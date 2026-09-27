import { defineConfig } from 'vitest/config';

/**
 * 独立的测试配置。
 *
 * 刻意不合并进 vite.config.ts：那是 vendored 上游文件，
 * 尽量少改动以降低日后同步上游的冲突面。
 *
 * 环境为 node：当前测试只覆盖纯逻辑（规则引擎 / 枚举 / 解析器），
 * 不需要 DOM。S2/S3 的 VAD 测试届时需要 mock 浏览器 API
 * （AudioContext / getUserMedia），按 skill 的做法用打桩而非真实环境。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 特征测试与契约测试按名称分组，便于单独跑
    reporters: ['default'],
  },
});
