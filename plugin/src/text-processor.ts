// TextProcessor — post-ASR text splitting (aligned with Python text_processor.py)
//
// Runs on main thread. Receives full ASR text segments from Worker,
// splits into displayable short sentences based on punctuation + length.

interface TextProcConfig {
  maxLineChars: number;       // max chars before forced split (default 30)
  silenceThresholdMs: number; // silence gap to trigger newline (unused in browser mode)
  dedupWindowMs: number;      // dedup window (default 3000ms)
}

interface TickResult {
  text: string | null;
}

const PUNCTUATION = '。！？.!?';
const SPLIT_PUNCTUATION = '，。！？.!?、';

export class TextProcessor {
  private buffer = '';
  private sentPos = 0;
  private needsSplit = false;
  private prevTail = '';
  private history: Array<{ text: string; time: number }> = [];
  private config: TextProcConfig;

  constructor(config: Partial<TextProcConfig> = {}) {
    this.config = {
      maxLineChars: config.maxLineChars || 30,
      silenceThresholdMs: config.silenceThresholdMs || 800,
      dedupWindowMs: config.dedupWindowMs || 3000,
    };
  }

  /** Feed a new recognized text segment. Returns 0-N split sentences. */
  tick(text: string, currentTime: number): TickResult[] {
    if (!text) return [];

    this.buffer += text;
    const results: TickResult[] = [];

    // Check duplicate
    if (this.isDup(this.buffer, currentTime)) {
      return [];
    }

    const isSentenceEnd = PUNCTUATION.includes(this.buffer.slice(-1));
    const fullLen = this.buffer.length;

    // Sentence end → emit
    if (isSentenceEnd) {
      const unsent = this.buffer.slice(this.sentPos);
      this.record(this.buffer, currentTime);
      this.buffer = '';
      this.needsSplit = false;
      this.sentPos = 0;
      results.push({ text: unsent });
    } else if (fullLen >= this.config.maxLineChars) {
      // Mark for split on next split punctuation or 2x overflow
      this.needsSplit = true;
    }

    // Needs split + split punctuation available
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
        // Force split at maxLineChars * 2
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
  flush(): TickResult[] {
    if (!this.buffer) return [];
    const text = this.buffer;
    this.buffer = '';
    this.sentPos = 0;
    this.needsSplit = false;
    return [{ text }];
  }

  reset() {
    this.buffer = '';
    this.sentPos = 0;
    this.needsSplit = false;
    this.history = [];
  }

  private findSplitPoint(buf: string, from: number): number {
    for (let i = buf.length - 1; i >= from; i--) {
      if (SPLIT_PUNCTUATION.includes(buf[i])) return i;
    }
    return -1;
  }

  private isDup(text: string, time: number): boolean {
    const tail = text.slice(-10);
    if (tail === this.prevTail) return true;
    // Check recent history
    const cutoff = time - this.config.dedupWindowMs;
    this.history = this.history.filter(h => h.time >= cutoff);
    for (const h of this.history) {
      if (h.text === text) return true;
    }
    return false;
  }

  private record(text: string, time: number) {
    this.prevTail = text.slice(-10);
    this.history.push({ text, time });
    if (this.history.length > 20) this.history.shift();
  }
}
