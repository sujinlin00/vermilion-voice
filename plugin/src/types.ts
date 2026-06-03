// Voice-Solo Dual-Worker Message Protocol

// ---- Shared ----

export interface PerfStats {
  vadMs: number;
  asrFbankMs: number;
  asrInferMs: number;
  asrDecodeMs: number;
  puncMs: number;
  heapMB: number;
}

export interface VoiceSoloSettings {
  // Model
  modelBasePath: string;
  asrModelTier: 'standard' | 'performance';

  // Output
  outputToNote: boolean;
  outputFolder: string;
  saveAudio: boolean;
  recordingFolder: string;
  postProcessEnabled: boolean;

  // Audio
  audioDevice: string;

  // Advanced
  hotWords: Record<string, string>;
}

// ---- Worker A: VAD (always running, never blocked) ----

export interface VadInitConfig {
  vadModelBuffer: ArrayBuffer;
  vadCmvnText: string;
  simdWasm: ArrayBuffer;
  jsepWasm: ArrayBuffer | null;
}

export type MainToVad =
  | { type: 'init'; config: VadInitConfig }
  | { type: 'start' }
  | { type: 'chunk'; data: ArrayBuffer }
  | { type: 'stop' };

export type VadToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'listening' | 'speech' }
  | { type: 'segment'; audio: ArrayBuffer; startMs: number; endMs: number }
  | { type: 'error'; message: string }
  | { type: 'progress'; phase: string; pct: number };

// ---- Worker B: ASR + PUNC (on-demand per speech segment) ----

export interface AsrInitConfig {
  asrModelBuffer: ArrayBuffer;
  puncModelBuffer: ArrayBuffer;
  asrCmvnText: string;
  tokensJson: string[];
  puncTokensJson: string[];
  simdWasm: ArrayBuffer;
  jsepWasm: ArrayBuffer | null;
}

export type MainToAsr =
  | { type: 'init'; config: AsrInitConfig }
  | { type: 'segment'; audio: ArrayBuffer; startMs: number; endMs: number }
  | { type: 'stop' };

export type AsrToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'asr' | 'punc' }
  | { type: 'result'; text: string; startMs: number; endMs: number; perf: PerfStats }
  | { type: 'error'; message: string }
  | { type: 'progress'; phase: string; pct: number };
