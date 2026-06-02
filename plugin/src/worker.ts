// Voice-Solo Pipeline Worker — VAD → ASR → PUNC
//
// Simple sequential pipeline:
//   1. Audio always accumulated (never dropped)
//   2. Fbank always updated (keeps internal state in sync)
//   3. VAD ONNX skipped during ASR (avoids session contention)
//   4. VAD resumes with fresh audio after ASR completes

import type { InitConfig, MainToWorker, WorkerToMain } from './types';
import { StreamingFbankProcessor, loadCMVN } from '../lib/streaming_fbank.js';

import * as ort from '../lib/ort.bundle.min.mjs';

// ---- State ----
let vadSession: any = null;
let asrSession: any = null;
let puncSession: any = null;
let vadFbank: any = null;
let asrCmvn: any = null;
let vadCaches: Float32Array[] = [];
let tokens: string[] = [];
let puncTokens: any = null;
let asrModelBuf: ArrayBuffer | null = null;
let vadModelBuf: ArrayBuffer | null = null;
let puncModelBuf: ArrayBuffer | null = null;

// Perf tracking
let totalVadMs = 0;
let vadCallCount = 0;

let running = false;
let asrBusy = false;
let fullAudio = new Float32Array(0);
let vadState = 'SILENCE';
let speechFrames = 0;
let silenceFrames = 0;
let speechStart = -1;
let speechSamples: number[] = [];

// VAD config (aligned with Python server-side)
const SIL_THRESH = 0.2;
const SPEECH_START_FRAMES = 20;    // 200ms min speech
const SPEECH_END_FRAMES = 100;     // 1s silence to end
const MAX_SPEECH_FRAMES = 600;     // 6s max → force split
const PRE_ROLL_MS = 80;
const POST_ROLL_MS = 120;
const MIN_SPEECH_SAMPLES = 3200;   // min 200ms @ 16kHz

