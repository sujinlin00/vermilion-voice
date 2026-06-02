"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VoiceSoloPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/view.ts
var import_obsidian = require("obsidian");
var VIEW_TYPE = "voice-solo-view";
var VoiceSoloView = class extends import_obsidian.ItemView {
  constructor(leaf) {
    super(leaf);
    this.isRunning = false;
    this.segCount = 0;
    // Callbacks set by main plugin
    this.onStart = null;
    this.onStop = null;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Voice Solo";
  }
  getIcon() {
    return "mic";
  }
  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("voice-solo-container");
    const header = container.createEl("div", { cls: "voice-solo-header" });
    header.createEl("span", { text: "Voice Solo", cls: "voice-solo-title" });
    this.statusEl = header.createEl("span", {
      text: "\u5C31\u7EEA",
      cls: "voice-solo-status voice-solo-idle"
    });
    const controls = container.createEl("div", { cls: "voice-solo-controls" });
    this.btnStart = controls.createEl("button", {
      text: "\u5F00\u59CB\u8BC6\u522B",
      cls: "voice-solo-btn voice-solo-btn-start"
    });
    this.btnStop = controls.createEl("button", {
      text: "\u505C\u6B62",
      cls: "voice-solo-btn voice-solo-btn-stop"
    });
    this.btnStop.disabled = true;
    this.btnStart.addEventListener("click", async () => {
      if (this.onStart) {
        this.btnStart.disabled = true;
        this.setStatus("loading", "\u8BF7\u6C42\u9EA6\u514B\u98CE...");
        try {
          await this.onStart();
          this.isRunning = true;
          this.btnStop.disabled = false;
          this.setStatus("recording", "\u8BC6\u522B\u4E2D...");
        } catch (e) {
          this.setStatus("error", e.message);
          this.btnStart.disabled = false;
        }
      }
    });
    this.btnStop.addEventListener("click", () => {
      this.isRunning = false;
      this.btnStart.disabled = false;
      this.btnStop.disabled = true;
      this.setStatus("idle", "\u5DF2\u505C\u6B62");
      if (this.onStop) this.onStop();
    });
    const stats = container.createEl("div", { cls: "voice-solo-stats" });
    this.bufferEl = stats.createEl("span", { text: "\u7F13\u51B2: 0s", cls: "voice-solo-stat" });
    this.segCountEl = stats.createEl("span", { text: "\u6BB5\u6570: 0", cls: "voice-solo-stat" });
    this.outputEl = container.createEl("div", { cls: "voice-solo-output" });
    this.outputEl.createEl("div", {
      text: '\u52A0\u8F7D\u6A21\u578B\u540E\u70B9\u51FB"\u5F00\u59CB\u8BC6\u522B"\u5F00\u59CB\u5B9E\u65F6\u8BED\u97F3\u8BC6\u522B',
      cls: "voice-solo-placeholder"
    });
  }
  async onClose() {
    if (this.isRunning && this.onStop) this.onStop();
  }
  setStatus(cls, text) {
    this.statusEl.className = "voice-solo-status voice-solo-" + cls;
    this.statusEl.textContent = text;
  }
  setBuffer(seconds) {
    this.bufferEl.textContent = `\u7F13\u51B2: ${seconds.toFixed(1)}s`;
  }
  addSegment(text, startMs, endMs, perf) {
    this.segCount++;
    this.segCountEl.textContent = `\u6BB5\u6570: ${this.segCount}`;
    const ph = this.outputEl.querySelector(".voice-solo-placeholder");
    if (ph) ph.remove();
    const seg = this.outputEl.createEl("div", { cls: "voice-solo-segment" });
    let timeStr = `${(startMs / 1e3).toFixed(1)}s \u2014 ${(endMs / 1e3).toFixed(1)}s`;
    if (perf) {
      timeStr += ` | VAD ${perf.vadMs}ms | FB ${perf.asrFbankMs}ms | ASR ${perf.asrInferMs}ms | DEC ${perf.asrDecodeMs}ms | PUNC ${perf.puncMs}ms | \u5806 ${perf.heapMB}MB`;
    }
    seg.createEl("div", { text: timeStr, cls: "voice-solo-seg-time" });
    seg.createEl("div", { text, cls: "voice-solo-seg-text" });
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
  clear() {
    this.outputEl.empty();
    this.outputEl.createEl("div", {
      text: '\u70B9\u51FB"\u5F00\u59CB\u8BC6\u522B"\u5F00\u59CB\u5B9E\u65F6\u8BED\u97F3\u8BC6\u522B',
      cls: "voice-solo-placeholder"
    });
    this.segCount = 0;
    this.segCountEl.textContent = "\u6BB5\u6570: 0";
    this.bufferEl.textContent = "\u7F13\u51B2: 0s";
  }
};

// src/text-processor.ts
var PUNCTUATION = "\u3002\uFF01\uFF1F.!?";
var SPLIT_PUNCTUATION = "\uFF0C\u3002\uFF01\uFF1F.!?\u3001";
var TextProcessor = class {
  constructor(config = {}) {
    this.buffer = "";
    this.sentPos = 0;
    this.needsSplit = false;
    this.prevTail = "";
    this.history = [];
    this.config = {
      maxLineChars: config.maxLineChars || 30,
      silenceThresholdMs: config.silenceThresholdMs || 800,
      dedupWindowMs: config.dedupWindowMs || 3e3
    };
  }
  /** Feed a new recognized text segment. Returns 0-N split sentences. */
  tick(text, currentTime) {
    if (!text) return [];
    this.buffer += text;
    const results = [];
    if (this.isDup(this.buffer, currentTime)) {
      return [];
    }
    const isSentenceEnd = PUNCTUATION.includes(this.buffer.slice(-1));
    const fullLen = this.buffer.length;
    if (isSentenceEnd) {
      const unsent = this.buffer.slice(this.sentPos);
      this.record(this.buffer, currentTime);
      this.buffer = "";
      this.needsSplit = false;
      this.sentPos = 0;
      results.push({ text: unsent });
    } else if (fullLen >= this.config.maxLineChars) {
      this.needsSplit = true;
    }
    if (this.needsSplit) {
      const splitIdx = this.findSplitPoint(this.buffer, this.sentPos);
      if (splitIdx > 0) {
        const unsent = this.buffer.slice(this.sentPos, splitIdx + 1);
        this.buffer = this.buffer.slice(splitIdx + 1);
        this.record(unsent, currentTime);
        this.needsSplit = false;
        this.sentPos = 0;
        results.push({ text: unsent });
      } else if (fullLen >= this.config.maxLineChars * 2) {
        const unsent = this.buffer.slice(0, this.config.maxLineChars);
        this.buffer = this.buffer.slice(this.config.maxLineChars);
        this.record(unsent, currentTime);
        this.needsSplit = false;
        this.sentPos = 0;
        results.push({ text: unsent });
      }
    }
    return results;
  }
  /** Flush remaining buffer (call on stop). */
  flush() {
    if (!this.buffer) return [];
    const text = this.buffer;
    this.buffer = "";
    this.sentPos = 0;
    this.needsSplit = false;
    return [{ text }];
  }
  reset() {
    this.buffer = "";
    this.sentPos = 0;
    this.needsSplit = false;
    this.history = [];
  }
  findSplitPoint(buf, from) {
    for (let i = buf.length - 1; i >= from; i--) {
      if (SPLIT_PUNCTUATION.includes(buf[i])) return i;
    }
    return -1;
  }
  isDup(text, time) {
    const tail = text.slice(-10);
    if (tail === this.prevTail) return true;
    const cutoff = time - this.config.dedupWindowMs;
    this.history = this.history.filter((h) => h.time >= cutoff);
    for (const h of this.history) {
      if (h.text === text) return true;
    }
    return false;
  }
  record(text, time) {
    this.prevTail = text.slice(-10);
    this.history.push({ text, time });
    if (this.history.length > 20) this.history.shift();
  }
};

