# Vermilion Voice

[English](./README.md) | 简体中文

Obsidian 本地语音识别插件 — 基于 ONNX 运行时的实时语音转写，无需云端。

## 功能特性

- **实时转写** — 基于 VAD 的语音分段，配合 ASR + 标点模型
- **本地推理** — 所有处理通过 ONNX WASM 在设备端运行，数据不离开你的电脑
- **双音频采集** — 麦克风、桌面音频，或两者合并
- **笔记输出** — 转写文本直接写入 Obsidian 笔记，带时间戳
- **可配置** — VAD 灵敏度、行长度、静音阈值
- **国际化** — 支持中文和英文界面

## 安装

### 社区插件安装

1. 打开 Obsidian 设置 → 社区插件
2. 搜索 "Vermilion Voice"
3. 安装并启用

### 手动安装

1. 从最新 [Release](https://github.com/sujinlin00/vermilion-voice/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 在你的 Obsidian 库中创建文件夹 `.obsidian/plugins/vermilion-voice/`
3. 将文件复制到该文件夹
4. 在 Obsidian 设置 → 社区插件中启用

## 使用方法

1. 启用插件 — 左侧功能区出现麦克风图标
2. 点击图标打开 Vermilion Voice 面板
3. 点击"开始识别" — 首次使用会自动下载模型（约 50MB）
4. 说话 — 转写文本实时显示
5. 点击"停止" — 结束识别

## 系统要求

- Obsidian v1.5.6+
- 仅支持桌面端（Windows / macOS / Linux）
- 需要麦克风权限

## 配置项

| 设置 | 说明 |
|------|------|
| 推理精度 | 标准（ONNX WASM CPU）或高性能（WebGPU，计划支持） |
| 音频采集 | 合并（麦克风 + 桌面）、仅麦克风、仅桌面音频 |
| VAD 灵敏度 | 高（短句快切）/ 中 / 低（长句慢切） |
| 单行字数上限 | 超过字数后遇到标点自动换行 |
| 段落分隔静音 | 静音超过此值时输出换行 |

## 许可证

[MIT](LICENSE)
