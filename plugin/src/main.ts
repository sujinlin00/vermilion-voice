import { Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { VoiceSoloView, VIEW_TYPE } from './view';
import type { VoiceSoloSettings } from './types';
import type { VadToMain, AsrToMain } from './types';
import { TextProcessor } from './text-processor';
import { FlacEncoder } from './flac-encoder';

// CDN URL for ONNX Runtime WASM (wasm-only bundle, ~11MB)
const ORT_WASM_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm';

interface ModelEntry {
  name: string;
  url: string;
  files: string[];
}

interface ModelsConfig {
  vad: ModelEntry;
  asr: ModelEntry;
  punc: ModelEntry;
}

function downloadFile(url: string, dest: string, fs: any): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const dir = dest.replace(/[/\\][^/\\]*$/, '');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = fs.createWriteStream(dest);
    require('https').get(url, (res: any) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        downloadFile(res.headers.location, dest, fs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

async function ensureModels(
  modelsDir: string,
  modelsJsonPath: string,
  addLog: (msg: string) => void,
  onProgress: (phase: string, pct: number) => void,
): Promise<string> {
  const fs: any = (window as any).require?.('fs') || require('fs');
  if (!fs.existsSync(modelsJsonPath)) {
    throw new Error(`models.json not found at ${modelsJsonPath}`);
  }
  const cfg: ModelsConfig = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
  const entries: Array<{ key: string; entry: ModelEntry; parent: string }> = [
    { key: 'vad', entry: cfg.vad, parent: 'vad' },
    { key: 'asr', entry: cfg.asr, parent: 'asr' },
    { key: 'punc', entry: cfg.punc, parent: 'punc' },
  ];

  let downloaded = false;
  for (const { key, entry, parent } of entries) {
    const modelDir = `${modelsDir}/${parent}/${entry.name}`;
    try { fs.mkdirSync(modelDir, { recursive: true }); } catch {}
    for (const f of entry.files) {
      const dest = `${modelDir}/${f}`;
      if (!fs.existsSync(dest)) {
        const url = `${entry.url}/${f}`;
        addLog(`Downloading ${key}/${f}...`);
        onProgress(key, 0);
        await downloadFile(url, dest, fs);
        const stat = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        addLog(`${key}/${f}: ${(stat / 1024).toFixed(0)}KB`);
        onProgress(key, 100);
        downloaded = true;
      }
    }
  }

  if (downloaded) addLog('All models ready');
  return modelsDir;
}

async function ensureWasmFile(wasmPath: string, addLog: (msg: string) => void): Promise<void> {
  const fs: any = (window as any).require?.('fs') || require('fs');
  if (fs.existsSync(wasmPath)) return;

  addLog(`Downloading ORT WASM from CDN...`);
  try {
    const https = require('https');
    await new Promise<void>((resolve, reject) => {
      const dir = wasmPath.replace(/[/\\][^/\\]*$/, '');
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const file = fs.createWriteStream(wasmPath);
      https.get(ORT_WASM_CDN, (res: any) => {
        if (res.statusCode !== 200) {
          reject(new Error(`CDN download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });
    const stat = fs.statSync(wasmPath);
    addLog(`ORT WASM downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
  } catch (e: any) {
    addLog(`ORT WASM download failed: ${e.message}`);
    throw new Error(`无法下载 ONNX Runtime WASM 文件。请检查网络连接。\n${e.message}`);
  }
}

const DEFAULT_SETTINGS: VoiceSoloSettings = {
  modelBasePath: '',
  asrModelTier: 'standard',
  outputToNote: false,
  outputFolder: 'Transcriptions',
  saveAudio: false,
  recordingFolder: 'Recordings',
  postProcessEnabled: false,
  audioDevice: '',
  hotWords: {},
};

export default class VoiceSoloPlugin extends Plugin {
  settings: VoiceSoloSettings;
  private vadWorker: Worker | null = null;
  private asrWorker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private pluginDir: string = '';
  private textProc: TextProcessor = new TextProcessor();
  private vadReady = false;
  private asrReady = false;
  private asrBusy = false;
  private logBuf: string[] = [];
  private logTimer = 0;
  private pendingSegments: Array<{ audio: Float32Array; startMs: number; endMs: number }> = [];
  private flacEncoder: FlacEncoder | null = null;
  private currentNotePath: string = '';
  private recordingPath: string = '';
  private pendingPlaceholder: string = '';

  private tickTimer: number = 0;

  private addLog(msg: string) {
    const ts = Date.now();
    this.logBuf.push(`[${ts}] ${msg}`);
    if (this.logBuf.length > 500) this.logBuf = this.logBuf.slice(-300);
  }

  private async flushLog(reason: string) {
    console.log(`[VoiceSolo] flushLog(${reason}) bufLen=${this.logBuf.length}`, this.logBuf.slice(0, 5));
    if (this.logBuf.length === 0) return;
    try {
      const text = `# Voice-Solo Debug Log — ${reason}\n\n` +
        this.logBuf.map(l => `- ${l}`).join('\n');
      const file = this.pluginDir.replace(/\\/g, '/') + '/debug-log.md';
      const fs: any = (window as any).require?.('fs') || require('fs');
      fs.writeFileSync(file, text, 'utf-8');
      this.logBuf = [];
    } catch { /* can't write, ignore */ }
  }

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new VoiceSoloView(leaf);
      view.onStart = () => this.startRecognition(view);
      view.onStop = () => this.stopRecognition();
      return view;
    });

    this.addRibbonIcon('mic', 'Voice Solo', () => this.toggleView());
    this.addSettingTab(new VoiceSoloSettingTab(this.app, this));

    this.addCommand({
      id: 'voice-solo-open',
      name: 'Open voice recognition panel',
      callback: () => this.toggleView(),
    });

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
    console.log('[VoiceSolo] startRecognition called');
    try {
      this.addLog('START requested');
      const fs: any = (window as any).require?.('fs') || require('fs');

      // Init FLAC recording (streaming)
      if (this.settings.saveAudio) {
        this.addLog('[step] init FLAC encoder...');
        const vaultRoot = (this.app.vault.adapter as any).basePath as string;
        const dir = vaultRoot + '/' + this.settings.recordingFolder;
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        this.recordingPath = dir + '/录音_' + ts + '.flac';
        FlacEncoder.pluginDir = this.pluginDir;
        this.flacEncoder = new FlacEncoder(16000, 4096);
        await this.flacEncoder.open(this.recordingPath, fs);
        this.addLog(`FLAC recording: ${this.recordingPath}`);
      }

      // Init note output
      if (this.settings.outputToNote) {
        this.addLog('[step] init note output...');
        await this.ensureOutputFile();
        await this.insertNoteHeader();
        if (this.settings.saveAudio) {
          const fname = this.recordingPath.replace(/\\/g, '/').split('/').pop() || '';
          await this.insertAudioPlaceholder(fname);
        }
      }

      // Start 3s tick timer
      this.tickTimer = window.setInterval(() => {
        const results = this.textProc.tickForce(Date.now());
        const lv = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        const v = lv.length > 0 ? lv[0].view as VoiceSoloView : null;
        for (const r of results) {
          if (r.text) {
            if (v) v.addSegment(r.text, 0, 0);
            if (this.settings.outputToNote) this.appendToNote(r.text);
          }
        }
      }, 3000);

      this.addLog('[step] creating workers...');
      await this.createWorkers(view);
      this.addLog('[step] starting mic...');
      await this.startMic(view);
      this.addLog('[step] startMic done');
    } catch (e: any) {
      this.addLog(`ERROR: ${e.message}\n${e.stack}`);
      console.error('[VoiceSolo] startRecognition failed:', e);
      view.setStatus('error', e.message || '启动失败');
      this.stopRecognition();
    }
  }

  async stopRecognition() {
    this.addLog('STOP requested');
    // Stop tick timer
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = 0; }
    // Flush text processor
    const parts = this.textProc.flush(Date.now());
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves.length > 0 ? leaves[0].view as VoiceSoloView : null;
    for (const p of parts) {
      if (p.text) {
        if (view) view.addSegment(p.text, 0, 0);
        if (this.settings.outputToNote) this.appendToNote(p.text);
      }
    }
    this.textProc.reset();
    this.pendingSegments = [];

    // Stop mic first
    if (this.workletNode) { this.workletNode.disconnect(); this.workletNode = null; }
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }

    // Finalize FLAC recording
    if (this.flacEncoder) {
      const flacFs: any = (window as any).require?.('fs') || require('fs');
      const flacDbg = this.flacEncoder.close(flacFs);
      this.addLog(`FLAC close: ${flacDbg}`);
      this.flacEncoder = null;
      if (this.settings.outputToNote && this.recordingPath) {
        await this.replacePlaceholderWithEmbed();
      }
      this.recordingPath = '';
    }

    // Stop VAD worker (flushes last speech segment)
    if (this.vadWorker) {
      this.vadWorker.postMessage({ type: 'stop' });
    }

    // Wait for ASR queue to drain (current segment + pending)
    if (this.asrWorker) {
      await this.waitForAsrDrain();
      this.asrWorker.terminate();
      this.asrWorker = null;
    }

    if (this.vadWorker) {
      this.vadWorker.terminate();
      this.vadWorker = null;
    }

    this.vadReady = false;
    this.asrReady = false;
    this.asrBusy = false;
    this.flushLog('stop');
  }

  waitForAsrDrain(): Promise<void> {
    const maxWait = 15000; // 15s max
    const start = Date.now();
    return new Promise(resolve => {
      const check = () => {
        const empty = !this.asrBusy && this.pendingSegments.length === 0;
        if (empty || Date.now() - start > maxWait) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  // ---- Dual Worker setup ----

  async createWorkers(view: VoiceSoloView) {
    // Clean up existing workers
    if (this.vadWorker) { this.vadWorker.terminate(); this.vadWorker = null; }
    if (this.asrWorker) { this.asrWorker.terminate(); this.asrWorker = null; }
    this.vadReady = false;
    this.asrReady = false;
    this.asrBusy = false;
    this.pendingSegments = [];

    const fs: any = (window as any).require?.('fs') || require('fs');
    const readBuf = (p: string): ArrayBuffer => {
      const buf: Buffer = fs.readFileSync(p);
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return ab;
    };
    const readText = (p: string) => fs.readFileSync(p, 'utf-8');

    // Ensure ORT SIMD WASM exists (download from CDN if missing)
    this.addLog('[workers] ensureWasmFile...');
    const wasmPath = this.pluginDir + '/lib/ort-wasm-simd-threaded.wasm';
    await ensureWasmFile(wasmPath, this.addLog.bind(this));
    const simdWasm = readBuf(wasmPath);
    const jsepWasmPath = this.pluginDir + '/lib/ort-wasm-simd-threaded.jsep.wasm';
    const jsepWasm = fs.existsSync(jsepWasmPath) ? readBuf(jsepWasmPath) : null;
    this.addLog(`[workers] wasm: simd=${(simdWasm.byteLength/1024/1024).toFixed(1)}MB jsep=${jsepWasm ? (jsepWasm.byteLength/1024/1024).toFixed(1)+'MB' : 'missing'}`);
    this.addLog(`[workers] wasm loaded: ${(simdWasm.byteLength / 1024 / 1024).toFixed(1)}MB`);

    // Resolve model directory (use settings or default lib/models)
    const baseDir = this.settings.modelBasePath.replace(/\\/g, '/').replace(/\/$/, '')
      || `${this.pluginDir.replace(/\\/g, '/')}/models`;
    const modelsJsonPath = `${this.pluginDir.replace(/\\/g, '/')}/models.json`;
    if (fs.existsSync(modelsJsonPath)) {
      await ensureModels(
        baseDir,
        modelsJsonPath,
        this.addLog.bind(this),
        (_phase, _pct) => {},
      );
    }

    const vadDir = `${baseDir}/vad/speech_fsmn_vad_zh-cn-16k-common-onnx`;
    const asrDir = `${baseDir}/asr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`;
    const puncDir = `${baseDir}/punc/punc_ct-transformer_zh-cn-common-vocab272727-onnx`;

    this.addLog('[workers] loading models...');
    const vadModelBuf = readBuf(`${vadDir}/model_quant.onnx`);
    const vadCmvn = readText(`${vadDir}/am.mvn`);
    const asrModelBuf = readBuf(`${asrDir}/model_quant.onnx`);
    const asrCmvn = readText(`${asrDir}/am.mvn`);
    const puncModelBuf = readBuf(`${puncDir}/model_quant.onnx`);
    const tokensJson = JSON.parse(readText(`${asrDir}/tokens.json`));
    const puncTokensJson = JSON.parse(readText(`${puncDir}/tokens.json`));
    this.addLog(`[workers] models: vad=${vadModelBuf.byteLength} asr=${asrModelBuf.byteLength} punc=${puncModelBuf.byteLength}`);
    // Verify ASR model header
    const asrHead = new Uint8Array(asrModelBuf.slice(0, 4));
    this.addLog(`[workers] asr header: ${Array.from(asrHead).map(b=>b.toString(16).padStart(2,'0')).join('')}`);

    // Create Worker A (VAD) from Blob URL
    this.addLog('[workers] creating VAD worker...');
    const vadCode = fs.readFileSync(this.pluginDir + '/worker-vad.js', 'utf-8');
    const vadBlob = new Blob([vadCode], { type: 'application/javascript' });
    this.vadWorker = new Worker(URL.createObjectURL(vadBlob), { type: 'module' });

    this.vadWorker.onerror = (e) => {
      console.error('[VoiceSolo] VAD Worker error:', e.message);
      view.setStatus('error', 'VAD Worker: ' + e.message);
    };

    this.vadWorker.onmessage = (e: MessageEvent<VadToMain>) => {
      this.handleVadMessage(e.data, view);
    };

    // Init VAD worker (slice copies — each worker gets its own ArrayBuffer)
    const vadBuf = vadModelBuf.slice(0);
    console.log(`[VoiceSolo] VAD postMessage: modelBuf=${vadBuf.byteLength} wasm=${simdWasm.byteLength}`);
    this.vadWorker.postMessage({
      type: 'init',
      config: {
        vadModelBuffer: vadBuf,
        vadCmvnText: vadCmvn,
        simdWasm: simdWasm.slice(0),
      },
    });

    // Create Worker B (ASR + PUNC) from Blob URL
    this.addLog('[workers] creating ASR worker...');
    const asrCode = fs.readFileSync(this.pluginDir + '/worker-asr.js', 'utf-8');
    const asrBlob = new Blob([asrCode], { type: 'application/javascript' });
    this.asrWorker = new Worker(URL.createObjectURL(asrBlob), { type: 'module' });

    this.asrWorker.onerror = (e) => {
      console.error('[VoiceSolo] ASR Worker error:', e.message);
      view.setStatus('error', 'ASR Worker: ' + e.message);
    };

    this.asrWorker.onmessage = (e: MessageEvent<AsrToMain>) => {
      this.handleAsrMessage(e.data, view);
    };

    // Init ASR worker
    const asrBuf = asrModelBuf.slice(0);
    const puncBuf = puncModelBuf.slice(0);
    console.log(`[VoiceSolo] ASR postMessage: asrBuf=${asrBuf.byteLength} puncBuf=${puncBuf.byteLength} wasm=${simdWasm.byteLength}`);
    this.asrWorker.postMessage({
      type: 'init',
      config: {
        asrModelBuffer: asrBuf,
        puncModelBuffer: puncBuf,
        asrCmvnText: asrCmvn,
        tokensJson: tokensJson,
        puncTokensJson: puncTokensJson,
        simdWasm: simdWasm.slice(0),
      },
    });

    // Wait for both workers to be ready
    await new Promise<void>(resolve => {
      const iv = setInterval(() => {
        if (this.vadReady && this.asrReady) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }

  // ---- Message routing ----

  handleVadMessage(msg: VadToMain, view: VoiceSoloView) {
    if (msg.type !== 'progress') this.addLog(`VAD → ${msg.type}${'status' in msg ? ':' + msg.status : ''}`);
    switch (msg.type) {
      case 'ready':
        this.vadReady = true;
        this.addLog(`VAD ready, asrReady=${this.asrReady}`);
        if (this.asrReady) {
          view.setStatus('ready', '模型就绪 — 开始识别');
          this.vadWorker!.postMessage({ type: 'start' });
          this.addLog('START sent to VAD');
        }
        break;
      case 'status':
        if (msg.status === 'listening') view.setStatus('recording', '监听中...');
        else if (msg.status === 'speech') view.setStatus('recording', '说话中...');
        break;
      case 'segment':
        this.addLog(`VAD segment ${(msg.startMs/1000).toFixed(1)}s-${(msg.endMs/1000).toFixed(1)}s`);
        this.dispatchSegment(msg.audio, msg.startMs, msg.endMs);
        break;
      case 'error':
        this.addLog(`VAD ERROR: ${msg.message}`);
        view.setStatus('error', msg.message);
        this.flushLog('VAD-error');
        break;
      case 'progress':
        break;
    }
  }

  handleAsrMessage(msg: AsrToMain, view: VoiceSoloView) {
    if (msg.type !== 'progress') this.addLog(`ASR → ${msg.type}${'status' in msg ? ':' + msg.status : ''}`);
    switch (msg.type) {
      case 'ready':
        this.asrReady = true;
        this.addLog(`ASR ready, vadReady=${this.vadReady}`);
        if (this.vadReady) {
          view.setStatus('ready', '模型就绪 — 开始识别');
          this.vadWorker!.postMessage({ type: 'start' });
          this.addLog('START sent to VAD');
        }
        break;
      case 'status':
        if (msg.status === 'asr') view.setStatus('processing', '识别中...');
        else if (msg.status === 'punc') view.setStatus('processing', '标点中...');
        break;
      case 'result': {
        this.addLog(`ASR result: "${msg.text.slice(0, 40)}..."`);
        this.asrBusy = false;
        const parts = this.textProc.tick(msg.text, msg.startMs, msg.endMs);
        for (const p of parts) {
          if (p.text) {
            view.addSegment(p.text, msg.startMs, msg.endMs, msg.perf);
            if (this.settings.outputToNote) this.appendToNote(p.text);
          }
        }
        this.drainPending();
        break;
      }
      case 'error':
        this.addLog(`ASR ERROR: ${msg.message}`);
        view.setStatus('error', msg.message);
        this.asrBusy = false;
        this.drainPending();
        this.flushLog('ASR-error');
        break;
      case 'progress':
        break;
    }
  }

  dispatchSegment(audioBuf: ArrayBuffer, startMs: number, endMs: number) {
    if (this.asrBusy) {
      this.addLog(`DISPATCH queue (busy, pending=${this.pendingSegments.length + 1})`);
      if (this.pendingSegments.length < 3) {
        this.pendingSegments.push({
          audio: new Float32Array(audioBuf),
          startMs,
          endMs,
        });
      }
      return;
    }
    this.addLog(`DISPATCH send to ASR`);
    this.asrBusy = true;
    const audio = new Float32Array(audioBuf);
    this.asrWorker!.postMessage(
      { type: 'segment', audio: audio.buffer, startMs, endMs },
      [audio.buffer],
    );
  }

  drainPending() {
    if (this.pendingSegments.length === 0) return;
    this.addLog(`DISPATCH drain (pending=${this.pendingSegments.length})`);
    const next = this.pendingSegments.shift()!;
    this.asrBusy = true;
    this.asrWorker!.postMessage(
      { type: 'segment', audio: next.audio.buffer, startMs: next.startMs, endMs: next.endMs },
      [next.audio.buffer],
    );
  }

  // ---- File output helpers ----

  private async ensureFolder(folderPath: string) {
    const parts = folderPath.split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (!cur) continue;
      try {
        if (!this.app.vault.getAbstractFileByPath(cur)) {
          await this.app.vault.createFolder(cur);
        }
      } catch { /* exists or can't create */ }
    }
  }

  private async ensureOutputFile() {
    const now = new Date();
    const ds = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const folder = this.settings.outputFolder || 'Transcriptions';
    await this.ensureFolder(folder);
    this.currentNotePath = `${folder}/转录_${ds}.md`;
    try {
      const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
      if (!file) {
        await this.app.vault.create(this.currentNotePath, `# 转录 ${ds}\n\n`);
      }
    } catch { /* ignore */ }
  }

  private async insertNoteHeader() {
    if (!this.currentNotePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const now = new Date();
    const ts = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const header = `\n\n---\n### ${ts}\n`;
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, content + header);
  }

  private async insertAudioPlaceholder(filename: string) {
    if (!this.currentNotePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const placeholder = `🔴 **录音中** — ${ts} 开始 · \`${filename}\`\n`;
    this.pendingPlaceholder = placeholder;
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, content + placeholder);
  }

  private async replacePlaceholderWithEmbed() {
    if (!this.currentNotePath || !this.pendingPlaceholder || !this.recordingPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const folder = this.settings.recordingFolder || 'Recordings';
    const fname = this.recordingPath.replace(/\\/g, '/').split('/').pop()!;
    const embed = `![[${folder}/${fname}]]`;
    const content = await this.app.vault.read(file);
    const replaced = content.replace(this.pendingPlaceholder.trim(), embed);
    await this.app.vault.modify(file, replaced);
    this.pendingPlaceholder = '';
  }

  private appendToNote(text: string) {
    if (!this.currentNotePath || !text) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    this.app.vault.read(file).then((content: string) => {
      this.app.vault.modify(file, content + text);
    });
  }

  // ---- Audio capture ----

  async startMic(view: VoiceSoloView) {
    this.addLog('[mic] getUserMedia...');
    const audioConstraints: any = {
      channelCount: 1, echoCancellation: true, noiseSuppression: true,
    };
    if (this.settings.audioDevice) {
      audioConstraints.deviceId = { exact: this.settings.audioDevice };
    }
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });
    this.addLog('[mic] got stream');

    this.audioCtx = new AudioContext();
    this.addLog(`[mic] AudioContext sampleRate=${this.audioCtx.sampleRate}`);

    const fs: any = (window as any).require?.('fs') || require('fs');
    const workletCode = fs.readFileSync(this.pluginDir + '/mic_worklet.js', 'utf-8');
    const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
    await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(workletBlob));
    this.addLog('[mic] worklet loaded');

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'mic-processor');
    this.workletNode.port.onmessage = async (e) => {
      // Save copy for FLAC (before transferring to VAD)
      if (this.flacEncoder) {
        const flacFs: any = (window as any).require?.('fs') || require('fs');
        await this.flacEncoder.processChunk(new Float32Array(e.data), flacFs);
      }
      // Forward to VAD (zero-copy transfer)
      if (this.vadWorker) {
        this.vadWorker.postMessage({ type: 'chunk', data: e.data }, [e.data]);
      }
    };

    const source = this.audioCtx.createMediaStreamSource(this.micStream);
    source.connect(this.workletNode);
    this.addLog('[mic] connected');
  }

  // ---- Settings ----

  async loadSettings() {
    const saved = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Migrate legacy autoSaveToNote → outputToNote
    if ((saved as any).autoSaveToNote && !saved.outputToNote) {
      this.settings.outputToNote = true;
    }
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
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Voice Solo Settings' });

    // ═══ 模型选择 ═══
    this.sectionHeading(containerEl, '模型选择');

    new Setting(containerEl)
      .setName('推理精度')
      .setDesc('标准：ONNX WASM CPU 本地推理，当前可用 | 高性能：ONNX WebGPU 推理（计划支持）')
      .addDropdown(d => {
        d.addOption('standard', '标准 (ONNX WASM)');
        d.addOption('performance', '高性能 (ONNX WebGPU)');
        d.setValue(s.asrModelTier);
        d.onChange(async (v) => {
          this.plugin.settings.asrModelTier = v as 'standard' | 'performance';
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('模型目录')
      .setDesc('FunASR 模型的本地根目录，含 vad/, asr/, punc/ 子目录。留空则使用插件内置 models.json 下载到 lib/models/')
      .addText(text => text
        .setPlaceholder('留空使用默认下载目录')
        .setValue(s.modelBasePath)
        .onChange(async (v) => {
          this.plugin.settings.modelBasePath = v;
          await this.plugin.saveSettings();
        }));

    // ═══ 输出设置 ═══
    this.sectionHeading(containerEl, '输出设置');

    let outputFolderText: any;
    let recordingFolderText: any;

    new Setting(containerEl)
      .setName('输出至文档')
      .setDesc('开启后将转录文本写入笔记文件，关闭后仅在面板中显示')
      .addToggle(toggle => {
        toggle.setValue(s.outputToNote);
        toggle.onChange(async (v) => {
          this.plugin.settings.outputToNote = v;
          await this.plugin.saveSettings();
          this.setDependentDisabled(outputFolderText, !v);
        });
      });

    const outputFolderSetting = new Setting(containerEl)
      .setName('转录文本路径')
      .setDesc('转录文本的输出路径（相对于保险库根目录）')
      .setClass('voice-solo-setting-indent')
      .addText(text => {
        outputFolderText = text;
        text.setPlaceholder('Transcriptions');
        text.setValue(s.outputFolder);
        text.onChange(async (v) => {
          this.plugin.settings.outputFolder = v;
          await this.plugin.saveSettings();
        });
      });
    this.setDependentDisabled(outputFolderText, !s.outputToNote);

    new Setting(containerEl)
      .setName('保存录音文件')
      .setDesc('录音结束后保存音频文件')
      .addToggle(toggle => {
        toggle.setValue(s.saveAudio);
        toggle.onChange(async (v) => {
          this.plugin.settings.saveAudio = v;
          await this.plugin.saveSettings();
          this.setDependentDisabled(recordingFolderText, !v);
        });
      });

    const recordingFolderSetting = new Setting(containerEl)
      .setName('录音文件路径')
      .setDesc('录音文件的输出路径（相对于保险库根目录）')
      .setClass('voice-solo-setting-indent')
      .addText(text => {
        recordingFolderText = text;
        text.setPlaceholder('Recordings');
        text.setValue(s.recordingFolder);
        text.onChange(async (v) => {
          this.plugin.settings.recordingFolder = v;
          await this.plugin.saveSettings();
        });
      });
    this.setDependentDisabled(recordingFolderText, !s.saveAudio);

    new Setting(containerEl)
      .setName('停止时进行二次识别')
      .setDesc('录音结束后使用更高精度模型重新识别整段音频，输出完整文本')
      .addToggle(toggle => {
        toggle.setValue(s.postProcessEnabled);
        toggle.onChange(async (v) => {
          this.plugin.settings.postProcessEnabled = v;
          await this.plugin.saveSettings();
        });
      });

    // ═══ 音频设置 ═══
    this.sectionHeading(containerEl, '音频设置');

    let audioSelectEl: HTMLSelectElement;

    const audioSetting = new Setting(containerEl)
      .setName('麦克风设备')
      .setDesc('选择录音使用的麦克风。点击刷新获取设备列表（需授权麦克风权限）')
      .addDropdown(d => {
        d.addOption('', '默认麦克风');
        if (s.audioDevice) d.addOption(s.audioDevice, s.audioDevice);
        d.setValue(s.audioDevice);
        audioSelectEl = d.selectEl;
        d.onChange(async (v) => {
          this.plugin.settings.audioDevice = v;
          await this.plugin.saveSettings();
        });
      });

    audioSetting.addExtraButton(btn => {
      btn.setIcon('refresh-cw');
      btn.setTooltip('刷新设备列表');
      btn.onClick(async () => {
        await this.refreshAudioDevices(audioSelectEl);
      });
    });

    // 首次显示时自动刷新设备列表
    this.refreshAudioDevices(audioSelectEl);

    // ═══ 高级 ═══
    this.sectionHeading(containerEl, '高级');

    new Setting(containerEl)
      .setName('热词替换表')
      .setDesc('JSON 格式: {"误识别词": "正确词", ...}')
      .addTextArea(text => text
        .setPlaceholder('{"电缆": "靛蓝", "云朵": "吲哚"}')
        .setValue(JSON.stringify(s.hotWords, null, 2))
        .onChange(async (v) => {
          try {
            this.plugin.settings.hotWords = JSON.parse(v || '{}');
            await this.plugin.saveSettings();
          } catch { /* invalid JSON, ignore */ }
        }));
  }

  private sectionHeading(el: HTMLElement, title: string) {
    const h = el.createDiv({ cls: 'voice-solo-settings-heading' });
    h.setText(title);
  }

  /** Disable the text input AND the setting row label/desc. */
  private setDependentDisabled(textComp: any, disabled: boolean) {
    if (!textComp) return;
    textComp.inputEl.disabled = disabled;
    // Gray out the setting row's label area
    const row = textComp.inputEl.closest('.setting-item');
    if (row) {
      const info = row.querySelector('.setting-item-info') as HTMLElement;
      if (info) info.style.opacity = disabled ? '0.4' : '1';
      (row as HTMLElement).classList.toggle('voice-solo-setting-disabled', disabled);
    }
  }

  private async refreshAudioDevices(selectEl: HTMLSelectElement) {
    // Request mic permission first so labels become available
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch {
      // User denied or no mic — still try to enumerate (may get empty labels)
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const currentVal = selectEl.value;
      selectEl.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '默认麦克风';
      selectEl.appendChild(opt);
      for (const d of inputs) {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `设备 ${d.deviceId.slice(0, 8)}...`;
        if (d.deviceId === currentVal) o.selected = true;
        selectEl.appendChild(o);
      }
    } catch (e) {
      console.warn('[VoiceSolo] Cannot enumerate audio devices:', e);
    }
  }
}
