import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // 0918：依赖缓存目录从默认的 node_modules/.vite 挪到项目内的 .vite。
  // 起因：这台机器上 node_modules 有可能是「指向别的盘的 junction」（例如 D:\nis0812 的指向 E:\nis0812），
  // 默认缓存目录会实际落到被指向的那块盘上 —— 一旦那边也有一个 dev server 在跑，两个进程抢同一份
  // 依赖缓存，vite 的依赖优化会直接卡死（实测挂 21 分钟、CPU 只用 2.8s）。挪进项目内即彻底避开。
  cacheDir: resolve(__dirname, '.vite'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    /* ★1011r：允许局域网访问（远程访问要用）。
       默认只监听 127.0.0.1 ⇒ 手机/另一台电脑打不开 dev 前端（现象是"响应时间过长"）。
       ⚠️ 命令行参数优先：启动时若写了 `--host 127.0.0.1`，会盖掉这里 —— 那种情况要把它去掉/改成 0.0.0.0。
       安全不依赖"只监听本机"，而靠后端的访问令牌：经代理进来的请求 remoteAddress 是本机、
       但 Host 是局域网地址，会被 originAllowed 要求带 ?token=（见 backend/server.ts 的 hostIsLoopback）。 */
    host: true,
    // 0914：/api → 后端 8766。预览 iframe（工作区 HTML）改走同源相对路径 —— 跨源时无法访问
    // iframe 的 contentDocument，「选择元素」拾取会失败（用户实测报错「跨源预览暂不支持」）。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8766',
        /* ★1011y（重要·安全）：原来是 true —— 它会把转发请求的 Host **改写成目标主机**
           （127.0.0.1:8766），于是后端看到的所有经代理请求都"来自本机" ⇒ **令牌校验被绕过**：
           局域网、尤其是将来把 dev server 挂到公网时，任何人访问都等于以本机身份操作 NIS
           （读写文件 / 跑命令）。
           改成 false ⇒ 保留原始 Host（局域网地址）⇒ 后端 originAllowed 能正确判为"外部"并要求令牌。
           ⚠️ 代价：经代理的请求都要带令牌 —— 而 EventSource / <img> / <iframe> / 下载链接
           这些**带不了请求头**，只能靠 ?token= 查询参数；前端 utils/nisToken.ts 的 withToken() 正是为此而铺。 */
        changeOrigin: false,
        /* ★1012t【关键修复】远程（局域网）访问时全局模型/设置"刷新就清空"的根因就在这里：
           手机用 http://<PC-IP>:5174 打开时，前端 BRIDGE_URL 走**同源**（bridgeUrl.ts 的 1011z 分支），
           也就是所有请求打到 vite dev server，再由本 proxy 转发到后端。但**WebSocket 必须显式开
           `ws: true` 才会被转发** —— 没开时：
             · HTTP（/api）能过 → 页面能打开；
             · WS（RPC 通道，providers.setModel / settings.* 全靠它）连不上 → 写入失败/读回为空
               ⇒ 表现就是「选了全局模型，一刷新就没了」。
           本机访问不走这条链路（前端直连 127.0.0.1:8766），所以只在远程复现。
           ⚠️ vite 配置改动**不会热更**，必须重启前端 dev 才生效。 */
        ws: true,
        // ★ 0922：SSE（/api/events.mux 长连接）必须**即时透传** —— 默认代理会顺手压缩/缓冲，
        // 事件到不了前端 ⇒ 后台任务胶囊/供应商状态「要切窗口/切对话才更新」。
        // 打包版前后端同源直连，所以那边没这毛病。
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
          proxy.on('proxyRes', (proxyRes) => {
            const ct = String(proxyRes.headers['content-type'] || '')
            if (ct.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
              delete proxyRes.headers['content-encoding']
            }
          })
        }
      }
    },
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG
  }
})
