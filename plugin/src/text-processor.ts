// TextProcessor — post-ASR text splitting with formatting
//
// Ported from voice-transcribe/processors/text_processor.py
// Output format matches Python _build_output(): [HH:MM:SS] text
//
// Features:
// - Silence-based paragraph breaks (≥2s gap)
// - Length-based line breaks (≥60 chars + punctuation)
// - Cross-segment overlap dedup (dedup_overlap)
// - English abbreviation space fixing (p p t → ppt)
// - Character repeat collapsing (皮皮皮 → 皮皮)
// - Short noise filtering
// - tick_force() timer support

interface TickResult {
  text: string;
  status: 'newline' | 'continuous';
}


// Characters that are legitimate to repeat ≥3 times (e.g. laughter, onomatopoeia)
const LEGITIMATE_REPEATS = new Set([
  '哈', '呵', '嘿', '嘻',
  '咚', '啪', '哗', '嗖', '砰', '嘀', '嗡',
]);

export class TextProcessor {
  private buffer = '';
  private sentPos = 0;
  private needsNewline = false;
  private isFirstLine = true;
  private hasOutput = false;
  private needsSessionNewline = false;   // marks session boundary for \n\n between sessions
  private prevSegmentTail = '';
  private lastSegmentEnd = 0;        // ms
  private recentOutputs: Array<{ text: string; time: number }> = [];
  private header = '';
  private carryBuffer = '';

  // Config (overridable via constructor)
  private maxLineChars = 90;
  private silenceThresholdSec = 2.5;
  private dedupWindowSec = 5.0;
  private newlinePunctuation = '。！？.!?';       // 换行：句末标点
  private carryPunctuation = '，。！？、；：,.!?;:';  // carry：所有标点

  constructor(cfg?: { silence_threshold?: number; max_line_chars?: number; dedup_window?: number; newline_punctuation?: string; carry_punctuation?: string }) {
    if (cfg) {
      if (cfg.silence_threshold != null) this.silenceThresholdSec = cfg.silence_threshold;
      if (cfg.max_line_chars != null) this.maxLineChars = cfg.max_line_chars;
      if (cfg.dedup_window != null) this.dedupWindowSec = cfg.dedup_window;
      if (cfg.newline_punctuation != null) this.newlinePunctuation = cfg.newline_punctuation;
      if (cfg.carry_punctuation != null) this.carryPunctuation = cfg.carry_punctuation;
    }
  }

  // ---- Public ----

  /**
   * Feed a new recognized text segment.
   * @param text       ASR+PUNC text
   * @param startWall  VAD segment start wall time (ms)
   * @param endWall    VAD segment end wall time (ms)
   * @param currentTime Current Unix timestamp (ms), for dedup
   */
  tick(text: string, startWall: number, endWall: number, currentTime?: number): TickResult[] {
    if (currentTime == null) currentTime = Date.now();

    // 1. Prepend header from previous truncated segment
    if (this.header) {
      text = this.header + text;
      this.header = '';
    }

    // 2. Preprocess
    let cleaned = this.preprocess(text);

    // 3. Cross-segment overlap dedup
    cleaned = this.dedupOverlap(cleaned);

    // 4. Filter noise
    if (this.isNoise(cleaned)) return [];

    // 5. If buffer has unsent text from a previous segment, flush it as newline first
    const results: TickResult[] = [];
    if (this.buffer.length > 0 && this.sentPos < this.buffer.length) {
      const prev = this.buffer.slice(this.sentPos).trim();
      if (prev && !this.isDuplicate(prev, currentTime)) {
        this.recordOutput(prev, currentTime);
        results.push(...this.formatOutput(prev, currentTime, 'newline'));
      }
      this.buffer = '';
      this.sentPos = 0;
      this.needsNewline = false;
    }

    // 6. Accumulate new text
    this.buffer += cleaned;

    // 7. Duplicate check
    if (this.isDuplicate(this.buffer, currentTime)) return results;

    // 8. Calculate silence gap
    const silenceSec = this.lastSegmentEnd > 0 ? (startWall - this.lastSegmentEnd) / 1000 : 0;
    this.lastSegmentEnd = endWall;

    // 9. Apply tick rules
    results.push(...this.applyTickRules(silenceSec, currentTime));
    return results;
  }

