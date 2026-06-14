// streaming_fbank.js — Streaming fbank + online LFR + CMVN
// Extends POC-2 FbankProcessor with streaming state management
//
// Pipeline per chunk:
//   waveform → input_cache concat → fbank(full frames only) →
//   lfr_splice_cache prepend → online LFR → CMVN → output
//
// State variables:
//   input_cache: leftover waveform samples (< 1 frame worth)
//   lfr_splice_cache: leftover LFR frames (incomplete right context)
//   fbank_cache: kaldi OnlineFbank internal state (simulated via input_cache)

import { FbankProcessor, loadCMVN } from './fbank.js';

export class StreamingFbankProcessor extends FbankProcessor {
  constructor(opts = {}) {
    super(opts);
    // Waveform cache: leftover samples that don't form a complete frame
    this.input_cache = null;
    // LFR splice cache: frames that need right context from next chunk
    this.lfr_splice_cache = [];
    // Waveform buffer for timestamp alignment
    this._waveform_buf = null;
  }

  /**
   * Feed a new audio chunk. Concatenates with leftover samples from
   * previous chunk, extracts complete fbank frames, handles online LFR.
   *
   * @param {Float32Array} waveform - new PCM samples [-1, 1]
   * @param {boolean} is_final - whether this is the last chunk
   * @returns {{feat: Float32Array, featLen: number, dim: number}}
   *   Returns empty feat (length 0) if not enough samples for any LFR frame
   */
  accept_waveform(waveform, is_final = false) {
    const frameLen = this.frameLength;
    const frameShift = this.frameShift;
    const lfrM = this.lfrM;
    const lfrN = this.lfrN;

    // ---- Step 1: Concatenate input cache with new waveform ----
    let combined;
    if (this.input_cache && this.input_cache.length > 0) {
      combined = new Float32Array(this.input_cache.length + waveform.length);
      combined.set(this.input_cache);
      combined.set(waveform, this.input_cache.length);
    } else {
      combined = waveform;
    }

    // ---- Step 2: Compute how many complete fbank frames we can form ----
    const totalLen = combined.length;
    const numFrames = Math.max(0, Math.floor((totalLen - frameLen) / frameShift) + 1);

    if (numFrames === 0) {
      if (is_final) {
        // Final chunk with no complete frames — try to flush remaining
        if (this.lfr_splice_cache.length > 0) {
          return this._flushFinalLFR(combined, is_final);
        }
        return { feat: new Float32Array(0), featLen: 0, dim: this.nMels };
      }
      // Not enough samples for a frame — cache everything for next chunk
      this.input_cache = combined;
      return { feat: new Float32Array(0), featLen: 0, dim: this.nMels };
    }

    // ---- Step 3: Save leftover samples (kaldi-style) ----
    // Kaldi caches samples from numFrames*frameShift to end.
    // These samples will become the left context for the next chunk's first frame.
    const usedSamples = (numFrames - 1) * frameShift + frameLen;
    const cachedStart = numFrames * frameShift;
    if (cachedStart < totalLen) {
      this.input_cache = combined.slice(cachedStart);
    } else {
      this.input_cache = new Float32Array(0);
    }

    // Waveform that forms complete frames
    const validWaveform = combined.slice(0, usedSamples);

    // ---- Step 4: Compute fbank on the valid waveform ----
    const fbankResult = this.fbank(validWaveform);
    let feats = fbankResult.feat;
    let T = fbankResult.featLen;
    const D = this.nMels;

    if (T === 0) {
      return { feat: new Float32Array(0), featLen: 0, dim: D };
    }

    // ---- Step 5: Online LFR ----
    if (lfrM !== 1 || lfrN !== 1) {
      // Initialize splice cache on first call: prepend (lfrM-1)//2 copies of frame 0
      if (this.lfr_splice_cache.length === 0) {
        const leftPad = (lfrM - 1) >> 1; // floor((lfrM-1)/2) = 2 for lfr_m=5
        const frame0 = feats.slice(0, D);
        for (let p = 0; p < leftPad; p++) {
          this.lfr_splice_cache.push(new Float32Array(frame0));
        }
      }

      // Check if we have enough frames for at least one LFR frame
      const cacheLen = this.lfr_splice_cache.length;
      if (cacheLen + T < lfrM) {
        // Not enough frames yet — accumulate into splice cache
        for (let i = 0; i < T; i++) {
          this.lfr_splice_cache.push(feats.slice(i * D, (i + 1) * D));
        }
        return { feat: new Float32Array(0), featLen: 0, dim: lfrM * D };
      }

      // Concatenate splice cache + current feats
      const catT = cacheLen + T;
      const catFeats = new Float32Array(catT * D);

      // Copy splice cache frames
      for (let i = 0; i < cacheLen; i++) {
        catFeats.set(this.lfr_splice_cache[i], i * D);
      }
      // Copy current frames
      catFeats.set(feats, cacheLen * D);

      // Apply online LFR
      const lfrResult = this._apply_lfr_online(catFeats, catT, D, is_final);
      feats = lfrResult.feat;
      T = lfrResult.frames;

      // Update splice cache for next chunk
      this.lfr_splice_cache = lfrResult.splice_cache;

      if (T === 0 && !is_final) {
        return { feat: new Float32Array(0), featLen: 0, dim: lfrM * D };
      }
    }

    // ---- Step 6: CMVN ----
    const outDim = (lfrM !== 1 || lfrN !== 1) ? lfrM * D : D;
    if (this.cmvn) {
      feats = this.applyCMVN(feats, outDim);
    }

    return { feat: feats, featLen: T, dim: outDim };
  }

