import { describe, it, expect, vi } from 'vitest';
import { AsrProxy, pickTranscribeText, assertHttps } from '../server/asr-proxy';

/**
 * S1 · ASR 代理端点契约测试。
 *
 * 设计要点：把代理逻辑抽成不依赖 Node req/res 的纯模块 AsrProxy，
 * Vite 中间件只做「读 body → 调 handle → 写 res」的适配。
 * 这样代理的所有分支都能在 node 环境直接测，无需起服务器。
 *
 * 移植自 board-game-voice-asr/references/server-proxy.md（Python → Node 18+ fetch）。
 */

const WAV_B64 = 'UklGRgAAAABXQVZF'; // 任意合法 base64 片段即可

/** 云端 fun-asr-flash 系列返回结构 */
const funAsrResp = (text: string) => ({
  output: { output: { sentence: { text } } },
});

/** 云端 qwen-audio-3.0-asr-flash 系列返回结构 */
const qwenResp = (text: string) => ({
  output: { choices: [{ message: { content: [{ text }] } }] },
});

const okFetch = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

/** 传给 fetch 的 init 子集（测试只关心这两项） */
interface FetchInitLike {
  body?: string;
  headers?: Record<string, string>;
}

/** 发往百炼的请求体形状（显式声明，避免断言时到处写 any） */
interface DashscopeBody {
  model: string;
  input: { messages: Array<{ role: string; content: Array<{ audio: string }> }> };
  parameters: { format: string };
}

type MockFetch = { mock: { calls: unknown[][] } };

/** 取出第 n 次调用传给 fetch 的 init */
const initOf = (mock: MockFetch, n = 0): FetchInitLike =>
  mock.mock.calls[n][1] as FetchInitLike;

/** 取出第 n 次调用实际发出的 JSON 请求体 */
const sentJson = (mock: MockFetch, n = 0): DashscopeBody =>
  JSON.parse(String(initOf(mock, n).body)) as DashscopeBody;

describe('pickTranscribeText：兼容两种云端返回结构', () => {
  it('解析 fun-asr-flash 系列结构', () => {
    expect(pickTranscribeText(funAsrResp(' 对K。'))).toBe('对K。');
  });

  it('解析 qwen-audio-3.0 系列结构', () => {
    expect(pickTranscribeText(qwenResp(' 顺子 '))).toBe('顺子');
  });

  it('结构无法识别时抛错，不返回空串冒充成功', () => {
    expect(() => pickTranscribeText({ output: {} })).toThrow();
  });
});

describe('assertHttps：转发前校验 scheme', () => {
  it('放行 https', () => {
    expect(() => assertHttps('https://dashscope.aliyuncs.com/api')).not.toThrow();
  });

  it('拒绝 file: 等自定义 scheme（红线）', () => {
    expect(() => assertHttps('file:///etc/passwd')).toThrow(/https/i);
  });

  it('拒绝 http 明文', () => {
    expect(() => assertHttps('http://example.com')).toThrow(/https/i);
  });
});

describe('AsrProxy.handle', () => {
  it('未配置 Key 时返回 503 并给出配置指引，游戏仍可玩', async () => {
    const proxy = new AsrProxy({ apiKey: null });
    const res = await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });
    expect(res.status).toBe(503);
    expect(res.payload.ok).toBe(false);
    expect(String(res.payload.error)).toContain('DASHSCOPE_API_KEY');
  });

  it('缺少 audio_base64 时返回 400', async () => {
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl: okFetch(funAsrResp('x')) });
    const res = await proxy.handle({ mime: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(res.payload.ok).toBe(false);
  });

  it('识别成功：返回 {ok:true, text}', async () => {
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl: okFetch(funAsrResp('对K')) });
    const res = await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });
    expect(res.status).toBe(200);
    expect(res.payload).toEqual({ ok: true, text: '对K' });
  });

  it('请求体必须带 parameters.format = wav（缺失云端会报 UNSUPPORTED_FORMAT）', async () => {
    const fetchImpl = okFetch(funAsrResp('对K'));
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl });
    await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });

    const sent = sentJson(fetchImpl);
    expect(sent.parameters).toEqual({ format: 'wav' });
  });

  it('音频以 data URL 形式内联上传（不依赖公网 URL）', async () => {
    const fetchImpl = okFetch(funAsrResp('对K'));
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl });
    await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });

    const sent = sentJson(fetchImpl);
    const content = sent.input.messages[0].content[0].audio;
    expect(content.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('模型名可配置，默认 qwen-audio-3.1-asr-flash', async () => {
    const fetchImpl = okFetch(funAsrResp('x'));
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl });
    await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });
    let sent = sentJson(fetchImpl);
    expect(sent.model).toBe('qwen-audio-3.1-asr-flash');

    const fetchImpl2 = okFetch(funAsrResp('x'));
    const proxy2 = new AsrProxy({ apiKey: 'k', fetchImpl: fetchImpl2, model: 'fun-asr-flash' });
    await proxy2.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });
    sent = sentJson(fetchImpl2);
    expect(sent.model).toBe('fun-asr-flash');
  });

  it('云端返回非 200 时透传错误体，前端才能区分 Key 无效与网络不通', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }),
      { status: 401 },
    ));
    const proxy = new AsrProxy({ apiKey: 'bad-key', fetchImpl });
    const res = await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });

    expect(res.status).toBe(500);
    expect(res.payload.ok).toBe(false);
    expect(String(res.payload.error)).toContain('InvalidApiKey');
  });

  it('网络异常被捕获，不抛出未处理异常', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl });
    const res = await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });
    expect(res.status).toBe(500);
    expect(String(res.payload.error)).toContain('ECONNREFUSED');
  });

  it('Bearer Key 放入 Authorization 头', async () => {
    const fetchImpl = okFetch(funAsrResp('x'));
    const proxy = new AsrProxy({ apiKey: 'my-key', fetchImpl });
    await proxy.handle({ audio_base64: WAV_B64, mime: 'audio/wav' });

    const headers = initOf(fetchImpl).headers;
    expect(headers?.Authorization).toBe('Bearer my-key');
  });

  it('非法 JSON body 返回 400 而非 500', async () => {
    const proxy = new AsrProxy({ apiKey: 'k', fetchImpl: okFetch(funAsrResp('x')) });
    const res = await proxy.handleRaw('{ not json');
    expect(res.status).toBe(400);
  });
});
