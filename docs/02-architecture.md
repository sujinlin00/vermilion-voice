# 02 — 架构设计

## 实际实现结构（迭代后）

```
vermilion-voice/
├── assets/                    # Obsidian 插件静态资源
│   ├── manifest.json
│   ├── models.json
│   ├── settings.json
│   ├── styles.css
│   └── mic_worklet.js
├── src/                       # 源码
│   ├── main.ts                # 插件入口，Worker 管理 + AudioWorklet
│   ├── worker-vad.ts          # VAD Worker (始终运行，永不阻塞)
│   ├── worker-asr.ts          # ASR+PUNC Worker (按需触发)
│   ├── worker.ts              # [遗留] 单 Worker 流水线
│   ├── view.ts                # 侧边栏视图
│   ├── types.ts               # 消息协议类型
│   ├── i18n.ts                # 国际化
│   ├── text-processor.ts      # 文本后处理（断句+去重）
│   ├── flac-encoder.ts        # FLAC 编码器封装
│   ├── audio-capture.ts       # 音频采集管理
│   ├── fbank.js               # fbank+LFR+CMVN 特征提取
│   └── streaming_fbank.js     # 流式 fbank 封装
├── lib/                       # Vendored 第三方依赖
│   ├── ort.bundle.min.mjs     # ONNX Runtime 1.20.1 (WASM+WebGPU)
│   ├── ort-wasm-simd-threaded.wasm
│   ├── ort-wasm-simd-threaded.jsep.wasm
│   ├── ort-wasm-simd-threaded.{mjs,jsep.mjs}
│   └── flac.js                # FLAC 编码器 (runtime 加载)
├── plugin/                    # 构建输出 (gitignored)
├── docs/                      # 文档
├── esbuild.config.mjs         # 构建脚本
├── package.json               # npm 配置
└── tsconfig.json              # TypeScript 配置
```

## 进程模型（双 Worker 并行）

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
│  └───────────────────┘                │              │
│                                       │              │
│  ┌────────────────────────────────────┴────────────┐  │
│  │ Worker B (ASR + PUNC)                           │  │
│  │ WASM, 500MB                                     │  │
│  │ 按需触发：语音段到达 → ASR fbank → ONNX → PUNC │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 为什么用 Blob URL？

Obsidian 运行在 `app://obsidian.md` 源。`new Worker('file:///...')` 被跨域策略拒绝。解决方案：

1. 主线程用 `require('fs').readFileSync()` 分别读取 `worker-vad.js` 和 `worker-asr.js`
2. 各自创建 `new Blob([code], {type: 'application/javascript'})`
3. `new Worker(URL.createObjectURL(blob), {type: 'module'})` 创建两个独立 Worker
4. ORT WASM 文件同理预加载，Worker 内 `self.fetch` 拦截返回

### 消息流

```
AudioWorklet
  │  Float32Array chunk (500ms)
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

### 三模型后端策略

| 模型 | 后端 | 原因 |
|------|------|------|
| VAD (0.5MB) | WASM | 小模型，GPU 无收益；不与 ASR 争用 GPU |
| ASR (227MB) | **WASM** | WebGPU 不稳定（ORT JSEP 内部空指针）；WASM 稳定+预热快 |
| PUNC (270MB) | WASM | 在 Worker B 内顺序执行，行为稳定 |

### 关键设计决策

1. **所有模型统一 WASM** — WebGPU 对 Paraformer 不稳定，GPU 回退只会增加 session 重建开销
2. **ASR 预热** — init 期用 0.5s 静音片段触发 WASM JIT 编译，消除首句冷启动惩罚 (3.7s→0.8s)
3. **Worker A 永不阻塞** — VAD 始终运行，段间无盲区，音频零丢失
4. **Worker B 按需触发** — 语音段到达时由 Main 转发，无需队列，串行处理避免竞态

### 启动时序

```
1. Worker A init → VAD 模型 + fbank → ready
2. Worker B init → ASR 预热 + PUNC 模型 → ready
3. AudioWorklet 启动 → chunk → Worker A
4. Worker A 检测到语音段 → 发送到 Worker B（此时必定 ready）
```

### 停止时序

```
1. 停止 AudioWorklet（不再产生新 chunk）
2. Worker A 收到 stop → flush 最后语音段 → Worker B
3. 等待 Worker B 完成所有 pending ASR
4. 终止两个 Worker
```

### 双 Worker 构建配置

两个入口文件：`src/worker-vad.ts` → `plugin/worker-vad.js`，`src/worker-asr.ts` → `plugin/worker-asr.js`。esbuild 原生支持多入口，构建输出到 `plugin/` 目录。

ORT bundle 在两个 Worker 间通过 `postMessage` 传递（slice 拷贝，实际开销极小）。

### 单 Worker → 双 Worker 收益

| 指标 | 单 Worker（旧） | 双 Worker | 改善 |
|------|-----------------|----------|------|
| 段间盲区 | ~1s/段（ASR 阻塞 VAD） | **0s** | 消除 |
| 每段 ASR 期间丢失音频 | ~0.9s | **0s** | 消除 |
| VAD 状态连续性 | 断断续续 | **持续运行** | — |
| 内存 | ~500MB | +3MB（ORT bundle 重复） | 可忽略 |

### 当前限制

| 问题 | 原因 |
|------|------|
| ASR 推理速度 (~8x 实时) | 单线程 WASM 瓶颈 |
| WASM 多线程 | 受 Blob URL Worker 安全策略限制 |
| WebGPU 不稳定 | Paraformer 模型 ORT JSEP 内部空指针 |
