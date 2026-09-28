import { describe, it, expect, vi, afterEach } from 'vitest';
import { GuandanVoice, decodeWavBase64 } from '../src/lib/voice/recorder';

/**
 * S2 · 浏览器录音模块测试。
 *
 * 按 skill 的做法在 node 环境打桩浏览器 API，不依赖真实麦克风：
 *   - AudioContext / createMediaStreamSource / createScriptProcessor / createGain
 *   - navigator.mediaDevices.getUserMedia
 *
 * 本阶段只覆盖「会话 + WAV 编码 + 提交 + 释放」，
 * VAD 状态机属于 S3（见 test/vad.test.ts）。
 */

const SAMPLE_RATE = 16000;

/**
 * 在 globalThis 上安装/删除浏览器 API 桩。
 * 用 Record<string, unknown> 而非 any，保持类型检查有意义。
 *
 * 必须走 Object.defineProperty：Node >= 21 自带一个只读的全局 `navigator`
 * （Web API 已进 Node），直接赋值会报 "which has only a getter"。
 */
const setGlobal = (key: string, value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};
const delGlobal = (key: string): void => {
  Reflect.deleteProperty(globalThis, key);
};

/** 浏览器 API 桩 */
const installBrowserStubs = (opts: { getUserMediaError?: Error } = {}) => {
  const stopTrack = vi.fn();
  const closeCtx = vi.fn(async () => { /* noop */ });
  const getUserMedia = vi.fn(async () => {
    if (opts.getUserMediaError) throw opts.getUserMediaError;
    return { getTracks: () => [{ stop: stopTrack }] };
  });

  const processor = {
    onaudioprocess: null as null | ((e: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  const gainNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const destination = {};

  class FakeAudioContext {
    sampleRate = SAMPLE_RATE;
    destination = destination as unknown as AudioNode;
    createMediaStreamSource = vi.fn(() => sourceNode);
    createScriptProcessor = vi.fn(() => processor);
    createGain = vi.fn(() => gainNode);
    close = closeCtx;
  }

  setGlobal('navigator', { mediaDevices: { getUserMedia } });
  setGlobal('AudioContext', FakeAudioContext);

  return { getUserMedia, stopTrack, closeCtx, processor, sourceNode, gainNode };
};

const restoreBrowserStubs = () => {
  delGlobal('navigator');
  delGlobal('AudioContext');
  delGlobal('webkitAudioContext');
};

/** 收集所有回调，便于断言 */
const makeCallbacks = () => ({
  onStatus: vi.fn(),
  onResult: vi.fn(),
  onError: vi.fn(),
  onStateChange: vi.fn(),
});

describe('GuandanVoice · 支持性检测', () => {
  afterEach(restoreBrowserStubs);

  it('浏览器 API 齐备时报告支持', () => {
    installBrowserStubs();
    expect(new GuandanVoice(makeCallbacks()).isSupported()).toBe(true);
  });

  it('缺少 getUserMedia 时报告不支持', () => {
    setGlobal('AudioContext', class {});
    setGlobal('navigator', {});
    expect(new GuandanVoice(makeCallbacks()).isSupported()).toBe(false);
  });

  it('缺少 AudioContext 时报告不支持', () => {
    setGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    expect(new GuandanVoice(makeCallbacks()).isSupported()).toBe(false);
  });

  it('兼容 webkitAudioContext', () => {
    setGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    setGlobal('webkitAudioContext', class {});
    expect(new GuandanVoice(makeCallbacks()).isSupported()).toBe(true);
  });
});

describe('GuandanVoice · 麦克风会话', () => {
  afterEach(restoreBrowserStubs);

  it('首次 startAuto 建立会话并进入 listening', async () => {
    const stubs = installBrowserStubs();
    const cb = makeCallbacks();
    const v = new GuandanVoice(cb);

    await v.startAuto();

    expect(stubs.getUserMedia).toHaveBeenCalledTimes(1);
    expect(cb.onStateChange).toHaveBeenCalledWith('listening');
    expect(cb.onStatus).toHaveBeenCalled();
  });

  it('会话只获取一次，重复 startAuto 不重复申请权限', async () => {
    const stubs = installBrowserStubs();
    const v = new GuandanVoice(makeCallbacks());

    await v.startAuto();
    v.pause();
    v.resume();
    await v.startAuto();

    expect(stubs.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('以 16kHz 建立 AudioContext', async () => {
    const stubs = installBrowserStubs();
    const v = new GuandanVoice(makeCallbacks());
    await v.startAuto();

    expect(stubs.processor.onaudioprocess).toBeTypeOf('function');
  });

  it('麦克风拒绝授权时走 onError，不崩溃、不卡住', async () => {
    installBrowserStubs({ getUserMediaError: new Error('NotAllowedError') });
    const cb = makeCallbacks();
    const v = new GuandanVoice(cb);

    await v.startAuto();

    expect(cb.onError).toHaveBeenCalled();
    expect(String(cb.onError.mock.calls[0][0])).toContain('NotAllowedError');
  });

  it('stopAuto 释放麦克风：track.stop() 与 audioContext.close() 均被调用', async () => {
    const stubs = installBrowserStubs();
    const cb = makeCallbacks();
    const v = new GuandanVoice(cb);

    await v.startAuto();
    v.stopAuto();

    expect(stubs.stopTrack).toHaveBeenCalled();
    expect(stubs.closeCtx).toHaveBeenCalled();
    expect(cb.onStateChange).toHaveBeenLastCalledWith('off');
  });

  it('pause 不释放会话（保持麦克风常开），resume 不重复申请', async () => {
    const stubs = installBrowserStubs();
    const v = new GuandanVoice(makeCallbacks());

    await v.startAuto();
    v.pause();
    v.resume();

    expect(stubs.stopTrack).not.toHaveBeenCalled();
    expect(stubs.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('会话未建立时 resume / pause 不抛异常（空值防御）', () => {
    const v = new GuandanVoice(makeCallbacks());
    expect(() => { v.resume(); v.pause(); }).not.toThrow();
  });
});

describe('GuandanVoice · WAV 编码', () => {
  it('生成 44 字节头的标准 PCM16 WAV', () => {
    const v = new GuandanVoice(makeCallbacks());
    const samples = new Float32Array(100);
    const bytes = decodeWavBase64(v.encodeWav(samples, SAMPLE_RATE));

    expect(bytes.length).toBe(44 + 100 * 2);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...bytes.slice(12, 16))).toBe('fmt ');
  });

  it('采样率写为 16kHz、单声道、16bit', () => {
    const v = new GuandanVoice(makeCallbacks());
    const bytes = decodeWavBase64(v.encodeWav(new Float32Array(8), SAMPLE_RATE));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getUint16(20, true)).toBe(1);   // PCM
    expect(view.getUint16(22, true)).toBe(1);   // 单声道
    expect(view.getUint32(24, true)).toBe(16000); // 采样率
    expect(view.getUint16(34, true)).toBe(16);  // 位深
  });

  it('音频数据段可解码回原始浮点采样', () => {
    const v = new GuandanVoice(makeCallbacks());
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = decodeWavBase64(v.encodeWav(samples, SAMPLE_RATE));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const dataOffset = 44;
    const read = (i: number) => view.getInt16(dataOffset + i * 2, true) / 32768;
    expect(read(1)).toBeCloseTo(0.5, 2);
    expect(read(2)).toBeCloseTo(-0.5, 2);
  });

  it('超出 [-1,1] 的采样被钳制，不溢出为整数回绕', () => {
    const v = new GuandanVoice(makeCallbacks());
    const samples = new Float32Array([2, -2]);
    const bytes = decodeWavBase64(v.encodeWav(samples, SAMPLE_RATE));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('空采样不抛异常', () => {
    const v = new GuandanVoice(makeCallbacks());
    expect(() => v.encodeWav(new Float32Array(0), SAMPLE_RATE)).not.toThrow();
  });
});

describe('GuandanVoice · 提交识别', () => {
  afterEach(restoreBrowserStubs);

  it('以 {audio_base64, mime} POST 到 /api/asr 并返回文本', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, text: '对K' }),
      { status: 200 },
    ));
    setGlobal('fetch', fetchMock);

    const v = new GuandanVoice(makeCallbacks());
    const text = await v.transcribe('UklGRg==');

    expect(text).toBe('对K');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/asr');
    expect((init.method as string)).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      audio_base64: 'UklGRg==',
      mime: 'audio/wav',
    });
  });

  it('服务端返回错误时抛出可读错误（含 503 配置指引）', async () => {
    setGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: '未配置 DASHSCOPE_API_KEY' }),
      { status: 503 },
    )));

    const v = new GuandanVoice(makeCallbacks());
    await expect(v.transcribe('UklGRg==')).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });

  it('网络异常向上抛出，交给 onError 处理', async () => {
    setGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const v = new GuandanVoice(makeCallbacks());
    await expect(v.transcribe('UklGRg==')).rejects.toThrow(/network down/);
  });
});
