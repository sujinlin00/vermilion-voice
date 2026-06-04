# Vermilion Voice

[简体中文](./README_zh.md) | English

Local speech recognition plugin for Obsidian — real-time voice transcription using ONNX runtime, no cloud required.

## Features

- **Real-time transcription** — VAD-based speech segmentation with ASR + punctuation model
- **Local inference** — All processing runs on-device via ONNX WASM, no data leaves your computer
- **Dual audio capture** — Microphone, desktop audio, or both merged
- **Note output** — Transcription written directly to Obsidian notes with timestamps
- **Configurable** — VAD sensitivity, line length, silence threshold
- **i18n** — Chinese and English interface

## Installation

### From Community Plugins

1. Open Obsidian Settings → Community Plugins
2. Search for "Vermilion Voice"
3. Install and enable

### Manual

1. Download `main.js`, `manifest.json`, `styles.css` from the latest [Release](https://github.com/sujinlin00/vermilion-voice/releases)
2. Create folder `.obsidian/plugins/vermilion-voice/` in your vault
3. Copy the files into the folder
4. Enable the plugin in Obsidian Settings → Community Plugins

## Usage

1. Enable the plugin — a microphone icon appears in the left ribbon
2. Click the icon to open the Vermilion Voice panel
3. Click "Start" — models will download on first use (~50MB)
4. Speak — transcription appears in real-time
5. Click "Stop" — transcription ends

## Requirements

- Obsidian v1.5.6+
- Desktop only (Windows / macOS / Linux)
- Microphone permission for voice capture

## Configuration

| Setting | Description |
|---------|-------------|
| Inference Mode | Standard (ONNX WASM CPU) or Performance (WebGPU, planned) |
| Audio Capture | Merge (mic + desktop), Mic only, Desktop audio only |
| VAD Sensitivity | High (quick cut) / Medium / Low (long segments) |
| Max Line Length | Auto-wrap at punctuation threshold |
| Paragraph Silence | Silence duration to trigger paragraph break |

## License

[MIT](LICENSE)
