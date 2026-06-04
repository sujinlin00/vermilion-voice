// Vermilion Voice Dual-Worker Message Protocol

// ---- Shared ----

export interface PerfStats {
  vadMs: number;
  asrFbankMs: number;
  asrInferMs: number;
  asrDecodeMs: number;
  puncMs: number;
  heapMB: number;
}

export interface VermilionVoiceSettings {
  // General
  language: 'zh' | 'en';

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

  // 识别粒度
  vadSensitivity: 'low' | 'medium' | 'high';
  outputInterval: number; // ms: 1000 | 3000 | 5000
  silenceThreshold: number; // 段落分隔静音(秒)
  maxLineChars: number;     // 单行字数上限
  maxSpeechDuration: number; // 最长语音分段(秒)

  // Advanced
  hotWords: Record<string, string>;
}

// ---- settings.json config ----

export interface TextProcessorConfig {
  silence_threshold: number;
  max_line_chars: number;
  dedup_window: number;
  newline_punctuation: string;  // 换行标点：句末标点
  carry_punctuation: string;    // carry 切分标点：所有标点
}

export interface VadSensitivityFrames {
  high: number;
  medium: number;
  low: number;
}

export interface VadConfig {
  min_speech_duration: number;
  max_speech_duration: number;
  pre_roll_duration: number;
  post_roll_duration: number;
  forced_cut_silence_frames: number;
  speech_start_frames: VadSensitivityFrames;
  speech_end_frames: VadSensitivityFrames;
}

export interface AudioCaptureConfig {
  mic_enabled: boolean;
  output_enabled: boolean;
  output_source: 'system' | 'window';  // system = 桌面音频, window = 指定窗口
  mix_mode: 'merge';                   // 合并为单流（唯一模式）
}

export interface AppConfig {
  text_processor: TextProcessorConfig;
  vad: VadConfig;
  audio_capture: AudioCaptureConfig;
}

// ---- Worker A: VAD (always running, never blocked) ----

export interface VadInitConfig {
  vadModelBuffer: ArrayBuffer;
  vadCmvnText: string;
  simdWasm: ArrayBuffer;
  jsepWasm: ArrayBuffer | null;
  sensitivity: 'low' | 'medium' | 'high';
  vadCfg: VadConfig;
}

export type MainToVad =
  | { type: 'init'; config: VadInitConfig }
  | { type: 'start' }
  | { type: 'chunk'; data: ArrayBuffer }
  | { type: 'stop' };

export type VadToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'listening' | 'speech' }
  | { type: 'segment'; audio: ArrayBuffer; startMs: number; endMs: number; reason: 'silence' | 'forced' }
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
  | { type: 'segment'; audio: ArrayBuffer; startMs: number; endMs: number; reason?: 'silence' | 'forced'; skipPunc?: boolean }
  | { type: 'punc'; text: string; startMs: number; endMs: number }
  | { type: 'stop' };

export type AsrToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'asr' | 'punc' }
  | { type: 'result'; text: string; startMs: number; endMs: number; perf: PerfStats; reason?: string }
  | { type: 'punc_result'; text: string; startMs: number; endMs: number }
  | { type: 'error'; message: string }
  | { type: 'progress'; phase: string; pct: number };
