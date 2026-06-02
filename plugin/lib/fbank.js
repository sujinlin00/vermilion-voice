// fbank.js — Pure JS fbank + LFR + CMVN feature extraction
// Reference: FunASR Python WavFrontend (kaldi_native_fbank based)
// Kaldi pipeline: PCM → pre-emphasis → framing → window → FFT → power → Mel → log

const PREEMPH_COEFF = 0.97; // Kaldi default
const FLT_EPSILON = 1.1920928955078125e-7; // float epsilon, used as energy floor

// =============================================================================
// FFT — Radix-2 DIT, in-place
// =============================================================================

function fft(re, im) {
  const n = re.length;
  // Bit reversal
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  // Radix-2 stages
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = -2.0 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const idx = i + j;
        const idxH = idx + half;
        const cos = Math.cos(angle * j);
        const sin = Math.sin(angle * j);
        const tr = re[idxH] * cos - im[idxH] * sin;
        const ti = re[idxH] * sin + im[idxH] * cos;
        re[idxH] = re[idx] - tr;
        im[idxH] = im[idx] - ti;
        re[idx] += tr;
        im[idx] += ti;
      }
    }
  }
}

// =============================================================================
// Mel filterbank — Kaldi-compatible triangular filters
// =============================================================================

function hzToMel(hz) {
  return 1127.0 * Math.log(1.0 + hz / 700.0);
}

function melToHz(mel) {
  return 700.0 * (Math.exp(mel / 1127.0) - 1.0);
}

function makeMelFilterbank(sampleRate, nfft, nMels, lowFreq = 20) {
  const nyquist = sampleRate / 2;
  const melLow = hzToMel(lowFreq);
  const melHigh = hzToMel(nyquist);
  const numBins = nfft / 2 + 1;

  // Compute CONTINUOUS FFT bin positions for nMels+2 mel points.
  // Kaldi uses continuous positions (not floored) for weight calculation,
  // which ensures every filter has non-zero width.
  const melStep = (melHigh - melLow) / (nMels + 1);
  const fftPos = new Float32Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    const mel = melLow + melStep * i;
    const hz = melToHz(mel);
    fftPos[i] = (nfft + 1) * hz / sampleRate; // continuous, not floored
  }

  // Build filters using the continuous-FFT-bin formula (Kaldi style).
  // For filter m: left=fftPos[m], center=fftPos[m+1], right=fftPos[m+2].
  // Integer bin range: [floor(left), ceil(right)).
  // Weight at bin k: (k-left)/(center-left) if k<center, else (right-k)/(right-center).
  const rows = new Array(nMels);
  for (let m = 0; m < nMels; m++) {
    const leftF = fftPos[m];
    const centerF = fftPos[m + 1];
    const rightF = fftPos[m + 2];

    const leftBin = Math.floor(leftF);
    const rightBin = Math.ceil(rightF);
    const row = new Float32Array(numBins);

    const ascDen = centerF - leftF;
    const descDen = rightF - centerF;

    for (let k = leftBin; k < rightBin && k < numBins; k++) {
      let w = 0;
      if (k < centerF && ascDen > 0) {
        w = (k - leftF) / ascDen;
      } else if (descDen > 0) {
        w = (rightF - k) / descDen;
      }
      // Kaldi clamps weights to [0, 1]
      if (w > 0) row[k] = Math.min(w, 1);
    }
    rows[m] = row;
  }
  return { rows, numBins };
}

// =============================================================================
// CMVN loader — parses Kaldi Nnet am.mvn format
// =============================================================================

export function loadCMVN(text) {
  const lines = text.split('\n');
  let means = null;
  let vars = null;

  for (let i = 0; i < lines.length; i++) {
    const items = lines[i].trim().split(/\s+/);
    if (items[0] === '<AddShift>') {
      const next = lines[i + 1].trim().split(/\s+/);
      if (next[0] === '<LearnRateCoef>') {
        means = next.slice(3, next.length - 1).map(Number);
      }
    } else if (items[0] === '<Rescale>') {
      const next = lines[i + 1].trim().split(/\s+/);
      if (next[0] === '<LearnRateCoef>') {
        vars = next.slice(3, next.length - 1).map(Number);
      }
    }
  }

  if (!means || !vars) throw new Error('Failed to parse am.mvn');
  return { means: new Float64Array(means), vars: new Float64Array(vars) };
}

// =============================================================================
// FbankProcessor — main class
// =============================================================================

