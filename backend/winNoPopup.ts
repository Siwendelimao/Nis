/* winNoPopup.ts —— ★0930 弹窗终杀（进程入口级兜底）
 * 背景（实测"从设置/浏览器页启动浏览器会弹一个命令行窗"，已抓现行）：
 *   playwright 拉起的 `chrome-headless-shell.exe` 是【控制台子系统】的 exe，而 playwright-core
 *   的 spawnOptions 不带 windowsHide ⇒ 后端主进程没有控制台，每次拉起都会弹一个可见控制台窗
 *   （Windows Terminal 标签=exe 全路径，即截图里被截断的 `D:\nis0924\backend\data\env…`）。
 * 做法：node_modules 不可持久改（重装/升级即丢），于是在进程入口给 child_process 全家上兜底——
 *   凡没显式指定 windowsHide 的 spawn/spawnSync/execFile/execFileSync/exec/execSync/fork
 *   一律强制 windowsHide: true。显式传 windowsHide: false 的（比如真要弹窗）不拦。
 * 影响面：只隐藏"控制台窗"；有头 Chrome / 资源管理器这类 GUI 窗口 windowsHide 管不到、照常显示。
 * 本模块必须在任何 spawn 之前 import（server.ts 首行 import）。 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cp = require('node:child_process') as Record<string, any>

for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const orig = cp[fn]
  if (typeof orig !== 'function') continue
  cp[fn] = function patchedChildProcess(this: unknown, ...args: any[]) {
    // 选项对象按签名在第 1/2/3 参（(cmd, opts) / (cmd, args, opts)），取第一个"非数组对象"参数
    for (let i = 1; i < args.length; i++) {
      const a = args[i]
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        if (a.windowsHide === undefined) a.windowsHide = true
        break
      }
    }
    return orig.apply(this, args)
  }
}
