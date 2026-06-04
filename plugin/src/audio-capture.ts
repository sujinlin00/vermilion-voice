// AudioCaptureManager — mic + system audio capture
//
// Decoupled from main plugin logic.
// Provides a single mixed AudioStream to the VAD pipeline.
//
// Usage:
//   const mgr = new AudioCaptureManager(config);
//   await mgr.start(audioCtx, onAudioData);
//   mgr.stop();

import type { AudioCaptureConfig } from './types';

export interface AudioCaptureCallbacks {
  /** Called with Float32Array audio data (16kHz mono) for each chunk. */
  onData: (data: Float32Array) => void;
  /** Called when capture state changes. */
  onStatus: (status: 'mic' | 'output' | 'mixed' | 'stopped') => void;
  /** Called on error. */
  onError: (message: string) => void;
}

export class AudioCaptureManager {
  private config: AudioCaptureConfig;
  private micStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private outputSource: MediaStreamAudioSourceNode | null = null;
  private merger: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private audioCtx: AudioContext | null = null;
  private callbacks: AudioCaptureCallbacks;
  private workletCode: string;

  constructor(callbacks: AudioCaptureCallbacks, workletCode: string, captureConfig?: AudioCaptureConfig) {
    this.callbacks = callbacks;
    this.workletCode = workletCode;
    this.config = captureConfig || {
      mic_enabled: true,
      output_enabled: true,
      output_source: 'system',
      mix_mode: 'merge',
    };
  }

  /** Update capture config (e.g. from settings change). */
  updateConfig(config: AudioCaptureConfig) {
    this.config = config;
  }

  /**
   * Start audio capture.
   * Creates AudioContext, connects mic and/or system audio, pipes to worklet.
   * @param micDeviceId  Optional mic device ID (empty = default)
   * @returns The AudioContext (for external use if needed)
   */
  async start(micDeviceId?: string): Promise<AudioContext> {
    this.audioCtx = new AudioContext();

    // Load worklet
    const workletBlob = new Blob([this.workletCode], { type: 'application/javascript' });
    await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(workletBlob));

    // Create worklet node
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'mic-processor');
    this.workletNode.port.onmessage = (e) => {
      this.callbacks.onData(new Float32Array(e.data));
    };

    // Create merger gain node (mixes multiple sources)
    this.merger = this.audioCtx.createGain();
    this.merger.gain.value = 1.0;

    // Connect mic
    if (this.config.mic_enabled) {
      await this.connectMic(micDeviceId);
    }

    // Connect system audio
    if (this.config.output_enabled) {
      await this.connectOutput();
    }

    // Wire merger → worklet
    this.merger.connect(this.workletNode);
    this.workletNode.connect(this.audioCtx.destination); // required for worklet to process

    // Report status
    if (this.config.mic_enabled && this.config.output_enabled) {
      this.callbacks.onStatus('mixed');
    } else if (this.config.output_enabled) {
      this.callbacks.onStatus('output');
    } else {
      this.callbacks.onStatus('mic');
    }

    return this.audioCtx;
  }

  /** Stop all capture, release resources. */
  stop() {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.outputSource) {
      this.outputSource.disconnect();
      this.outputSource = null;
    }
    if (this.merger) {
      this.merger.disconnect();
      this.merger = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    if (this.outputStream) {
      this.outputStream.getTracks().forEach(t => t.stop());
      this.outputStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.callbacks.onStatus('stopped');
  }

  /** Whether system audio capture is active. */
  hasOutputCapture(): boolean {
    return this.outputStream !== null;
  }

  /** Get current mic stream (for external use like FLAC recording). */
  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  // ---- Private ----

  private async connectMic(deviceId?: string) {
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } as MediaTrackConstraints,
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.micSource = this.audioCtx!.createMediaStreamSource(this.micStream);
      this.micSource.connect(this.merger!);
    } catch (e: any) {
      this.callbacks.onError(`麦克风采集失败: ${e.message}`);
      throw e;
    }
  }

  private async connectOutput() {
    try {
      // Electron/Obsidian: use desktopCapturer for reliable audio capture
      const { ipcRenderer } = require('electron');
      const desktopCapturer = (navigator.mediaDevices as any);

      // Try Electron desktopCapturer first (more reliable in Electron)
      let stream: MediaStream | null = null;

      try {
        // Electron: getDisplayMedia with audio:true and chromeMediaSource
        stream = await desktopCapturer.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: 'screen:0:0',
              maxWidth: 1,
              maxHeight: 1,
              maxFrameRate: 1,
            },
          },
        });
      } catch {
        // Fallback: standard getDisplayMedia (browser-like behavior)
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: false,
          } as any,
        });
      }

      if (!stream) {
        this.callbacks.onError('无法获取桌面音频流');
        return;
      }

      // Keep only audio tracks, stop video tracks
      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      videoTracks.forEach(t => t.stop());

      if (audioTracks.length === 0) {
        this.callbacks.onError('未获取到音频轨道，请在弹窗中勾选"分享系统音频"');
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      // Create a new stream with only audio
      this.outputStream = new MediaStream(audioTracks);
      this.outputSource = this.audioCtx!.createMediaStreamSource(this.outputStream);
      this.outputSource.connect(this.merger!);
    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        this.callbacks.onError('用户取消了音频共享授权');
      } else {
        this.callbacks.onError(`桌面音频采集失败: ${e.message}`);
      }
      this.outputStream = null;
    }
  }
}
