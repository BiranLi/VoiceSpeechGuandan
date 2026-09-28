import type { Plugin } from 'vite';
import { AsrProxy, DASHSCOPE_ENV_KEY, DASHSCOPE_ENV_MODEL, DEFAULT_ASR_MODEL } from './asr-proxy';

/**
 * 把 ASR 代理挂到 Vite 开发服务器的 /api/asr。
 *
 * 选 configureServer 中间件而非 server/index.js + proxy 条目的理由：
 * 代理与游戏页面共用 6677 一个端口，天然同源，不产生 CORS 预检。
 *
 * 红线：Key 只从环境变量/命令行读取，且只用于服务端转发，
 * 绝不写进任何会进 git 或下发到浏览器的产物。
 */
export interface AsrPluginOptions {
  /** 缺省读环境变量 DASHSCOPE_API_KEY */
  apiKey?: string | null;
  model?: string;
}

const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });

export const asrProxyPlugin = (opts: AsrPluginOptions = {}): Plugin => {
  const apiKey = opts.apiKey ?? process.env[DASHSCOPE_ENV_KEY] ?? null;
  const model = opts.model ?? process.env[DASHSCOPE_ENV_MODEL] ?? DEFAULT_ASR_MODEL;

  return {
    name: 'guandan-asr-proxy',
    apply: 'serve', // 只在开发服务器生效，生产构建无此端点（与 NFR-7 一致）
    configureServer(server) {
      server.middlewares.use('/api/asr', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: '仅支持 POST' }));
          return;
        }
        // 红线：刻意不设 Access-Control-Allow-Origin。
        // 前端用相对路径 /api/asr 提交，属同源请求，浏览器不会发预检、也不需要该头。
        // 一旦写成通配符 *, 任意网站都能 POST 到用户本机 6677，白白消耗他的 ASR 额度。
        const proxy = new AsrProxy({ apiKey, model });
        let result;
        try {
          result = await proxy.handleRaw(await readBody(req));
        } catch (err) {
          result = {
            status: 500,
            payload: { ok: false, error: `代理内部错误: ${(err as Error).message}` },
          };
        }

        res.statusCode = result.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(result.payload));
      });
    },
  };
};