export class FbankProcessor {
  /**
   * @param {Object} opts
   *   fs: 16000, n_mels: 80, frame_length_ms: 25, frame_shift_ms: 10,
   *   dither: 1.0, lfr_m: 7, lfr_n: 6, cmvn: null | {means, vars}
   */
  constructor(opts = {}) {
    this.sampleRate = opts.fs || 16000;
    this.nMels = opts.n_mels || 80;
    this.frameLengthMs = opts.frame_length_ms || 25;
    this.frameShiftMs = opts.frame_shift_ms || 10;
    this.dither = opts.dither != null ? opts.dither : 1.0;
    this.lfrM = opts.lfr_m || 7;
    this.lfrN = opts.lfr_n || 6;
    this.cmvn = opts.cmvn || null;

    // Kaldi rounds to nearest integer: static_cast<int32>(samp_freq * 0.001 * ms + 0.5)
    this.frameLength = Math.round(this.sampleRate * this.frameLengthMs / 1000);
    this.frameShift = Math.round(this.sampleRate * this.frameShiftMs / 1000);

    // FFT size = next power of 2 >= frameLength
    this.fftSize = 1;
    while (this.fftSize < this.frameLength) this.fftSize <<= 1; // 512

    // Precompute window (Hamming)
    this._window = new Float32Array(this.frameLength);
    for (let i = 0; i < this.frameLength; i++) {
      this._window[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (this.frameLength - 1));
    }

    // Precompute Mel filterbank
    this._mel = makeMelFilterbank(this.sampleRate, this.fftSize, this.nMels);
    this._melDim = this.nMels;

    // Streaming state
    this._preemphPrev = 0.0;
  }

  // ---------------------------------------------------------------------------
  // fbank(waveform) — convert PCM [-1,1] Float32Array → (feat, featLen)
  // Returns {feat: Float32Array[frames × nMels], featLen: number}
  //
  // Kaldi pipeline order:
  //   1. Pre-emphasis sequentially on the full waveform (each sample uses the
  //      *already modified* previous sample, coeff=0.97)
  //   2. Dither in integer domain (Gaussian, std=dither/32768 in float domain)
  //   3. Frame extraction + Hamming window
  //   4. FFT (radix-2) → power spectrum (|X|² / nfft)
  //   5. Mel filterbank (80 triangular filters)
  //   6. Log energy with floor = FLT_EPSILON
  // ---------------------------------------------------------------------------

  fbank(waveform) {
    const len = waveform.length;
    const frameLen = this.frameLength;
    const frameShift = this.frameShift;
    const nfft = this.fftSize;

    const KALDI_SCALE = 32768.0;
    const numFrames = Math.max(0, Math.floor((len - frameLen) / frameShift) + 1);
    const feat = new Float32Array(numFrames * this.nMels);

    const re = new Float32Array(nfft);
    const im = new Float32Array(nfft);
    const {rows: melRows, numBins} = this._mel;

    // dither std at Kaldi scale (dither=1.0 → std=1.0 on ×32768-scaled samples)
    const ditherStd = this.dither;

    // Pre-emphasis state: kaldi uses ORIGINAL (not pre-emphasized) sample as prev.
    // y[n] = x[n] - coeff * x[n-1]
    // For the first frame, if no prev chunk, kaldi uses x[0] as self-prev.
    let pePrev = this._preemphPrev;
    const isFirst = (pePrev === 0.0);

    for (let f = 0; f < numFrames; f++) {
      const start = f * frameShift;

      re.fill(0);
      im.fill(0);

      // 1. Copy frame samples (scaled), compute sum for DC offset
      let frameSum = 0;
      for (let i = 0; i < frameLen; i++) {
        re[i] = waveform[start + i] * KALDI_SCALE;
        frameSum += re[i];
      }

      // 2. Dither (applied BEFORE dc removal and pre-emphasis in kaldi)
      if (ditherStd > 0) {
        for (let i = 0; i < frameLen; i++) {
          let u1, u2;
          do { u1 = Math.random(); } while (u1 === 0);
          u2 = Math.random();
          re[i] += Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * ditherStd;
        }
        // Recompute sum if dithered (dither changes the DC)
        frameSum = 0;
        for (let i = 0; i < frameLen; i++) frameSum += re[i];
      }

      // 3. Remove DC offset
      const frameMean = frameSum / frameLen;
      for (let i = 0; i < frameLen; i++) {
        re[i] -= frameMean;
      }

      // 4. Pre-emphasis: y[i] = x[i] - coeff * originalPrev
      // kaldi stores the ORIGINAL sample (before pre-emphasis) as prev.
      for (let i = 0; i < frameLen; i++) {
        const original = re[i]; // x[i] (after dither, after dc removal)

        if (f === 0 && i === 0 && isFirst) {
          // First sample of first chunk: kaldi uses self as prev
          re[i] = original - PREEMPH_COEFF * original;
        } else if (f > 0 && i === 0) {
          // First sample of subsequent frame: use last ORIGINAL of prev frame
          re[i] = original - PREEMPH_COEFF * pePrev;
        } else {
          // Within-frame: use previous ORIGINAL sample
          // The previous iteration stored the original in pePrev
          re[i] = original - PREEMPH_COEFF * pePrev;
        }
        pePrev = original; // store ORIGINAL (not pre-emphasized) for next step
      }

      // 5. Apply Hamming window
      for (let i = 0; i < frameLen; i++) {
        re[i] *= this._window[i];
      }

      // 6. FFT
      fft(re, im);

      // 7. Power spectrum → mel filterbank → log
      const featOff = f * this.nMels;
      for (let m = 0; m < this.nMels; m++) {
        let sum = 0;
        const row = melRows[m];
        for (let k = 0; k < numBins; k++) {
          sum += row[k] * (re[k] * re[k] + im[k] * im[k]);
        }
        // kaldi-native-fbank does NOT divide power spectrum by nfft.
        // The FFT output |X|² is used directly.
        // Floor: kaldi-native-fbank uses log(max(log(eps), energy)) which
        // effectively disables the floor (log(eps) < 0 energy always).
        // We use max(0, energy) to guard against floating-point underflow.
        feat[featOff + m] = Math.log(Math.max(0, sum));
      }
    }

    this._preemphPrev = pePrev;
    return { feat, featLen: numFrames };
  }

