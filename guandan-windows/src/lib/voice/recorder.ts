/**
 * S2 · 浏览器录音模块。
 *
 * 移植自 board-game-voice-asr/references/vad-recording.md 的 ChessVoice 骨架（改名为 GuandanVoice）。
 * 本阶段只负责：麦克风会话、16kHz 单声道采集、WAV 编码、提交识别、干净释放。
 * VAD 能量检测状态机属于 S3（见 _onAudioChunk 的接缝）。
 *
 * 红线：这里绝不出现任何 API Key，识别请求只打同源 /api/asr。
 */

export const SAMPLE_RATE = 16000;
export const CHUNK_SAMPLES = 2048; // 16kHz 下约 128ms/块

export interface VoiceCallbacks {
  /** 过程提示（聆听中/识别中/太短重试） */
  onStatus: (msg: string) => void;
  /** 识别成功；解析失败时调用方须重新武装收音 */
  onResult: (text: string) => void;
  /** 网络错/空结果/麦克风拒绝 */
  onError: (msg: string) => void;
  /** listening / paused / recording / off，供无障碍视觉同步 */
  onStateChange: (state: VoiceState) => void;
}

export type VoiceState = 'listening' | 'paused' | 'recording' | 'off';

/** 测试用：把 WAV base64 解回字节（浏览器与 node 均有 atob） */
export const decodeWavBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

type AnyCtor = new (contextOptions?: AudioContextOptions) => AudioContext;

export class GuandanVoice {
  private readonly cb: VoiceCallbacks;

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;

  /** null=未启动 / 'auto' / 'paused' */
  private mode: 'auto' | 'paused' | null = null;

  constructor(callbacks: Partial<VoiceCallbacks> = {}) {
    this.cb = {
      onStatus: callbacks.onStatus ?? (() => { /* noop */ }),
      onResult: callbacks.onResult ?? (() => { /* noop */ }),
      onError: callbacks.onError ?? (() => { /* noop */ }),
      onStateChange: callbacks.onStateChange ?? (() => { /* noop */ }),
    };
  }

  /** 浏览器是否具备录音所需能力 */
  isSupported(): boolean {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    const hasGetUserMedia = !!(md && md.getUserMedia);
    // SAFETY: 浏览器确实在 globalThis 上挂有 AudioContext（及旧版 webkitAudioContext），
    // 但 TS 的 lib.dom 只声明了前者；此处仅做只读探测，故断言为可选构造器。
    const g = globalThis as unknown as { AudioContext?: AnyCtor; webkitAudioContext?: AnyCtor };
    const hasAudioContext = !!(g.AudioContext || g.webkitAudioContext);
    return hasGetUserMedia && hasAudioContext;
  }

  /** 开启自动模式。首次由用户手势触发以获得麦克风授权 */
  async startAuto(): Promise<void> {
    if (this.mode === 'auto') return;
    try {
      await this.ensureSession();
    } catch (err) {
      // 拒绝授权等：提示后仍留在可重试状态，不把玩家卡死
      this.cb.onError(err instanceof Error ? err.message : String(err));
      this.cb.onStateChange('off');
      return;
    }
    this.mode = 'auto';
    this.attachProcessor();
    this.cb.onStateChange('listening');
    this.cb.onStatus('🎙️ 语音已开启，请直接说指令…');
  }

  /** 暂停监听（对手/AI 回合，防误采），但保持麦克风会话 */
  pause(): void {
    if (this.mode !== 'auto') return;
    this.mode = 'paused';
    if (this.processor) this.processor.onaudioprocess = null;
    this.cb.onStateChange('paused');
  }

  /** 恢复监听（不重新申请麦克风） */
  resume(): void {
    if (!this.audioContext || this.mode === 'auto') return;
    this.mode = 'auto';
    this.attachProcessor();
    this.cb.onStateChange('listening');
  }

  /** 完全停止并释放麦克风 */
  stopAuto(): void {
    this.mode = null;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.sourceNode?.disconnect();
    this.gainNode?.disconnect();
    this.mediaStream?.getTracks().forEach(t => t.stop());
    void this.audioContext?.close().catch(() => { /* 已关闭则忽略 */ });

    this.processor = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.cb.onStateChange('off');
  }

  /** 会话只获取一次并全程复用：反复 getUserMedia 有延迟和权限弹窗 */
  private async ensureSession(): Promise<void> {
    if (this.audioContext) return;
    // SAFETY: 同 isSupported()——webkitAudioContext 是旧版 Safari 的事实标准前缀，
    // lib.dom 未声明；断言为可选构造器后立即判空，不假定它存在。
    const g = globalThis as unknown as { AudioContext?: AnyCtor; webkitAudioContext?: AnyCtor };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');

    this.audioContext = new Ctor({ sampleRate: SAMPLE_RATE });
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
    this.gainNode = this.audioContext.createGain();

    // gain=0：保持回调链路活跃，但不把麦克风回放到扬声器
    this.gainNode.gain.value = 0;
    this.sourceNode.connect(this.processor);
    this.processor.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
  }

  /** 挂上音频块回调；会话未建立时安全返回 */
  private attachProcessor(): void {
    if (!this.processor) return;
    this.processor.onaudioprocess = e => {
      this.onAudioChunk(e.inputBuffer.getChannelData(0));
    };
  }

  /**
   * 音频块接缝。
   * S3 在此接入 VAD 能量检测状态机；S2 阶段不消费音频。
   */
  private onAudioChunk(_data: Float32Array): void {
    // 刻意暂不消费：S3 将在此接入 VAD 能量检测状态机。
    // 保留形参是为了把接缝固定下来，避免 S3 再改回调签名。
    void _data;
  }

  /** 提交识别到同源代理 */
  async transcribe(audioBase64: string): Promise<string> {
    const resp = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_base64: audioBase64, mime: 'audio/wav' }),
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `语音识别失败 (HTTP ${resp.status})`);
    }
    return data.text ?? '';
  }

  /**
   * Float32 → 16-bit PCM WAV → Base64。
   * 不用 MediaRecorder 的 webm/opus：WAV 是各 ASR 服务兼容性最好的格式。
   */
  encodeWav(samples: Float32Array | number[], sampleRate: number = SAMPLE_RATE): string {
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const writeStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);            // fmt chunk size
    view.setUint16(20, 1, true);             // PCM
    view.setUint16(22, 1, true);             // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);             // block align
    view.setUint16(34, 16, true);            // 位深
    writeStr(36, 'data');
    view.setUint32(40, n * 2, true);

    let o = 44;
    for (let i = 0; i < n; i++) {
      const raw = samples[i];
      const s = Math.max(-1, Math.min(1, raw));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }

    const bytes = new Uint8Array(buffer);
    let bin = '';
    const STEP = 0x8000; // 分片避免 apply 参数过多
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    return btoa(bin);
  }
}
