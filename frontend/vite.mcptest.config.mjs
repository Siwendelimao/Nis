/**
 * 临时 vite 配置（仅本轮 MCP 实测用，测完即删）
 * 为什么要单独一份：项目 vite.config.ts 里 proxy target 硬编码 127.0.0.1:8766 ——
 * 那是**老大正在跑的安装版后端**。直接起 dev server 会把请求打到他实例上
 * （可能改他的 providers.json / 触发导入覆盖）。故这里换端口 + 换 target，源码一行不动。
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const ROOT = 'D:/nis0924/frontend'

export default defineConfig({
  root: ROOT,
  plugins: [vue(), tailwindcss()],
  cacheDir: resolve(ROOT, '.vite-mcptest'),
  resolve: { alias: { '@': resolve(ROOT, 'src') } },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8799',      // ← 独立测试后端，绝不碰 8766
        changeOrigin: true,
      },
    },
  },
})