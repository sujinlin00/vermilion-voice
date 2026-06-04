# Vermilion Voice

[简体中文](./README_zh.md) | English

Local speech recognition plugin for Obsidian — real-time voice transcription using ONNX runtime, no cloud required.

## Features

- **Real-time transcription** — VAD → ASR → Punctuation pipeline, all running locally via ONNX WASM
- **Dual Worker architecture** — VAD and ASR run in separate workers in parallel, eliminating inter-segment blind spots
- **Dual audio capture** — Microphone, desktop audio, or both merged via Web Audio API GainNode mixing
- **Note output** — Transcription written directly to Obsidian notes with `[HH:MM:SS]` timestamps
- **Intelligent line breaking** — Silence-based paragraph breaks + length-based line breaks with separate punctuation configs
- **Cross-segment dedup** — Overlap deduplication between consecutive ASR segments
- **Parallel model download** — Three models (VAD/ASR/PUNC) download concurrently with progress: `vad:50%|asr:30%|punc:10%`
- **MD5 verification** — Downloaded model files are verified for integrity
- **i18n** — Chinese and English interface, switchable in settings

## Installation

### From Community Plugins (recommended)

1. Open Obsidian Settings → Community Plugins
2. Search for "Vermilion Voice"
3. Install and enable

### Manual (zip)

1. Download `vermilion-voice-x.x.x.zip` from [Releases](https://github.com/sujinlin00/vermilion-voice/releases)
2. Extract to your vault's `.obsidian/plugins/vermilion-voice/` directory
3. Enable the plugin in Obsidian Settings → Community Plugins

```bash
# Linux / macOS
cd /path/to/vault/.obsidian/plugins/
unzip vermilion-voice-0.1.0.zip -d vermilion-voice/
```

## Usage

1. Enable the plugin — a microphone icon appears in the left ribbon
2. Click the icon to open the Vermilion Voice panel
3. Click "Start" — models will download on first use (~50MB, with progress display)
4. Speak — transcription appears in real-time
5. Click "Stop" — transcription ends

## Requirements

- Obsidian v1.5.6+
- Desktop only (Windows / macOS / Linux)
- Microphone permission for voice capture

## Technical Details

### Pipeline Architecture

```
AudioContext (48kHz)
  → AudioWorklet (resample to 16kHz, 500ms chunks)
  → Worker A (VAD): FSMN model, 10ms/frame, speech/silence state machine
  → Worker B (ASR + PUNC): Paraformer-large + CT-Transformer
  → TextProcessor: dedup, line breaking, carry-over
  → Obsidian note
```

### Models

| Model | Size | Purpose |
|-------|------|---------|
| FSMN-VAD | ~500KB | Voice Activity Detection, 10ms/frame |
| Paraformer-large | ~228MB | Non-autoregressive ASR, 60x faster than Whisper |
| CT-Transformer | ~270MB | Punctuation restoration |

All models are from [ModelScope FunASR](https://modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx), downloaded automatically on first use.

### Key Design Decisions

- **Blob URL Workers** — Obsidian runs on `app://` origin, so Workers are created from Blob URLs to bypass cross-origin restrictions
- **WASM-only inference** — All models use ONNX WASM CPU backend for stability (WebGPU support planned)
- **Forced segment cut** — VAD auto-cuts speech segments at configurable duration (3-8s), with silence-aware boundary detection
- **Carry-over mechanism** — Forced-cut segments are split at punctuation boundaries; unpunctuated tail is carried to the next segment for re-punctuation

## Configuration

| Setting | Description |
|---------|-------------|
| Language | Chinese / English |
| Inference Mode | Standard (ONNX WASM CPU) or Performance (WebGPU, planned) |
| Audio Capture | Merge (mic + desktop), Mic only, Desktop audio only |
| VAD Sensitivity | High (quick cut) / Medium / Low (long segments) |
| Output Interval | 1s / 3s / 5s refresh rate |
| Paragraph Silence | Silence duration to trigger paragraph break (1.5-3.0s) |
| Max Line Length | Auto-wrap at punctuation (60/90/120/unlimited) |
| Max Speech Duration | Force-cut threshold (3/4/6/8s) |

## License

[MIT](LICENSE)
