// Voice-Solo Worker B — ASR + PUNC (on-demand per speech segment)
//
// Receives speech segments from main thread (forwarded from Worker A),
// runs ASR ONNX + decode + PUNC, outputs text results.

import type { AsrToMain, MainToAsr, PerfStats } from './types';
import { StreamingFbankProcessor, loadCMVN } from '../lib/streaming_fbank.js';
import * as ort from '../lib/ort.bundle.min.mjs';

// ---- State ----
let asrSession: any = null;
let puncSession: any = null;
let asrCmvn: any = null;
let tokens: string[] = [];
let puncTokens: any = null;

function post(msg: AsrToMain) {
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
async function init(config: import('./types').AsrInitConfig) {
  post({ type: 'progress', phase: 'ort', pct: 100 });

  ort.env.wasm.wasmPaths = 'https://voice-solo.local/';
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

  tokens = config.tokensJson;
  puncTokens = config.puncTokensJson;

  // ASR: WASM
  post({ type: 'progress', phase: 'asr', pct: 0 });
  asrSession = await ort.InferenceSession.create(config.asrModelBuffer, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'basic',
  });
  post({ type: 'progress', phase: 'asr', pct: 100 });

  // ASR fbank
  asrCmvn = loadCMVN(config.asrCmvnText);

  // PUNC: WASM
  post({ type: 'progress', phase: 'punc', pct: 0 });
  puncSession = await ort.InferenceSession.create(config.puncModelBuffer, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  post({ type: 'progress', phase: 'punc', pct: 100 });

  // Warmup: run a tiny silent segment to compile WASM graph
  post({ type: 'progress', phase: 'warmup', pct: 0 });
  try {
    const warmupAudio = new Float32Array(8000);
    const wfbank = new StreamingFbankProcessor({
      fs: 16000, n_mels: 80, frame_length_ms: 25, frame_shift_ms: 10,
      dither: 0.0, lfr_m: 7, lfr_n: 6, cmvn: asrCmvn,
    });
    const { feat, featLen, dim } = wfbank.accept_waveform(warmupAudio, true);
    if (featLen > 0) {
      clipFeat(feat, featLen, dim);
      await asrSession.run({
        [asrSession.inputNames[0]]: new ort.Tensor('float32', feat.slice(0, featLen * dim), [1, featLen, dim]),
        [asrSession.inputNames[1]]: new ort.Tensor('int32', new Int32Array([featLen]), [1]),
      });
    }
  } catch { /* warmup failed — not critical */ }
  post({ type: 'progress', phase: 'warmup', pct: 100 });

  post({ type: 'ready' });
}

// ---- BPE & text cleanup ----

/** Remove SentencePiece BPE continuation markers and special tokens. */
function cleanBpe(text: string): string {
  // Remove special tokens
  text = text.replace(/<unk>/g, '');
  text = text.replace(/<s>/g, '');
  text = text.replace(/<\/s>/g, '');
  text = text.replace(/<blank>/g, '');
  // SentencePiece space marker → actual space
  text = text.replace(/▁/g, ' ');
  // BPE continuation: "token@@" without following space means internal continuation
  // Pattern: any sequence of "xxx@@yyy@@" → merge by removing @@
  text = text.replace(/@@/g, '');
  // Collapse multiple spaces
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

/** Check if >50% of characters are ASCII (English-heavy → skip Chinese PUNC model). */
function isMostlyAscii(text: string): boolean {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  return ascii > text.length * 0.5;
}

// ---- Process speech segment ----
async function processSegment(audio: Float32Array, startMs: number, endMs: number) {
  const tTotal = performance.now();

  try {
    post({ type: 'status', status: 'asr' });

    // ASR fbank
    const tFbank = performance.now();
    const asrFbank = new StreamingFbankProcessor({
      fs: 16000, n_mels: 80, frame_length_ms: 25, frame_shift_ms: 10,
      dither: 0.0, lfr_m: 7, lfr_n: 6, cmvn: asrCmvn,
    });
    const { feat, featLen, dim } = asrFbank.accept_waveform(audio, true);
    if (featLen === 0) return;
    clipFeat(feat, featLen, dim);
    const asrFbankMs = performance.now() - tFbank;

    // ASR ONNX
    const feeds: any = {
      [asrSession.inputNames[0]]: new ort.Tensor('float32', feat.slice(0, featLen * dim), [1, featLen, dim]),
      [asrSession.inputNames[1]]: new ort.Tensor('int32', new Int32Array([featLen]), [1]),
    };
    const tInfer = performance.now();
    const outputs = await asrSession.run(feeds);
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
    // BPE post-processing: remove SentencePiece continuation markers
    text = cleanBpe(text);
    const asrDecodeMs = performance.now() - tDecode;

    // PUNC (skip for English-heavy segments — CT-Transformer is Chinese-only)
    let puncMs = 0;
    if (puncSession && text.length > 0 && !isMostlyAscii(text)) {
      post({ type: 'status', status: 'punc' });
      const tPunc = performance.now();
      text = await runPunc(text);
      puncMs = performance.now() - tPunc;
    }

    const perf: PerfStats = {
      vadMs: 0,
      asrFbankMs: Math.round(asrFbankMs),
      asrInferMs: Math.round(asrInferMs),
      asrDecodeMs: Math.round(asrDecodeMs),
      puncMs: Math.round(puncMs),
      heapMB: (performance as any).memory?.usedJSHeapSize
        ? Number(((performance as any).memory.usedJSHeapSize / 1024 / 1024).toFixed(0))
        : 0,
    };

    post({ type: 'result', text, startMs, endMs, perf });
  } catch (e: any) {
    post({ type: 'error', message: `ASR: ${e.message || String(e)}` });
  }
}

// ---- PUNC ----
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

// ---- Message handler ----
self.onmessage = async (e: MessageEvent<MainToAsr>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.config);
        break;
      case 'segment': {
        const audio = new Float32Array(msg.audio);
        await processSegment(audio, msg.startMs, msg.endMs);
        break;
      }
      case 'stop':
        // No state to flush — Worker B is stateless per segment
        break;
    }
  } catch (e: any) {
    post({ type: 'error', message: `ASR: ${e.message || String(e)}` });
  }
};
