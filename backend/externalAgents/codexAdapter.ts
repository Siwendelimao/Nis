/* codexAdapter.ts —— 外部预设打样：codex exec --json 事件流 → NIS 契约（骨架版 1001）
 * 图纸：D:\nis0924\docs\外部预设-codex事件映射-1001.md（含实测修正）
 * 纪律：spawn stdin 必须 'ignore'（否则 codex 干等输入）；windowsHide；shell:false；超时杀进程。
 * 记账口径：usage 只记 codex 自报的量，进 token 面板标「外部口径」。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EXT_AGENTS_DIR } from './registry.ts'

const FALLBACK_CODEX_BIN = 'D:\\nis0924\\toolchain\\codex\\codex_cli_bin\\bin\\codex.exe'

/** ★1001：优先用「外部 agent 安装器」装到固定文件夹的 codex（external-agents\codex\）；
 *  找不到再回落手工安装的 toolchain 路径。 */
export function resolveCodexBin(): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(EXT_AGENTS_DIR, 'codex', 'install.json'), 'utf8'))
    if (j?.entry && fs.existsSync(String(j.entry))) return String(j.entry)
  } catch { /* 未装/账本缺失 */ }
  return FALLBACK_CODEX_BIN
}
/** 归一事件（NIS 侧消费的最小契约面） */
type NisExternalEvent =
  | { kind: 'turn_start'; threadId?: string }
  | { kind: 'text'; text: string }                                   // agent_message → 正文
  | { kind: 'thinking'; text: string }                               // reasoning → 思考块
  | { kind: 'tool'; name: string; summary: string; status: 'running' | 'ok' | 'fail'; detail?: string }
  | { kind: 'usage'; inputTokens: number; cacheReadTokens: number; completionTokens: number }
  | { kind: 'notice'; text: string }                                 // error/自愈消息 → 内联提示（非致命）
  | { kind: 'turn_end'; ok: boolean; reason?: string }

/** 单行 JSONL → 归一事件（纯函数，可单测） */
export function mapCodexEvent(raw: string): NisExternalEvent[] {
  const s = String(raw || '').trim()
  if (!s) return []
  let ev: any
  try { ev = JSON.parse(s) } catch { return [{ kind: 'notice', text: s.slice(0, 300) }] }
  switch (ev?.type) {
    case 'thread.started':
      return [{ kind: 'turn_start', threadId: ev.thread_id ? String(ev.thread_id) : undefined }]
    case 'turn.started':
      return [{ kind: 'turn_start' }]
    case 'item.started': {
      const it = ev.item || {}
      if (it.type === 'command_execution' || it.type === 'mcp_tool_call' || it.type === 'file_change' || it.type === 'web_search') {
        return [{ kind: 'tool', name: String(it.type), summary: itemSummary(it), status: 'running' }]
      }
      return []
    }
    case 'item.updated':   // delta 档（存在与否待登录后实测；先按整段处理，有 delta 就当 text 增量）
      return ev.item?.text ? [{ kind: 'text', text: String(ev.item.text) }] : []
    case 'item.completed': {
      const it = ev.item || {}
      switch (it.type) {
        case 'agent_message': return it.text ? [{ kind: 'text', text: String(it.text) }] : []
        case 'reasoning': return it.text ? [{ kind: 'thinking', text: String(it.text) }] : []
        case 'command_execution':
        case 'mcp_tool_call':
        case 'file_change':
        case 'web_search': {
          const fail = /fail|error/i.test(String(it.status || ''))
          return [{ kind: 'tool', name: String(it.type), summary: itemSummary(it), status: fail ? 'fail' : 'ok', detail: itemDetail(it) }]
        }
        case 'plan_update': return [{ kind: 'notice', text: '[计划更新] ' + itemSummary(it) }]
        case 'error': return [{ kind: 'notice', text: String(it.message || '') }]
        default: return []
      }
    }
    case 'turn.completed': {
      const u = ev.usage || {}
      const out: NisExternalEvent[] = []
      out.push({
        kind: 'usage',
        inputTokens: Number(u.input_tokens || 0),
        cacheReadTokens: Number(u.cached_input_tokens || 0),
        completionTokens: Number(u.output_tokens || 0) + Number(u.reasoning_output_tokens || 0),
      })
      out.push({ kind: 'turn_end', ok: true })
      return out
    }
    case 'turn.failed':
      return [{ kind: 'turn_end', ok: false, reason: String(ev?.error?.message || ev?.message || 'turn.failed') }]
    case 'error':
      return [{ kind: 'notice', text: String(ev.message || '') }]   // 瞬断重连等自愈消息，不致死
    default:
      return []
  }
}

