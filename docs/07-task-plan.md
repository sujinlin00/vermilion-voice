# 07 — 任务规划：插件集成路线

> 2026-05-31 | MVP-1 完成后的下一步工作

## 当前状态

浏览器端全流水线已验证通过（`mvp-1/test_models.html`）：

```
麦克风 → VAD(WebGPU) → ASR(WASM) → PUNC(WebGPU) → 文本
```

## 路线：三步进入 Obsidian

### 第一步：Obsidian 插件骨架（目标：插件内完成一次识别）

| 任务 | 说明 | 预估 |
|------|------|------|
| 1.1 初始化插件项目 | `manifest.json`, `main.ts`, esbuild 打包, TypeScript 配置 | 2h |
| 1.2 Sidebar View | 录音按钮、状态指示、实时文本区 — 注册 `ItemView` | 3h |
| 1.3 Worker 迁移 | 将 `processMicChunk` + `finalizeSpeech` + `runPunc` 打包 | 4h |
| 1.4 AudioWorklet 迁移 | `mic_worklet.js` 作为独立文件绑入插件 | 1h |
| 1.5 模型路径配置 | Obsidian Settings API — modelDir 路径 + 文件校验 | 2h |
| 1.6 ORT + fbank 打包 | `ort.bundle.min.mjs` + `streaming_fbank.js` 纳入插件 | 2h |
| 1.7 端到端验证 | 在 Obsidian 内完成一次 VAD→ASR→PUNC 识别 | 2h |

**验收标准**: 打开 Obsidian → 点击录音按钮 → 说话 → 识别文本出现在 View 中

**文件产出**: `voice-solo/plugin/` 目录，含 `main.ts`, `view.ts`, `worker.ts`, `manifest.json`

### 第二步：功能完善（目标：可日常使用）

| 任务 | 说明 | 预估 |
|------|------|------|
| 2.1 识别结果写入笔记 | `app.vault.append()` / `app.workspace.activeEditor` 插入文本 | 2h |
| 2.2 多设备选择 | Settings 面板 — 枚举 `mediaDevices.enumerateDevices()` 音频输入 | 2h |
| 2.3 热词替换 | Settings 面板 — 替换表 `{"电缆": "靛蓝", "云朵": "吲哚", ...}`，PUNC 后执行 | 2h |
| 2.4 模型下载 | 从 GitHub Releases 下载模型文件 + 进度条 + IndexedDB 缓存 | 4h |
| 2.5 错误恢复 | WebGPU → WASM 自动降级, AudioContext 重连, 模型文件缺失提示 | 2h |
| 2.6 录音保存 | MediaRecorder API → WAV/WebM → Vault 指定目录 | 2h |

**验收标准**: 设置面板完整, 热词生效, 识别结果写入笔记, 模型可远程下载

### 第三步：打包发布（目标：他人可安装使用）

| 任务 | 说明 | 预估 |
|------|------|------|
| 3.1 模型托管 | FunASR 模型上传到 GitHub Releases（~500MB total） | 1h |
| 3.2 首次使用引导 | 欢迎页 / 设置向导 — 模型下载 → 路径配置 → 测试识别 | 3h |
| 3.3 TextProcessor 精细化 | Python 版 TextProcessor 逻辑移植到 JS（分段/去重/纠错） | 3h |
| 3.4 性能优化 | 模型 IndexedDB 缓存, 减少首帧延迟, 内存监控 | 2h |
| 3.5 兼容测试 | Windows/Mac/Linux + Chrome/Electron 不同版本 | 3h |
| 3.6 社区发布 | Obsidian Community Plugin 提交, README, 截图 | 2h |

**验收标准**: `obsidian://` 链接安装后，指定模型路径即可使用

## 可复用模块清单

从 MVP-1 直接复用的模块：

| 模块 | 来源 | 插件中位置 |
|------|------|-----------|
| `StreamingFbankProcessor` + `loadCMVN` | `poc-3/streaming_fbank.js` | Worker 内 import |
| VAD 流式推理 + 状态机 | `test_models.html` `processMicChunk` | Worker 主函数 |
| ASR 推理 + 解码 | `test_models.html` `finalizeSpeech` | Worker 内调用 |
| PUNC 推理 + 拼接 | `test_models.html` `runPunc` | Worker 内调用 |
| AudioWorklet 降采样 | `mvp-1/mic_worklet.js` | 插件 assets |
| ORT Web bundle | `mvp-1/ort.bundle.min.mjs` + WASM files | 插件 lib |
| 特征裁剪 | `test_models.html` `clipFeat` | Worker 工具函数 |
| WASM ASR session 懒加载 | `test_models.html` `micAsrWasmSession` | Worker 初始化 |

## 技术债务（不阻塞发布，记录用于后续版本）

| 项 | 优先级 | 说明 |
|----|--------|------|
| AudioWorklet 抗混叠滤波 | 低 | 当前最近邻抽取有混叠，加线性插值或 Sinc |
| WebGPU ASR 崩溃根因 | 中 | `reading 'fc'` 是 ORT 内部问题，需关注 upstream |
| JS fbank 精度对齐 Python | 中 | 当前 0.077 nat 差异，可进一步排查 FFT/Mel 细节 |
| PUNC 上下文管理 | 低 | CT-Transformer 跨句缓存（当前每段独立） |
| 内存优化 | 中 | 500MB 模型常驻，长时间录音 buffer 管理 |

## 开发顺序

```
第一步 ──→ 第二步 ──→ 第三步
 (1-2天)    (2-3天)    (1-2天)
```

每个步骤结束时设置 checkpoint，验证核心功能正常后再进入下一步。不跳步、不并行。
