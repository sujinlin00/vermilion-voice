# Vermilion Voice

[English](./README.md) | 简体中文

Obsidian 本地语音识别插件 — 基于 ONNX 运行时的实时语音转写，无需云端。

## 功能特性

- **实时转写** — VAD → ASR → 标点恢复全流水线，基于 ONNX WASM 本地运行
- **双 Worker 架构** — VAD 和 ASR 在独立 Worker 中并行运行，消除段间盲区
- **双音频采集** — 麦克风、桌面音频，或两者合并（Web Audio API GainNode 混音）
- **笔记输出** — 转写文本直接写入 Obsidian 笔记，带 `[HH:MM:SS]` 时间戳
- **智能换行** — 基于静音的段落分隔 + 基于长度的行换行，换行标点与切分标点独立配置
- **跨段去重** — 相邻 ASR 段之间的重叠文本自动去重
- **并行模型下载** — 三个模型（VAD/ASR/PUNC）同时下载，实时显示进度：`vad:50%|asr:30%|punc:10%`
- **MD5 校验** — 下载的模型文件自动验证完整性
- **国际化** — 支持中文和英文界面，设置中切换

## 安装

### 社区插件安装（推荐）

1. 打开 Obsidian 设置 → 社区插件
2. 搜索 "Vermilion Voice"
3. 安装并启用

### 手动安装（zip）

1. 从 [Releases](https://github.com/sujinlin00/vermilion-voice/releases) 下载 `vermilion-voice-x.x.x.zip`
2. 解压到你的 Obsidian 库的 `.obsidian/plugins/vermilion-voice/` 目录
3. 在 Obsidian 设置 → 社区插件中启用

```bash
# Linux / macOS
cd /path/to/vault/.obsidian/plugins/
unzip vermilion-voice-0.1.1.zip -d vermilion-voice/
```

## 使用方法

1. 启用插件 — 左侧功能区出现麦克风图标
2. 点击图标打开 Vermilion Voice 面板
3. 点击"开始识别" — 首次使用会自动下载模型（约 50MB，带进度显示）
4. 说话 — 转写文本实时显示
5. 点击"停止" — 结束识别

## 系统要求

- Obsidian v1.5.6+
- 仅支持桌面端（Windows / macOS / Linux）
- 需要麦克风权限

## 开发

```bash
git clone https://github.com/sujinlin00/vermilion-voice.git
cd vermilion-voice
npm install
npm run build     # 生产构建 → plugin/ + 发布 zip
npm run dev       # 开发构建（含 sourcemap）
```

### 项目结构

```
vermilion-voice/
├── assets/               插件静态资源（manifest、models、样式）
├── src/                  TypeScript 源码
├── lib/                  Vendored 第三方依赖（ONNX Runtime、FLAC 编码器）
├── plugin/               构建输出（gitignored）
├── docs/                 文档
├── esbuild.config.mjs    构建脚本
├── package.json          npm 配置
└── tsconfig.json         TypeScript 配置
```

详见 [docs/02-architecture.md](./02-architecture.md)。

## 技术细节

### 流水线架构

```
AudioContext (48kHz)
  → AudioWorklet (降采样到 16kHz, 500ms chunk)
  → Worker A (VAD): FSMN 模型, 10ms/帧, 语音/静音状态机
  → Worker B (ASR + PUNC): Paraformer-large + CT-Transformer
  → TextProcessor: 去重、换行、carry-over
  → Obsidian 笔记
```

### 模型

| 模型               | 大小     | 用途                           |
| ---------------- | ------ | ---------------------------- |
| FSMN-VAD         | ~500KB | 语音活动检测, 10ms/帧               |
| Paraformer-large | ~228MB | 非自回归 ASR, 速度是 Whisper 的 60 倍 |
| CT-Transformer   | ~270MB | 标点恢复                         |

所有模型来自 [ModelScope FunASR](https://modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx)，首次使用时自动下载。

### 关键设计决策

- **Blob URL Worker** — Obsidian 运行在 `app://` 源，Worker 通过 Blob URL 创建以绕过跨域限制
- **WASM-only 推理** — 所有模型使用 ONNX WASM CPU 后端，确保稳定性（WebGPU 支持计划中）
- **强制分段** — VAD 在可配置的时长（3-8 秒）自动切分语音段，带静音感知的边界检测
- **Carry-over 机制** — 强制切分的段在标点处分割；无标点的尾部文本携带到下一段重新标点化

## 配置项

| 设置      | 说明                                 |
| ------- | ---------------------------------- |
| 语言      | 中文 / English                       |
| 推理精度    | 标准（ONNX WASM CPU）或高性能（WebGPU，计划支持） |
| 音频采集    | 合并（麦克风 + 桌面）、仅麦克风、仅桌面音频            |
| VAD 灵敏度 | 高（短句快切）/ 中 / 低（长句慢切）               |
| 文本推送间隔  | 1 秒 / 3 秒 / 5 秒                    |
| 段落分隔静音  | 静音超过此值时输出换行（1.5-3.0 秒）             |
| 单行字数上限  | 超过字数后遇到标点自动换行（60/90/120/不限制）       |
| 最长语音分段  | 强制切分阈值（3/4/6/8 秒）                  |

## 许可证

[MIT](../LICENSE)
