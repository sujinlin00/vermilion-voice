# Voice-Solo: Obsidian 本地语音识别插件 — 技术探索

> 目标：在 Obsidian 插件中直接加载 ONNX 模型，通过 ORT Web + WebGPU 实现本地语音识别，无需外部 Python 服务。

## 一、当前实现的痛点

Python 服务端架构（`voice-transcribe`）已稳定运行，但存在以下问题：

| 痛点   | 说明                                 |
| ---- | ---------------------------------- |
| 部署复杂 | 需要 Python 环境、pip 依赖、模型路径配置         |
| 双进程  | Obsidian 插件 + Python 服务端，需要分别启动/管理 |
| 迁移困难 | 换机器需要重新配置 Python 环境                |
| 端口管理 | WebSocket 端口冲突、防火墙问题               |

**理想形态：** 用户安装 Obsidian 插件 → 指定模型路径 → 一键开始录音转写。

---

## 二、目标架构概览

```
┌──────────────────────────────────────────────────┐
│  Obsidian Plugin (Main Thread)                    │
│  ┌──────────────────────────────────────────────┐ │
│  │ UI (Obsidian View)                           │ │
│  │ - 录音按钮、状态指示、实时文本展示            │ │
│  │ - 设置面板（模型路径、设备选择、参数配置）    │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │ Plugin Core (主线程)                          │ │
│  │ - 生命周期管理（start / stop / reload）       │ │
│  │ - 配置读写（Obsidian Data API）               │ │
│  │ - Worker 创建与消息路由                       │ │
│  │ - 录音文件管理（Vault 写入）                  │ │
│  └──────────┬───────────────────────────────────┘ │
│             │ MessageChannel / transferable        │
│  ┌──────────┴───────────────────────────────────┐ │
│  │ Pipeline Worker (专用 Worker 线程)            │ │
│  │                                               │ │
│  │  AudioCapture → VAD → ASR → PUNC → Output    │ │
│  │      ↑           ↑      ↑      ↑       ↓     │ │
│  │  AudioContext  FSMN   Paraformer  CT   文本   │ │
│  │  (Web Audio)  ONNX   ONNX  ONNX  累积/拆分   │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

---

## 三、关键技术卡点

### 3.1 音频采集

| 场景        | Python (当前)      | Obsidian / Electron                 |
| --------- | ---------------- | ----------------------------------- |
| 麦克风       | sounddevice (原生) | navigator.mediaDevices.getUserMedia |
| 系统音频 / 回环 | WASAPI Loopback  | **Web Audio API 不支持**               |
| 多设备       | MultiSource 线程   | 单 AudioContext                      |

**方案选择：**

- **麦克风模式（默认）：** `navigator.mediaDevices.getUserMedia({ audio: true })`，与当前 Python 版功能对等。用户可在设置中选择音频输入设备。

- **会议模式：** 使用 `desktopCapturer.getSources({ types: ['screen'] })` + `navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })`。这会同时捕获系统音频和麦克风（无法分离），适用场景为视频会议、在线课程等需要同时录制双方语音的情况。

> 注：Electron 的 `desktopCapturer` 允许捕获系统音频输出（"Loopback" 模式），但这是整个系统音频流，不含麦克风。真正的"麦克风 + 系统音频"混合需要分别获取两个流后在前端混音，或使用 Native Addon (N-API) 封装 WASAPI Loopback。

### 3.2 模型加载

```
Python:   磁盘读取 → onnxruntime.InferenceSession → ~2s
ORT Web:  文件读取/下载 → ort.InferenceSession.create() → 取决于模型
```

**模型获取策略：**

| 场景      | 方式               | 说明                                               |
| ------- | ---------------- | ------------------------------------------------ |
| 调试 / 本地 | 预置模型文件           | 用户在设置中指定本地模型路径，插件直接加载                            |
| 首次使用    | 网络下载             | 设置面板显示下载进度条，模型托管在 GitHub Releases 或 Hugging Face |
| 缓存      | IndexedDB / 本地文件 | 下载后缓存，下次启动直接使用                                   |

**实现：**

- 设置面板提供"模型来源"选项：本地路径 / 远程下载
- 远程下载时，通过 `fetch()` 流式读取 + `ReadableStream` 显示进度百分比
- 大型模型（ASR ~228MB）下载进度实时更新

### 3.3 ONNX Runtime Web + WebGPU

```
Python 当前:
  音频线程 → asyncio 队列 → VAD 协程 → asr_queue → ASR worker(线程池)
  → punc_queue → PUNC worker → TextProcessor → WS 推送

