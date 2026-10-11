/**
 * MCP 运行时 —— NIS 的 Model Context Protocol 客户端集成。
 *
 * 能力：
 *   - 连接管理：backend/data/mcp-servers/<name>/server.json 配置驱动（stdio 子进程 / StreamableHTTP 远程）
 *   - 工具桥接：MCP server 的工具 → pi AgentTool（mcp__<server>__<tool>），自动进各 agent 工具集
 *   - 生命周期：随启动初始化、断线标记、按需重连、移除清理
 *
 * 参考 Cline McpHub 架构（官方 SDK 承担协议层，本模块只做桥接与生命周期）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'
import { execFile } from 'node:child_process'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitExe, npmCmd } from './gitExe.ts' // ★0930b：git/npm 绝对路径解析（后端 PATH 无 Git 无 npm）
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DATA_ROOT } from './paths.ts'

const MCP_SERVERS_DIR = path.join(DATA_ROOT, 'mcp-servers')

export interface McpServerConfig {
  /** stdio 型：启动命令（如 npx / node） */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** stdio 型：工作目录（本地仓库/包目录，相对路径命令在此执行） */
  cwd?: string
  /** 远程型：StreamableHTTP 端点 */
  url?: string
  /** 描述（记录来源/用途） */
  description?: string
  /** 启用/停用（0904 开关B，缺省 true）：false=装了但不用——不连进程、不注入工具、仓库置灰 */
  enabled?: boolean
  /** 选择（0904 反馈④b，缺省 true）：复选=选用该服务；不选不断进程不删配置，仅不注入工具。
   *  与开关B 是两维：B 管"在岗"，selected 管"被选用"；agent 可用 = 预设总开关 ∧ B 启用 ∧ selected。 */
  selected?: boolean
  /** 内置虚拟 server（0904 浏览器）：进程内直接分发到本地引擎，不启动子进程、无 server.json 目录、不可移除 */
  virtual?: boolean
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: any
}

export interface McpServerState {
  name: string
  config: McpServerConfig
  status: 'connected' | 'connecting' | 'error' | 'disconnected'
  error?: string
  tools: McpToolInfo[]
  connectedAt?: number
  /** 开关B 视图字段（缺省启用） */
  enabled?: boolean
  /** 服务选择视图字段（缺省选中） */
  selected?: boolean
  /** 内置虚拟 server（进程内分发） */
  virtual?: boolean
}

const servers = new Map<string, McpServerState>()
const clients = new Map<string, Client>()
/** 虚拟 server 的工具分发器：name → (toolName, args, sessionId) => 文本结果（execute 里调本地引擎，不走 client.callTool）。
 *  details=可选的结构化附加数据（如 wb_send_screenshot 的 dataUrl），vcall 包装层透传给前端渲染 */
const virtualCalls = new Map<string, (toolName: string, args: Record<string, any>, sessionId?: string) => Promise<{ text: string; isError?: boolean; details?: Record<string, any> }>>()
/** 虚拟 server 的 启用/选择 持久化（不能写 data/mcp-servers/<name>/server.json，否则 mcpHubInit 会当 stdio server 去连失败） */
const VIRTUAL_STATE_PATH = path.join(MCP_SERVERS_DIR, '.virtual-state.json')
function loadVirtualState(): Record<string, { enabled?: boolean; selected?: boolean }> {
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 回落空表；损坏先备份 .corrupt-* 再回落 + 明确日志
     （旧逻辑：损坏也静默 return {} → 用户的启用/选择状态无声消失）。 */
  const r = loadJsonOrBackup<Record<string, { enabled?: boolean; selected?: boolean }>>(VIRTUAL_STATE_PATH, () => ({}))
  return (r.data && typeof r.data === 'object') ? r.data : {}
}
function saveVirtualState(name: string, patch: { enabled?: boolean; selected?: boolean }): void {
  const all = loadVirtualState()
  all[name] = { ...(all[name] || {}), ...patch }
  /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）替换裸 writeFileSync */
  writeJsonAtomic(VIRTUAL_STATE_PATH, all)
}

