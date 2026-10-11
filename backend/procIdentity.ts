/**
 * 进程身份工具（0922e）—— 从 backgroundTasks.ts 抽出来共用，避免循环依赖。
 *
 * 为什么需要"身份指纹"：Windows 的 pid 会被系统复用，只凭 pid 去杀进程可能误伤别人的程序。
 * 所以登记时记下**进程创建时间**（ToFileTimeUtc，100ns 精度）当指纹，动手前再查一次比对。
 *
 * ★ 口径统一（0922e 实测踩过）：指纹一律走 **CIM** `Get-CimInstance Win32_Process …CreationDate`；
 *   早先 procStartStamp 用的是 `Get-Process …StartTime`，两个 API 精度不同 ⇒ 同一进程比对不上，
 *   会把活着的残留误判成"pid 已被复用"而跳过。比较另加 **2 秒容差**兜底。
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 读某进程的创建时间（ToFileTimeUtc 字符串）。
 *  返回：非空串=指纹；''=确实查无此进程；null=**查询失败/参数非法**（证明不了身份，调用方必须按"不确定"处理）。
 *  ★1003 安全批 4.26/4.27：① pid 是运行时值（TS 类型擦除后无人拦），原来直接拼进 PowerShell
 *  -Filter 字符串 = 命令注入面（`1'; Remove-Item …` 可逃逸）——先验正整数再用；
 *  ② 查询失败（PowerShell 超时/异常/非零退出）原来被吞成 '' ⇒ 调用方把"查失败"当"进程不存在"
 *  （活进程被注销+报成功）——现在分开回 null。 */
export function procStartStamp(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CreationDate) { try { [string]$p.CreationDate.ToFileTimeUtc() } catch { '' } }`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (r.error || r.status !== 0) return null
    const v = String(r.stdout || '').trim()
    return /^\d{10,}$/.test(v) ? v : ''
  } catch { return null }
}

/** 两个 FileTime 指纹是否指向同一个进程（2 秒容差 —— 不同 API 精度可能差毫秒级）
 *  FileTime 单位 = 100ns ⇒ 2 秒 = 2e7。pid 复用通常发生在原进程结束很久之后，误判风险极低。 */
export function sameStamp(a: string, b: string): boolean {
  const x = Number(a)
  const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return false
  return Math.abs(x - y) < 2e7
}

/** 一次拿全机器进程表（pid|ppid|name|创建时间 FileTime），在调用方建树 —— 比逐层查询快得多 */
export function snapshotProcesses(): { pid: number; ppid: number; name: string; start: string }[] {
  try {
    const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | ForEach-Object { $t=''; if ($_.CreationDate) { try { $t=[string]$_.CreationDate.ToFileTimeUtc() } catch {} }; '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $t }`],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 })
    const out: { pid: number; ppid: number; name: string; start: string }[] = []
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const p = line.trim().split('|')
      if (p.length < 4) continue
      const pid = Number(p[0])
      const ppid = Number(p[1])
      if (!Number.isFinite(pid) || pid <= 0) continue
      out.push({ pid, ppid: Number.isFinite(ppid) ? ppid : 0, name: p[2] || '', start: p[3] || '' })
    }
    return out
  } catch { return [] }
}
