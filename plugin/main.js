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
    this.btnClear = controls.createEl("button", {
      text: "\u6E05\u5C4F",
      cls: "voice-solo-btn voice-solo-btn-clear"
    });
    this.btnStart.addEventListener("click", async () => {
      if (this.onStart) {
        this.btnStart.disabled = true;
        this.btnClear.disabled = true;
        this.setStatus("loading", "\u8BF7\u6C42\u9EA6\u514B\u98CE...");
        try {
          await this.onStart();
          this.isRunning = true;
          this.btnStop.disabled = false;
          this.setStatus("recording", "\u8BC6\u522B\u4E2D...");
        } catch (e) {
          this.setStatus("error", e.message);
          this.btnStart.disabled = false;
          this.btnClear.disabled = false;
        }
      }
    });
    this.btnStop.addEventListener("click", () => {
      this.isRunning = false;
      this.btnStart.disabled = false;
      this.btnStop.disabled = true;
      this.btnClear.disabled = false;
      this.setStatus("idle", "\u5DF2\u505C\u6B62");
      if (this.onStop) this.onStop();
    });
    this.btnClear.addEventListener("click", () => {
      this.clear();
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
var LEGITIMATE_REPEATS = /* @__PURE__ */ new Set([
  "\u54C8",
  "\u5475",
  "\u563F",
  "\u563B",
  "\u549A",
  "\u556A",
  "\u54D7",
  "\u55D6",
  "\u7830",
  "\u5600",
  "\u55E1"
]);
var TextProcessor = class {
  constructor() {
    this.buffer = "";
    this.sentPos = 0;
    this.needsNewline = false;
    this.isFirstLine = true;
    this.prevSegmentTail = "";
    this.lastSegmentEnd = 0;
    // ms
    this.recentOutputs = [];
    this.header = "";
    // Config
    this.maxLineChars = 60;
    this.silenceThresholdSec = 2;
    this.dedupWindowSec = 5;
  }
  // ---- Public ----
  /**
   * Feed a new recognized text segment.
   * @param text       ASR+PUNC text
   * @param startWall  VAD segment start wall time (ms)
   * @param endWall    VAD segment end wall time (ms)
   * @param currentTime Current Unix timestamp (ms), for dedup
   */
  tick(text, startWall, endWall, currentTime) {
    if (currentTime == null) currentTime = Date.now();
    if (this.header) {
      text = this.header + text;
      this.header = "";
    }
    let cleaned = this.preprocess(text);
    cleaned = this.dedupOverlap(cleaned);
    if (this.isNoise(cleaned)) return [];
    this.buffer += cleaned;
    if (this.isDuplicate(this.buffer, currentTime)) return [];
    const silenceSec = this.lastSegmentEnd > 0 ? (startWall - this.lastSegmentEnd) / 1e3 : 0;
    this.lastSegmentEnd = endWall;
    return this.applyTickRules(silenceSec, currentTime);
  }
  /**
   * Timer-driven force check (every 3s).
   * Only triggers newline for condition 3 (flag + punctuation).
   * Does NOT produce continuous output.
   */
  tickForce(currentTime) {
    if (currentTime == null) currentTime = Date.now();
    if (!this.buffer) return [];
    if (this.isDuplicate(this.buffer, currentTime)) return [];
    if (this.needsNewline && this.buffer.slice(-1).match(/[，。！？.!?、]/)) {
      const unsent = this.buffer.slice(this.sentPos);
      const fullLen = this.buffer.length;
      this.buffer = "";
      this.needsNewline = false;
      this.sentPos = 0;
      this.recordOutput(unsent, currentTime);
      return this.formatOutput(unsent, currentTime, "newline");
    }
    if (this.buffer.length >= this.maxLineChars) {
      this.needsNewline = true;
    }
    return [];
  }
  /** Flush remaining buffer on stop. */
  flush(currentTime) {
    if (currentTime == null) currentTime = Date.now();
    if (!this.buffer || this.buffer.trim().length === 0) {
      this.buffer = "";
      this.sentPos = 0;
      return [];
    }
    const text = this.buffer.trim();
    this.buffer = "";
    this.sentPos = 0;
    this.needsNewline = false;
    return this.formatOutput(text, currentTime, "newline");
  }
  reset() {
    this.buffer = "";
    this.sentPos = 0;
    this.needsNewline = false;
    this.isFirstLine = true;
    this.prevSegmentTail = "";
    this.lastSegmentEnd = 0;
    this.recentOutputs = [];
    this.header = "";
  }
  // ---- Preprocess ----
  preprocess(text) {
    if (!text) return "";
    text = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    text = this.fixEnglishAbbrev(text);
    text = this.fixNumberFormat(text);
    text = this.collapseRepeats(text);
    return text.trim();
  }
  // ---- Tick rules ----
  applyTickRules(silenceSec, currentTime) {
    const isSentenceEnd = PUNCTUATION.includes(this.buffer.slice(-1));
    const fullLen = this.buffer.length;
    if (isSentenceEnd && silenceSec >= this.silenceThresholdSec) {
      const unsent2 = this.buffer.slice(this.sentPos);
      this.recordOutput(this.buffer, currentTime);
      this.buffer = "";
      this.needsNewline = false;
      this.sentPos = 0;
      return this.formatOutput(unsent2, currentTime, "newline");
    }
    if (fullLen >= this.maxLineChars) {
      this.needsNewline = true;
    }
    if (this.needsNewline && this.buffer.slice(-1).match(/[，。！？.!?、]/)) {
      const unsent2 = this.buffer.slice(this.sentPos);
      this.recordOutput(this.buffer, currentTime);
      this.buffer = "";
      this.needsNewline = false;
      this.sentPos = 0;
      return this.formatOutput(unsent2, currentTime, "newline");
    }
    if (this.needsNewline && fullLen >= this.maxLineChars * 2) {
      const splitAt = this.findBestSplit(this.buffer, this.maxLineChars);
      const unsent2 = this.buffer.slice(this.sentPos, splitAt);
      this.buffer = this.buffer.slice(splitAt);
      this.recordOutput(unsent2, currentTime);
      this.needsNewline = false;
      this.sentPos = 0;
      return this.formatOutput(unsent2, currentTime, "newline");
    }
    const unsent = this.buffer.slice(this.sentPos);
    if (unsent.length > 0) {
      this.sentPos = fullLen;
      return this.formatOutput(unsent, currentTime, "continuous");
    }
    return [];
  }
  // ---- Output formatting ----
  // Matches Python _build_output() style:
  //   first-line + newline:    "[HH:MM:SS] text"
  //   !first-line + newline:   "\n\n[HH:MM:SS] text"  ← time header prefixed to new paragraph
  //   first-line + continuous: "[HH:MM:SS] text"
  //   !first-line + continuous: "text"
  formatOutput(text, currentTime, status) {
    const t = new Date(currentTime);
    const ts = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    const timeHeader = `[${ts}]`;
    text = text.trim();
    if (!text) return [];
    if (status === "newline") {
      if (this.isFirstLine) {
        this.isFirstLine = false;
        return [{ text: `${timeHeader}
${text}`, status: "newline" }];
      } else {
        return [{ text: `

${timeHeader}
${text}`, status: "newline" }];
      }
    } else {
      if (this.isFirstLine) {
        this.isFirstLine = false;
        return [{ text: `${timeHeader}
${text}`, status: "continuous" }];
      }
      return [{ text, status: "continuous" }];
    }
  }
  // ---- Dedup / Overlap ----
  isDuplicate(text, currentTime) {
    const cutoff = currentTime - this.dedupWindowSec * 1e3;
    this.recentOutputs = this.recentOutputs.filter((h) => h.time >= cutoff);
    for (const h of this.recentOutputs) {
      if (h.text === text) return true;
    }
    return false;
  }
  recordOutput(text, currentTime) {
    this.recentOutputs.push({ text, time: currentTime });
    if (this.recentOutputs.length > 50) this.recentOutputs.shift();
  }
  /**
   * Cross-segment overlap dedup.
   * Compares new segment head with previous segment tail, removes overlap ≥2 chars.
   */
  dedupOverlap(text) {
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
  isNoise(text) {
    if (!text || text.trim().length === 0) return true;
    const trimmed = text.trim();
    if (/^[.,!?。，！？\s]+$/.test(trimmed)) return true;
    if (trimmed.length <= 1) return true;
    if (/^[\d\s.,\-]+$/.test(trimmed)) return true;
    if (/^[一-鿿]+$/.test(trimmed) && trimmed.length < 3) return true;
    if (/^[a-zA-Z\s.,!?]+$/.test(trimmed)) {
      const letters = trimmed.replace(/[^a-zA-Z]/g, "");
      if (letters.length < 2) return true;
    }
    return false;
  }
  // ---- Text fixes ----
  /** Fix "p p t" → "ppt" (single-letter English abbreviations with spaces). */
  fixEnglishAbbrev(text) {
    let changed = true;
    while (changed) {
      const prev = text;
      text = text.replace(/\b([a-zA-Z])\s+(?=[a-zA-Z]\b)/g, "$1");
      changed = text !== prev;
    }
    return text;
  }
  /** Fix number format: "3 . 14" → "3.14" */
  fixNumberFormat(text) {
    return text.replace(/(\d)\s*\.\s*(\d)/g, "$1.$2");
  }
  /** Collapse repeated Chinese characters: "皮皮皮" → "皮皮" */
  collapseRepeats(text) {
    let result = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch >= "\u4E00" && ch <= "\u9FFF") {
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
  findBestSplit(buf, minLen) {
    for (const p of "\u3002\uFF01\uFF1F") {
      const idx = buf.lastIndexOf(p, buf.length - 1);
      if (idx >= minLen) return idx + 1;
    }
    for (const p of "\uFF0C\u3001\uFF1B") {
      const idx = buf.lastIndexOf(p, buf.length - 1);
      if (idx >= minLen) return idx + 1;
    }
    return minLen;
  }
};

// src/flac-encoder.ts
var BLOCK_SIZE = 4096;
var RICE_PARTITION_ORDER = 2;
var RICE_PARTITION_SIZE = BLOCK_SIZE >> RICE_PARTITION_ORDER;
var MAX_RICE_K = 14;
var BitBuf = class {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.pos = 0;
  }
  write(v, n) {
    if (n <= 0) return;
    v = v & (1 << n) - 1;
    while (n > 0) {
      const room = 8 - this.pos;
      const take = Math.min(n, room);
      this.cur |= v >>> n - take << room - take;
      this.pos += take;
      n -= take;
      v = v & (1 << n) - 1;
      if (this.pos === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.pos = 0;
      }
    }
  }
  writeUnary(v) {
    while (v >= 8 - this.pos) {
      const room = 8 - this.pos;
      this.cur |= (1 << room) - 1 << 0;
      this.bytes.push(this.cur);
      this.cur = 0;
      this.pos = 0;
      v -= room;
    }
    if (v > 0) {
      this.cur |= (1 << v) - 1 << 8 - this.pos - v;
      this.pos += v;
    }
    this.pos++;
    if (this.pos === 8) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.pos = 0;
    }
  }
  writeRiceSigned(v, k) {
    const u = v >= 0 ? v << 1 : (-v << 1) - 1;
    const q = u >>> k, r = u & (1 << k) - 1;
    this.writeUnary(q);
    if (k > 0) this.write(r, k);
  }
  flush() {
    if (this.pos > 0) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.pos = 0;
    }
  }
  toUint8() {
    this.flush();
    return new Uint8Array(this.bytes);
  }
};
function crc8(data, start, len) {
  let c = 0;
  for (let i = start; i < start + len; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = c & 128 ? (c << 1 ^ 7) & 255 : c << 1 & 255;
  }
  return c & 255;
}
function crc16(data, start, len) {
  let c = 0;
  for (let i = start; i < start + len; i++) {
    c ^= data[i] << 8;
    for (let j = 0; j < 8; j++) c = c & 32768 ? (c << 1 ^ 32773) & 65535 : c << 1 & 65535;
  }
  return c & 65535;
}
var FIXED_COEFFS = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];
function computeResiduals(samples, block, order, out) {
  const coeffs = FIXED_COEFFS[order];
  let sumAbs = 0;
  for (let i = order; i < block; i++) {
    let pred = 0;
    for (let j = 0; j < order; j++) pred += coeffs[j] * samples[i - 1 - j];
    out[i] = samples[i] - pred;
    sumAbs += Math.abs(out[i]);
  }
  return sumAbs;
}
function buildStreaminfo(sampleRate, totalSamples) {
  const out = new Uint8Array(4 + 34);
  out[0] = 128;
  out[1] = 0;
  out[2] = 0;
  out[3] = 34;
  const b = new BitBuf();
  b.write(BLOCK_SIZE, 16);
  b.write(BLOCK_SIZE, 16);
  b.write(0, 24);
  b.write(0, 24);
  b.write(sampleRate, 20);
  b.write(0, 3);
  b.write(15, 5);
  b.write(totalSamples, 36);
  b.write(0, 128);
  out.set(b.toUint8(), 4);
  return out;
}
function encodeFrame(samples, n, frameNum, order, warmup, subframeBytes) {
  const hdr = new BitBuf();
  hdr.write(16382, 14);
  hdr.write(0, 1);
  hdr.write(1, 4);
  hdr.write(0, 4);
  hdr.write(0, 4);
  hdr.write(1, 3);
  hdr.write(0, 1);
  if (frameNum < 128) hdr.write(frameNum, 8);
  else if (frameNum < 2048) {
    hdr.write(192 | frameNum >>> 6, 8);
    hdr.write(128 | frameNum & 63, 8);
  }
  hdr.write(n - 1 & 255, 8);
  const hdrBytes = hdr.toUint8();
  const hdrWithCrc = new Uint8Array(hdrBytes.length + 1);
  hdrWithCrc.set(hdrBytes, 0);
  hdrWithCrc[hdrBytes.length] = crc8(hdrBytes, 0, hdrBytes.length);
  const frame = new Uint8Array(hdrWithCrc.length + subframeBytes.length + 2);
  frame.set(hdrWithCrc, 0);
  frame.set(subframeBytes, hdrWithCrc.length);
  const c16 = crc16(frame, 0, frame.length - 2);
  frame[frame.length - 2] = c16 >>> 8 & 255;
  frame[frame.length - 1] = c16 & 255;
  return frame;
}
function encodeSingleBlock(samples, n, frameNum) {
  const residuals = new Int32Array(BLOCK_SIZE);
  let bestOrder = 0, bestCost = Infinity;
  for (let order = 0; order <= 4; order++) {
    if (n <= order) continue;
    const cost = computeResiduals(samples, n, order, residuals);
    if (cost < bestCost) {
      bestCost = cost;
      bestOrder = order;
    }
  }
  const subframe = new BitBuf();
  const warmup = Math.min(bestOrder, n);
  subframe.write(0, 1);
  subframe.write(16 | bestOrder & 7, 6);
  subframe.write(0, 1);
  for (let i = 0; i < warmup; i++) subframe.write(samples[i] & 65535, 16);
  const numParts = 1 << RICE_PARTITION_ORDER;
  for (let p = 0; p < numParts; p++) {
    const start = warmup + p * RICE_PARTITION_SIZE;
    const end = Math.min(start + RICE_PARTITION_SIZE, n);
    const riceBits = p === 0 ? 4 : 5;
    if (end <= start) {
      subframe.write(0, riceBits);
      continue;
    }
    let bestK = 0, bestBits = Infinity;
    for (let k = 0; k <= MAX_RICE_K; k++) {
      let bits = riceBits;
      for (let i = start; i < end; i++) {
        const u = residuals[i] >= 0 ? residuals[i] << 1 : (-residuals[i] << 1) - 1;
        bits += (u >>> k) + 1 + k;
      }
      if (bits < bestBits) {
        bestBits = bits;
        bestK = k;
      }
    }
    subframe.write(bestK, riceBits);
    for (let i = start; i < end; i++) subframe.writeRiceSigned(residuals[i], bestK);
  }
  return encodeFrame(samples, n, frameNum, bestOrder, warmup, subframe.toUint8());
}
function buildWavHeader(dataSize, sampleRate) {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}
var FlacEncoder = class {
  constructor(sampleRate = 16e3, blockSize = 4096) {
    this.accum = new Float32Array(0);
    this.fdFlac = null;
    this.fdWav = null;
    this.totalSamples = 0;
    this.frameNum = 0;
    this.flacPath = "";
    this.wavPath = "";
    this.minFrameSize = Infinity;
    this.maxFrameSize = 0;
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
  }
  /** Open FLAC file (streaming), also open WAV for diagnostics. */
  open(flacFilepath, fs) {
    this.flacPath = flacFilepath;
    this.totalSamples = 0;
    this.frameNum = 0;
    this.accum = new Float32Array(0);
    this.minFrameSize = Infinity;
    this.maxFrameSize = 0;
    const dir = flacFilepath.replace(/[/\\][^/\\]*$/, "");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
    }
    this.fdFlac = fs.openSync(flacFilepath, "w");
    fs.writeSync(this.fdFlac, Buffer.from([102, 76, 97, 67]));
    fs.writeSync(this.fdFlac, Buffer.from(buildStreaminfo(this.sampleRate, 0)));
    this.wavPath = flacFilepath.replace(/\.flac$/, ".wav");
    this.fdWav = fs.openSync(this.wavPath, "w");
    fs.writeSync(this.fdWav, Buffer.from(buildWavHeader(0, this.sampleRate)));
  }
  /** Feed audio chunk. Encoded FLAC frames are appended immediately. WAV PCM is appended. */
  processChunk(chunk, fs) {
    const merged = new Float32Array(this.accum.length + chunk.length);
    merged.set(this.accum);
    merged.set(chunk, this.accum.length);
    this.accum = merged;
    while (this.accum.length >= this.blockSize) {
      const block = this.accum.slice(0, this.blockSize);
      this.accum = this.accum.slice(this.blockSize);
      this.encodeAndWrite(block, fs);
    }
  }
  encodeAndWrite(block, fs) {
    const n = block.length;
    const i16 = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      i16[i] = Math.round(Math.max(-1, Math.min(1, block[i])) * 32767);
    }
    const flacFrame = encodeSingleBlock(i16, n, this.frameNum);
    this.frameNum++;
    this.totalSamples += n;
    const fsz = flacFrame.length;
    if (fsz < this.minFrameSize) this.minFrameSize = fsz;
    if (fsz > this.maxFrameSize) this.maxFrameSize = fsz;
    if (this.fdFlac !== null) {
      fs.writeSync(this.fdFlac, Buffer.from(flacFrame));
    }
    if (this.fdWav !== null) {
      fs.writeSync(this.fdWav, Buffer.from(i16.buffer));
    }
  }
  /** Flush remaining, fix headers, close files. Returns debug info string. */
  close(fs) {
    if (this.accum.length > 0) {
      const block = new Float32Array(this.accum.length);
      block.set(this.accum);
      this.encodeAndWrite(block, fs);
    }
    this.accum = new Float32Array(0);
    const dbg = [];
    dbg.push(`frames=${this.frameNum} totalSamples=${this.totalSamples}`);
    if (this.fdFlac !== null) {
      const total = this.totalSamples;
      const buf = Buffer.alloc(5);
      buf[0] = 240 | total >>> 32 & 15;
      buf.writeUInt32BE(total & 4294967295, 1);
      fs.writeSync(this.fdFlac, buf, 0, 5, 21);
      const minFrm = this.minFrameSize === Infinity ? 0 : this.minFrameSize;
      const maxFrm = this.maxFrameSize;
      const fbuf = Buffer.alloc(3);
      fbuf.writeUIntBE(minFrm, 0, 3);
      fs.writeSync(this.fdFlac, fbuf, 0, 3, 12);
      fbuf.writeUIntBE(maxFrm, 0, 3);
      fs.writeSync(this.fdFlac, fbuf, 0, 3, 15);
      dbg.push(`minFrame=${minFrm} maxFrame=${maxFrm}`);
      fs.closeSync(this.fdFlac);
      this.fdFlac = null;
      try {
        const check = fs.readFileSync(this.flacPath);
        dbg.push(`fileSize=${check.length}`);
        const magic = String.fromCharCode(...check.slice(0, 4));
        dbg.push(`magic="${magic}"` + (magic === "fLaC" ? " OK" : " BAD"));
        const blkHdr = check[4];
        const isLast = (blkHdr & 128) !== 0;
        const blkType = blkHdr & 127;
        dbg.push(`stINFO[last=${isLast} type=${blkType}]` + (blkType === 0 ? " OK" : " BAD"));
        const hex16 = Array.from(check.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        dbg.push(`head[0:16]=${hex16}`);
        if (check.length > 44) {
          const syncHi = check[42], syncLo = check[43];
          const sync = (syncHi & 255) << 6 | (syncLo & 252) >> 2;
          dbg.push(`frame0[0:2]=${syncHi.toString(16).padStart(2, "0")} ${syncLo.toString(16).padStart(2, "0")} sync=${sync.toString(16)}` + (sync === 16382 ? " OK" : " BAD"));
        } else {
          dbg.push(`frame0: file too short (no frame data)`);
        }
      } catch (e) {
        dbg.push(`selfCheck error: ${e.message}`);
      }
    }
    if (this.fdWav !== null) {
      const dataSize = this.totalSamples * 2;
      const fileSize = 36 + dataSize;
      const hdr = Buffer.alloc(8);
      hdr.writeUInt32LE(fileSize, 0);
      hdr.writeUInt32LE(dataSize, 4);
      fs.writeSync(this.fdWav, hdr, 0, 4, 4);
      fs.writeSync(this.fdWav, hdr, 4, 4, 40);
      fs.closeSync(this.fdWav);
      this.fdWav = null;
    }
    return dbg.join(" | ");
  }
  /**
   * Debug: write a 1-second 440Hz test tone FLAC using the same encoder.
   * If this plays but the real recording doesn't, the issue is in audio capture.
   * If this also fails, the encoder has an Electron-specific bug.
   */
  static debugTestTone(filepath, fs) {
    const sr = 16e3;
    const duration = sr * 1;
    const tone = new Float32Array(duration);
    for (let i = 0; i < duration; i++) {
      tone[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
    }
    const dir = filepath.replace(/[/\\][^/\\]*$/, "");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
    }
    const i16 = new Int16Array(duration);
    for (let i = 0; i < duration; i++) i16[i] = Math.round(Math.max(-1, Math.min(1, tone[i])) * 32767);
    const fd = fs.openSync(filepath, "w");
    fs.writeSync(fd, Buffer.from([102, 76, 97, 67]));
    fs.writeSync(fd, Buffer.from(buildStreaminfo(sr, 0)));
    let totalSamples = 0;
    let frameNum = 0;
    let minFsz = Infinity, maxFsz = 0;
    for (let offset = 0; offset < duration; offset += BLOCK_SIZE) {
      const n = Math.min(BLOCK_SIZE, duration - offset);
      const block = new Int16Array(BLOCK_SIZE);
      block.set(i16.subarray(offset, offset + n));
      const frame = encodeSingleBlock(block, n, frameNum);
      fs.writeSync(fd, Buffer.from(frame));
      frameNum++;
      totalSamples += n;
      if (frame.length < minFsz) minFsz = frame.length;
      if (frame.length > maxFsz) maxFsz = frame.length;
    }
    const buf = Buffer.alloc(5);
    buf[0] = 240 | totalSamples >>> 32 & 15;
    buf.writeUInt32BE(totalSamples & 4294967295, 1);
    fs.writeSync(fd, buf, 0, 5, 21);
    const fbuf = Buffer.alloc(3);
    if (minFsz !== Infinity) {
      fbuf.writeUIntBE(minFsz, 0, 3);
      fs.writeSync(fd, fbuf, 0, 3, 12);
    }
    fbuf.writeUIntBE(maxFsz, 0, 3);
    fs.writeSync(fd, fbuf, 0, 3, 15);
    fs.closeSync(fd);
    try {
      const check = fs.readFileSync(filepath);
      const magic = String.fromCharCode(...check.slice(0, 4));
      return `testTone fileSize=${check.length} magic="${magic}"` + (magic === "fLaC" ? " OK" : " BAD");
    } catch (e) {
      return `testTone error: ${e.message}`;
    }
  }
};