/** 注册内置虚拟 MCP server（如 nis-browser）。幂等：已存在只刷新工具/分发器，保留已持久化的 enabled/selected。 */
export function registerVirtualServer(
  name: string,
  opts: { description?: string; tools: McpToolInfo[]; call: (toolName: string, args: Record<string, any>, sessionId?: string) => Promise<{ text: string; isError?: boolean; details?: Record<string, any> }> },
): void {
  const persisted = loadVirtualState()[name] || {}
  virtualCalls.set(name, opts.call)
  const existing = servers.get(name)
  const state: McpServerState = {
    name,
    config: { description: opts.description || '', enabled: persisted.enabled !== false, selected: persisted.selected !== false, virtual: true },
    status: 'connected',
    tools: opts.tools,
    connectedAt: existing?.connectedAt || Date.now(),
    enabled: persisted.enabled !== false,
    selected: persisted.selected !== false,
    virtual: true,
  }
  servers.set(name, state)
}

function configPath(name: string): string {
  return path.join(MCP_SERVERS_DIR, name, 'server.json')
}

function sanitizeName(name: string): string {
  const out = String(name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48)
  // 0906 体检 P0#4：'..' 原样通过会令 path.join(MCP_DIR, '..') 指向 DATA_ROOT 被递归删除
  if (/^\.{1,2}$/.test(out)) throw new Error('非法名称（不允许相对路径段）')
  return out
}

