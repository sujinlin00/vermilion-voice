import { Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { VermilionVoiceView, VIEW_TYPE } from './view';
import type { VermilionVoiceSettings, AppConfig, VadConfig } from './types';
import type { VadToMain, AsrToMain } from './types';
import { TextProcessor } from './text-processor';
import { FlacEncoder } from './flac-encoder';
import { AudioCaptureManager } from './audio-capture';
import { t, setLanguage } from './i18n';

// Debug logging — set to false for release builds
const DEBUG = true;
const debugLog = (...args: any[]) => { if (DEBUG) console.log('[VV]', ...args); };
const debugErr = (...args: any[]) => { if (DEBUG) console.error('[VV]', ...args); };

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

function computeMD5(filePath: string, fs: any): string {
  const crypto = require('crypto');
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** Download a single file with byte-level progress via https.get. */
function downloadWithProgress(
  url: string,
  dest: string,
  fs: any,
  onChunk: (bytesReceived: number, totalBytes: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const dir = dest.replace(/[/\\][^/\\]*$/, '');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const https = require('https');
    https.get(url, { headers: { 'User-Agent': 'VermilionVoice/0.1.0' } }, (res: any) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadWithProgress(res.headers.location, dest, fs, onChunk).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const total = Number(res.headers['content-length'] || 0);
      const chunks: Buffer[] = [];
      let received = 0;

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        onChunk(received, total);
      });

      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(dest, buf);
        // Compute and save MD5
        try {
          const md5 = computeMD5(dest, fs);
          fs.writeFileSync(dest + '.md5', md5, 'utf-8');
        } catch { /* ignore */ }
        resolve();
      });

      res.on('error', (e: any) => {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
        reject(e);
      });
    }).on('error', (e: any) => reject(e));
  });
}

/** Check if a model file exists and has valid MD5. */
function isModelValid(dest: string, fs: any): boolean {
  if (!fs.existsSync(dest)) return false;
  if (fs.statSync(dest).size === 0) return false;
  const md5File = dest + '.md5';
  if (!fs.existsSync(md5File)) return true; // no md5 recorded yet, trust the file
  try {
    const expected = fs.readFileSync(md5File, 'utf-8').trim();
    const actual = computeMD5(dest, fs);
    return expected === actual;
  } catch { return false; }
}

type ModelProgress = Record<string, number>; // key → 0~100, or bytes if < 0

/** Format combined progress string: "vad:50%|asr: 1%|punc: 0%" */
function formatProgress(progress: ModelProgress): string {
  return Object.entries(progress)
    .map(([k, v]) => {
      if (v < 0) return `${k}:${(-v / 1024 / 1024).toFixed(1)}MB`;
      return `${k}:${String(v).padStart(3)}%`;
    })
    .join('|');
}

/**
 * Download all models in parallel with per-model progress tracking.
 * Downloads each model's files sequentially, but models run concurrently.
 * Reports combined progress via onProgress callback.
 */
