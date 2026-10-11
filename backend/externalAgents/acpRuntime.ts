/* acpRuntime.ts —— ★1010 P0：外部流 ACP 运行时（codex-acp 适配器 → PartEvent 归一层）
 * 契约：会话工作区《P0契约-ext-stream与PartEvent-1010.md》（PartEvent 7 类形状 / ext-stream 帧体 / 落盘体同一形状）。
 * 参考：会话工作区 _acp_probe/probe.mjs（spawn / 手写 JSON-RPC 换行分隔 / 反向请求拒绝手法，已真跑全绿）。
 *
 * 纪律（不得偏离）：
 *  · spawn 一律 windowsHide:true（0930 弹窗铁律）；shell:false。
 *  · 适配器反向请求（带 id）：session/request_permission（审批）→ 自动放行应答（★1010 三病①修复，
 *    P0 口径=会话工作目录内自动放行）；其余（fs/terminal 等）→ 回 error code -32601 拒绝；无 id 的是通知，不回。
 *  · AbortSignal 先发 session/cancel 再杀子进程（codex-acp SDK 口径：session/cancel 是**通知**，
 *    见包内 dist zCancelNotification { sessionId }），给它一个收轮窗口（800ms）再 kill。
 *  · seq 从 opts.startSeq（= session.extTranscript.length + 1）起单调递增，保证同会话跨轮单调；t = Date.now()。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BACKEND_ROOT, PROJECT_ROOT } from '../paths.ts'

/** PartEvent（= ext-stream 帧体 = extTranscript 落盘体，同一形状，契约为准，不得增删字段） */
export type PartEvent =
  | { kind: 'text'; seq: number; t: number; delta: string }
  | { kind: 'thought'; seq: number; t: number; delta: string }
  | { kind: 'tool-start'; seq: number; t: number; id: string; name: string; summary: string }
  | { kind: 'tool-end'; seq: number; t: number; id: string; detail?: string; isError?: boolean }
  | { kind: 'usage'; seq: number; t: number; inputTokens: number; cachedReadTokens: number; completionTokens: number; thoughtTokens?: number }
  | { kind: 'info'; seq: number; t: number; text: string }
  | { kind: 'turn-end'; seq: number; t: number; stopReason: string; ok: boolean; reason?: string }

/** 归一层内部体（seq/t 由 emit 统一填）——必须走泛型分发（直接 Omit<联合类型> 只剩公共字段） */
type StripSeqT<T> = T extends any ? Omit<T, 'seq' | 't'> : never
type PartBody = StripSeqT<PartEvent>

interface AcpTurnOpts {
  prompt: string
  cwd: string
  /** key/模型装配（server.ts runExternalTurnAcp 照 runExternalTurn 口径拼好传入）：
   *  跟随 NIS 档 = CODEX_HOME（临时 config.toml）+ NIS_GW_KEY 明文；own 档 = CODEX_API_KEY（有才注入）。 */
  extraEnv?: Record<string, string>
  /** codex 可执行文件（缺省 = 安装器固定的 external-agents\codex 路径） */
  codexPath?: string
  /** 整轮硬上限（默认 10min，同 runCodexTurn 口径） */
  timeoutMs?: number
  signal?: AbortSignal
  /** seq 起点（= session.extTranscript.length + 1）；缺省 1 */
  startSeq?: number
  /** ★1010j（已定案：跨轮上下文）：上一轮的 ACP 会话 id —— 用 session/load 把 codex 自己的会话（含它自己的压缩）续上；缺省/换模型=新建 */
  resumeAcpSessionId?: string
  /** 会话 id 回调（新建或 load 成功即回调，供 server 落盘到下轮用） */
  onAcpSessionId?: (sid: string) => void
}

interface AcpTurnResult {
  ok: boolean
  stopReason?: string
  reason?: string
}

