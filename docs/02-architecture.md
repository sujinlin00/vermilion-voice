# 02 — 架构设计

## 实际实现结构（迭代后）

```
voice-solo/plugin/
├── manifest.json              # Obsidian 插件清单
├── main.js / main.ts          # 插件入口，Worker 管理 + AudioWorklet
├── worker.js / worker.ts      # VAD→ASR→PUNC 全流水线 (Web Worker)
├── mic_worklet.js             # AudioWorklet 麦克风降采样
├── styles.css                 # UI 样式
├── lib/
│   ├── ort.bundle.min.mjs     # ONNX Runtime 1.20.1 (WASM+WebGPU)
│   ├── ort-wasm-simd-threaded.wasm
│   ├── ort-wasm-simd-threaded.jsep.wasm
│   ├── streaming_fbank.js     # 流式 fbank+LFR+CMVN
│   └── fbank.js               # 离线 fbank
├── src/
│   ├── main.ts                # 插件入口
│   ├── worker.ts              # Worker 流水线
│   ├── view.ts                # 侧边栏视图
│   ├── types.ts               # 消息协议类型
│   └── text-processor.ts      # 文本后处理（断句+去重）
├── docs/                      # 本文档目录
└── esbuild.config.mjs         # 打包脚本
```

## 进程模型

```
┌─────────────────────────────────────────────────┐
│  Main Thread (Obsidian app://)                   │
│  ┌─────────────────────────────────────────────┐ │
│  │ Plugin Core (main.ts)                       │ │
│  │ - 生命周期 / Worker 管理 / 文件 I/O (fs)   │ │
│  │ - 模型+WASM 预加载 → postMessage 传递      │ │
│  │ - AudioWorklet Node (Blob URL)              │ │
│  └──────────────┬──────────────────────────────┘ │
│                 │ Worker (Blob URL)               │
│  ┌──────────────┴──────────────────────────────┐ │
│  │ PipelineWorker (worker.ts)                   │ │
│  │  ORT 静态导入 (esbuild 打包)                 │ │
│  │  VAD(WASM) → ASR(WASM) → PUNC(WASM)         │ │
│  │  fetch 拦截 → 返回主线程预加载的 WASM 文件    │ │
│  └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 为什么用 Blob URL？

Obsidian 运行在 `app://obsidian.md` 源。`new Worker('file:///...')` 被跨域策略拒绝。解决方案：

1. 主线程用 `require('fs').readFileSync()` 读取 `worker.js` 内容
2. 创建 `new Blob([code], {type: 'application/javascript'})`
3. `new Worker(URL.createObjectURL(blob), {type: 'module'})`
4. ORT WASM 文件同理预加载，Worker 内 `self.fetch` 拦截返回

### 三模型后端策略（最终版）

| 模型 | 后端 | 原因 |
|------|------|------|
| VAD (0.5MB) | WASM | 小模型，GPU 无收益；不与 ASR 争用 GPU |
| ASR (227MB) | **WASM** | WebGPU 必然崩溃 (`reading 'fc'`)；WASM 稳定+预热快 |
| PUNC (270MB) | WASM | ASR 期间 VAD 暂停，无争用；避免 GPU 挂起风险 |

### 关键设计决策

1. **所有模型统一 WASM** — WebGPU 对 Paraformer 不稳定（ORT JSEP 内部空指针），GPU 回退只会增加 session 重建开销
2. **ASR 预热** — init 期用 0.5s 静音片段触发 WASM JIT 编译，消除首句冷启动惩罚 (3.7s→0.8s)
3. **音频零丢失** — `processChunk` 始终累积音频+计算 fbank，仅在 ASR 期间跳过 VAD ONNX（避免 session 争用）
4. **顺序处理** — 无队列、无 fire-and-forget，避免竞态条件

### 当前限制：单 Worker 顺序执行

```
chunk → VAD fbank → VAD ONNX → 状态机 → ASR → PUNC → 下一 chunk
                                  ↑
                             ASR 期间 VAD 暂停
                             段间盲区 ~1s
```

与 Python `voice-transcribe` 的并发模型对比：

| | Python | JS 插件（当前） |
|---|---|---|
| 并发模型 | `asyncio` 协程 + `ThreadPoolExecutor(4)` | 单 Worker 线程，无并发 |
| 流水线 | VAD/ASR/PUNC 三个独立 asyncio task，队列解耦 | 全部顺序串联 |
| ORT 线程 | `CPUExecutionProvider`，OS 原生多线程 | `numThreads=1`，单线程 WASM |
| 并行推理 | VAD 处理 chunk N+1 的同时 ASR 处理段 N | ASR 期间 VAD 暂停 |
| 段间盲区 | 0（VAD 持续运行） | ~1s（ASR 阻塞 VAD） |

---

## 演进方向：双 Worker 流水线

### 目标

消除段间盲区，实现 VAD 和 ASR 的真正并行。

### 架构

