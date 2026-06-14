// FLAC encoder using libFLAC WASM (via @mediabunny/flac-encoder bridge)
//
// Streaming: writes header on open, frames as encoded, fixes header on close.

type FlacModule = {
  cwrap: (name: string, ret: string, args: string[]) => (...a: number[]) => number;
  HEAPU8: Uint8Array;
};

let flacModule: FlacModule | null = null;
let flacModulePromise: Promise<FlacModule> | null = null;

// C bridge function pointers (resolved after module init)
let initEncoderFn: (ch: number, sr: number, bps: number) => number;
let getEncodeInputPtr: (ctx: number, size: number) => number;
let sendSamplesFn: (ctx: number, n: number) => number;
let getOutputData: (ctx: number) => number;
let getFrameCount: (ctx: number) => number;
let getFrameSize: (ctx: number, i: number) => number;
let getHeaderData: (ctx: number) => number;
let getHeaderSize: (ctx: number) => number;
let finishEncoderFn: (ctx: number) => number;

async function ensureFlacModule(): Promise<FlacModule> {
  if (flacModule) return flacModule;
  if (flacModulePromise) return flacModulePromise;

  flacModulePromise = (async () => {
    const fs: any = (globalThis as any).require?.('fs') || require('fs');
    const path: any = (globalThis as any).require?.('path') || require('path');

    // Load flac.js at runtime (not bundled by esbuild, avoids import.meta.url issue)
    // Use FlacEncoder.pluginDir if set, fallback to __dirname
    const baseDir = (FlacEncoder as any).pluginDir || __dirname;
    const libPath = path.join(baseDir, 'flac.js');
    let code = fs.readFileSync(libPath, 'utf-8');
    // Patch import.meta.url — not available in new Function() context, and unused (WASM is inlined)
    code = code.replace('import.meta.url', 'undefined');

    // Evaluate the module: it's CJS with `exports.default = Module`
    const fakeModule: any = { exports: {} };
    const fakeExports: any = {};
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    fn(fakeExports, require, fakeModule, libPath, path.dirname(libPath));

    const createModule = fakeExports.default || fakeModule.exports?.default;
    if (!createModule) throw new Error('flac.js: cannot find default export');

    const emMod: FlacModule = await createModule();
    flacModule = emMod;

    initEncoderFn = emMod.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    getEncodeInputPtr = emMod.cwrap('get_encode_input_ptr', 'number', ['number', 'number']);
    sendSamplesFn = emMod.cwrap('send_samples', 'number', ['number', 'number']);
    getOutputData = emMod.cwrap('get_output_data', 'number', ['number']);
    getFrameCount = emMod.cwrap('get_frame_count', 'number', ['number']);
    getFrameSize = emMod.cwrap('get_frame_size', 'number', ['number', 'number']);
    getHeaderData = emMod.cwrap('get_header_data', 'number', ['number']);
    getHeaderSize = emMod.cwrap('get_header_size', 'number', ['number']);
    finishEncoderFn = emMod.cwrap('finish_encoder', 'number', ['number']);

    return emMod;
  })();

  return flacModulePromise;
}

// ---- Public API ----

export class FlacEncoder {
  /** Set by main.ts to resolve lib/flac.js path */
  static pluginDir: string = '';
  private sampleRate: number;
  private blockSize: number;
  private accum = new Float32Array(0);
  private fdFlac: number | null = null;
  private totalSamples = 0;
  private flacPath = '';
  private ctx: number | null = null;   // WASM encoder context pointer
  private mod: FlacModule | null = null;
  private headerBytes: Uint8Array | null = null;