/* ★1005 可移植性修复：原来这三处**写死了 `D:\nis0924\...`** —— 本机在、打包版装到别的目录或换机就全废
 *（同文件早就 import 了 BACKEND_ROOT，说明作者知道要用相对根，这三处漏了）。现在一律运行时派生：
 *  · AGENTS_ROOT：外部 agent 安装根（安装器就是往「NIS 根\external-agents\<id>\」装的）
 *  · NODE_DIR   ：**跑我们自己的那个 node** 在哪（比写死 toolchain 路径正确）
 *  · GIT_CMD    ：Git for Windows 的 cmd 目录；找不到就不塞 PATH（并留痕，不静默假装有）
 *  · codex 入口 ：**唯一权威 = 安装器写的 install.json.entry**（与"登录/查额度"读同一份），
 *                不再写死 site-packages 布局（换渠道/换版本就会变）。 */
const AGENTS_ROOT = path.join(PROJECT_ROOT, 'external-agents')
const NODE_DIR = path.dirname(process.execPath)

/** Git for Windows 的 cmd 目录（适配器要拉工具链）；找不到返回 null，调用方留痕 */
function resolveGitCmd(): string | null {
  for (const c of ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files (x86)\\Git\\cmd']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

/** codex 可执行文件：读安装器的记账（install.json.entry）。取不到返回 null ⇒ 调用方**显式失败**。 */
function resolveCodexBin(): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(AGENTS_ROOT, 'codex', 'install.json'), 'utf8'))
    const e = String(meta?.entry || '')
    return e && fs.existsSync(e) ? e : null
  } catch { return null }
}

/** 适配器入口：backend 依赖 @agentclientprotocol/codex-acp（bin=dist/index.js），从包清单解析（probe.mjs 同款手法） */
function resolveAdapterBin(): string {
  const pkgPath = path.join(BACKEND_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp', 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.['codex-acp'] || Object.values(pkg.bin || {})[0])
    if (binRel) return path.join(path.dirname(pkgPath), String(binRel))
  } catch { /* 包缺失/清单异常 → 走固定回落 */ }
  return path.join(BACKEND_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** prompt 响应 usage → 真值 usage 体（覆盖中途 usage_update 的估算，含 thoughtTokens） */
function usageBody(u: any): PartBody {
  return {
    kind: 'usage',
    inputTokens: num(u?.inputTokens ?? u?.used),
    cachedReadTokens: num(u?.cachedReadTokens ?? u?.cachedInputTokens),
    completionTokens: num(u?.outputTokens ?? u?.completionTokens),
    thoughtTokens: num(u?.thoughtTokens),
  }
}

/** content/输出体 → 纯文本（content 可能是 {type:'text',text}、数组、或 rawOutput 包一层 content） */
function extractText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(extractText).join('')
  if (typeof content?.text === 'string') return content.text
  return ''
}
function outText(raw: any): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw.slice(0, 4000)
  const t = extractText(raw?.content ?? raw)
  return (t || JSON.stringify(raw)).slice(0, 4000)
}

/* ★1010 三病③：工具摘要美化 —— 适配器 tool_call 的 title 对 shell 取整条命令（带 pwsh.exe 全路径）、
 * Guardian 类 rawInput 带 threadId/turnId JSON ⇒ 摘要层全是 JSON/全路径噪音。
 * 规则（任务单口径）：title 含 '{' / threadId / JSON 时改从 rawInput 重造摘要：
 *   · rawInput.command → 命令首段（去 pwsh.exe 全路径与壳参数）
 *   · rawInput.path   → 动作词 + 路径
 * 正常 title 原样保留（不碰好数据）。 */
const TOOL_ACTION_WORDS: Array<[RegExp, string]> = [
  [/write|create|save/i, '写入'], [/read|view|cat/i, '读取'], [/edit|patch|update/i, '编辑'],
  [/delete|remove/i, '删除'], [/search|grep|glob|find/i, '搜索'], [/list|\bls\b/i, '列出'],
  [/run|exec|shell|terminal|bash|command/i, '执行'],
]
/** rawInput.command → 命令首段：剥 pwsh/powershell/cmd 等解释器（全路径或裸名）与 -NoProfile/-Command 壳参数，取首词
 *  （export 仅供冒烟单测，零行为变化） */