  /**
   * Timer-driven force check (every 3s).
   * Only triggers newline for condition 3 (flag + punctuation).
   * Does NOT produce continuous output.
   */
  tickForce(currentTime?: number): TickResult[] {
    if (currentTime == null) currentTime = Date.now();
    if (!this.buffer) return [];

    if (this.isDuplicate(this.buffer, currentTime)) return [];

    // Only trigger newline when flag is set AND buffer ends with newline punctuation
    if (this.needsNewline && this.newlinePunctuation.includes(this.buffer.slice(-1))) {
      const unsent = this.buffer.slice(this.sentPos);
      const fullLen = this.buffer.length;
      this.buffer = '';
      this.needsNewline = false;
      this.sentPos = 0;
      this.recordOutput(unsent, currentTime);
      return this.formatOutput(unsent, currentTime, 'newline');
    }

    // Set flag if buffer is long enough
    if (this.buffer.length >= this.maxLineChars) {
      this.needsNewline = true;
    }

    return [];
  }

  /** Flush remaining buffer and carryBuffer on stop. */
  flush(currentTime?: number): TickResult[] {
    if (currentTime == null) currentTime = Date.now();
    const results: TickResult[] = [];

    // Flush carryBuffer first
    if (this.carryBuffer && this.carryBuffer.trim().length > 0) {
      results.push(...this.formatOutput(this.carryBuffer.trim(), currentTime, 'newline'));
      this.carryBuffer = '';
    }

    // Flush main buffer
    if (this.buffer && this.buffer.trim().length > 0) {
      results.push(...this.formatOutput(this.buffer.trim(), currentTime, 'newline'));
    }
    this.buffer = '';
    this.sentPos = 0;
    this.needsNewline = false;
    // Mark session boundary: next session's first segment needs \n\n
    this.needsSessionNewline = true;
    return results;
  }

  /**
   * Handle forced-cut segment: split at second-to-last punctuation.
   * Returns the part that should be output now; stores the rest in carryBuffer.
   */
  setCarryText(text: string): string {
    if (!text) { this.carryBuffer = ''; return ''; }

    // Record and strip trailing punctuation
    const trailingRe = new RegExp(`([${this.carryPunctuation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+)$`);
    const trailingMatch = text.match(trailingRe);
    const trailingPunc = trailingMatch ? trailingMatch[1] : '';
    const stripped = text.replace(trailingRe, '');
    if (!stripped) { this.carryBuffer = ''; return ''; }

    // Find all split-punctuation positions in stripped text
    const positions: number[] = [];
    for (let i = 0; i < stripped.length; i++) {
      if (this.carryPunctuation.includes(stripped[i])) positions.push(i);
    }

    let output: string;
    if (positions.length >= 1) {
      // Split at LAST punctuation
      const splitAt = positions[positions.length - 1] + 1;
      output = stripped.slice(0, splitAt);
      // Carry = text after last punc, stripped of ALL punctuation
      const rawCarry = stripped.slice(splitAt);
      this.carryBuffer = this.stripAllPunctuation(rawCarry);
    } else {
      // No punctuation: store everything in carry, stripped of ALL punctuation
      output = '';
      this.carryBuffer = this.stripAllPunctuation(stripped);
    }

    // Debug log
    console.log(`[setCarryText] input="${text.slice(0,30)}..." positions=[${positions}] output="${output.slice(0,20)}" carry="${this.carryBuffer.slice(0,20)}"`);

    return output;
  }

  /** Get current carry buffer content. */
  getCarryBuffer(): string { return this.carryBuffer; }

  /** Force next output to be a new paragraph (with \n\n prefix). */
  forceNewline() {
    this.isFirstLine = false;
  }

  /** Clear carry buffer. */
  clearCarryBuffer() { this.carryBuffer = ''; }

  /** Set hasOutput flag (for restart scenarios where we want \n\n on next output). */
  setHasOutput(v: boolean) { this.hasOutput = v; }
  getNeedsSessionNewline(): boolean { return this.needsSessionNewline; }
  setNeedsSessionNewline(v: boolean) { this.needsSessionNewline = v; }

  reset(preserveSessionNewline = true) {
    this.buffer = '';
    this.sentPos = 0;
    this.needsNewline = false;
    this.isFirstLine = true;
    this.hasOutput = false;
    this.prevSegmentTail = '';
    this.lastSegmentEnd = 0;
    this.recentOutputs = [];
    this.carryBuffer = '';
    this.header = '';
    // Preserve needsSessionNewline by default (reset during stop keeps it for next session)
    if (!preserveSessionNewline) this.needsSessionNewline = false;
  }

