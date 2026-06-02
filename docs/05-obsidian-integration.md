# 05 — Obsidian 插件集成

## manifest.json

```json
{
  "id": "voice-solo",
  "name": "Voice Solo",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "本地语音识别，无需外部服务。ONNX 模型直接运行在设备上。",
  "author": "",
  "isDesktopOnly": true
}
```

`isDesktopOnly: true` — 模型文件大，移动端不现实。WebGPU 也只在桌面 Electron 中稳定。

## 生命周期

```typescript
// main.ts
import { Plugin } from "obsidian";
import { VoiceSoloSettings, DEFAULT_SETTINGS } from "./settings";
import { VoiceView, VIEW_TYPE_VOICE } from "./src/ui/VoiceView";
import { PipelineWorker } from "./src/pipeline/PipelineWorker";

export default class VoiceSoloPlugin extends Plugin {
  settings: VoiceSoloSettings;
  private _worker: PipelineWorker | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new VoiceSoloSettingTab(this.app, this));

    // 注册侧边栏视图
    this.registerView(
      VIEW_TYPE_VOICE,
      (leaf) => new VoiceView(leaf, this),
    );

    // 注册命令：开始/停止录音
    this.addCommand({
      id: "start-recording",
      name: "开始录音",
      callback: () => this._startRecording(),
    });
    this.addCommand({
      id: "stop-recording",
      name: "停止录音",
      callback: () => this._stopRecording(),
    });

    // 状态栏指示器
    this.addStatusBarItem();
  }

  async onunload() {
    await this._stopRecording();
    this._worker?.terminate();
  }
```

## 设置面板

```typescript
// settings.ts
interface VoiceSoloSettings {
  // 模型来源
  modelSource: "local" | "remote";

  // 本地路径
  modelPathVad: string;     // FSMN ONNX 模型路径
  modelPathAsr: string;     // Paraformer ONNX 模型路径
  modelPathPunc: string;    // CT-Transformer ONNX 模型路径

  // 远程 URL (模型下载)
  modelUrlVad: string;
  modelUrlAsr: string;
  modelUrlPunc: string;

  // 音频
  audioDevice: string;      // 麦克风设备 ID
  meetingMode: boolean;     // 会议模式 (desktopCapturer)

  // 文本处理
  maxLineChars: number;     // 最大行长度 (默认 60)
  silenceThreshold: number; // 静默阈值秒 (默认 2.5)
  timeHeader: boolean;      // 是否显示时间头 [HH:MM:SS]

  // 热词
  hotwordsEnabled: boolean;
  hotwordsPath: string;     // 热词文件路径 (Vault 内)
}
```

## 视图 (VoiceView)

```typescript
// src/ui/VoiceView.ts
import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_VOICE = "voice-solo-view";

export class VoiceView extends ItemView {
  private _contentEl: HTMLElement;
  private _buttonEl: HTMLButtonElement;
  private _outputEl: HTMLElement;
  private _statusEl: HTMLElement;
  private _isRecording = false;

  getViewType(): string { return VIEW_TYPE_VOICE; }
  getDisplayText(): string { return "Voice Solo"; }
  getIcon(): string { return "microphone"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("voice-solo-container");

    // 工具栏
    const toolbar = container.createDiv("voice-solo-toolbar");
    this._buttonEl = toolbar.createEl("button", {
      text: "开始录音",
      cls: "voice-solo-record-btn",
    });
    this._buttonEl.addEventListener("click", () => this._toggleRecording());

    this._statusEl = toolbar.createDiv("voice-solo-status");
    this._statusEl.setText("就绪");

    // 输出区域
    this._outputEl = container.createDiv("voice-solo-output");
    this._outputEl.setAttribute("contenteditable", "true");
  }

  appendText(text: string, status: "newline" | "continuous") {
    if (status === "newline") {
      this._outputEl.createEl("br");
    }
    const span = this._outputEl.createEl("span", { text });
    // 自动滚动到底部
    span.scrollIntoView({ behavior: "smooth" });
  }

  setStatus(status: string) {
    this._statusEl.setText(status);
  }

  setRecording(active: boolean) {
    this._isRecording = active;
    this._buttonEl.setText(active ? "停止录音" : "开始录音");
    this._buttonEl.toggleClass("recording", active);
  }

  private _toggleRecording() {
    if (this._isRecording) {
      this.app.workspace.trigger("voice-solo:stop");
    } else {
      this.app.workspace.trigger("voice-solo:start");
    }
  }
}
```

## Worker 创建与通信

```typescript
// main.ts 续
private _startRecording() {
  if (!this._worker) {
    this._worker = new Worker(
      new URL("./src/pipeline/PipelineWorker.ts", import.meta.url),
      { type: "module" },
    );
    this._worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      this._handleWorkerMessage(ev.data);
    };
  }

  const config: PipelineConfig = {
    modelPaths: {
      vad: this.settings.modelPathVad,
      asr: this.settings.modelPathAsr,
      punc: this.settings.modelPathPunc,
    },
    audioDevice: this.settings.audioDevice,
    meetingMode: this.settings.meetingMode,
    textProcessor: {
      maxLineChars: this.settings.maxLineChars,
      silenceThreshold: this.settings.silenceThreshold,
    },
  };

  this._worker.postMessage({ type: "start", config });
}

private _handleWorkerMessage(msg: WorkerMessage) {
  switch (msg.type) {
    case "text":
      this._voiceView?.appendText(msg.text, msg.status);
      break;
    case "state":
      this._voiceView?.setStatus(msg.state);
      break;
    case "progress":
      this._showProgress(msg.step, msg.percent);
      break;
    case "error":
      new Notice(`Voice Solo: ${msg.message}`);
      break;
  }
}
```

## 录音文件保存

```typescript
// src/storage/RecordingStore.ts
class RecordingStore {
  async save(audioBuffer: Float32Array[], vaultPath: string) {
    // 方案 1: MediaRecorder API (推荐)
    //   录制时直接用 MediaRecorder 写 WebM → vault
    //   优点：零转码，无需 ffmpeg
    //   缺点：无法自定义编码参数

    // 方案 2: WAV 直写
    //   合并 Float32Array → Int16Array → WAV header + data
    //   优点：无依赖，简单
    //   缺点：文件大 (16bit 16kHz mono = ~2MB/min)

    // 方案 3: ffmpeg.wasm
    //   优点：支持 WebM/Opus 编码，文件小
    //   缺点：首次加载 ffmpeg.wasm 慢 (~30MB 下载)
  }
}
```

## 设置面板 — 模型下载进度

```typescript
// src/ui/DownloadProgress.ts
class DownloadProgress {
  private _progressEl: HTMLDivElement;
  private _barEl: HTMLDivElement;

  constructor(container: HTMLElement) {
    this._progressEl = container.createDiv("voice-solo-download");
    this._progressEl.createSpan({ text: "模型下载中..." });
    this._barEl = this._progressEl.createDiv("voice-solo-progress-bar");
  }

  update(percent: number) {
    this._barEl.style.width = `${Math.min(percent, 100)}%`;
    if (percent >= 100) {
      this._progressEl.setText("下载完成");
    }
  }

  hide() {
    this._progressEl.remove();
  }
}
```