/** 连接（或重连）一个 MCP server；成功后缓存工具清单 */
export async function mcpHubConnect(name: string, config: McpServerConfig): Promise<{ ok: boolean; error?: string; tools?: McpToolInfo[] }> {
  const clean = sanitizeName(name)
  if (!clean) return { ok: false, error: 'name 不合法' }
  // 内置虚拟 server：无子进程可连，"重连"直接返回其工具（避免 command/url 校验失败）
  if (servers.get(clean)?.virtual) return { ok: true, tools: servers.get(clean)!.tools }
  if (!config?.command && !config?.url) return { ok: false, error: '配置缺少 command（stdio）或 url（远程）' }

  // 已停用的（0904 开关B）：登记状态但不连进程——装了≠要用
  if (config.enabled === false) {
    await mcpHubDisconnect(clean, true)
    servers.set(clean, { name: clean, config, status: 'disconnected', tools: [], enabled: false })
    return { ok: true, tools: [] }
  }

  // 已连接的先断开
  await mcpHubDisconnect(clean, true)

  const state: McpServerState = { name: clean, config, status: 'connecting', tools: [], enabled: true }
  servers.set(clean, state)

  /* ★1003 并发批 4.14 配套：client 提升到 try 外 —— catch 里要负责关掉它（原声明在 try 内，够不着） */
  let client: Client | undefined
  try {
    client = new Client({ name: 'nis-mcp', version: '1.0.0' })
    let transport: any
    if (config.url) {
      transport = new StreamableHTTPClientTransport(new URL(config.url))
    } else {
      transport = new StdioClientTransport({
        command: config.command!,
        args: config.args || [],
        env: { ...(process.env as Record<string, string>), ...(config.env || {}) },
        cwd: config.cwd,
      })
    }
    // 握手超时 30s（连接挂死不让工具无限等）
    // 0906 体检 P2#16：超时后关闭悬挂 client 与 timer（反复重连不再积累孤儿子进程）
    /* ★1003 并发批 4.13：原实现两个 30s 定时器赛跑 —— connectTimer 先注册先触发、把 connectSettled
     * 置 true，"超时拒绝"那个后触发直接 return ⇒ **超时根本不会拒**，client.connect() 悬着就永久
     * 挂死（卡 mcpHubInstall/开关/启动）；且失败路径两个 timer 都没人清（30s 后幽灵 close() +
     * 事件循环续命）。现在：一个定时器管拒绝、finally 必清；client 关闭交给 catch（见 4.14）。 */
    const CONNECT_TIMEOUT_MS = 30_000
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    const connectWithTimeout = Promise.race([
      client.connect(transport),
      new Promise((_, rej) => {
        connectTimer = setTimeout(() => rej(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`)), CONNECT_TIMEOUT_MS)
      }),
    ])
    try {
      await connectWithTimeout
    } finally {
      clearTimeout(connectTimer)
    }

    const list = await client.listTools()
    state.status = 'connected'
    state.connectedAt = Date.now()
    state.error = undefined
    state.tools = (list.tools || []).map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
    clients.set(clean, client)
    console.log(`[mcp] connected: ${clean} (${state.tools.length} tools)`)
    return { ok: true, tools: state.tools }
  } catch (e: any) {
    /* ★1003 并发批 4.14：失败路径原来**不关 client** —— 连接失败时 stdio 子进程可能已被 transport
     * 拉起，listTools 失败时更是已连接；每次失败重试漏一个子进程/HTTP 会话，越积越多。
     * 先关 client 再清状态（clients.delete 是兜底：此路径上 client 本来就没进过 map）。 */
    try { await client?.close() } catch { /* ignore */ }
    state.status = 'error'
    state.error = String(e?.message || e)
    state.tools = []
    clients.delete(clean)
    console.error(`[mcp] connect failed: ${clean}:`, state.error)
    return { ok: false, error: state.error }
  }
}

/** 断开连接（removeConfig=true 时同时删除配置目录） */
export async function mcpHubDisconnect(name: string, keepConfig = false): Promise<void> {
  const clean = sanitizeName(name)
  const client = clients.get(clean)
  if (client) {
    try { await client.close() } catch { /* ignore */ }
    clients.delete(clean)
  }
  const state = servers.get(clean)
  if (state) {
    state.status = 'disconnected'
    state.tools = []
  }
  if (!keepConfig) {
    const st = servers.get(clean)
    if (st) servers.delete(clean)
  }
}

/** 切换 server 启用/停用（0904 开关B）：落盘 server.json + 启用即连 / 停用断开并置灰 */
export async function mcpHubSetEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string; tools?: McpToolInfo[] }> {
  const clean = sanitizeName(name)
  // 内置虚拟 server：只改内存 + 持久化开关，绝不走 connect（无 command/url 会被拒）
  const vs = servers.get(clean)
  if (vs?.virtual) {
    vs.config = { ...vs.config, enabled }
    vs.enabled = enabled
    saveVirtualState(clean, { enabled })
    return { ok: true, tools: vs.tools }
  }
  let config: McpServerConfig | null = servers.get(clean)?.config ? { ...servers.get(clean)!.config, enabled } : null
  if (!config) {
    try { config = { ...JSON.parse(fs.readFileSync(configPath(clean), 'utf-8')) as McpServerConfig, enabled } } catch { return { ok: false, error: 'MCP 服务不存在' } }
  }
  try {
    fs.mkdirSync(path.dirname(configPath(clean)), { recursive: true })
    fs.writeFileSync(configPath(clean), JSON.stringify(config, null, 2) + '\n', 'utf-8')
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  if (enabled) return mcpHubConnect(clean, config)
  await mcpHubDisconnect(clean, true)
  servers.set(clean, { name: clean, config, status: 'disconnected', tools: [], enabled: false })
  return { ok: true, tools: [] }
}

/** 切换服务选择（0904 反馈④b）：落盘 selected + 同步内存。不选=不断进程不删配置，仅不注入工具（与开关B 区分）。 */
export function mcpHubSetSelected(name: string, selected: boolean): { ok: boolean; error?: string } {
  const clean = sanitizeName(name)
  const vs = servers.get(clean)
  if (vs?.virtual) {
    vs.config = { ...vs.config, selected }
    vs.selected = selected
    saveVirtualState(clean, { selected })
    return { ok: true }
  }
  let config: McpServerConfig | null = servers.get(clean)?.config ? { ...servers.get(clean)!.config, selected } : null
  if (!config) {
    try { config = { ...JSON.parse(fs.readFileSync(configPath(clean), 'utf-8')) as McpServerConfig, selected } } catch { return { ok: false, error: 'MCP 服务不存在' } }
  }
  try {
    fs.mkdirSync(path.dirname(configPath(clean)), { recursive: true })
    fs.writeFileSync(configPath(clean), JSON.stringify(config, null, 2) + '\n', 'utf-8')
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  const st = servers.get(clean)
  if (st) { st.config = config; st.selected = selected }
  return { ok: true }
}

/** 全选/取消全选（0904 反馈④b）：遍历全部已配置 server 批量写 selected */
export function mcpHubSetSelectedAll(selected: boolean): { ok: boolean; changed: number } {
  const names = new Set<string>(servers.keys())
  try {
    if (fs.existsSync(MCP_SERVERS_DIR)) {
      for (const d of fs.readdirSync(MCP_SERVERS_DIR, { withFileTypes: true })) if (d.isDirectory()) names.add(d.name)
    }
  } catch { /* 目录不可读时只处理内存态 */ }
  let changed = 0
  for (const name of names) { if (mcpHubSetSelected(name, selected).ok) changed++ }
  return { ok: true, changed }
}

/** 断开并删除配置目录（卸载） */
export async function mcpHubRemove(name: string): Promise<{ ok: boolean; error?: string }> {  const clean = sanitizeName(name)
  // 内置虚拟 server（如 nis-browser）不可卸载（无配置目录），只能停用
  if (servers.get(clean)?.virtual) return { ok: false, error: '内置服务不可卸载，如需关闭请在「工具」页停用' }
  await mcpHubDisconnect(clean, true)
  const dir = path.join(MCP_SERVERS_DIR, clean)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (e: any) {
    return { ok: false, error: `删除配置失败：${e?.message || e}` }
  }
  servers.delete(clean)
  console.log(`[mcp] removed: ${clean}`)
  return { ok: true }
}

/** 执行命令（clone/依赖安装用） */
function runProc(cmd: string, args: string[], cwd?: string, timeout = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    /* ★0930 修弹窗：git clone / npm install 裸奔会弹控制台窗（后端无控制台=必弹）。 */
    execFile(cmd, args, { cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 400)))
      else resolve(String(stdout))
    })
  })
}

/** 写配置 + 连接（安装）。
 *  repoUrl（可选）：本地包型 MCP 自动 clone 到 mcp-servers/<name>/repo 并安装依赖，
 *  config.cwd 缺省时指向该目录（相对路径命令如 node src/index.js 即可运行）。 */
export async function mcpHubInstall(name: string, config: McpServerConfig, repoUrl?: string): Promise<{ ok: boolean; error?: string; tools?: McpToolInfo[] }> {
  const clean = sanitizeName(name)
  if (!clean) return { ok: false, error: 'name 不合法' }
  // 内置虚拟 server：绝不建配置目录/装包（前端"重连"等误触时安全 no-op）
  if (servers.get(clean)?.virtual) return { ok: true, tools: servers.get(clean)!.tools }
  try {
    const serverDir = path.join(MCP_SERVERS_DIR, clean)
    fs.mkdirSync(serverDir, { recursive: true })
    // 本地包型：clone 仓库 + 安装依赖 + 默认 cwd
    if (repoUrl && !config.url) {
      const repoDir = path.join(serverDir, 'repo')
      if (!fs.existsSync(path.join(repoDir, '.git'))) {
        console.log(`[mcp] cloning ${repoUrl} -> ${repoDir}`)
        await runProc(gitExe(), ['clone', '--depth', '1', repoUrl, repoDir])
      }
      const pkg = path.join(repoDir, 'package.json')
      if (fs.existsSync(pkg)) {
        console.log(`[mcp] npm install: ${clean}`)
        try {
          /* ★0930c：npm 走绝对解析（gitExe.ts）——裸名 npm 后端 PATH 里没有（cmd /c npm 同样找不到），
             且 Windows execFile 裸跑 npm.cmd 会 EINVAL。npmCmd()=自带 node + npm-cli.js，零 PATH 依赖。 */
          const nm = npmCmd()
          if (!nm) console.warn('[mcp] 未找到 npm（设置→软件环境可一键安装），跳过依赖安装')
          else await runProc(nm.bin, [...nm.args, 'install', '--no-audit', '--no-fund'], repoDir, 300000)
        } catch (e: any) {
          console.warn(`[mcp] npm install warn: ${clean}:`, String(e?.message || e).slice(0, 200))
        }
      }
      if (!config.cwd) config.cwd = repoDir
    }
    fs.writeFileSync(configPath(clean), JSON.stringify(config, null, 2) + '\n', 'utf-8')
  } catch (e: any) {
    return { ok: false, error: `写配置失败：${e?.message || e}` }
  }
  return mcpHubConnect(clean, config)
}

/** 全部已连接 server 的工具 → pi AgentTool（mcp__<server>__<tool>） */
/** 收集 MCP 工具注入 agent。sessionId 可选：虚拟 server（内置浏览器等）分发时透传，
 *  让后端动作（如 AI 打开网页）能带上"发起会话"身份，前端据此做视图联动过滤。 */
export function getMcpAgentTools(sessionId?: string): AgentTool<any>[] {
  const out: AgentTool<any>[] = []
  for (const [serverName, st] of servers) {
    if (st.status !== 'connected') continue
    if (st.config?.enabled === false) continue   // 开关B：停用的一律不注入
    if (st.config?.selected === false) continue  // ④b 服务选择：未选用的一律不注入
    const client = clients.get(serverName)
    const vcall = virtualCalls.get(serverName)
    if (!client && !vcall) continue   // 真 MCP 要有 client；虚拟 MCP 要有分发器
    for (const t of st.tools) {
      const toolName = `mcp__${serverName}__${t.name}`
      out.push({
        name: toolName,
        label: `${serverName}/${t.name}`,
        description: t.description || `MCP 工具 ${t.name}（来自 ${serverName}）`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
        execute: async (_callId: string, args: any) => {
          try {
            if (vcall) {
              // 内置虚拟 server：直接调本地引擎分发器（如 browserEngine）
              const r = await vcall(t.name, args || {}, sessionId)
              return {
                content: [{ type: 'text', text: r.text || '（无返回）' }],
                // 0908 截图内嵌对话流：透传分发器自定义 details（wb_send_screenshot 的 dataUrl）。
                // 键序：先展开自定义字段，再写 ok/server/tool 权威字段，防工具侧伪造成功态/来源。
                details: {
                  ...(r.details && typeof r.details === 'object' ? r.details : {}),
                  ok: !r.isError,
                  server: serverName,
                  tool: t.name,
                },
              }
            }
            /* ★1003 并发批 4.15：client 原来在注入时刻被闭包**攥死** —— mcpHubConnect 重连会换掉
             * map 里的 client、mcpHubDisconnect 会关掉旧的 ⇒ 已注入的工具永远调用一个已关的死
             * client，全部哑火直到重新注入。改为调用时现查活的；拿不到如实报错（不再用 ! 掩盖断连）。 */
            const live = clients.get(serverName)
            if (!live) throw new Error('MCP 未连接（连接已断开或正在重连，请重试）')
            const result = await live.callTool({ name: t.name, arguments: args || {} })
            const text = Array.isArray(result?.content)
              ? result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
              : JSON.stringify(result ?? '')
            return {
              content: [{ type: 'text', text: text || '（无返回）' }],
              details: { ok: !result?.isError, server: serverName, tool: t.name },
            }
          } catch (e: any) {
            throw new Error(`MCP 工具调用失败（${serverName}/${t.name}）：${e?.message || e}`)
          }
        },
      })
    }
  }
  return out
}

/** RPC 状态视图 */
export function getMcpStatus(): McpServerState[] {
  return Array.from(servers.values()).map(s => ({ ...s }))
}

/** 启动初始化：扫描配置目录，逐个后台连接（失败不影响主服务） */
export async function mcpHubInit(): Promise<void> {
  try {
    if (!fs.existsSync(MCP_SERVERS_DIR)) return
    const names = fs.readdirSync(MCP_SERVERS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    for (const name of names) {
      try {
        const cfgPath = configPath(name)
        if (!fs.existsSync(cfgPath)) continue
        const config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as McpServerConfig
        void mcpHubConnect(name, config).then(r => {
          if (!r.ok) console.warn(`[mcp] init connect failed: ${name}: ${r.error}`)
        })
      } catch (e) {
        console.warn(`[mcp] init skip ${name}:`, e)
      }
    }
  } catch (e) {
    console.error('[mcp] init failed:', e)
  }
}