```
┌──────────────────────────────────────────────────────┐
│  Main Thread                                         │
│  ┌────────────────────┐  ┌────────────────────────┐  │
│  │ AudioWorklet       │  │ Message Router         │  │
│  │ (mic_worklet.js)   │  │ - chunk → Worker A     │  │
│  │ 48k→16k 降采样    │  │ - Worker A → status UI │  │
│  └────────┬───────────┘  │ - Worker A → Worker B  │  │
│           │              │ - Worker B → result UI │  │
│           │              └──┬──────────┬──────────┘  │
│  ┌────────┴──────────┐     │          │              │
│  │ Worker A (VAD)    │◄────┘          │              │
│  │ WASM, 0.5MB       │                │              │
│  │ 始终运行，永不阻塞 │               │              │
│  │ VAD fbank → ONNX  │                │              │
│  │ → 状态机 → 语音段 │                │              │
│  └───────────────────┘                │              │
│                                       │              │
│  ┌────────────────────────────────────┴────────────┐  │
│  │ Worker B (ASR + PUNC)                           │  │
│  │ WASM, 500MB                                     │  │
│  │ 按需触发：语音段到达 → ASR fbank → ONNX → PUNC │  │
│  │ → 解码 → 文本 → Main → UI                      │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 消息流

```
AudioWorklet
  │  Float32Array chunk (128 samples = 8ms)
  ▼
Main Thread
  ├──→ Worker A: { type: 'chunk', data: ArrayBuffer }
  │
Worker A
  │  VAD 处理 → 检测语音段
  ├──→ Main: { type: 'status', status: 'speech' | 'listening' }
  ├──→ Main: { type: 'segment', audio: ArrayBuffer, startMs, endMs }
  │
Main Thread
  ├──→ UI: 更新状态显示
  └──→ Worker B: { type: 'segment', audio: ArrayBuffer, startMs, endMs }
  │
Worker B
  │  ASR fbank → ONNX → 解码 → PUNC
  └──→ Main: { type: 'result', text, startMs, endMs, perf }
  │
Main Thread
  └──→ UI: 显示识别结果
```

### 需要解决的问题

**1. ORT + WASM 重复加载**

两个 Worker 各需 `ort.bundle.min.mjs`(776KB) + 两个 `.wasm` 文件(~2MB)。主线程 `fs.readFileSync` 读取后通过 `postMessage` **transfer** 给 Worker，transfer 后 ArrayBuffer 变空。两个 Worker 各需一份。

解决方案：
```typescript
// 主线程读一次，slice 拷贝
const ortBuf = readBuf('ort.bundle.min.mjs');
const threadWasm = readBuf('ort-wasm-simd-threaded.wasm');
const jsepWasm = readBuf('ort-wasm-simd-threaded.jsep.wasm');

// 各给一份（slice 浅拷贝，数据共享直到修改，实际开销极小）
workerA.postMessage({ ortBuf: ortBuf.slice(0), ... });
workerB.postMessage({ ortBuf: ortBuf.slice(0), ... });
```

**2. 构建配置**

两个入口文件：`worker-vad.ts` → `worker-vad.js`，`worker-asr.ts` → `worker-asr.js`。esbuild 原生支持多入口：
```javascript
entryPoints: ['src/worker-vad.ts', 'src/worker-asr.ts'],
```

**3. 启动时序**

```
1. Worker A init → VAD 模型 + fbank → ready
2. Worker B init → ASR 预热 + PUNC 模型 → ready
3. AudioWorklet 启动 → chunk → Worker A
4. Worker A 检测到语音段 → 发送到 Worker B（此时必定 ready）
```

必须保证 Worker B 的 ASR 预热在 chunk 到达前完成。

**4. 停止时序**

```
1. 停止 AudioWorklet（不再产生新 chunk）
2. Worker A 收到 stop → flush 最后语音段 → Worker B
3. 等待 Worker B 完成所有 pending ASR
4. 终止两个 Worker
```

顺序搞错会导致最后一段语音丢失。

**5. Main 线程膨胀**

当前 `main.ts` ~290 行。双 Worker 后需管理 2 个 Worker 实例 + 消息中继 + 状态协调 → 预计 ~500 行。需要提取子模块。

### 收益量化

| 指标 | 单 Worker（当前） | 双 Worker | 改善 |
|------|-----------------|----------|------|
| 段间盲区 | ~1s/段（ASR 阻塞 VAD） | **0s** | 消除 |
| 每段 ASR 期间丢失音频 | ~0.9s | **0s** | 消除 |
| 15 段/次识别累计盲区 | ~13.5s | **0s** | — |
| VAD 状态连续性 | 断断续续 | **持续运行** | — |
| 内存 | ~500MB | +3MB（ORT bundle 重复） | 可忽略 |
| 构建复杂度 | 1 Worker 入口 | 2 Worker 入口 | +1 esbuild entry |
| 代码量 (main.ts) | ~290 行 | ~500 行 | +70% |

### 不解决的问题

| 问题 | 原因 |
|------|------|
| ASR 推理速度 (~8x 实时) | 单线程 WASM 瓶颈，双 Worker 不影响 ASR 自身速度 |
| VAD 静音检测 1s 延迟 | VAD 参数配置，非架构问题 |
| PUNC 稳定性 | PUNC 在 Worker B 内顺序执行，行为不变 |
| WASM 多线程 | 始终受 Blob URL Worker 安全策略限制 |
