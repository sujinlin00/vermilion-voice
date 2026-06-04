// Vermilion Voice Worker A — VAD (always running, never blocked)
//
// Receives audio chunks from main thread, runs streaming VAD ONNX,
// outputs speech segments to main thread for forwarding to Worker B.

import type { MainToVad, VadToMain } from './types';
import { StreamingFbankProcessor, loadCMVN } from '../lib/streaming_fbank.js';
import * as ort from '../lib/ort.bundle.min.mjs';

// ---- State ----
let vadSession: any = null;
let vadFbank: any = null;
let vadCaches: Float32Array[] = [];
let vadModelBuf: ArrayBuffer | null = null;

// Perf tracking
let totalVadMs = 0;
let vadCallCount = 0;

let running = false;
let fullAudio = new Float32Array(0);
let vadState = 'SILENCE';
let speechFrames = 0;
let silenceFrames = 0;
let speechStart = -1;
let speechSamples: number[] = [];

const SIL_THRESH = 0.2;
let speechStartFrames = 20;
let speechEndFrames = 100;
let maxSpeechFrames = 600;
let preRollMs = 80;
let postRollMs = 120;
let minSpeechSamples = 3200;
let forcedCutSilenceFrames = 3;

function post(msg: VadToMain, transfer?: Transferable[]) {
  if (transfer) {
    (self as any).postMessage(msg, transfer);
  } else {
    (self as any).postMessage(msg);
  }
}

function clipFeat(feat: Float32Array, len: number, dim: number) {
  const n = len * dim;
  for (let i = 0; i < n; i++) {
    if (!isFinite(feat[i])) feat[i] = 0.0;
    else if (feat[i] > 50) feat[i] = 50;
    else if (feat[i] < -50) feat[i] = -50;
  }
}

