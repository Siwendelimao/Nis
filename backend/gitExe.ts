/* gitExe.ts —— git 可执行文件解析（★0930 修"设置里装了 git，git 工具却说没装"）
 * 根因两套口径打架：设置→软件环境 按【绝对路径】探测（C:\Program Files\Git\cmd\git.exe ⇒ 显示已安装）；
 * 而 git 工具用裸名 'git' 走 PATH —— 后端进程的 PATH 里没有 Git\cmd（实测也没有 node/npm），
 * execFile('git') 直接 ENOENT ⇒ 报"本机没有安装 git"。装了 ≠ 后端找得到。
 * 这里按绝对路径候选解析（lstatSync 认链接——WindowsApps AppExecLink 的坑见 server.ts 0917 注释），
 * 带缓存；都找不到才退回裸名（PATH 里有时的机器）。 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts' // ★0930c：NIS 环境目录（有的环境直接装进软件目录）

let cached: string | null = null

export function gitExe(): string {
  if (cached) return cached
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const lp = process.env.LOCALAPPDATA || ''
  /* ★0930c 用户提醒"有的环境装在 NIS 软件目录"：候选要同时覆盖
     ① NIS 环境目录（<DATA_ROOT>/env 下，未来 git 若走 NIS 安装会落这里）
     ② C 盘/系统标准位置（winget 装法）③ 用户目录/便携版 ④ D:\Git ⑤ 裸名走 PATH 兜底。 */
  const envDir = path.join(DATA_ROOT, 'env')
  const cands = [
    path.join(envDir, 'Git', 'cmd', 'git.exe'),
    path.join(envDir, 'git', 'cmd', 'git.exe'),
    path.join(envDir, 'mingit64', 'cmd', 'git.exe'),
    path.join(envDir, 'cmd', 'git.exe'),
    path.join(pf, 'Git', 'cmd', 'git.exe'),
    path.join(pf86, 'Git', 'cmd', 'git.exe'),
    lp ? path.join(lp, 'Programs', 'Git', 'cmd', 'git.exe') : '',
    path.join(pf, 'Git', 'bin', 'git.exe'),
    path.join('D:\\', 'Git', 'cmd', 'git.exe'),
  ].filter(Boolean)
  for (const c of cands) {
    try { fs.lstatSync(c); cached = c; return c } catch { /* try next */ }
  }
  cached = 'git' // 兜底：PATH 里有时也认
  return cached
}

/** npm 运行方式解析（★0930c）：本机 toolchain 只带 node.exe 不带 npm ⇒ 裸名恒 ENOENT。
 *  优先 NIS 软件环境目录装的 npm（<envDir>/npm，设置→软件环境一键安装），其次系统 Node 自带的；
 *  都没有返回 null（调用方明确提示"去装"，而不是硬跑报错）。
 *  统一用【应用自带 node + npm-cli.js】跑——npm.cmd 是批处理，Windows execFile 裸跑会 EINVAL。 */
export function npmCmd(): { bin: string; args: string[] } | null {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const envDir = path.join(DATA_ROOT, 'env')
  for (const cli of [
    path.join(envDir, 'npm', 'bin', 'npm-cli.js'),
    path.join(pf, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    try { fs.lstatSync(cli); return { bin: process.execPath, args: [cli] } } catch { /* try next */ }
  }
  return null
}