ORT Web:
  AudioContext → Pipeline Worker (单一 Worker，串行流水线)
```

**核心理由：所有模型在一个 Worker 中运行**，避免跨 Worker 传输大数组（Float32Array 音频片段）。WebGPU 模型推理在专用 Worker 内执行，UI 线程不阻塞。

### 3.4 Pipeline Worker 内部流水线

```
AudioWorklet (高优先级实时线程)
  │  每 100ms 输出 Float32Array chunk
  │  → SharedArrayBuffer (环形缓冲区，零拷贝)
  ▼
Pipeline Worker
  │
  ├─ VAD 阶段: FSMN ONNX (507KB, ~0.1s 加载)
  │   buffer 1s window → classify → speech / silence 状态机
  │
  ├─ ASR 阶段: Paraformer ONNX (228MB, ~2s 加载)
  │   speech segment → recognize → raw text
  │
  ├─ PUNC 阶段: CT-Transformer ONNX (274MB, ~0.4s 加载)
  │   raw text → punctuate → 带标点文本
  │
  └─ 输出: postMessage({ text, status }) → Main Thread → UI 更新
```

### 3.5 热词支持

ONNX Paraformer 不支持 SEACO 的实时热词注入。替代方案：

- **文本后处理层替换：** 在 PUNC 输出后，通过字符串匹配替换常见误识别词。例：ASR 输出"你" → 如果热词表中有"镍"，且上下文符合（金属讨论），替换为"镍"。
- **利用 Vault 内容：** 读取当前笔记的 frontmatter / tags / wikilinks 作为动态热词候选。
- **局限性：** 效果不如 SEACO 的 context biasing（模型内部 attention 偏置），但对高频专有名词有实用价值。

### 3.6 PUNC 上下文管理

CT-Transformer 标点模型依赖跨句子的上下文。需要管理 inference session 的缓存状态，与 Python 版 `reset_cache()` 逻辑一致。

---

## 四、和 Python 版的模块映射

```
Python 组件                 →  JS / Electron 组件
───────────────────────────────────────────────────
sounddevice + WASAPI       →  MediaDevices + AudioWorklet
kaldi_native_fbank (C++)     →  JS 纯实现 或 WASM 编译 (NEW: POC 新增难点)
asyncio + executor            →  Worker + Atomics.wait
asyncio.Queue (背压控制)      →  RingBuffer + 水位检查
threading.Queue (线程安全)    →  SharedArrayBuffer + Atomics
INT8 量化 ONNX 模型           →  ORT Web (原生支持 INT8)
Python TextProcessor          →  JS 直接移植（纯字符串操作）
funasr decode (argmax+token)  →  JS 直接移植（POC 验证通过）
日志系统                    →  console + Obsidian Notice API
模型文件管理                →  Obsidian Settings API + 本地缓存
录音保存 (WAV/WebM)         →  ffmpeg.wasm 或 MediaRecorder API
```

---

## 五、模型规格（POC 实测）

| 模型                  | 格式        | 大小          | WebGPU 加载 | WebGPU 推理     | 输入 Shape                                | 输出 Shape                         |
| ------------------- | --------- | ----------- | --------- | ------------- | --------------------------------------- | -------------------------------- |
| VAD FSMN            | ONNX INT8 | 0.5 MB      | 0.79 s    | 1795 ms (98帧) | speech [1,T,400] + 4×cache [1,128,19,1] | logits [1,T,248] + 4×cache       |
| ASR Paraformer      | ONNX INT8 | 227 MB      | 3.52 s    | 5729 ms (93帧) | speech [1,T,560], speech_lengths [1]    | logits [1,N,8404], token_num [1] |
| PUNC CT-Transformer | ONNX INT8 | 270 MB      | 1.72 s    | —             | inputs, text_lengths                    | logits                           |
| **总计**              |           | **~497 MB** | **~6 s**  | —             |                                         |                                  |

> 以上数据来自 POC，测试环境：Chrome + WebGPU，模型为 `model_quant.onnx`（INT8 量化）。首次加载后浏览器会缓存模型文件。

### 关键发现：ONNX 模型输入是特征，不是原始音频

POC 验证过程中发现一个重要细节：FunASR 导出的 ONNX 模型中，前端特征提取（fbank + LFR + CMVN）**不在模型内部**。模型输入是已经过处理的声学特征，而非原始 PCM 音频：

| 模型  | 前置处理                               | 输入维度        | 说明                   |
| --- | ---------------------------------- | ----------- | -------------------- |
| VAD | fbank(80mel) → LFR(m=5,n=1) → CMVN | [1, T, 400] | 80mel × 5帧 LFR = 400 |
| ASR | fbank(80mel) → LFR(m=7,n=6) → CMVN | [1, T, 560] | 80mel × 7帧 LFR = 560 |

这意味着 JS 端必须实现完整的 fbank + LFR + CMVN 特征提取管线，这是 POC 阶段未预料到的额外工作量。

### 特征提取实现策略

**首选：纯 JS 实现（POC-2 阶段）**

所需的 4 个模块工作量可控：

| 模块         | 复杂度 | 估计代码量 | JS 实现方式                              |
| ---------- | --- | ----- | ------------------------------------ |
| 分帧 + 汉明窗   | 低   | ~30 行 | 纯数组操作，无外部依赖                          |
| FFT → 功率谱  | 中   | ~50 行 | 自研 Radix-2 FFT 或引入 kissfft（单文件 C 移植） |
| Mel 滤波器组   | 低   | ~50 行 | 预计算三角形滤波器矩阵 + MatMul                 |
| LFR + CMVN | 低   | ~30 行 | 纯数组拼接 + am.mvn 参数加载                  |

**性能兜底：WASM 编译（仅在 JS 性能不足时启用）**

如果纯 JS 实现无法满足实时要求（单帧处理 > 10ms），走 WASM 路线：

1. 使用 `kissfft`（单文件纯 C，MIT 协议）替代 JS 自研 FFT
2. 手写 Mel 滤波器、LFR、CMVN 的 C 代码（~200 行，无外部依赖）
3. 通过 Emscripten 编译为单一 `.wasm` 文件（~50KB）

```
kissfft.c + fbank_impl.c → emcc → fbank.wasm (~50KB)
```

此方案**不依赖 kaldi-native-fbank 的复杂依赖链**（OpenBLAS/LAPACK 等），编译难度可控。但不建议作为首选——若算法逻辑已用 JS 理解并实现，性能大概率够用（每 100ms 一批音频，fbank 计算仅需数十 ms），引入 WASM 增加了编译调试环节的复杂度。

**不推荐方案：直接编译 kaldi-native-fbank 到 WASM** — 该库依赖 OpenBLAS/LAPACK 等数学库，依赖链在 Emscripten 下交叉编译极其复杂，之前社区尝试（kaldi-wasm、kaldi.js）均因维护成本过高停更。

---

## 六、开发阶段建议（POC 后更新）

| 阶段          | 内容                                   | 验证标准                 | 状态        |
| ----------- | ------------------------------------ | -------------------- | --------- |
| **POC**     | ORT Web 加载 3 个 ONNX 模型，推理验证          | 浏览器控制台输出正确文本         | **已完成** ✓ |
| **POC-2**   | JS fbank + LFR + CMVN 前端特征提取         | 与 Python 输出匹配        | **已完成** ✓ |
| **POC-3**   | 流式 VAD + cache 管理 + 状态机后处理           | 流式特征帧数匹配 + VAD 状态机正确 | **已完成** ✓ |
| **MVP-1**   | 麦克风采集 + JS 前端 + VAD + ASR + PUNC 流水线 | 实时转写，延迟 < 3s         | **已完成** ✓ |
| **MVP-2**   | Obsidian 插件骨架 + 设置面板 + 模型管理          | 插件内完成识别              | **下一阶段**  |
| **Beta**    | 热词、录音保存、性能优化、错误恢复                    | 功能完整                 | 待进行       |
| **Release** | 模型下载、打包发布、社区插件审核                     | 可发布到社区               | 待进行       |

POC 阶段新增了 **POC-2** 和 **POC-3** 子阶段：

- POC-2：发现 ONNX 模型需要外部 fbank + LFR + CMVN 特征提取，实现纯 JS 版本
- POC-3：实现流式 fbank + online LFR + VAD ONNX 推理（4×FSMN cache tensors）+ VAD 状态机后处理

### MVP-1 完成情况（2026-05-31）

在 `mvp-1/test_models.html` 实现了完整的浏览器端实时语音识别：

- **VAD**（WebGPU 流式推理）：FSMN 0.5MB，4×cache 跨块传递，正确检测语音起止
- **ASR**（WASM 批量推理）：Paraformer 227MB，首次自动加载 WASM session（~3s），后续复用
- **PUNC**（WebGPU 推理）：CT-Transformer 270MB，CharTokenizer，6 类标点
- **麦克风采集**：AudioWorklet → resample to 16kHz → 500ms chunks → RingBuffer
- **前端特征**：fbank + online LFR + CMVN（VAD lfr=5/1 400dim，ASR lfr=7/6 560dim）

**关键发现：**

1. WebGPU ASR 推理有不稳定崩溃（`reading 'fc'` null pointer），用独立 WASM session 绕过
2. VAD WebGPU 推理稳定，无需回退
3. 首次 fbank 帧可能含 `-Infinity`（CMVN 初始化不足），需 clip 裁剪
4. VAD/ASR 不能同时跑 WebGPU（"Session already started"），需 `micAsrBusy` 隔离

---

## 七、风险与未决项（POC 后更新）

| 风险                            | 状态        | 影响             | 缓解                                                                   |
| ----------------------------- | --------- | -------------- | -------------------------------------------------------------------- |
| ~~ORT Web 对 Paraformer 算子支持~~ | **已验证通过** | —              | 三个模型 WebGPU 推理无算子兼容问题                                                |
| ~~WebGPU 在浏览器中的稳定性~~          | **部分验证**  | —              | VAD WebGPU 稳定；ASR WebGPU 有不稳定崩溃（`reading 'fc'`），通过独立 WASM session 绕过 |
| ~~JS 端 fbank + LFR + CMVN~~   | **已完成**   | —              | 纯 JS 实现，95.5% 帧在 0.5 nat 内匹配 Python 参考                               |
| ~~VAD 流式推理的 cache 管理~~        | **已验证通过** | —              | JS 端正确管理 4×[1,128,19,1] FSMN cache tensors 的 streaming 生命周期          |
| WebGPU 在 Electron 中的稳定性       | **部分验证**  | ASR 推理可能需 WASM | Chrome 浏览器中 ASR WebGPU 有不稳定崩溃，Electron 中可能类似，WASM 已验证稳定              |
| ~~228MB 模型在浏览器内存中~~           | **已验证通过** | —              | INT8 量化 + WASM session，内存压力可接受                                       |
| fbank 首帧 -Infinity            | **已缓解**   | ASR 崩溃         | clipFeat() 裁剪极值到 [-50, 50]                                           |
| AudioWorklet 降采样质量            | 待改进       | 识别精度           | 当前用最近邻抽取（无抗混叠滤波），后续可加线性插值                                            |
| AudioWorklet 兼容性              | 未验证       | 音频采集失败         | 降级到 ScriptProcessorNode                                              |

---

## 八、现有参考项目

| 项目                                                                                                                     | 说明                                         | 与 Voice-Solo 的关系                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| [xenova/whisper-web](https://github.com/xenova/whisper-web) ★3324                                                      | Whisper ONNX + ORT Web + WebGPU，浏览器端实时语音识别 | 架构最接近（Web Worker + 模型推理 + 实时音频流），但不含 VAD/PUNC 流水线 |
| [microsoft/onnxruntime-inference-examples](https://github.com/microsoft/onnxruntime-inference-examples) ★1653          | ORT 官方示例，含 Web 浏览器用法                       | ORT Web 集成参考（Webpack/Vite/纯 HTML）                 |
| [Whisper WebGPU Tutorial](https://dev.to/proflead/real-time-audio-to-text-in-your-browser-whisper-webgpu-tutorial-j6d) | AudioContext → Worker → ORT WebGPU 端到端教程   | AudioWorklet + Worker 通信模式可直接复用                   |

**关键发现：** 社区已有成熟的不依赖 Python 的浏览器端语音识别方案，但都是基于 Whisper 架构。Paraformer + FSMN VAD + CT-Transformer PUNC 的 ONNX 流水线没有已知的开源前端实现。Voice-Solo 是这条路线的第一个。