export function commandHead(cmd: unknown): string {
  let parts = Array.isArray(cmd) ? cmd.map((x: any) => String(x)) : String(cmd ?? '').trim().split(/\s+/)
  parts = parts.map(s => s.replace(/^["']|["']$/g, '')).filter(Boolean)
  if (!parts.length) return ''
  const base0 = (parts[0].split(/[\\/]/).pop() || parts[0]).replace(/\.exe$/i, '')
  if (/^(pwsh|powershell|cmd|bash|sh|zsh)$/i.test(base0)) {
    parts = parts.slice(1)
    while (parts.length && /^-[A-Za-z]/.test(parts[0])) parts = parts.slice(1)   // -NoProfile -Command …
  }
  const head = (((parts[0] || '').split(/[\\/]/).pop()) || '').trim().split(/\s+/)[0] || ''
  return head.replace(/^["']|["']$/g, '').slice(0, 60)
}
/** tool_call 摘要：正常 title 原样；JSON/全路径噪音 → rawInput.command 命令首段，或 rawInput.path 动作词+路径
 *  （export 仅供冒烟单测，零行为变化） */
export function prettyToolSummary(name: string, u: any): string {
  const raw = String(u?.title || u?.description || '') || name
  if (!/[{]|threadId|JSON|[A-Za-z]:[\\/]|pwsh|powershell/i.test(raw)) return raw
  const input = u?.rawInput || {}
  const head = commandHead(input.command)
  if (head) return head
  const p = String(input.path || input.filePath || input.file || '')
  if (p) {
    const nm = String(u?.toolName || u?.kind || name)
    const word = (TOOL_ACTION_WORDS.find(([re]) => re.test(nm)) || [null, '调用'])[1]
    return `${word} ${p}`.slice(0, 80)
  }
  return name
}

/** session/update chunk → PartEvent 体（契约映射表，不得偏离；无法归类的 chunk → info） */
function mapUpdate(u: any): PartBody[] {
  const kind = String(u?.sessionUpdate || '')
  switch (kind) {
    case 'agent_message_chunk': {
      const text = extractText(u?.content)
      if (!text) return []
      /* info 吞吐规则（契约）：正文里以 Warning:/Error: 开头的 chunk 归 info（不进正文）——
         实测 codex 会把 "Warning: Model metadata … not found" 当正文块发（probe out.jsonl 有实例）。 */
      if (/^\s*(Warning:|Error:)/.test(text)) return [{ kind: 'info', text: text.trim() }]
      return [{ kind: 'text', delta: text }]
    }
    case 'agent_thought_chunk': {
      const text = extractText(u?.content)
      return text ? [{ kind: 'thought', delta: text }] : []
    }
    case 'tool_call': {
      const id = String(u?.toolCallId ?? u?.id ?? '') || `acp-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const name = String(u?.toolName || u?.kind || '') || 'tool'          // toolName 可空 → 回退 kind
      const summary = prettyToolSummary(name, u)   // ★1010 三病③：摘要美化（JSON/全路径噪音 → 命令首段/动作词+路径）
      return [{ kind: 'tool-start', id, name, summary }]
    }
    case 'tool_call_update': {
      const id = String(u?.toolCallId ?? u?.id ?? '')
      if (!id) return []
      const detail = outText(u?.output ?? u?.rawOutput)
      const status = String(u?.status || '')
      /* 契约：带 output/status 的 tool_call_update → tool-end（detail=output 文本，isError=status==='failed'）。
         护栏：pending/in_progress 的中间态 update（且无 output）不算收尾，等带输出/终态的 update 再收。 */
      const terminal = /completed|failed|cancelled|done|error/i.test(status)
      if (!detail && !terminal) return []
      return [{ kind: 'tool-end', id, detail: detail || undefined, isError: status === 'failed' }]
    }
    case 'usage_update': {
      /* 契约：{used,size} 形状归一为 inputTokens=used、其余 0（收轮 prompt 响应 usage 才是真值，后到覆盖） */
      if (u?.used != null || u?.size != null) {
        return [{ kind: 'usage', inputTokens: num(u?.used), cachedReadTokens: 0, completionTokens: 0, thoughtTokens: 0 }]
      }
      return [usageBody(u)]
    }
    case 'session_info_update': {
      const bits: string[] = []
      if (u?.displayName) bits.push(`标题 ${u.displayName}`)
      if (u?.cwd) bits.push(`目录 ${u.cwd}`)
      if (u?.model) bits.push(`模型 ${u.model}`)
      return [{ kind: 'info', text: bits.length ? `会话信息：${bits.join('，')}` : '会话信息更新' }]
    }
    case 'available_commands_update': {
      const names = (Array.isArray(u?.availableCommands) ? u.availableCommands : [])
        .map((c: any) => String(c?.name || '')).filter(Boolean)
      return [{ kind: 'info', text: names.length ? `可用命令：${names.join('、')}` : '可用命令更新' }]
    }
    case '':
      return []
    default:
      /* 契约：无法归类的 chunk → info（元数据/标题类） */
      return [{ kind: 'info', text: `[事件 ${kind}] ${JSON.stringify(u).slice(0, 300)}` }]
  }
}

/** 跑一轮 ACP：spawn 适配器 → initialize → session/new → session/prompt，session/update 逐 chunk 归一回调。
 *  返回收轮 stopReason/ok；异常与超时如实返回（生命周期关账在 server.ts runExternalTurnAcp 外壳里）。 */
export function runAcpTurn(opts: AcpTurnOpts, onPart: (part: PartEvent) => void): Promise<AcpTurnResult> {
  return new Promise((resolve) => {
    const bin = resolveAdapterBin()
    /* ★1005：codex 入口先解析（取不到不在这里失败 —— 要让 finish() 走"恰好一条 turn-end"的收尾口径，
       见下面 async IIFE 开头的显式报错）。git 目录找不到只留痕，不阻塞（用户机器上可能真没装 Git）。 */
    const codexBin = opts.codexPath || resolveCodexBin()
    const gitDir = resolveGitCmd()
    if (!gitDir) console.warn('[acp] 没找到 Git for Windows 的 cmd 目录（C:\Program Files\Git\cmd）—— 适配器的工具链可能受限')
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: [NODE_DIR, gitDir, process.env.PATH || ''].filter(Boolean).join(';'),
      ...(codexBin ? { CODEX_PATH: codexBin } : {}),
      ...(opts.extraEnv || {}),
    }
    const child = spawn(process.execPath, [bin], {
      env,
      windowsHide: true,   // 弹窗纪律（0930 硬规矩）
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let seq = Number(opts.startSeq) > 0 ? Number(opts.startSeq) : 1
    const emit = (body: PartBody): void => {
      /* ★1005 诚实性：原来 `seq++` 写在调用**之前**的同一个表达式里 —— 回调一抛错，号已经占了、
         片段却丢了 ⇒ 前端看到的是**永久缺号**（还不知道是谁丢的）。现在只有回调成功才推进 seq，
         失败的片段**留痕**（不是静默），且后续号连续、不会伪造"缺号"。 */
      const part = { ...(body as any), seq, t: Date.now() } as PartEvent
      try {
        onPart(part)
        seq++
      } catch (e) {
        console.warn('[acp] PartEvent 回调失败，该片段已丢弃（不占 seq，后续号保持连续）：', e)
      }
    }

    let nextId = 1
    let curSessionId = ''
    let settled = false
    let turnEndSent = false
    let aborted = false
    let replaying = false   // ★1010j：session/load 重放历史期间不落 extTranscript/不发帧（防与回放双份）
    let killer: ReturnType<typeof setTimeout> | undefined
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    const write = (obj: unknown): void => {
      try { child.stdin.write(JSON.stringify(obj) + '\n') } catch { /* stdin 已断 */ }
    }
    const send = (method: string, params: unknown, timeoutMs: number): Promise<any> =>
      new Promise((res2, rej2) => {
        const id = nextId++
        pending.set(id, { resolve: res2, reject: rej2 })
        write({ jsonrpc: '2.0', id, method, params })
        setTimeout(() => { if (pending.delete(id)) rej2(new Error(`ACP 超时：${method}`)) }, timeoutMs)
      })
    /* 取消：先 session/cancel 通知（SDK 口径=通知，带 sessionId），给 800ms 收轮窗口再杀子进程 */
    const sendCancel = (): void => {
      if (curSessionId) write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: curSessionId } })
    }
    const emitTurnEnd = (stopReason: string, ok: boolean, reason?: string): void => {
      if (turnEndSent) return
      turnEndSent = true
      emit({ kind: 'turn-end', stopReason, ok, ...(reason ? { reason } : {}) })
    }
    const finish = (result: AcpTurnResult): void => {
      if (settled) return
      settled = true
      /* 兜底：任何收尾路径都必须恰好一条 turn-end（前端按它关流） */
      emitTurnEnd(String(result.stopReason || 'error'), false, result.reason || '未收轮')
      if (killer) clearTimeout(killer)
      for (const [, p] of pending) p.reject(new Error('ACP 已收尾'))
      pending.clear()
      try { child.kill() } catch { /* 已退出 */ }
      resolve(result)
    }

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += String(d)
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        let m: any
        try { m = JSON.parse(line) } catch {
          emit({ kind: 'info', text: `[ACP 非 JSON 行] ${line.slice(0, 200)}` })
          continue
        }
        if (m.method && m.id !== undefined) {
          /* ★1010 三病①修复：session/request_permission 是**审批请求** —— 一律回 -32601 等于拒绝审批，
             codex 审批基建直接挂（Shell is unavailable due to review infrastructure failure）
             ⇒ shell 反复重试 / 写文件被拦。P0 口径（1001 已拍板 danger-full-access）= 自动放行：
             options 里 kind=allow_always 优先、次选 allow_once；
             应答形状（SDK schema + 适配器 dist 双重实锤）：result={outcome:{outcome:'selected',optionId:<选项id>}}，
             options 形状 {optionId,name,kind}，kind∈allow_once/allow_always/reject_once/reject_always。
             其余反向请求（fs/terminal 等，initialize 已声明不支持）维持 -32601 拒绝。无 id 的是通知，不回。 */
          if (m.method === 'session/request_permission') {
            const popts: any[] = Array.isArray(m.params?.options) ? m.params.options : []
            const pick = popts.find((o: any) => String(o?.kind || '') === 'allow_always')
              || popts.find((o: any) => String(o?.kind || '') === 'allow_once')
            if (pick && pick.optionId != null) {
              write({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } })
              console.log('[acp] 自动放行审批：', String(pick.kind), String(pick.name || '').slice(0, 60))
            } else {
              /* 没有可放行选项（畸形/纯拒绝）→ 维持 -32601 拒绝（不瞎选 reject，语义如实） */
              console.log('[acp] 审批无可放行选项（留证形状）', JSON.stringify(m.params || {}).slice(0, 300))
              write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nis: not supported' } })
            }
          } else {
            console.log('[acp] 未匹配反向请求（留证形状）', m.method, JSON.stringify(m.params || {}).slice(0, 300))
            write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nis: not supported' } })
          }
        } else if (m.method === 'session/update') {
          if (!replaying) for (const body of mapUpdate(m.params?.update || {})) emit(body)   // ★1010j：load 重放丢弃
        } else if (m.method) {
          /* 其余通知（_auth/status_update 等元数据）：只留后端日志，不上界面 */
          if (String(m.method).startsWith('_auth/')) console.log('[acp]', m.method, JSON.stringify(m.params || {}).slice(0, 160))
        } else if (m.id !== undefined && pending.has(m.id)) {
          const p = pending.get(m.id)!; pending.delete(m.id)
          m.error ? p.reject(new Error(typeof m.error === 'string' ? m.error : JSON.stringify(m.error))) : p.resolve(m.result)
        }
      }
    })
    child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log('[acp][adapter stderr]', s.slice(0, 200)) })
    child.on('error', (e) => finish({ ok: false, reason: `适配器启动失败：${String(e)}` }))
    child.on('exit', (code) => {
      if (settled) return
      for (const [, p] of pending) p.reject(new Error(`适配器提前退出（code=${code}）`))
      pending.clear()
      finish({ ok: false, reason: `适配器提前退出（code=${code}）` })
    })

    /* 整轮硬上限（同 runCodexTurn 口径）：到点 cancel + 杀 */
    const hardTimeout = opts.timeoutMs ?? 10 * 60 * 1000
    killer = setTimeout(() => {
      sendCancel()
      setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 300)
      finish({ ok: false, reason: `外部轮超时（${Math.round(hardTimeout / 60000)} 分钟上限）` })
    }, hardTimeout)

    opts.signal?.addEventListener('abort', () => {
      aborted = true
      sendCancel()
      setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 800)
    }, { once: true })

    void (async () => {
      try {
        /* ★1005 诚实性：用户配了 codex 预设但本机装的东西找不到时，**明确说清楚并失败** ——
           不许静默换用适配器自带的别的 codex（那会让"用过哪份 codex"变成谜）。 */
        if (!codexBin) {
          throw new Error('找不到已安装的 codex（external-agents\\codex\\install.json 缺失或 entry 已失效）—— 请在设置里重新安装该外部 agent')
        }
        await send('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'nis', title: 'NIS', version: '1.0.0' },
        }, 60000)
        /* ★1010j：有上轮会话 id → session/load 续上（codex 自己的上下文/压缩在它那边）；load 失败如实回退新建 */
        let sessOk = false
        if (opts.resumeAcpSessionId) {
          try {
            replaying = true
            await send('session/load', { sessionId: String(opts.resumeAcpSessionId), cwd: String(opts.cwd || process.cwd()), mcpServers: [] }, 60000)
            curSessionId = String(opts.resumeAcpSessionId)
            sessOk = true
            console.log('[acp] 已续上上一轮会话:', curSessionId.slice(0, 12))
          } catch (e: any) {
            console.warn('[acp] session/load 失败，回退新建会话：', String(e?.message || e).slice(0, 160))
          } finally { replaying = false }
        }
        if (!sessOk) {
          const sess = await send('session/new', { cwd: String(opts.cwd || process.cwd()), mcpServers: [] }, 60000)
          curSessionId = String(sess?.sessionId || '')
          if (!curSessionId) throw new Error('ACP session/new 未返回 sessionId')
        }
        try { opts.onAcpSessionId?.(curSessionId) } catch { /* 回调失败不拦主流程 */ }
        const res = await send('session/prompt', {
          sessionId: curSessionId,
          prompt: [{ type: 'text', text: String(opts.prompt || '') }],
        }, hardTimeout)
        /* ★1005 诚实性修复：**缺 stopReason 不是"正常结束"**。原来写 `String(res?.stopReason || 'end_turn')`
           并据此判 ok=true ⇒ 适配器没回结论（响应畸形/字段缺失）会被当成成功上报，把失败说成成功。
           协议字段缺失/类型不符一律显式报错，不设默认值。 */
        const rawStop = res?.stopReason
        if (typeof rawStop !== 'string' || !rawStop) {
          finish({ ok: false, stopReason: 'error', reason: '适配器未返回 stopReason（响应畸形，拒绝当成功）' })
          return
        }
        const stopReason = rawStop
        /* 收轮 usage = 真值（覆盖中途 usage_update 的 {used,size} 估算），含 thoughtTokens */
        if (res?.usage) emit(usageBody(res.usage))
        emitTurnEnd(stopReason, stopReason === 'end_turn', stopReason === 'end_turn' ? undefined : stopReason)
        finish({ ok: stopReason === 'end_turn', stopReason })
      } catch (e: any) {
        const reason = String(e?.message || e).slice(0, 300)
        if (settled) return
        emitTurnEnd(aborted ? 'cancelled' : 'error', false, aborted ? '已取消' : reason)
        finish({ ok: false, stopReason: aborted ? 'cancelled' : 'error', reason: aborted ? '已取消' : reason })
      }
    })()
  })
}