// src/main.ts
var ORT_WASM_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm";
function downloadFile(url, dest, fs) {
  return new Promise((resolve, reject) => {
    const dir = dest.replace(/[/\\][^/\\]*$/, "");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
    }
    const file = fs.createWriteStream(dest);
    require("https").get(url, (res) => {
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
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", reject);
  });
}
async function ensureModels(modelsDir, modelsJsonPath, addLog, onProgress) {
  const fs = window.require?.("fs") || require("fs");
  if (!fs.existsSync(modelsJsonPath)) {
    throw new Error(`models.json not found at ${modelsJsonPath}`);
  }
  const cfg = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
  const entries = [
    { key: "vad", entry: cfg.vad, parent: "vad" },
    { key: "asr", entry: cfg.asr, parent: "asr" },
    { key: "punc", entry: cfg.punc, parent: "punc" }
  ];
  let downloaded = false;
  for (const { key, entry, parent } of entries) {
    const modelDir = `${modelsDir}/${parent}/${entry.name}`;
    try {
      fs.mkdirSync(modelDir, { recursive: true });
    } catch {
    }
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
  if (downloaded) addLog("All models ready");
  return modelsDir;
}
async function ensureWasmFile(wasmPath, addLog) {
  const fs = window.require?.("fs") || require("fs");
  if (fs.existsSync(wasmPath)) return;
  addLog(`Downloading ORT WASM from CDN...`);
  try {
    const https = require("https");
    await new Promise((resolve, reject) => {
      const dir = wasmPath.replace(/[/\\][^/\\]*$/, "");
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
      }
      const file = fs.createWriteStream(wasmPath);
      https.get(ORT_WASM_CDN, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`CDN download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", reject);
    });
    const stat = fs.statSync(wasmPath);
    addLog(`ORT WASM downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
  } catch (e) {
    addLog(`ORT WASM download failed: ${e.message}`);
    throw new Error(`\u65E0\u6CD5\u4E0B\u8F7D ONNX Runtime WASM \u6587\u4EF6\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u3002
${e.message}`);
  }
}
var DEFAULT_SETTINGS = {
  modelBasePath: "",
  asrModelTier: "standard",
  outputToNote: false,
  outputFolder: "Transcriptions",
  saveAudio: false,
  recordingFolder: "Recordings",
  postProcessEnabled: false,
  audioDevice: "",
  hotWords: {}
};
var VoiceSoloPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    this.vadWorker = null;
    this.asrWorker = null;
    this.audioCtx = null;
    this.micStream = null;
    this.workletNode = null;
    this.pluginDir = "";
    this.textProc = new TextProcessor();
    this.vadReady = false;
    this.asrReady = false;
    this.asrBusy = false;
    this.logBuf = [];
    this.logTimer = 0;
    this.pendingSegments = [];
    this.flacEncoder = null;
    this.currentNotePath = "";
    this.recordingPath = "";
    this.pendingPlaceholder = "";
    this.tickTimer = 0;
  }
  addLog(msg) {
    const ts = Date.now();
    this.logBuf.push(`[${ts}] ${msg}`);
    if (this.logBuf.length > 500) this.logBuf = this.logBuf.slice(-300);
  }
  async flushLog(reason) {
    console.log(`[VoiceSolo] flushLog(${reason}) bufLen=${this.logBuf.length}`, this.logBuf.slice(0, 5));
    if (this.logBuf.length === 0) return;
    try {
      const text = `# Voice-Solo Debug Log \u2014 ${reason}

` + this.logBuf.map((l) => `- ${l}`).join("\n");
      const file = this.pluginDir.replace(/\\/g, "/") + "/debug-log.md";
      const fs = window.require?.("fs") || require("fs");
      fs.writeFileSync(file, text, "utf-8");
      this.logBuf = [];
    } catch {
    }
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
    console.log("[VoiceSolo] startRecognition called");
    try {
      this.addLog("START requested");
      const fs = window.require?.("fs") || require("fs");
      if (this.settings.saveAudio) {
        this.addLog("[step] init FLAC encoder...");
        const vaultRoot = this.app.vault.adapter.basePath;
        const dir = vaultRoot + "/" + this.settings.recordingFolder;
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
        }
        const now = /* @__PURE__ */ new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        this.recordingPath = dir + "/\u5F55\u97F3_" + ts + ".flac";
        this.flacEncoder = new FlacEncoder(16e3, 4096);
        this.flacEncoder.open(this.recordingPath, fs);
        this.addLog(`FLAC+WAV recording: ${this.recordingPath}`);
      }
      if (this.settings.outputToNote) {
        this.addLog("[step] init note output...");
        await this.ensureOutputFile();
        await this.insertNoteHeader();
        if (this.settings.saveAudio) {
          const fname = this.recordingPath.replace(/\\/g, "/").split("/").pop() || "";
          await this.insertAudioPlaceholder(fname);
        }
      }
      this.tickTimer = window.setInterval(() => {
        const results = this.textProc.tickForce(Date.now());
        const lv = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        const v = lv.length > 0 ? lv[0].view : null;
        for (const r of results) {
          if (r.text) {
            if (v) v.addSegment(r.text, 0, 0);
            if (this.settings.outputToNote) this.appendToNote(r.text);
          }
        }
      }, 3e3);
      this.addLog("[step] creating workers...");
      await this.createWorkers(view);
      this.addLog("[step] starting mic...");
      await this.startMic(view);
      this.addLog("[step] startMic done");
    } catch (e) {
      this.addLog(`ERROR: ${e.message}
${e.stack}`);
      console.error("[VoiceSolo] startRecognition failed:", e);
      view.setStatus("error", e.message || "\u542F\u52A8\u5931\u8D25");
      this.stopRecognition();
    }
  }
  async stopRecognition() {
    this.addLog("STOP requested");
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = 0;
    }
    const parts = this.textProc.flush(Date.now());
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves.length > 0 ? leaves[0].view : null;
    for (const p of parts) {
      if (p.text) {
        if (view) view.addSegment(p.text, 0, 0);
        if (this.settings.outputToNote) this.appendToNote(p.text);
      }
    }
    this.textProc.reset();
    this.pendingSegments = [];
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
    if (this.flacEncoder) {
      const flacFs = window.require?.("fs") || require("fs");
      const flacDbg = this.flacEncoder.close(flacFs);
      this.addLog(`FLAC close: ${flacDbg}`);
      this.addLog(`WAV saved: ${this.recordingPath.replace(".flac", ".wav")}`);
      const testPath = this.recordingPath.replace(".flac", "_test.flac");
      const testDbg = FlacEncoder.debugTestTone(testPath, flacFs);
      this.addLog(`FLAC test: ${testDbg}`);
      this.flacEncoder = null;
      if (this.settings.outputToNote && this.recordingPath) {
        this.replacePlaceholderWithEmbed();
      }
      this.recordingPath = "";
    }
    if (this.vadWorker) {
      this.vadWorker.postMessage({ type: "stop" });
    }
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
    this.flushLog("stop");
  }
  waitForAsrDrain() {
    const maxWait = 15e3;
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const empty = !this.asrBusy && this.pendingSegments.length === 0;
        if (empty || Date.now() - start > maxWait) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }
  // ---- Dual Worker setup ----
  async createWorkers(view) {
    if (this.vadWorker) {
      this.vadWorker.terminate();
      this.vadWorker = null;
    }
    if (this.asrWorker) {
      this.asrWorker.terminate();
      this.asrWorker = null;
    }
    this.vadReady = false;
    this.asrReady = false;
    this.asrBusy = false;
    this.pendingSegments = [];
    const fs = window.require?.("fs") || require("fs");
    const readBuf = (p) => {
      const buf = fs.readFileSync(p);
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return ab;
    };
    const readText = (p) => fs.readFileSync(p, "utf-8");
    this.addLog("[workers] ensureWasmFile...");
    const wasmPath = this.pluginDir + "/lib/ort-wasm-simd-threaded.wasm";
    await ensureWasmFile(wasmPath, this.addLog.bind(this));
    const simdWasm = readBuf(wasmPath);
    const jsepWasmPath = this.pluginDir + "/lib/ort-wasm-simd-threaded.jsep.wasm";
    const jsepWasm = fs.existsSync(jsepWasmPath) ? readBuf(jsepWasmPath) : null;
    this.addLog(`[workers] wasm: simd=${(simdWasm.byteLength / 1024 / 1024).toFixed(1)}MB jsep=${jsepWasm ? (jsepWasm.byteLength / 1024 / 1024).toFixed(1) + "MB" : "missing"}`);
    this.addLog(`[workers] wasm loaded: ${(simdWasm.byteLength / 1024 / 1024).toFixed(1)}MB`);
    const baseDir = this.settings.modelBasePath.replace(/\\/g, "/").replace(/\/$/, "") || `${this.pluginDir.replace(/\\/g, "/")}/models`;
    const modelsJsonPath = `${this.pluginDir.replace(/\\/g, "/")}/models.json`;
    if (fs.existsSync(modelsJsonPath)) {
      await ensureModels(
        baseDir,
        modelsJsonPath,
        this.addLog.bind(this),
        (_phase, _pct) => {
        }
      );
    }
    const vadDir = `${baseDir}/vad/speech_fsmn_vad_zh-cn-16k-common-onnx`;
    const asrDir = `${baseDir}/asr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`;
    const puncDir = `${baseDir}/punc/punc_ct-transformer_zh-cn-common-vocab272727-onnx`;
    this.addLog("[workers] loading models...");
    const vadModelBuf = readBuf(`${vadDir}/model_quant.onnx`);
    const vadCmvn = readText(`${vadDir}/am.mvn`);
    const asrModelBuf = readBuf(`${asrDir}/model_quant.onnx`);
    const asrCmvn = readText(`${asrDir}/am.mvn`);
    const puncModelBuf = readBuf(`${puncDir}/model_quant.onnx`);
    const tokensJson = JSON.parse(readText(`${asrDir}/tokens.json`));
    const puncTokensJson = JSON.parse(readText(`${puncDir}/tokens.json`));
    this.addLog(`[workers] models: vad=${vadModelBuf.byteLength} asr=${asrModelBuf.byteLength} punc=${puncModelBuf.byteLength}`);
    const asrHead = new Uint8Array(asrModelBuf.slice(0, 4));
    this.addLog(`[workers] asr header: ${Array.from(asrHead).map((b) => b.toString(16).padStart(2, "0")).join("")}`);
    this.addLog("[workers] creating VAD worker...");
    const vadCode = fs.readFileSync(this.pluginDir + "/worker-vad.js", "utf-8");
    const vadBlob = new Blob([vadCode], { type: "application/javascript" });
    this.vadWorker = new Worker(URL.createObjectURL(vadBlob), { type: "module" });
    this.vadWorker.onerror = (e) => {
      console.error("[VoiceSolo] VAD Worker error:", e.message);
      view.setStatus("error", "VAD Worker: " + e.message);
    };
    this.vadWorker.onmessage = (e) => {
      this.handleVadMessage(e.data, view);
    };
    const vadBuf = vadModelBuf.slice(0);
    console.log(`[VoiceSolo] VAD postMessage: modelBuf=${vadBuf.byteLength} wasm=${simdWasm.byteLength}`);
    this.vadWorker.postMessage({
      type: "init",
      config: {
        vadModelBuffer: vadBuf,
        vadCmvnText: vadCmvn,
        simdWasm: simdWasm.slice(0)
      }
    });
    this.addLog("[workers] creating ASR worker...");
    const asrCode = fs.readFileSync(this.pluginDir + "/worker-asr.js", "utf-8");
    const asrBlob = new Blob([asrCode], { type: "application/javascript" });
    this.asrWorker = new Worker(URL.createObjectURL(asrBlob), { type: "module" });
    this.asrWorker.onerror = (e) => {
      console.error("[VoiceSolo] ASR Worker error:", e.message);
      view.setStatus("error", "ASR Worker: " + e.message);
    };
    this.asrWorker.onmessage = (e) => {
      this.handleAsrMessage(e.data, view);
    };
    const asrBuf = asrModelBuf.slice(0);
    const puncBuf = puncModelBuf.slice(0);
    console.log(`[VoiceSolo] ASR postMessage: asrBuf=${asrBuf.byteLength} puncBuf=${puncBuf.byteLength} wasm=${simdWasm.byteLength}`);
    this.asrWorker.postMessage({
      type: "init",
      config: {
        asrModelBuffer: asrBuf,
        puncModelBuffer: puncBuf,
        asrCmvnText: asrCmvn,
        tokensJson,
        puncTokensJson,
        simdWasm: simdWasm.slice(0)
      }
    });
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (this.vadReady && this.asrReady) {
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });
  }
  // ---- Message routing ----
  handleVadMessage(msg, view) {
    if (msg.type !== "progress") this.addLog(`VAD \u2192 ${msg.type}${"status" in msg ? ":" + msg.status : ""}`);
    switch (msg.type) {
      case "ready":
        this.vadReady = true;
        this.addLog(`VAD ready, asrReady=${this.asrReady}`);
        if (this.asrReady) {
          view.setStatus("ready", "\u6A21\u578B\u5C31\u7EEA \u2014 \u5F00\u59CB\u8BC6\u522B");
          this.vadWorker.postMessage({ type: "start" });
          this.addLog("START sent to VAD");
        }
        break;
      case "status":
        if (msg.status === "listening") view.setStatus("recording", "\u76D1\u542C\u4E2D...");
        else if (msg.status === "speech") view.setStatus("recording", "\u8BF4\u8BDD\u4E2D...");
        break;
      case "segment":
        this.addLog(`VAD segment ${(msg.startMs / 1e3).toFixed(1)}s-${(msg.endMs / 1e3).toFixed(1)}s`);
        this.dispatchSegment(msg.audio, msg.startMs, msg.endMs);
        break;
      case "error":
        this.addLog(`VAD ERROR: ${msg.message}`);
        view.setStatus("error", msg.message);
        this.flushLog("VAD-error");
        break;
      case "progress":
        break;
    }
  }
  handleAsrMessage(msg, view) {
    if (msg.type !== "progress") this.addLog(`ASR \u2192 ${msg.type}${"status" in msg ? ":" + msg.status : ""}`);
    switch (msg.type) {
      case "ready":
        this.asrReady = true;
        this.addLog(`ASR ready, vadReady=${this.vadReady}`);
        if (this.vadReady) {
          view.setStatus("ready", "\u6A21\u578B\u5C31\u7EEA \u2014 \u5F00\u59CB\u8BC6\u522B");
          this.vadWorker.postMessage({ type: "start" });
          this.addLog("START sent to VAD");
        }
        break;
      case "status":
        if (msg.status === "asr") view.setStatus("processing", "\u8BC6\u522B\u4E2D...");
        else if (msg.status === "punc") view.setStatus("processing", "\u6807\u70B9\u4E2D...");
        break;
      case "result": {
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
      case "error":
        this.addLog(`ASR ERROR: ${msg.message}`);
        view.setStatus("error", msg.message);
        this.asrBusy = false;
        this.drainPending();
        this.flushLog("ASR-error");
        break;
      case "progress":
        break;
    }
  }
  dispatchSegment(audioBuf, startMs, endMs) {
    if (this.asrBusy) {
      this.addLog(`DISPATCH queue (busy, pending=${this.pendingSegments.length + 1})`);
      if (this.pendingSegments.length < 3) {
        this.pendingSegments.push({
          audio: new Float32Array(audioBuf),
          startMs,
          endMs
        });
      }
      return;
    }
    this.addLog(`DISPATCH send to ASR`);
    this.asrBusy = true;
    const audio = new Float32Array(audioBuf);
    this.asrWorker.postMessage(
      { type: "segment", audio: audio.buffer, startMs, endMs },
      [audio.buffer]
    );
  }
  drainPending() {
    if (this.pendingSegments.length === 0) return;
    this.addLog(`DISPATCH drain (pending=${this.pendingSegments.length})`);
    const next = this.pendingSegments.shift();
    this.asrBusy = true;
    this.asrWorker.postMessage(
      { type: "segment", audio: next.audio.buffer, startMs: next.startMs, endMs: next.endMs },
      [next.audio.buffer]
    );
  }
  // ---- File output helpers ----
  async ensureFolder(folderPath) {
    const parts = folderPath.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? cur + "/" + part : part;
      if (!cur) continue;
      try {
        if (!this.app.vault.getAbstractFileByPath(cur)) {
          await this.app.vault.createFolder(cur);
        }
      } catch {
      }
    }
  }
  async ensureOutputFile() {
    const now = /* @__PURE__ */ new Date();
    const ds = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const folder = this.settings.outputFolder || "Transcriptions";
    await this.ensureFolder(folder);
    this.currentNotePath = `${folder}/\u8F6C\u5F55_${ds}.md`;
    try {
      const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
      if (!file) {
        await this.app.vault.create(this.currentNotePath, `# \u8F6C\u5F55 ${ds}

`);
      }
    } catch {
    }
  }
  async insertNoteHeader() {
    if (!this.currentNotePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const now = /* @__PURE__ */ new Date();
    const ts = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const header = `

---
### ${ts}
`;
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, content + header);
  }
  async insertAudioPlaceholder(filename) {
    if (!this.currentNotePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const placeholder = `\u{1F534} \u5F55\u97F3\u4E2D \u2014 ${filename}
`;
    this.pendingPlaceholder = placeholder;
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, content + placeholder);
  }
  async replacePlaceholderWithEmbed() {
    if (!this.currentNotePath || !this.pendingPlaceholder || !this.recordingPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const folder = this.settings.recordingFolder || "Recordings";
    const wavName = this.recordingPath.replace(/\\/g, "/").split("/").pop().replace(".flac", ".wav");
    const flacName = this.recordingPath.replace(/\\/g, "/").split("/").pop();
    const embed = `![[${folder}/${wavName}]]  
*FLAC: ${flacName}*`;
    const content = await this.app.vault.read(file);
    const replaced = content.replace(this.pendingPlaceholder.trim(), embed);
    await this.app.vault.modify(file, replaced);
    this.pendingPlaceholder = "";
  }
  appendToNote(text) {
    if (!this.currentNotePath || !text) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    this.app.vault.read(file).then((content) => {
      this.app.vault.modify(file, content + text);
    });
  }
  insertRecordingEmbed() {
    if (!this.currentNotePath || !this.recordingPath) return;
    const file = this.app.vault.getAbstractFileByPath(this.currentNotePath);
    if (!file) return;
    const fname = this.recordingPath.replace(/\\/g, "/").split("/").pop() || "";
    const folder = this.settings.recordingFolder || "Recordings";
    const embed = `
![[${folder}/${fname}]]
`;
    this.app.vault.read(file).then((content) => {
      this.app.vault.modify(file, content + embed);
    });
  }
  // ---- Audio capture ----
  async startMic(view) {
    this.addLog("[mic] getUserMedia...");
    const audioConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    };
    if (this.settings.audioDevice) {
      audioConstraints.deviceId = { exact: this.settings.audioDevice };
    }
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });
    this.addLog("[mic] got stream");
    this.audioCtx = new AudioContext();
    this.addLog(`[mic] AudioContext sampleRate=${this.audioCtx.sampleRate}`);
    const fs = window.require?.("fs") || require("fs");
    const workletCode = fs.readFileSync(this.pluginDir + "/mic_worklet.js", "utf-8");
    const workletBlob = new Blob([workletCode], { type: "application/javascript" });
    await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(workletBlob));
    this.addLog("[mic] worklet loaded");
    this.workletNode = new AudioWorkletNode(this.audioCtx, "mic-processor");
    this.workletNode.port.onmessage = (e) => {
      if (this.flacEncoder) {
        const flacFs = window.require?.("fs") || require("fs");
        this.flacEncoder.processChunk(new Float32Array(e.data), flacFs);
      }
      if (this.vadWorker) {
        this.vadWorker.postMessage({ type: "chunk", data: e.data }, [e.data]);
      }
    };
    const source = this.audioCtx.createMediaStreamSource(this.micStream);
    source.connect(this.workletNode);
    this.addLog("[mic] connected");
  }
  // ---- Settings ----
  async loadSettings() {
    const saved = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (saved.autoSaveToNote && !saved.outputToNote) {
      this.settings.outputToNote = true;
    }
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
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Voice Solo Settings" });
    this.sectionHeading(containerEl, "\u6A21\u578B\u9009\u62E9");
    new import_obsidian2.Setting(containerEl).setName("\u63A8\u7406\u7CBE\u5EA6").setDesc("\u6807\u51C6\uFF1AONNX WASM CPU \u672C\u5730\u63A8\u7406\uFF0C\u5F53\u524D\u53EF\u7528 | \u9AD8\u6027\u80FD\uFF1AONNX WebGPU \u63A8\u7406\uFF08\u8BA1\u5212\u652F\u6301\uFF09").addDropdown((d) => {
      d.addOption("standard", "\u6807\u51C6 (ONNX WASM)");
      d.addOption("performance", "\u9AD8\u6027\u80FD (ONNX WebGPU)");
      d.setValue(s.asrModelTier);
      d.onChange(async (v) => {
        this.plugin.settings.asrModelTier = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("\u6A21\u578B\u76EE\u5F55").setDesc("FunASR \u6A21\u578B\u7684\u672C\u5730\u6839\u76EE\u5F55\uFF0C\u542B vad/, asr/, punc/ \u5B50\u76EE\u5F55\u3002\u7559\u7A7A\u5219\u4F7F\u7528\u63D2\u4EF6\u5185\u7F6E models.json \u4E0B\u8F7D\u5230 lib/models/").addText((text) => text.setPlaceholder("\u7559\u7A7A\u4F7F\u7528\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55").setValue(s.modelBasePath).onChange(async (v) => {
      this.plugin.settings.modelBasePath = v;
      await this.plugin.saveSettings();
    }));
    this.sectionHeading(containerEl, "\u8F93\u51FA\u8BBE\u7F6E");
    let outputFolderText;
    let recordingFolderText;
    new import_obsidian2.Setting(containerEl).setName("\u8F93\u51FA\u81F3\u6587\u6863").setDesc("\u5F00\u542F\u540E\u5C06\u8F6C\u5F55\u6587\u672C\u5199\u5165\u7B14\u8BB0\u6587\u4EF6\uFF0C\u5173\u95ED\u540E\u4EC5\u5728\u9762\u677F\u4E2D\u663E\u793A").addToggle((toggle) => {
      toggle.setValue(s.outputToNote);
      toggle.onChange(async (v) => {
        this.plugin.settings.outputToNote = v;
        await this.plugin.saveSettings();
        this.setDependentDisabled(outputFolderText, !v);
      });
    });
    const outputFolderSetting = new import_obsidian2.Setting(containerEl).setName("\u8F6C\u5F55\u6587\u672C\u8DEF\u5F84").setDesc("\u8F6C\u5F55\u6587\u672C\u7684\u8F93\u51FA\u8DEF\u5F84\uFF08\u76F8\u5BF9\u4E8E\u4FDD\u9669\u5E93\u6839\u76EE\u5F55\uFF09").setClass("voice-solo-setting-indent").addText((text) => {
      outputFolderText = text;
      text.setPlaceholder("Transcriptions");
      text.setValue(s.outputFolder);
      text.onChange(async (v) => {
        this.plugin.settings.outputFolder = v;
        await this.plugin.saveSettings();
      });
    });
    this.setDependentDisabled(outputFolderText, !s.outputToNote);
    new import_obsidian2.Setting(containerEl).setName("\u4FDD\u5B58\u5F55\u97F3\u6587\u4EF6").setDesc("\u5F55\u97F3\u7ED3\u675F\u540E\u4FDD\u5B58\u97F3\u9891\u6587\u4EF6").addToggle((toggle) => {
      toggle.setValue(s.saveAudio);
      toggle.onChange(async (v) => {
        this.plugin.settings.saveAudio = v;
        await this.plugin.saveSettings();
        this.setDependentDisabled(recordingFolderText, !v);
      });
    });
    const recordingFolderSetting = new import_obsidian2.Setting(containerEl).setName("\u5F55\u97F3\u6587\u4EF6\u8DEF\u5F84").setDesc("\u5F55\u97F3\u6587\u4EF6\u7684\u8F93\u51FA\u8DEF\u5F84\uFF08\u76F8\u5BF9\u4E8E\u4FDD\u9669\u5E93\u6839\u76EE\u5F55\uFF09").setClass("voice-solo-setting-indent").addText((text) => {
      recordingFolderText = text;
      text.setPlaceholder("Recordings");
      text.setValue(s.recordingFolder);
      text.onChange(async (v) => {
        this.plugin.settings.recordingFolder = v;
        await this.plugin.saveSettings();
      });
    });
    this.setDependentDisabled(recordingFolderText, !s.saveAudio);
    new import_obsidian2.Setting(containerEl).setName("\u505C\u6B62\u65F6\u8FDB\u884C\u4E8C\u6B21\u8BC6\u522B").setDesc("\u5F55\u97F3\u7ED3\u675F\u540E\u4F7F\u7528\u66F4\u9AD8\u7CBE\u5EA6\u6A21\u578B\u91CD\u65B0\u8BC6\u522B\u6574\u6BB5\u97F3\u9891\uFF0C\u8F93\u51FA\u5B8C\u6574\u6587\u672C").addToggle((toggle) => {
      toggle.setValue(s.postProcessEnabled);
      toggle.onChange(async (v) => {
        this.plugin.settings.postProcessEnabled = v;
        await this.plugin.saveSettings();
      });
    });
    this.sectionHeading(containerEl, "\u97F3\u9891\u8BBE\u7F6E");
    let audioSelectEl;
    const audioSetting = new import_obsidian2.Setting(containerEl).setName("\u9EA6\u514B\u98CE\u8BBE\u5907").setDesc("\u9009\u62E9\u5F55\u97F3\u4F7F\u7528\u7684\u9EA6\u514B\u98CE\u3002\u70B9\u51FB\u5237\u65B0\u83B7\u53D6\u8BBE\u5907\u5217\u8868\uFF08\u9700\u6388\u6743\u9EA6\u514B\u98CE\u6743\u9650\uFF09").addDropdown((d) => {
      d.addOption("", "\u9ED8\u8BA4\u9EA6\u514B\u98CE");
      if (s.audioDevice) d.addOption(s.audioDevice, s.audioDevice);
      d.setValue(s.audioDevice);
      audioSelectEl = d.selectEl;
      d.onChange(async (v) => {
        this.plugin.settings.audioDevice = v;
        await this.plugin.saveSettings();
      });
    });
    audioSetting.addExtraButton((btn) => {
      btn.setIcon("refresh-cw");
      btn.setTooltip("\u5237\u65B0\u8BBE\u5907\u5217\u8868");
      btn.onClick(async () => {
        await this.refreshAudioDevices(audioSelectEl);
      });
    });
    this.refreshAudioDevices(audioSelectEl);
    this.sectionHeading(containerEl, "\u9AD8\u7EA7");
    new import_obsidian2.Setting(containerEl).setName("\u70ED\u8BCD\u66FF\u6362\u8868").setDesc('JSON \u683C\u5F0F: {"\u8BEF\u8BC6\u522B\u8BCD": "\u6B63\u786E\u8BCD", ...}').addTextArea((text) => text.setPlaceholder('{"\u7535\u7F06": "\u975B\u84DD", "\u4E91\u6735": "\u5432\u54DA"}').setValue(JSON.stringify(s.hotWords, null, 2)).onChange(async (v) => {
      try {
        this.plugin.settings.hotWords = JSON.parse(v || "{}");
        await this.plugin.saveSettings();
      } catch {
      }
    }));
  }
  sectionHeading(el, title) {
    const h = el.createDiv({ cls: "voice-solo-settings-heading" });
    h.setText(title);
  }
  /** Disable the text input AND the setting row label/desc. */
  setDependentDisabled(textComp, disabled) {
    if (!textComp) return;
    textComp.inputEl.disabled = disabled;
    const row = textComp.inputEl.closest(".setting-item");
    if (row) {
      const info = row.querySelector(".setting-item-info");
      if (info) info.style.opacity = disabled ? "0.4" : "1";
      row.classList.toggle("voice-solo-setting-disabled", disabled);
    }
  }
  async refreshAudioDevices(selectEl) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const currentVal = selectEl.value;
      selectEl.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "\u9ED8\u8BA4\u9EA6\u514B\u98CE";
      selectEl.appendChild(opt);
      for (const d of inputs) {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || `\u8BBE\u5907 ${d.deviceId.slice(0, 8)}...`;
        if (d.deviceId === currentVal) o.selected = true;
        selectEl.appendChild(o);
      }
    } catch (e) {
      console.warn("[VoiceSolo] Cannot enumerate audio devices:", e);
    }
  }
};