  // ---- Preprocess ----

  private preprocess(text: string): string {
    if (!text) return '';
    // Remove control characters
    text = text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    // Fix English abbreviation spaces: "p p t" → "ppt"
    text = this.fixEnglishAbbrev(text);
    // Fix number format
    text = this.fixNumberFormat(text);
    // Collapse repeated characters: "皮皮皮" → "皮皮"
    text = this.collapseRepeats(text);
    return text.trim();
  }

  // ---- Tick rules ----

  private applyTickRules(silenceSec: number, currentTime: number): TickResult[] {
    const lastChar = this.buffer.slice(-1);
    const isSentenceEnd = this.newlinePunctuation.includes(lastChar);
    const fullLen = this.buffer.length;

    // Condition 1: silence ≥ threshold AND sentence-end punctuation → newline
    if (isSentenceEnd && silenceSec >= this.silenceThresholdSec) {
      const unsent = this.buffer.slice(this.sentPos);
      this.recordOutput(this.buffer, currentTime);
      this.buffer = '';
      this.needsNewline = false;
      this.sentPos = 0;
      return this.formatOutput(unsent, currentTime, 'newline');
    }

    // Condition 2: buffer too long → set flag
    if (fullLen >= this.maxLineChars) {
      this.needsNewline = true;
    }

    // Condition 3: flag set AND newline punctuation at end → newline
    if (this.needsNewline && this.newlinePunctuation.includes(lastChar)) {
      const unsent = this.buffer.slice(this.sentPos);
      this.recordOutput(this.buffer, currentTime);
      this.buffer = '';
      this.needsNewline = false;
      this.sentPos = 0;
      return this.formatOutput(unsent, currentTime, 'newline');
    }

    // Condition 4: flag set AND overflow → force split at best point
    if (this.needsNewline && fullLen >= Math.ceil(this.maxLineChars * 1.1)) {
      const splitAt = this.findBestSplit(this.buffer, this.maxLineChars);
      let unsent = this.buffer.slice(this.sentPos, splitAt);
      this.buffer = this.buffer.slice(splitAt);
      // Strip trailing non-sentence-end punctuation (e.g. comma)
      if (unsent.length > 0 && this.carryPunctuation.includes(unsent.slice(-1)) && !this.newlinePunctuation.includes(unsent.slice(-1))) {
        unsent = unsent.slice(0, -1);
      }
      this.recordOutput(unsent, currentTime);
      this.needsNewline = false;
      this.sentPos = 0;
      return this.formatOutput(unsent, currentTime, 'newline');
    }

    // Condition 5: continuous — send increment only
    const unsent = this.buffer.slice(this.sentPos);
    if (unsent.length > 0) {
      this.sentPos = fullLen;
      return this.formatOutput(unsent, currentTime, 'continuous');
    }

    return [];
  }

  // ---- Output formatting ----
  //   first-line + newline:    "[HH:MM:SS] text"
  //   !first-line + newline:   "\n\n[HH:MM:SS] text"
  //   first-line + continuous: "[HH:MM:SS] text"
  //   !first-line + continuous: "text"

  private formatOutput(text: string, currentTime: number, status: 'newline' | 'continuous'): TickResult[] {
    const t = new Date(currentTime);
    const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    const timeHeader = `[${ts}]`;

    text = text.trim();
    if (!text) return [];

    // Session boundary: force \n\n + time header for first output of new session
    if (this.needsSessionNewline) {
      this.needsSessionNewline = false;
      this.hasOutput = true;
      return [{ text: `\n\n${timeHeader} ${text}`, status: 'newline' }];
    }

    if (status === 'newline') {
      if (!this.hasOutput) {
        this.hasOutput = true;
        this.isFirstLine = false;
        return [{ text: `${timeHeader} ${text}`, status: 'newline' }];
      } else {
        return [{ text: `\n\n${timeHeader} ${text}`, status: 'newline' }];
      }
    } else {
      // continuous
      if (!this.hasOutput) {
        this.hasOutput = true;
        this.isFirstLine = false;
        return [{ text: `${timeHeader} ${text}`, status: 'continuous' }];
      }
      return [{ text, status: 'continuous' }];
    }
  }

