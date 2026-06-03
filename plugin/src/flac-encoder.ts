// FLAC encoder + WAV fallback for diagnostics
//
// Streaming FLAC: writes header on open, frames as encoded, fixes header on close.
// Also saves a WAV copy for comparison to isolate encoding vs capture issues.

const BLOCK_SIZE = 4096;
const RICE_PARTITION_ORDER = 2;
const RICE_PARTITION_SIZE = BLOCK_SIZE >> RICE_PARTITION_ORDER;
const MAX_RICE_K = 14;

// ---- Bit buffer ----

class BitBuf {
  private bytes: number[] = [];
  private cur = 0;
  private pos = 0;

  write(v: number, n: number) {
    if (n <= 0) return;
    v = v & ((1 << n) - 1);
    while (n > 0) {
      const room = 8 - this.pos;
      const take = Math.min(n, room);
      this.cur |= (v >>> (n - take)) << (room - take);
      this.pos += take; n -= take;
      v = v & ((1 << n) - 1);
      if (this.pos === 8) { this.bytes.push(this.cur); this.cur = 0; this.pos = 0; }
    }
  }

  writeUnary(v: number) {
    while (v >= 8 - this.pos) {
      const room = 8 - this.pos;
      this.cur |= ((1 << room) - 1) << 0;
      this.bytes.push(this.cur); this.cur = 0; this.pos = 0;
      v -= room;
    }
    if (v > 0) { this.cur |= ((1 << v) - 1) << (8 - this.pos - v); this.pos += v; }
    this.pos++;
    if (this.pos === 8) { this.bytes.push(this.cur); this.cur = 0; this.pos = 0; }
  }

  writeRiceSigned(v: number, k: number) {
    const u = v >= 0 ? (v << 1) : ((-v << 1) - 1);
    const q = u >>> k, r = u & ((1 << k) - 1);
    this.writeUnary(q);
    if (k > 0) this.write(r, k);
  }

  flush() { if (this.pos > 0) { this.bytes.push(this.cur); this.cur = 0; this.pos = 0; } }
  toUint8(): Uint8Array { this.flush(); return new Uint8Array(this.bytes); }
}

// ---- CRC (masked to 8/16 bits after each shift) ----

function crc8(data: Uint8Array, start: number, len: number): number {
  let c = 0;
  for (let i = start; i < start + len; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xFF) : ((c << 1) & 0xFF);
  }
  return c & 0xFF;
}

function crc16(data: Uint8Array, start: number, len: number): number {
  let c = 0;
  for (let i = start; i < start + len; i++) {
    c ^= (data[i] << 8);
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? (((c << 1) ^ 0x8005) & 0xFFFF) : ((c << 1) & 0xFFFF);
  }
  return c & 0xFFFF;
}

// ---- FIXED predictor ----

