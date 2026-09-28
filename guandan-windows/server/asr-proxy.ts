/**
 * S1 · ASR 本地代理（纯逻辑部分）。
 *
 * 移植自 board-game-voice-asr/references/server-proxy.md 的 Python 实现，
 * 改用 Node 18+ 全局 fetch。这里刻意不接触 Node 的 req/res，
 * 只做「请求体 → 状态码+响应体」，以便在 node 环境直接测全部分支；
 * Vite 中间件（见 vite-asr-plugin.ts）只负责读写 HTTP。
 *
 * 红线：API Key 只从环境变量/启动参数进入，绝不下发到前端。
 */

export const DASHSCOPE_ENV_KEY = 'DASHSCOPE_API_KEY';
export const DEFAULT_ASR_MODEL = 'qwen-audio-3.1-asr-flash';
export const DASHSCOPE_NATIVE_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface AsrProxyOptions {
  /** null 表示未配置；此时一律返回 503，但游戏本身照常可玩 */
  apiKey: string | null;
  model?: string;
  /** 注入点：测试用 stub */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AsrResult {
  status: number;
  payload: Record<string, unknown>;
}

interface DashscopeBody {
  model: string;
  input: { messages: Array<{ role: string; content: Array<{ audio: string }> }> };
  parameters: { format: string };
}

/** 转发前校验 scheme，杜绝 file: 等自定义 scheme（静态审计也会盯这条） */
export const assertHttps = (url: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`拒绝访问非法地址: ${url}`);
  }
  if (parsed.protocol !== 'https:' || !parsed.host) {
    throw new Error(`拒绝访问非 https 地址: ${url}`);
  }
};

/**
 * 从百炼返回体中取出识别文本。
 * 兼容两种结构：fun-asr-flash 系列与 qwen-audio-3.0 系列。
 * 都取不到时抛错——绝不返回空串冒充成功。
 */
export const pickTranscribeText = (resp: unknown): string => {
  const root = resp as {
    output?: {
      output?: { sentence?: { text?: string } };
      choices?: Array<{ message?: { content?: unknown } }>;
    };
  };
  try {
    const t = root.output?.output?.sentence?.text;
    if (typeof t === 'string') return t.trim();
  } catch { /* 落到下面的兜底 */ }

  try {
    const content = root.output?.choices?.[0]?.message?.content;
    if (Array.isArray(content) && typeof content[0]?.text === 'string') {
      return (content[0] as { text: string }).text.trim();
    }
    if (content && typeof content === 'object' && 'text' in content) {
      const text = (content as { text?: unknown }).text;
      if (typeof text === 'string') return text.trim();
    }
  } catch { /* 落到下面的抛错 */ }

  throw new Error(`百炼返回格式异常: ${JSON.stringify(resp).slice(0, 300)}`);
};

export class AsrProxy {
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AsrProxyOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_ASR_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 入口：解析已读出的原始 body 字符串 */
  async handleRaw(raw: string): Promise<AsrResult> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      return { status: 400, payload: { ok: false, error: '请求体不是合法 JSON' } };
    }
    return this.handle(body);
  }

  /** 入口：已解析的请求体 */
  async handle(body: Record<string, unknown>): Promise<AsrResult> {
    if (!this.apiKey) {
      return {
        status: 503,
        payload: {
          ok: false,
          error: `服务器未配置 ASR API Key。请通过环境变量 ${DASHSCOPE_ENV_KEY}`
                 + ' 或启动参数 --asr-api-key 提供。',
        },
      };
    }

    const audioB64 = body.audio_base64;
    if (typeof audioB64 !== 'string' || audioB64.length === 0) {
      return { status: 400, payload: { ok: false, error: '缺少 audio_base64 字段' } };
    }
    const mime = typeof body.mime === 'string' && body.mime ? body.mime : 'audio/wav';

    try {
      const text = await this.transcribe(audioB64, mime);
      return { status: 200, payload: { ok: true, text } };
    } catch (err) {
      return {
        status: 500,
        payload: { ok: false, error: `语音识别失败: ${(err as Error)?.message ?? String(err)}` },
      };
    }
  }

  /** 发往百炼并取回文本 */
  private async transcribe(audioB64: string, mime: string): Promise<string> {
    const url = DASHSCOPE_NATIVE_URL;
    assertHttps(url);

    // 本地场景没有公网 URL，只能内联 data URL
    const dataUrl = `data:${mime};base64,${audioB64}`;
    const body: DashscopeBody = {
      model: this.model,
      input: { messages: [{ role: 'user', content: [{ audio: dataUrl }] }] },
      parameters: { format: 'wav' }, // 缺失会报 UNSUPPORTED_FORMAT
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const raw = await resp.text();
      if (!resp.ok) {
        // 原样透传云端错误体，前端才能区分「Key 无效」与「网络不通」
        throw new Error(`百炼 HTTP ${resp.status}: ${raw.slice(0, 300)}`);
      }
      return pickTranscribeText(JSON.parse(raw));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`请求超时（${this.timeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
