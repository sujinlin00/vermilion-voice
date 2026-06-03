# 08 — 双 Worker 开发计划

> 2026-06-02 | Voice-Solo 插件 v2 架构升级

## 目标

将当前单 Worker 顺序流水线升级为双 Worker 并行流水线，消除段间盲区（~1s/段）。

## 当前架构 vs 目标架构

```
当前（单 Worker）:
  chunk → VAD fbank → VAD ONNX → 状态机 → ASR → PUNC → 下一 chunk
           ↑                                    ↑
           └────────── 同一线程，顺序执行 ─────────┘
                      ASR 期间 VAD 暂停

目标（双 Worker）:
  Worker A: chunk → VAD fbank → VAD ONNX → 状态机 → 语音段 → Main
  Worker B:                                             语音段 → ASR fbank → ONNX → 解码 → PUNC → Main
           ↑                                            ↑
           └────────── 完全并行，互不阻塞 ─────────────────┘
```

## 文件变更清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/worker-vad.ts` | Worker A — VAD 全流水线（fbank + ONNX + 状态机） |
| `src/worker-asr.ts` | Worker B — ASR + PUNC（fbank + ONNX + 解码） |
| `src/messages.ts` | 消息类型定义（从 types.ts 拆分，三端共享） |

### 修改文件

| 文件 | 变更 |
|------|------|
| `main.ts` | 管理 2 个 Worker 实例 + 消息中继 + 启动/停止协调 |
| `view.ts` | 无变更（消息接口不变） |
| `types.ts` | 新增 WorkerA→Main、Main→WorkerB 消息类型 |
| `styles.css` | 无变更 |
| `text-processor.ts` | 无变更（仍在 main 线程运行） |
| `esbuild.config.mjs` | 多入口：`worker-vad.ts` + `worker-asr.ts` |

### 删除文件

| 文件 | 原因 |
|------|------|
| `src/worker.ts` | 被 `worker-vad.ts` + `worker-asr.ts` 替代 |

## 实施步骤

### Step 1: 消息协议设计（0.5h）

定义三端消息类型，确保 Worker A / Worker B / Main 的类型安全。

```typescript
// types.ts 扩展

// Main → Worker A
type MainToVad =
  | { type: 'init'; config: VadInitConfig }
  | { type: 'start' }
  | { type: 'chunk'; data: ArrayBuffer }
  | { type: 'stop' };

// Worker A → Main
type VadToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'listening' | 'speech' }
  | { type: 'segment'; audio: ArrayBuffer; startMs: number; endMs: number }
  | { type: 'error'; message: string }
  | { type: 'progress'; phase: string; pct: number };

// Main → Worker B
type MainToAsr =
  | { type: 'init'; config: AsrInitConfig }
  | { type: 'segment'; audio: ArrayBuffer; startMs: number; endMs: number }
  | { type: 'stop' };

// Worker B → Main
type AsrToMain =
  | { type: 'ready' }
  | { type: 'status'; status: 'asr' | 'punc' }
  | { type: 'result'; text: string; startMs: number; endMs: number; perf: PerfStats }
  | { type: 'error'; message: string }
  | { type: 'progress'; phase: string; pct: number };
```

### Step 2: 拆分 Worker 代码（2h）

从 `worker.ts`（~400 行）拆分为两个文件：

**`worker-vad.ts`** — 保留 VAD 相关逻辑：
- fbank 初始化 (lfr_m=5, n=1)
- VAD ONNX session 管理
- VAD 状态机（speech/silence 检测 + pre-roll/post-roll）
- 语音段输出（裁剪 audio 从 fullAudio buffer）
- 接收 chunk、start、stop 消息

**`worker-asr.ts`** — 保留 ASR/PUNC 相关逻辑：
- ASR fbank 初始化 (lfr_m=7, n=6)
- ASR ONNX session + 预热
- PUNC ONNX session
- 解码逻辑（argmax + tokens 查表）
- 接收 segment、stop 消息

### Step 3: 重写 main.ts Worker 管理层（3h）

```typescript
// main.ts 新增管理逻辑

class WorkerManager {
  private vadWorker: Worker;
  private asrWorker: Worker;
  private vadReady = false;
  private asrReady = false;
  private asrBusy = false; // ASR 是否在处理中
  private pendingSegments: Array<{audio: Float32Array; startMs: number; endMs: number}> = [];

  async init(): Promise<void> {
    // 1. 读取 Worker 代码 + ORT + WASM 文件
    // 2. 创建两个 Blob URL
    // 3. 创建两个 Worker 实例
    // 4. 顺序 init: Worker A 先，Worker B 后（含 ASR 预热）
    // 5. 等待两个 ready 信号
  }

  start(): void {
    // 启动 AudioWorklet → chunk → Worker A
  }

  stop(): Promise<void> {
    // 1. 停止 AudioWorklet
    // 2. Worker A stop → flush 最后语音段 → Worker B
    // 3. 等待 Worker B 完成所有 pending ASR
    // 4. 终止两个 Worker
  }

  // 消息中继
  private onVadMessage(msg: VadToMain): void {
    switch (msg.type) {
      case 'segment':
        // 转发语音段到 Worker B（如果 ASR 忙则排队）
        if (this.asrBusy) {
          this.pendingSegments.push(...);
        } else {
          this.asrBusy = true;
          this.asrWorker.postMessage(msg);
        }
        break;
      case 'status':
        // 更新 UI
        break;
    }
  }

  private onAsrMessage(msg: AsrToMain): void {
    switch (msg.type) {
      case 'result':
        // 显示结果 → UI
        this.asrBusy = false;
        // 排空 pending 队列
        this.drainPending();
        break;
    }
  }
}
```

### Step 4: 构建配置更新（0.5h）

```javascript
// esbuild.config.mjs
await build({
  entryPoints: ['src/worker-vad.ts', 'src/worker-asr.ts'],
  outdir: '.',
  format: 'esm',
  bundle: true,
  // ...
});
```

### Step 5: 端到端测试（1h）

1. 单句识别 → 验证双 Worker 消息链
2. 连续多句 → 验证段间无盲区
3. 错误恢复 → 验证 Worker 崩溃后重连
4. 停止时序 → 验证最后一段不丢失

## 风险点

| 风险 | 缓解 |
|------|------|
| Worker B 处理速度跟不上语音节奏 | pending 队列限长（3 段），丢弃旧段 |
| 两个 Worker 的 ORT bundle 版本不一致 | 构建时共享同一份 lib |
| AudioWorklet buffer 在主线程和 Worker A 间多拷贝 | 使用 transfer list，零拷贝传递 |
| 停止时 pending ASR 未完成 | `stop()` 返回 Promise，等待所有 ASR 完成 |

## 预估总工时

| 步骤 | 工时 |
|------|------|
| Step 1: 消息协议 | 0.5h |
| Step 2: 拆分 Worker | 2h |
| Step 3: main.ts 重写 | 3h |
| Step 4: 构建配置 | 0.5h |
| Step 5: 测试 | 1h |
| **合计** | **7h** |