const FIXED_COEFFS: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function computeResiduals(samples: Int16Array, block: number, order: number, out: Int32Array): number {
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

// ---- FLAC structures ----

function buildStreaminfo(sampleRate: number, totalSamples: number): Uint8Array {
  const out = new Uint8Array(4 + 34);
  out[0] = 0x80; out[1] = 0x00; out[2] = 0x00; out[3] = 0x22;
  const b = new BitBuf();
  b.write(BLOCK_SIZE, 16); b.write(BLOCK_SIZE, 16);
  b.write(0, 24); b.write(0, 24);
  b.write(sampleRate, 20); b.write(0, 3); b.write(15, 5);
  b.write(totalSamples, 36); b.write(0, 128);
  out.set(b.toUint8(), 4);
  return out;
}

function encodeFrame(samples: Int16Array, n: number, frameNum: number,
                     order: number, warmup: number, subframeBytes: Uint8Array): Uint8Array {
  const hdr = new BitBuf();
  hdr.write(0x3FFE, 14); hdr.write(0, 1);
  hdr.write(0x1, 4); hdr.write(0x0, 4); hdr.write(0x0, 4); hdr.write(0x1, 3); hdr.write(0, 1);
  if (frameNum < 128) hdr.write(frameNum, 8);
  else if (frameNum < 2048) { hdr.write(0xC0 | (frameNum >>> 6), 8); hdr.write(0x80 | (frameNum & 0x3F), 8); }
  hdr.write((n - 1) & 0xFF, 8);

  const hdrBytes = hdr.toUint8();
  const hdrWithCrc = new Uint8Array(hdrBytes.length + 1);
  hdrWithCrc.set(hdrBytes, 0);
  hdrWithCrc[hdrBytes.length] = crc8(hdrBytes, 0, hdrBytes.length);

  const frame = new Uint8Array(hdrWithCrc.length + subframeBytes.length + 2);
  frame.set(hdrWithCrc, 0);
  frame.set(subframeBytes, hdrWithCrc.length);
  const c16 = crc16(frame, 0, frame.length - 2);
  frame[frame.length - 2] = (c16 >>> 8) & 0xFF;
  frame[frame.length - 1] = c16 & 0xFF;
  return frame;
}

function encodeSingleBlock(samples: Int16Array, n: number, frameNum: number): Uint8Array {
  const residuals = new Int32Array(BLOCK_SIZE);
  let bestOrder = 0, bestCost = Infinity;
  for (let order = 0; order <= 4; order++) {
    if (n <= order) continue;
    const cost = computeResiduals(samples, n, order, residuals);
    if (cost < bestCost) { bestCost = cost; bestOrder = order; }
  }

  const subframe = new BitBuf();
  const warmup = Math.min(bestOrder, n);
  subframe.write(0, 1);
  subframe.write(0x10 | (bestOrder & 0x07), 6);
  subframe.write(0, 1);

  for (let i = 0; i < warmup; i++) subframe.write(samples[i] & 0xFFFF, 16);

  const numParts = 1 << RICE_PARTITION_ORDER;
  for (let p = 0; p < numParts; p++) {
    const start = warmup + p * RICE_PARTITION_SIZE;
    const end = Math.min(start + RICE_PARTITION_SIZE, n);
    const riceBits = p === 0 ? 4 : 5;
    if (end <= start) { subframe.write(0, riceBits); continue; }

    let bestK = 0, bestBits = Infinity;
    for (let k = 0; k <= MAX_RICE_K; k++) {
      let bits = riceBits;
      for (let i = start; i < end; i++) {
        const u = residuals[i] >= 0 ? (residuals[i] << 1) : ((-residuals[i] << 1) - 1);
        bits += (u >>> k) + 1 + k;
      }
      if (bits < bestBits) { bestBits = bits; bestK = k; }
    }
    subframe.write(bestK, riceBits);
    for (let i = start; i < end; i++) subframe.writeRiceSigned(residuals[i], bestK);
  }

  return encodeFrame(samples, n, frameNum, bestOrder, warmup, subframe.toUint8());
}

// ---- WAV header (for diagnostics) ----

function buildWavHeader(dataSize: number, sampleRate: number): Uint8Array {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);       // chunk size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bps
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}

// ---- Public API ----

export class FlacEncoder {
  private sampleRate: number;
  private blockSize: number;
  private accum = new Float32Array(0);
  private fdFlac: number | null = null;
  private fdWav: number | null = null;
  private totalSamples = 0;
  private frameNum = 0;
  private flacPath = '';
  private wavPath = '';
  private minFrameSize = Infinity;
  private maxFrameSize = 0;