// src/main.ts
var DEFAULT_SETTINGS = {
  modelBasePath: "",
  hotWords: {},
  autoSaveToNote: false
};
var VoiceSoloPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    this.worker = null;
    this.audioCtx = null;
    this.micStream = null;
    this.workletNode = null;
    this.pluginDir = "";
    this.textProc = new TextProcessor();
  }
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new VoiceSoloView(leaf);
      view.onStart = () => this.startRecognition(view);
      view.onStop = () => this.stopRecognition();
      return view;
    });
    this.addRibbonIcon("mic", "Voice Solo", () => this.toggleView());
    this.addSettingTab(new VoiceSoloSettingTab(this.app, this));
    this.addCommand({
      id: "voice-solo-open",
      name: "Open voice recognition panel",
      callback: () => this.toggleView()
    });
    const vaultRoot = this.app.vault.adapter.basePath;
    this.pluginDir = vaultRoot + "/.obsidian/plugins/voice-solo";
  }
  onunload() {
    this.stopRecognition();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
  async toggleView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  // ---- Recognition lifecycle ----
  async startRecognition(view) {
    try {
      await this.createWorker(view);
      await this.startMic(view);
    } catch (e) {
      console.error("[VoiceSolo] startRecognition failed:", e);
      view.setStatus("error", e.message || "\u542F\u52A8\u5931\u8D25");
      this.stopRecognition();
    }
  }
  stopRecognition() {
    const parts = this.textProc.flush();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      const view = leaves[0].view;
      for (const p of parts) {
        if (p.text) view.addSegment(p.text, 0, 0);
      }
    }
    this.textProc.reset();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = null;
    }
  }
  async createWorker(view) {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const workerPath = this.pluginDir + "\\worker.js";
    const fs = window.require?.("fs") || require("fs");
    const workerCode = fs.readFileSync(workerPath, "utf-8");
    const blob = new Blob([workerCode], { type: "application/javascript" });
    this.worker = new Worker(URL.createObjectURL(blob), { type: "module" });
    this.worker.onerror = (e) => {
      console.error("[VoiceSolo] Worker error:", e.message);
      view.setStatus("error", "Worker \u9519\u8BEF: " + e.message);
    };
    this.worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "ready":
          view.setStatus("ready", "\u6A21\u578B\u5C31\u7EEA \u2014 \u5F00\u59CB\u8BC6\u522B");
          this.worker.postMessage({ type: "start" });
          break;
        case "status":
          if (msg.status === "listening") view.setStatus("recording", "\u76D1\u542C\u4E2D...");
          else if (msg.status === "speech") view.setStatus("recording", "\u8BF4\u8BDD\u4E2D...");
          else if (msg.status === "asr") view.setStatus("processing", "\u8BC6\u522B\u4E2D...");
          else if (msg.status === "punc") view.setStatus("processing", "\u6807\u70B9\u4E2D...");
          else if (msg.status === "idle") view.setStatus("idle", "\u5DF2\u505C\u6B62");
          break;
        case "segment": {
          const parts = this.textProc.tick(msg.text, msg.endMs);
          for (const p of parts) {
            if (p.text) view.addSegment(p.text, msg.startMs, msg.endMs, msg.perf);
          }
          break;
        }
        case "error":
          view.setStatus("error", msg.message);
          break;
        case "progress":
          view.setStatus("loading", `\u52A0\u8F7D ${msg.phase.toUpperCase()}: ${msg.pct}%`);
          break;
      }
    };
    await this.loadWorkerConfig(view);
  }
  async loadWorkerConfig(view) {
    const baseDir = this.settings.modelBasePath.replace(/\\/g, "/").replace(/\/$/, "");
    if (!baseDir) throw new Error("\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u914D\u7F6E\u6A21\u578B\u76EE\u5F55\u8DEF\u5F84 (Settings \u2192 Voice Solo)");
    const vadDir = `${baseDir}/vad/speech_fsmn_vad_zh-cn-16k-common-onnx`;
    const asrDir = `${baseDir}/asr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`;
    const puncDir = `${baseDir}/punc/punc_ct-transformer_zh-cn-common-vocab272727-onnx`;
    let fs;
    try {
      fs = window.require("fs");
    } catch {
      fs = require("fs");
    }
    const readText = (p) => fs.readFileSync(p, "utf-8");
    const readBuf = (p) => fs.readFileSync(p).buffer;
    const vadModelBuf = readBuf(`${vadDir}\\model_quant.onnx`);
    const asrModelBuf = readBuf(`${asrDir}\\model_quant.onnx`);
    const puncModelBuf = readBuf(`${puncDir}\\model_quant.onnx`);
    const vadCmvn = readText(`${vadDir}\\am.mvn`);
    const asrCmvn = readText(`${asrDir}\\am.mvn`);
    const tokensJson = JSON.parse(readText(`${asrDir}\\tokens.json`));
    const puncTokensJson = JSON.parse(readText(`${puncDir}\\tokens.json`));
    const threadedWasm = readBuf(this.pluginDir + "\\lib\\ort-wasm-simd-threaded.wasm");
    const jsepWasm = readBuf(this.pluginDir + "\\lib\\ort-wasm-simd-threaded.jsep.wasm");
    let hasWebGPU = false;
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        hasWebGPU = !!adapter;
      } catch {
      }
    }
    this.worker.postMessage({
      type: "init",
      config: {
        hasWebGPU,
        vadModelBuffer: vadModelBuf,
        asrModelBuffer: asrModelBuf,
        puncModelBuffer: puncModelBuf,
        vadCmvnText: vadCmvn,
        asrCmvnText: asrCmvn,
        tokensJson,
        puncTokensJson,
        threadedWasm,
        jsepWasm
      }
    }, [vadModelBuf, asrModelBuf, puncModelBuf, threadedWasm, jsepWasm]);
  }
  async startMic(view) {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    this.audioCtx = new AudioContext();
    const fs = window.require?.("fs") || require("fs");
    const workletCode = fs.readFileSync(this.pluginDir + "\\mic_worklet.js", "utf-8");
    const workletBlob = new Blob([workletCode], { type: "application/javascript" });
    await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(workletBlob));
    this.workletNode = new AudioWorkletNode(this.audioCtx, "mic-processor");
    this.workletNode.port.onmessage = (e) => {
      if (this.worker) {
        this.worker.postMessage({ type: "chunk", data: e.data }, [e.data]);
      }
    };
    const source = this.audioCtx.createMediaStreamSource(this.micStream);
    source.connect(this.workletNode);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var VoiceSoloSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Voice Solo Settings" });
    new import_obsidian2.Setting(containerEl).setName("\u6A21\u578B\u76EE\u5F55").setDesc("FunASR \u6A21\u578B\u7684\u672C\u5730\u6839\u76EE\u5F55\uFF0C\u542B vad/, asr/, punc/ \u5B50\u76EE\u5F55").addText((text) => text.setPlaceholder("D:/arvin/obsidian_workpace/models").setValue(this.plugin.settings.modelBasePath).onChange(async (value) => {
      this.plugin.settings.modelBasePath = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian2.Setting(containerEl).setName("\u70ED\u8BCD\u66FF\u6362\u8868").setDesc('JSON \u683C\u5F0F: {"\u8BEF\u8BC6\u522B\u8BCD": "\u6B63\u786E\u8BCD", ...}').addTextArea((text) => text.setPlaceholder('{"\u7535\u7F06": "\u975B\u84DD", "\u4E91\u6735": "\u5432\u54DA"}').setValue(JSON.stringify(this.plugin.settings.hotWords, null, 2)).onChange(async (value) => {
      try {
        this.plugin.settings.hotWords = JSON.parse(value || "{}");
        await this.plugin.saveSettings();
      } catch {
      }
    }));
    new import_obsidian2.Setting(containerEl).setName("\u81EA\u52A8\u5199\u5165\u7B14\u8BB0").setDesc("\u8BC6\u522B\u5B8C\u6210\u540E\u81EA\u52A8\u5C06\u6587\u672C\u63D2\u5165\u5F53\u524D\u6D3B\u52A8\u7B14\u8BB0").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSaveToNote).onChange(async (value) => {
      this.plugin.settings.autoSaveToNote = value;
      await this.plugin.saveSettings();
    }));
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3ZpZXcudHMiLCAic3JjL3RleHQtcHJvY2Vzc29yLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgdHlwZSB7IEFwcCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IFZvaWNlU29sb1ZpZXcsIFZJRVdfVFlQRSB9IGZyb20gJy4vdmlldyc7XG5pbXBvcnQgdHlwZSB7IFZvaWNlU29sb1NldHRpbmdzLCBXb3JrZXJUb01haW4gfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IFRleHRQcm9jZXNzb3IgfSBmcm9tICcuL3RleHQtcHJvY2Vzc29yJztcblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogVm9pY2VTb2xvU2V0dGluZ3MgPSB7XG4gIG1vZGVsQmFzZVBhdGg6ICcnLFxuICBob3RXb3Jkczoge30sXG4gIGF1dG9TYXZlVG9Ob3RlOiBmYWxzZSxcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFZvaWNlU29sb1BsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gIHNldHRpbmdzOiBWb2ljZVNvbG9TZXR0aW5ncztcbiAgcHJpdmF0ZSB3b3JrZXI6IFdvcmtlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGF1ZGlvQ3R4OiBBdWRpb0NvbnRleHQgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNTdHJlYW06IE1lZGlhU3RyZWFtIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgd29ya2xldE5vZGU6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBwbHVnaW5EaXI6IHN0cmluZyA9ICcnO1xuICBwcml2YXRlIHRleHRQcm9jOiBUZXh0UHJvY2Vzc29yID0gbmV3IFRleHRQcm9jZXNzb3IoKTtcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgIC8vIFJlZ2lzdGVyIHZpZXcgXHUyMDE0IGluamVjdCBwbHVnaW4gcmVmZXJlbmNlIGZvciBjYWxsYmFjayB3aXJpbmdcbiAgICB0aGlzLnJlZ2lzdGVyVmlldyhWSUVXX1RZUEUsIChsZWFmKSA9PiB7XG4gICAgICBjb25zdCB2aWV3ID0gbmV3IFZvaWNlU29sb1ZpZXcobGVhZik7XG4gICAgICB2aWV3Lm9uU3RhcnQgPSAoKSA9PiB0aGlzLnN0YXJ0UmVjb2duaXRpb24odmlldyk7XG4gICAgICB2aWV3Lm9uU3RvcCA9ICgpID0+IHRoaXMuc3RvcFJlY29nbml0aW9uKCk7XG4gICAgICByZXR1cm4gdmlldztcbiAgICB9KTtcblxuICAgIC8vIFJpYmJvbiBpY29uXG4gICAgdGhpcy5hZGRSaWJib25JY29uKCdtaWMnLCAnVm9pY2UgU29sbycsICgpID0+IHRoaXMudG9nZ2xlVmlldygpKTtcblxuICAgIC8vIFNldHRpbmdzIHRhYlxuICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgVm9pY2VTb2xvU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgLy8gQ29tbWFuZDogdG9nZ2xlIHZpZXdcbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6ICd2b2ljZS1zb2xvLW9wZW4nLFxuICAgICAgbmFtZTogJ09wZW4gdm9pY2UgcmVjb2duaXRpb24gcGFuZWwnLFxuICAgICAgY2FsbGJhY2s6ICgpID0+IHRoaXMudG9nZ2xlVmlldygpLFxuICAgIH0pO1xuXG4gICAgLy8gRGV0ZXJtaW5lIHBsdWdpbiBkaXJlY3RvcnlcbiAgICBjb25zdCB2YXVsdFJvb3QgPSAodGhpcy5hcHAudmF1bHQuYWRhcHRlciBhcyBhbnkpLmJhc2VQYXRoIGFzIHN0cmluZztcbiAgICB0aGlzLnBsdWdpbkRpciA9IHZhdWx0Um9vdCArICcvLm9ic2lkaWFuL3BsdWdpbnMvdm9pY2Utc29sbyc7XG4gIH1cblxuICBvbnVubG9hZCgpIHtcbiAgICB0aGlzLnN0b3BSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5kZXRhY2hMZWF2ZXNPZlR5cGUoVklFV19UWVBFKTtcbiAgfVxuXG4gIGFzeW5jIHRvZ2dsZVZpZXcoKSB7XG4gICAgY29uc3QgbGVhdmVzID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEUpO1xuICAgIGlmIChsZWF2ZXMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnJldmVhbExlYWYobGVhdmVzWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRSaWdodExlYWYoZmFsc2UpO1xuICAgIGlmICghbGVhZikgcmV0dXJuO1xuICAgIGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHsgdHlwZTogVklFV19UWVBFLCBhY3RpdmU6IHRydWUgfSk7XG4gICAgdGhpcy5hcHAud29ya3NwYWNlLnJldmVhbExlYWYobGVhZik7XG4gIH1cblxuICAvLyAtLS0tIFJlY29nbml0aW9uIGxpZmVjeWNsZSAtLS0tXG5cbiAgYXN5bmMgc3RhcnRSZWNvZ25pdGlvbih2aWV3OiBWb2ljZVNvbG9WaWV3KSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuY3JlYXRlV29ya2VyKHZpZXcpO1xuICAgICAgYXdhaXQgdGhpcy5zdGFydE1pYyh2aWV3KTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1tWb2ljZVNvbG9dIHN0YXJ0UmVjb2duaXRpb24gZmFpbGVkOicsIGUpO1xuICAgICAgdmlldy5zZXRTdGF0dXMoJ2Vycm9yJywgZS5tZXNzYWdlIHx8ICdcdTU0MkZcdTUyQThcdTU5MzFcdThEMjUnKTtcbiAgICAgIHRoaXMuc3RvcFJlY29nbml0aW9uKCk7XG4gICAgfVxuICB9XG5cbiAgc3RvcFJlY29nbml0aW9uKCkge1xuICAgIC8vIEZsdXNoIGFueSByZW1haW5pbmcgYnVmZmVyZWQgdGV4dFxuICAgIGNvbnN0IHBhcnRzID0gdGhpcy50ZXh0UHJvYy5mbHVzaCgpO1xuICAgIGNvbnN0IGxlYXZlcyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFKTtcbiAgICBpZiAobGVhdmVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHZpZXcgPSBsZWF2ZXNbMF0udmlldyBhcyBWb2ljZVNvbG9WaWV3O1xuICAgICAgZm9yIChjb25zdCBwIG9mIHBhcnRzKSB7XG4gICAgICAgIGlmIChwLnRleHQpIHZpZXcuYWRkU2VnbWVudChwLnRleHQsIDAsIDApO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnRleHRQcm9jLnJlc2V0KCk7XG5cbiAgICBpZiAodGhpcy53b3JrbGV0Tm9kZSkgeyB0aGlzLndvcmtsZXROb2RlLmRpc2Nvbm5lY3QoKTsgdGhpcy53b3JrbGV0Tm9kZSA9IG51bGw7IH1cbiAgICBpZiAodGhpcy5taWNTdHJlYW0pIHsgdGhpcy5taWNTdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCh0ID0+IHQuc3RvcCgpKTsgdGhpcy5taWNTdHJlYW0gPSBudWxsOyB9XG4gICAgaWYgKHRoaXMuYXVkaW9DdHgpIHsgdGhpcy5hdWRpb0N0eC5jbG9zZSgpOyB0aGlzLmF1ZGlvQ3R4ID0gbnVsbDsgfVxuICAgIGlmICh0aGlzLndvcmtlcikge1xuICAgICAgdGhpcy53b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiAnc3RvcCcgfSk7XG4gICAgICB0aGlzLndvcmtlci50ZXJtaW5hdGUoKTtcbiAgICAgIHRoaXMud29ya2VyID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBhc3luYyBjcmVhdGVXb3JrZXIodmlldzogVm9pY2VTb2xvVmlldykge1xuICAgIGlmICh0aGlzLndvcmtlcikgeyB0aGlzLndvcmtlci50ZXJtaW5hdGUoKTsgdGhpcy53b3JrZXIgPSBudWxsOyB9XG5cbiAgICAvLyBSZWFkIHdvcmtlci5qcyBhbmQgY3JlYXRlIEJsb2IgVVJMIChwYWdlIGlzIGFwcDovLyBvcmlnaW4sIGJsb2IgaXMgc2FtZS1vcmlnaW4pXG4gICAgY29uc3Qgd29ya2VyUGF0aCA9IHRoaXMucGx1Z2luRGlyICsgJ1xcXFx3b3JrZXIuanMnO1xuICAgIGNvbnN0IGZzOiBhbnkgPSAod2luZG93IGFzIGFueSkucmVxdWlyZT8uKCdmcycpIHx8IHJlcXVpcmUoJ2ZzJyk7XG4gICAgY29uc3Qgd29ya2VyQ29kZSA9IGZzLnJlYWRGaWxlU3luYyh3b3JrZXJQYXRoLCAndXRmLTgnKTtcbiAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW3dvcmtlckNvZGVdLCB7IHR5cGU6ICdhcHBsaWNhdGlvbi9qYXZhc2NyaXB0JyB9KTtcbiAgICB0aGlzLndvcmtlciA9IG5ldyBXb3JrZXIoVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKSwgeyB0eXBlOiAnbW9kdWxlJyB9KTtcblxuICAgIC8vIENhdGNoIHdvcmtlciBpbml0IGVycm9yc1xuICAgIHRoaXMud29ya2VyLm9uZXJyb3IgPSAoZSkgPT4ge1xuICAgICAgY29uc29sZS5lcnJvcignW1ZvaWNlU29sb10gV29ya2VyIGVycm9yOicsIGUubWVzc2FnZSk7XG4gICAgICB2aWV3LnNldFN0YXR1cygnZXJyb3InLCAnV29ya2VyIFx1OTUxOVx1OEJFRjogJyArIGUubWVzc2FnZSk7XG4gICAgfTtcblxuICAgIC8vIEhhbmRsZSBtZXNzYWdlcyBmcm9tIHdvcmtlclxuICAgIHRoaXMud29ya2VyLm9ubWVzc2FnZSA9IChlOiBNZXNzYWdlRXZlbnQ8V29ya2VyVG9NYWluPikgPT4ge1xuICAgICAgY29uc3QgbXNnID0gZS5kYXRhO1xuICAgICAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgICAgICBjYXNlICdyZWFkeSc6XG4gICAgICAgICAgdmlldy5zZXRTdGF0dXMoJ3JlYWR5JywgJ1x1NkEyMVx1NTc4Qlx1NUMzMVx1N0VFQSBcdTIwMTQgXHU1RjAwXHU1OUNCXHU4QkM2XHU1MjJCJyk7XG4gICAgICAgICAgdGhpcy53b3JrZXIhLnBvc3RNZXNzYWdlKHsgdHlwZTogJ3N0YXJ0JyB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnc3RhdHVzJzpcbiAgICAgICAgICBpZiAobXNnLnN0YXR1cyA9PT0gJ2xpc3RlbmluZycpIHZpZXcuc2V0U3RhdHVzKCdyZWNvcmRpbmcnLCAnXHU3NkQxXHU1NDJDXHU0RTJELi4uJyk7XG4gICAgICAgICAgZWxzZSBpZiAobXNnLnN0YXR1cyA9PT0gJ3NwZWVjaCcpIHZpZXcuc2V0U3RhdHVzKCdyZWNvcmRpbmcnLCAnXHU4QkY0XHU4QkREXHU0RTJELi4uJyk7XG4gICAgICAgICAgZWxzZSBpZiAobXNnLnN0YXR1cyA9PT0gJ2FzcicpIHZpZXcuc2V0U3RhdHVzKCdwcm9jZXNzaW5nJywgJ1x1OEJDNlx1NTIyQlx1NEUyRC4uLicpO1xuICAgICAgICAgIGVsc2UgaWYgKG1zZy5zdGF0dXMgPT09ICdwdW5jJykgdmlldy5zZXRTdGF0dXMoJ3Byb2Nlc3NpbmcnLCAnXHU2ODA3XHU3MEI5XHU0RTJELi4uJyk7XG4gICAgICAgICAgZWxzZSBpZiAobXNnLnN0YXR1cyA9PT0gJ2lkbGUnKSB2aWV3LnNldFN0YXR1cygnaWRsZScsICdcdTVERjJcdTUwNUNcdTZCNjInKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnc2VnbWVudCc6IHtcbiAgICAgICAgICAvLyBUZXh0UHJvY2Vzc29yIHNwbGl0cyBsb25nIEFTUiBvdXRwdXQgaW50byBkaXNwbGF5YWJsZSBzZW50ZW5jZXNcbiAgICAgICAgICBjb25zdCBwYXJ0cyA9IHRoaXMudGV4dFByb2MudGljayhtc2cudGV4dCwgbXNnLmVuZE1zKTtcbiAgICAgICAgICBmb3IgKGNvbnN0IHAgb2YgcGFydHMpIHtcbiAgICAgICAgICAgIGlmIChwLnRleHQpIHZpZXcuYWRkU2VnbWVudChwLnRleHQsIG1zZy5zdGFydE1zLCBtc2cuZW5kTXMsIG1zZy5wZXJmKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAnZXJyb3InOlxuICAgICAgICAgIHZpZXcuc2V0U3RhdHVzKCdlcnJvcicsIG1zZy5tZXNzYWdlKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAncHJvZ3Jlc3MnOlxuICAgICAgICAgIHZpZXcuc2V0U3RhdHVzKCdsb2FkaW5nJywgYFx1NTJBMFx1OEY3RCAke21zZy5waGFzZS50b1VwcGVyQ2FzZSgpfTogJHttc2cucGN0fSVgKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgLy8gSW5pdGlhbGl6ZSB3b3JrZXIgd2l0aCBwcmUtbG9hZGVkIG1vZGVsIGRhdGFcbiAgICBhd2FpdCB0aGlzLmxvYWRXb3JrZXJDb25maWcodmlldyk7XG4gIH1cblxuICBhc3luYyBsb2FkV29ya2VyQ29uZmlnKHZpZXc6IFZvaWNlU29sb1ZpZXcpIHtcbiAgICBjb25zdCBiYXNlRGlyID0gdGhpcy5zZXR0aW5ncy5tb2RlbEJhc2VQYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9cXC8kLywgJycpO1xuICAgIGlmICghYmFzZURpcikgdGhyb3cgbmV3IEVycm9yKCdcdThCRjdcdTUxNDhcdTU3MjhcdThCQkVcdTdGNkVcdTRFMkRcdTkxNERcdTdGNkVcdTZBMjFcdTU3OEJcdTc2RUVcdTVGNTVcdThERUZcdTVGODQgKFNldHRpbmdzIFx1MjE5MiBWb2ljZSBTb2xvKScpO1xuICAgIGNvbnN0IHZhZERpciA9IGAke2Jhc2VEaXJ9L3ZhZC9zcGVlY2hfZnNtbl92YWRfemgtY24tMTZrLWNvbW1vbi1vbm54YDtcbiAgICBjb25zdCBhc3JEaXIgPSBgJHtiYXNlRGlyfS9hc3Ivc3BlZWNoX3BhcmFmb3JtZXItbGFyZ2VfYXNyX25hdC16aC1jbi0xNmstY29tbW9uLXZvY2FiODQwNC1vbm54YDtcbiAgICBjb25zdCBwdW5jRGlyID0gYCR7YmFzZURpcn0vcHVuYy9wdW5jX2N0LXRyYW5zZm9ybWVyX3poLWNuLWNvbW1vbi12b2NhYjI3MjcyNy1vbm54YDtcblxuICAgIC8vIFVzZSByZXF1aXJlKCdmcycpIGZvciBhbGwgZmlsZSByZWFkcyAobm8gZmV0Y2ggY3Jvc3Mtb3JpZ2luIGlzc3VlcylcbiAgICBsZXQgZnM6IGFueTtcbiAgICB0cnkgeyBmcyA9ICh3aW5kb3cgYXMgYW55KS5yZXF1aXJlKCdmcycpOyB9IGNhdGNoIHsgZnMgPSByZXF1aXJlKCdmcycpOyB9XG4gICAgY29uc3QgcmVhZFRleHQgPSAocDogc3RyaW5nKSA9PiBmcy5yZWFkRmlsZVN5bmMocCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgcmVhZEJ1ZiA9IChwOiBzdHJpbmcpID0+IGZzLnJlYWRGaWxlU3luYyhwKS5idWZmZXIgYXMgQXJyYXlCdWZmZXI7XG5cbiAgICAvLyBSZWFkIG1vZGVsIGZpbGVzICsgY29uZmlnXG4gICAgY29uc3QgdmFkTW9kZWxCdWYgPSByZWFkQnVmKGAke3ZhZERpcn1cXFxcbW9kZWxfcXVhbnQub25ueGApO1xuICAgIGNvbnN0IGFzck1vZGVsQnVmID0gcmVhZEJ1ZihgJHthc3JEaXJ9XFxcXG1vZGVsX3F1YW50Lm9ubnhgKTtcbiAgICBjb25zdCBwdW5jTW9kZWxCdWYgPSByZWFkQnVmKGAke3B1bmNEaXJ9XFxcXG1vZGVsX3F1YW50Lm9ubnhgKTtcbiAgICBjb25zdCB2YWRDbXZuID0gcmVhZFRleHQoYCR7dmFkRGlyfVxcXFxhbS5tdm5gKTtcbiAgICBjb25zdCBhc3JDbXZuID0gcmVhZFRleHQoYCR7YXNyRGlyfVxcXFxhbS5tdm5gKTtcbiAgICBjb25zdCB0b2tlbnNKc29uID0gSlNPTi5wYXJzZShyZWFkVGV4dChgJHthc3JEaXJ9XFxcXHRva2Vucy5qc29uYCkpO1xuICAgIGNvbnN0IHB1bmNUb2tlbnNKc29uID0gSlNPTi5wYXJzZShyZWFkVGV4dChgJHtwdW5jRGlyfVxcXFx0b2tlbnMuanNvbmApKTtcblxuICAgIC8vIFJlYWQgT1JUIFdBU00gZmlsZXNcbiAgICBjb25zdCB0aHJlYWRlZFdhc20gPSByZWFkQnVmKHRoaXMucGx1Z2luRGlyICsgJ1xcXFxsaWJcXFxcb3J0LXdhc20tc2ltZC10aHJlYWRlZC53YXNtJyk7XG4gICAgY29uc3QganNlcFdhc20gPSByZWFkQnVmKHRoaXMucGx1Z2luRGlyICsgJ1xcXFxsaWJcXFxcb3J0LXdhc20tc2ltZC10aHJlYWRlZC5qc2VwLndhc20nKTtcblxuICAgIC8vIERldGVjdCBXZWJHUFUgb24gbWFpbiB0aHJlYWQgKG1vcmUgcmVsaWFibGUgdGhhbiBXb3JrZXItc2lkZSBkZXRlY3Rpb24pXG4gICAgbGV0IGhhc1dlYkdQVSA9IGZhbHNlO1xuICAgIGlmICgobmF2aWdhdG9yIGFzIGFueSkuZ3B1KSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBhZGFwdGVyID0gYXdhaXQgKG5hdmlnYXRvciBhcyBhbnkpLmdwdS5yZXF1ZXN0QWRhcHRlcigpO1xuICAgICAgICBoYXNXZWJHUFUgPSAhIWFkYXB0ZXI7XG4gICAgICB9IGNhdGNoIHsgLyogZmFsbCB0aHJvdWdoICovIH1cbiAgICB9XG5cbiAgICAvLyBUcmFuc2ZlciBtb2RlbCArIFdBU00gYnVmZmVycyB0byBXb3JrZXIgKHplcm8tY29weSlcbiAgICB0aGlzLndvcmtlciEucG9zdE1lc3NhZ2Uoe1xuICAgICAgdHlwZTogJ2luaXQnLFxuICAgICAgY29uZmlnOiB7XG4gICAgICAgIGhhc1dlYkdQVTogaGFzV2ViR1BVLFxuICAgICAgICB2YWRNb2RlbEJ1ZmZlcjogdmFkTW9kZWxCdWYsXG4gICAgICAgIGFzck1vZGVsQnVmZmVyOiBhc3JNb2RlbEJ1ZixcbiAgICAgICAgcHVuY01vZGVsQnVmZmVyOiBwdW5jTW9kZWxCdWYsXG4gICAgICAgIHZhZENtdm5UZXh0OiB2YWRDbXZuLFxuICAgICAgICBhc3JDbXZuVGV4dDogYXNyQ212bixcbiAgICAgICAgdG9rZW5zSnNvbjogdG9rZW5zSnNvbixcbiAgICAgICAgcHVuY1Rva2Vuc0pzb246IHB1bmNUb2tlbnNKc29uLFxuICAgICAgICB0aHJlYWRlZFdhc206IHRocmVhZGVkV2FzbSxcbiAgICAgICAganNlcFdhc206IGpzZXBXYXNtLFxuICAgICAgfSxcbiAgICB9LCBbdmFkTW9kZWxCdWYsIGFzck1vZGVsQnVmLCBwdW5jTW9kZWxCdWYsIHRocmVhZGVkV2FzbSwganNlcFdhc21dKTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0TWljKHZpZXc6IFZvaWNlU29sb1ZpZXcpIHtcbiAgICB0aGlzLm1pY1N0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHtcbiAgICAgIGF1ZGlvOiB7IGNoYW5uZWxDb3VudDogMSwgZWNob0NhbmNlbGxhdGlvbjogdHJ1ZSwgbm9pc2VTdXBwcmVzc2lvbjogdHJ1ZSB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5hdWRpb0N0eCA9IG5ldyBBdWRpb0NvbnRleHQoKTtcblxuICAgIC8vIExvYWQgQXVkaW9Xb3JrbGV0IHZpYSBCbG9iIFVSTCAoZmlsZTovLyBpcyBjcm9zcy1vcmlnaW4gZnJvbSBhcHA6Ly8pXG4gICAgY29uc3QgZnM6IGFueSA9ICh3aW5kb3cgYXMgYW55KS5yZXF1aXJlPy4oJ2ZzJykgfHwgcmVxdWlyZSgnZnMnKTtcbiAgICBjb25zdCB3b3JrbGV0Q29kZSA9IGZzLnJlYWRGaWxlU3luYyh0aGlzLnBsdWdpbkRpciArICdcXFxcbWljX3dvcmtsZXQuanMnLCAndXRmLTgnKTtcbiAgICBjb25zdCB3b3JrbGV0QmxvYiA9IG5ldyBCbG9iKFt3b3JrbGV0Q29kZV0sIHsgdHlwZTogJ2FwcGxpY2F0aW9uL2phdmFzY3JpcHQnIH0pO1xuICAgIGF3YWl0IHRoaXMuYXVkaW9DdHguYXVkaW9Xb3JrbGV0LmFkZE1vZHVsZShVUkwuY3JlYXRlT2JqZWN0VVJMKHdvcmtsZXRCbG9iKSk7XG5cbiAgICB0aGlzLndvcmtsZXROb2RlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUodGhpcy5hdWRpb0N0eCwgJ21pYy1wcm9jZXNzb3InKTtcbiAgICB0aGlzLndvcmtsZXROb2RlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGlmICh0aGlzLndvcmtlcikge1xuICAgICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6ICdjaHVuaycsIGRhdGE6IGUuZGF0YSB9LCBbZS5kYXRhXSk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGNvbnN0IHNvdXJjZSA9IHRoaXMuYXVkaW9DdHguY3JlYXRlTWVkaWFTdHJlYW1Tb3VyY2UodGhpcy5taWNTdHJlYW0pO1xuICAgIHNvdXJjZS5jb25uZWN0KHRoaXMud29ya2xldE5vZGUpO1xuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICB9XG5cbiAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gIH1cbn1cblxuLy8gLS0tLSBTZXR0aW5ncyBUYWIgLS0tLVxuXG5jbGFzcyBWb2ljZVNvbG9TZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHBsdWdpbjogVm9pY2VTb2xvUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFZvaWNlU29sb1BsdWdpbikge1xuICAgIHN1cGVyKGFwcCwgcGx1Z2luKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ1ZvaWNlIFNvbG8gU2V0dGluZ3MnIH0pO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnXHU2QTIxXHU1NzhCXHU3NkVFXHU1RjU1JylcbiAgICAgIC5zZXREZXNjKCdGdW5BU1IgXHU2QTIxXHU1NzhCXHU3Njg0XHU2NzJDXHU1NzMwXHU2ODM5XHU3NkVFXHU1RjU1XHVGRjBDXHU1NDJCIHZhZC8sIGFzci8sIHB1bmMvIFx1NUI1MFx1NzZFRVx1NUY1NScpXG4gICAgICAuYWRkVGV4dCh0ZXh0ID0+IHRleHRcbiAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdEOi9hcnZpbi9vYnNpZGlhbl93b3JrcGFjZS9tb2RlbHMnKVxuICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MubW9kZWxCYXNlUGF0aClcbiAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsQmFzZVBhdGggPSB2YWx1ZTtcbiAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfSkpO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnXHU3MEVEXHU4QkNEXHU2NkZGXHU2MzYyXHU4ODY4JylcbiAgICAgIC5zZXREZXNjKCdKU09OIFx1NjgzQ1x1NUYwRjoge1wiXHU4QkVGXHU4QkM2XHU1MjJCXHU4QkNEXCI6IFwiXHU2QjYzXHU3ODZFXHU4QkNEXCIsIC4uLn0nKVxuICAgICAgLmFkZFRleHRBcmVhKHRleHQgPT4gdGV4dFxuICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ3tcIlx1NzUzNVx1N0YwNlwiOiBcIlx1OTc1Qlx1ODRERFwiLCBcIlx1NEU5MVx1NjczNVwiOiBcIlx1NTQzMlx1NTREQVwifScpXG4gICAgICAgIC5zZXRWYWx1ZShKU09OLnN0cmluZ2lmeSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5ob3RXb3JkcywgbnVsbCwgMikpXG4gICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaG90V29yZHMgPSBKU09OLnBhcnNlKHZhbHVlIHx8ICd7fScpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSBjYXRjaCB7IC8qIGludmFsaWQgSlNPTiwgaWdub3JlICovIH1cbiAgICAgICAgfSkpO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnXHU4MUVBXHU1MkE4XHU1MTk5XHU1MTY1XHU3QjE0XHU4QkIwJylcbiAgICAgIC5zZXREZXNjKCdcdThCQzZcdTUyMkJcdTVCOENcdTYyMTBcdTU0MEVcdTgxRUFcdTUyQThcdTVDMDZcdTY1ODdcdTY3MkNcdTYzRDJcdTUxNjVcdTVGNTNcdTUyNERcdTZEM0JcdTUyQThcdTdCMTRcdThCQjAnKVxuICAgICAgLmFkZFRvZ2dsZSh0b2dnbGUgPT4gdG9nZ2xlXG4gICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5hdXRvU2F2ZVRvTm90ZSlcbiAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmF1dG9TYXZlVG9Ob3RlID0gdmFsdWU7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIH0pKTtcbiAgfVxufVxuXG4iLCAiaW1wb3J0IHsgSXRlbVZpZXcsIFdvcmtzcGFjZUxlYWYgfSBmcm9tICdvYnNpZGlhbic7XG5cbmV4cG9ydCBjb25zdCBWSUVXX1RZUEUgPSAndm9pY2Utc29sby12aWV3JztcblxuZXhwb3J0IGNsYXNzIFZvaWNlU29sb1ZpZXcgZXh0ZW5kcyBJdGVtVmlldyB7XG4gIHByaXZhdGUgaXNSdW5uaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgc3RhdHVzRWw6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIG91dHB1dEVsOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBidWZmZXJFbDogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgc2VnQ291bnRFbDogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgYnRuU3RhcnQ6IEhUTUxCdXR0b25FbGVtZW50O1xuICBwcml2YXRlIGJ0blN0b3A6IEhUTUxCdXR0b25FbGVtZW50O1xuICBwcml2YXRlIHNlZ0NvdW50ID0gMDtcblxuICAvLyBDYWxsYmFja3Mgc2V0IGJ5IG1haW4gcGx1Z2luXG4gIG9uU3RhcnQ6ICgoKSA9PiBQcm9taXNlPHZvaWQ+KSB8IG51bGwgPSBudWxsO1xuICBvblN0b3A6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYpIHtcbiAgICBzdXBlcihsZWFmKTtcbiAgfVxuXG4gIGdldFZpZXdUeXBlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIFZJRVdfVFlQRTtcbiAgfVxuXG4gIGdldERpc3BsYXlUZXh0KCk6IHN0cmluZyB7XG4gICAgcmV0dXJuICdWb2ljZSBTb2xvJztcbiAgfVxuXG4gIGdldEljb24oKTogc3RyaW5nIHtcbiAgICByZXR1cm4gJ21pYyc7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgY29uc3QgY29udGFpbmVyID0gdGhpcy5jb250YWluZXJFbC5jaGlsZHJlblsxXTtcbiAgICBjb250YWluZXIuZW1wdHkoKTtcbiAgICBjb250YWluZXIuYWRkQ2xhc3MoJ3ZvaWNlLXNvbG8tY29udGFpbmVyJyk7XG5cbiAgICAvLyBIZWFkZXJcbiAgICBjb25zdCBoZWFkZXIgPSBjb250YWluZXIuY3JlYXRlRWwoJ2RpdicsIHsgY2xzOiAndm9pY2Utc29sby1oZWFkZXInIH0pO1xuICAgIGhlYWRlci5jcmVhdGVFbCgnc3BhbicsIHsgdGV4dDogJ1ZvaWNlIFNvbG8nLCBjbHM6ICd2b2ljZS1zb2xvLXRpdGxlJyB9KTtcblxuICAgIHRoaXMuc3RhdHVzRWwgPSBoZWFkZXIuY3JlYXRlRWwoJ3NwYW4nLCB7XG4gICAgICB0ZXh0OiAnXHU1QzMxXHU3RUVBJyxcbiAgICAgIGNsczogJ3ZvaWNlLXNvbG8tc3RhdHVzIHZvaWNlLXNvbG8taWRsZScsXG4gICAgfSk7XG5cbiAgICAvLyBDb250cm9sc1xuICAgIGNvbnN0IGNvbnRyb2xzID0gY29udGFpbmVyLmNyZWF0ZUVsKCdkaXYnLCB7IGNsczogJ3ZvaWNlLXNvbG8tY29udHJvbHMnIH0pO1xuICAgIHRoaXMuYnRuU3RhcnQgPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgdGV4dDogJ1x1NUYwMFx1NTlDQlx1OEJDNlx1NTIyQicsXG4gICAgICBjbHM6ICd2b2ljZS1zb2xvLWJ0biB2b2ljZS1zb2xvLWJ0bi1zdGFydCcsXG4gICAgfSk7XG4gICAgdGhpcy5idG5TdG9wID0gY29udHJvbHMuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgIHRleHQ6ICdcdTUwNUNcdTZCNjInLFxuICAgICAgY2xzOiAndm9pY2Utc29sby1idG4gdm9pY2Utc29sby1idG4tc3RvcCcsXG4gICAgfSk7XG4gICAgdGhpcy5idG5TdG9wLmRpc2FibGVkID0gdHJ1ZTtcblxuICAgIHRoaXMuYnRuU3RhcnQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAodGhpcy5vblN0YXJ0KSB7XG4gICAgICAgIHRoaXMuYnRuU3RhcnQuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICB0aGlzLnNldFN0YXR1cygnbG9hZGluZycsICdcdThCRjdcdTZDNDJcdTlFQTZcdTUxNEJcdTk4Q0UuLi4nKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCB0aGlzLm9uU3RhcnQoKTtcbiAgICAgICAgICB0aGlzLmlzUnVubmluZyA9IHRydWU7XG4gICAgICAgICAgdGhpcy5idG5TdG9wLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ3JlY29yZGluZycsICdcdThCQzZcdTUyMkJcdTRFMkQuLi4nKTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ2Vycm9yJywgZS5tZXNzYWdlKTtcbiAgICAgICAgICB0aGlzLmJ0blN0YXJ0LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHRoaXMuYnRuU3RvcC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgIHRoaXMuaXNSdW5uaW5nID0gZmFsc2U7XG4gICAgICB0aGlzLmJ0blN0YXJ0LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB0aGlzLmJ0blN0b3AuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdGhpcy5zZXRTdGF0dXMoJ2lkbGUnLCAnXHU1REYyXHU1MDVDXHU2QjYyJyk7XG4gICAgICBpZiAodGhpcy5vblN0b3ApIHRoaXMub25TdG9wKCk7XG4gICAgfSk7XG5cbiAgICAvLyBTdGF0cyBiYXJcbiAgICBjb25zdCBzdGF0cyA9IGNvbnRhaW5lci5jcmVhdGVFbCgnZGl2JywgeyBjbHM6ICd2b2ljZS1zb2xvLXN0YXRzJyB9KTtcbiAgICB0aGlzLmJ1ZmZlckVsID0gc3RhdHMuY3JlYXRlRWwoJ3NwYW4nLCB7IHRleHQ6ICdcdTdGMTNcdTUxQjI6IDBzJywgY2xzOiAndm9pY2Utc29sby1zdGF0JyB9KTtcbiAgICB0aGlzLnNlZ0NvdW50RWwgPSBzdGF0cy5jcmVhdGVFbCgnc3BhbicsIHsgdGV4dDogJ1x1NkJCNVx1NjU3MDogMCcsIGNsczogJ3ZvaWNlLXNvbG8tc3RhdCcgfSk7XG5cbiAgICAvLyBPdXRwdXRcbiAgICB0aGlzLm91dHB1dEVsID0gY29udGFpbmVyLmNyZWF0ZUVsKCdkaXYnLCB7IGNsczogJ3ZvaWNlLXNvbG8tb3V0cHV0JyB9KTtcbiAgICB0aGlzLm91dHB1dEVsLmNyZWF0ZUVsKCdkaXYnLCB7XG4gICAgICB0ZXh0OiAnXHU1MkEwXHU4RjdEXHU2QTIxXHU1NzhCXHU1NDBFXHU3MEI5XHU1MUZCXCJcdTVGMDBcdTU5Q0JcdThCQzZcdTUyMkJcIlx1NUYwMFx1NTlDQlx1NUI5RVx1NjVGNlx1OEJFRFx1OTdGM1x1OEJDNlx1NTIyQicsXG4gICAgICBjbHM6ICd2b2ljZS1zb2xvLXBsYWNlaG9sZGVyJyxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIG9uQ2xvc2UoKSB7XG4gICAgaWYgKHRoaXMuaXNSdW5uaW5nICYmIHRoaXMub25TdG9wKSB0aGlzLm9uU3RvcCgpO1xuICB9XG5cbiAgc2V0U3RhdHVzKGNsczogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpIHtcbiAgICB0aGlzLnN0YXR1c0VsLmNsYXNzTmFtZSA9ICd2b2ljZS1zb2xvLXN0YXR1cyB2b2ljZS1zb2xvLScgKyBjbHM7XG4gICAgdGhpcy5zdGF0dXNFbC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBzZXRCdWZmZXIoc2Vjb25kczogbnVtYmVyKSB7XG4gICAgdGhpcy5idWZmZXJFbC50ZXh0Q29udGVudCA9IGBcdTdGMTNcdTUxQjI6ICR7c2Vjb25kcy50b0ZpeGVkKDEpfXNgO1xuICB9XG5cbiAgYWRkU2VnbWVudCh0ZXh0OiBzdHJpbmcsIHN0YXJ0TXM6IG51bWJlciwgZW5kTXM6IG51bWJlciwgcGVyZj86IGFueSkge1xuICAgIHRoaXMuc2VnQ291bnQrKztcbiAgICB0aGlzLnNlZ0NvdW50RWwudGV4dENvbnRlbnQgPSBgXHU2QkI1XHU2NTcwOiAke3RoaXMuc2VnQ291bnR9YDtcblxuICAgIGNvbnN0IHBoID0gdGhpcy5vdXRwdXRFbC5xdWVyeVNlbGVjdG9yKCcudm9pY2Utc29sby1wbGFjZWhvbGRlcicpO1xuICAgIGlmIChwaCkgcGgucmVtb3ZlKCk7XG5cbiAgICBjb25zdCBzZWcgPSB0aGlzLm91dHB1dEVsLmNyZWF0ZUVsKCdkaXYnLCB7IGNsczogJ3ZvaWNlLXNvbG8tc2VnbWVudCcgfSk7XG5cbiAgICBsZXQgdGltZVN0ciA9IGAkeyhzdGFydE1zIC8gMTAwMCkudG9GaXhlZCgxKX1zIFx1MjAxNCAkeyhlbmRNcyAvIDEwMDApLnRvRml4ZWQoMSl9c2A7XG4gICAgaWYgKHBlcmYpIHtcbiAgICAgIHRpbWVTdHIgKz0gYCB8IFZBRCAke3BlcmYudmFkTXN9bXMgfCBGQiAke3BlcmYuYXNyRmJhbmtNc31tcyB8IEFTUiAke3BlcmYuYXNySW5mZXJNc31tcyB8IERFQyAke3BlcmYuYXNyRGVjb2RlTXN9bXMgfCBQVU5DICR7cGVyZi5wdW5jTXN9bXMgfCBcdTU4MDYgJHtwZXJmLmhlYXBNQn1NQmA7XG4gICAgfVxuICAgIHNlZy5jcmVhdGVFbCgnZGl2JywgeyB0ZXh0OiB0aW1lU3RyLCBjbHM6ICd2b2ljZS1zb2xvLXNlZy10aW1lJyB9KTtcbiAgICBzZWcuY3JlYXRlRWwoJ2RpdicsIHsgdGV4dCwgY2xzOiAndm9pY2Utc29sby1zZWctdGV4dCcgfSk7XG5cbiAgICB0aGlzLm91dHB1dEVsLnNjcm9sbFRvcCA9IHRoaXMub3V0cHV0RWwuc2Nyb2xsSGVpZ2h0O1xuICB9XG5cbiAgY2xlYXIoKSB7XG4gICAgdGhpcy5vdXRwdXRFbC5lbXB0eSgpO1xuICAgIHRoaXMub3V0cHV0RWwuY3JlYXRlRWwoJ2RpdicsIHtcbiAgICAgIHRleHQ6ICdcdTcwQjlcdTUxRkJcIlx1NUYwMFx1NTlDQlx1OEJDNlx1NTIyQlwiXHU1RjAwXHU1OUNCXHU1QjlFXHU2NUY2XHU4QkVEXHU5N0YzXHU4QkM2XHU1MjJCJyxcbiAgICAgIGNsczogJ3ZvaWNlLXNvbG8tcGxhY2Vob2xkZXInLFxuICAgIH0pO1xuICAgIHRoaXMuc2VnQ291bnQgPSAwO1xuICAgIHRoaXMuc2VnQ291bnRFbC50ZXh0Q29udGVudCA9ICdcdTZCQjVcdTY1NzA6IDAnO1xuICAgIHRoaXMuYnVmZmVyRWwudGV4dENvbnRlbnQgPSAnXHU3RjEzXHU1MUIyOiAwcyc7XG4gIH1cbn1cbiIsICIvLyBUZXh0UHJvY2Vzc29yIFx1MjAxNCBwb3N0LUFTUiB0ZXh0IHNwbGl0dGluZyAoYWxpZ25lZCB3aXRoIFB5dGhvbiB0ZXh0X3Byb2Nlc3Nvci5weSlcbi8vXG4vLyBSdW5zIG9uIG1haW4gdGhyZWFkLiBSZWNlaXZlcyBmdWxsIEFTUiB0ZXh0IHNlZ21lbnRzIGZyb20gV29ya2VyLFxuLy8gc3BsaXRzIGludG8gZGlzcGxheWFibGUgc2hvcnQgc2VudGVuY2VzIGJhc2VkIG9uIHB1bmN0dWF0aW9uICsgbGVuZ3RoLlxuXG5pbnRlcmZhY2UgVGV4dFByb2NDb25maWcge1xuICBtYXhMaW5lQ2hhcnM6IG51bWJlcjsgICAgICAgLy8gbWF4IGNoYXJzIGJlZm9yZSBmb3JjZWQgc3BsaXQgKGRlZmF1bHQgMzApXG4gIHNpbGVuY2VUaHJlc2hvbGRNczogbnVtYmVyOyAvLyBzaWxlbmNlIGdhcCB0byB0cmlnZ2VyIG5ld2xpbmUgKHVudXNlZCBpbiBicm93c2VyIG1vZGUpXG4gIGRlZHVwV2luZG93TXM6IG51bWJlcjsgICAgICAvLyBkZWR1cCB3aW5kb3cgKGRlZmF1bHQgMzAwMG1zKVxufVxuXG5pbnRlcmZhY2UgVGlja1Jlc3VsdCB7XG4gIHRleHQ6IHN0cmluZyB8IG51bGw7XG59XG5cbmNvbnN0IFBVTkNUVUFUSU9OID0gJ1x1MzAwMlx1RkYwMVx1RkYxRi4hPyc7XG5jb25zdCBTUExJVF9QVU5DVFVBVElPTiA9ICdcdUZGMENcdTMwMDJcdUZGMDFcdUZGMUYuIT9cdTMwMDEnO1xuXG5leHBvcnQgY2xhc3MgVGV4dFByb2Nlc3NvciB7XG4gIHByaXZhdGUgYnVmZmVyID0gJyc7XG4gIHByaXZhdGUgc2VudFBvcyA9IDA7XG4gIHByaXZhdGUgbmVlZHNTcGxpdCA9IGZhbHNlO1xuICBwcml2YXRlIHByZXZUYWlsID0gJyc7XG4gIHByaXZhdGUgaGlzdG9yeTogQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IHRpbWU6IG51bWJlciB9PiA9IFtdO1xuICBwcml2YXRlIGNvbmZpZzogVGV4dFByb2NDb25maWc7XG5cbiAgY29uc3RydWN0b3IoY29uZmlnOiBQYXJ0aWFsPFRleHRQcm9jQ29uZmlnPiA9IHt9KSB7XG4gICAgdGhpcy5jb25maWcgPSB7XG4gICAgICBtYXhMaW5lQ2hhcnM6IGNvbmZpZy5tYXhMaW5lQ2hhcnMgfHwgMzAsXG4gICAgICBzaWxlbmNlVGhyZXNob2xkTXM6IGNvbmZpZy5zaWxlbmNlVGhyZXNob2xkTXMgfHwgODAwLFxuICAgICAgZGVkdXBXaW5kb3dNczogY29uZmlnLmRlZHVwV2luZG93TXMgfHwgMzAwMCxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEZlZWQgYSBuZXcgcmVjb2duaXplZCB0ZXh0IHNlZ21lbnQuIFJldHVybnMgMC1OIHNwbGl0IHNlbnRlbmNlcy4gKi9cbiAgdGljayh0ZXh0OiBzdHJpbmcsIGN1cnJlbnRUaW1lOiBudW1iZXIpOiBUaWNrUmVzdWx0W10ge1xuICAgIGlmICghdGV4dCkgcmV0dXJuIFtdO1xuXG4gICAgdGhpcy5idWZmZXIgKz0gdGV4dDtcbiAgICBjb25zdCByZXN1bHRzOiBUaWNrUmVzdWx0W10gPSBbXTtcblxuICAgIC8vIENoZWNrIGR1cGxpY2F0ZVxuICAgIGlmICh0aGlzLmlzRHVwKHRoaXMuYnVmZmVyLCBjdXJyZW50VGltZSkpIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICBjb25zdCBpc1NlbnRlbmNlRW5kID0gUFVOQ1RVQVRJT04uaW5jbHVkZXModGhpcy5idWZmZXIuc2xpY2UoLTEpKTtcbiAgICBjb25zdCBmdWxsTGVuID0gdGhpcy5idWZmZXIubGVuZ3RoO1xuXG4gICAgLy8gU2VudGVuY2UgZW5kIFx1MjE5MiBlbWl0XG4gICAgaWYgKGlzU2VudGVuY2VFbmQpIHtcbiAgICAgIGNvbnN0IHVuc2VudCA9IHRoaXMuYnVmZmVyLnNsaWNlKHRoaXMuc2VudFBvcyk7XG4gICAgICB0aGlzLnJlY29yZCh0aGlzLmJ1ZmZlciwgY3VycmVudFRpbWUpO1xuICAgICAgdGhpcy5idWZmZXIgPSAnJztcbiAgICAgIHRoaXMubmVlZHNTcGxpdCA9IGZhbHNlO1xuICAgICAgdGhpcy5zZW50UG9zID0gMDtcbiAgICAgIHJlc3VsdHMucHVzaCh7IHRleHQ6IHVuc2VudCB9KTtcbiAgICB9IGVsc2UgaWYgKGZ1bGxMZW4gPj0gdGhpcy5jb25maWcubWF4TGluZUNoYXJzKSB7XG4gICAgICAvLyBNYXJrIGZvciBzcGxpdCBvbiBuZXh0IHNwbGl0IHB1bmN0dWF0aW9uIG9yIDJ4IG92ZXJmbG93XG4gICAgICB0aGlzLm5lZWRzU3BsaXQgPSB0cnVlO1xuICAgIH1cblxuICAgIC8vIE5lZWRzIHNwbGl0ICsgc3BsaXQgcHVuY3R1YXRpb24gYXZhaWxhYmxlXG4gICAgaWYgKHRoaXMubmVlZHNTcGxpdCkge1xuICAgICAgY29uc3Qgc3BsaXRJZHggPSB0aGlzLmZpbmRTcGxpdFBvaW50KHRoaXMuYnVmZmVyLCB0aGlzLnNlbnRQb3MpO1xuICAgICAgaWYgKHNwbGl0SWR4ID4gMCkge1xuICAgICAgICBjb25zdCB1bnNlbnQgPSB0aGlzLmJ1ZmZlci5zbGljZSh0aGlzLnNlbnRQb3MsIHNwbGl0SWR4ICsgMSk7XG4gICAgICAgIHRoaXMuYnVmZmVyID0gdGhpcy5idWZmZXIuc2xpY2Uoc3BsaXRJZHggKyAxKTtcbiAgICAgICAgdGhpcy5yZWNvcmQodW5zZW50LCBjdXJyZW50VGltZSk7XG4gICAgICAgIHRoaXMubmVlZHNTcGxpdCA9IGZhbHNlO1xuICAgICAgICB0aGlzLnNlbnRQb3MgPSAwO1xuICAgICAgICByZXN1bHRzLnB1c2goeyB0ZXh0OiB1bnNlbnQgfSk7XG4gICAgICB9IGVsc2UgaWYgKGZ1bGxMZW4gPj0gdGhpcy5jb25maWcubWF4TGluZUNoYXJzICogMikge1xuICAgICAgICAvLyBGb3JjZSBzcGxpdCBhdCBtYXhMaW5lQ2hhcnMgKiAyXG4gICAgICAgIGNvbnN0IHVuc2VudCA9IHRoaXMuYnVmZmVyLnNsaWNlKDAsIHRoaXMuY29uZmlnLm1heExpbmVDaGFycyk7XG4gICAgICAgIHRoaXMuYnVmZmVyID0gdGhpcy5idWZmZXIuc2xpY2UodGhpcy5jb25maWcubWF4TGluZUNoYXJzKTtcbiAgICAgICAgdGhpcy5yZWNvcmQodW5zZW50LCBjdXJyZW50VGltZSk7XG4gICAgICAgIHRoaXMubmVlZHNTcGxpdCA9IGZhbHNlO1xuICAgICAgICB0aGlzLnNlbnRQb3MgPSAwO1xuICAgICAgICByZXN1bHRzLnB1c2goeyB0ZXh0OiB1bnNlbnQgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cblxuICAvKiogRmx1c2ggcmVtYWluaW5nIGJ1ZmZlciAoY2FsbCBvbiBzdG9wKS4gKi9cbiAgZmx1c2goKTogVGlja1Jlc3VsdFtdIHtcbiAgICBpZiAoIXRoaXMuYnVmZmVyKSByZXR1cm4gW107XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYnVmZmVyO1xuICAgIHRoaXMuYnVmZmVyID0gJyc7XG4gICAgdGhpcy5zZW50UG9zID0gMDtcbiAgICB0aGlzLm5lZWRzU3BsaXQgPSBmYWxzZTtcbiAgICByZXR1cm4gW3sgdGV4dCB9XTtcbiAgfVxuXG4gIHJlc2V0KCkge1xuICAgIHRoaXMuYnVmZmVyID0gJyc7XG4gICAgdGhpcy5zZW50UG9zID0gMDtcbiAgICB0aGlzLm5lZWRzU3BsaXQgPSBmYWxzZTtcbiAgICB0aGlzLmhpc3RvcnkgPSBbXTtcbiAgfVxuXG4gIHByaXZhdGUgZmluZFNwbGl0UG9pbnQoYnVmOiBzdHJpbmcsIGZyb206IG51bWJlcik6IG51bWJlciB7XG4gICAgZm9yIChsZXQgaSA9IGJ1Zi5sZW5ndGggLSAxOyBpID49IGZyb207IGktLSkge1xuICAgICAgaWYgKFNQTElUX1BVTkNUVUFUSU9OLmluY2x1ZGVzKGJ1ZltpXSkpIHJldHVybiBpO1xuICAgIH1cbiAgICByZXR1cm4gLTE7XG4gIH1cblxuICBwcml2YXRlIGlzRHVwKHRleHQ6IHN0cmluZywgdGltZTogbnVtYmVyKTogYm9vbGVhbiB7XG4gICAgY29uc3QgdGFpbCA9IHRleHQuc2xpY2UoLTEwKTtcbiAgICBpZiAodGFpbCA9PT0gdGhpcy5wcmV2VGFpbCkgcmV0dXJuIHRydWU7XG4gICAgLy8gQ2hlY2sgcmVjZW50IGhpc3RvcnlcbiAgICBjb25zdCBjdXRvZmYgPSB0aW1lIC0gdGhpcy5jb25maWcuZGVkdXBXaW5kb3dNcztcbiAgICB0aGlzLmhpc3RvcnkgPSB0aGlzLmhpc3RvcnkuZmlsdGVyKGggPT4gaC50aW1lID49IGN1dG9mZik7XG4gICAgZm9yIChjb25zdCBoIG9mIHRoaXMuaGlzdG9yeSkge1xuICAgICAgaWYgKGgudGV4dCA9PT0gdGV4dCkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHByaXZhdGUgcmVjb3JkKHRleHQ6IHN0cmluZywgdGltZTogbnVtYmVyKSB7XG4gICAgdGhpcy5wcmV2VGFpbCA9IHRleHQuc2xpY2UoLTEwKTtcbiAgICB0aGlzLmhpc3RvcnkucHVzaCh7IHRleHQsIHRpbWUgfSk7XG4gICAgaWYgKHRoaXMuaGlzdG9yeS5sZW5ndGggPiAyMCkgdGhpcy5oaXN0b3J5LnNoaWZ0KCk7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBQUFBLG1CQUFrRDs7O0FDQWxELHNCQUF3QztBQUVqQyxJQUFNLFlBQVk7QUFFbEIsSUFBTSxnQkFBTixjQUE0Qix5QkFBUztBQUFBLEVBYzFDLFlBQVksTUFBcUI7QUFDL0IsVUFBTSxJQUFJO0FBZFosU0FBUSxZQUFZO0FBT3BCLFNBQVEsV0FBVztBQUduQjtBQUFBLG1CQUF3QztBQUN4QyxrQkFBOEI7QUFBQSxFQUk5QjtBQUFBLEVBRUEsY0FBc0I7QUFDcEIsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLGlCQUF5QjtBQUN2QixXQUFPO0FBQUEsRUFDVDtBQUFBLEVBRUEsVUFBa0I7QUFDaEIsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUVBLE1BQU0sU0FBUztBQUNiLFVBQU0sWUFBWSxLQUFLLFlBQVksU0FBUyxDQUFDO0FBQzdDLGNBQVUsTUFBTTtBQUNoQixjQUFVLFNBQVMsc0JBQXNCO0FBR3pDLFVBQU0sU0FBUyxVQUFVLFNBQVMsT0FBTyxFQUFFLEtBQUssb0JBQW9CLENBQUM7QUFDckUsV0FBTyxTQUFTLFFBQVEsRUFBRSxNQUFN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UUFBUTtBQUNmLGFBQUssT0FBTyxZQUFZLEVBQUUsTUFBTSxTQUFTLE1BQU0sRUFBRSxLQUFLLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ25FO0FBQUEsSUFDRjtBQUVBLFVBQU0sU0FBUyxLQUFLLFNBQVMsd0JBQXdCLEtBQUssU0FBUztBQUNuRSxXQUFPLFFBQVEsS0FBSyxXQUFXO0FBQUEsRUFDakM7QUFBQSxFQUVBLE1BQU0sZUFBZTtBQUNuQixTQUFLLFdBQVcsT0FBTyxPQUFPLENBQUMsR0FBRyxrQkFBa0IsTUFBTSxLQUFLLFNBQVMsQ0FBQztBQUFBLEVBQzNFO0FBQUEsRUFFQSxNQUFNLGVBQWU7QUFDbkIsVUFBTSxLQUFLLFNBQVMsS0FBSyxRQUFRO0FBQUEsRUFDbkM7QUFDRjtBQUlBLElBQU0sc0JBQU4sY0FBa0Msa0NBQWlCO0FBQUEsRUFHakQsWUFBWSxLQUFVLFFBQXlCO0FBQzdDLFVBQU0sS0FBSyxNQUFNO0FBQ2pCLFNBQUssU0FBUztBQUFBLEVBQ2hCO0FBQUEsRUFFQSxVQUFnQjtBQUNkLFVBQU0sRUFBRSxZQUFZLElBQUk7QUFDeEIsZ0JBQVksTUFBTTtBQUNsQixnQkFBWSxTQUFTLE1BQU0sRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRTFELFFBQUkseUJBQVEsV0FBVyxFQUNwQixRQUFRLDBCQUFNLEVBQ2QsUUFBUSwwR0FBeUMsRUFDakQsUUFBUSxVQUFRLEtBQ2QsZUFBZSxtQ0FBbUMsRUFDbEQsU0FBUyxLQUFLLE9BQU8sU0FBUyxhQUFhLEVBQzNDLFNBQVMsT0FBTyxVQUFVO0FBQ3pCLFdBQUssT0FBTyxTQUFTLGdCQUFnQjtBQUNyQyxZQUFNLEtBQUssT0FBTyxhQUFhO0FBQUEsSUFDakMsQ0FBQyxDQUFDO0FBRU4sUUFBSSx5QkFBUSxXQUFXLEVBQ3BCLFFBQVEsZ0NBQU8sRUFDZixRQUFRLDRFQUErQixFQUN2QyxZQUFZLFVBQVEsS0FDbEIsZUFBZSxrRUFBMEIsRUFDekMsU0FBUyxLQUFLLFVBQVUsS0FBSyxPQUFPLFNBQVMsVUFBVSxNQUFNLENBQUMsQ0FBQyxFQUMvRCxTQUFTLE9BQU8sVUFBVTtBQUN6QixVQUFJO0FBQ0YsYUFBSyxPQUFPLFNBQVMsV0FBVyxLQUFLLE1BQU0sU0FBUyxJQUFJO0FBQ3hELGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxNQUNqQyxRQUFRO0FBQUEsTUFBNkI7QUFBQSxJQUN2QyxDQUFDLENBQUM7QUFFTixRQUFJLHlCQUFRLFdBQVcsRUFDcEIsUUFBUSxzQ0FBUSxFQUNoQixRQUFRLDhHQUFvQixFQUM1QixVQUFVLFlBQVUsT0FDbEIsU0FBUyxLQUFLLE9BQU8sU0FBUyxjQUFjLEVBQzVDLFNBQVMsT0FBTyxVQUFVO0FBQ3pCLFdBQUssT0FBTyxTQUFTLGlCQUFpQjtBQUN0QyxZQUFNLEtBQUssT0FBTyxhQUFhO0FBQUEsSUFDakMsQ0FBQyxDQUFDO0FBQUEsRUFDUjtBQUNGOyIsCiAgIm5hbWVzIjogWyJpbXBvcnRfb2JzaWRpYW4iXQp9Cg==