  // ---- Dedup / Overlap ----

  private isDuplicate(text: string, currentTime: number): boolean {
    // Clean expired entries
    const cutoff = currentTime - this.dedupWindowSec * 1000;
    this.recentOutputs = this.recentOutputs.filter(h => h.time >= cutoff);
    for (const h of this.recentOutputs) {
      if (h.text === text) return true;
    }
    return false;
  }

  private recordOutput(text: string, currentTime: number) {
    this.recentOutputs.push({ text, time: currentTime });
    if (this.recentOutputs.length > 50) this.recentOutputs.shift();
  }

  /**
   * Cross-segment overlap dedup.
   * Compares new segment head with previous segment tail, removes overlap ≥2 chars.
   */
  private dedupOverlap(text: string): string {
    if (!text) return text;

    if (!this.prevSegmentTail) {
      this.prevSegmentTail = text.slice(-20);
      return text;
    }

    const tail = this.prevSegmentTail.slice(-20);
    const head = text.slice(0, 20);

    let overlapLen = 0;
    const maxCheck = Math.min(tail.length, head.length);
    for (let k = maxCheck; k >= 2; k--) {
      if (tail.slice(-k) === head.slice(0, k)) {
        overlapLen = k;
        break;
      }
    }

    if (overlapLen >= 2) {
      text = text.slice(overlapLen);
    }

    this.prevSegmentTail = text.slice(-20);
    return text;
  }

  // ---- Noise filter ----

  private isNoise(text: string): boolean {
    if (!text || text.trim().length === 0) return true;
    const trimmed = text.trim();

    // Pure punctuation
    if (/^[.,!?。，！？\s]+$/.test(trimmed)) return true;
    // Single char
    if (trimmed.length <= 1) return true;
    // Pure digits
    if (/^[\d\s.,\-]+$/.test(trimmed)) return true;
    // Short Chinese (< 3 chars)
    if (/^[一-鿿]+$/.test(trimmed) && trimmed.length < 3) return true;
    // Short English (< 2 letters)
    if (/^[a-zA-Z\s.,!?]+$/.test(trimmed)) {
      const letters = trimmed.replace(/[^a-zA-Z]/g, '');
      if (letters.length < 2) return true;
    }

    return false;
  }

  // ---- Text fixes ----

  /** Fix "p p t" → "ppt" (single-letter English abbreviations with spaces). */
  private fixEnglishAbbrev(text: string): string {
    // Iteratively merge isolated single ASCII letters
    // Pattern: word-boundary + single letter + spaces + word-boundary
    let changed = true;
    while (changed) {
      const prev = text;
      text = text.replace(/\b([a-zA-Z])\s+(?=[a-zA-Z]\b)/g, '$1');
      changed = text !== prev;
    }
    return text;
  }

  /** Fix number format: "3 . 14" → "3.14" */
  private fixNumberFormat(text: string): string {
    return text.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
  }

  /** Collapse repeated Chinese characters: "皮皮皮" → "皮皮" */
  private collapseRepeats(text: string): string {
    let result = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch >= '一' && ch <= '鿿') {
        let j = i + 1;
        while (j < text.length && text[j] === ch) j++;
        const count = j - i;
        if (count >= 3) {
          const keep = LEGITIMATE_REPEATS.has(ch) ? 3 : 2;
          result += ch.repeat(keep);
        } else {
          result += ch.repeat(count);
        }
        i = j;
      } else {
        result += ch;
        i++;
      }
    }
    return result;
  }

  // ---- Helpers ----

  /** Remove all punctuation from text (for carry buffer). */
  private stripAllPunctuation(text: string): string {
    const re = new RegExp(`[${this.carryPunctuation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`, 'g');
    return text.replace(re, '').trim();
  }

  private findBestSplit(buf: string, minLen: number): number {
    // Prefer sentence-end punctuation (newlinePunctuation) near minLen
    for (const p of this.newlinePunctuation) {
      const idx = buf.lastIndexOf(p, buf.length - 1);
      if (idx >= minLen) return idx + 1;
    }
    // Fallback to carry punctuation (includes commas etc.)
    for (const p of this.carryPunctuation) {
      const idx = buf.lastIndexOf(p, buf.length - 1);
      if (idx >= minLen) return idx + 1;
    }
    // Hard split at minLen
    return minLen;
  }
}
