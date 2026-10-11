/**
 * 进程保护 —— 无差别进程杀伤命令拦截（0902 事故修复）
 *
 * 事故：团队成员执行 `taskkill /F /IM node.exe 2>nul`（本意杀自己起的测试服务），
 * Windows 下 /IM 按映像名无差别全杀 → pi-bridge(8766)/vite(5174)/成员链全部团灭，
 * 回合未走到结束快照 → 聊天记录丢。
 *
 * 规则：按映像名杀 node/node.exe/pwsh 的命令一律拒绝（主 agent 与成员同拦）；
 * 带 /PID 的精确击杀放行。独立模块避免 server.ts ↔ teamRuntime.ts 循环依赖。
 */

const PROTECTED_IMAGES = new Set(['node', 'node.exe', 'pwsh', 'pwsh.exe'])

/** 检测无差别进程杀伤命令。返回 null=放行；命中返回 {cmd, image} 供提示语拼装 */
export function matchIndiscriminateKillCommand(raw: string): { cmd: string; image: string } | null {
  const cmd = String(raw || '')
  if (!cmd) return null
  // taskkill（含 taskkill.exe）：拦 /IM 按映像名；/PID 精确击杀不进此分支
  const im = /\/im\s+(\S+)/i.exec(cmd)
  /* 0927 netfix sec-guard-0927：/FI 过滤器形态（taskkill /FI "IMAGENAME eq node.exe"）同样要拦 */
  const fi = /\/fi\s+["']?imagename\s+eq\s+([^"']+)["']?/i.exec(cmd)
  if (/\btaskkill(\.exe)?\b/i.test(cmd) && (im || fi)) {
    const imageRaw = im ? im[1] : (fi ? fi[1] : '')
    const image = imageRaw.replace(/^"|"$/g, '').trim().toLowerCase()
    if (PROTECTED_IMAGES.has(image)) {
      return { cmd: cmd.slice(0, 120), image: image === 'node' ? 'node.exe' : image }
    }
  }
  if (im) {
    const image = im[1].replace(/^"|"$/g, '').toLowerCase()
    if (PROTECTED_IMAGES.has(image)) {
      return { cmd: cmd.slice(0, 120), image: image === 'node' ? 'node.exe' : image }
    }
    return null
  }
  // PowerShell：Stop-Process -Name node / Get-Process node | Stop-Process
  if (/stop-process\s+[^|;\n]*-name\s+["']?(node|pwsh)(\.exe)?["']?/i.test(cmd)) return { cmd: cmd.slice(0, 120), image: 'node.exe' }
  if (/get-process\s+["']?node(\.exe)?["']?/i.test(cmd) && /stop/i.test(cmd)) return { cmd: cmd.slice(0, 120), image: 'node.exe' }
  // Unix 系：pkill node / killall node
  const pk = /(?:^|\s|\/)(pkill|killall)(?:\s|$)/i.exec(cmd)
  if (pk) {
    /* 0927 netfix sec-guard-0927：先剥掉旗标（killall -9 node / pkill -f -9 node）再认名字 */
    const rest = cmd.slice((pk.index || 0) + pk[0].length).trim().replace(/^(?:-\S+\s+)+/, '').replace(/^-f\s+/, '')
    if (/^["']?(node|pwsh)(\.exe)?["']?(?:\s|$)/i.test(rest)) return { cmd: cmd.slice(0, 120), image: 'node.exe' }
  }
  return null
}
