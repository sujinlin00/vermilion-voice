import { ItemView, WorkspaceLeaf } from 'obsidian';

export const VIEW_TYPE = 'vermilion-voice-view';

export class VermilionVoiceView extends ItemView {
  private isRunning = false;
  private statusEl: HTMLElement;
  private outputEl: HTMLElement;
  private bufferEl: HTMLElement;
  private segCountEl: HTMLElement;
  private btnStart: HTMLButtonElement;
  private btnStop: HTMLButtonElement;
  private btnClear: HTMLButtonElement;
  private segCount = 0;

  // Callbacks set by main plugin
  onStart: (() => Promise<void>) | null = null;
  onStop: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Vermilion Voice';
  }

  getIcon(): string {
    return 'mic';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('vermilion-voice-container');

    // Header
    const header = container.createEl('div', { cls: 'vermilion-voice-header' });
    header.createEl('span', { text: 'Vermilion Voice', cls: 'vermilion-voice-title' });

    this.statusEl = header.createEl('span', {
      text: '就绪',
      cls: 'vermilion-voice-status vermilion-voice-idle',
    });

    // Controls
    const controls = container.createEl('div', { cls: 'vermilion-voice-controls' });
    this.btnStart = controls.createEl('button', {
      text: '开始识别',
      cls: 'vermilion-voice-btn vermilion-voice-btn-start',
    });
    this.btnStop = controls.createEl('button', {
      text: '停止',
      cls: 'vermilion-voice-btn vermilion-voice-btn-stop',
    });
    this.btnStop.disabled = true;

    this.btnClear = controls.createEl('button', {
      text: '清屏',
      cls: 'vermilion-voice-btn vermilion-voice-btn-clear',
    });

    this.btnStart.addEventListener('click', async () => {
      if (this.onStart) {
        this.btnStart.disabled = true;
        this.btnClear.disabled = true;
        this.setStatus('loading', '请求麦克风...');
        try {
          await this.onStart();
          this.isRunning = true;
          this.btnStop.disabled = false;
          this.setStatus('recording', '识别中...');
        } catch (e: any) {
          this.setStatus('error', e.message);
          this.btnStart.disabled = false;
          this.btnClear.disabled = false;
        }
      }
    });

    this.btnStop.addEventListener('click', () => {
      this.isRunning = false;
      this.btnStart.disabled = false;
      this.btnStop.disabled = true;
      this.btnClear.disabled = false;
      this.setStatus('idle', '已停止');
      if (this.onStop) this.onStop();
    });

    this.btnClear.addEventListener('click', () => {
      this.clear();
    });

    // Stats bar
    const stats = container.createEl('div', { cls: 'vermilion-voice-stats' });
    this.bufferEl = stats.createEl('span', { text: '缓冲: 0s', cls: 'vermilion-voice-stat' });
    this.segCountEl = stats.createEl('span', { text: '段数: 0', cls: 'vermilion-voice-stat' });

    // Output
    this.outputEl = container.createEl('div', { cls: 'vermilion-voice-output' });
    this.outputEl.createEl('div', {
      text: '加载模型后点击"开始识别"开始实时语音识别',
      cls: 'vermilion-voice-placeholder',
    });
  }

  async onClose() {
    if (this.isRunning && this.onStop) this.onStop();
  }

  setStatus(cls: string, text: string) {
    this.statusEl.className = 'vermilion-voice-status vermilion-voice-' + cls;
    this.statusEl.textContent = text;
  }

  setBuffer(seconds: number) {
    this.bufferEl.textContent = `缓冲: ${seconds.toFixed(1)}s`;
  }

  addSegment(text: string, startMs: number, endMs: number, perf?: any) {
    this.segCount++;
    this.segCountEl.textContent = `段数: ${this.segCount}`;

    const ph = this.outputEl.querySelector('.vermilion-voice-placeholder');
    if (ph) ph.remove();

    const seg = this.outputEl.createEl('div', { cls: 'vermilion-voice-segment' });

    let timeStr = `${(startMs / 1000).toFixed(1)}s — ${(endMs / 1000).toFixed(1)}s`;
    if (perf) {
      timeStr += ` | VAD ${perf.vadMs}ms | FB ${perf.asrFbankMs}ms | ASR ${perf.asrInferMs}ms | DEC ${perf.asrDecodeMs}ms | PUNC ${perf.puncMs}ms | 堆 ${perf.heapMB}MB`;
    }
    seg.createEl('div', { text: timeStr, cls: 'vermilion-voice-seg-time' });
    seg.createEl('div', { text, cls: 'vermilion-voice-seg-text' });

    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  clear() {
    this.outputEl.empty();
    this.outputEl.createEl('div', {
      text: '点击"开始识别"开始实时语音识别',
      cls: 'vermilion-voice-placeholder',
    });
    this.segCount = 0;
    this.segCountEl.textContent = '段数: 0';
    this.bufferEl.textContent = '缓冲: 0s';
  }
}
