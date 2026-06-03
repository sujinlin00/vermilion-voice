# 10 — 双 Worker 实施任务

> 2026-06-02

## Step 1: 消息协议设计

- [ ] 1.1 定义 `MainToVad` / `VadToMain` / `MainToAsr` / `AsrToMain` 四组消息类型
- [ ] 1.2 从 `InitConfig` 拆分 `VadInitConfig`（VAD 模型 + fbank 配置）和 `AsrInitConfig`（ASR/PUNC 模型 + WASM + tokens）
- [ ] 1.3 在 `types.ts` 中定义 `PerfStats`（已有，确认可复用）

## Step 2: 拆分 Worker

- [ ] 2.1 创建 `worker-vad.ts` — 从 `worker.ts` 提取：
  - VAD fbank 初始化（lfr_m=5, n=1, cmvn）
  - VAD ONNX session（WASM，固定）
  - VAD 状态机（speech/silence 检测 + pre-roll/post-roll）
  - 4×FSMN cache 管理
  - 音频累积（fullAudio buffer）+ 语音段裁剪
  - 消息处理：init / start / chunk / stop
  - 输出：语音段 Float32Array + startMs/endMs → Main

- [ ] 2.2 创建 `worker-asr.ts` — 从 `worker.ts` 提取：
  - ASR fbank 初始化（lfr_m=7, n=6, cmvn）
  - ASR ONNX session + 预热（WASM）
  - PUNC ONNX session（WASM）
  - 解码逻辑（argmax + tokens 查表）
  - 消息处理：init / segment / stop
  - 输出：识别文本 + perf stats → Main

- [ ] 2.3 删除 `worker.ts`（被上述两个文件替代）

## Step 3: main.ts Worker 管理器

- [ ] 3.1 实现 `WorkerManager` 类：
  - 两个 Worker 实例创建（Blob URL × 2）
  - ORT + WASM 文件读取 + slice 拷贝
  - 顺序 init：Worker A → Worker B → AudioWorklet
  - start/stop 生命周期

- [ ] 3.2 消息中继逻辑：
  - AudioWorklet chunk → Worker A
  - Worker A segment → Worker B（含 pending 队列，ASR 忙时排队）
  - Worker A status → UI
  - Worker B result → TextProcessor → UI

- [ ] 3.3 停止协调：
  - AudioWorklet.stop → Worker A.stop（flush 最后段）→ Worker B.stop（等待完成）→ terminate

- [ ] 3.4 错误处理：
  - 单个 Worker 崩溃不影响另一个
  - 错误通过 postMessage 上报 UI

## Step 4: 构建配置

- [ ] 4.1 更新 `esbuild.config.mjs` — 多入口：`worker-vad.ts` + `worker-asr.ts`
- [ ] 4.2 更新文件拷贝逻辑（`worker-vad.js` + `worker-asr.js` 替代 `worker.js`）

## Step 5: 端到端验证

- [ ] 5.1 单句识别：验证双 Worker 消息链完整
- [ ] 5.2 连续多句：验证段间无盲区（相邻段 endMs/startMs 接近）
- [ ] 5.3 停止时序：验证最后一段不丢失
- [ ] 5.4 错误恢复：Worker 崩溃后重新开始识别

---

## 验证标准

```
单 Worker（当前）:
  42.8s — 44.9s  2.1s 间隙
  54.5s — 55.3s  0.8s 间隙
  75.7s — 79.1s  3.4s 间隙
  → 间隙 = ASR 阻塞 + VAD 恢复 + 用户停顿

双 Worker（目标）:
  42.8s — 44.9s  2.1s 间隙（仅用户停顿 + VAD silence timeout）
  54.5s — 55.3s  0.8s 间隙（仅用户停顿 + VAD silence timeout）
  → 间隙 = VAD silence timeout + 用户停顿，不再包含 ASR 阻塞
  → ASR 阻塞盲区 ~0.9s/段被消除
```
