# 02 — 架构设计

## 目录结构

```
voice-solo/
├── manifest.json              # Obsidian 插件清单
├── main.ts                    # 插件入口，生命周期
├── settings.ts                # 设置面板 (Obsidian SettingTab)
├── src/
│   ├── pipeline/
│   │   ├── PipelineWorker.ts  # Worker 线程主控
│   │   ├── AudioCapture.ts    # 麦克风采集 (Web Audio API)
│   │   ├── FbankProcessor.ts  # fbank + LFR + CMVN 特征提取 (NEW)
│   │   ├── VADProcessor.ts    # VAD 状态机 + FSMN ONNX
│   │   ├── ASRProcessor.ts    # Paraformer ONNX 推理 + 解码
│   │   ├── PUNCProcessor.ts   # CT-Transformer ONNX 推理
│   │   └── TextProcessor.ts   # 文本后处理 (去重/拆分/time header)
│   ├── models/
│   │   ├── ModelLoader.ts     # 本地/远程模型加载
│   │   ├── OrtSession.ts      # ORT Web Session 封装
│   │   └── Hotwords.ts        # 热词管理 (文本后处理层)
│   ├── ui/
│   │   ├── VoiceView.ts       # 主视图 (录音按钮 + 实时文本)
│   │   ├── StatusBar.ts       # 状态栏指示器
│   │   └── DownloadProgress.ts # 模型下载进度条
│   ├── storage/
│   │   ├── RecordingStore.ts  # 录音文件管理
│   │   └── ModelCache.ts      # 模型缓存管理
│   └── utils/
│       ├── RingBuffer.ts      # 无锁环形缓冲区 (SharedArrayBuffer)
│       └── MessageBus.ts      # Worker ↔ Main 消息定义
├── models/                    # 本地预置模型 (开发期)
│   ├── vad_fsmn.onnx
│   ├── asr_paraformer.onnx
│   └── punc_ct.onnx
├── styles.css                 # UI 样式
└── docs/                      # 本文档目录
```

## 进程模型

```
┌─────────────────────────────────────────────┐
│  Main Thread (Electron Renderer)             │
│  ┌─────────────────────┐  ┌───────────────┐ │
│  │ Plugin Core          │  │ UI (View)      │ │
│  │ - 生命周期           │  │ - VoiceView    │ │
│  │ - Worker 管理        │  │ - StatusBar    │ │
│  │ - 设置读写           │  │ - SettingsTab  │ │
│  │ - 文件 I/O           │  │ - Progress     │ │
│  └──────────┬──────────┘  └───────────────┘ │
│             │ MessageChannel                  │
│  ┌──────────┴──────────────────────────────┐ │
│  │ PipelineWorker                          │ │
│  │  (独立 Worker 线程，不阻塞 UI)           │ │
│  │                                          │ │
│  │  AudioWorkletNode ─→ RingBuffer ─→ ...  │ │
│  │       ↑ (AudioContext 在主线程)          │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## 消息协议 (MessageBus)

Main Thread ↔ PipelineWorker 之间通过结构化消息通信：

```typescript
// Main → Worker
type MainMessage =
  | { type: "start"; config: PipelineConfig }
  | { type: "stop" }
  | { type: "reload_hotwords"; hotwords: string[] }

// Worker → Main
type WorkerMessage =
  | { type: "text"; text: string; status: "newline" | "continuous"; time: string }
  | { type: "state"; state: "idle" | "recognizing" | "silent" | "error" }
  | { type: "progress"; step: string; message: string; percent: number }
  | { type: "error"; message: string }
```

## 数据流（POC 后更新）

```
AudioContext (sampleRate: 16000, chunkSize: 1600 samples = 100ms)
  │
  │  AudioWorklet.process()
  │  → 写入 SharedArrayBuffer (RingBuffer, 双缓冲区避免拷贝)
  ▼
PipelineWorker
  │  读取 RingBuffer → Float32Array chunk (100ms)
  │
  ├─ FBANK 阶段 (NEW: POC 验证发现 ONNX 模型需要外部特征提取)
  │   原始 PCM → 分帧(25ms/10ms) → 汉明窗 → FFT → Mel(80) → Log → LFR → CMVN
  │   VAD: LFR(m=5,n=1) → 400-dim, ASR: LFR(m=7,n=6) → 560-dim
  │
  ├─ VAD (1s window)
  │   FSMN ONNX 推理 → { hasSpeech, segment? }
  │   有语音段 → 送入 ASR 队列，cache 跨帧传递
  │
  ├─ ASR (on-demand, 非定时)
  │   SpeechSegment 特征 → Paraformer ONNX → argmax 解码 → raw text
  │   送入 PUNC 队列
  │
  ├─ PUNC
  │   raw text → CT-Transformer ONNX → punctuated text
  │   force_ended 处理 → append_truncated
  │
  └─ TextProcessor
       preprocess → dedup → tick(silence, start, end)
       → postMessage({ type: "text", ... }) → Main → UI
```

## RingBuffer 设计

```typescript
// 基于 SharedArrayBuffer 的单写单读环形缓冲区
// AudioWorklet 写，PipelineWorker 读

const RING_SIZE = 16000 * 2;  // 2 秒缓冲 = 64000 floats = 256KB
const STATE_OFFSET = RING_SIZE * 4;  // 状态区位于数据区之后

class RingBuffer {
  private _data: Float32Array;    // RING_SIZE 个 float32
  private _state: Int32Array;     // [writePos, readPos]

  write(chunk: Float32Array): void {
    // AudioWorklet 调用，写 chunk 到 _data
    // Atomics.store 更新 writePos
  }

  read(length: number): Float32Array | null {
    // Worker 调用，读取 length 个样本
    // Atomics.load 检查可读量
    // Atomics.store 更新 readPos
  }
}
```

关键：用 `Atomics` 保证跨线程内存可见性和操作原子性，无锁。