  constructor(sampleRate: number = 16000, blockSize: number = 4096) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
  }

  /** Open FLAC file (streaming). Must be awaited. */
  async open(flacFilepath: string, fs: any) {
    this.flacPath = flacFilepath;
    this.totalSamples = 0;
    this.accum = new Float32Array(0);

    const dir = flacFilepath.replace(/[/\\][^/\\]*$/, '');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    // Initialize WASM encoder
    this.mod = await ensureFlacModule();
    this.ctx = initEncoderFn(1, this.sampleRate, 16);
    if (!this.ctx) throw new Error('FLAC: init_encoder failed');

    // Capture stream header (fLaC + STREAMINFO + optional metadata)
    const hdrPtr = getHeaderData(this.ctx);
    const hdrSize = getHeaderSize(this.ctx);
    this.headerBytes = this.mod.HEAPU8.slice(hdrPtr, hdrPtr + hdrSize);

    // Write header to file
    this.fdFlac = fs.openSync(flacFilepath, 'w');
    fs.writeSync(this.fdFlac, Buffer.from(this.headerBytes));
  }

  /** Feed audio chunk. Encoded FLAC frames are appended immediately. */
  async processChunk(chunk: Float32Array, fs: any) {
    const merged = new Float32Array(this.accum.length + chunk.length);
    merged.set(this.accum);
    merged.set(chunk, this.accum.length);
    this.accum = merged;

    while (this.accum.length >= this.blockSize) {
      const block = this.accum.slice(0, this.blockSize);
      this.accum = this.accum.slice(this.blockSize);
      await this.encodeAndWrite(block, fs);
    }
  }

  private async encodeAndWrite(block: Float32Array, fs: any) {
    if (!this.mod || !this.ctx) return;
    const n = block.length;

    // Float32 → Int32 with audio in upper 16 bits
    // bridge.c does: input_buffer[i] >>= (32 - bits_per_sample)  i.e. >>= 16
    // So we must put 16-bit data in the HIGH 16 bits of each int32
    const i32 = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      i32[i] = Math.round(Math.max(-1, Math.min(1, block[i])) * 32767) << 16;
    }

    // Copy into WASM heap
    const byteLen = i32.byteLength;
    const inputPtr = getEncodeInputPtr(this.ctx, byteLen);
    this.mod.HEAPU8.set(new Uint8Array(i32.buffer), inputPtr);

    // Encode
    const ret = sendSamplesFn(this.ctx, n);
    if (ret < 0) throw new Error(`FLAC encode failed: ${ret}`);

    // Read and write encoded frames
    const frameCount = getFrameCount(this.ctx);
    if (frameCount === 0) return;
    const outPtr = getOutputData(this.ctx);
    let offset = 0;
    for (let i = 0; i < frameCount; i++) {
      const sz = getFrameSize(this.ctx, i);
      const frameData = this.mod.HEAPU8.slice(outPtr + offset, outPtr + offset + sz);
      if (this.fdFlac !== null) fs.writeSync(this.fdFlac, Buffer.from(frameData));
      offset += sz;
    }

    this.totalSamples += n;
  }

  /** Flush remaining, fix headers, close files. Returns debug info string. */
  close(fs: any): string {
    const dbg: string[] = [];

    // Flush remaining samples as a final (possibly shorter) block
    if (this.accum.length > 0 && this.mod && this.ctx) {
      const n = this.accum.length;
      const i32 = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        i32[i] = Math.round(Math.max(-1, Math.min(1, this.accum[i])) * 32767) << 16;
      }
      const inputPtr = getEncodeInputPtr(this.ctx, i32.byteLength);
      this.mod.HEAPU8.set(new Uint8Array(i32.buffer), inputPtr);
      sendSamplesFn(this.ctx, n);
      this.totalSamples += n;
    }
    this.accum = new Float32Array(0);

    dbg.push(`totalSamples=${this.totalSamples}`);

    // Fix STREAMINFO total_samples in the header already written to disk
    // Header layout: [0:4]="fLaC" [4:8]=STREAMINFO block hdr [8:41]=STREAMINFO data
    // total_samples = 36 bits at STREAMINFO bit 108 = byte 13.5 of data = file offset 21
    if (this.fdFlac !== null && this.headerBytes) {
      const total = this.totalSamples;
      const buf = Buffer.alloc(5);
      buf[0] = 0xF0 | ((total >>> 32) & 0x0F);
      buf.writeUInt32BE(total & 0xFFFFFFFF, 1);
      fs.writeSync(this.fdFlac, buf, 0, 5, 21);
      dbg.push(`patched total_samples at offset 21`);

      fs.closeSync(this.fdFlac);
      this.fdFlac = null;

      // Self-check
      try {
        const check = fs.readFileSync(this.flacPath);
        dbg.push(`fileSize=${check.length}`);
        const magic = String.fromCharCode(...check.slice(0, 4));
        dbg.push(`magic="${magic}"` + (magic === 'fLaC' ? ' OK' : ' BAD'));
        if (check.length > 44) {
          const syncHi = check[this.headerBytes.length];
          const syncLo = check[this.headerBytes.length + 1];
          const sync = ((syncHi & 0xFF) << 6) | ((syncLo & 0xFC) >> 2);
          dbg.push(`frame0 sync=0x${sync.toString(16)}` + (sync === 0x3FFE ? ' OK' : ' BAD'));
        }
      } catch (e: any) {
        dbg.push(`selfCheck error: ${e.message}`);
      }
    }

    // Release WASM context
    if (this.ctx && this.mod) {
      finishEncoderFn(this.ctx);
      this.ctx = null;
    }

    return dbg.join(' | ');
  }
}