// ---- Init ----
async function init(config: import('./types').VadInitConfig) {
  // Apply vadCfg from settings.json
  const cfg = config.vadCfg;
  if (cfg) {
    const sens = config.sensitivity || 'medium';
    speechStartFrames = cfg.speech_start_frames[sens] ?? 20;
    speechEndFrames = cfg.speech_end_frames[sens] ?? 100;
    maxSpeechFrames = Math.round(cfg.max_speech_duration * 100);  // duration(s) → frames(10ms)
    preRollMs = Math.round(cfg.pre_roll_duration * 1000);
    postRollMs = Math.round(cfg.post_roll_duration * 1000);
    minSpeechSamples = Math.round(cfg.min_speech_duration * 16000);  // duration(s) → samples(16kHz)
    forcedCutSilenceFrames = cfg.forced_cut_silence_frames ?? 3;
  } else {
    // Fallback: sensitivity only
    const sens = config.sensitivity || 'medium';
    if (sens === 'low') { speechStartFrames = 30; speechEndFrames = 150; }
    else if (sens === 'high') { speechStartFrames = 10; speechEndFrames = 50; }
    else { speechStartFrames = 20; speechEndFrames = 100; }
  }

  console.log(`[VAD] init: maxSpeechFrames=${maxSpeechFrames} speechStartFrames=${speechStartFrames} speechEndFrames=${speechEndFrames} preRollMs=${preRollMs} postRollMs=${postRollMs} forcedCutSil=${forcedCutSilenceFrames}`);

  post({ type: 'progress', phase: 'ort', pct: 100 });

  ort.env.wasm.wasmPaths = 'https://vermilion-voice.local/';
  ort.env.wasm.numThreads = 1;

  const wasmBinaries: Record<string, ArrayBuffer> = {
    'ort-wasm-simd-threaded.wasm': config.simdWasm,
  };
  const origFetch = self.fetch.bind(self);
  self.fetch = (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    for (const [name, buf] of Object.entries(wasmBinaries)) {
      if (url.includes(name)) {
        return Promise.resolve(new Response(buf, { headers: { 'Content-Type': 'application/wasm' } }));
      }
    }
    return origFetch(input, init);
  };

  vadModelBuf = config.vadModelBuffer;
  post({ type: 'progress', phase: 'vad', pct: 0 });
  vadSession = await ort.InferenceSession.create(config.vadModelBuffer, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  post({ type: 'progress', phase: 'vad', pct: 100 });

  const vadCmvn = loadCMVN(config.vadCmvnText);
  vadFbank = new StreamingFbankProcessor({
    fs: 16000, n_mels: 80, frame_length_ms: 25, frame_shift_ms: 10,
    dither: 0.0, lfr_m: 5, lfr_n: 1, cmvn: vadCmvn,
  });

  for (let i = 0; i < 4; i++) vadCaches[i] = new Float32Array(128 * 19);

  post({ type: 'ready' });
}

// ---- Emit speech segment ----
function emitSpeech(reason: 'silence' | 'forced' = 'silence') {
  if (speechSamples.length < minSpeechSamples) {
    speechSamples = []; speechStart = -1;
    return;
  }
  const audio = new Float32Array(speechSamples);
  const startMs = speechStart / 16;
  const endMs = (speechStart + speechSamples.length) / 16;
  speechSamples = []; speechStart = -1;

  // Transfer audio buffer to main thread (zero-copy)
  post({ type: 'segment', audio: audio.buffer, startMs, endMs, reason }, [audio.buffer]);
}

// ---- Process audio chunk ----
async function processChunk(chunk: Float32Array) {
  // Accumulate audio
  const newBuf = new Float32Array(fullAudio.length + chunk.length);
  newBuf.set(fullAudio);
  newBuf.set(chunk, fullAudio.length);
  fullAudio = newBuf;

  // VAD fbank
  const { feat, featLen, dim } = vadFbank.accept_waveform(chunk, false);
  if (featLen === 0) return;
  clipFeat(feat, featLen, dim);

  // VAD ONNX
  const feeds: any = {
    [vadSession.inputNames[0]]: new ort.Tensor('float32', feat.slice(0, featLen * dim), [1, featLen, dim]),
  };
  for (let i = 0; i < 4; i++) {
    feeds[vadSession.inputNames[i + 1]] = new ort.Tensor('float32', vadCaches[i], [1, 128, 19, 1]);
  }

  const tStart = performance.now();
  const vadOutputs = await vadSession.run(feeds);
  totalVadMs += performance.now() - tStart;
  vadCallCount++;

  const scoresData = new Float32Array(vadOutputs[vadSession.outputNames[0]].data);
  for (let i = 0; i < 4; i++) {
    vadCaches[i] = new Float32Array(vadOutputs[vadSession.outputNames[i + 1]].data);
  }

  // VAD state machine
  const T = scoresData.length / 248;
  let segmentSpeechFrames = speechSamples.length / 160;
  const preRollSamples = preRollMs * 16;
  const postRollSamples = postRollMs * 16;

  for (let t = 0; t < T; t++) {
    const silScore = scoresData[t * 248];
    const isSpeech = silScore < SIL_THRESH;

    if (isSpeech) {
      silenceFrames = 0;
      speechFrames++;
      segmentSpeechFrames++;
      if (vadState === 'SILENCE' && speechFrames >= speechStartFrames) {
        vadState = 'SPEECH';
        const rawStart = fullAudio.length - chunk.length + Math.floor(t * 160);
        speechStart = Math.max(0, rawStart - preRollSamples);
        speechSamples = [];
        for (let s = speechStart; s < rawStart; s++) speechSamples.push(fullAudio[s]);
        segmentSpeechFrames = 0;
        post({ type: 'status', status: 'speech' });
      }
      if (vadState === 'SPEECH') {
        const fStart = fullAudio.length - chunk.length + Math.max(0, Math.floor(t * 160));
        const fEnd = Math.min(fullAudio.length, fStart + 160);
        for (let s = fStart; s < fEnd; s++) speechSamples.push(fullAudio[s]);

        // Hard forced cut: no silence detected, cut at exact maxSpeechFrames
        if (segmentSpeechFrames >= maxSpeechFrames) {
          console.log(`[VAD] HARD CUT (no silence): segFrames=${segmentSpeechFrames} maxFrames=${maxSpeechFrames} segMs=${(segmentSpeechFrames*10).toFixed(0)}`);
          const cutPoint = fullAudio.length - chunk.length + Math.floor(t * 160);
          emitSpeech('forced');
          speechStart = Math.max(0, cutPoint - preRollSamples);
          speechSamples = [];
          for (let s = speechStart; s < cutPoint; s++) speechSamples.push(fullAudio[s]);
          segmentSpeechFrames = 0;
          silenceFrames = 0;
        }
      }
    } else {
      speechFrames = 0;
      if (vadState === 'SPEECH') {
        silenceFrames++;
        if (silenceFrames >= speechEndFrames) {
          const postEnd = Math.min(
            fullAudio.length,
            fullAudio.length - chunk.length + Math.floor(t * 160) + postRollSamples
          );
          for (let s = fullAudio.length - chunk.length + Math.floor(t * 160); s < postEnd; s++) {
            speechSamples.push(fullAudio[s]);
          }
          console.log(`[VAD] SILENCE CUT: silenceFrames=${silenceFrames} segmentMs=${(segmentSpeechFrames*10).toFixed(0)}ms`);
          emitSpeech('silence');
          vadState = 'SILENCE';
          silenceFrames = 0;
          post({ type: 'status', status: 'listening' });
        } else if (segmentSpeechFrames >= maxSpeechFrames && silenceFrames >= forcedCutSilenceFrames) {
          // Forced cut: exceeded max duration + brief silence at word boundary
          console.log(`[VAD] FORCED CUT: segFrames=${segmentSpeechFrames} maxFrames=${maxSpeechFrames} silFrames=${silenceFrames} segMs=${(segmentSpeechFrames*10).toFixed(0)}`);
          const postEnd = Math.min(
            fullAudio.length,
            fullAudio.length - chunk.length + Math.floor(t * 160) + postRollSamples
          );
          for (let s = fullAudio.length - chunk.length + Math.floor(t * 160); s < postEnd; s++) {
            speechSamples.push(fullAudio[s]);
          }
          emitSpeech('forced');
          speechStart = Math.max(0, fullAudio.length - chunk.length + Math.floor(t * 160) - preRollSamples);
          speechSamples = [];
          for (let s = speechStart; s < fullAudio.length - chunk.length + Math.floor(t * 160); s++) {
            speechSamples.push(fullAudio[s]);
          }
          segmentSpeechFrames = 0;
          silenceFrames = 0;
        }
      }
    }
  }
}

function reset() {
  running = false;
  fullAudio = new Float32Array(0);
  vadState = 'SILENCE';
  speechFrames = 0; silenceFrames = 0;
  speechStart = -1; speechSamples = [];
  if (vadFbank) vadFbank.reset();
  for (let i = 0; i < 4; i++) vadCaches[i] = new Float32Array(128 * 19);
}

// ---- Message handler ----
self.onmessage = async (e: MessageEvent<MainToVad>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.config);
        break;
      case 'start':
        running = true;
        post({ type: 'status', status: 'listening' });
        break;
      case 'chunk': {
        if (!running) return;
        const chunk = new Float32Array(msg.data);
        await processChunk(chunk);
        break;
      }
      case 'stop': {
        running = false;
        if (vadState === 'SPEECH' && speechSamples.length > 0) {
          emitSpeech('silence');
        }
        reset();
        break;
      }
    }
  } catch (e: any) {
    post({ type: 'error', message: `VAD: ${e.message || String(e)}` });
  }
};