function post(msg: WorkerToMain) {
  (self as any).postMessage(msg);
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
async function init(config: InitConfig) {
  post({ type: 'progress', phase: 'ort', pct: 100 });

  ort.env.wasm.wasmPaths = 'https://voice-solo.local/';
  ort.env.wasm.numThreads = 1;

  const wasmBinaries: Record<string, ArrayBuffer> = {
    'ort-wasm-simd-threaded.wasm': config.threadedWasm,
    'ort-wasm-simd-threaded.jsep.wasm': config.jsepWasm,
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

  tokens = config.tokensJson;
  puncTokens = config.puncTokensJson;
  const gpuEp = config.hasWebGPU ? 'webgpu' : 'wasm';

  // VAD: always WASM (2-3ms/frame, avoids GPU contention with ASR)
  vadModelBuf = config.vadModelBuffer;
  post({ type: 'progress', phase: 'vad', pct: 0 });
  vadSession = await ort.InferenceSession.create(config.vadModelBuffer, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  post({ type: 'progress', phase: 'vad', pct: 100 });

  // ASR: try GPU → WASM fallback
  asrModelBuf = config.asrModelBuffer;
  post({ type: 'progress', phase: 'asr', pct: 0 });
  try {
    asrSession = await ort.InferenceSession.create(config.asrModelBuffer, {
      executionProviders: [gpuEp], graphOptimizationLevel: 'basic',
    });
  } catch {
    asrSession = await ort.InferenceSession.create(config.asrModelBuffer, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'basic',
    });
  }
  post({ type: 'progress', phase: 'asr', pct: 100 });

  // PUNC: always WASM — runs inside finalizeSpeech while VAD is paused, so no contention
  puncModelBuf = config.puncModelBuffer;
  post({ type: 'progress', phase: 'punc', pct: 0 });
  puncSession = await ort.InferenceSession.create(config.puncModelBuffer, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  post({ type: 'progress', phase: 'punc', pct: 100 });

  // Init fbank
  const vadCmvn = loadCMVN(config.vadCmvnText);
  asrCmvn = loadCMVN(config.asrCmvnText);
  vadFbank = new StreamingFbankProcessor({
    fs: 16000, n_mels: 80, frame_length_ms: 25, frame_shift_ms: 10,
    dither: 0.0, lfr_m: 5, lfr_n: 1, cmvn: vadCmvn,
  });

  for (let i = 0; i < 4; i++) vadCaches[i] = new Float32Array(128 * 19);

  post({ type: 'ready' });
}

// ---- Process audio chunk ----
async function processChunk(chunk: Float32Array) {
  // Always accumulate audio — never drop, even during ASR
  const newBuf = new Float32Array(fullAudio.length + chunk.length);
  newBuf.set(fullAudio);
  newBuf.set(chunk, fullAudio.length);
  fullAudio = newBuf;

  // Always compute fbank — keep LFR state in sync
  const { feat, featLen, dim } = vadFbank.accept_waveform(chunk, false);
  if (featLen === 0) return;
  clipFeat(feat, featLen, dim);

  // Skip VAD ONNX during ASR (avoids ORT session contention)
  // Audio + fbank state are preserved; VAD resumes when ASR completes
  if (asrBusy) return;

  // VAD ONNX
  const feeds: any = {
    [vadSession.inputNames[0]]: new ort.Tensor('float32', feat.slice(0, featLen * dim), [1, featLen, dim]),
  };
  for (let i = 0; i < 4; i++) {
    feeds[vadSession.inputNames[i + 1]] = new ort.Tensor('float32', vadCaches[i], [1, 128, 19, 1]);
  }

  const tVadStart = performance.now();
  let vadOutputs: any;
  try {
    vadOutputs = await vadSession.run(feeds);
  } catch (e: any) {
    if ((e.message?.includes('fc') || e.message?.includes('null')) && vadModelBuf) {
      vadSession = await ort.InferenceSession.create(vadModelBuf, {
        executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      });
      vadOutputs = await vadSession.run(feeds);
    } else {
      throw e;
    }
  }
  totalVadMs += performance.now() - tVadStart;
  vadCallCount++;
  const scoresData = new Float32Array(vadOutputs[vadSession.outputNames[0]].data);
  for (let i = 0; i < 4; i++) {
    vadCaches[i] = new Float32Array(vadOutputs[vadSession.outputNames[i + 1]].data);
  }

  // VAD state machine
  const T = scoresData.length / 248;
  let segmentSpeechFrames = speechSamples.length / 160;
  const preRollSamples = PRE_ROLL_MS * 16;
  const postRollSamples = POST_ROLL_MS * 16;

  for (let t = 0; t < T; t++) {
    const silScore = scoresData[t * 248];
    const isSpeech = silScore < SIL_THRESH;

    if (isSpeech) {
      silenceFrames = 0;
      speechFrames++;
      segmentSpeechFrames++;
      if (vadState === 'SILENCE' && speechFrames >= SPEECH_START_FRAMES) {
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
      }
    } else {
      speechFrames = 0;
      if (vadState === 'SPEECH') {
        silenceFrames++;
        if (silenceFrames >= SPEECH_END_FRAMES) {
          const postEnd = Math.min(
            fullAudio.length,
            fullAudio.length - chunk.length + Math.floor(t * 160) + postRollSamples
          );
          for (let s = fullAudio.length - chunk.length + Math.floor(t * 160); s < postEnd; s++) {
            speechSamples.push(fullAudio[s]);
          }
          await emitSpeech();
          vadState = 'SILENCE';
          silenceFrames = 0;
          post({ type: 'status', status: 'listening' });
        } else if (segmentSpeechFrames >= MAX_SPEECH_FRAMES && silenceFrames >= 3) {
          const postEnd = Math.min(
            fullAudio.length,
            fullAudio.length - chunk.length + Math.floor(t * 160) + postRollSamples
          );
          for (let s = fullAudio.length - chunk.length + Math.floor(t * 160); s < postEnd; s++) {
            speechSamples.push(fullAudio[s]);
          }
          await emitSpeech();
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

// ---- Emit speech segment ----
async function emitSpeech() {
  if (speechSamples.length < MIN_SPEECH_SAMPLES) {
    speechSamples = []; speechStart = -1;
    return;
  }
  const samples = speechSamples;
  const start = speechStart;
  speechSamples = []; speechStart = -1;
  await finalizeSpeech(samples, start);
}

// ---- ASR ----
async function finalizeSpeech(samples: number[], startIdx: number) {
  if (samples.length < MIN_SPEECH_SAMPLES) return;

  asrBusy = true;
  const audio = new Float32Array(samples);
  const startMs = startIdx / 16;
  const endMs = (startIdx + samples.length) / 16;

  try {
    post({ type: 'status', status: 'asr' });

    // ASR fbank (offline, lfr_m=7, n=6)
    const tFbank = performance.now();
    const asrFbank = new StreamingFbankProcessor({
      fs: 16000, n_mels: 80, frame_length_ms: 25, frame_shift_ms: 10,
      dither: 0.0, lfr_m: 7, lfr_n: 6, cmvn: asrCmvn,
    });
    const { feat, featLen, dim } = asrFbank.accept_waveform(audio, true);
    if (featLen === 0) { asrBusy = false; return; }
    clipFeat(feat, featLen, dim);
    const asrFbankMs = performance.now() - tFbank;

    // ASR ONNX
    const feeds: any = {
      [asrSession.inputNames[0]]: new ort.Tensor('float32', feat.slice(0, featLen * dim), [1, featLen, dim]),
      [asrSession.inputNames[1]]: new ort.Tensor('int32', new Int32Array([featLen]), [1]),
    };
    const tInfer = performance.now();
    let outputs: any;
    try {
      outputs = await asrSession.run(feeds);
    } catch (e: any) {
      if ((e.message?.includes('fc') || e.message?.includes('null')) && asrModelBuf) {
        asrSession = await ort.InferenceSession.create(asrModelBuf, {
          executionProviders: ['wasm'], graphOptimizationLevel: 'basic',
        });
        outputs = await asrSession.run(feeds);
      } else {
        throw e;
      }
    }
    const asrInferMs = performance.now() - tInfer;

    // Decode
    const tDecode = performance.now();
    const logitsData = new Float32Array(outputs[asrSession.outputNames[0]].data);
    const outputLen = outputs[asrSession.outputNames[0]].dims[1];
    const vocabSize = outputs[asrSession.outputNames[0]].dims[2];
    const tokenNum = outputs[asrSession.outputNames[1]].data[0];

    const yseq: number[] = [];
    for (let t = 0; t < outputLen; t++) {
      let maxI = 0, maxV = -Infinity;
      const off = t * vocabSize;
      for (let v = 0; v < vocabSize; v++) {
        if (logitsData[off + v] > maxV) { maxV = logitsData[off + v]; maxI = v; }
      }
      yseq.push(maxI);
    }

    const validLen = Math.max(0, tokenNum - 1);
    const filtered: number[] = [];
    for (const id of yseq) {
      if (id !== 0 && id !== 2) { filtered.push(id); if (filtered.length >= validLen) break; }
    }
    let text = filtered.map(id => id < tokens.length ? tokens[id] : '').join('');
    const asrDecodeMs = performance.now() - tDecode;

    // PUNC — safe to run WASM here because VAD is paused (asrBusy=true)
    let puncMs = 0;
    if (puncSession && text.length > 0) {
      post({ type: 'status', status: 'punc' });
      const tPunc = performance.now();
      text = await runPunc(text);
      puncMs = performance.now() - tPunc;
    }

    // Report
    const vadAvgMs = vadCallCount > 0 ? totalVadMs / vadCallCount : 0;
    const heapMB = (performance as any).memory?.usedJSHeapSize
      ? ((performance as any).memory.usedJSHeapSize / 1024 / 1024).toFixed(0)
      : 0;

    post({
      type: 'segment', text, startMs, endMs,
      perf: {
        vadMs: Math.round(vadAvgMs * 10) / 10,
        asrFbankMs: Math.round(asrFbankMs),
        asrInferMs: Math.round(asrInferMs),
        asrDecodeMs: Math.round(asrDecodeMs),
        puncMs: Math.round(puncMs),
        heapMB: Number(heapMB),
      },
    });
  } catch (e: any) {
    post({ type: 'error', message: `ASR: ${e.message || String(e)}` });
  }
  asrBusy = false;
}

async function runPunc(text: string): Promise<string> {
  if (!puncTokens || !puncSession) return text;

  const charToId: Record<string, number> = {};
  for (let i = 0; i < puncTokens.length; i++) {
    if (puncTokens[i].length === 1) charToId[puncTokens[i]] = i;
  }
  const unkId = puncTokens.indexOf('<unk>');

  const tokenIds: number[] = [];
  for (const ch of text) tokenIds.push(charToId[ch] ?? unkId);

  const feeds: any = {
    [puncSession.inputNames[0]]: new ort.Tensor('int32', new Int32Array(tokenIds), [1, tokenIds.length]),
    [puncSession.inputNames[1]]: new ort.Tensor('int32', new Int32Array([tokenIds.length]), [1]),
  };
  const outputs = await puncSession.run(feeds);

  const logitsData = new Float32Array(outputs[puncSession.outputNames[0]].data);
  const outLen = outputs[puncSession.outputNames[0]].dims[1];
  const numClasses = outputs[puncSession.outputNames[0]].dims[2];
  const puncList = ['<unk>', '_', '，', '。', '？', '、'];

  const puncSeq: string[] = [];
  for (let t = 0; t < outLen; t++) {
    let maxI = 0, maxV = -Infinity;
    const off = t * numClasses;
    for (let c = 0; c < numClasses; c++) {
      if (logitsData[off + c] > maxV) { maxV = logitsData[off + c]; maxI = c; }
    }
    puncSeq.push(puncList[maxI] || '_');
  }

  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += text[i];
    if (i < puncSeq.length && puncSeq[i] !== '_' && puncSeq[i] !== '<unk>') {
      result += puncSeq[i];
    }
  }
  return result;
}

function reset() {
  running = false;
  asrBusy = false;
  fullAudio = new Float32Array(0);
  vadState = 'SILENCE';
  speechFrames = 0; silenceFrames = 0;
  speechStart = -1; speechSamples = [];
  if (vadFbank) vadFbank.reset();
  for (let i = 0; i < 4; i++) vadCaches[i] = new Float32Array(128 * 19);
}

// ---- Message handler ----
self.onmessage = async (e: MessageEvent<MainToWorker>) => {
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
          const samples = speechSamples;
          const start = speechStart;
          speechSamples = []; speechStart = -1;
          await finalizeSpeech(samples, start);
        }
        reset();
        post({ type: 'status', status: 'idle' });
        break;
      }
    }
  } catch (e: any) {
    post({ type: 'error', message: e.message });
  }
};
