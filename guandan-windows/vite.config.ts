import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { traeBadgePlugin } from 'vite-plugin-trae-solo-badge';
import { asrProxyPlugin } from './server/vite-asr-plugin';

// https://vite.dev/config/
export default defineConfig({
  base: './', // 设为相对路径以支持 Electron 打包后的本地 file:// 协议
  server: {
    port: 6677,
    strictPort: true, // 确保端口不会被占用导致启动失败
    host: true, // 允许外部网络访问 (绑定到 0.0.0.0)
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: 'hidden',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './index.html'
      },
      output: {
        manualChunks: {
          react_vendor: ['react', 'react-dom'],
          motion_vendor: ['framer-motion'],
          socket_vendor: ['socket.io-client'],
          zustand_vendor: ['zustand'],
          ui_vendor: ['lucide-react'],
        },
      }
    }
  },
  plugins: [
    // ASR 本地代理：仅开发服务器生效，与游戏同端口 6677（无 CORS）。
    // Key 从环境变量 DASHSCOPE_API_KEY 读取，缺失时 /api/asr 返 503，
    // 游戏仍可正常点击操作。
    asrProxyPlugin(),
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    traeBadgePlugin({
      variant: 'dark',
      position: 'bottom-right',
      prodOnly: true,
      clickable: true,
      clickUrl: 'https://www.trae.ai/solo?showJoin=1',
      autoTheme: true,
      autoThemeTarget: '#root'
    }), 
    tsconfigPaths()
  ],
})