function itemSummary(it: any): string {
  return String(it.command || it.name || it.path || (Array.isArray(it.changes) ? it.changes.map((c: any) => c?.path).filter(Boolean).join(', ') : '') || it.query || it.type || '')
}
function itemDetail(it: any): string | undefined {
  const d = it.output ?? it.result ?? it.diff ?? it.text
  return d == null ? undefined : String(d).slice(0, 4000)
}

interface CodexTurnOpts {
  prompt: string
  cwd: string
  threadId?: string          // 有则 resume 续聊（exec resume <id>）
  resumeLast?: boolean       // 或 --last
  model?: string             // -m
  apiKey?: string            // 跟随NIS档：CODEX_API_KEY 内联给本次运行
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  timeoutMs?: number         // 默认 10min 硬上限（cancel 兜底同款口径）
  extraEnv?: Record<string, string>   // 跟随NIS档：CODEX_HOME（自定义服务商配置）/ 服务商 env_key 钥匙
  ignoreRules?: boolean      // 跳过 execpolicy .rules（Windows 上默认策略会拦 shell 命令，1001 实测）
  signal?: AbortSignal       // 取消（session.cancel → 杀子进程）
}

/** 跑一轮 codex，事件流逐行翻译后回调。返回线程 id 与最终 ok。 */
export function runCodexTurn(opts: CodexTurnOpts, onEvent: (e: NisExternalEvent) => void): Promise<{ ok: boolean; threadId?: string; reason?: string }> {
  return new Promise((resolve) => {
    const args: string[] = []
    if (opts.threadId) args.push('exec', 'resume', opts.threadId)
    else if (opts.resumeLast) args.push('exec', 'resume', '--last')
    else args.push('exec')
    args.push('--json', '--skip-git-repo-check', '--ephemeral', '-C', opts.cwd)
    if (opts.sandbox) args.push('--sandbox', opts.sandbox)
    if (opts.ignoreRules) args.push('--ignore-rules')
    if (opts.model) args.push('-m', opts.model)
    args.push(opts.prompt)

    const env = { ...process.env }
    if (opts.apiKey) env.CODEX_API_KEY = opts.apiKey   // 跟随NIS档；不给=用它自己的登录态
    if (opts.extraEnv) Object.assign(env, opts.extraEnv)
    const child = spawn(resolveCodexBin(), args, {
      windowsHide: true,     // 弹窗纪律（0930 硬规矩）
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],   // ★stdin 必须 ignore：开着 codex 会干等输入
    })

    let threadId: string | undefined
    let ok = false
    let reason: string | undefined
    let buf = ''
    let errBuf = ''
    const killer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, opts.timeoutMs ?? 10 * 60 * 1000)

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
        for (const e of mapCodexEvent(line)) {
          if (e.kind === 'turn_start' && e.threadId) threadId = e.threadId
          if (e.kind === 'turn_end') { ok = e.ok; reason = e.reason }
          onEvent(e)
        }
      }
    })
    child.stderr.on('data', (d) => { errBuf += d.toString('utf8').slice(-2000) })   // ★留证：暴毙时全靠它定位（1001 踩过）
    child.on('exit', () => {
      clearTimeout(killer)
      if (buf.trim()) for (const e of mapCodexEvent(buf)) { if (e.kind === 'turn_end') { ok = e.ok; reason = e.reason } onEvent(e) }
      if (!ok && !reason) reason = '进程退出但未见 turn.completed（截断体检：看尾部标记）'
      if (!ok && errBuf.trim()) reason = (reason || '') + ' | stderr: ' + errBuf.trim().slice(0, 300)
      resolve({ ok, threadId, reason })
    })
    child.on('error', (e) => {
      clearTimeout(killer)
      resolve({ ok: false, reason: String(e) })
    })
    opts.signal?.addEventListener('abort', () => { try { child.kill() } catch { /* ignore */ } })
  })
}