  /**
   * Online LFR: stack lfr_m frames, stride lfr_n.
   * Unlike offline LFR, incomplete frames at the end are NOT padded -
   * they become the splice_cache for the next chunk.
   *
   * @param {Float32Array} inputs - concatenated [splice_cache | current_frames]
   * @param {number} T - total input frames
   * @param {number} D - feature dimension per frame
   * @param {boolean} is_final - if true, pad incomplete frames
   * @returns {{feat: Float32Array, frames: number, splice_cache: Float32Array[]}}
   */
  _apply_lfr_online(inputs, T, D, is_final) {
    const lfrM = this.lfrM;
    const lfrN = this.lfrN;

    // Number of complete LFR frames we can form
    // minus right context: (lfrM-1)//2
    const rightContext = (lfrM - 1) >> 1;
    const T_lfr = Math.ceil((T - rightContext) / lfrN);

    const outDim = lfrM * D;
    const lfrFrames = [];
    let spliceIdx = T_lfr; // default: all frames processed

    for (let i = 0; i < T_lfr; i++) {
      const startFrame = i * lfrN;
      const remaining = T - startFrame;

      if (lfrM <= remaining) {
        // Complete LFR frame: stack lfrM frames
        const frame = new Float32Array(outDim);
        for (let j = 0; j < lfrM; j++) {
          frame.set(
            inputs.subarray((startFrame + j) * D, (startFrame + j + 1) * D),
            j * D
          );
        }
        lfrFrames.push(frame);
      } else {
        // Incomplete LFR frame
        if (is_final) {
          // Pad with copies of last frame
          const frame = new Float32Array(outDim);
          for (let j = 0; j < lfrM; j++) {
            const srcIdx = Math.min(startFrame + j, T - 1);
            frame.set(
              inputs.subarray(srcIdx * D, (srcIdx + 1) * D),
              j * D
            );
          }
          lfrFrames.push(frame);
        } else {
          // Stop here, save tail for next chunk
          spliceIdx = i;
          break;
        }
      }
    }

    // Extract splice cache: frames from spliceIdx * lfrN onwards
    const spliceStart = Math.min(T, spliceIdx * lfrN);
    const spliceCache = [];
    for (let i = spliceStart; i < T; i++) {
      spliceCache.push(inputs.slice(i * D, (i + 1) * D));
    }

    // Flatten LFR output
    const numOut = lfrFrames.length;
    const out = new Float32Array(numOut * outDim);
    for (let i = 0; i < numOut; i++) {
      out.set(lfrFrames[i], i * outDim);
    }

    return { feat: out, frames: numOut, splice_cache: spliceCache };
  }

  /**
   * Flush remaining splice cache frames at the end of the stream.
   * Called when is_final=true and there are leftover frames.
   */
  _flushFinalLFR(waveform, is_final) {
    const D = this.nMels;
    const lfrM = this.lfrM;
    const lfrN = this.lfrN;
    const outDim = lfrM * D;

    if (this.lfr_splice_cache.length === 0) {
      return { feat: new Float32Array(0), featLen: 0, dim: outDim };
    }

    // Convert splice cache array to flat Float32Array
    const cacheLen = this.lfr_splice_cache.length;
    const catFeats = new Float32Array(cacheLen * D);
    for (let i = 0; i < cacheLen; i++) {
      catFeats.set(this.lfr_splice_cache[i], i * D);
    }

    const lfrResult = this._apply_lfr_online(catFeats, cacheLen, D, true);
    this.lfr_splice_cache = lfrResult.splice_cache;

    let feats = lfrResult.feat;
    let T = lfrResult.frames;

    if (this.cmvn && T > 0) {
      feats = this.applyCMVN(feats, outDim);
    }

    return { feat: feats, featLen: T, dim: outDim };
  }

  /**
   * Reset all streaming state.
   */
  reset() {
    super.reset();
    this.input_cache = null;
    this.lfr_splice_cache = [];
    this._waveform_buf = null;
  }
}

export { loadCMVN };