async function ensureModels(
  modelsDir: string,
  modelsJsonPath: string,
  addLog: (msg: string) => void,
  onProgress: (status: string) => void,
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

  // Shared progress state (updated atomically by each model's download)
  const progress: ModelProgress = { vad: 0, asr: 0, punc: 0 };

  // Check which files need downloading
  const tasks: Array<{ key: string; entry: ModelEntry; parent: string; files: Array<{ url: string; dest: string }> }> = [];
  let anyDownload = false;

  for (const { key, entry, parent } of entries) {
    const modelDir = `${modelsDir}/${parent}/${entry.name}`;
    try { fs.mkdirSync(modelDir, { recursive: true }); } catch {}
    const filesToDownload: Array<{ url: string; dest: string }> = [];

    for (const f of entry.files) {
      const dest = `${modelDir}/${f}`;
      if (!isModelValid(dest, fs)) {
        filesToDownload.push({ url: `${entry.url}/${f}`, dest });
        anyDownload = true;
      }
    }

    if (filesToDownload.length > 0) {
      tasks.push({ key, entry, parent, files: filesToDownload });
    } else {
      progress[key] = 100; // already valid
    }
  }

  if (!anyDownload) return modelsDir;

  // Report initial state
  onProgress(formatProgress(progress));
  addLog(`Downloading models: ${formatProgress(progress)}`);

  // Download each model group in parallel
  await Promise.all(tasks.map(async ({ key, files }) => {
    let downloadedBytes = 0;

    // Download files sequentially within each model group
    for (const { url, dest } of files) {
      const fname = dest.replace(/.*\//, '');
      addLog(`Downloading ${key}/${fname}...`);

      await downloadWithProgress(url, dest, fs, (received, total) => {
        if (total > 0) {
          // Known total: show percentage
          progress[key] = Math.min(Math.round(((downloadedBytes + received) / total) * 100), 99);
        } else {
          // Unknown total: show negative bytes (formatProgress converts to MB)
          progress[key] = -(downloadedBytes + received);
        }
        onProgress(formatProgress(progress));
      });

      downloadedBytes += fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      addLog(`${key}/${fname}: ${(fs.statSync(dest).size / 1024).toFixed(0)}KB`);
    }

    progress[key] = 100;
    onProgress(formatProgress(progress));
  }));

  addLog('All models ready');
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

const DEFAULT_SETTINGS: VermilionVoiceSettings = {
  language: 'zh',
  modelBasePath: '',
  asrModelTier: 'standard',
  outputToNote: false,
  outputFolder: '03.语音转写',
  saveAudio: false,
  recordingFolder: '04.录音文件',
  organizeByMonth: true,
  postProcessEnabled: false,
  audioDevice: '',
  vadSensitivity: 'medium',
  outputInterval: 3000,
  silenceThreshold: 2.5,
  maxLineChars: 90,
  maxSpeechDuration: 4.0,

};

export default class VermilionVoicePlugin extends Plugin {
  settings: VermilionVoiceSettings;
  private vadWorker: Worker | null = null;
  private asrWorker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  audioCaptureMgr: AudioCaptureManager | null = null;
  private pluginDir: string = '';
  private textProc: TextProcessor = new TextProcessor();
  appConfig: AppConfig | null = null;
  private vadCfg: VadConfig | null = null;
  private vadReady = false;
  private asrReady = false;
  private asrBusy = false;
  private logBuf: string[] = [];
  private logTimer = 0;
  private pendingSegments: Array<{ audio: Float32Array; startMs: number; endMs: number; reason?: string }> = [];
  private flacEncoder: FlacEncoder | null = null;
  private currentNotePath: string = '';
  private recordingPath: string = '';
  private pendingPlaceholder: string = '';

  private tickTimer: number = 0;
  private workerCleanupTimer: number = 0;
  private puncTimer: number = 0;
  private puncPending: { text: string; startMs: number; endMs: number; view: VermilionVoiceView } | null = null;
  private puncFromCarry: boolean = false;

  private addLog(msg: string) {
    const ts = Date.now();
    const entry = `[${ts}] ${msg}`;
    this.logBuf.push(entry);
    debugLog(msg);
    if (this.logBuf.length > 500) this.logBuf = this.logBuf.slice(-300);
  }

  private flushLog(reason: string) {
    if (this.logBuf.length === 0) return;
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      const header = `\n\n## ${ts} — ${reason}\n\n`;
      const body = this.logBuf.map(l => `- ${l}`).join('\n');
      const file = this.pluginDir.replace(/\\/g, '/') + '/debug-log.md';
      const fs: any = (window as any).require?.('fs') || require('fs');
      // Append mode: create file with header if it doesn't exist, otherwise append
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `# Vermilion Voice Debug Log\n${header}${body}`, 'utf-8');
      } else {
        fs.appendFileSync(file, `${header}${body}`, 'utf-8');
      }
      this.logBuf = [];
    } catch { /* can't write, ignore */ }
  }

  async onload() {
    const vaultRoot = (this.app.vault.adapter as any).basePath as string;
    this.pluginDir = vaultRoot + '/.obsidian/plugins/vermilion-voice';

    await this.loadSettings();
    setLanguage(this.settings.language);
    this.loadAppConfig();

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new VermilionVoiceView(leaf);
      view.onStart = () => this.startRecognition(view);
      view.onStop = () => this.stopRecognition();
      return view;
    });

    this.addRibbonIcon('mic', 'Vermilion Voice', () => this.toggleView());
    this.addSettingTab(new VermilionVoiceSettingTab(this.app, this));

    this.addCommand({
      id: 'vermilion-voice-open',
      name: 'Open voice recognition panel',
      callback: () => this.toggleView(),
    });
  }

  onunload() {
    this.stopRecognition();
    if (this.workerCleanupTimer) { clearTimeout(this.workerCleanupTimer); this.workerCleanupTimer = 0; }
    // Terminate workers on plugin unload
    if (this.vadWorker) { this.vadWorker.terminate(); this.vadWorker = null; }
    if (this.asrWorker) { this.asrWorker.terminate(); this.asrWorker = null; }
    this.vadReady = false;
    this.asrReady = false;
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

  async startRecognition(view: VermilionVoiceView) {
    debugLog('startRecognition called');
    try {
      this.addLog('START requested');
      const fs: any = (window as any).require?.('fs') || require('fs');

      // Init FLAC recording (streaming)
      if (this.settings.saveAudio) {
        this.addLog('[step] init FLAC encoder...');
        const vaultRoot = (this.app.vault.adapter as any).basePath as string;
        const now = new Date();
        const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const dir = vaultRoot + '/' + this.settings.recordingFolder;
        const targetDir = this.settings.organizeByMonth ? `${dir}/${ym}` : dir;
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
        const ts = `${ym}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        this.recordingPath = targetDir + '/录音_' + ts + '.flac';
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
        const v = lv.length > 0 ? lv[0].view as VermilionVoiceView : null;
        for (const r of results) {
          if (r.text) {
            if (v) v.addSegment(r.text, 0, 0);
            if (this.settings.outputToNote) this.appendToNote(r.text);
          }
        }
      }, this.settings.outputInterval);

      // Cancel pending worker cleanup timer
      if (this.workerCleanupTimer) { clearTimeout(this.workerCleanupTimer); this.workerCleanupTimer = 0; }

      // Reuse existing workers if still alive, otherwise create new ones
      if (this.vadReady && this.asrReady && this.vadWorker && this.asrWorker) {
        this.addLog('[step] reusing existing workers');
        view.setStatus('ready', t('status.ready'));
        this.vadWorker.postMessage({ type: 'start' });
        this.addLog('START sent to VAD (reuse)');
      } else {
        this.addLog('[step] creating workers...');
        await this.createWorkers(view);
      }
      this.addLog('[step] starting mic...');
      await this.startMic(view);
      this.addLog('[step] startMic done');
      this.flushLog('startRecognition-ok');
    } catch (e: any) {
      this.addLog(`ERROR: ${e.message}\n${e.stack}`);
      debugErr('startRecognition failed:', e);
      view.setStatus('error', e.message || t('status.startupFailed'));
      this.flushLog('startRecognition-error');
      this.stopRecognition();
    }
  }

  async stopRecognition() {
    this.addLog('STOP requested');
    // Stop tick timer
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = 0; }
    // Flush text processor (sets needsSessionNewline for next session)
    const parts = this.textProc.flush(Date.now());
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves.length > 0 ? leaves[0].view as VermilionVoiceView : null;
    for (const p of parts) {
      if (p.text) {
        if (view) view.addSegment(p.text, 0, 0);
        if (this.settings.outputToNote) this.appendToNote(p.text);
      }
    }
    if (this.puncTimer) { clearTimeout(this.puncTimer); this.puncTimer = 0; }
    this.puncPending = null;
    this.pendingSegments = [];

    // Stop audio capture
    if (this.audioCaptureMgr) {
      this.audioCaptureMgr.stop();
      this.audioCaptureMgr = null;
    }
    // Legacy fields (may still be set by old code paths)
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

    // Stop VAD worker (resets state, but keeps worker alive for reuse)
    if (this.vadWorker) {
      this.vadWorker.postMessage({ type: 'stop' });
    }

    // Wait for ASR queue to drain (segments during drain go to current session)
    if (this.asrWorker) {
      await this.waitForAsrDrain();
    }

    // Reset TextProcessor AFTER drain — preserves needsSessionNewline for next session
    this.textProc.reset();

    // Don't terminate workers — keep them alive for next start
    // Release after 5 minutes if not restarted
    if (this.workerCleanupTimer) { clearTimeout(this.workerCleanupTimer); }
    this.workerCleanupTimer = window.setTimeout(() => {
      this.addLog('[cleanup] 5min idle, releasing workers');
      if (this.vadWorker) { this.vadWorker.terminate(); this.vadWorker = null; }
      if (this.asrWorker) { this.asrWorker.terminate(); this.asrWorker = null; }
      this.vadReady = false;
      this.asrReady = false;
      this.workerCleanupTimer = 0;
    }, 5 * 60 * 1000);

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

  async createWorkers(view: VermilionVoiceView) {
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
        (status) => {
          view.setStatus('loading', `模型下载 ${status}`);
        },
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
      debugErr('VAD Worker error:', e.message);
      view.setStatus('error', 'VAD Worker: ' + e.message);
    };

    this.vadWorker.onmessage = (e: MessageEvent<VadToMain>) => {
      this.handleVadMessage(e.data, view);
    };

    // Init VAD worker (slice copies — each worker gets its own ArrayBuffer)
    const vadBuf = vadModelBuf.slice(0);
    debugLog(`VAD postMessage: modelBuf=${vadBuf.byteLength} wasm=${simdWasm.byteLength}`);
    debugLog(`VAD config: sensitivity=${this.settings.vadSensitivity} vadCfg=`, JSON.stringify(this.vadCfg));
    this.vadWorker.postMessage({
      type: 'init',
      config: {
        vadModelBuffer: vadBuf,
        vadCmvnText: vadCmvn,
        simdWasm: simdWasm.slice(0),
        sensitivity: this.settings.vadSensitivity,
        vadCfg: this.vadCfg!,
      },
    });

    // Create Worker B (ASR + PUNC) from Blob URL
    this.addLog('[workers] creating ASR worker...');
    const asrCode = fs.readFileSync(this.pluginDir + '/worker-asr.js', 'utf-8');
    const asrBlob = new Blob([asrCode], { type: 'application/javascript' });
    this.asrWorker = new Worker(URL.createObjectURL(asrBlob), { type: 'module' });

    this.asrWorker.onerror = (e) => {
      debugErr('ASR Worker error:', e.message);
      view.setStatus('error', 'ASR Worker: ' + e.message);
    };

    this.asrWorker.onmessage = (e: MessageEvent<AsrToMain>) => {
      this.handleAsrMessage(e.data, view);
    };

    // Init ASR worker
    const asrBuf = asrModelBuf.slice(0);
    const puncBuf = puncModelBuf.slice(0);
    debugLog(`ASR postMessage: asrBuf=${asrBuf.byteLength} puncBuf=${puncBuf.byteLength} wasm=${simdWasm.byteLength}`);
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
    this.addLog('[workers] both workers ready');
    this.flushLog('createWorkers-ok');
  }

  // ---- Message routing ----

  handleVadMessage(msg: VadToMain, view: VermilionVoiceView) {
    if (msg.type !== 'progress') this.addLog(`VAD → ${msg.type}${'status' in msg ? ':' + msg.status : ''}`);
    switch (msg.type) {
      case 'ready':
        this.vadReady = true;
        this.addLog(`VAD ready, asrReady=${this.asrReady}`);
        if (this.asrReady) {
          view.setStatus('ready', t('status.ready'));
          this.vadWorker!.postMessage({ type: 'start' });
          this.addLog('START sent to VAD');
        }
        break;
      case 'status':
        if (msg.status === 'listening') view.setStatus('recording', t('status.listening'));
        else if (msg.status === 'speech') view.setStatus('recording', t('status.speaking'));
        break;
      case 'segment':
        this.addLog(`VAD segment ${(msg.startMs/1000).toFixed(1)}s-${(msg.endMs/1000).toFixed(1)}s`);
        this.dispatchSegment(msg.audio, msg.startMs, msg.endMs, msg.reason);
        break;
      case 'error':
        this.addLog(`VAD ERROR: ${msg.message}`);
        view.setStatus('error', msg.message);
        this.flushLog('VAD-error');
        break;
      case 'progress':
        view.setStatus('loading', `${msg.phase.toUpperCase()}: ${msg.pct}%`);
        break;
    }
  }

  handleAsrMessage(msg: AsrToMain, view: VermilionVoiceView) {
    if (msg.type !== 'progress') this.addLog(`ASR → ${msg.type}${'status' in msg ? ':' + msg.status : ''}`);
    switch (msg.type) {
      case 'ready':
        this.asrReady = true;
        this.addLog(`ASR ready, vadReady=${this.vadReady}`);
        if (this.vadReady) {
          view.setStatus('ready', t('status.ready'));
          this.vadWorker!.postMessage({ type: 'start' });
          this.addLog('START sent to VAD');
        }
        break;
      case 'status':
        if (msg.status === 'asr') view.setStatus('processing', t('status.recording'));
        else if (msg.status === 'punc') view.setStatus('processing', t('status.punc'));
        break;
      case 'result': {
        this.addLog(`ASR result: "${msg.text.slice(0, 40)}..." reason=${msg.reason || 'silence'}`);
        this.handleAsrResult(msg.text, msg.startMs, msg.endMs, msg.reason, view, msg.perf);
        break;
      }
      case 'punc_result': {
        this.addLog(`ASR punc_result: "${msg.text.slice(0, 40)}..."`);
        if (this.puncTimer) { clearTimeout(this.puncTimer); this.puncTimer = 0; }
        this.puncPending = null;
        const fromCarry = this.puncFromCarry;
        this.puncFromCarry = false;
        this.handleAsrResult(msg.text, msg.startMs, msg.endMs, undefined, view, undefined, fromCarry);
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
        view.setStatus('loading', `${msg.phase.toUpperCase()}: ${msg.pct}%`);
        break;
    }
  }

  dispatchSegment(audioBuf: ArrayBuffer, startMs: number, endMs: number, reason: 'silence' | 'forced' = 'silence') {
    if (this.asrBusy) {
      this.addLog(`DISPATCH queue (busy, pending=${this.pendingSegments.length + 1})`);
      if (this.pendingSegments.length < 5) {
        this.pendingSegments.push({
          audio: new Float32Array(audioBuf),
          startMs,
          endMs,
          reason,
        });
      }
      return;
    }
    const skipPunc = !!this.textProc.getCarryBuffer();
    this.addLog(`DISPATCH send to ASR (reason=${reason}, skipPunc=${skipPunc})`);
    this.asrBusy = true;
    const audio = new Float32Array(audioBuf);
    this.asrWorker!.postMessage(
      { type: 'segment', audio: audio.buffer, startMs, endMs, reason, skipPunc },
      [audio.buffer],
    );
  }

  /**
   * Unified ASR result handling:
   * 1. If carry exists → combine carry + text, send to punc, check for re-split
   * 2. If forced → split at second-to-last punctuation, store carry
   * 3. Otherwise → output directly
   */
  private handleAsrResult(
    text: string, startMs: number, endMs: number,
    reason: string | undefined, view: VermilionVoiceView, perf?: any,
    isCarryCombined: boolean = false,
  ) {
    const carry = this.textProc.getCarryBuffer();
    this.addLog(`[handleAsrResult] text="${text.slice(0,30)}..." reason=${reason} carry="${carry.slice(0,20)}" isCarryCombined=${isCarryCombined}`);

    if (carry) {
      // Has carry from previous forced segment: combine and re-punctuate
      const combined = carry + text;
      this.textProc.clearCarryBuffer();
      this.addLog(`[carry] combined: "${combined.slice(0, 40)}..."`);
      // Timeout protection: if punc doesn't respond in 5s, output without punc
      this.puncPending = { text: combined, startMs, endMs, view };
      this.puncTimer = window.setTimeout(() => {
        this.addLog('[carry] punc timeout, outputting without punc');
        this.puncTimer = 0;
        this.puncPending = null;
        this.asrBusy = false;
        this.textProc.forceNewline();
        const parts = this.textProc.tick(combined, startMs, endMs);
        for (const p of parts) {
          if (p.text) {
            view.addSegment(p.text, startMs, endMs);
            if (this.settings.outputToNote) this.appendToNote(p.text);
          }
        }
        this.drainPending();
      }, 5000);
      this.puncFromCarry = true;
      this.asrWorker!.postMessage({ type: 'punc', text: combined, startMs, endMs });
      return;
    }

    // No carry
    if (isCarryCombined) this.textProc.forceNewline();

    if (reason === 'forced' || isCarryCombined) {
      // Forced segment: split at second-to-last punctuation, store carry
      const outputPart = this.textProc.setCarryText(text);
      if (outputPart) {
        const parts = this.textProc.tick(outputPart, startMs, endMs);
        for (const p of parts) {
          if (p.text) {
            view.addSegment(p.text, startMs, endMs, perf);
            if (this.settings.outputToNote) this.appendToNote(p.text);
          }
        }
      }
    } else {
      // Normal segment: output directly, no splitting
      const parts = this.textProc.tick(text, startMs, endMs);
      for (const p of parts) {
        if (p.text) {
          view.addSegment(p.text, startMs, endMs, perf);
          if (this.settings.outputToNote) this.appendToNote(p.text);
        }
      }
    }

    this.asrBusy = false;
    this.drainPending();
  }

  drainPending() {
    if (this.pendingSegments.length === 0) return;
    this.addLog(`DISPATCH drain (pending=${this.pendingSegments.length})`);
    const next = this.pendingSegments.shift()!;
    const skipPunc = !!this.textProc.getCarryBuffer();
    this.asrBusy = true;
    this.asrWorker!.postMessage(
      { type: 'segment', audio: next.audio.buffer, startMs: next.startMs, endMs: next.endMs, reason: next.reason, skipPunc },
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
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const ds = `${ym}-${String(now.getDate()).padStart(2, '0')}`;
    const folder = this.settings.outputFolder || 'Transcriptions';
    const targetDir = this.settings.organizeByMonth ? `${folder}/${ym}` : folder;
    await this.ensureFolder(targetDir);
    this.currentNotePath = `${targetDir}/转写_${ds}.md`;
    try {
      const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
      if (!file) {
        await this.app.vault.create(this.currentNotePath, '');
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
    // Compute vault-relative path from absolute recording path
    const vaultRoot = (this.app.vault.adapter as any).basePath as string;
    const vaultPrefix = vaultRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const relPath = this.recordingPath.replace(/\\/g, '/').replace(vaultPrefix, '');
    const embed = `![[${relPath}]]`;
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

  async startMic(view: VermilionVoiceView) {
    const fs: any = (window as any).require?.('fs') || require('fs');
    const workletCode = fs.readFileSync(this.pluginDir + '/mic_worklet.js', 'utf-8');

    const audioCfg = this.appConfig?.audio_capture;

    // Use AudioCaptureManager for unified mic + system audio handling
    this.audioCaptureMgr = new AudioCaptureManager(
      {
        onData: async (data: Float32Array) => {
          // FLAC recording
          if (this.flacEncoder) {
            const flacFs: any = (window as any).require?.('fs') || require('fs');
            await this.flacEncoder.processChunk(data, flacFs);
          }
          // Forward to VAD (transfer buffer)
          if (this.vadWorker) {
            const buf = data.buffer.slice(0);
            this.vadWorker.postMessage({ type: 'chunk', data: buf }, [buf]);
          }
        },
        onStatus: (status) => {
          this.addLog(`[audio] status: ${status}`);
        },
        onError: (msg) => {
          this.addLog(`[audio] error: ${msg}`);
          new Notice(msg, 5000);
        },
      },
      workletCode,
      audioCfg || { mic_enabled: true, output_enabled: true, output_source: 'system', mix_mode: 'merge' },
    );

    this.addLog('[audio] starting capture...');
    this.audioCtx = await this.audioCaptureMgr.start(this.settings.audioDevice || undefined);
    this.addLog(`[audio] started (sampleRate=${this.audioCtx.sampleRate})`);
  }

  /** Restart audio capture with current config (e.g. after settings change). */
  async restartAudioCapture() {
    if (!this.audioCaptureMgr) return; // not running
    const fs: any = (window as any).require?.('fs') || require('fs');
    const workletCode = fs.readFileSync(this.pluginDir + '/mic_worklet.js', 'utf-8');
    const audioCfg = this.appConfig?.audio_capture;

    // Flush and reset TextProcessor (flush sets needsSessionNewline for next session)
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves.length > 0 ? leaves[0].view as VermilionVoiceView : null;
    const parts = this.textProc.flush(Date.now());
    if (view) {
      for (const p of parts) {
        if (p.text) {
          view.addSegment(p.text, 0, 0);
          if (this.settings.outputToNote) this.appendToNote(p.text);
        }
      }
    }
    this.textProc.reset();

    // Reset VAD state
    if (this.vadWorker) {
      this.vadWorker.postMessage({ type: 'stop' });
      this.vadWorker.postMessage({ type: 'start' });
    }

    // Stop current capture
    this.audioCaptureMgr.stop();
    this.audioCaptureMgr = null;
    this.audioCtx = null;

    // Recreate with new config
    this.audioCaptureMgr = new AudioCaptureManager(
      {
        onData: async (data: Float32Array) => {
          if (this.flacEncoder) {
            const flacFs: any = (window as any).require?.('fs') || require('fs');
            await this.flacEncoder.processChunk(data, flacFs);
          }
          if (this.vadWorker) {
            const buf = data.buffer.slice(0);
            this.vadWorker.postMessage({ type: 'chunk', data: buf }, [buf]);
          }
        },
        onStatus: (status) => { this.addLog(`[audio] status: ${status}`); },
        onError: (msg) => { this.addLog(`[audio] error: ${msg}`); new Notice(msg, 5000); },
      },
      workletCode,
      audioCfg || { mic_enabled: true, output_enabled: true, output_source: 'system', mix_mode: 'merge' },
    );

    this.addLog('[audio] restarting capture...');
    this.audioCtx = await this.audioCaptureMgr.start(this.settings.audioDevice || undefined);
    this.addLog(`[audio] restarted (sampleRate=${this.audioCtx.sampleRate})`);
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

  private loadAppConfig() {
    const fs: any = (globalThis as any).require?.('fs') || require('fs');
    const path: any = (globalThis as any).require?.('path') || require('path');
    const cfgPath = path.join(this.pluginDir, 'settings.json');
    try {
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        this.appConfig = JSON.parse(raw);
        this.vadCfg = this.appConfig?.vad || null;
        this.addLog(`[config] loaded settings.json`);
      }
    } catch (e: any) {
      this.addLog(`[config] failed to load settings.json: ${e.message}`);
    }

    // Sync UI settings into appConfig and persist to keep settings.json in sync
    this.syncUiToAppConfig();
    this.saveAppConfig();
  }

  /** Sync UI settings (this.settings) into appConfig and rebuild TextProcessor/VadConfig. */
  syncUiToAppConfig() {
    if (!this.appConfig) this.appConfig = { text_processor: {} as any, vad: {} as any };
    if (!this.appConfig.text_processor) this.appConfig.text_processor = {} as any;
    if (!this.appConfig.vad) this.appConfig.vad = {} as any;
    if (!this.vadCfg) this.vadCfg = this.appConfig.vad;

    const s = this.settings;
    const tp = this.appConfig.text_processor;
    const vad = this.appConfig.vad;

    // UI → settings.json mapping
    tp.silence_threshold = s.silenceThreshold;
    tp.max_line_chars = s.maxLineChars;
    vad.max_speech_duration = s.maxSpeechDuration;
    // outputInterval: only in UI, not in settings.json

    // Update config in-place — preserves all runtime state (hasOutput, buffer, etc.)
    this.textProc.updateConfig({
      silence_threshold: tp.silence_threshold,
      max_line_chars: tp.max_line_chars,
      dedup_window: tp.dedup_window,
      newline_punctuation: tp.newline_punctuation,
      carry_punctuation: tp.carry_punctuation,
    });
  }

  /** Write current appConfig to settings.json. */
  saveAppConfig() {
    try {
      const fs: any = (globalThis as any).require?.('fs') || require('fs');
      const path: any = (globalThis as any).require?.('path') || require('path');
      const cfgPath = path.join(this.pluginDir, 'settings.json');
      fs.writeFileSync(cfgPath, JSON.stringify(this.appConfig, null, 2), 'utf-8');
    } catch (e: any) {
      this.addLog(`[config] failed to save settings.json: ${e.message}`);
    }
  }
}

// ---- Settings Tab ----

class VermilionVoiceSettingTab extends PluginSettingTab {
  plugin: VermilionVoicePlugin;

  constructor(app: App, plugin: VermilionVoicePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl('h2', { text: t('settings.title') });

    // ═══ Language (first setting) ═══
    new Setting(containerEl)
      .setName(t('settings.language'))
      .setDesc(t('settings.language.desc'))
      .addDropdown(d => {
        d.addOption('zh', '中文');
        d.addOption('en', 'English');
        d.setValue(s.language);
        d.onChange(async (v) => {
          this.plugin.settings.language = v as 'zh' | 'en';
          await this.plugin.saveSettings();
          setLanguage(v as 'zh' | 'en');
          this.display(); // re-render with new language
        });
      });

    // ═══ Model ═══
    this.sectionHeading(containerEl, t('settings.model'));

    new Setting(containerEl)
      .setName(t('settings.inference'))
      .setDesc(t('settings.inference.desc'))
      .addDropdown(d => {
        d.addOption('standard', t('settings.inference.standard'));
        d.addOption('performance', t('settings.inference.performance'));
        d.setValue(s.asrModelTier);
        d.onChange(async (v) => {
          this.plugin.settings.asrModelTier = v as 'standard' | 'performance';
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t('settings.modelDir'))
      .setDesc(t('settings.modelDir.desc'))
      .addText(text => text
        .setPlaceholder(t('settings.modelDir.placeholder'))
        .setValue(s.modelBasePath)
        .onChange(async (v) => {
          this.plugin.settings.modelBasePath = v;
          await this.plugin.saveSettings();
        }));

    // ═══ Output ═══
    this.sectionHeading(containerEl, t('settings.output'));

    let outputFolderText: any;
    let recordingFolderText: any;

    new Setting(containerEl)
      .setName(t('settings.outputToNote'))
      .setDesc(t('settings.outputToNote.desc'))
      .addToggle(toggle => {
        toggle.setValue(s.outputToNote);
        toggle.onChange(async (v) => {
          this.plugin.settings.outputToNote = v;
          await this.plugin.saveSettings();
          this.setDependentDisabled(outputFolderText, !v);
        });
      });

    new Setting(containerEl)
      .setName(t('settings.outputFolder'))
      .setDesc(t('settings.outputFolder.desc'))
      .setClass('vermilion-voice-setting-indent')
      .addText(text => {
        outputFolderText = text;
        text.setPlaceholder('03.语音转写');
        text.setValue(s.outputFolder);
        text.onChange(async (v) => {
          this.plugin.settings.outputFolder = v;
          await this.plugin.saveSettings();
        });
      });
    this.setDependentDisabled(outputFolderText, !s.outputToNote);

    new Setting(containerEl)
      .setName(t('settings.saveAudio'))
      .setDesc(t('settings.saveAudio.desc'))
      .addToggle(toggle => {
        toggle.setValue(s.saveAudio);
        toggle.onChange(async (v) => {
          this.plugin.settings.saveAudio = v;
          await this.plugin.saveSettings();
          this.setDependentDisabled(recordingFolderText, !v);
        });
      });

    new Setting(containerEl)
      .setName(t('settings.recordingFolder'))
      .setDesc(t('settings.recordingFolder.desc'))
      .setClass('vermilion-voice-setting-indent')
      .addText(text => {
        recordingFolderText = text;
        text.setPlaceholder('04.录音文件');
        text.setValue(s.recordingFolder);
        text.onChange(async (v) => {
          this.plugin.settings.recordingFolder = v;
          await this.plugin.saveSettings();
        });
      });
    this.setDependentDisabled(recordingFolderText, !s.saveAudio);

    new Setting(containerEl)
      .setName(t('settings.organizeByMonth'))
      .setDesc(t('settings.organizeByMonth.desc'))
      .setClass('vermilion-voice-setting-indent')
      .addToggle(toggle => {
        toggle.setValue(s.organizeByMonth);
        toggle.onChange(async (v) => {
          this.plugin.settings.organizeByMonth = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t('settings.postProcess'))
      .setDesc(t('settings.postProcess.desc'))
      .addToggle(toggle => {
        toggle.setValue(s.postProcessEnabled);
        toggle.onChange(async (v) => {
          this.plugin.settings.postProcessEnabled = v;
          await this.plugin.saveSettings();
        });
      });

    // ═══ Recognition ═══
    this.sectionHeading(containerEl, t('settings.granularity'));

    new Setting(containerEl)
      .setName(t('settings.vadSensitivity'))
      .setDesc(t('settings.vadSensitivity.desc'))
      .addDropdown(d => {
        d.addOption('high', t('settings.vadSensitivity.high'));
        d.addOption('medium', t('settings.vadSensitivity.medium'));
        d.addOption('low', t('settings.vadSensitivity.low'));
        d.setValue(s.vadSensitivity);
        d.onChange(async (v) => {
          this.plugin.settings.vadSensitivity = v as 'low' | 'medium' | 'high';
          await this.plugin.saveSettings();
          this.plugin.syncUiToAppConfig();
          this.plugin.saveAppConfig();
        });
      });

    new Setting(containerEl)
      .setName(t('settings.outputInterval'))
      .setDesc(t('settings.outputInterval.desc'))
      .addDropdown(d => {
        d.addOption('1000', t('settings.outputInterval.1s'));
        d.addOption('3000', t('settings.outputInterval.3s'));
        d.addOption('5000', t('settings.outputInterval.5s'));
        d.setValue(String(s.outputInterval));
        d.onChange(async (v) => {
          this.plugin.settings.outputInterval = Number(v);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t('settings.silenceThreshold'))
      .setDesc(t('settings.silenceThreshold.desc'))
      .addDropdown(d => {
        d.addOption('1.5', s.language === 'en' ? '1.5s (compact)' : '1.5 秒（紧凑）');
        d.addOption('2.0', '2.0s');
        d.addOption('2.5', s.language === 'en' ? '2.5s (default)' : '2.5 秒（默认）');
        d.addOption('3.0', s.language === 'en' ? '3.0s (loose)' : '3.0 秒（宽松）');
        d.setValue(Number(s.silenceThreshold).toFixed(1));
        d.onChange(async (v) => {
          this.plugin.settings.silenceThreshold = Number(v);
          await this.plugin.saveSettings();
          this.plugin.syncUiToAppConfig();
          this.plugin.saveAppConfig();
        });
      });

    new Setting(containerEl)
      .setName(t('settings.maxLineChars'))
      .setDesc(t('settings.maxLineChars.desc'))
      .addDropdown(d => {
        d.addOption('60', '60');
        d.addOption('90', s.language === 'en' ? '90 (default)' : '90（默认）');
        d.addOption('120', '120');
        d.addOption('0', t('settings.maxLineChars.unlimited'));
        d.setValue(String(s.maxLineChars));
        d.onChange(async (v) => {
          this.plugin.settings.maxLineChars = Number(v);
          await this.plugin.saveSettings();
          this.plugin.syncUiToAppConfig();
          this.plugin.saveAppConfig();
        });
      });

    new Setting(containerEl)
      .setName(t('settings.maxSpeechDuration'))
      .setDesc(t('settings.maxSpeechDuration.desc'))
      .addDropdown(d => {
        d.addOption('3', s.language === 'en' ? '3s (short)' : '3 秒（短段）');
        d.addOption('4', s.language === 'en' ? '4s (default)' : '4 秒（默认）');
        d.addOption('6', s.language === 'en' ? '6s (long)' : '6 秒（长段）');
        d.addOption('8', s.language === 'en' ? '8s (extra long)' : '8 秒（超长段）');
        d.setValue(String(s.maxSpeechDuration));
        d.onChange(async (v) => {
          this.plugin.settings.maxSpeechDuration = Number(v);
          await this.plugin.saveSettings();
          this.plugin.syncUiToAppConfig();
          this.plugin.saveAppConfig();
        });
      });

    // ═══ Audio ═══
    this.sectionHeading(containerEl, t('settings.audio'));

    const audioCfg = this.plugin.appConfig?.audio_capture || { mic_enabled: true, output_enabled: true, output_source: 'system', mix_mode: 'merge' };

    const updateMicEnabled = () => {
      const disabled = audioCfg.output_enabled && !audioCfg.mic_enabled;
      if (audioSelectEl) audioSelectEl.disabled = disabled;
      if (micSettingRow) {
        const info = micSettingRow.querySelector('.setting-item-info') as HTMLElement;
        if (info) info.style.opacity = disabled ? '0.4' : '1';
        micSettingRow.classList.toggle('vermilion-voice-setting-disabled', disabled);
      }
    };

    new Setting(containerEl)
      .setName(t('settings.audioMode'))
      .setDesc(t('settings.audioMode.desc'))
      .addDropdown(d => {
        d.addOption('merge', t('settings.audioMode.merge'));
        d.addOption('mic', t('settings.audioMode.mic'));
        d.addOption('output', t('settings.audioMode.output'));
        const current = audioCfg.mix_mode === 'merge' && audioCfg.output_enabled ? 'merge'
          : audioCfg.output_enabled && !audioCfg.mic_enabled ? 'output'
          : 'mic';
        d.setValue(current);
        d.onChange(async (v) => {
          if (v === 'mic') {
            audioCfg.mic_enabled = true;
            audioCfg.output_enabled = false;
            audioCfg.mix_mode = undefined;
          } else if (v === 'output') {
            audioCfg.mic_enabled = false;
            audioCfg.output_enabled = true;
            audioCfg.mix_mode = undefined;
          } else {
            audioCfg.mic_enabled = true;
            audioCfg.output_enabled = true;
            audioCfg.mix_mode = 'merge';
          }
          this.plugin.syncUiToAppConfig();
          this.plugin.saveAppConfig();
          updateMicEnabled();
          if (this.plugin.audioCaptureMgr) {
            try {
              await this.plugin.restartAudioCapture();
              new Notice(t('notice.audioModeSwitched'));
            } catch (e: any) {
              new Notice(t('notice.audioModeFailed') + ': ' + e.message);
            }
          } else {
            new Notice(t('notice.audioModeNextStart'));
          }
        });
      });

    let audioSelectEl: HTMLSelectElement;
    let micSettingRow: HTMLElement;

    const audioSetting = new Setting(containerEl)
      .setName(t('settings.micDevice'))
      .setDesc(t('settings.micDevice.desc'))
      .addDropdown(d => {
        d.addOption('', t('settings.micDevice.default'));
        if (s.audioDevice) d.addOption(s.audioDevice, s.audioDevice);
        d.setValue(s.audioDevice);
        audioSelectEl = d.selectEl;
        d.onChange(async (v) => {
          this.plugin.settings.audioDevice = v;
          await this.plugin.saveSettings();
        });
      });

    micSettingRow = audioSetting.settingEl;
    updateMicEnabled();

    audioSetting.addExtraButton(btn => {
      btn.setIcon('refresh-cw');
      btn.setTooltip(t('settings.micDevice.refresh'));
      btn.onClick(async () => {
        await this.refreshAudioDevices(audioSelectEl);
      });
    });

    this.refreshAudioDevices(audioSelectEl);

  }

  private sectionHeading(el: HTMLElement, title: string) {
    const h = el.createDiv({ cls: 'vermilion-voice-settings-heading' });
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
      (row as HTMLElement).classList.toggle('vermilion-voice-setting-disabled', disabled);
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
      opt.textContent = t('settings.micDevice.default');
      selectEl.appendChild(opt);
      for (const d of inputs) {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `设备 ${d.deviceId.slice(0, 8)}...`;
        if (d.deviceId === currentVal) o.selected = true;
        selectEl.appendChild(o);
      }
    } catch (e) {
      debugLog('Cannot enumerate audio devices:', e);
    }
  }
}
