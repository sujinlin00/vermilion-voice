import { Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { VoiceSoloView, VIEW_TYPE } from './view';
import type { VoiceSoloSettings, WorkerToMain } from './types';
import { TextProcessor } from './text-processor';

const DEFAULT_SETTINGS: VoiceSoloSettings = {
  modelBasePath: '',
  hotWords: {},
  autoSaveToNote: false,
};

export default class VoiceSoloPlugin extends Plugin {
  settings: VoiceSoloSettings;
  private worker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private pluginDir: string = '';
  private textProc: TextProcessor = new TextProcessor();

  async onload() {
    await this.loadSettings();

    // Register view — inject plugin reference for callback wiring
    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new VoiceSoloView(leaf);
      view.onStart = () => this.startRecognition(view);
      view.onStop = () => this.stopRecognition();
      return view;
    });

    // Ribbon icon
    this.addRibbonIcon('mic', 'Voice Solo', () => this.toggleView());

    // Settings tab
    this.addSettingTab(new VoiceSoloSettingTab(this.app, this));

    // Command: toggle view
    this.addCommand({
      id: 'voice-solo-open',
      name: 'Open voice recognition panel',
      callback: () => this.toggleView(),
    });

    // Determine plugin directory
    const vaultRoot = (this.app.vault.adapter as any).basePath as string;
    this.pluginDir = vaultRoot + '/.obsidian/plugins/voice-solo';
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

  async startRecognition(view: VoiceSoloView) {
    try {
      await this.createWorker(view);
      await this.startMic(view);
    } catch (e: any) {
      console.error('[VoiceSolo] startRecognition failed:', e);
      view.setStatus('error', e.message || '启动失败');
      this.stopRecognition();
    }
  }

  stopRecognition() {
    // Flush any remaining buffered text
    const parts = this.textProc.flush();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      const view = leaves[0].view as VoiceSoloView;
      for (const p of parts) {
        if (p.text) view.addSegment(p.text, 0, 0);
      }
    }
    this.textProc.reset();

    if (this.workletNode) { this.workletNode.disconnect(); this.workletNode = null; }
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
  }

  async createWorker(view: VoiceSoloView) {
    if (this.worker) { this.worker.terminate(); this.worker = null; }

    // Read worker.js and create Blob URL (page is app:// origin, blob is same-origin)
    const workerPath = this.pluginDir + '\\worker.js';
    const fs: any = (window as any).require?.('fs') || require('fs');
    const workerCode = fs.readFileSync(workerPath, 'utf-8');
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob), { type: 'module' });

    // Catch worker init errors
    this.worker.onerror = (e) => {
      console.error('[VoiceSolo] Worker error:', e.message);
      view.setStatus('error', 'Worker 错误: ' + e.message);
    };

    // Handle messages from worker
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          view.setStatus('ready', '模型就绪 — 开始识别');
          this.worker!.postMessage({ type: 'start' });
          break;
        case 'status':
          if (msg.status === 'listening') view.setStatus('recording', '监听中...');
          else if (msg.status === 'speech') view.setStatus('recording', '说话中...');
          else if (msg.status === 'asr') view.setStatus('processing', '识别中...');
          else if (msg.status === 'punc') view.setStatus('processing', '标点中...');
          else if (msg.status === 'idle') view.setStatus('idle', '已停止');
          break;
        case 'segment': {
          // TextProcessor splits long ASR output into displayable sentences
          const parts = this.textProc.tick(msg.text, msg.endMs);
          for (const p of parts) {
            if (p.text) view.addSegment(p.text, msg.startMs, msg.endMs, msg.perf);
          }
          break;
        }
        case 'error':
          view.setStatus('error', msg.message);
          break;
        case 'progress':
          view.setStatus('loading', `加载 ${msg.phase.toUpperCase()}: ${msg.pct}%`);
          break;
      }
    };

    // Initialize worker with pre-loaded model data
    await this.loadWorkerConfig(view);
  }

  async loadWorkerConfig(view: VoiceSoloView) {
    const baseDir = this.settings.modelBasePath.replace(/\\/g, '/').replace(/\/$/, '');
    if (!baseDir) throw new Error('请先在设置中配置模型目录路径 (Settings → Voice Solo)');
    const vadDir = `${baseDir}/vad/speech_fsmn_vad_zh-cn-16k-common-onnx`;
    const asrDir = `${baseDir}/asr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`;
    const puncDir = `${baseDir}/punc/punc_ct-transformer_zh-cn-common-vocab272727-onnx`;

    // Use require('fs') for all file reads (no fetch cross-origin issues)
    let fs: any;
    try { fs = (window as any).require('fs'); } catch { fs = require('fs'); }
    const readText = (p: string) => fs.readFileSync(p, 'utf-8');
    const readBuf = (p: string) => fs.readFileSync(p).buffer as ArrayBuffer;

    // Read model files + config
    const vadModelBuf = readBuf(`${vadDir}\\model_quant.onnx`);
    const asrModelBuf = readBuf(`${asrDir}\\model_quant.onnx`);
    const puncModelBuf = readBuf(`${puncDir}\\model_quant.onnx`);
    const vadCmvn = readText(`${vadDir}\\am.mvn`);
    const asrCmvn = readText(`${asrDir}\\am.mvn`);
    const tokensJson = JSON.parse(readText(`${asrDir}\\tokens.json`));
    const puncTokensJson = JSON.parse(readText(`${puncDir}\\tokens.json`));

    // Read ORT WASM files
    const threadedWasm = readBuf(this.pluginDir + '\\lib\\ort-wasm-simd-threaded.wasm');
    const jsepWasm = readBuf(this.pluginDir + '\\lib\\ort-wasm-simd-threaded.jsep.wasm');

    // Detect WebGPU on main thread (more reliable than Worker-side detection)
    let hasWebGPU = false;
    if ((navigator as any).gpu) {
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        hasWebGPU = !!adapter;
      } catch { /* fall through */ }
    }

    // Transfer model + WASM buffers to Worker (zero-copy)
    this.worker!.postMessage({
      type: 'init',
      config: {
        hasWebGPU: hasWebGPU,
        vadModelBuffer: vadModelBuf,
        asrModelBuffer: asrModelBuf,
        puncModelBuffer: puncModelBuf,
        vadCmvnText: vadCmvn,
        asrCmvnText: asrCmvn,
        tokensJson: tokensJson,
        puncTokensJson: puncTokensJson,
        threadedWasm: threadedWasm,
        jsepWasm: jsepWasm,
      },
    }, [vadModelBuf, asrModelBuf, puncModelBuf, threadedWasm, jsepWasm]);
  }

  async startMic(view: VoiceSoloView) {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    this.audioCtx = new AudioContext();

    // Load AudioWorklet via Blob URL (file:// is cross-origin from app://)
    const fs: any = (window as any).require?.('fs') || require('fs');
    const workletCode = fs.readFileSync(this.pluginDir + '\\mic_worklet.js', 'utf-8');
    const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
    await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(workletBlob));

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'mic-processor');
    this.workletNode.port.onmessage = (e) => {
      if (this.worker) {
        this.worker.postMessage({ type: 'chunk', data: e.data }, [e.data]);
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
}

// ---- Settings Tab ----

class VoiceSoloSettingTab extends PluginSettingTab {
  plugin: VoiceSoloPlugin;

  constructor(app: App, plugin: VoiceSoloPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Voice Solo Settings' });

    new Setting(containerEl)
      .setName('模型目录')
      .setDesc('FunASR 模型的本地根目录，含 vad/, asr/, punc/ 子目录')
      .addText(text => text
        .setPlaceholder('D:/arvin/obsidian_workpace/models')
        .setValue(this.plugin.settings.modelBasePath)
        .onChange(async (value) => {
          this.plugin.settings.modelBasePath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('热词替换表')
      .setDesc('JSON 格式: {"误识别词": "正确词", ...}')
      .addTextArea(text => text
        .setPlaceholder('{"电缆": "靛蓝", "云朵": "吲哚"}')
        .setValue(JSON.stringify(this.plugin.settings.hotWords, null, 2))
        .onChange(async (value) => {
          try {
            this.plugin.settings.hotWords = JSON.parse(value || '{}');
            await this.plugin.saveSettings();
          } catch { /* invalid JSON, ignore */ }
        }));

    new Setting(containerEl)
      .setName('自动写入笔记')
      .setDesc('识别完成后自动将文本插入当前活动笔记')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSaveToNote)
        .onChange(async (value) => {
          this.plugin.settings.autoSaveToNote = value;
          await this.plugin.saveSettings();
        }));
  }
}