  constructor(sampleRate: number = 16000, blockSize: number = 4096) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
  }

  /** Open FLAC file (streaming), also open WAV for diagnostics. */
  open(flacFilepath: string, fs: any) {
    this.flacPath = flacFilepath;
    this.totalSamples = 0;
    this.frameNum = 0;
    this.accum = new Float32Array(0);
    this.minFrameSize = Infinity;
    this.maxFrameSize = 0;

    const dir = flacFilepath.replace(/[/\\][^/\\]*$/, '');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    // FLAC: write header with placeholder total_samples
    this.fdFlac = fs.openSync(flacFilepath, 'w');
    fs.writeSync(this.fdFlac, Buffer.from([0x66, 0x4C, 0x61, 0x43]));
    fs.writeSync(this.fdFlac, Buffer.from(buildStreaminfo(this.sampleRate, 0)));

    // WAV: write header with placeholder data size
    this.wavPath = flacFilepath.replace(/\.flac$/, '.wav');
    this.fdWav = fs.openSync(this.wavPath, 'w');
    fs.writeSync(this.fdWav, Buffer.from(buildWavHeader(0, this.sampleRate)));
  }

  /** Feed audio chunk. Encoded FLAC frames are appended immediately. WAV PCM is appended. */
  processChunk(chunk: Float32Array, fs: any) {
    const merged = new Float32Array(this.accum.length + chunk.length);
    merged.set(this.accum);
    merged.set(chunk, this.accum.length);
    this.accum = merged;

    // Encode full blocks
    while (this.accum.length >= this.blockSize) {
      const block = this.accum.slice(0, this.blockSize);
      this.accum = this.accum.slice(this.blockSize);
      this.encodeAndWrite(block, fs);
    }
  }

  private encodeAndWrite(block: Float32Array, fs: any) {
    const n = block.length;

    // Float32 → Int16
    const i16 = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      i16[i] = Math.round(Math.max(-1, Math.min(1, block[i])) * 32767);
    }

    // FLAC frame
    const flacFrame = encodeSingleBlock(i16, n, this.frameNum);
    this.frameNum++;
    this.totalSamples += n;

    const fsz = flacFrame.length;
    if (fsz < this.minFrameSize) this.minFrameSize = fsz;
    if (fsz > this.maxFrameSize) this.maxFrameSize = fsz;

    if (this.fdFlac !== null) {
      fs.writeSync(this.fdFlac, Buffer.from(flacFrame));
    }

    // WAV PCM (raw Int16 LE)
    if (this.fdWav !== null) {
      fs.writeSync(this.fdWav, Buffer.from(i16.buffer));
    }
  }

  /** Flush remaining, fix headers, close files. Returns debug info string. */
  close(fs: any): string {
    // Flush remaining samples as a final (possibly shorter) block
    if (this.accum.length > 0) {
      const block = new Float32Array(this.accum.length);
      block.set(this.accum);
      this.encodeAndWrite(block, fs);
    }
    this.accum = new Float32Array(0);

    const dbg: string[] = [];
    dbg.push(`frames=${this.frameNum} totalSamples=${this.totalSamples}`);

    // Fix FLAC STREAMINFO total_samples
    if (this.fdFlac !== null) {
      const total = this.totalSamples;
      const buf = Buffer.alloc(5);
      buf[0] = 0xF0 | ((total >>> 32) & 0x0F);
      buf.writeUInt32BE(total & 0xFFFFFFFF, 1);
      fs.writeSync(this.fdFlac, buf, 0, 5, 21);

      // Fix min/max frame size (24-bit big-endian at offset 12 and 15)
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

      // Self-check: read back and validate
      try {
        const check = fs.readFileSync(this.flacPath);
        dbg.push(`fileSize=${check.length}`);
        const magic = String.fromCharCode(...check.slice(0, 4));
        dbg.push(`magic="${magic}"` + (magic === 'fLaC' ? ' OK' : ' BAD'));
        // STREAMINFO block header
        const blkHdr = check[4];
        const isLast = (blkHdr & 0x80) !== 0;
        const blkType = blkHdr & 0x7F;
        dbg.push(`stINFO[last=${isLast} type=${blkType}]` + (blkType === 0 ? ' OK' : ' BAD'));
        // First 16 bytes hex
        const hex16 = Array.from(check.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        dbg.push(`head[0:16]=${hex16}`);
        // First frame sync (after STREAMINFO = offset 42)
        if (check.length > 44) {
          const syncHi = check[42], syncLo = check[43];
          const sync = ((syncHi & 0xFF) << 6) | ((syncLo & 0xFC) >> 2);
          dbg.push(`frame0[0:2]=${syncHi.toString(16).padStart(2,'0')} ${syncLo.toString(16).padStart(2,'0')} sync=${sync.toString(16)}` + (sync === 0x3FFE ? ' OK' : ' BAD'));
        } else {
          dbg.push(`frame0: file too short (no frame data)`);
        }
      } catch (e: any) {
        dbg.push(`selfCheck error: ${e.message}`);
      }
    }

    // Fix WAV header (file size + data size)
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

    return dbg.join(' | ');
  }

  /**
   * Debug: write a 1-second 440Hz test tone FLAC using the same encoder.
   * If this plays but the real recording doesn't, the issue is in audio capture.
   * If this also fails, the encoder has an Electron-specific bug.
   */
  static debugTestTone(filepath: string, fs: any): string {
    const sr = 16000;
    const duration = sr * 1; // 1 second
    const tone = new Float32Array(duration);
    for (let i = 0; i < duration; i++) {
      tone[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
    }

    const dir = filepath.replace(/[/\\][^/\\]*$/, '');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const i16 = new Int16Array(duration);
    for (let i = 0; i < duration; i++) i16[i] = Math.round(Math.max(-1, Math.min(1, tone[i])) * 32767);

    const fd = fs.openSync(filepath, 'w');
    fs.writeSync(fd, Buffer.from([0x66, 0x4C, 0x61, 0x43]));
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
    buf[0] = 0xF0 | ((totalSamples >>> 32) & 0x0F);
    buf.writeUInt32BE(totalSamples & 0xFFFFFFFF, 1);
    fs.writeSync(fd, buf, 0, 5, 21);
    // Fix min/max frame size
    const fbuf = Buffer.alloc(3);
    if (minFsz !== Infinity) { fbuf.writeUIntBE(minFsz, 0, 3); fs.writeSync(fd, fbuf, 0, 3, 12); }
    fbuf.writeUIntBE(maxFsz, 0, 3); fs.writeSync(fd, fbuf, 0, 3, 15);
    fs.closeSync(fd);

    // Validate
    try {
      const check = fs.readFileSync(filepath);
      const magic = String.fromCharCode(...check.slice(0, 4));
      return `testTone fileSize=${check.length} magic="${magic}"` + (magic === 'fLaC' ? ' OK' : ' BAD');
    } catch (e: any) {
      return `testTone error: ${e.message}`;
    }
  }
}