  // ---------------------------------------------------------------------------
  // applyLFR(feat) — Low Frame Rate splicing
  // Stacks lfr_m frames into one super-frame, stride lfr_n
  // VAD: lfr_m=5, lfr_n=1  → 80mel × 5 = 400 dim
  // ASR: lfr_m=7, lfr_n=6  → 80mel × 7 = 560 dim
  // ---------------------------------------------------------------------------

  applyLFR(feat) {
    const lfrM = this.lfrM;
    const lfrN = this.lfrN;
    const D = this.nMels;
    const T = feat.length / D;

    if (!Number.isInteger(T)) throw new Error(`feat length ${feat.length} not divisible by dim ${D}`);

    const leftPad = (lfrM - 1) >> 1; // floor((lfrM-1)/2)
    const effectiveT = T + leftPad;
    const T_lfr = Math.ceil(T / lfrN);

    // Helper: get frame at index (with left-padding being repeats of frame 0)
    const getFrame = (idx) => {
      const actualIdx = idx - leftPad;
      const clamped = Math.max(0, Math.min(actualIdx, T - 1));
      return feat.subarray(clamped * D, (clamped + 1) * D);
    };

    const outDim = lfrM * D;
    const out = new Float32Array(T_lfr * outDim);

    for (let i = 0; i < T_lfr; i++) {
      const outOff = i * outDim;
      for (let j = 0; j < lfrM; j++) {
        const frameIdx = i * lfrN + j;
        if (frameIdx < effectiveT) {
          out.set(getFrame(frameIdx), outOff + j * D);
        } else {
          // Pad with last frame
          out.set(getFrame(T - 1 + leftPad), outOff + j * D);
        }
      }
    }

    return { feat: out, dim: outDim, frames: T_lfr };
  }

  // ---------------------------------------------------------------------------
  // applyCMVN(feat, dim) — global mean-variance normalization
  // ---------------------------------------------------------------------------

  applyCMVN(feat, dim) {
    if (!this.cmvn) return feat;

    const means = this.cmvn.means;
    const vars = this.cmvn.vars;
    const frames = feat.length / dim;
    const out = new Float32Array(feat.length);

    for (let t = 0; t < frames; t++) {
      const off = t * dim;
      for (let d = 0; d < dim; d++) {
        const idx = off + d;
        out[idx] = (feat[idx] + means[d]) * vars[d];
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // lfrCMVN(feat) — combined pipeline wrapper
  // ---------------------------------------------------------------------------

  lfrCMVN(fbankResult) {
    const { feat, featLen } = fbankResult;

    let current = feat;
    let dim = this.nMels;

    if (this.lfrM !== 1 || this.lfrN !== 1) {
      const lfr = this.applyLFR(current);
      current = lfr.feat;
      dim = lfr.dim;
    }

    if (this.cmvn) {
      current = this.applyCMVN(current, dim);
    }

    return { feat: current, featLen: current.length / dim, dim };
  }

  // ---------------------------------------------------------------------------
  // process(waveform) — full pipeline: fbank → LFR → CMVN
  // Returns {feat: Float32Array, featLen: number, dim: number}
  // ---------------------------------------------------------------------------

  process(waveform) {
    const fbankResult = this.fbank(waveform);
    return this.lfrCMVN(fbankResult);
  }

  // ---------------------------------------------------------------------------
  // reset() — clear streaming state
  // ---------------------------------------------------------------------------

  reset() {
    this._preemphPrev = 0.0;
  }
}
