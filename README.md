# Vermilion Voice

Local speech recognition plugin for Obsidian — real-time voice transcription using ONNX runtime, no cloud required.

本地语音识别 Obsidian 插件 — 基于 ONNX 运行时的实时语音转写，无需云端。

## Features / 功能

- **Real-time transcription / 实时转写** — VAD-based speech segmentation with ASR + punctuation model
- **Local inference / 本地推理** — All processing runs on-device via ONNX WASM, no data leaves your computer
- **Dual audio capture / 双音频采集** — Microphone, desktop audio, or both merged
- **Note output / 笔记输出** — Transcription written directly to Obsidian notes with timestamps
- **Configurable / 可配置** — VAD sensitivity, line length, silence threshold, hot word replacement
- **i18n** — Chinese and English interface

## Installation / 安装

### From Community Plugins / 社区插件安装

1. Open Obsidian Settings → Community Plugins
2. Search for "Vermilion Voice"
3. Install and enable

### Manual / 手动安装

1. Download `main.js`, `manifest.json`, `styles.css` from the latest [Release](https://github.com/suinlin-onyx/vermilion-voice/releases)
2. Create folder `.obsidian/plugins/vermilion-voice/` in your vault
3. Copy the files into the folder
4. Enable the plugin in Obsidian Settings → Community Plugins

## Usage / 使用方法

1. Enable the plugin — a microphone icon appears in the left ribbon
2. Click the icon to open the Vermilion Voice panel
3. Click "Start" — models will download on first use (~50MB)
4. Speak — transcription appears in real-time
5. Click "Stop" — transcription ends

## Requirements / 系统要求

- Obsidian v1.5.6+
- Desktop only (Windows / macOS / Linux)
- Microphone permission for voice capture

## Configuration / 配置

| Setting | Description |
|---------|-------------|
| Inference Mode | Standard (ONNX WASM CPU) or Performance (WebGPU, planned) |
| Audio Capture | Merge (mic + desktop), Mic only, Desktop audio only |
| VAD Sensitivity | High (quick cut) / Medium / Low (long segments) |
| Max Line Length | Auto-wrap at punctuation threshold |
| Paragraph Silence | Silence duration to trigger paragraph break |
| Hot Words | JSON map for misrecognition correction |

## License

[MIT](LICENSE)
