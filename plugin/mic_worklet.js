// mic_worklet.js — AudioWorklet: 麦克风采集, 16kHz 单声道
//
// 将浏览器麦克风输入降采样到 16kHz，输出 Float32Array chunk

const TARGET_SR = 16000;
const CHUNK_MS = 500;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = []; // accumulated samples for resampling
    this._inputSr = sampleRate;

    // Resampling ratio
    this._ratio = TARGET_SR / this._inputSr;
    this._chunkSize = Math.floor(TARGET_SR * CHUNK_MS / 1000);

    // For simple integer-ratio resampling
    this._resampleAcc = 0;

    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this._buffer = [];
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Simple resampling: accumulate and decimate
    // For a more accurate resampler, use a proper SRC library
    for (let i = 0; i < channel.length; i++) {
      this._resampleAcc += this._ratio;
      while (this._resampleAcc >= 1.0) {
        this._resampleAcc -= 1.0;
        this._buffer.push(channel[i]);
      }
    }

    // Output chunks when we have enough
    while (this._buffer.length >= this._chunkSize) {
      const chunk = new Float32Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        chunk[i] = this._buffer.shift();
      }
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('mic-processor', MicProcessor);
