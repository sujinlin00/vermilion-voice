// Worker message protocol

export interface InitConfig {
  hasWebGPU: boolean;       // pre-detected by main thread (Worker navigator.gpu may be unavailable)
  vadModelBuffer: ArrayBuffer;
  asrModelBuffer: ArrayBuffer;
  puncModelBuffer: ArrayBuffer;
  vadCmvnText: string;
  asrCmvnText: string;
  tokensJson: string[];
  threadedWasm: ArrayBuffer;
  jsepWasm: ArrayBuffer;
  puncTokensJson: string[];
}

export type MainToWorker =
  | { type: 'init'; config: InitConfig }
  | { type: 'start' }
  | { type: 'chunk'; data: ArrayBuffer }
  | { type: 'stop' };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'idle' | 'listening' | 'speech' | 'asr' | 'punc' }
  | { type: 'segment'; text: string; startMs: number; endMs: number; perf?: PerfStats }
  | { type: 'error'; message: string }
  | { type: 'progress'; phase: string; pct: number };

export interface PerfStats {
  vadMs: number;
  asrFbankMs: number;
  asrInferMs: number;
  asrDecodeMs: number;
  puncMs: number;
  heapMB: number;
}

export interface VoiceSoloSettings {
  modelBasePath: string;
  hotWords: Record<string, string>;
  autoSaveToNote: boolean;
}
