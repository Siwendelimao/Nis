/**
 * pi-bridge: DSH frontend <-> Pi Agent <-> LongCat LLM
 *
 * Implements minimal DSH API protocol (HTTP RPC + SSE event streams)
 * backed by Pi Agent and LongCat OpenAI-compatible API.
 */

import './winNoPopup.ts' // ★0930 弹窗兜底：child_process 强制 windowsHide（必须最先加载，见该文件头注释）
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn, spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentEvent, BeforeToolCallContext, AgentTool } from '@earendil-works/pi-agent-core'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { Model as PiModel } from '@earendil-works/pi-ai'
import { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions'
// 0910 协议扩展：原生 Anthropic / Google 协议适配器（供应商协议=anthropic-messages/google-generative-ai 时路由到这里）
import { stream as anthropicMessagesStream } from '@earendil-works/pi-ai/api/anthropic-messages'
import { stream as googleGeminiStream } from '@earendil-works/pi-ai/api/google-generative-ai'
/* ★1011 pi 1.1.0 兼容层：收工钩子改名（shouldStopAfterTurn→finishTurn）+ 流函数入参收紧（Context→TranscriptContext） */
import { toFinishTurn, toTranscriptCtx } from './piCompat.ts'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { buildSessionTools, setSnapshotTurn, buildProjectNoteTool, buildLoadToolsTool, buildListDirTool, buildHistoryTools, buildScheduleTools, buildGitTools, buildRepoTools, resetBashPath } from './tools.ts'
/* ★1010：项目档案「档案卡」（体量 + 各节行范围 + 最近进度/决策）——新窗口开箱即知，别再整份读档案 */
import { buildNoteDigest } from './noteDigest.ts'
/* ★1012i：工具输出 spill（全文落盘 + 确切取回路径）—— 共享模块，与 tools.ts 同一份实现 */
import { omitNotice } from './spillStore.ts'
import { LAZY_FAMILIES, familyIndexLine, splitToolsForRequest } from './lazyTools.ts'
import { listChanges, readObject, checkConflict, restoreChange, putObject, saveChanges, listOrphanWorkdirs, removeWorkdir, diffStatByHash, resolveChangePath, changeStatus, turnSummaries, enforceBudget, setHistoryQuota, historyStats, autoCleanHistory, type HistoryChange } from './fileHistory.ts'
import { memoryBridge, buildMemoryTools, resetMemoryPython, BRIDGE_SCRIPT, USING_BUNDLED_KERNEL, currentMemoryDir, defaultMemoryDir, setDistillLlm } from './memoryBridge.ts'
import { buildNotebookTools } from './notebookTools.ts'
import { notebookList, notebookAdd, notebookUpdate, notebookRemove, notebookCounts, notebookImageAdd, resolveNotebookAsset, NOTEBOOK_ASSET_URL_PREFIX } from './notebookStore.ts'
import { SessionAssetStore, stripSessionAssets, restoreSessionAssets, ASSET_DIR_NAME, ASSET_URL_PREFIX } from './sessionAssets.ts'
import { buildWebTools, getWebSearchConfig, setWebSearchConfig, sealPortableSearchKeys, unsealPortableSearchKeys, reloadWebSearchConfig, type SearchProviderId } from './webTools.ts'
import { getSkills, getSkillsSync, formatSkillList, invalidateSkillCache, skillsSnapshotSync } from './skillTools.ts'
import { buildInstallTools, readInstallLog, appendInstallLog, SKILLS_DIR, MCP_DIR } from './installTools.ts'
import { initAgentPresets, listAgentPresets, readAgentPreset, writeAgentPreset, deleteAgentPreset, INSTALL_SYSTEM_PROMPT, PRESETS_DIR } from './agentPresetsStore.ts'
import { buildPresetAdminTools } from './presetAdminTools.ts'
import { runCodexTurn } from './externalAgents/codexAdapter.ts'   // ★1001 外部预设：codex 引擎子进程
import { runAcpTurn, type PartEvent } from './externalAgents/acpRuntime.ts'   // ★1010 P0：外部流 ACP 运行时（ext-stream/PartEvent 契约）
import { listExternalAgents, startInstall, uninstallExternalAgent, startLogin, setExternalKey, getExternalKey, listModels, fetchQuota } from './externalAgents/installer.ts'   // ★1001 外部 agent 可拆装安装器
import { buildToolRegistry, type ToolRegistryEntry } from './toolCatalog.ts'
import { computeBreakdownPure, estimateRequestTokens, estimateMsgTokens, ctxMsgChars } from './ctxEstimate.ts'
import { BACKEND_ROOT, DATA_ROOT } from './paths.ts'
import { PROJECT_ROOT, SKILLS_ROOT } from './paths.ts'
import { mcpHubInit, mcpHubInstall, mcpHubRemove, mcpHubDisconnect, getMcpAgentTools, getMcpStatus, mcpHubSetEnabled, mcpHubSetSelected, mcpHubSetSelectedAll, registerVirtualServer } from './mcpRuntime.ts'
import * as browserEngine from './browserEngine.ts'
import type { McpToolInfo } from './mcpRuntime.ts'

/** 内置虚拟 MCP server 注册（0904 浏览器）：工具命名抄 webbridge 的 wb_* 语义。
 *  execute 直接调 browserEngine 内存函数 → 自动受 预设总开关 / 开关B(enabled) / 仓库 / list_tools 全链路管辖。 */
const BROWSER_TOOLS: McpToolInfo[] = [
  { name: 'wb_status', description: '查看内置浏览器运行状态（是否启动/当前标签页/视口模式）', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_navigate', description: '打开【网络网址】(http/https，自动补 https://)到内置浏览器。落点：默认新开标签；若存在仍停留在默认首页的空闲标签则复用它。用户在用的标签永远不会被顶掉或关闭。硬性限制：本地工作区文件（file:// 或本地路径）会被系统拒绝——要给用户看本地文件请用 wb_preview_file（预览）或 wb_send_screenshot path=（截图发对话流）。页面内跳转（点链接/表单/翻页）用 wb_click 而非重复 navigate；遇到验证码/扫码等真人环节不要重试绕过，直接告知用户在「浏览器」视图接管完成', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要访问的网络网址' } }, required: ['url'] } },
  { name: 'wb_snapshot', description: '抓取当前页面可读文本快照（title/url/正文+可交互元素清单），AI 据此判断下一步。行为准则：发现当前页不是目标内容（错误页/无关导航页）时，重新 wb_navigate 直达正确网址；清单里的引号文字可直接作为 wb_click 的 text= 参数；遇到扫码/验证码/人工审核环节直接告知用户接管完成，你 wb_wait 等待', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } } },
  { name: 'wb_screenshot', description: '当前页面截图，返回 base64 图（图只有你自己能看，用于判断页面状态；要给【用户】看请改用 wb_send_screenshot）。失败最多重试一次，仍失败就放弃并告知用户', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'jpeg'] } } } },
  { name: 'wb_click', description: '点击元素。优先 text=页面上可见文字（如"发送""登录"，来自 wb_snapshot 清单）；拿不到文字再用 CSS selector=。找不到元素先 wb_snapshot 看页面实况，盲重试无效', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '按可见文字点击（优先）' }, selector: { type: 'string', description: 'CSS 选择器（备选）' } } } },
  { name: 'wb_fill', description: '向输入框填入文本（先清空后输入）。优先 placeholder= 输入框占位文字定位；否则 CSS selector=。填不进先 wb_snapshot 看页面实况（自定义控件可能需 wb_click 聚焦后再填），盲重试无效', inputSchema: { type: 'object', properties: { placeholder: { type: 'string', description: '按占位文字定位（优先）' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['value'] } },
  { name: 'wb_press_key', description: '按键（Enter / Tab / Escape / 组合键等）', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'wb_scroll', description: '滚动页面', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' } } } },
  { name: 'wb_wait', description: '等待页面就绪（等网络空闲，上限 ms 毫秒）或等待某选择器出现；返回当前页面标题/URL 供你判断页面是否已变化。优先用这个代替盲目等待+反复 snapshot', inputSchema: { type: 'object', properties: { ms: { type: 'number' }, selector: { type: 'string' }, timeoutMs: { type: 'number' } } } },
  { name: 'wb_hover', description: '悬停到元素（展开下拉菜单/悬浮层）：text=可见文字优先，其次 selector=，或 x/y 坐标', inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'wb_get_text', description: '定点取某元素的文本（比整页快照轻量，上下文友好）：text=可见文字或 selector= 定位，最多返回 2000 字', inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' } } } },
  { name: 'wb_fill_form', description: '表单批量填写：fields 数组 [{placeholder 或 selector, value}] 一次填完整个表单（避免逐字段多轮调用）', inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: { placeholder: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } } } } }, required: ['fields'] } },
  { name: 'wb_console', description: '读取页面最近 console/pageerror 输出（count 条，默认 30）——页面行为异常时排查报错用', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
  { name: 'wb_evaluate', description: '在页面执行 JS 表达式并返回结果（谨慎）', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'wb_set_viewport', description: '切换视口预设：pc / iphone15 / ipad / pixel7（模拟移动端/桌面）', inputSchema: { type: 'object', properties: { viewport: { type: 'string' } }, required: ['viewport'] } },
  { name: 'wb_list_tabs', description: '列出所有标签页（含 tabId/url）。要继续操作之前打开过的页面时，先列 tab 找到对应 tabId，后续工具带 tabId= 参数操作那一页，不要重新 wb_navigate', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_close_tab', description: '关闭某标签页。仅限关闭你自己为本次任务打开的、且任务已完成的标签；用户的默认首页标签和最后一个标签会被系统强制拒绝；没让你清理就不要主动关任何标签', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] } },
  { name: 'wb_preview_file', description: '在预览面板打开本地工作区文件（HTML/图片等）展示给用户——后台打开不打断用户当前视图（tab 栏有提示点），用户随时自己点开看。仅当用户明确要求查看/预览某文件时才调用；写完文件后不要主动开预览、也不要为展示产物调用它——直接回复文件路径即可。硬性限制：外部网址(http/https)会被系统拒绝——真实网络页面用 wb_navigate；想把网页/文件效果【发到对话流里】用 wb_send_screenshot', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '工作区内相对路径或绝对路径' } }, required: ['path'] } },
  { name: 'wb_send_screenshot', description: '把画面直接发送到对话流里给用户看（零成本，图不回传你、勿复述内容）。四种用法：不带参数=截【用户当前正在看的页面】；url= 一步导航到该网址并等页面就绪后截（最新效果，可再带 delay_ms 等动画渲染）；tabId= 截【指定已开标签页】；path= 发【本地工作区文件】（图片直发，HTML/md 自动渲染成截图）。要截桌面上非浏览器的内容用 wb_screen_capture。回执会报告实际截图来源 URL——发现截错对象就换参数重截一次，不要盲重试', inputSchema: { type: 'object', properties: { format: { type: 'string', description: 'png 或 jpeg，默认 png' }, url: { type: 'string', description: '要导航后截图的网址（可选）' }, tabId: { type: 'string', description: '要截的标签页 id（来自 wb_list_tabs，可选）' }, path: { type: 'string', description: '本地工作区图片/文本文件路径（可选）' }, delay_ms: { type: 'number', description: '截图前额外等待毫秒数（动画/异步渲染，上限 15000，可选）' } } } },
  { name: 'wb_screen_capture', description: '截取用户【整块桌面屏幕】发到对话流（能看到任何应用窗口：外部浏览器/预览面板/桌面程序）。内置浏览器页截图/本地文件请用 wb_send_screenshot，别用本工具。想给用户看某个具体应用：先让用户把该应用切到前台（或提示用户接管），再带 delay_ms 300-1500 调用本工具。每次都会弹审批卡由用户批准；图不回传你本人（零 vision 成本），用户视角展示用', inputSchema: { type: 'object', properties: { delay_ms: { type: 'number', description: '截图前等待毫秒数（等窗口切前台/动画渲染，可选）' } } } },
]

/** 0905：AI 在浏览器里的"专属标签"（按会话隔离）——后续点击/填表/截图都作用在它上面，
 *  用户切换/操作其它标签（activeTab）不会干扰 AI，AI 也不会抢用户的画面 */
const aiPreferredTabBySession = new Map<string, string>()

/** 0908 三批（用户实测：模型打开B站后连发多张截图=白烧轮次+transcript 塞多份 base64）：
 *  send_screenshot 同页去重——距上次发图 <45s 且页面自那以后【无任何交互动作】且目标 URL 相同
 *  → 不再截图不再发图，回"已发送过"提示。合法场景（点完再看效果/导航到新页再截）不受影响。 */
const shotDedupBySession = new Map<string, { url: string; at: number }>()
const lastActionAtBySession = new Map<string, number>()
function markPageAction(sessionKey: string): void { lastActionAtBySession.set(sessionKey, Date.now()) }
/** 同页去重窗口：45s。判据是"同 URL + 期间无任何页面交互动作"——换页/点击/导航都会 markPageAction 放行，
 *  换 URL 也放行，所以这个时间窗只是"同页静止时"的连拍保险，放宽不会误伤合法的"点完再看新效果"。 */
function duplicateShotHit(sessionKey: string, url: string): boolean {
  const prev = shotDedupBySession.get(sessionKey)
  const acted = lastActionAtBySession.get(sessionKey) || 0
  if (prev && Date.now() - prev.at < 45000 && acted < prev.at && normShotUrl(prev.url) === normShotUrl(url)) return true
  return false
}
function normShotUrl(u: string): string {
  try { return u.replace(/\/+$/, '').toLowerCase() } catch { return u }
}

/** 0905 T2：AI 主动打开内容 → 通知前端自动切到浏览器视图 + 弹对话悬浮窗（带发起会话，前端过滤） */
function broadcastBrowserAct(sessionId?: string): void {
  try { broadcastMux('', { type: 'browser/act', kind: 'open', sessionId: sessionId || '' }) } catch { /* ignore */ }
}

/** 0905 T3：页面滚动指标广播（悬浮滚动进度条用）；300ms 节流防 wheel 连发 */
let lastScrollProbeAt = 0
let scrollProbeTimer: ReturnType<typeof setTimeout> | null = null
function broadcastScrollMetrics(sessionId: string, immediate = false): void {
  const run = async () => {
    lastScrollProbeAt = Date.now()
    try {
      const inst = browserEngine.getBrowserInstance(sessionId)
      const p = inst.tryGetTab() as any
      if (!p) return
      const m = await p.evaluate('(() => { const d = document.scrollingElement || document.documentElement; return { y: Math.round(d.scrollTop), h: Math.round(d.scrollHeight), vh: Math.round(d.clientHeight) } })()')
      if (m && typeof m.h === 'number') broadcastMux('', { type: 'browser/scroll', sessionId, y: m.y || 0, h: m.h || 0, vh: m.vh || 0 })
    } catch { /* ignore */ }
  }
  if (immediate) { void run(); return }
  if (Date.now() - lastScrollProbeAt < 300) {
    if (scrollProbeTimer) clearTimeout(scrollProbeTimer)
    scrollProbeTimer = setTimeout(run, 320)
    return
  }
  void run()
}

/** 0905 T4：AI 交互类工具集合——执行前查占用权，用户接管期间拒绝（只读工具不受限） */
const BROWSER_INTERACTIVE_TOOLS = new Set(['wb_navigate', 'wb_click', 'wb_fill', 'wb_press_key', 'wb_scroll', 'wb_evaluate', 'wb_set_viewport', 'wb_close_tab', 'wb_hover', 'wb_fill_form'])
/** 0908 发现4：需要页面上下文的工具全集（含只读页工具）——未就绪时自动拉起；status/list_tabs/preview_file 不依赖实例 */
const BROWSER_PAGE_TOOLS = new Set([...BROWSER_INTERACTIVE_TOOLS, 'wb_snapshot', 'wb_get_text', 'wb_screenshot', 'wb_send_screenshot', 'wb_wait', 'wb_console'])

/** 0905 九批：wb_navigate 落点——①与某现有标签 URL 完全相同→复用（等价刷新，防 SPA 操作失败后反复重开同一站）；
 *  ②仍停留在默认首页的空闲标签→拿来用；③否则新开。用户在用的标签永不被占用。 */
async function resolveAiNavigateTarget(inst: browserEngine.BrowserInstance, rawUrl: string): Promise<{ tabId?: string; how: string }> {
  const u = rawUrl.trim().replace(/\/+$/, '')
  const tabs = inst.listTabs()
  const norm = (x: string) => x.replace(/\/+$/, '')
  const same = tabs.find(t => t.url && norm(t.url) === u)
  if (same) return { tabId: same.id, how: '已有同址标签' }
  const home = inst.getHomeUrl()
  const idleHome = tabs.find(t => !t.url || t.url === 'about:blank' || (!!home && t.url === home))
  if (idleHome) return { tabId: idleHome.id, how: '默认首页标签' }
  const nt = await inst.newTab(rawUrl)
  return { tabId: nt.id, how: '新标签' }
}

/** 0908 C₁：Windows 全屏截图（PowerShell + System.Drawing，零新依赖）。
 *  VirtualScreen = 多显示器整体虚拟桌面；临时 PNG 读完即删。
 *  隐私边界由 assessRisk（wb_screen_capture=high 必弹卡）把守；图走 details 通道给用户看、不回灌模型。 */
function captureDesktopScreen(): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const tmpRoot = process.env.TEMP || process.env.TMP || 'C:/Windows/Temp'
    const out = path.join(tmpRoot, `nis-screen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
    const ps = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;',
      '$out=$env:NIS_SHOT_OUT;',
      '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
      '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);',
      '$g=[System.Drawing.Graphics]::FromImage($bmp);',
      '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);',
      '$bmp.Save($out);',
      '$g.Dispose();$bmp.Dispose()',
    ]
    /* ★1003 安全批 4.58：路径原来单引号拼进 -Command —— TEMP 路径出现单引号即可逃逸成命令注入。
     * 按项目纪律改走环境变量（同 spawnShellDelete 口径），命令字符串零路径字面量。 */
    execFile('powershell.exe', ps, { windowsHide: true, timeout: 10000, env: { ...process.env, NIS_SHOT_OUT: out } }, (err) => {
      if (err) return reject(new Error(`截屏失败：${String(err.message || err).split('\n')[0]}`))
      try {
        const buf = fs.readFileSync(out)
        try { fs.unlinkSync(out) } catch { /* ignore */ }
        resolve({ data: buf.toString('base64'), mime: 'image/png' })
      } catch (e: any) {
        try { fs.unlinkSync(out) } catch { /* ignore */ }
        reject(e)
      }
    })
  })
}

/** 页面内可交互元素清单（snapshot 附带，AI 定位用，减少试错轮数） */
const INTERACTIVE_SNIPPET = `(() => {
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('a,button,input,textarea,select,[role=button],[onclick],summary,[contenteditable]')) {
    if (out.length >= 40) { out.push('…更多元素用 wb_evaluate 查询'); break }
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    const tag = el.tagName.toLowerCase()
    const text = String(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    const sel = el.id ? '#' + el.id : ''
    const key = tag + '|' + sel + '|' + text
    if (seen.has(key)) continue
    seen.add(key)
    out.push('- [' + tag + ']' + (sel ? ' ' + sel : '') + (text ? ' "' + text + '"' : ''))
  }
  return out.join('\\n')
})()`

/** 0906 画布一批：读工作区文件为预览准备内容（wb_preview_file 与 fs.readForPreview 共用） */
const IMAGE_EXTS_PV = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']
const TEXT_EXTS_PV = ['.html', '.htm', '.txt', '.md', '.json', '.css', '.js', '.mjs', '.xml', '.csv']
function readForPreview(sessionId: string, rawPath: string): { name: string; kind: 'html' | 'image' | 'file'; content?: string; dataUrl?: string } {
  const sess = sessions.get(sessionId)
  const abs = resolveWorkdirPath({ workDir: sess?.workDir }, rawPath)
  const ext = path.extname(abs).toLowerCase()
  if (IMAGE_EXTS_PV.includes(ext)) {
    const b64 = fs.readFileSync(abs).toString('base64')
    return { name: path.basename(abs), kind: 'image', dataUrl: `data:image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)};base64,${b64}` }
  }
  if (TEXT_EXTS_PV.includes(ext)) {
    if (fs.statSync(abs).size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，预览不支持')
    return { name: path.basename(abs), kind: ext === '.html' || ext === '.htm' ? 'html' : 'file', content: fs.readFileSync(abs, 'utf-8') }
  }
  throw new Error(`该类型（${ext || '无扩展名'}）暂不支持预览`)
}

/**
 * 0912 二十一批：**本轮产生的截图**（通道会话专用）—— agent_end 时自动补发到 IM。
 *
 * 用户实测痛点：「让 AI 截图，PC 对话流里有图，但 QQ/微信收不到」。
 * 根因：wb_send_screenshot 只把图塞进 PC 对话流（details.shotRef），IM 完全不知道；
 * AI 以为"已发送到对话流"=对方看到了，于是不会写 MEDIA: 行。
 *
 * 做法：截图落盘时（persistShot）若本会话有通道来源（origin）→ 记进本轮清单；
 * agent_end 回推时，除正文与 MEDIA: 媒体外，再把这批图**自动补发**到该 IM 对端
 * （与 MEDIA: 已发过的同路径去重）。
 */
const turnShotMedia = new Map<string, string[]>()
function noteTurnShot(sessionId: string | undefined, absPath: string): void {
  if (!sessionId) return
  const s = sessions.get(sessionId)
  if (!s?.origin) return   // 非通道会话：不自动外发（PC 场景对话流里看到就够了）
  const list = turnShotMedia.get(sessionId) || []
  if (!list.includes(absPath) && list.length < 6) list.push(absPath)   // 同文件当轮一次；上限 6 张防刷屏
  turnShotMedia.set(sessionId, list)
}
/** 取走本轮的截图清单（agent_end 消费；无论成不成都清空，避免串到下一轮） */
function consumeTurnShots(sessionId: string): string[] {
  const list = turnShotMedia.get(sessionId) || []
  if (list.length) turnShotMedia.delete(sessionId)
  return list
}

/** 0908 三批：截图落盘——把 base64 写入【工作区 screenshots/】目录，details 只存相对路径 shotRef
 *  （前端经 /api/workspace-file 渲染 live+刷新都能出图）。transcript/sessions.json 不再塞 base64。
 *  无工作区或写盘失败 → 回退内联 dataUrl，绝不让图丢失。 */
function persistShot(sessionId: string | undefined, base64: string, mime: string): Record<string, any> {
  const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg'
  const wd = sessionId ? sessions.get(sessionId)?.workDir?.trim() : ''
  if (!wd) return { dataUrl: `data:${mime};base64,${base64}` }
  try {
    const fname = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`
    const dirAbs = path.join(wd, 'screenshots')
    fs.mkdirSync(dirAbs, { recursive: true })
    const full = path.join(dirAbs, fname)
    fs.writeFileSync(full, Buffer.from(base64, 'base64'))
    // 二十一批：通道会话 → 记进本轮清单，agent_end 自动补发到 IM（"图一定要到手机上"）
    noteTurnShot(sessionId, full)
    return { shotRef: `screenshots/${fname}`, mime }
  } catch {
    return { dataUrl: `data:${mime};base64,${base64}` }
  }
}
/** 从 dataUrl 拆出 base64+mime，统一走 persistShot（path=图片直发分支用，源文件已在磁盘但仍归拢进 screenshots/） */
function persistShotFromDataUrl(sessionId: string | undefined, dataUrl: string): Record<string, any> {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!m) return { dataUrl }
  return persistShot(sessionId, m[2], m[1])
}

/** ★1011t（已定案 B 方案）：把用户附件落进【工作区 uploads/】，消息里**只带相对路径**
 *  （`uploads/<文件名>`）—— 这样：消息体很轻（几十字节而不是几 MB）、气泡里显示文件名，
 *  而且 **AI 能用现成工具直接读到这个文件**（这才是"附件"真正的价值）。
 *  与 persistShot 同一套模式与取舍：
 *   · 文件名安全化（去掉路径分隔符/控制字符），重名自动加序号（**绝不覆盖**用户已有文件）；
 *   · 无工作区 / 写盘失败 → **明确返回错误**，绝不静默丢（"发出去的东西凭空消失"最难排查）。 */
function persistUpload(sessionId: string, name: string, base64: string): { relPath?: string; bytes?: number; error?: string } {
  const wd = sessions.get(sessionId)?.workDir?.trim()
  if (!wd) return { error: '该会话还没有工作区（先随便发一条消息，会话落地后附件就能存了）' }
  const base = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file'
  try {
    const dirAbs = path.join(wd, 'uploads')
    fs.mkdirSync(dirAbs, { recursive: true })
    let fname = base
    let n = 1
    while (fs.existsSync(path.join(dirAbs, fname))) {
      const dot = base.lastIndexOf('.')
      fname = dot > 0 ? `${base.slice(0, dot)}-${++n}${base.slice(dot)}` : `${base}-${++n}`
    }
    const buf = Buffer.from(base64, 'base64')
    fs.writeFileSync(path.join(dirAbs, fname), buf)
    return { relPath: `uploads/${fname}`, bytes: buf.length }
  } catch (e: any) {
    return { error: '写盘失败：' + String(e?.message || e) }
  }
}

/** 0905 十一批：浏览器工具 per-session 串行队列——AI（和某些模型）会把多个 wb_* 并行发
 *  （实测日志：两条 wb_navigate 同毫秒并发赛跑、press_key 和 wait 并发时序错乱），串行化保序。 */
/** 0908 截图内嵌对话流：details=结构化附加数据（wb_send_screenshot 的 dataUrl），经 mcpRuntime vcall 透传给前端渲染 */
type BrowserToolResult = { text: string; isError?: boolean; details?: Record<string, any> }
const browserToolQueues = new Map<string, Promise<BrowserToolResult>>()
async function callBrowserTool(tool: string, args: Record<string, any>, sessionId?: string): Promise<BrowserToolResult> {
  const key = String(sessionId || 'default')
  const prev = browserToolQueues.get(key) || Promise.resolve()
  const job = prev.catch(() => { /* 前一个失败不影响排队 */ }).then(() => callBrowserToolInner(tool, args, sessionId))
  browserToolQueues.set(key, job)
  try { return await job } finally { if (browserToolQueues.get(key) === job) browserToolQueues.delete(key) }
}

async function callBrowserToolInner(tool: string, args: Record<string, any>, sessionId?: string): Promise<BrowserToolResult> {
  // 0905 七批：浏览器按会话隔离——AI 用发起会话自己的实例；专属标签也按会话记
  const inst = browserEngine.getBrowserInstance(sessionId)
  const sessionKey = String(sessionId || 'default')
  // AI 专属标签优先（用户切 tab 不影响 AI），显式 args.tabId 仍最高
  const tabId = args.tabId ? String(args.tabId) : (aiPreferredTabBySession.get(sessionKey) || undefined)
  // 0908 发现4：需要页面的工具遇到实例未就绪（idle 回收/切换空窗）→ 自动拉起一次再执行，
  // 把模型"未就绪→连环试探 5-10 次"压成一次透明恢复；起不来才回【不要重试】失败。
  // 0908 二批条4：send_screenshot 带 path 的图片直发模式不经浏览器，不触发拉起（HTML 渲染分支仍会用到 inst，
  // 但失败会走 case 内 try/catch 明确报错，不拦这里）
  if (BROWSER_PAGE_TOOLS.has(tool) && !(tool === 'wb_send_screenshot' && String(args.path || '').trim()) && !inst.isRunning()) {
    try { await inst.start() } catch { /* 统一走下面的失败文案 */ }
    if (!inst.isRunning()) {
      return { text: '【不要重试】内置浏览器启动失败（可能运行环境缺失或系统限制）。请停止调用一切 wb_* 浏览器工具，直接告知用户"内置浏览器当前不可用"，或改用其他方式（如 fs_write 产物 + wb_preview_file 预览）。', isError: true }
    }
  }
  // T4 双向互斥：用户正在接管（手动操作中）→ AI 交互类工具直接拒，文案带明确行为指令（防模型自顾自重试）
  if (BROWSER_INTERACTIVE_TOOLS.has(tool) && inst.controlledBy === 'user') {
    return { text: '【不要重试】用户正在接管浏览器手动操作。请立即停止所有浏览器工具调用，直接回复用户一句话告知：「您正在手动接管浏览器，我已暂停自动化；完成后跟我说"继续"即可」。不要尝试任何其他浏览器操作，等用户明确说继续后再继续原任务。', isError: true }
  }
  const holdsControl = BROWSER_INTERACTIVE_TOOLS.has(tool)
  if (holdsControl) {
    // 0908 三批：交互动作=页面可能变化，为 send_screenshot 同页去重记录时间戳
    markPageAction(sessionKey)
    // 0905 十批：AI 一碰浏览器（任何交互工具）就通知前端弹悬浮窗——用户要"开始操作就看到"，不等第一次导航
    broadcastBrowserAct(sessionId)
    inst.controlledBy = 'ai'
    try { broadcastMux('', { type: 'browser/control', sessionId: sessionKey, by: 'ai' }) } catch { /* ignore */ }
  }
  try {
    switch (tool) {
      case 'wb_status': return { text: JSON.stringify(inst.currentStatus()) }
      case 'wb_navigate': {
        // 0905：智能落点（首页空闲标签复用→新开）；广播提前到导航开始（前端 dock 先弹，页面随后到）
        const rawUrl0 = String(args.url || '').trim()
        // 0908 A 闸门：本地文件硬禁走浏览器（此前只有描述提示，模型偶发仍丢 file:///本地路径过来=串台进浏览器）
        if (/^file:\/\//i.test(rawUrl0) || /^[a-z]:[\\/]/i.test(rawUrl0) || (/^\.{1,2}[\\/]/.test(rawUrl0) && !rawUrl0.startsWith('http'))) {
          return { text: '【行为指令】本地工作区文件禁止用 wb_navigate 打开。要给用户看效果请改用：wb_preview_file（工作区预览面板，不打断用户当前视图）或 wb_send_screenshot（把文件渲染成截图直接发进对话流）。给用户看的页面永远走预览通道，浏览器只用于真实网络网址。', isError: true }
        }
        broadcastBrowserAct(sessionId)
        const t = await resolveAiNavigateTarget(inst, String(args.url || ''))
        const r = await inst.navigate(String(args.url || ''), t.tabId)
        aiPreferredTabBySession.set(sessionKey, t.tabId || '')
        return { text: `已在${t.how}打开 ${r.url}（tabId ${t.tabId || '新'}），后续点击/填表自动作用于此标签` }
      }
      case 'wb_snapshot': {
        const r = await inst.snapshot(tabId)
        let items = ''
        try { const p = inst.tryGetTab(); if (p) items = await (p as any).evaluate(INTERACTIVE_SNIPPET) } catch { /* ignore */ }
        return { text: `# ${r.title}\nURL: ${r.url}\n\n${r.text}${items ? `\n\n## 可交互元素（点击/填写优先用 text=/placeholder= 按文字定位）\n${items}` : ''}` }
      }
      case 'wb_screenshot': { const r = await inst.screenshot(tabId, (args.format === 'png' ? 'png' : 'jpeg')); broadcastBrowserAct(sessionId); return { text: `data:${r.mime};base64,${r.data}` } }
      case 'wb_send_screenshot': {
        // 0908 改版：截图【内嵌进对话流】（前端在工具卡片下方直接渲染图），不再弹预览面板拉走用户。
        // 0908 三批 B+D：精准+最新——
        //   默认目标从"AI 专属页"改为【用户当前激活页】（修"截错 tab"根因：模型没传 tabId 时会截到用户正在看的那页）；
        //   url= 直接导航到目标再截（一步到位，省一轮 navigate）；delay_ms= 等渲染完成（动画/异步内容）；
        //   回执带【实际截图的页面 URL】——可核对是否截准、截新。path= 本地文件逻辑保留（二批条4）。
        const fmt = (args.format === 'jpeg' ? 'jpeg' : 'png') as 'png' | 'jpeg'
        const delayMs = Math.min(Number(args.delay_ms) || 0, 15000)
        const rawPath = String(args.path || '').trim()
        const rawUrl = String(args.url || '').trim()
        // ① 本地文件（二批条4）
        if (rawPath) {
          let pv: ReturnType<typeof readForPreview> | null = null
          try { pv = readForPreview(String(sessionId || ''), rawPath) } catch { pv = null }
          if (!pv) return { text: `无法读取「${rawPath}」（不存在或不在工作区内）。发本地文件请传工作区内相对/绝对路径；截网页请带 url= 或不带参数截当前页`, isError: true }
          if (pv.kind === 'image' && pv.dataUrl) {
            return { text: `图片已直接发送到对话流中（源文件 ${pv.name}）。不要用文字复述图片内容`, details: persistShotFromDataUrl(sessionId, pv.dataUrl) }
          }
          if (pv.content) {
            let tmpTab: string | undefined
            try {
              if (!inst.isRunning()) await inst.start()
              const abs = resolveWorkdirPath({ workDir: sessions.get(String(sessionId || ''))?.workDir }, rawPath)
              tmpTab = (await inst.newTab(`file:///${abs.replace(/\\/g, '/')}`)).id
              await new Promise(rs => setTimeout(rs, 600))   // 本地文件渲染余量
              const r = await inst.screenshot(tmpTab, fmt)
              return { text: `文件 ${pv.name} 已渲染截图发送到对话流中（源=${abs}）。不要用文字复述图片内容`, details: persistShot(sessionId, r.data, r.mime) }
            } catch (e: any) {
              return { text: `渲染文件截图失败：${e?.message || e}。图片文件可直接发送，HTML 也可让用户在预览面板查看（wb_preview_file）`, isError: true }
            } finally {
              if (tmpTab) { try { await inst.closeTab(tmpTab) } catch { /* ignore */ } }
            }
          }
          return { text: `「${rawPath}」类型暂不支持发送（支持 png/jpg/webp/gif/svg 等图片与 html/md/txt 等文本渲染截图）`, isError: true }
        }
        if (!inst.isRunning()) return { text: '【不要重试】内置浏览器未运行且无法截图。截本地文件请带 path=；截网页请带 url=。', isError: true }
        const shotReceipt = (u: string, mime: string, data: string) => ({
          text: `截图已发送到对话流（来源：${u || '当前页'}）。用户已经看到了这一张，【同屏无需再次截图发送】——继续完成你的回复即可；只有页面发生变化后才值得再截。不要复述图片内容`,
          details: persistShot(sessionId, data, mime),
        })
        // ② 指定标签页截图
        if (args.tabId) {
          const shotUrl0 = inst.listTabs().find(x => x.id === String(args.tabId))?.url || ''
          if (duplicateShotHit(sessionKey, shotUrl0)) return { text: '同一页面的截图刚刚已经发给用户了，用户已看到，无需重复截图。请继续回复。' }
          if (delayMs) await new Promise(rs => setTimeout(rs, delayMs))
          const r = await inst.screenshot(String(args.tabId), fmt)
          shotDedupBySession.set(sessionKey, { url: shotUrl0, at: Date.now() })
          return shotReceipt(shotUrl0 || String(args.tabId), r.mime, r.data)
        }
        // ③ 带 url：导航到目标页 → 等就绪+可选 delay → 截该页（一步到位且能截"最新"）
        if (rawUrl) {
          if (/^file:\/\//i.test(rawUrl)) return { text: '【行为指令】截本地文件请带 path=（不要用 url=file://）。', isError: true }
          if (duplicateShotHit(sessionKey, rawUrl)) return { text: '同一页面的截图刚刚已经发给用户了，用户已看到，无需重复截图。请继续回复。' }
          const nav = await inst.navigate(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`, tabId)
          markPageAction(sessionKey)
          const p = inst.tryGetTab()
          if (p) { await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}) }
          if (duplicateShotHit(sessionKey, nav.url)) return { text: '同一页面的截图刚刚已经发给用户了，用户已看到，无需重复截图。请继续回复。' }
          if (delayMs) await new Promise(rs => setTimeout(rs, delayMs))
          const r = await inst.screenshot(tabId, fmt)
          shotDedupBySession.set(sessionKey, { url: nav.url, at: Date.now() })
          return shotReceipt(nav.url, r.mime, r.data)
        }
        // ④ 默认：截用户当前激活页（不是 AI 专属页——修复"截到别的 tab"）
        const activePage = inst.requirePage()
        const shotUrl = activePage?.url?.() || ''
        if (duplicateShotHit(sessionKey, shotUrl)) return { text: '同一页面的截图刚刚已经发给用户了，用户已看到，无需重复截图。请继续回复。' }
        if (delayMs) await new Promise(rs => setTimeout(rs, delayMs))
        const r = await inst.screenshot(undefined, fmt)
        shotDedupBySession.set(sessionKey, { url: shotUrl, at: Date.now() })
        return shotReceipt(shotUrl, r.mime, r.data)
      }
      case 'wb_screen_capture': {
        // 0908 C₁：整屏截图（用户桌面上任何可见内容），图进对话流给用户看、不回灌模型。
        // 审批由 assessRisk 把守（high=confirm/self_audit 都弹卡）；不依赖浏览器实例，不进 BROWSER_PAGE_TOOLS。
        const dMs = Math.min(Number(args.delay_ms) || 0, 15000)
        if (dMs) await new Promise(rs => setTimeout(rs, dMs))
        try {
          const shot = await captureDesktopScreen()
          return { text: '整屏截图已发送到对话流（来源=用户桌面）。不要复述图片内容', details: persistShot(sessionId, shot.data, shot.mime) }
        } catch (e: any) {
          return { text: `整屏截图失败：${e?.message || e}。【不要重试】若要截内置浏览器里的页面请改用 wb_send_screenshot。`, isError: true }
        }
      }
      case 'wb_click': {
        const p = inst.requirePage()
        // 0905：支持按可见文字定位（快照清单里的引号文字直接拿来点），大幅减少选择器试错
        if (args.text) { await p.getByText(String(args.text), { exact: false }).first().click({ timeout: 8000 }); return { text: `已点击"${String(args.text).slice(0, 30)}"` } }
        await p.waitForSelector(String(args.selector), { timeout: 8000 }); await p.click(String(args.selector)); return { text: '已点击' }
      }
      case 'wb_fill': {
        const p = inst.requirePage()
        try {
          if (args.placeholder) { await p.getByPlaceholder(String(args.placeholder), { exact: false }).first().fill(String(args.value ?? '')); return { text: '已填写' } }
          await p.fill(String(args.selector), String(args.value ?? '')); return { text: '已填写' }
        } catch {
          // 0905：contenteditable（豆包/kimi 等聊天输入框常见）fill 不进去——点击聚焦后整段插入
          const target = args.placeholder ? p.getByPlaceholder(String(args.placeholder), { exact: false }).first() : p.locator(String(args.selector)).first()
          await target.click({ timeout: 8000 })
          await p.keyboard.insertText(String(args.value ?? ''))
          return { text: '已填写（点击聚焦+文本插入，适用于 contenteditable 输入框）' }
        }
      }
      case 'wb_press_key': { const p = inst.requirePage(); await p.keyboard.press(String(args.key || 'Enter')); return { text: '已按键' } }
      case 'wb_scroll': { const p = inst.requirePage(); await p.evaluate(`window.scrollBy(${args.direction === 'left' ? -1 : args.direction === 'right' ? 1 : 0} * (${Number(args.amount) || 600}), ${args.direction === 'up' ? -1 : args.direction === 'down' ? 1 : 0} * (${Number(args.amount) || 600}))`); broadcastScrollMetrics(sessionId); return { text: '已滚动' } }
      case 'wb_wait': {
        const p = inst.requirePage()
        if (args.selector) { await p.waitForSelector(String(args.selector), { timeout: Number(args.timeoutMs) || 15000 }).catch(() => {}) }
        else {
          // 0905 十一批：智能等待——等网络空闲（上限 ms），比死等 N 秒精准；SPA 轮询站超时即止
          const ms = Math.min(Number(args.ms) || 3000, 15000)
          await p.waitForLoadState('networkidle', { timeout: ms }).catch(() => {})
        }
        const title = await p.title().catch(() => '')
        return { text: `ok（当前页面：「${title}」 ${inst.tryGetTab()?.url() || ''}）` }
      }
      case 'wb_hover': {
        // 悬停（展开下拉菜单/显示悬浮层用）：text= 可见文字优先
        const p = inst.requirePage()
        if (args.text) { await p.getByText(String(args.text), { exact: false }).first().hover({ timeout: 8000 }); return { text: `已悬停"${String(args.text).slice(0, 30)}"` } }
        if (args.selector) { await p.hover(String(args.selector), { timeout: 8000 }); return { text: '已悬停' } }
        await inst.input('hover', { x: Number(args.x) || 0, y: Number(args.y) || 0 }, tabId)
        return { text: '已悬停到坐标' }
      }
      case 'wb_get_text': {
        // 定点取文本（0905 十一批：比整页 snapshot 轻量，上下文友好）：text=/selector= 定位
        const p = inst.requirePage()
        let txt = ''
        if (args.text) txt = await p.getByText(String(args.text), { exact: false }).first().innerText({ timeout: 8000 }).catch(() => '')
        else if (args.selector) txt = await p.locator(String(args.selector)).first().innerText({ timeout: 8000 }).catch(() => '')
        else txt = await p.evaluate('document.body ? document.body.innerText.slice(0, 2000) : ""').catch(() => '')
        return { text: String(txt).slice(0, 2000) || '（未取到内容）' }
      }
      case 'wb_fill_form': {
        // 表单批量填写：fields:[{placeholder|selector, value}]，一次调用填完整个表单（降轮次）
        const p = inst.requirePage()
        const fields = Array.isArray(args.fields) ? args.fields : []
        let ok = 0
        for (const f of fields) {
          try {
            if (f.placeholder) await p.getByPlaceholder(String(f.placeholder), { exact: false }).first().fill(String(f.value ?? ''), { timeout: 6000 })
            else await p.fill(String(f.selector), String(f.value ?? ''), { timeout: 6000 })
            ok++
          } catch {
            try {
              const t = f.placeholder ? p.getByPlaceholder(String(f.placeholder), { exact: false }).first() : p.locator(String(f.selector)).first()
              await t.click({ timeout: 6000 }); await p.keyboard.insertText(String(f.value ?? ''))
              ok++
            } catch { /* 单字段失败跳过 */ }
          }
        }
        return { text: `已填写 ${ok}/${fields.length} 个字段` }
      }
      case 'wb_console': {
        // 读页面 console/pageerror 最近输出（SPA 报错排查）
        const n = Math.min(Math.max(Number(args.count) || 30, 1), 200)
        const lines = inst.consoleBuf.slice(-n)
        return { text: lines.join('\n') || '（暂无 console 输出）' }
      }
      case 'wb_evaluate': { const p = inst.requirePage(); const v = await p.evaluate(String(args.expression)); return { text: typeof v === 'string' ? v : JSON.stringify(v) } }
      case 'wb_set_viewport': { const r = await inst.setViewport(String(args.viewport || 'pc')); return { text: `视口已切换为 ${r.viewport}` } }
      case 'wb_list_tabs': {
        const ts = inst.listTabs() as any[]
        const homeNote = ts.filter(t => t.isHome).length ? '（其中 1 个是默认首页标签，不算你打开的网站）' : ''
        return { text: JSON.stringify(ts) + homeNote }
      }
      case 'wb_close_tab': {
        // 0905 九批硬约束：默认首页标签与最后一个标签禁止 AI 关闭（防模型误清用户页面）
        const targetId = String(args.tabId || '')
        const all = inst.listTabs()
        if (all.length <= 1) return { text: '拒绝：这是最后一个标签页，不能关闭', isError: true }
        const home = inst.getHomeUrl()
        const target = all.find(t => t.id === targetId)
        if (target && home && target.url === home) return { text: '拒绝：这是用户的默认首页标签，不能关闭', isError: true }
        const r = await inst.closeTab(targetId)
        return { text: JSON.stringify(r.tabs) }
      }
      case 'wb_preview_file': {
        // 0905 九批：本地产物展示走预览（file 渲染零延迟），不用内置浏览器
        const sid = String(sessionId || '')
        const raw = String(args.path || '').trim()
        if (!raw) return { text: '缺少 path', isError: true }
        // 0908 A 闸门：外部网址硬禁走预览（与 wb_navigate 互设闸门，两通道语义不再互相渗透）
        if (/^https?:\/\//i.test(raw)) {
          return { text: '【行为指令】wb_preview_file 仅用于本地工作区文件。外部网址请用 wb_navigate（内置浏览器）打开；若只是想把网页截图发给用户，用 wb_send_screenshot url=。', isError: true }
        }
        try {
          const pv = readForPreview(sid, raw)
          // 0914 精准打击②：附带规范化工作区相对路径——前端按路径命中已开 tab 就地刷新（不再叠 ai: 重复 tab）
          let relPath = ''
          try {
            const wd = (sessions.get(sid)?.workDir || '').trim()
            if (wd) relPath = path.relative(wd, resolveWorkdirPath({ workDir: wd }, raw)).replace(/\\/g, '/')
          } catch { /* 解析失败就不带，行为与旧版一致 */ }
          broadcastMux('', { type: 'preview/open', sessionId: sid, kind: pv.kind, name: pv.name, content: pv.content, dataUrl: pv.dataUrl, path: relPath || undefined })
          return { text: `已在预览中打开 ${pv.name}。请继续完成你的回复（不要停在这个工具上）` }
        } catch (e: any) {
          return { text: `无法预览：${e?.message || e}`, isError: true }
        }
      }
      default: return { text: `未知浏览器工具：${tool}`, isError: true }
    }
  } catch (e: any) {
    return { text: `浏览器操作失败（${tool}）：${e?.message || e}`, isError: true }
  } finally {
    // 释放占用（不覆盖用户接管权）
    if (holdsControl && inst.controlledBy === 'ai') {
      inst.controlledBy = ''
      try { broadcastMux('', { type: 'browser/control', sessionId: sessionKey, by: '' }) } catch { /* ignore */ }
    }
  }
}
// 0905 十五批：每个浏览器实例挂"自动回无头"广播（有头窗口被用户点 × 后，前端图标同步）
browserEngine.setInstanceHook((inst) => {
  inst.onAutoModeChange = (mode) => {
    try { broadcastMux('', { type: 'browser/status', sessionId: inst.key, connected: inst.isRunning(), mode, viewport: inst.currentStatus().viewport }) } catch { /* ignore */ }
  }
  // 0908②(a)：标签收养（含用户在有头窗口手动开的页）即时广播 tabs 帧——
  // 面板 2s 轮询是兜底，帧让"手动开 tab 不进列表"的观感延迟归零
  inst.onTabsChange = () => {
    try { broadcastMux('', { type: 'browser/tabs', sessionId: inst.key, tabs: inst.listTabs(), activeTabId: (inst.currentStatus() as any).activeTabId, mode: inst.mode }) } catch { /* ignore */ }
  }
})

function registerBuiltinVirtualServers(): void {
  registerVirtualServer('nis-browser', {
    description: '内置 Chromium 浏览器（Playwright 驱动，持久登录态；人可在「浏览器」视图实时观看并接管，AI 用下列工具自动化网页）',
    tools: BROWSER_TOOLS,
    call: callBrowserTool,
  })
  console.log(`[mcp] registered builtin virtual server: nis-browser (${BROWSER_TOOLS.length} tools)`)
}

/** 浏览器直播帧节流广播（0905 七批按会话隔离：每会话独立实例/回调，帧带 sessionId 给对应前端桶） */
const lastFrameAtBySession = new Map<string, number>()
function setBrowserWatch(on: boolean, sessionId?: string): void {
  const inst = browserEngine.getBrowserInstance(sessionId)
  if (on) {
    // 0905 T5：有人在看 → 挂起引擎 idle 计时（光看着/悬停不算空闲；离开视图 unwatch 后才起算 90s）
    inst.pauseIdle()
    inst.setFrameCallback((tabId, data, meta) => {
      const now = Date.now()
      const key = String(sessionId || 'default')
      // 0906 体检性能#4：按会话节流（多会话同看互不抢配额）
      if (now - (lastFrameAtBySession.get(key) || 0) < browserEngine.getCastMinIntervalMs()) return
      lastFrameAtBySession.set(key, now)
      broadcastMux('', { type: 'browser/frame', sessionId: key, tabId, data, mime: 'image/jpeg', width: meta.width, height: meta.height })
    })
  } else {
    inst.setFrameCallback(null)
    inst.resumeIdle()
  }
}

/** 浏览器设置（0905）：流畅度/反爬/渲染参数，落盘 browser-settings.json，启动即应用进 engine */
const BROWSER_SETTINGS_PATH = path.join(DATA_ROOT, 'browser-settings.json')
interface BrowserSettings {
  castFps: number; castQuality: number; castScale: number; castEveryNth: number
  stealth: boolean; blockMedia: boolean; gpu: boolean
  proxy: string
}
const BROWSER_DEFAULTS: BrowserSettings = { castFps: 11, castQuality: 60, castScale: 1, castEveryNth: 1, stealth: true, blockMedia: false, gpu: false, proxy: '' }
function loadBrowserSettings(): BrowserSettings {
  try { return { ...BROWSER_DEFAULTS, ...JSON.parse(fs.readFileSync(BROWSER_SETTINGS_PATH, 'utf-8')) } } catch { return { ...BROWSER_DEFAULTS } }
}
function applyBrowserSettingsToEngine(s: BrowserSettings): void {
  browserEngine.setRenderOpts({ stealth: s.stealth, blockMedia: s.blockMedia, gpu: s.gpu, proxy: s.proxy || '' })
  browserEngine.setCastOpts({ fps: s.castFps, quality: s.castQuality, scale: s.castScale, everyNthFrame: s.castEveryNth })
}

import { logEvent, readSessionLogs, cleanupOldLogs } from './sessionLogger.ts'
import { getCustomAgentTools, buildCustomToolAdminTools, saveCustomTool, deleteCustomTool, listCustomTools } from './customTools.ts'
import { initTeams, listTeams, readTeam, saveTeam, deleteTeam, TEAMS_DIR, type TeamDef } from './teamsStore.ts'
import { listProjects, createProject as createProjectStore, updateProject as updateProjectStore, deleteProject as deleteProjectStore, setProjectStorageRootProvider } from './projectsStore.ts'
import { migrateRootPathsOnDisk, deleteDirToRecycleBin } from './projectPaths.ts'
import { listChannels, getChannel, getChannelRedacted, updateChannel, addBot, updateBot, removeBot, modelForChannel, setRemoteToken, invalidateChannelsCache } from './channelsStore.ts'
import { parseCommand, findCommand, helpText, commandList, parsePermMode, permLabel, permText, PERM_OPTIONS } from './channelCommands.ts'
import { buildCommandKeyboard, buildItemKeyboard, buildApprovalKeyboard, commandHint, type ButtonScene } from './channels/qqButtons.ts'
// 0912 接入批：QQ 官方 Bot API（WebSocket 长连接）+ 通道会话映射
import { setQqBotHandlers, syncQqBotsFromConfig, sendQqMessage, sendQqMedia, stopAllQqBots, qqBotStatus, reserveQqMsgSeq } from './channels/qqBot.ts'
/* ★1013a：QQ 指令面板同步（把内置命令注册到 QQ 平台）。该模块零 import / 零广播 /
   零事件监听 / 零定时器，只发异步 HTTP —— 不碰会话/帧/路由，不影响对话流。 */
import { fetchQqAccessToken, listQqPanels, syncQqPanel, QQ_PANEL_ITEMS } from './channels/qqPanel.ts'
/* ★1019：QQ 单聊**自定义菜单**（单聊窗口底部常驻）。同样只发异步 HTTP，不碰会话/帧/路由。
   ⚠️ 菜单项 send_message 的语义是「点击后文本**填进输入框**」（用户还得按发送）⇒ 定位是"常驻快捷入口"，
   一键执行仍靠消息按钮（按钮是回调式，点了就执行）。 */
import { fetchQqMenu, syncQqMenu } from './channels/qqMenu.ts'
/* ★1014b：QQ 私聊正文流式（官方 stream_messages）。该模块只发"一帧 HTTP"——零广播、零事件
   监听、零定时器（定时器与降级策略都在 server.ts 这边，见 QqStreamState 注释）。 */
import { sendQqStreamFrame, shouldPushFrame, clipStreamText, QQ_STREAM_MAX_CHARS } from './channels/qqStream.ts'
import { setWechatBotHandlers, startWechatBot, stopWechatBot, stopAllWechatBots, sendWechatText, sendWechatMedia, sendWechatToolProgress, wechatBotStatus } from './channels/wechatBot.ts'
import { listTasks, createTask, updateTask, removeTask, runTaskNow, getTaskOwnSessionIds, setTaskRunner, setTaskSessionResolver, startScheduler, describeSchedule, normalizeNotifyTargets, setOwnSession, setExecSession, type TaskNotifyTarget } from './scheduledTasks.ts'
import { makeChannelKey, getLink, setLink, touchLink, removeLinkBySession, listLinks, setBotActive, getBotActive, clearBotActive, setContextToken, setKind } from './channels/sessionMap.ts'
/** ★1014f：PC 会话接管的准入闸（配对码 + 白名单） */
import { isPaired, tryPair, getPairCode, pcAccessFilePath } from './channels/pcAccess.ts'
// 0912 接入批：微信扫码登录（移植官方 openclaw-weixin，MIT）
import { startQrLogin, waitQrLogin, cancelQrLogin } from './channels/wechatAuth.ts'
// 0912 十四批：群成员目录（让 AI 分得清「群里谁在说话」）
import { identifyMember, listMembers, toMentionText } from './channels/memberDirectory.ts'
// 0912 十五批：群聊流水（旁听全量群消息 → 回答「刚才谁说了什么」）
import { recordGroupLine, recentGroupLines, canInterject, markInterject, markBotSpoke } from './channels/groupTranscript.ts'
// 0912 十七批：对端显示名（群A/群B…）—— 多群场景下「谁是谁」的唯一可读标识
import { labelFor, setPeerLabel, allPeerLabels } from './channels/peerLabels.ts'
// 0912 十八批：尝试拉真实群名做显示名（官方接口仅白名单机器人可用，失败就继续用 群A/群B）
import { fetchQqGroupInfo } from './channels/qqBot.ts'
// 0912 二十二批：联调投喂原始事件（平台字段灰度/变更时拿真实事件体本地回归）
// 0912 十九批：定时任务「待回复通知」台账（/通知 · /回复通知）
import { recordNotice, listNotices, markNoticeReplied, clearNoticesByTask } from './channels/notices.ts'
// 0912 二十一批：入站图片（QQ 图链下载 / 微信 CDN 解密后落盘）→ 附件喂给 agent（AI 能看图）
import { type InboundImage, downloadImageUrl, fetchQqImages, INBOUND_IMAGE_MAX_COUNT } from './channels/imageIntake.ts'

/** 群名拉取节流（每对端 30 分钟最多试一次，避免打满 30 QPM 限额） */
const groupNameTriedAt = new Map<string, number>()

/**
 * 拉一次**真实群名**并对端显示名（0912 十八批）。
 *
 * 官方接口 `GET /v2/groups/{group_openid}/info` 会返回 `group_name`，但**仅白名单机器人可用**；
 * 非白名单返回 11253。所以这里全程静默失败：拿到就用真群名（比「群A」直观），
 * 拿不到就维持自动分配的 群A/群B（用户也能手动改名）。用户手填过的名字不会被覆盖。
 */
async function syncGroupName(channel: string, botId: string, peerId: string): Promise<void> {
  if (channel !== 'qq' || !botId || !peerId) return
  const k = makeChannelKey(channel, botId, peerId)
  const last = groupNameTriedAt.get(k) || 0
  if (Date.now() - last < 30 * 60 * 1000) return
  const prev = allPeerLabels()[`${channel}:${botId || '-'}:${peerId}`]
  if (prev && prev.auto === false) return   // 用户自定义名优先，别覆盖
  groupNameTriedAt.set(k, Date.now())
  const info = await fetchQqGroupInfo(botId, peerId)
  if (!info.ok || !info.name) {
    console.log(`[channel] 群名拉取失败（接口需白名单，属正常）：${peerId.slice(0, 8)} · ${String(info.error || '无返回').slice(0, 100)}`)
    return
  }
  setPeerLabel(channel, botId, peerId, info.name, 'group', { auto: true })
  console.log(`[channel] 群名已同步：${peerId.slice(0, 8)} →「${info.name}」${info.memberNum ? `（${info.memberNum} 人）` : ''}`)
}
import { buildTeamTools, clearBlackboard, abortSubAgents, loadBlackboard, runMemberChat, memberChatsSnapshot, clearMemberChats, bumpMemberDmGeneration, abortMemberDm, setMemberChatSessionLivenessCheck, setMemberRunLimitProvider, setMemberInspectorProvider, setInspectorReviewer, isRunActive, type TeamCtx, type ModelOverride } from './teamRuntime.ts'
import { listActiveRunFrames, runningSubAgentCount, setSubAgentsIdleHook } from './teamRuntime.ts'
import { buildCloneTools } from './cloneRuntime.ts'
import { Type as TbType } from 'typebox'
import { currentLlmConfig, getState, isBuiltinProvider, setProviderKey, setProviderLogo, setActiveModel, setActiveEffort, activeEffort, setProviderBase, setProviderProxy, setProviderProtocol, toggleProviderEnabled, addProvider, removeProvider, setModels, fetchModelsRemote, testConnectionRemote, revealKey, plainKeyById, plainKey, sealPortableKeys, unsealPortableKeys, autoSyncZenFreeModels, resolveModelCaps, resolveModelEfforts, clampEffort, resolveMaxOutput, resolveContextWindow, resolveMaxInput, reloadProviders, keepImportedProviderModels, backgroundLlmConfig, setBackgroundModel, type ProviderModel } from './providers.ts'
/* ★ 1001：密钥加密（enc:v1:dpapi/…）的判定 —— 发送前用它拦"把密文当明文发出去"这一类代码缺陷 */
import { isEncrypted } from './secretbox.ts'
import { sanitizeRequestMessages, repairToolPairing } from './messageSanitize.ts'
/* 0920：语音（语音输入 ASR / 朗读 TTS）—— 模型增量包，装到 <envDir>/voice，不进安装包 */
import { voiceState, voiceInstallStart, voiceJobGet, voiceRemove, voiceSpeak, voiceTranscribe, voiceRelease, loadCfg as loadVoiceCfg, saveCfg as saveVoiceCfg, modelCfg as voiceModelCfg, findModel as findVoiceModel } from './voice.ts'
/* 0920：后台任务（挂后台跑长命令/下载，完事通知会话与 AI） */
import { bgList, bgGet, bgStop, bgPause, bgResume, bgClear, bgReadOutput, setBgEmitter, setBgNotifier, setBgWatcher, bgSuggestWatchSec } from './backgroundTasks.ts'
/* ★ 0922e：进程监控（AI 工具拉起的进程） */
import { procList, procKill, setProcEmitter, setProcRemover } from './processRegistry.ts'
import { setFileLockRunLiveness } from './fileLocks.ts'
import { recordUsage, stats, resetStats, type BillingPeriod } from './billing.ts'
import { loadJsonOrBackup, degradedFiles } from './jsonStore.ts'
import { Type } from 'typebox'
import { matchIndiscriminateKillCommand } from './processGuard.ts'
import { swallowed } from './swallowed.ts'

/* ── 0906 体检 P1#8：JSON 原子写（tmp+rename）——防崩溃损坏 Key/设置/统计文件 ── */
function atomicWriteFileSync(file: string, data: string): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, file)
}

// 多模态调试日志（写入文件，方便排查图片是否真实发送）
const MULTIMODAL_LOG = path.join(DATA_ROOT, 'multimodal.log')
function logMM(msg: string) {
  try { fs.appendFileSync(MULTIMODAL_LOG, `${new Date().toISOString()} ${msg}\n`) } catch {/* ignore */}
}

// ============================================================================
// Config
// ============================================================================

// 0911 #16：支持 NIS_PORT 覆盖（冒烟副本验证用，默认仍是 8766）
const PORT = Number(process.env.NIS_PORT || 8766)

// ============================================================================
// Types (minimal DSH protocol)
// ============================================================================

interface ClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

interface ServerResponse_Frame {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: unknown } | { ok: false; error: string }
}

interface ServerRequest {
  type: 'server-request'
  rpcId: string
  payload: MuxFrame | HostFrame
}

type MuxFrame =
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  /** ★1005 补类型：订阅确认的"全局流"变体（无会话上下文时用） */
  | { type: 'stream/subscribed'; sessionId?: string; lastSeq: number }
  /** ★1005 补类型：**会话运行状态帧** —— 后端 8 处广播、前端整套"运行中/收轮(agentEnd)"逻辑都吃它，
   *  却一直不在联合里（于是又成了"用 as any 绕"的一处）。字段按实际广播点取值。 */
  | { type: 'session/status'; sessionId: string; running: boolean; agentEnd?: boolean; aborted?: boolean; stopped?: boolean;
      loopBreak?: boolean; usage?: unknown; timing?: unknown; model?: string; replyPreview?: string; sessionTitle?: string }
  /** ★1005 补类型：自动压缩完成后的"合法变短"通知（前端据此重建，不能当本地更新跳过） */
  | { type: 'session/compacted'; sessionId: string; folded: number; keepFrom: number; auto?: boolean; summaryLen?: number }
  | { type: 'session/event'; sessionId: string; event: SessionEvent; view?: unknown; expectFinal?: boolean }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'session/hitl-request'; sessionId: string; requestId: string; question: string; options: string[]; tool: string; risk: string; args?: unknown }
  | { type: 'session/question'; sessionId: string; requestId: string; question: string; options?: string[]; placeholder?: string; multiple?: boolean;
      /** ★1005 补类型：多问题卡（>1 时才带）——前端 QuestionComposer 正是读它判断 isMulti */
      questions?: Array<{ question: string; options?: string[]; placeholder?: string }> }
  | { type: 'session/log'; sessionId: string; entry: { t: number; level: string; category: string; message: string; data?: any } }
  | { type: 'session/plan'; sessionId: string; items: Array<{ text: string; done: boolean }>;
      /** ★1005 补类型：黑板计划随帧独立下发（前端 ChatInterface 读 p.boardItems → c.boardPlan） */
      boardItems?: Array<{ text: string; done: boolean }> }
  | { type: 'session/subagent-event'; sessionId: string; runId: string; stepId: string; memberId: string; memberName: string; seq: number; event: unknown }
  | { type: 'session/agent-event'; sessionId: string; seq: number; event: AgentEvent }
  | { type: 'session/blackboard'; sessionId: string; blackboard: unknown }
  | { type: 'browser/frame'; sessionId?: string; tabId: string; data: string; mime: string; width: number; height: number }
  | { type: 'browser/status'; sessionId?: string; connected: boolean; mode: string; viewport: string; activeTabId?: string }
  | { type: 'browser/tabs'; sessionId?: string; tabs: unknown[]; activeTabId?: string; mode?: string }
  | { type: 'browser/act'; kind: 'open'; sessionId?: string }
  | { type: 'preview/open'; sessionId: string; kind: 'html' | 'image' | 'file'; name: string; content?: string; dataUrl?: string; path?: string }
  | { type: 'browser/control'; sessionId?: string; by: 'user' | 'ai' | '' }
  | { type: 'browser/scroll'; sessionId?: string; y: number; h: number; vh: number }
  /* 0917b：数据备份进度（设置→通用→数据备份）——长耗时打包/解包不再只有"处理中"三个字。
   * 走全局桶广播（''），无会话上下文也能收到；percent<0 = 不定量（阶段文本仍可显示）。 */
  | { type: 'data/progress'; task: 'export' | 'import'; percent: number; phase: string }
  | { type: 'stream/error'; error: { code: string; message: string } }

/** 权限模式：三档（与前端 PermissionSelector 对应） */
type PermissionMode = 'confirm' | 'self_audit' | 'full_access'

/** 挂起的工具审批请求 */
interface PendingApproval {
  sessionId: string
  /** choice = 用户选择；reasonOverride = 非用户选择（停止/删除等）时的结论文案 */
  resolve: (choice: string, reasonOverride?: string) => void
  timer: NodeJS.Timeout
  /** 0908三①：审批卡内容快照（session.history 刷新恢复用，与询问卡 pendingFor 同款） */
  question: string
  tool?: string
  risk: string
  options: string[]
}

/** 挂起的询问请求（AI 主动问用户） */
interface PendingQuestion {
  sessionId: string
  /** 原始问题内容（刷新后恢复询问卡显示用） */
  questions: Array<{ question: string; options?: string[]; placeholder?: string }>
  resolve: (value: string) => void
  timer: NodeJS.Timeout
}

type HostFrame =
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  | { type: 'host/session-added'; sessionId: string; blank: boolean; parentSessionId?: string; cwd?: string }
  | { type: 'host/session-removed'; sessionId: string }
  | { type: 'host/session-status'; sessionId: string; running: boolean }
  | { type: 'host/session-renamed'; sessionId: string; title: string }
  /** ★1005 补类型：项目增删改后通知前端刷新项目树（3 处广播） */
  | { type: 'host/projects-changed' }
  | { type: 'host/settings-updated'; settings: Record<string, any> }
  | { type: 'host/channel-reply'; sessionId: string; channel: string; botId: string; kind: string; title: string; preview: string; at: number }
  | { type: 'stream/error'; error: { code: string; message: string } }

interface SessionEvent {
  type: 'message_added' | 'message_updated'
  message: DSHMessage
  expectFinal?: boolean
}

interface DSHMessage {
  id: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  timestamp: number
  expectFinal?: boolean
  /** 模型 id（assistant 消息：流式透传；供前端气泡头部展示） */
  model?: string
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

/** 0909⑦ 排队消息条目（后端权威持久化；前端队列条=这份账本的镜像） */
interface QueuedMsg {
  id: string
  text: string
  /** 图片附件（dataUrl）——flush 时随 prompt 走 vision 闸门 */
  attachments?: Array<{ name: string; dataUrl: string }>
  skills?: string[]
  /** 入队时的会话模型覆盖快照（flush 时同源带上；null=跟随全局） */
  model?: { provider: string; model_id: string; base?: string }
  effort?: string
  createdAt: number
}

interface SessionView {
  id: string
  title: string
  messages: DSHMessage[]
  createdAt: number
  updatedAt: number
  model: string
  /** 0908三：model 归属供应商 id（持久化）。前端刷新后按它回填每会话模型覆盖；
   *  无此字段=该会话从未显式选过模型（存量/新建兜底），前端不回填、跟随全局 */
  modelProviderId?: string
  status: 'idle' | 'running'
  /** 浼氳瘽宸ヤ綔鍖猴細浜у嚭/涓嬭浇榛樿钀借繖閲岋紙鏅€氳亰澶?鏃堕棿鎴冲瓙鐩綍锛涢」鐩?椤圭洰 root_path锛?*/
  workDir?: string
  /** Agent 棰勮 id锛堝垱寤烘椂瀹氬瀷锛?*/
  presetId?: string
  /** 团队 id（P1 配置绑定；P2 编排运行时消费） */
  teamId?: string
  /** 0917：项目归属（项目树子节点；空=本体聊天）。此前前端写死 null → 项目会话重启后错归到聊天列表 */
  projectId?: string
  /** 计划本（主 agent）：AI 用 plan_write 拆解的任务清单（计划面板渲染） */
  plan?: Array<{ text: string; done: boolean }>
  /** 0910 三批①计划面板三合一：黑板步骤独立存——原先黑板 syncPlan 直接覆盖 plan，
   *  导致主 agent 自己的计划与团队黑板互相覆盖（串台）。前端按 黑板→主计划→子计划 顺序渲染三张卡 */
  boardPlan?: Array<{ text: string; done: boolean }>
  /** 0909⑦改：会话置顶（列表排序+标识）。此前只存前端内存态，刷新即丢 */
  pinned?: boolean
  /** 0912 接入批：会话来源通道（undefined/空=桌面端；'wechat'|'qq'|... = 该通道创建的会话）。
   *  用途：① 通道弹窗按来源过滤出自己的「独享对话列表」 ② 侧栏/标题可标来源。
   *  通道会话**仍是普通会话** —— 因此 PC 上可直接打开继续聊（跨端接续）。 */
  origin?: string
  /** 通道侧的对端标识（微信 from_user_id / QQ openid）：同通道内区分不同联系人 */
  originPeer?: string
  /** 0912 二批：来源机器人 id。QQ 支持多机器人，每个机器人的对话列表必须互相独立 */
  originBot?: string
  /** 0912 三批：对端类型（QQ/微信的消息场景）—— 'c2c'=私聊 / 'group'=群聊 / 'channel'=频道。
   *  用途：同一机器人下混着私聊与群聊的会话时，列表里能一眼区分（用户明确要求）。 */
  originKind?: string
  /**
   * 0912 十九批：**定时任务的专属支线**标记（= 所属任务 id）。
   * 用途：① 标题/列表上打 ⏰ ② 右键改为「放回定时任务」③ **禁止直接删**（只能删任务，随任务一起消失）。
   */
  taskId?: string
  /** 该任务支线是否要出现在**主对话列表**里（穿插模式默认 false，列表通知默认 true；可右键放回） */
  inMainList?: boolean
  /** ★ 0922z2b（需求）：**迁入主对话列表的时间**（「独享会话 → 移到聊天列表」时打点）。
   *  侧栏排序取 max(最后活跃, movedInAt) ⇒ 刚挪进来的排最前；在里面聊过之后 updatedAt 超过它，
   *  自然回落 —— 不篡改真实聊天时间。 */
  movedInAt?: number
  /** ★0927（已定案 ①b）：**最后已读时间戳**（ms）。未读=该会话里 ts 晚于它的 AI 回复条数，
   *  由 `session.list` 现场算 + 随会话持久化 ⇒ 刷新页面/重开窗口不再丢未读。
   *  写入点：`session.markRead`（前端点开会话 / 正在看的会话跑完一轮时调）。 */
  lastReadAt?: number
  /** 用户手动重命名过：AI 自动总结标题不再覆盖 */
  titleManual?: boolean
  /** 0910：AI 总结标题已成功落定（持久化；未成功前每轮 agent_end 重试，成功后不再重复生成） */
  titleGenerated?: boolean
  /** 组装好的系统提示词（人格层/角色层/运行时层，创建时定型） */
  system?: string
  /* ★1005 补类型（③ 第一步）：下面 7 个字段**运行时一直在读写**，只是类型没声明 ——
     类型说"没这字段"，写代码的人就只能 `as any` 绕 ⇒ 这正是全项目 704 处 `as any` 的根源之一。
     字段类型按**实际赋值/读取形态**推出（见各条注释），纯类型声明、运行时零影响。 */
  /** 自动压缩的冷却截止时间戳（ms）；到点前不再尝试压缩，靠占位折叠顶住 */
  compactCooldownUntil?: number
  /** 连续压缩失败次数（达到阈值进冷却） */
  compactFailStreak?: number
  /** 最近一次压缩失败原因（进冷却时随日志给出，便于排查） */
  compactLastError?: string
  /** 压缩进行中的互斥锁截止时间戳（ms）：另一路请求持锁时本轮改用占位折叠 */
  compactLockUntil?: number
  /** 上下文用量锚点（收到新真实 usage 时撤销）：tokens=估算用量 / at=打点时间 / viewCount=当次请求消息数 */
  ctxUsedOverride?: { tokens: number; at: number; viewCount: number }
  /** 上下文圆环显示的用量（圆环只读它，不读 ctxUsedOverride；两者必须同步写） */
  ctxUsedForRing?: number
  /** 外部预设会话的 part 流记录（P0 契约 1010）：刷新回放用，与 persistSessions 的落盘字段对应 */
  extTranscript?: import('./externalAgents/acpRuntime.ts').PartEvent[]
  /** ★1010j：ACP 会话 id + 当时模型（换模型自动弃旧会话）——codex 自己的会话状态，下轮 session/load 续上 */
  extAcpSessionId?: string
  extAcpModel?: string
  /** 权限模式（三档）：confirm=需要确认 / self_audit=自审计 / full_access=完全访问。默认 confirm */
  permissionMode?: PermissionMode
  /** 0920：工作模式（plan=计划模式·只出方案不动手 / build=构建模式·跳过规划直接干 / default=默认）。
   *  ⚠️ 实现方式是**随用户消息注入一段行为指令**（跟技能标记同一机制），
   *  不进 systemPrompt、不参与 agent 配置指纹 ⇒ **切模式不会重建 agent、不影响其它会话**。
   *  goal（目标模式）尚未实装，前端标"规划中"。 */
  mode?: string
  /** 会话级授权记忆（"当前会话允许"的工具指纹，后续同类调用不再审批） */
  approvedTools?: string[]
  /** 会话级成员技能覆盖（memberId → 技能名清单）。新对话默认空——技能勾选不再写进团队配置
   *  （团队是全局共享的，跨项目继承技能是 0901 反馈 #6 的根因），派发时按本会话覆盖生效 */
  memberSkills?: Record<string, string[]>
  /** pi 格式对话记录（agent_end 时快照，持久化用；重启后恢复上下文/历史） */
  transcript?: unknown[]
  /** ★0928 T2：分身执行过程记录（subRuns）会话级持久化表 —— toolCallId → 成员 runs 快照数组。
   *  与 messages/transcript/turnMetas 同级随会话落盘；老会话无此字段 → 加载时回退空对象。
   *  只在内容变化时置脏落盘（schedulePersist 去抖节流），不是每次注入循环都写盘。 */
  subRuns?: Record<string, any[]>
  /** 消息级 turn 元数据（写时补全：agent_end 落笔，ts = 本轮最后一条 assistant 消息的 timestamp）。
   *  history 响应时由服务端按 ts 挂到对应 assistant 消息的 _turnMeta 上——前端直读，
   *  读侧零推断/零兜底（0831-0901 系列刷新丢统计的根治） */
  // 0910：usage 扩缓存三字段——本轮命中率进 AI 组悬停统计（复制按钮右侧那行），刷新后从 _turnMeta 恢复
  turnMetas?: Array<{ ts: number; timing?: { llmMs: number; ttftMs: number; toolMs?: number }; usage?: { completionTokens: number; promptTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>
  /** ★ 0924（token 对账修）：会话级 usage 单调账本 —— 每轮 agent_end 累加（含中断轮：已消耗=真实账单）。
   *  只增不减（删轮/重跑不回退——账单也不退款）；不用 turnMetas 求和是因为它只留最近 200 条且删轮会移除条目。 */
  usageTotals?: { uncached: number; cacheRead: number; cacheWrite: number; output: number; turns: number }
  /** 创建/重建时记录的设置版本（settings.update 后重建 agent 用新 system） */
  settingsVersion?: number
  /** 最近一次 LLM 请求的真实 usage（context 圆环/统计条用） */
  lastUsage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /** 0921：上一次请求**发出前我们估算的输入 token**。与 lastUsage 的真实值一比 = 本会话的估算校准系数
   *  （不同内容构成系数不同：导入类会话 char/2.2 会低估到 1.4 倍）。发送预算靠它把"估算"变成"接近真实"。 */
  lastPromptEstimate?: number
  /** 0921：上一次请求直接撞了「maximum context length」时，供应商在错误里**自报的真实输入 token**
   *  （比任何本地估算都硬）+ 当时我们的估算值。这对数字用于校准后续预算，并让圆环显示真实占用。 */
  ctxOverflowRealInput?: number
  ctxOverflowEstimate?: number
  /** 各模型最近一次 usage（per-model 统计条/第5胶囊悬停用；同一模型重复使用覆盖更新） */
  modelUsage?: Record<string, { timing?: { llmMs?: number; ttftMs?: number; toolMs?: number }; usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>
  /** 本对话用过的不同模型（按首次使用顺序去重） */
  usedModels?: string[]
  /** 思考强度（per-session 窗口隔离；fast/deep/heavy/burning → reasoning_effort） */
  effort?: string
  /** 0909⑦ 排队消息（AI 忙时发送入队，整轮自然结束后自动逐条发出）。权威源在后端（用户铁律：
   *  禁 localStorage 兜底）——重启不丢、多窗口经 session/projection(key=queue) 帧同步同一份。 */
  queuedMessages?: QueuedMsg[]
  /** 0909④ 自动续跑运行态（不持久化）：软段计数/本轮 token 累计/已计入 usage 的 assistant 消息数。prompt 开始复位。 */
  contState?: { segments: number; tokens: number; counted: number; graceUsed: boolean }
  /** turn 计时（TTFT/耗时统计） */
  turnStartTime?: number
  firstTokenTime?: number
  lastTurnTiming?: { llmMs: number; ttftMs: number; toolMs?: number }
  /** 工具计时（tool_execution_start → end 累加） */
  toolStartTime?: number
  toolMsTotal?: number
  /** 会话级模型覆盖（安装助手等专用 agent 用「全局模型」，而非聊天模型） */
  llmOverride?: { providerId: string; providerName: string; base: string; apiKey: string; model: string; protocol?: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai' ; effort?: string | null }
  /**
   * 二十一批：llmOverride 的**来源**（★0929 起随会话**只落盘标记**，见 buildSessionPayload）——
   *   'channel' = 按通道配置（接入弹窗里的模型）打的；配置变了可以刷掉
   *   'user'    = 用户在 PC 上手动选的；通道配置不许覆盖它（重启后也必须生效）
   * 为什么要这个标记：通道会话的模型此前只写进 session.model（展示用），
   * 真正调用走 llmOverride||全局 → 通道里配的模型（含**视觉模型**）根本不生效。
   * 0929 P1：原注释"不落盘，进程内有效" → 重启即丢标记 ⇒ 通道覆盖把用户手选顶掉（0924 抹字段事故同族）。
   */
  llmOverrideBy?: 'channel' | 'user'
  /**
   * 二十一批（用户实测）：**预设**的来源标记（★0929 起随会话**只落盘标记**）——
   *   'channel' = 按通道配置（接入弹窗里给机器人选的预设）打的；配置变了可刷掉
   *   'user'    = 用户在 PC 上明确选的（session.configure）；重启后通道也不许顶
   * 为什么需要：预设决定**工具白名单**（`preset.tools` 是严格清单），而 presetId 只在**建会话那一刻**定型 ——
   * 用户给机器人换了「仅对话」预设，旧会话仍挂着老预设（minimal 里有 fs_write）→ 机器人照样能写文件（用户实测质问）。
   */
  presetBy?: 'channel' | 'user'
  /** 撞墙检测状态（思考死循环滑动窗口，运行时态不持久化；agent_start 时重置） */
  loopWindow?: { sigs: Map<string, number>; buf: string }
  /** 上下文分段占用（字符估算，非持久化）：每次 createStreamFn 按真实请求内容重算，供上下文圆环悬停明细。
   *  0911 体系化：分类查 toolCatalog（唯一源）；mcpDetail=MCP 分服务明细（任意数量 MCP 自动生效）；
   *  toolDetail=逐工具明细（定义+调用结果合计，按 token 降序，bucket 对应归属栏）。 */
  contextBreakdown?: {
    base: number; sysTools: number; specialTools: number; mcpTools: number; skill: number; messages: number
    mcpDetail?: Array<{ name: string; tokens: number }>
    toolDetail?: Array<{ name: string; bucket: 'mcp' | 'skill' | 'sys' | 'special'; tokens: number }>
  }
  /** C3 上下文压缩：早期对话的滚动摘要（持久化；请求期前缀注入，transcript 本身不改） */
  contextSummary?: string
  /** 摘要覆盖到的起始消息索引（transcript 中从该索引起被摘要替代；用于增量重算 + 幂等） */
  summaryStartIndex?: number
  /** 压缩时导出的工作区存档相对路径（供摘要消息引用 + 复用，避免每轮重复写盘） */
  compactArchiveRel?: string
  /** 每次压缩的时间线快照（at=折叠边界索引，folded=本折叠条数，summary=当时的累计摘要）→ 历史里每张常驻卡片 */
  contextSummaries?: Array<{ at: number; folded: number; summary: string }>
}

interface WorkspaceView {
  id: string
  name: string
  sessions: SessionView[]
}

// ============================================================================
// OpenAI 兼容 LLM stream function（方案 A：pi-ai 官方 openai-completions 适配器）
// 手写 fetch/SSE 层已退役——role:"tool" 回执、signal 贯穿、重试、usage 映射全部白拿官方实现
// ============================================================================

// 本地服务（ollama 等）无 Key 时给适配器的占位 token（适配器要求非空）
const LOCAL_API_KEY_PLACEHOLDER = 'unused'

/** 设置更新工具（AI 根据用户要求修改设置：更新名字/头像/性格提示词等） */
function buildSettingsUpdateTool(_sessionId: string): AgentTool<any> {
  return {
    name: 'settings_update',
    label: '更新设置',
    description: '更新全局设置（用户名字、AI 名字、头像、性格提示词等）。在用户明确要求修改设置时调用（如"以后叫我老牛"、"把你的名字改成大马"）。设置是权威信息源，聊天中的临时称呼不应覆盖设置。',
    parameters: Type.Object({
      userName: Type.Optional(Type.String({ description: '用户的新名字（设置通用页）' })),
      nisName: Type.Optional(Type.String({ description: 'AI 的新名字（设置人格页）' })),
      prompt: Type.Optional(Type.String({ description: 'AI 性格/说话方式的新提示词（设置人格页）' })),
    }),
    async execute(_callId, params: any) {
      const patch: any = {}
      if (typeof params.userName === 'string' && params.userName.trim()) patch.userName = params.userName.trim()
      if (typeof params.nisName === 'string' && params.nisName.trim()) patch.nisName = params.nisName.trim()
      if (typeof params.prompt === 'string' && params.prompt.trim()) patch.prompt = params.prompt.trim()
      if (Object.keys(patch).length === 0) throw new Error('没有需要更新的设置')
      const allowed = ['userName', 'nisName', 'prompt']
      for (const key of Object.keys(patch)) {
        if (allowed.includes(key)) globalSettings[key] = patch[key]
      }
      bumpSettingsVersion()
      persistSettings()
      const changed = Object.keys(patch).join('、')
      broadcastHost({ type: 'host/settings-updated', settings: JSON.parse(JSON.stringify(globalSettings)) })
      return {
        content: [{ type: 'text', text: `已更新设置：${changed}` }],
        details: { updated: Object.keys(patch) },
      }
    },
  }
}

/* ── D2 供应商级网络代理：给用了 proxyUrl 的供应商注入 undici ProxyAgent fetch，
 *    其余供应商走默认直连（不传 fetch → SDK 用全局 fetch，行为零变化）。ProxyAgent 按 url 复用。 ── */
const proxyAgents = new Map<string, ProxyAgent>()
function getProxyAgent(url: string): ProxyAgent {
  let a = proxyAgents.get(url)
  if (!a) { a = new ProxyAgent(url); proxyAgents.set(url, a) }
  return a
}
function makeProxiedFetch(url: string) {
  const dispatcher = getProxyAgent(url)
  return (input: any, init: any = {}) => undiciFetch(input, { ...init, dispatcher })
}

/* ── LLM 调用重试（模型异常/网络瞬断）：建立阶段失败才重试，退避可被 abort 中断；
 *    通过 session/projection(key=llm-retry) 通知前端渲染"重试过程块"（过程态动画 + 恢复/失败态 icon）。
 *    仅在尚未向 agent 流出任何内容（未 start）时重试，避免中途断流重发导致文本重复。── */
const LLM_MAX_RETRIES = 5            // 0908十（用户拍板）：正常 1 次 + 最多重试 5 次，5 次全失败即终止
// 0908十：阶梯退避（用户指定）=第 n 次重试前等待 LADDER[n-1]：5s/10s/30s/60s/120s
const LLM_RETRY_LADDER_MS = [5000, 10000, 30000, 60000, 120000]
type RetryPhase = 'retry' | 'recovered' | 'failed'
function emitLlmRetry(sessionId: string, phase: RetryPhase, attempt: number, maxRetries: number, reason?: string, delayMs?: number): void {
  try {
    broadcastMux(sessionId, {
      type: 'session/projection', sessionId, key: 'llm-retry', seq: Date.now(),
      value: { phase, attempt, maxRetries, reason: (reason || '').slice(0, 200), delayMs: delayMs || 0 },
    })
  } catch { /* ignore */ }
}
/** 退避时长（秒）文案：与 sleepBackoff 同一张阶梯表，日志与前端过程块都据此显示"等多少秒" */
function backoffSeconds(attempt: number): number {
  return LLM_RETRY_LADDER_MS[Math.min(Math.max(attempt, 1), LLM_RETRY_LADDER_MS.length) - 1] / 1000
}
async function sleepBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  // 0908十：阶梯退避 5/10/30/60/120s（attempt 从 1 计；越界取末档）
  const ms = LLM_RETRY_LADDER_MS[Math.min(Math.max(attempt, 1), LLM_RETRY_LADDER_MS.length) - 1]
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/** ── 上下文计量体系：纯计算已抽 backend/ctxEstimate.ts（★0926 降负提速 2a-A）──
 *  本函数只是薄包装：取 real=上一轮真实 usage（prompt+cacheRead+cacheWrite）当缩放锚点、把结果写回 s.contextBreakdown；
 *  估算/分桶/明细的纯计算见 computeBreakdownPure（供会话工人共用同一份代码）。
 *  ★0926 B3：0924 的"上下文分桶调试"日志已删（当时自标"核实清楚后可删"；0926 核实无误后删，
 *     省掉每请求一次的全量统计+字符串拼接+日志广播）。要再排查可从 git/备份回捞。
 *  ★ 数值口径与抽出前一字不变（对拍 _verify_ctxext_0926.cjs）。 */
function computeContextBreakdown(sessionId: string, sysText: string, tools: any[], messages: any[]): void {
  try {
    const lu = sessions.get(sessionId)?.lastUsage
    const real = lu ? (lu.promptTokens || 0) + (lu.cacheReadTokens || 0) + (lu.cacheWriteTokens || 0) : 0
    const s = sessions.get(sessionId)
    if (s) s.contextBreakdown = computeBreakdownPure(sysText, tools, messages, real)
  } catch { /* 明细估算失败不影响请求 */ }
}

/* ══ 上下文压缩（C3）：请求期非破坏式——只压缩"发给模型的那份 payload"，transcript/session.messages/显示全量保留。
 *    达阈值（真实完整上下文 token ≥ 窗口×阈值）时：把最早的整轮摘要成一条前缀消息，并（可选）把全量对话导出
 *    工作区 transcript.md（模型可按需 fs_read 回读长线细节）。压缩视图幂等派生（持久化 summary + 起始索引）。 ══ */
/** 0921：`resolveContextWindow` 已上移到 providers.ts（与 resolveMaxOutput 同款「唯一解析口」），
 *  本文件改为 import 使用 —— 窗口/输入上限/输出上限三处从此共用一套口径，不再各算各的。 ══ */

/* ══ 0921 真修复：上下文预算（窗口 / 输入上限 / 输出上限 一套口径） ══
 * 事故（安装版日志原文，实测）：网关按 **"输入 + 输出预留 ≤ 窗口"** 判 ——
 *   `max context length is 1048576. However, you requested 1049171 tokens
 *    (655955 in the messages, 393216 in the completion)` → 只超 595 token 就硬失败。
 * 三个根因（都已在本轮修掉）：
 *   ① 每轮无条件发 models.dev 的 limit.output（本机 393,216），等于把窗口 38% 白送给"输出预留"；
 *      输入一超过 `窗口 − 393K` 就必炸 —— 这条线（本机 60.6 万）比压缩触发线（70 万）还靠前。
 *   ② 估算只认 NIS 自己的块名，导入会话（anthropic 块名）少算 28.8 倍 → 压缩判断看 2%，永远不触发。
 *   ③ 400 被当"可重试"，5/10/30/60/120 秒白等 5 轮，参数一字未变。
 * 现在的口径：**估算 → 用真实 usage 校准 → 留安全垫 → 得出这次能要多少输出**（放不下就少要）。 */
const CTX_SEND_MARGIN = 512           // 固定安全垫（token）：估算尾差 + 网关自己的附加计数
/* ★ 0923：输出下限 —— 输入吃满窗口时也要留"能说完一句话"的量。
   旧写法 `room <= 256 ? 256 : ...` 在"剩余窗口为负"时只发 256 token，
   实测后果：模型回复被 max_tokens 掐断（stopReason=length），整轮白干。 */
const CTX_SEND_MIN_OUTPUT = 4096
/* ★ 0923：校准锚点的**量级合理性上限**。real/estimate 超过它 → 判定"锚点与估算不可比"
   （典型：压缩折叠早期消息让 estimate 骤降，而锚点还是压缩前的大值 ⇒ 比值被放大到 2~4 倍，
   estCalibrated 虚高成几百万、剩余窗口为负 → sendOutput 掉到 256 → 回复被截断）。
   实测最坏真实低估约 1.4 倍，2.0 已留足余量。 */
const CTX_EST_SANE_MAX = 2
/** ★ 0923：输出预留的"独立天花板"占窗口比例 —— Roo Code 同款规则
 *  （Clamp default model max tokens to 20% of context window）。
 *  为什么必须有：① models.dev 是跨供应商聚合，可能虚高（opencommand 实测被路由商标到 943718，
 *  而网关硬上限 393216 → 400「Invalid max_tokens value」）；② "剩余窗口越大越敢要"，
 *  上下文被压缩后反而更容易越线；③ 主流 agent 的输出预留只有 min(模型上限, 20000)。 */
const CTX_OUTPUT_CAP_PCT = 0.20
/** 天花板下限（小窗口也得留够写代码的量；窗口侧安全仍由 room 兜底） */
const CTX_OUTPUT_CAP_MIN = 8192
/** ★ 0923：网关实测的输出上限（从 400 原文里学到的，如 "[1, 393216]"）——进程级缓存。
 *  为什么必须"记住"：一次性纠偏会被反复重撞（hermes-agent 的公开教训 —— 每轮 tool-loop
 *  都重新失败、重新压缩 1~3 分钟）；学到值后，后续请求第一发就用它钳住。 */
const observedMaxOutput = new Map<string, number>()
const outputCapKey = (providerId: string, modelId: string) => `${providerId}::${modelId}`
const CTX_EST_FALLBACK_RATIO = 1.4     // 没有可校准锚点（首轮 / 重启后第一轮）时的保守系数：
                                       // 取实测最坏值量级（导入类会话 char/2.2 低估到 1.41 倍）。
                                       // 代价只是"重启后第一轮"的输出上限低一点（正常回复几千 token，碰不到），
                                       // 换来的是**首轮也不会撞 400**。
const CTX_EST_MAX_RATIO = 4           // 校准系数上限：防一次脏数据把预算算崩
/** 本会话的估算校准系数 = 真实 / 估算。
 *  取"上一轮"：我们发上一轮时存下了估算值（session.lastPromptEstimate），供应商回报的真实 input
 *  在 session.lastUsage —— 相邻两轮内容构成最接近，比值最准（实测导入类会话 char/2.2 低估到 1.41 倍，
 *  普通会话接近 1.0；写死一个倍数必然两头不讨好：小了挡不住 400，大了白缩输出）。 */
function ctxCalibrationRatio(s: any): { ratio: number; estimate: number; real: number } {
  const estimate = Number(s?.lastPromptEstimate) || 0
  const lu = s?.lastUsage
  const realUsage = lu ? (Number(lu.promptTokens) || 0) + (Number(lu.cacheReadTokens) || 0) + (Number(lu.cacheWriteTokens) || 0) : 0
  /* ★ 0923 护栏（实测：58% 就触发压缩 / 回复被 256 token 截断）：
     锚点必须与"当轮估算"**同量级可比** —— 压缩会把早期消息折起来，本轮的估算随之骤降，
     而锚点（上一轮 usage / 撞线实报）往往还是压缩前的大值：real/estimate 被放大到 2~4 倍，
     estCalibrated 虚高（实测 2,998,500）、剩余窗口算成负数 → sendOutput 保底 256 → 回复被截断。
     判据：比值落在 [0.4, CTX_EST_SANE_MAX] 才采信；否则视为不可比，退回保守系数。 */
  const comparable = (real: number, est: number): boolean => {
    if (!(real > 0) || !(est > 0)) return false
    const r = real / est
    return r >= 0.4 && r <= CTX_EST_SANE_MAX
  }
  // ① 最硬：上一次请求直接撞了上下文 400，错误里那对数字是供应商自己数的
  //    （`... 655955 in the messages, 393216 in the completion`）—— 比任何本地估算都准。
  //    只在"撞线后、下一次成功之前"有效（成功轮会清掉，见 handleAgentEvent）。
  const ovfReal = Number(s?.ctxOverflowRealInput) || 0
  const ovfEst = Number(s?.ctxOverflowEstimate) || 0
  if (comparable(ovfReal, ovfEst)) {
    return { ratio: Math.min(CTX_EST_MAX_RATIO, Math.max(1, ovfReal / ovfEst)), estimate: ovfEst, real: ovfReal }
  }
  // ② 常规：上一轮成功请求的 真实 usage ÷ 我们当时的估算
  if (comparable(realUsage, estimate)) {
    return { ratio: Math.min(CTX_EST_MAX_RATIO, Math.max(1, realUsage / estimate)), estimate, real: realUsage }
  }
  // ③ 无可用锚点（首轮 / 刚重启 / 锚点不可比）：保守系数兜底
  return { ratio: CTX_EST_FALLBACK_RATIO, estimate, real: realUsage }
}
/** ★ 0923（已定案 A 方案）：当前会话的**真实占用**（与界面圆环 / session.context 同源）。
 *  为什么需要它：压缩触发判定原先用"估算 × 校准系数"这个**悲观预测**，实测把界面显示的 58%
 *  预测成 104 万 ⇒ 用户设 70% 却在显示 58% 时就压缩，滑块失去意义。
 *  口径：优先上一轮真实 usage（prompt + cacheRead + cacheWrite）；没有（首轮/刚重启）时
 *  退回"估算 × 校准"（此时显示与判定仍同源）。
 *  安全性不再依赖"提前压缩"，而是三层护栏：输出天花板 + 动态让位 + 400 自动纠偏。 */
function ctxUsedTokens(s: any): number {
  /* ★ 0923（P0 修 · 判定锚点）：**压缩后锚点优先** —— 刚压完、新 usage 还没回来的那段时间里，
     必须用"压缩后视图"的估算值来判定，否则整个 turn 都会拿压缩前的大 usage 反复判超线
     （实测事故：真值 28% 被反复判成 88%，每完成一次工具调用就白压一次）。
     锚点在收到新 usage 时撤销（见 agent_end 处 delete session.ctxUsedOverride）。 */
  const ov = s?.ctxUsedOverride
  if (ov && Number(ov.tokens) > 0) return Number(ov.tokens)
  const lu = s?.lastUsage
  const real = lu ? (Number(lu.promptTokens) || 0) + (Number(lu.cacheReadTokens) || 0) + (Number(lu.cacheWriteTokens) || 0) : 0
  if (real > 0) return real
  const est = Number(s?.lastPromptEstimate) || 0
  if (est > 0) return Math.round(est * ctxCalibrationRatio(s).ratio)
  return 0
}
/** 「不缩水死亡线」：假设输出预留**一点不让位**（就发 models.dev 那个上限）时，输入超过它就会 400。
 *  本机：1,000,000 − 393,216 − 512 ≈ 60.6 万。
 *  0921 修正：它**不再参与压缩触发线的计算**（那会把滑块废掉），只用于日志/诊断——
 *  真正的护栏是 computeSendBudget（输出预留动态让位），所以它只是"如果什么都不做会在哪儿炸"的参考值。 */
function ctxDeathLineTokens(providerId: string, modelId: string): number {
  const win = resolveContextWindow(providerId, modelId)
  return Math.max(1024, win - resolveMaxOutput(providerId, modelId) - CTX_SEND_MARGIN)
}
/** 压缩触发线 = **窗口 × 用户滑块百分比**（30~95 全区间直接生效，语义就是"窗口用到多少才压缩"）。
 *  0921 修正：原来我把这条线又 min 了"死亡线×90%"，结果 55%~95% 全被切平成同一个值
 *  （等于把滑块废了）—— 用户的原话是"区间内用户自己把控就是"，所以这里只认滑块。
 *  安全性不再靠提前压缩，而是靠**发送预算**（见 computeSendBudget）：输入占得多，输出预留就自动让位，
 *  所以 95% 也不会撞 "maximum context length"。模型级显式填了 maxInput 时取更小者（那也是用户自己填的）。 */
function ctxTriggerLineTokens(providerId: string, modelId: string, trigPct: number): number {
  const win = resolveContextWindow(providerId, modelId)
  const inputCap = resolveMaxInput(providerId, modelId)
  const line = win * (Math.min(95, Math.max(30, trigPct)) / 100)
  return Math.max(1024, inputCap > 0 ? Math.min(line, inputCap) : line)
}
/* ★ 0921n / 1012g：工具结果裁剪参数 —— 只留"首 30 行 + 省略提示 + 尾 30 行"。
   ★1012g（与轮次无关的统一规则，两轮实测教训换来的）：
     旧版是"最近 2 轮原样 + 更早的裁"= **滑动窗口** ⇒ 每轮都有一格从"原样"变"被裁" ⇒ 改写点
     之后的前缀全失效（全库实测轮首跳只有 83.2%、每轮白丢 2.8~5 万 token）。
     1012e 试过"只在冷轮裁"⇒ 当天被证伪（热轮不裁会**积攒**，冷轮一次性裁掉好几轮 = 改写点跑到
     很前面，实测冷轮首跳只剩 3.5%）。
     现在**去掉轮次维度**：同一份工具输出，无论它在第几轮、无论被裁几次，都裁成**同一文本**
     （纯字符规则，参数里没有轮次）⇒ 一旦裁过就永不再变 ⇒ 热轮根本不会被改写。
     代价：最新轮的超长输出也只留首尾，模型要看细节就按提示里的路径 fs_read 回看。
     dsh 的 tool-result-pruner 是同款思路（写入时决定、append-only），见档案 1012f。 */
const CTX_TOOL_KEEP_TURNS = 2      /* ← 现在**只**用于"图片/思考块保留最近几轮"（见函数内注释） */
const CTX_PRUNE_MIN_CHARS = 4000   /* 工具结果短于此一律不动（门槛高于旧版 800，因为最新轮也裁） */
const CTX_PRUNE_BIG_CHARS = 24000  /* 超大输出按字符裁到头 40% + 尾 60%（比首尾 30 行更狠） */
/* ★1012i：spill 的实现已移到**共享模块** `spillStore.ts`（server.ts 与 tools.ts 都要用）——
   工具层截断时也必须落盘，否则"工具层先砍掉的那 95%"谁也救不回来
   （1012h 实测：84,000 字符的输出在工具层被 tail(4000) 砍掉，spill 只捡到 4,034 字符的残渣）。
   详见该文件头部注释。 */
/* ★1012g：常量 CTX_PRUNE_COLD_MS / 判据 _coldForPrune 已**删除** —— 1012e 的"按时间挑冷轮裁"
   是错的路子（见上方 CTX_TOOL_KEEP_TURNS 注释里的两轮实测）。裁剪现在与时间、轮次都无关。 */
const CTX_TOOL_HEAD_LINES = 30
const CTX_TOOL_TAIL_LINES = 30
/* ★ 0923（P1 剪枝加码，学 dsh 的 tool-result-pruner）：
   旧版只按"行数"判断是否裁剪 → **单行巨长内容永远漏网**（minified JSON/JS、无换行日志、base64），
   实测这是"上下文只涨不降"的一大来源。现在补三条口径： */
const CTX_TEXT_HARD_CLIP = 4000   // 工具结果：单行/少行但超过这个长度 → 按字符裁（首尾各留 EDGE）
const CTX_TEXT_EDGE_CHARS = 1500  // 按字符裁时首尾各保留多少字符
/* ★1012j：`CTX_THINK_FOLD_MIN`（思考块折叠档位，原 1500 字符）已**删除** —— 思考块现在永不折叠，
   原因见 pruneToolOutputs 里 thinking 分支的注释（折叠会每 2 轮白丢 3~5 万 token 未命中，
   而保留只花命中价；未命中价 ≈ 命中价的 4 倍）。要恢复折叠时把档位加回来即可。 */
const CTX_ASSIST_TEXT_MIN = 8000  // assistant 正文：超过这个长度才裁（正文含结论，阈值放宽）
/** ★ 0921o：对话存档的字符上限（超过后较长的工具结果会按行截断）≈ 12MB 文本 */
const CTX_ARCHIVE_MAX_CHARS = 12 * 1024 * 1024

/** ★1012k：请求指纹探针 —— **每跳记一行** system / tools / messages(分 10 段) 的 sha1 指纹。
    背景（1012j 实测 + 用户洞察）：**每次重启后第一轮固定丢约 4.6 万 token**（46,275 / 46,661
    两次几乎一模一样），而用户最近的习惯正是"重启一次聊一句"⇒ 每轮都在付这笔。
    形态：轮 27 首跳 = 全量 273,989 中**前 227,328 命中、之后全废** —— 说明失效点在"历史的后段"，
    不是 system/tools 全废。怀疑重启时"重新组装 system+tools / 从 transcript 重建 messages"的文本
    与重启前不完全一致。这一行把三段分别 hash 出来，**重启前后一对比就知道是哪一段、从第几条消息
    开始变的**，不用再靠推断。
    成本：一行日志/跳（约 200 字符）；失败绝不影响请求（整段 try 包住）。 */
let _fpSeq = 0
function logRequestFingerprint(sessionId: string, messages: any[]): void {
  try {
    _fpSeq++
    /* 只记本进程的前 100 跳：足够覆盖"重启后第一轮"（对比需要的就是**每次启动后那几跳**的指纹），
       又不会长期刷日志。 */
    if (_fpSeq > 100) return
    const h = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)
    const list = Array.isArray(messages) ? messages : []
    const ag = agents.get(sessionId) as any
    const sys = String(ag?.state.systemPrompt || '')
    const toolsTxt = JSON.stringify(ag?.state.tools || [])
    const segLen = Math.max(1, Math.ceil(list.length / 10))
    const segs: string[] = []
    for (let k = 0; k < list.length; k += segLen) segs.push(h(JSON.stringify(list.slice(k, k + segLen))))
    sessionLog(sessionId, 'info', 'llm',
      `[请求指纹#${_fpSeq}] sys=${h(sys)}/${sys.length} tools=${h(toolsTxt)}/${toolsTxt.length} msgs=${list.length}条 段=[${segs.join(' ')}]`)
  } catch { /* 探针失败绝不影响请求 */ }
}

/** ★ 0921n / 1012g：工具结果裁剪（**发送时视图**，不改存储、不改界面显示）——
 *  动机：长会话里工具输出（日志/文件内容/命令回显）常占一半以上，整段折进摘要太浪费；
 *        业界标配（Codex 的 TruncationPolicy / dsh 的 tool-result-pruner）。
 *  做法（1012g 起）：**与轮次无关的统一规则** —— 任何 toolResult 超门槛就只留"首 N 行 + 省略提示 + 尾 N 行"，
 *        不论它在第几轮（详见 CTX_PRUNE_MIN_CHARS 上方注释）。关键是**幂等**：
 *        同一份输出在第几轮、被裁几次，结果都逐字节相同 ⇒ 历史一旦裁过就永不再变 ⇒ 前缀缓存永不打散。
 *  只按轮次区分的仅剩两类（它们不能统一处理）：**图片**（模型当轮要看原图）与**思考块**（当轮推理链）。
 *  原文没丢：会话里存着，工作区 transcripts/transcript.md 也有全量存档（模型可 fs_read 回看）。 */
function pruneToolOutputs(
  messages: any[],
  opts?: { imageKeepRecentTurns?: number; headLines?: number; tailLines?: number },
): { messages: any[]; changed: number; savedChars: number } {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return { messages: list, changed: 0, savedChars: 0 }
  const headLines = Math.max(1, Number(opts?.headLines) || CTX_TOOL_HEAD_LINES)
  const tailLines = Math.max(1, Number(opts?.tailLines) || CTX_TOOL_TAIL_LINES)
  const roundStarts: number[] = []
  list.forEach((m, i) => { if (m?.role === 'user') roundStarts.push(i) })
  /* keepFrom 现在**只**服务"图片 / 思考块保留最近 N 轮"；工具结果与轮次无关 */
  const imgKeep = Math.max(0, Number(opts?.imageKeepRecentTurns ?? CTX_TOOL_KEEP_TURNS) || 0)
  const keepFrom = roundStarts.length > imgKeep
    ? roundStarts[roundStarts.length - imgKeep]
    : 0
  let changed = 0
  let savedChars = 0
  /* ★ 0923（P1）：minChars 按内容类型给门槛（工具结果 800 / assistant 正文 8000），
     并区分两条裁剪路径 —— 多行按"首尾 N 行"，**单行巨长按字符**（后者是旧版的漏网之鱼）。 */
  const clip = (text: string, minChars: number): string | null => {
    const t = String(text || '')
    if (t.length < minChars) return null
    /* ★1012g/1012h 幂等硬护栏（自检两次抓出来的）：**已裁过的文本一律不再动**。
       没有这道护栏会连环裁：多行档（首尾 30 行）裁完可能仍 >4000 字符/少行 → 又落进字符档 → …
       历史上就会连续几轮都在变（spill 上线后文本更长，更容易撞上这道坎）。
       ⚠️ 判据必须覆盖**所有档位**的提示语：多行档/单行档是"…（此处省略"，超大档历史上写过
       "…（本轮工具输出过大" / "…（工具输出过大"（现统一为"…（此处省略"），工具层 tools.ts 在
       1012i 之前写的是"…（中间省略"（同样必须认——否则升级那一刻会把历史里所有旧命令输出重裁一遍，
       凭空白付一次全量改写）。只认"已省略"是不够的——1012h 自检就是靠这个用例抓出来的。 */
    if (t.indexOf('…（此处省略') >= 0 || t.indexOf('…（工具输出过大') >= 0 || t.indexOf('…（本轮工具输出过大') >= 0
      || t.indexOf('…（中间省略') >= 0) return null
    /* ★1012h/1012i：要被裁的文本由 omitNotice() **完整落盘**并给出确切取回路径
       （路径 = 内容 sha1 ⇒ 同一份输出永远同一文案；确定性 = 幂等，前缀缓存不打散）。 */
    const rows = t.split('\n')
    if (rows.length > headLines + tailLines + 5) {
      const omitted = rows.length - headLines - tailLines
      const head = rows.slice(0, headLines).join('\n')
      const tail = rows.slice(-tailLines).join('\n')
      savedChars += t.length - (head.length + tail.length)
      return head + omitNotice(t, '此处省略 ' + omitted + ' 行（原文共 ' + rows.length + ' 行 / ' + t.length + ' 字符）') + tail
    }
    /* ★1012g：**超大输出先走"更狠"的字符档**（不论行数）—— 学 dsh 的 tool-result-pruner
       （它 >8192 字符就砍成头 4096 + 标记 + 尾 1024）。让巨型输出无论在第几轮都只剩固定头尾。 */
    if (t.length > CTX_PRUNE_BIG_CHARS) {
      /* ★1012g 幂等护栏：裁完必须**严格短于门槛**，否则下轮又满足条件（自检实测：直接裁到
         24000 会得到 24071 字符 > 24000 → 每轮都变）。这里留 512 字符给提示语。 */
      const budget = Math.max(1000, CTX_PRUNE_BIG_CHARS - 512)
      const headLen = Math.floor(budget * 0.4)
      const tailLen = budget - headLen
      const h = t.slice(0, headLen)
      const tl = t.slice(-tailLen)
      savedChars += t.length - (h.length + tl.length)
      return h + omitNotice(t, `此处省略 ${t.length - h.length - tl.length} 字（输出过大，原文共 ${t.length} 字符）`) + tl
    }
    /* ★ 0923：单行/少行但超长（minified JSON、无换行日志、base64）→ 按字符裁。
       旧版在这里直接 return null，导致这类内容永远不裁、只涨不降。 */
    if (t.length <= CTX_TEXT_HARD_CLIP) return null
    const head = t.slice(0, CTX_TEXT_EDGE_CHARS)
    const tail = t.slice(-CTX_TEXT_EDGE_CHARS)
    savedChars += t.length - (head.length + tail.length)
    return head + omitNotice(t, `此处省略 ${t.length - head.length - tail.length} 字（单行超长内容，原文共 ${t.length} 字符）`) + tail
  }
  /* ★1012g：原来这里有一整块"最近 keepRecentTurns 轮的**体积兜底**"（recentHardCapChars 那条路径）——
     它和"更早轮次裁剪"合起来就是**滑动窗口**，正是每轮改写历史、打散前缀缓存的根源。
     现在所有轮次统一走同一套纯字符规则（门槛见 CTX_PRUNE_MIN_CHARS / CTX_PRUNE_BIG_CHARS），
     唯一还按轮次区分的只剩"图片与思考块保留最近几轮"（见下方 keepFrom 的用法）。 */
  const out = list.map((m, i) => {
    const role = m?.role
    /* ① 纯字符串 content（旧格式工具结果）—— 只有工具结果才裁，user 原话不动 */
    if (typeof m.content === 'string') {
      if (role !== 'tool' && role !== 'toolResult') return m
      const c = clip(m.content, CTX_PRUNE_MIN_CHARS)
      if (!c) return m
      changed += 1
      return { ...m, content: c }
    }
    if (!Array.isArray(m.content)) return m
    /* ② 块数组：工具结果裁剪 + 早期图片占位 + 早期思考折叠（覆盖所有角色；user 文本仍不动） */
    let touched = false
    const content = m.content.map((b: any) => {
      if (!b) return b
      /* ②-a 图片占位（P1 · 学 dsh 的 image-offload）：早期轮次的截图/附件 → 一行文本。
         图片不参与任何文本裁剪，而且 base64 会让请求体膨胀；保留最近 N 轮的图，更早的换占位。
         原图仍在会话记录与工作区存档里 —— 需要时可以重发或从存档回看。 */
      if (b.type === 'image') {
        /* ★1012g：图片**不**统一折（模型当轮要看原图）—— 仍按"最近 N 轮"保留 */
        if (i >= keepFrom) return b
        const n = Number((b.data || '').length)
        savedChars += n
        touched = true
        return { type: 'text', text: `（图片已省略：更早轮次的截图/附件，约 ${Math.round(n / 1024)} KB；需要时请让我重新读取，或从会话存档回看）` }
      }
      /* ②-b 思考折叠（P1）：早期轮次的 reasoning/thinking → 一行占位。
         ★ 带 signature/redacted 的思考块（Anthropic 系）**绝不折叠** —— 那是协议契约，动了会 400；
         只折纯文本思考（OpenAI 兼容系）。 */
      if (b.type === 'thinking' || b.type === 'reasoning') {
        /* ★1012j：**永不折叠**（原实现是"最近 2 轮保留、更早的折成一行"= 滑动窗口 ⇒ 残余的每轮税源）。
           实测（本会话轮 26，热轮、距上轮仅 24 秒）：首跳命中仅 82.6%、丢 46,275 token ——
           改写点正好落在"两轮前那批思考块"上，一折就把后面 3~5 万 token 全部重算。
           为什么"永不折"反而更便宜：折叠的代价是**未命中价 × 改写点之后的全量**（一次 3~5 万 token），
           而保留的代价只是**命中价 × 思考块自身体积**（每轮几千 token）；未命中价 ≈ 命中价的 4 倍
           ⇒ 保留更划算。体积交给压缩机制兜底（压缩是低频一次性、且本来就全价）。
           （带 signature / redacted 的思考块本来就绝不折 —— 那是 Anthropic 协议契约，动了会 400。） */
        return b
      }
      /* ②-c 文本块：工具结果按工具门槛；assistant 正文只在超长时裁；user 原话一律不动 */
      if (b.type === 'text' && typeof b.text === 'string') {
        if (role === 'user') return b
        const c = clip(b.text, role === 'assistant' ? CTX_ASSIST_TEXT_MIN : CTX_PRUNE_MIN_CHARS)
        if (c) { touched = true; return { ...b, text: c } }
      }
      return b
    })
    if (!touched) return m
    changed += 1
    return { ...m, content }
  })
  return { messages: out, changed, savedChars }
}

/** 发送预算：算清"这次要发的 max_tokens"。
 *  输入放得下就按用户/官方的输出上限要；放不下就少要 —— 绝不发一个注定被拒的请求。
 *  maxInput（用户填的输入上限）不在这里缩输出：它的语义是"输入超过就该压缩"，见 ctxTriggerLineTokens。 */
function computeSendBudget(providerId: string, modelId: string, sysText: string, tools: any[], messages: any[], s: any): {
  win: number; estimate: number; ratio: number; estCalibrated: number; wantOutput: number; sendOutput: number; outCap: number
} {
  const win = resolveContextWindow(providerId, modelId)
  const estimate = estimateRequestTokens(sysText, tools, messages)
  const { ratio } = ctxCalibrationRatio(s)
  /* ★ 0923：校准后的估算**钳到窗口** —— 锚点异常时也不会算出几百万这种荒唐值（双保险） */
  const estCalibrated = Math.min(win, Math.round(estimate * ratio))
  const wantOutput = resolveMaxOutput(providerId, modelId)
  const room = win - estCalibrated - CTX_SEND_MARGIN
  /* ★ 0923：**三层取最小**——①模型声明上限 ②剩余窗口 ③窗口×20% 天花板（含"网关实测值"的二次钳位）。
     只新增第三层，前两层语义不变；日常输出几千~几万 token，根本碰不到天花板，它只在极端情况兜底。 */
  const outCapBase = Math.max(CTX_OUTPUT_CAP_MIN, Math.floor(win * CTX_OUTPUT_CAP_PCT))
  const observed = observedMaxOutput.get(outputCapKey(providerId, modelId)) || 0
  const outCap = observed > 0 ? Math.min(outCapBase, observed) : outCapBase
  /* ★ 0923：下限从 256 提到 CTX_SEND_MIN_OUTPUT（4096）——
     旧写法在"输入吃满窗口"时只给 256，实测把模型回复直接掐断（stopReason=length）。
     宁可让上游按"输入+输出>窗口"报 400（有 _tryCtxFix 纠偏 + 压缩兜底），也不发一个注定说不完话的上限。 */
  const sendOutput = Math.max(CTX_SEND_MIN_OUTPUT, Math.min(wantOutput, Math.max(room, CTX_SEND_MIN_OUTPUT), outCap))
  return { win, estimate, ratio, estCalibrated, wantOutput, sendOutput, outCap }
}
/** ── 0921 错误分类：哪些值得重试、哪些重试一万次也一样 ──
 *  重试值：429 限流 / 5xx 网关抖动 / 网络中断 —— 阶梯退避（5/10/30/60/120 秒）本来就是为它们设计的。
 *  重试无用（立刻失败，别白等 3.7 分钟）：上下文超限、参数非法、鉴权失败、模型不存在等确定性错误
 *  （安装版实测：400「maximum context length」被重试 5 轮，参数一字未变，注定全灭）。 */
function classifyLlmFailure(msg: string): 'retry' | 'fatal' {
  const raw = String(msg || '')
  const s = raw.toLowerCase()
  /* ★ 0928（接中断轮）：先看**开头的 HTTP 状态码前缀**（错误文本格式是 `400: {...}`）——
     这是最可靠的判据，又不会被正文里的 token 数字误伤（正文数字不会"紧跟冒号出现在开头"；
     `429003: xxx` 这种 4 位码也不会命中，因为要求 3 位数字后立刻是冒号）。
     可重试：408 请求超时 / 425 / 429 限流 / 499 / 全部 5xx（网关抖动）；
     确定性（重试无用）：其余 4xx（400 参数/额度/套餐、401/403 鉴权权限、404 模型不存在…）。 */
  const head = /^\s*(\d{3}):/.exec(raw)
  if (head) {
    const code = Number(head[1])
    if (code >= 500 || code === 408 || code === 425 || code === 429 || code === 499) return 'retry'
    if (code >= 400 && code < 500) return 'fatal'
  }
  const fatal = [
    'maximum context length', 'context_length_exceeded', 'context length exceeded', 'reduce the length of the messages',
    'too many tokens', 'prompt is too long', 'max_tokens is too large', 'string too long',
    /* ★ 0928 补（实测踩到）：`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`
       三个关键词都不命中（'invalid request'/'invalid parameter'/'max_tokens is too large' 全对不上）
       ⇒ 被判 retry 白等 225 秒；且 _tryMaxTokensFix 只在 fatal 分支里跑 ⇒ 自愈路径根本不可达。 */
    'invalid max_tokens', 'range of max_tokens', 'max_tokens must',
    'invalid_request_error', 'invalid request', 'invalid parameter', 'unsupported', 'not supported',
    'does not exist', 'no such model', 'model not found', 'unknown model',
    'unauthorized', 'invalid api key', 'incorrect api key', 'permission denied', 'insufficient',
    /* ★ 0928 补（实测踩到，见 27cf2c28 日志 13:55:31~13:57:18）：
       `403 permission_denied_error` + `model is not available in the current token plan` 被判成了 **retry**
       —— 因为列表里只有带空格的 'permission denied'，而下划线写法 `permission_denied` 没匹配上，
       于是白等 5+10+30+60+120 = **225 秒**才失败。这类"套餐/权限"错误重试一万次也一样，必须 fatal。 */
    'permission_denied', 'token plan', 'not available in the current',
  ]
  // 注意：不按裸数字（401/403/404）判 —— 错误文本里全是 token 数（1048576 等），会误伤。
  return fatal.some(k => s.includes(k)) ? 'fatal' : 'retry'
}
/** ★ 0930（实测反馈「不知道为啥不重试」）：把"**这一轮为什么不重试**"讲清楚。
 *  以前只丢一句"确定性错误，重试无用"，用户仍分不清是自己 key 的问题还是模型的问题；
 *  这里点名命中的是哪一类（鉴权/额度/上下文超限/输出上限/模型不存在/参数非法）。 */
function fatalReasonPhrase(msg: string): string {
  const raw = String(msg || '')
  const s = raw.toLowerCase()
  const head = /^\s*(\d{3})\s*:/.exec(raw)
  const code = head ? Number(head[1]) : 0
  const groups: [string, string[]][] = [
    ['鉴权/权限', ['unauthorized', 'invalid api key', 'incorrect api key', 'invalid_api_key', 'authentication', 'permission denied', 'permission_denied']],
    ['额度/套餐', ['insufficient', 'token plan', 'not available in the current', 'quota']],
    ['上下文超限', ['maximum context length', 'context_length_exceeded', 'context length exceeded', 'too many tokens', 'prompt is too long', 'string too long', 'too long']],
    ['输出上限越界', ['invalid max_tokens', 'range of max_tokens', 'max_tokens must', 'max_tokens is too large']],
    ['模型不存在', ['does not exist', 'no such model', 'model not found', 'unknown model']],
    ['参数/接口不支持', ['invalid_request_error', 'invalid request', 'invalid parameter', 'unsupported', 'not supported']],
  ]
  const hit = groups.find(([, kws]) => kws.some(k => s.includes(k)))
  const why = hit ? `命中「${hit[0]}」类错误`
    : (code >= 400 && code < 500 ? `供应商返回 ${code}（4xx 确定性拒绝）` : '命中确定性错误')
  return `未重试：${why} —— 同一份请求原样重发结果一样，得先改配置 / 等额度恢复`
}

/** ── 0928 错误人话化：把报错翻译成**按类型给建议**的人话（覆盖全部常见状态码/错误类型） ──
 *  起因（实测）：上下文才 2% 也弹 400，真因是供应商**额度/余额不足**
 *  （原文 `insufficient credits ... purchase more credits`），却被通用模板写成
 *  "如上下文超限…"，把排查方向直接带偏（以为上下文饱满了）。
 *  ★ 400 是个"万能筐"，至少 6 种触发方式（只能按正文细分，不能按状态码）：
 *  ①额度/余额 ②套餐不含该模型 ③鉴权 ④模型不存在 ⑤内容安全拦截 ⑥输入/上下文超限
 *  ⑦输出上限 max_tokens 越界 ⑧其他参数非法。其余：401/402/403/404/413/422 各归各，
 *  429 限流 / 5xx 网关抖动 / 网络中断（terminated、ECONNRESET…）走"重试后"口径。
 *  识别顺序：先专后通（额度 → 套餐 → 鉴权 → 模型 → 内容 → 输入 → 输出 → 参数 → 限流 → 网关 → 网络），
 *  前面命中就不看后面（如 403 token plan 不会先被"模型不存在"抢走）。
 *  mode='fatal'（确定性错误，重试无用直接停）/ 'exhausted'（已重试多轮仍未恢复）——
 *  只影响兜底与结尾口径。返回 { short, full }：short = 给用户看的一句话（≤60 字）；
 *  full = short + 具体怎么办（进日志 / 给模型看 / 详情里可展开）。 */
type ErrHint = { short: string; full: string }
/** ★ 0930（实测反馈「报错不显示 40 几、只有人话」）：从错误原文里抠**真实 HTTP 状态码**。
 *  绝不按裸数字判 —— 错误正文里全是 token 数（1048576 / 393216…），裸数字必然误伤
 *  （与 classifyLlmFailure 里那句老规矩同源，这里是它的加强版：老规矩只认开头的 `401:`）。
 *  这里认四种**带上下文**的写法，覆盖各网关/SDK 的实际格式：
 *    ① `401: {...}`（pi-ai 当前格式） ② `{"status":401}` / `status_code=401` 这类键值
 *    ③ `HTTP 401` / `HTTP/1.1 401`  ④ `401 Unauthorized`（码+英文状态名，天然带上下文） */
function extractHttpCode(msg: string): number {
  const raw = String(msg || '')
  const pats = [
    /^\s*(\d{3})\s*:/,                                                                // ① "401: {...}"（pi-ai 当前格式）
    /"?(?:status|status_?code|error_?code|code)"?\s*[:=]\s*"?(4\d\d|5\d\d)"?/i,        // ② {"status":401} / error_code=429
    /\b(?:status|status_?code|error_?code)\b\s*[:=]?\s*"?\b(4\d\d|5\d\d)\b/i,           // ③ "status 401"（**空格**分隔；SDK 变体，实测漏过）
    /\bHTTP[\s/]?(4\d\d|5\d\d)\b/i,                                                     // ④ HTTP/1.1 401
    /\b(4\d\d|5\d\d)\b\s*[:\-]?\s*(Unauthorized|Forbidden|Not Found|Bad Request|Payment Required|Too Many Requests|Request Timeout|Internal Server Error|Bad Gateway|Service Unavailable)\b/i, // ⑤ 401 Unauthorized / 401: Unauthorized
  ]
  for (const p of pats) {
    const m = p.exec(raw)
    if (m) { const c = Number(m[1]); if (c >= 400 && c < 600) return c }
  }
  return 0
}
/** ★ 0930：包装层 —— 给 12 类人话**统一**挂上「真实状态码 · 」前缀。
 *  为什么放包装而不是改 12 个分支：分类文案还在长（0928/0929 一直在补词），逐个改必漏；
 *  在出口加一次，新增分类自动带码。**解析不出码就原样返回，绝不编一个码出来。** */
function terminalErrorHint(msg: string, mode: 'fatal' | 'exhausted' = 'fatal'): ErrHint {
  const h = terminalErrorHintBase(msg, mode)
  const code = extractHttpCode(msg)
  if (!(code > 0)) return h
  return { short: `${code} · ${h.short}`, full: `${code} · ${h.full}` }
}
function terminalErrorHintBase(msg: string, mode: 'fatal' | 'exhausted' = 'fatal'): ErrHint {
  const raw = String(msg || '')
  /* ★1004（实测反馈"审批超时停轮却报网络层中断+自动重试 5 轮"）：**主动中止不是网络故障** ——
     审批连续超时停轮/用户点停止走 abort()，LLM 层报 "Request aborted"，旧归类命中网络分支的
     `aborted` 词根 → 谎报"网络层中断（没连上）"还挂"自动重试 5 轮后未恢复"（其实一轮都没重试）。
     主动中止如实说：本轮已被停止，不是网络问题。 */
  if (/\brequest aborted\b|^\[aborted\]|aborted by user|err_canceled|cancell?ed by user/i.test(raw)) {
    return {
      short: '本轮已停止（你点了停止，或审批连续超时自动停轮）：不是网络问题。',
      full: '本轮已停止：**请求被主动中止**（你点了停止、或同一操作审批连续 2 次等不到授权自动停轮）——不是网络故障，无需检查网络。要继续的话重新发送指令即可（若是审批超时：先在卡片上点「允许一次」再发）。',
    }
  }
  const s = raw.toLowerCase()
  const code = Number((/^\s*(\d{3}):/.exec(raw) || [])[1] || 0)
  // ① 额度/余额不足（402 / insufficient credits）
  if (code === 402 || /insufficient\s+(credits?|quota|balance)|quota\s+exceeded|exceeded your (current )?quota|payment required|欠费|余额不足|额度不足|积分不足/.test(s)) {
    return {
      short: '该模型/上游额度不足（与上下文长度无关）——换个模型、换 key 或充值。',
      full: '这一步没跑起来：**该供应商的这条模型/上游额度不足**（insufficient credits / quota exceeded）——'
        + '与上下文长度、输出上限都无关，重试也不会好。'
        + '★ 实测（commandcode.ai）：同 key 下 `xiaomi/mimo-v2.6-pro` 连 3.6K token 的小请求都报这个错，'
        + '而同 key 的 `deepseek/deepseek-v4.1-flash` 当时还能跑（一度像按模型/上游分池）；'
        + '但随后 deepseek 也报同一错，还交替冒出 403「套餐不含该模型」和 429 限流 —— 更像**账户/套餐层面整体出问题**。'
        + '所以：① 先换**同供应商的另一个模型**试试（成本最低）；② 不行就去充值/续费、查套餐状态；③ 或换 API key / 换供应商。',
    }
  }
  // ② 套餐不含该模型 / 没权限（403 permission_denied）
  if (code === 403 || /token plan|permission_denied|permission denied|not available in the current|upgrade your (plan|subscription)|no access to (this )?model|does not have (access|permission)/.test(s)) {
    return {
      short: '这个模型不在你当前套餐里（或没权限）——换模型或升级套餐。',
      full: '这一步没跑起来：**当前套餐/计划不包含这个模型**'
        + '（`model is not available in the current token plan`，403 permission_denied）——确定性错误，重试无用。'
        + '① 在「设置→供应商→模型 ✎」换一个套餐内的模型；② 或去供应商后台升级/续费套餐；③ 或换供应商。',
    }
  }
  // ③ 鉴权失败（401）
  if (code === 401 || /unauthorized|invalid api key|incorrect api key|invalid_api_key|authentication/.test(s)) {
    return {
      short: '供应商鉴权失败：去「设置→供应商」检查 API key。',
      full: '这一步没跑起来：**供应商鉴权失败**（key 无效 / 过期 / 权限不足）。去「设置→供应商」检查该供应商的 API key，'
        + '或确认这个 key 有没有开对应模型的权限。',
    }
  }
  // ④ 模型不存在/已下架/不被支持（404/400 unsupported_model —— 0928 真机 B 场景实测补词）
  if (code === 404 || /model.{0,40}(not found|does not exist|no such|unknown|invalid|is not supported)|model_not_found|no such model|unknown model|unsupported_model|invalid model/.test(s)) {
    return {
      short: '模型 ID 不存在或已下架：去「设置→供应商→模型」核对模型名。',
      full: '这一步没跑起来：**模型不存在 / 已下架**（model not found）——重试无用。'
        + '① 核对模型 ID 拼写（含 `供应商/模型` 前缀）；② 去该供应商模型列表看它是否已下架/改名；③ 换一个可用模型。',
    }
  }
  // ⑤ 内容安全拦截（400 content_filter）
  if (/content[_ -]?(filter|policy|management)|responsibleai|sensitive|violation|inappropriate|flagged|prohibited|违规|敏感|拦截/.test(s)) {
    return {
      short: '这条内容被供应商安全策略拦下：改一下措辞再发，或换模型。',
      full: '这一步没跑起来：**触发了供应商的内容安全策略**（content_filter / policy violation）——'
        + '与技术配置无关，原样重发也不会过。① 改写措辞（尤其去掉攻击/越权/敏感表述）再试；② 或换安全策略更宽松的模型/供应商。',
    }
  }
  // ⑥ 输入/上下文超限（400 / 413）
  if (code === 413 || /maximum context length|context[_ -]?length|context_length_exceeded|prompt is too long|too many tokens|reduce the length of the messages|input is too long|longer than maximum/.test(s)) {
    return {
      short: '输入/上下文超限：压缩或删减历史，或换更大窗口的模型。',
      full: '这一步没跑起来：**输入超过了模型的上下文/输入上限**（确定性错误，重试无用；自动纠偏会先试一次）。'
        + '① 压缩或删减本会话历史（或开新会话）；② 在「设置→供应商→模型 ✎」调小输出上限给输入腾空间；③ 换窗口更大的模型。',
    }
  }
  // ⑦ 输出上限/max_tokens 越界（400）
  if (/max[_ ]?tokens|valid range|completion.{0,30}(too long|exceed)|output.{0,30}(too long|exceed|limit)/.test(s)) {
    return {
      short: '输出上限参数越界：去「设置→供应商→模型 ✎」调小输出上限。',
      full: '这一步没跑起来：**max_tokens/输出上限超出了该模型的合法范围**（确定性错误；自动纠偏会先钳一次再试）。'
        + '① 在「设置→供应商→模型 ✎」把输出上限调进供应商报的合法范围；② 或换输出上限更高的模型/线路。',
    }
  }
  // ⑧ 其他参数非法（400/422 —— 400 万能筐里认不出触发方式的都落这）
  if (code === 422 || code === 400 || /invalid_request|invalid request|invalid parameter|bad request|malformed|missing.{0,20}(parameter|field)/.test(s)) {
    return {
      short: '请求参数被供应商拒了（重试无用）：看原始报错，多为模型配置或会话数据问题。',
      full: '这一步没跑起来：**请求参数非法**（invalid_request / bad request）——参数没变，重试也不会好。'
        + '常见触发：输出上限/上下文等模型配置、会话里有不被支持的内容格式、供应商改了接口口径。'
        + '① 看下面的原始报错定位；② 换个模型试（最快分辨是不是配置问题）；③ 或把这条会话的可疑内容删掉重发。',
    }
  }
  // ⑨ 限流（429 tpm/rpm）
  if (code === 429 || /rate.?limit|too many requests|\btpm\b|\brpm\b|inference exceeds|try again (in|later)|concurrent/.test(s)) {
    return {
      short: '供应商限流了：等一会儿再发、降并发，或找供应商提额。',
      full: `这一步没跑起来：**触发供应商限流**（429 / tpm / rpm limit）——${mode === 'exhausted' ? '自动重试 5 轮（约 4 分钟）后仍未恢复' : '已按确定性错误直接停止'}。`
        + '① 等几十秒到几分钟再发；② 减少并发（别的会话/工人同时在跑也算）；③ 找供应商提额或换线路。',
    }
  }
  // ⑩ 网关/服务端抖动（5xx）
  if (code >= 500 || /bad gateway|service unavailable|internal server error|overloaded|upstream|gateway.{0,20}(error|timeout)/.test(s)) {
    return {
      short: '供应商网关抖动：稍后重发，或换供应商/线路。',
      full: `这一步没跑起来：**供应商服务端/网关故障**（5xx）——${mode === 'exhausted' ? '自动重试 5 轮（约 4 分钟）后仍未恢复' : '已直接停止'}。`
        + '① 稍后重发；② 看该供应商状态页是不是在宕机；③ 换供应商/线路再试。',
    }
  }
  // ⑪ 网络中断
  if (/terminated|etimedout|econnreset|econnrefused|socket hang up|network|fetch failed|dns|timed? ?out|connection (reset|closed|refused)|aborted/.test(s)) {
    return {
      /* ★ 1001（用户问"为什么别的错有 40几、这条没有"）：这类是**网络层中断**，请求压根没拿到
         回包 —— 状态码是服务端才给的东西，这里**客观上不存在**，所以显示不出来。
         旧文案只写"网络层中断"，看着像"漏显示了码"，让人以为是 bug。改成明说"没有状态码 + 为什么"，
         一眼能分清【服务端报错】和【压根没连上】。 */
      short: '无状态码 · 网络中断（连接未建立）：检查网络/代理后重新发送。',
      full: `这一步没跑起来：**网络层中断，本次没有 HTTP 状态码**（连接被掐/超时/域名解析失败——请求没到达服务端，所以没有 40几/5xx 可显示）——${mode === 'exhausted' ? '自动重试 5 轮（约 4 分钟）后仍未恢复' : '已直接停止'}。`
        + '① 检查本机网络/代理/VPN；② 确认供应商域名可达；③ 重发这条消息即可。',
    }
  }
  // ⑫ 兜底（认不出类型）
  return mode === 'exhausted'
    ? {
        short: '请求多轮重试后仍未成功：看原始报错详情，或换模型/稍后再试。',
        full: '这一步没跑起来：**自动重试多轮后仍未成功**，且错误文本不属于已知类型。'
          + '① 看下面的原始报错定位；② 换个模型试（最快分辨是配置问题还是线路问题）；③ 或稍后再发。',
      }
    : {
        short: '本次请求是确定性错误（上下文超限 / 参数非法 / 鉴权失败），重试无用。',
        full: '本次请求是确定性错误（如上下文超限 / 参数非法 / 鉴权失败）——重试无用，已直接停止。'
          + '若是上下文超限：压缩或删减本会话历史，或在「设置→供应商→模型 ✎」调小输出上限。',
      }
}
/** 0921：从 400 原文里抠出供应商**自己报**的三个数（这是最硬的真相，比任何估算都准）。
 *  样本（实测原文）：
 *  `This model's maximum context length is 1048576 tokens. However, you requested 1049171 tokens
 *   (655955 in the messages, 393216 in the completion).`
 *  → { window: 1048576, input: 655955, completion: 393216 }
 *  拿到它就能算出"这次该要多少输出"（窗口 − 实报输入 − 余量），实现一次纠偏重试，而不是原样重试 5 次。 */
function parseContextOverflow(msg: string): { window: number; input: number; completion: number } | null {
  const s = String(msg || '')
  const w = s.match(/maximum context length is\s*(\d+)/i)
  const inp = s.match(/(\d+)\s*in the messages/i)
  const comp = s.match(/(\d+)\s*in the completion/i)
  const req = s.match(/requested\s*(\d+)\s*tokens/i)
  const window = w ? Number(w[1]) : 0
  const input = inp ? Number(inp[1]) : 0
  if (!(window > 0) || !(input > 0)) return null
  return { window, input, completion: comp ? Number(comp[1]) : (req ? Math.max(0, Number(req[1]) - input) : 0) }
}
/** 0923：从 400 原文里抠供应商报的 max_tokens 合法范围。
 *  样本（用户安装版实测，opencommand 网关）：
 *  `Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`
 *  根因：models.dev 聚合把路由商（kilo/openrouter）标的路由级 output 上限混入聚合（buildIndex 已改中位数治本）；
 *  （buildIndex 已改中位数治本）；本函数是兜底自愈——任何未知网关的口径错都能纠偏一次。 */
function parseMaxTokensRange(msg: string): { min: number; max: number } | null {
  const m = String(msg || '').match(/valid range of max_tokens is \[(\d+)\s*,\s*(\d+)\]/i)
  if (!m) return null
  const lo = Number(m[1]), hi = Number(m[2])
  if (!(hi > 0)) return null
  return { min: lo > 0 ? lo : 1, max: hi }
}

/** ★0927（截断体检）：上游"假完成"检测 —— 上游给出 finish_reason=stop（pi 记为 stopReason='stop'），
 *  但正文其实停在半句/未闭合标记上。实据（实测反馈 2eb3636d · 2026/9/26 14:43:01）：
 *  rawStopReason='stop'、output=110 token、正文停在「用户，计时这个 bug **根因链查明白了**，交个底：\n\n**为」。
 *  为什么不按 token 数判：短回复本来就正常（"收到"也算）；这里只用**硬信号** —— 正常收尾的正文
 *  几乎不可能以 `**`、`（`、`[`、`` ` `` 这类"必须跟内容"的符号结尾。
 *  返回命中原因（空串 = 没命中），写进日志让"凭什么判它断了"一目了然。 */
function detectTruncatedTail(msg: any): string {
  try {
    const blocks = Array.isArray(msg?.content) ? msg.content : []
    const t = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b?.text || '')).join('').trimEnd()
    if (t.length < 2) return ''                       // 空/极短回复不在此判（另一类问题，不混判）
    /* ★0927 全库回归（176 会话 / 1397 轮 stop 收尾）实测：只看"奇偶不平衡"有 4/5 误报
       （正文中间夹了单个反引号/星号，回复其实说完了）→ 必须叠加**落点判据**：
       未闭合标记要出现在**尾部 4 字符内**，这才等于"写到标记处断头"（实测反馈案例尾部是「**为」）。 */
    const tail4 = t.slice(-4)
    if (tail4.includes('**') && (t.match(/\*\*/g) || []).length % 2 === 1) return '加粗标记未闭合'
    if (tail4.includes('`') && (t.match(/`/g) || []).length % 2 === 1) return '代码标记未闭合'
    const last = t.slice(-1)
    if ('（([【「『《{'.includes(last)) return '括号未闭合'
    if ('，、,'.includes(last)) return `正文停在「${last}」`   // "：" 不收：引出语（"交个底："）正常收尾也常见
    return ''
  } catch { return '' }
}
/* ★0926 修复：原处此处多出一个 `}`（= parseMaxTokensRange 的收尾被"吞"到了这里，
   导致 detectTruncatedTail 被嵌进它的函数体内、成为块级作用域 ⇒ 模块层调用必然
   ReferenceError: detectTruncatedTail is not defined ⇒ 每轮收尾都被记成 stopReason=error）。
   已把该 `}` 归位到 parseMaxTokensRange 的 return 之后。 */
/** 压缩过程通知：走 llm-retry 同款 projection 通道，phase='compacting'（前端显示"压缩中"）/'done'（显示"—— 上下文已压缩 ——"） */
function emitCompactionNotice(sessionId: string, phase: 'compacting' | 'done' | 'failed'): void {
  try {
    broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'context-compaction', seq: Date.now(), value: { phase } })
  } catch { /* ignore */ }
}
/** 全量对话导出为工作区 markdown（写进独立子目录 transcripts/，每次触发覆盖写=替换旧全文，非破坏保留）。
 *  0908 三批：① 挪进 `transcripts/` 单独文件夹（不污染工作区根）；② 工具结果全量不截断（此前只留 300 字）。
 *  截图已落盘 screenshots/ 且 content 不含 base64，故全量导出体积可控。 */
function writeTranscriptArchive(workDir: string, messages: any[], sessionId?: string): string | null {
  try {
      let totalChars = 0   // ★ 0921o：存档体积累计（超 CTX_ARCHIVE_MAX_CHARS 后开始按行截断工具结果）
    /* ★ 0921n：索引头 —— 让模型（或用户）一眼知道这份存档是什么时候、多少条、怎么用 */
    const lines: string[] = [
      '# 对话存档（上下文压缩自动导出 · 全量）',
      '> 生成时间：' + new Date().toISOString() + '　共 ' + ((messages || []).length) + ' 条消息',
      '> 用途：这是**压缩时点的全量对话**（含工具结果原文）。发给模型的上下文已被压缩/裁剪，',
      '> 需要精确回看早期原文（具体报错、文件路径、代码片段）时，读本文件即可。',
      '',
    ]
    for (const m of messages || []) {
      const role = m?.role
      if (role === 'user') {
        const t = (Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : String(m.content || ''))
        if (t.trim()) { lines.push(`## 用户`); lines.push(t.trim()); lines.push('') }
      } else if (role === 'assistant') {
        const parts: string[] = []
        for (const c of (Array.isArray(m.content) ? m.content : [])) {
          if (c.type === 'text' && c.text) parts.push(c.text)
          else if (c.type === 'toolCall') parts.push(`（调用工具 ${c.name}）`)
        }
        if (parts.length) { lines.push(`## 助手`); lines.push(parts.join('\n').trim()); lines.push('') }
        /* ★2026-10-06 修（后端起不来）：此处曾被误粘一段「★1010h 召回背景」——
           ① 它 await 了 buildExternalContext，但本函数是**同步**的（esbuild 直接报
           "await" can only be used inside an "async" function ⇒ 整个后端起不来）；
           ② 它还引用 prompt / session —— 这两个变量在本函数作用域**根本不存在**。
           ⇒ 判定为错位粘贴，已移除；buildExternalContext 的定义保留在 11156，
              要用就接到正确的位置（发给 codex 的 agentPrompt 构建点）。 */
      } else if (role === 'tool' || role === 'toolResult') {
        let t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
        /* ★ 0921o：体积保护 —— 全量存档在超长会话里可能涨到几十 MB；
           累计超过阈值后，把**较长的工具结果**按行截断（首尾各 30 行，与发送裁剪同参数）。
           注：存档定位仍是"全量真相"，这里只兜住极端体积；完整原文始终在会话记录里。 */
        if (totalChars + t.length > CTX_ARCHIVE_MAX_CHARS && t.length > 2000) {
          const _rows = t.split('\n')
          if (_rows.length > CTX_TOOL_HEAD_LINES + CTX_TOOL_TAIL_LINES + 5) {
            t = _rows.slice(0, CTX_TOOL_HEAD_LINES).join('\n') + `\n…（存档体积超限，此处省略 ${_rows.length - CTX_TOOL_HEAD_LINES - CTX_TOOL_TAIL_LINES} 行）…\n` + _rows.slice(-CTX_TOOL_TAIL_LINES).join('\n')
          }
        }
        totalChars += t.length
        lines.push(`> 工具结果：${t}`, '')
      }
    }
    const dirAbs = path.join(workDir, 'transcripts')
    fs.mkdirSync(dirAbs, { recursive: true })
    /* ★ 0921u（修设计缺陷）：文件名**带会话 id** ——
       原先固定写 `transcript.md` 在工作区目录下，同一工作区里多个会话会**互相覆盖**：
       后压缩的会话把先前的存档盖掉，而摘要提示里还指着这个路径，模型可能读到别的会话的内容（比读到旧内容更糟）。
       现在每个会话一份：transcripts/transcript-<会话id前8位>.md（旧的无 id 文件保留，不影响）。 */
    const relName = sessionId
      ? `transcript-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8)}.md`
      : 'transcript.md'
    fs.writeFileSync(path.join(dirAbs, relName), lines.join('\n'), 'utf-8')
    return `transcripts/${relName}`
  } catch { return null }
}
/* ★ 0923（P2-b · 抄 pi-agent-core 的摘要模板）——8 段结构化检查点 + 增量合并提示词。
   为什么抄它：① 8 段结构与 dsh / Claude Code 同构，模型对这套格式最"上道"；
             ② 有旧摘要时切到 UPDATE 版，明确要求"保留旧信息 + 合并新进展 + In Progress 移入 Done"
                —— 这正是旧版缺的"复压合并"（旧版每次都重写 2000 字，上一轮的结论容易丢）。
   标题刻意保留英文（跨轮一致、模型最熟），正文要求中文，并强制"原样保留路径/函数名/报错/数值"。 */
const CTX_SUMMARY_FORMAT = '## Goal\n[用户想达成什么；多个任务就分条]\n\n## Constraints & Preferences\n- [用户的约束/偏好/要求；没有就写 "(none)"]\n\n## Progress\n### Done\n- [x] [已完成的改动与结论]\n\n### In Progress\n- [ ] [正在进行的事]\n\n### Blocked\n- [阻塞点；没有就不写]\n\n## Key Decisions\n- **[决定]**：[一句话理由]\n\n## Next Steps\n1. [按序写下一步]\n\n## Critical Context\n- [继续工作必须知道的具体信息：文件路径、函数名、报错原文、参数值]\n- [没有就写 "(none)"]\n\n要求：每节保持简短；**必须原样保留**文件路径、函数名、报错原文、数值参数；只输出摘要正文，不要任何评论。'
const CTX_SUMMARY_FIRST = '上面的对话需要压缩成一份"上下文检查点摘要"，供另一个 LLM 接着干同样的活。严格按下面的格式输出：\n\n' + CTX_SUMMARY_FORMAT
const CTX_SUMMARY_UPDATE = '上面是**新的对话内容**，需要和 <previous-summary> 里已有的摘要合并。规则：\n- 保留旧摘要中的全部有效信息，把新进展合并进去\n- "In Progress" 里已做完的移入 "Done"\n- 按当前进度重写 "Next Steps"\n- 已过时/不再相关的可以删掉\n- 文件路径、函数名、报错原文必须原样保留\n\n严格按下面的格式输出：\n\n' + CTX_SUMMARY_FORMAT
/** 单发摘要调用（无工具、走同供应商/同代理）；失败抛错由调用方兜底 */
async function summarizeOlderMessages(llmCfg: { providerId: string; base: string; apiKey: string; model: string; protocol?: string }, older: any[], prevSummary: string, proxyFetch?: (input: any, init?: any) => any): Promise<string> {
  const isLongCat = /longcat/i.test(llmCfg.providerId) || /longcat/i.test(llmCfg.base)
  /* ★ 0923（P2-c · 抄 pi 的 "0.8 × reserve" 约束）：摘要输出上限不再硬编码 3000 ——
     上限太小会把摘要截断（信息直接丢），取 min(13107 ≈ 0.8×16384, 模型输出上限) 更稳。 */
  const _sumMax = Math.max(2048, Math.min(13107, resolveMaxOutput(llmCfg.providerId, llmCfg.model) || 4096))
  // 0910 协议扩展：摘要调用也走供应商协议（原生协议供应商不能塞 openai 格式）
  const proto = llmCfg.protocol || 'openai-completions'
  const piModel: PiModel<'openai-completions'> = {
    id: llmCfg.model, name: llmCfg.model, api: proto as any, provider: llmCfg.providerId as any,
    baseUrl: llmCfg.base, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1200,
    compat: proto === 'openai-completions'
      ? (isLongCat ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } : undefined)
      : proto === 'anthropic-messages' ? {} : undefined,
  }
  /* ★ 0923（实测：压缩连败 → `empty summary`）—— 旧版对 digest **没有任何总长限制**：
     737 条 × 每条最多 800 字符 ≈ 59 万字符（≈27 万 token）直接塞进摘要请求，超过摘要模型/网关窗口
     → 上游拒绝或返回空 → 压缩永远失败、上下文只涨不降（接着就是 400）。
     现在：① digest 设**总字符预算**（12 万字符 ≈ 5.5 万 token，留足余量）；
           ② 从**最近**的消息往前装（越近越重要），装不下的更早消息只留一行说明。 */
  const CTX_DIGEST_MAX_CHARS = 120000
  const digestLines: string[] = []
  let digestUsed = 0
  for (let i = older.length - 1; i >= 0; i--) {
    const m = older[i]
    const role = m?.role
    const t = Array.isArray(m?.content)
      ? m.content.map((c: any) => c.type === 'text' ? (c.text || '') : c.type === 'toolCall' ? `[tool ${c.name}]` : c.type === 'toolResult' ? `[result]` : '').join(' ')
      : String(m?.content || '')
    const line = `${role}: ${t.slice(0, 800)}`
    if (digestUsed + line.length + 1 > CTX_DIGEST_MAX_CHARS) {
      digestLines.unshift(`（更早的 ${i + 1} 条超出摘要输入预算，已省略——重点看下方较近的内容）`)
      break
    }
    digestLines.unshift(line)
    digestUsed += line.length + 1
  }
  const digest = digestLines.join('\n')
  /* ★ 0923（P2-b）：对话放前面、指令放后面（与 pi 的措辞 "the messages above" 对齐）；
     有旧摘要走 UPDATE 版、没有走 FIRST 版。 */
  const _instrTail = prevSummary
    ? `<previous-summary>\n${prevSummary}\n</previous-summary>\n\n${CTX_SUMMARY_UPDATE}`
    : CTX_SUMMARY_FIRST
  const instr = `===== 待压缩对话（较早部分，共 ${older.length} 条） =====\n${digest}\n\n${_instrTail}`
  const msgs = [{ role: 'user', content: [{ type: 'text', text: instr }] }]
  const ctx = toTranscriptCtx('你是严谨的对话压缩器，只输出摘要正文。', msgs as any)
  const st = proto === 'anthropic-messages'
    ? anthropicMessagesStream(piModel as any, ctx, {
        apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER, maxTokens: _sumMax, signal: AbortSignal.timeout(180000),
        ...(proxyFetch ? { fetch: proxyFetch } : {}),
      } as any)
    : proto === 'google-generative-ai'
      ? googleGeminiStream(piModel as any, ctx, {
          apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER, maxTokens: _sumMax, signal: AbortSignal.timeout(180000),
          ...(proxyFetch ? { fetch: proxyFetch } : {}),
        } as any)
      : openaiCompletionsStream(piModel, ctx, {
          apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER, maxTokens: _sumMax, signal: AbortSignal.timeout(180000),
          ...(proxyFetch ? { fetch: proxyFetch } : {}),
        } as any)
  let out = ''
  let reasoningText = ''
  for await (const ev of st) {
    if (ev.type === 'done') {
      const mm: any = (ev as any).message
      out = (mm.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim()
      /* ★ 0923：推理模型常把内容全放进思考块（text 为空）→ 旧版直接判 `empty summary`，
         于是压缩永远失败。这里把思考文本也收集起来做兜底。 */
      reasoningText = (mm.content || [])
        .filter((c: any) => c.type === 'reasoning' || c.type === 'thinking')
        .map((c: any) => c.text || c.thinking || '')
        .join('')
        .trim()
    }
    /* ★ 0923：压缩失败必须留下**原始原因**（旧版只抛 "compact llm error" → 0923 连着失败 3 次都查不出为什么，
       上下文只涨不降等于给 400 铺路）。这里把供应商/V8 的真实信息带上。 */
    else if (ev.type === 'error') {
      const e: any = (ev as any)?.error
      /* ★ 0925o（实测：错误体竟是摘要模型的思考文本 JSON）——流被掐断（多为超时）时，
         下游会把**残留消息**当 error 塞出来（{role:'assistant',content:[{type:'thinking'…}]}），
         旧解析把它 JSON.stringify 后当错误原因，看不出真凶。识别这种形态报"流中断/超时"。 */
      let detail: string
      if (e && typeof e === 'object' && (e.role === 'assistant' || Array.isArray(e.content))) {
        const thinking = String((e.content || []).map((c: any) => c?.thinking || c?.text || '').join(' ')).slice(0, 120)
        detail = `模型响应流中断（多半是生成超时/网关截断）——中断前模型思考到：“${thinking}”…`
      } else {
        detail = (typeof e === 'string'
          ? e
          : (e?.message || e?.error?.message || (() => { try { return JSON.stringify(e || {}) } catch { return '' } })())).slice(0, 300)
      }
      throw new Error('compact llm error: ' + String(detail || '未知'))
    }
  }
  /* ★ 0923：text 空但思考里有内容 → 用思考兜底（比"压缩失败"强得多：至少拿到了摘要） */
  if (!out && reasoningText) out = reasoningText.slice(0, 2000)
  if (!out) throw new Error('empty summary')
  /* ★ 0923（P2-c · 抄 dsh 的 shrink 校验）：摘要**必须比材料明显短** ——
     实测有的模型会把对话几乎照抄回来（"摘要"5 万字），压缩等于没做还多花一次调用。
     材料足够长（>4000 字）却压不到 60% 以下 → 判为无效，走降级链（缩量重试 → 机械摘要）。 */
  if (digest.length > 4000 && out.length > Math.round(digest.length * 0.6)) {
    throw new Error(`summary not shrunk: 摘要 ${out.length} 字 vs 材料 ${digest.length} 字（>60%）`)
  }
  return out
}
/** ★ 0923：**本地机械摘要**（压缩的最后一道兜底，零模型依赖 → 永远成功）。
 *  背景（设计口径）：压缩失败会打乱节奏，必须尽量不发生。所以降级链做成：
 *    ① 正常摘要（材料限长 12 万字符 + 思考兜底）
 *    ② 缩量重试（材料砍半，同一模型再来一次）
 *    ③ 本地机械摘要（本函数）—— 粗但稳：把用户诉求、动作序列、涉及文件、结论线索抽出来，
 *       并明确告知"原文存档在哪、可 fs_read 回读"，比旧的"占位折叠（老消息整段不发）"强得多。
 */
function buildMechanicalSummary(older: any[], archiveRel?: string): string {
  const userPts: string[] = []
  const toolCount: Record<string, number> = {}
  const files = new Set<string>()
  const keyLines: string[] = []
  for (const m of older) {
    const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content || '') }]
    for (const c of blocks) {
      if (c?.type === 'toolCall' && c?.name) toolCount[String(c.name)] = (toolCount[String(c.name)] || 0) + 1
      const txt = String(c?.text || c?.content || '')
      if (!txt) continue
      for (const mt of txt.matchAll(/[A-Za-z]:[\\/][^\s"'`）)]{1,120}|(?:[\w.-]+\/)+[\w.-]+\.(?:ts|vue|js|md|json|cjs|mjs|py|txt|html|css)/g)) {
        if (mt[0].length < 160) files.add(mt[0])
      }
      const first = txt.split('\n').find(l => l.trim()) || ''
      if (m?.role === 'user' && userPts.length < 12 && first.trim()) userPts.push(first.trim().slice(0, 120))
      if (m?.role === 'assistant' && keyLines.length < 8 && first.trim()) keyLines.push(first.trim().slice(0, 120))
    }
  }
  const parts = [
    '（本摘要由本地机械抽取生成：摘要模型本轮不可用，但关键线索已保留）',
    userPts.length ? '· 用户诉求（按序）:\n' + userPts.map(s => '  - ' + s).join('\n') : '',
    Object.keys(toolCount).length ? '· 执行过的动作: ' + Object.entries(toolCount).map(([k, v]) => `${k}×${v}`).join('、') : '',
    keyLines.length ? '· 结论线索:\n' + keyLines.map(s => '  - ' + s).join('\n') : '',
    files.size ? '· 涉及文件:\n' + [...files].slice(0, 20).map(s => '  - ' + s).join('\n') : '',
    archiveRel ? `· 原文存档: ${archiveRel}（需要细节直接 fs_read 回读）` : '· 原文存档: 见工作区 transcripts/ 目录（需要细节可直接读取）',
  ].filter(Boolean)
  return parts.join('\n').slice(0, 4000)
}

/* ══ 0911 三批：成员巡检官复审（轻量直调，不占成员/主 agent 名额）════
 *  规则预筛命中后调用；输入=任务单+验收标准+最近轨迹（短上下文 1~3K token），输出严格 JSON。
 *  走与压缩摘要同款"单发直调"模式（同供应商/同代理/同协议）；失败抛错由 teamRuntime 静默跳过——
 *  巡检是增益不是依赖，网关抖动绝不能影响成员运行。 */
async function inspectorReviewDirect(input: {
  memberName: string; roleText: string; stepText: string; taskText: string; acceptance: string
  suspicion: string; trajectory: string
}): Promise<{ verdict: 'ok' | 'drift' | 'loop'; reason: string; fix?: string }> {
  const llmCfg = currentLlmConfig()
  if (!llmCfg.base || !llmCfg.model) throw new Error('未配置模型，巡检复审跳过')
  const _prov = getState().providers.find(x => x.id === llmCfg.providerId) as any
  const _proxyUrl = String(_prov?.proxyUrl || '').trim()
  const proxyFetch = _proxyUrl && /^https?:\/\//i.test(_proxyUrl) ? makeProxiedFetch(_proxyUrl) : undefined
  const isLongCat = /longcat/i.test(llmCfg.providerId) || /longcat/i.test(llmCfg.base)
  const proto = (llmCfg as any).protocol || 'openai-completions'
  const piModel: PiModel<'openai-completions'> = {
    id: llmCfg.model, name: llmCfg.model, api: proto as any, provider: llmCfg.providerId as any,
    baseUrl: llmCfg.base, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 300,
    // developer 角色统一关（同主链路：b.ai 网关对 developer 必挂；system 通用）
    compat: proto === 'openai-completions'
      ? (isLongCat ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const } : { supportsDeveloperRole: false })
      : proto === 'anthropic-messages' ? {} : undefined,
  }
  const clip = (x: unknown, n: number) => { const s = String(x ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }
  const prompt = [
    '你是多 agent 团队的运行巡检员。某成员正在执行任务单，系统检测到可疑迹象，请判定该成员的状态。',
    '判定原则（克制）：只有在【明显偏离任务单主线】或【明显陷入无意义循环】时才判异常；探索性读取、试错调试、必要的多次命令、正常的多次文件修改都属正常（ok）。拿不准时判 ok。',
    '',
    `成员：${input.memberName}｜职责：${clip(input.roleText, 200)}`,
    `任务描述：${clip(input.stepText, 300)}`,
    `任务单（指挥官打包）：${clip(input.taskText, 800)}`,
    input.acceptance ? `验收标准：${clip(input.acceptance, 400)}` : '',
    '',
    `可疑迹象：${input.suspicion}`,
    '最近工具轨迹（时间序，含参数与结果摘要）：',
    input.trajectory || '(无)',
    '',
    '输出严格 JSON（不要 markdown 围栏、不要多余文字）：',
    '{"verdict":"ok|drift|loop","reason":"一句话，≤60字","fix":"若异常，给成员一句可直接执行的纠偏指令，≤80字；正常则空字符串"}',
  ].filter(Boolean).join('\n')
  const msgs = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const ctx = toTranscriptCtx('你是严格但克制的任务巡检员，只输出 JSON。', msgs as any)
  const st = proto === 'anthropic-messages'
    ? anthropicMessagesStream(piModel as any, ctx, {
        apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER, maxTokens: 300, signal: AbortSignal.timeout(45000),
        ...(proxyFetch ? { fetch: proxyFetch } : {}),
      } as any)
    : proto === 'google-generative-ai'
      ? googleGeminiStream(piModel as any, ctx, {
          apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER, maxTokens: 300, signal: AbortSignal.timeout(45000),
          ...(proxyFetch ? { fetch: proxyFetch } : {}),
        } as any)
      : openaiCompletionsStream(piModel, ctx, {
          apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER, maxTokens: 300, signal: AbortSignal.timeout(45000),
          ...(proxyFetch ? { fetch: proxyFetch } : {}),
        } as any)
  let out = ''
  for await (const ev of st) {
    if (ev.type === 'done') { const mm: any = (ev as any).message; out = (mm.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim() }
    else if (ev.type === 'error') throw new Error('inspector review llm error')
  }
  if (!out) throw new Error('empty review output')
  // 解析：JSON 优先；小模型偶发不守格式时走中文关键词兜底（宁可放过，不可误伤）
  let verdict: 'ok' | 'drift' | 'loop' = 'ok'
  let reason = ''
  let fix = ''
  try {
    const m = /\{[\s\S]*\}/.exec(out)
    const obj = m ? JSON.parse(m[0]) : null
    if (obj) {
      const v = String(obj.verdict || '')
      verdict = /drift/i.test(v) ? 'drift' : /loop/i.test(v) ? 'loop' : 'ok'
      reason = clip(obj.reason, 160)
      fix = clip(obj.fix, 200)
    }
  } catch { /* 走兜底 */ }
  if (!reason) {
    verdict = /偏离|drift/i.test(out) ? 'drift' : /循环|loop/i.test(out) ? 'loop' : 'ok'
    reason = out.replace(/\s+/g, ' ').slice(0, 120)
  }
  return { verdict, reason, fix: fix || undefined }
}

/* ══ 0911：AI 提炼 / 记忆提炼（一次性直调，无工具单轮）════
 *  与巡检复审 / 压缩摘要同款单发模式（同供应商 / 同代理 / 同协议），失败抛错由调用侧兜底。
 *  背景：前端 aiExtract / memoryExtract 原走 AI_EXTRACT / MEMORY_EXTRACT 等 WS 死通道（转 15s 失败），
 *  本轮改为 bridgeRpc 实链路，本文件提供后端 LLM 侧能力。 */
/** 提炼模型可覆盖（前端「人格 → 提炼模型」）；未指定则用全局聊天模型 */
function resolveLlmCfg(override?: { provider?: string; model_id?: string } | null) {
  const base = currentLlmConfig()
  const pid = String(override?.provider || '').trim()
  const mid = String(override?.model_id || '').trim()
  if (!pid || !mid) return base
  const prov = getState().providers.find(x => x.id === pid) as any
  if (!prov) return base
  return {
    ...base,
    providerId: prov.id,
    providerName: prov.name,
    base: (prov.base || '').replace(/\/+$/, ''),
    apiKey: plainKeyById(prov.id),            // ★ 1001：取明文（原为 prov.apiKey = 落盘密文）
    model: mid,
    proxyUrl: prov.proxyUrl || '',
    protocol: (prov.protocol || 'openai-completions') as any,
  }
}

async function llmOnceDirect(
  prompt: string,
  systemPrompt: string,
  opts: { maxTokens?: number; timeoutMs?: number; override?: { provider?: string; model_id?: string; effort?: string | null } | null } = {},
): Promise<string> {
  const llmCfg = resolveLlmCfg(opts.override)
  if (!llmCfg.base || !llmCfg.model) throw new Error('未配置模型')
  /* ★1013：让"后台模型的推理强度"对提炼这类**非对话**调用也生效（用户："后台模型也能自由选强度"）。
     只有该模型确实支持思考（clampEffort 返回非空）时才打开 reasoning，避免给非推理模型塞 thinking 参数。 */
  const _effortWanted = String((opts.override as any)?.effort || '').trim()
  const _effort = _effortWanted
    ? mapEffort(clampEffort(llmCfg.providerId, llmCfg.model, _effortWanted) || '', String(llmCfg.base || ''))
    : null
  const _prov = getState().providers.find(x => x.id === llmCfg.providerId) as any
  const _proxyUrl = String(_prov?.proxyUrl || '').trim()
  const proxyFetch = _proxyUrl && /^https?:\/\//i.test(_proxyUrl) ? makeProxiedFetch(_proxyUrl) : undefined
  const isLongCat = /longcat/i.test(llmCfg.providerId) || /longcat/i.test(llmCfg.base)
  const proto = (llmCfg as any).protocol || 'openai-completions'
  const maxTokens = opts.maxTokens ?? 1500
  const timeoutMs = opts.timeoutMs ?? 60000
  const piModel: PiModel<'openai-completions'> = {
    id: llmCfg.model, name: llmCfg.model, api: proto as any, provider: llmCfg.providerId as any,
    baseUrl: llmCfg.base, reasoning: !!_effort, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens,
    compat: proto === 'openai-completions'
      ? (isLongCat ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const } : { supportsDeveloperRole: false })
      : proto === 'anthropic-messages' ? {} : undefined,
  }
  const msgs = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const ctx = toTranscriptCtx(systemPrompt, msgs as any)
  const callOpts = {
    apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER,
    maxTokens,
    signal: AbortSignal.timeout(timeoutMs),
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
    // ★1013：后台模型的推理强度（仅当该模型支持思考时才有值；非推理模型不加此参数）
    ...(_effort ? { reasoningEffort: _effort } : {}),
  } as any
  let out = ''
  // 空输出容错：推理款模型偶发"只思考不出正文"（empty output，实测 glm-5.3-flash）→ 重试一次（0913）
  for (let attempt = 1; attempt <= 2; attempt++) {
    const st = proto === 'anthropic-messages'
      ? anthropicMessagesStream(piModel as any, ctx, callOpts)
      : proto === 'google-generative-ai'
        ? googleGeminiStream(piModel as any, ctx, callOpts)
        : openaiCompletionsStream(piModel, ctx, callOpts)
    out = ''
    for await (const ev of st) {
      if (ev.type === 'done') {
        const mm: any = (ev as any).message
        out = (mm.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim()
      } else if (ev.type === 'error') {
        // 透传上游错误细节（此前只报 'llm direct error'，把 402 欠费/4xx 这类关键信息藏掉了）
        const detail = JSON.stringify((ev as any).error || (ev as any).reason || ev).slice(0, 300)
        throw new Error('llm direct error: ' + detail)
      }
    }
    if (out) return out
    if (attempt === 1) console.warn('[llmOnceDirect] 空输出，重试一次…')
  }
  throw new Error('empty llm output')
}

/** 从模型输出抠出 JSON 对象（容忍 markdown 围栏 / 前后废话） */
function parseLooseJson(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const m = /\{[\s\S]*\}/.exec(body)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/** 从模型输出抠出 JSON 数组（容忍围栏 / 外层对象包裹） */
function parseLooseArray(text: string): any[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const m = /\[[\s\S]*\]/.exec(body)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0])
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

// ── AI 提炼（知识库） ──────────────────────────────────────

const AI_EXTRACT_TYPES = ['doc', 'manual', 'note', 'reference']

function emptyExtractFields() {
  return { title: '', summary: '', content: '', entry_type: 'doc', tags: [] as string[], source_label: '' }
}

/** 原文直填兜底（LLM 不可用时的降级，对应前端「AI 不可用 · 原文直填」文案） */
function rawFillFields(content: string, isUrl: boolean) {
  const text = String(content || '').trim()
  const firstLine = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) || text
  return {
    title: firstLine.slice(0, 60),
    summary: text.replace(/\s+/g, ' ').slice(0, 120),
    content: text,
    entry_type: 'doc',
    tags: [] as string[],
    source_label: isUrl ? text.slice(0, 60) : '',
  }
}

function normalizeExtractFields(obj: any, sourceText: string, fallbackContent: string) {
  const et = String(obj?.entry_type || '').trim().toLowerCase()
  const tags = Array.isArray(obj?.tags) ? obj.tags.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 6) : []
  return {
    title: String(obj?.title || '').slice(0, 60),
    summary: String(obj?.summary || '').slice(0, 120),
    content: String(obj?.content || '').trim() || fallbackContent,
    entry_type: AI_EXTRACT_TYPES.includes(et) ? et : 'doc',
    category: String(obj?.category || '').trim().slice(0, 24),
    tags,
    source_label: String(obj?.source_label || sourceText || '').slice(0, 60),
  }
}

/** 抓取 URL 正文（失败返回空串；仅取前 20K 字符，去标签） */
async function fetchUrlText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000) })
    if (!res.ok) return ''
    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20000)
  } catch { return '' }
}

/** ai.extract：文字/URL → 知识库固定字段。LLM 失败不报错，回退原文直填（llm_used=false）。 */
async function aiExtractDirect(sourceType: string, rawContent: string, override?: { provider?: string; model_id?: string } | null) {
  const content = String(rawContent || '').trim()
  if (!content) return { ok: false, fields: emptyExtractFields(), llm_used: false, msg: '内容为空' }
  const isUrl = sourceType === 'url' || /^https?:\/\/\S+$/i.test(content)
  let body = content
  if (isUrl) {
    const page = await fetchUrlText(content)
    if (page) body = page
  }
  const clip = (s: any, n: number) => String(s ?? '').slice(0, n)
  // 0924：自动分类 —— 把现有分类清单带进提示词（knowledge_add 侧对不存在的分类会自动建 folder）
  let cats = ''
  try {
    cats = ((await memoryBridge.call('knowledge_list', {}))?.entries || [])
      .filter((e: any) => e?.entry_type === 'folder').map((e: any) => String(e.title)).filter(Boolean).slice(0, 30).join(' / ')
  } catch { /* 拿不到分类不影响提炼 */ }
  const prompt = [
    '把下面的内容提炼成一条知识库条目，输出严格 JSON（不要 markdown 围栏、不要多余文字）：',
    '{"title":"标题≤40字","summary":"摘要≤120字","content":"整理后的正文（保留关键信息与具体标识符，≤2000字）","entry_type":"doc|manual|note|reference","tags":["≤6个短标签"],"category":"分类名","source_label":"来源说明≤40字"}',
    'entry_type 判定：doc=文档资料 / manual=操作手册步骤 / note=零散笔记 / reference=参考链接。',
    cats ? `category 分类（0924 自动归档）：优先从【现有分类】里选一个：${cats}；都不合适才给新的简短分类名（2~6字）；给不出留空。` : 'category 分类（0924 自动归档）：按内容给一个简短分类名（2~6字）；给不出留空。',
    isUrl ? `（来源链接：${clip(content, 300)}）` : '',
    '===== 待提炼内容 =====',
    clip(body, 8000),
  ].filter(Boolean).join('\n')
  try {
    const out = await llmOnceDirect(prompt, '你是知识库录入助手，只输出 JSON。', { maxTokens: 1600, timeoutMs: 45000, override })
    const obj = parseLooseJson(out)
    if (obj) {
      return { ok: true, llm_used: true, fields: normalizeExtractFields(obj, isUrl ? content : '', isUrl ? content : body) }
    }
  } catch { /* 落兜底 */ }
  return { ok: true, llm_used: false, fields: rawFillFields(isUrl ? content : body, isUrl) }
}

// ── 记忆提炼（长期记忆） ──────────────────────────────────

const MEMORY_NODE_TYPES = ['preference', 'decision', 'pitfall', 'pattern', 'progress']

/** 归一化文本（去空白与标点，小写）——记忆查重粗相似度用 */
function normForSim(s: string): string {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符 bigram Jaccard 相似度（0~1） */
function simScore(a: string, b: string): number {
  const x = normForSim(a)
  const y = normForSim(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return (Math.min(x.length, y.length) / Math.max(x.length, y.length)) * 0.9 + 0.1
  const grams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const A = grams(x)
  const B = grams(y)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const uni = A.size + B.size - inter
  return uni ? inter / uni : 0
}

/** 现有记忆网图节点（排除 memories 表投影节点），查重用 */
async function loadMemoryNodesForDedup(): Promise<any[]> {
  try {
    const g = await memoryBridge.call('memory_graph', { scope: 'all' })
    // 0924 一期：不再排除 mem_ 投影 —— 提炼查重要覆盖全部记忆（含 AI memory_store 写入的）
    return (g?.nodes || [])
  } catch { return [] }
}

/** 记忆落盘（单条） */
async function writeMemoryNode(item: any): Promise<string | null> {
  /* 0924 一期（分裂缺陷修复）：统一写 memory_records —— 与 AI memory_store 同一条管线
   * （语义查重合并 + 可被 memory_search 检索 + 进 6 类/摘要索引）。此前写 memory_nodes
   * 网图表 ⇒ 用户提炼的记忆 AI 根本搜不到、两套体系对不上。 */
  const NODE_TO_CATEGORY: Record<string, string> = {
    preference: 'preference', decision: 'decision', pitfall: 'lesson',
    pattern: 'pattern', fact: 'fact', progress: 'fact', profile: 'profile',
  }
  const content = String(item?.content || '')
  const title = String(item?.title || '').slice(0, 60)
  const r = await memoryBridge.call('memory_store', {
    content: title ? (content ? `${title}：${content}` : title) : content,
    summary: String(item?.summary || title || content).slice(0, 60),
    category: NODE_TO_CATEGORY[String(item?.node_type || '').toLowerCase()] || 'fact',
    source: 'extract',
    // 0924 修回归：0913「待确认」审核区的标签（pending_review/from_auto_memory）随写入流转，不再丢
    tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
  })
  return r?.memory?.id ? String(r.memory.id) : null
}

/** memory.extract：对话 → 候选记忆条目（含查重判定 outcome）。dryRun=false 时直接落盘。
 *  auto=true（主动记忆·无人值守）→ 写入时打 pending_review 标记，进记忆库「待确认」审核区。 */
async function memoryExtractDirect(content: string, projectRoot: string, dryRun: boolean, override?: { provider?: string; model_id?: string } | null, auto = false) {
  const src = String(content || '').trim()
  if (!src) return { ok: false, saved: 0, items: [], llm_used: false, msg: '内容为空' }
  let raw = ''
  try {
    const prompt = [
      '从下面的对话里提炼值得长期记住的记忆条目，输出严格 JSON 数组（不要 markdown 围栏、不要多余文字）：',
      '[{"node_type":"preference|decision|pitfall|pattern|progress","title":"≤30字","content":"一句话陈述，≤200字"}]',
      'preference=用户偏好/明确要求 / decision=已定的决策 / pitfall=踩坑教训 / pattern=可复用做法 / progress=项目进度。',
      '只提炼有长期价值的信息；没有值得记的就输出 []。',
      '===== 对话内容 =====',
      src.slice(0, 12000),
    ].join('\n')
    raw = await llmOnceDirect(prompt, '你是记忆提炼助手，只输出 JSON 数组。', { maxTokens: 2000, timeoutMs: 60000, override })
  } catch (e: any) {
    return { ok: false, saved: 0, items: [], llm_used: false, msg: `提炼失败：${String(e?.message || e).slice(0, 120)}` }
  }
  const arr = parseLooseArray(raw)
  if (!arr.length) return { ok: true, saved: 0, items: [], llm_used: true, msg: '这段对话没有值得提炼的内容' }

  const existing = await loadMemoryNodesForDedup()
  const items = arr.slice(0, 20).map((x: any) => {
    const nt = String(x?.node_type || '').trim().toLowerCase()
    const title = String(x?.title || '').slice(0, 60)
    const body = String(x?.content || '').slice(0, 400)
    let outcome = 'created'
    let hit: any = null
    let best = 0
    for (const n of existing) {
      const s = Math.max(simScore(title, n.title || ''), simScore(body, n.content || ''))
      if (s > best) { best = s; hit = n }
    }
    if (hit && best >= 0.9) outcome = 'already_exists'
    else if (hit && best >= 0.55) outcome = 'conflict'
    return {
      node_type: MEMORY_NODE_TYPES.includes(nt) ? nt : 'fact',
      title,
      content: body,
      outcome,
      hit_id: outcome === 'created' ? undefined : String(hit.id),
      old_content: outcome === 'created' ? undefined : String(hit.content || '').slice(0, 300),
      reason: outcome === 'already_exists' ? '已有高度相似的记忆'
        : outcome === 'conflict' ? '与已有记忆部分冲突' : undefined,
    }
  })

  if (dryRun) return { ok: true, saved: 0, items, llm_used: true }

  // 直接落盘（非 dryRun）：跳过已存在，其余写入
  const counts = { created: 0, merged: 0, already_exists: 0, conflict: 0 }
  const written: any[] = []
  for (const it of items) {
    if (it.outcome === 'already_exists') { counts.already_exists++; written.push(it); continue }
    try {
      const newId = await writeMemoryNode({
        ...it,
        scope: 'global',
        project_id: projectRoot || '',
        // 0913 主动记忆（无人值守）：进「待确认」审核区（记忆库可采纳/丢弃）
        tags: auto
          ? [...(Array.isArray((it as any)?.tags) ? (it as any).tags : []), 'pending_review', 'from_auto_memory']
          : (it as any)?.tags,
      })
      it.outcome = 'created'
      it.hit_id = newId || undefined
      counts.created++
    } catch (e: any) {
      // 0913：落盘失败不再静默（此前吞掉异常只记 conflict，排查无门）
      console.warn('[memory.extract] 落盘失败:', String(e?.message || e).slice(0, 200))
      it.reason = String(e?.message || e).slice(0, 120)
      counts.conflict++
    }
    written.push(it)
  }
  return { ok: true, saved: counts.created, items: written, counts, llm_used: true }
}

/** memory.extractCommit：提交用户勾选的条目（已存在跳过；冲突顶替时改走 update） */
async function memoryExtractCommitDirect(items: any[], projectRoot: string) {
  const counts = { created: 0, merged: 0, already_exists: 0, conflict: 0 }
  const out: any[] = []
  for (const it of Array.isArray(items) ? items : []) {
    const outcome = String(it?.outcome || 'created')
    if (outcome === 'already_exists') { counts.already_exists++; out.push(it); continue }
    const payload = {
      title: String(it?.title || '未命名记忆'),
      content: String(it?.content || ''),
      summary: String(it?.summary || it?.title || '').slice(0, 60),
      node_type: String(it?.node_type || 'fact'),
      scope: 'global',
      project_id: projectRoot || '',
    }
    try {
      // 用户确认顶替 → 更新命中节点；否则新增
      // 0924 一期：统一走 memory_store（自带语义查重合并），顶替/新增都不再写网图节点
      {
        const newId = await writeMemoryNode({ ...payload, summary: payload.summary || payload.title })
        if (newId) counts[outcome === 'merged' ? 'merged' : 'created']++
        out.push({ ...it, outcome: outcome === 'merged' ? 'merged' : 'created', hit_id: newId || it?.hit_id })
      }
    } catch {
      counts.conflict++
      out.push({ ...it, outcome: 'conflict', reason: '写入失败' })
    }
  }
  return {
    ok: counts.created + counts.merged > 0,
    saved: counts.created + counts.merged,
    items: out,
    counts,
    llm_used: true,
  }
}

/** memory.conflictResolve：用户确认用新内容顶替旧记忆 */
async function memoryConflictResolveDirect(payload: any) {
  const memoryId = String(payload?.memory_id || '')
  const title = String(payload?.title || '未命名记忆')
  const content = String(payload?.content || '')
  const nt = String(payload?.node_type || 'fact')
  const nodeType = MEMORY_NODE_TYPES.includes(nt) ? nt : 'fact'
  try {
    if (memoryId) {
      const r = await memoryBridge.call('memory_node_update', { id: memoryId, title, content, node_type: nodeType })
      return { outcome: r?.updated ? 'merged' : 'already_exists', memory_id: memoryId }
    }
    const r = await memoryBridge.call('memory_node_add', {
      title, content, summary: content.slice(0, 60), node_type: nodeType,
      scope: String(payload?.scope || 'global'), project_id: String(payload?.project_id || ''),
      tags: [], source_type: 'memory_extract',
    })
    return { outcome: r?.node?.id ? 'merged' : 'already_exists', memory_id: r?.node?.id }
  } catch (e: any) {
    return { outcome: 'already_exists', reason: String(e?.message || e).slice(0, 120) }
  }
}

/* ── 知识提炼（知识库·0913） ──────────────────────────────
 * 与「记忆提炼」对偶：对话 → 候选知识条目（查重）→ 勾选提交写入 knowledge.db。
 * 数据走 memoryBridge（Python）：knowledge_list 查重 / knowledge_add 写入。
 */

const KNOWLEDGE_ENTRY_TYPES = ['doc', 'manual', 'note', 'reference']

/** 现有知识库条目（查重用） */
async function loadKnowledgeForDedup(): Promise<any[]> {
  try {
    const r = await memoryBridge.call('knowledge_list', {})
    return Array.isArray(r?.entries) ? r.entries : []
  } catch { return [] }
}

/** knowledge.extract：对话 → 候选知识条目（含查重判定）。dryRun=false 时直接写入知识库。 */
async function knowledgeExtractDirect(content: string, _projectRoot: string, dryRun: boolean, override?: { provider?: string; model_id?: string } | null) {
  const src = String(content || '').trim()
  if (!src) return { ok: false, saved: 0, items: [], llm_used: false, msg: '内容为空' }
  let raw = ''
  // 0924 二期批2：自动分类 —— 把现有分类清单带进提示词（knowledge_add 对新分类自动建 folder）
  let cats = ''
  try {
    cats = ((await memoryBridge.call('knowledge_list', {}))?.entries || [])
      .filter((e: any) => e?.entry_type === 'folder').map((e: any) => String(e.title)).filter(Boolean).slice(0, 30).join(' / ')
  } catch { /* 拿不到分类不影响提炼 */ }
  try {
    const prompt = [
      '从下面的对话里提炼值得存入「知识库」的资料条目（可复用的知识、方法步骤、参考资料、结论），输出严格 JSON 数组（不要 markdown 围栏、不要多余文字）：',
      '[{"entry_type":"doc|manual|note|reference","title":"≤40字","summary":"摘要≤60字","content":"整理后的要点正文（保留关键信息与具体标识符，≤800字）","tags":["≤4个短标签"],"category":"分类名"}]', 
      'entry_type 判定：doc=文档资料 / manual=操作步骤 / note=零散笔记 / reference=参考链接。',
      cats ? `category 分类（0924 自动归档）：优先从【现有分类】里选一个：${cats}；都不合适才给新的简短分类名（2~6字）；给不出留空。` : 'category 分类（0924 自动归档）：按内容给一个简短分类名（2~6字）；给不出留空。',
      '只提炼有长期价值、可复用的信息；没有值得存的就输出 []。',
      '===== 对话内容 =====',
      src.slice(0, 12000),
    ].join('\n')
    raw = await llmOnceDirect(prompt, '你是知识库录入助手，只输出 JSON 数组。', { maxTokens: 4000, timeoutMs: 60000, override })
  } catch (e: any) {
    return { ok: false, saved: 0, items: [], llm_used: false, msg: `提炼失败：${String(e?.message || e).slice(0, 120)}` }
  }
  const arr = parseLooseArray(raw)
  if (!arr.length) return { ok: true, saved: 0, items: [], llm_used: true, msg: '这段对话没有值得提炼的知识' }

  const existing = await loadKnowledgeForDedup()
  const items = arr.slice(0, 15).map((x: any) => {
    const et = String(x?.entry_type || '').trim().toLowerCase()
    const title = String(x?.title || '').slice(0, 100)
    const body = String(x?.content || '').slice(0, 2000)
    const tags = Array.isArray(x?.tags) ? x.tags.map((tg: any) => String(tg).slice(0, 20)).slice(0, 6) : []
    let outcome = 'created'
    let hit: any = null
    let best = 0
    for (const e of existing) {
      const s = Math.max(simScore(title, e.title || ''), simScore(body, e.content || ''))
      if (s > best) { best = s; hit = e }
    }
    if (hit && best >= 0.85) outcome = 'already_exists'
    return {
      entry_type: KNOWLEDGE_ENTRY_TYPES.includes(et) ? et : 'note',
      title,
      summary: String(x?.summary || '').slice(0, 120),
      category: String(x?.category || '').trim().slice(0, 24),
      content: body,
      tags,
      outcome,
      hit_id: outcome === 'created' ? undefined : String(hit.id),
      reason: outcome === 'already_exists' ? '知识库已有相似条目' : undefined,
    }
  })

  if (dryRun) return { ok: true, saved: 0, items, llm_used: true }

  const counts = { created: 0, already_exists: 0 }
  const written: any[] = []
  for (const it of items) {
    if (it.outcome === 'already_exists') { counts.already_exists++; written.push(it); continue }
    try {
      const r = await memoryBridge.call('knowledge_add', { title: it.title, content: it.content, summary: it.summary || '', category: it.category || '', entry_type: it.entry_type, tags: it.tags })
      it.hit_id = r?.entry?.id ? String(r.entry.id) : undefined
      counts.created++
    } catch {
      it.outcome = 'already_exists'
      counts.already_exists++
    }
    written.push(it)
  }
  return { ok: true, saved: counts.created, items: written, counts, llm_used: true }
}

/** knowledge.extractCommit：提交用户勾选的条目（已存在跳过；写入知识库） */
async function knowledgeExtractCommitDirect(items: any[]) {
  const counts = { created: 0, already_exists: 0 }
  const out: any[] = []
  for (const it of Array.isArray(items) ? items : []) {
    if (String(it?.outcome || 'created') === 'already_exists') { counts.already_exists++; out.push(it); continue }
    try {
      const r = await memoryBridge.call('knowledge_add', {
        title: String(it?.title || '未命名条目'),
        content: String(it?.content || ''),
        summary: String(it?.summary || it?.title || '').slice(0, 120),
        category: String(it?.category || ''),
        entry_type: KNOWLEDGE_ENTRY_TYPES.includes(String(it?.entry_type)) ? String(it.entry_type) : 'note',
        tags: Array.isArray(it?.tags) ? it.tags.map(String) : [],
      })
      counts.created++
      out.push({ ...it, outcome: 'created', hit_id: r?.entry?.id ? String(r.entry.id) : undefined })
    } catch {
      counts.already_exists++
      out.push({ ...it, outcome: 'already_exists', reason: '写入失败' })
    }
  }
  return { ok: counts.created > 0, saved: counts.created, items: out, counts, llm_used: true }
}

/* ── 版本保底桥接（0913）：设置页「版本保底」页调用 _release.mjs 引擎 ──
 * 引擎是独立纯 node 脚本（与「一键回滚.exe」同源）；这里 execFile 跑子命令，拿结构化 JSON / 输出日志。
 * NIS 挂了也能用 exe 救（本桥接只是活体入口）；回滚属重操作，前端有二次确认。
 */

/** ★1010：正在进行的版本保底操作 —— 让设置页切 tab / 重进后能"接上"进度（反馈：删大还原点时切走再回来，那条看着像没删过）。
 *  只跟踪 NIS 面板发起的操作；exe 面板与命令行是另起进程，这里看不到（可接受）。 */
let releaseOp: { kind: 'snapshot' | 'rollback' | 'delete'; name: string; startedAt: number } | null = null
/** 包一层：登记 op → 跑命令 → 无论成败都清空（前端靠 release.state 的 op 字段续接） */
async function withReleaseOp<T>(kind: 'snapshot' | 'rollback' | 'delete', name: string, fn: () => Promise<T>): Promise<T> {
  releaseOp = { kind, name, startedAt: Date.now() }
  try { return await fn() } finally { releaseOp = null }
}

/** 跑一次引擎子命令；返回 { ok, output } */
function runReleaseCmd(args: string[], timeoutMs = 120000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const engine = path.join(PROJECT_ROOT, 'backend', '_release.mjs')
    if (!fs.existsSync(engine)) { resolve({ ok: false, output: `引擎缺失：${engine}` }); return }
    void import('node:child_process').then(({ execFile }) => {
      execFile(process.execPath, [engine, ...args], {
        cwd: path.join(PROJECT_ROOT, 'backend'),
        env: { ...process.env, NIS_RELEASE_ROOT: PROJECT_ROOT, NIS_DATA_DIR: DATA_ROOT },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }, (err: any, stdout: string, stderr: string) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim()
        resolve({ ok: !err, output })
      })
    }).catch((e: any) => resolve({ ok: false, output: `启动失败：${String(e?.message || e)}` }))
  })
}

/* ── 数据整包导出/导入（0915）：设置→通用「数据备份」──
 * 导出 = tar.gz（nis-manifest.json + data/ + storage/ + skills/，排除版本快照与日志）；
 * 导入 = 解到 %APPDATA%/nis/imports/<ts>/（绝不触碰现有数据）→ 改写 config.json 指向导入数据
 *        （旧配置自动 .bak）→ 重启应用后生效；还原 = 改回配置或删掉重指。
 */

/** 数据根父目录（导出默认落点基准） */
function dataParentDir(): string {
  return path.dirname(path.resolve(DATA_ROOT))
}



/** tar.exe（Windows 自带 bsdtar） */
function tarExe(): string {
  const p = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'tar.exe')
  return fs.existsSync(p) ? p : 'tar'
}

/** 跑一次 tar；{ ok, output } */
function runTar(args: string[], timeoutMs = 600000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    void import('node:child_process').then(({ execFile }) => {
      execFile(tarExe(), args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }, (err: any, stdout: string, stderr: string) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim()
        resolve({ ok: !err, output })
      })
    }).catch((e: any) => resolve({ ok: false, output: 'tar 启动失败：' + String(e?.message || e) }))
  })
}

/** 0917b：数据备份进度广播（设置→通用→数据备份条显示百分比 + 阶段文本）。
 *  走全局桶（sessionId=''）：设置页没有会话上下文也能收到。percent<0 = 不定量。 */
function emitDataProgress(task: 'export' | 'import', percent: number, phase: string): void {
  try { broadcastMux('', { type: 'data/progress', task, percent, phase }) } catch { /* 广播失败不影响备份本体 */ }
}

/* 进度**节流**：tar -v 是"每个条目一行"，几百 MB 的包能产出几千行 →
 * 不节流会把几千条消息灌进前端（实测表现为弹窗/进度条卡住不动）。这里按任务限到 ~4 次/秒。
 * ⚠️ 只节流"中间进度"，0%/100% 这种落槌消息仍走 emitDataProgress 原样发。 */
const lastProgAt: Record<string, number> = {}
function emitDataProgressThrottled(task: 'export' | 'import', percent: number, phase: string): void {
  const now = Date.now()
  if (now - (lastProgAt[task] || 0) < 250) return
  lastProgAt[task] = now
  emitDataProgress(task, percent, phase)
}

/** 正在跑的导出 tar 进程（0920 加）：供 `data.cancelExport` 做真取消。
 *  ⚠️ 只跟踪**导出**；导入是解包落位（多步、有覆盖语义），中途掐掉会把数据留在半途，
 *     所以导入端仍然只允许"等它做完"。 */
let exportProc: { cp: any; cancelled: boolean } | null = null

/** 0917b：流式跑 tar —— 读取 stdout/stderr 的每一行回调（配合 `-v` 拿"已处理条目数"做真实进度）。
 *  与 runTar 的差别：spawn + 行回调，不再等进程结束才拿到输出。
 *  0920：多一个 `onProc` —— 把子进程句柄交出去，导出才能"取消"（见 data.cancelExport）。 */
function runTarStream(
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void,
  onProc?: (cp: any) => void,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    void import('node:child_process').then(({ spawn }) => {
      let cp: ReturnType<typeof spawn>
      try {
        cp = spawn(tarExe(), args, { windowsHide: true })
      } catch (e: any) {
        resolve({ ok: false, output: 'tar 启动失败：' + String(e?.message || e) })
        return
      }
      try { onProc?.(cp) } catch { /* 回调失败不影响打包 */ }
      let out = ''
      let settled = false
      const timer = setTimeout(() => { try { cp.kill() } catch { /* ignore */ } }, timeoutMs)
      const feed = (buf: Buffer): void => {
        const s = buf.toString('utf8')
        out += s
        if (out.length > 8 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024) // 防大目录无界增长
        for (const line of s.split(/\r?\n/)) { const v = line.trim(); if (v) onLine(v) }
      }
      cp.stdout?.on('data', feed)
      cp.stderr?.on('data', feed)
      cp.on('error', (e: any) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        resolve({ ok: false, output: 'tar 启动失败：' + String(e?.message || e) })
      })
      cp.on('close', (code: number | null) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        resolve({ ok: code === 0, output: out.trim() })
      })
    }).catch((e: any) => resolve({ ok: false, output: 'tar 启动失败：' + String(e?.message || e) }))
  })
}

/* ── 数据备份的"部分"定义（0919）─────────────────────────────────────────
 * 一个"部分" = 一组 tar 成员（从哪个根取哪些顶层条目） + 默认是否勾选。
 * 导出勾选、导入按部分解包、manifest 里的清单与体积，全部以这份定义为准。
 * ⚠️ root 名只是逻辑名，实际路径在运行时由 DATA_ROOT / storageRootNow() / SKILLS_ROOT / currentMemoryDir() 解析
 *    —— 这样"当前安装的对应位置"永远是对的，不会写死到某个盘。 */
const DATA_PARTS: Array<{
  id: string
  label: string
  hint?: string
  src: Array<{ root: 'data' | 'storage' | 'skills' | 'memory'; entries: string[] }>
  on?: boolean
  secrets?: boolean
  /** ★1011：含**明文**敏感值 —— 导出口令护不住它们（口令加密只覆盖 providers / websearch 的密钥）。
   *  前端据此把"能加密带走的密钥"与"包里就是明文的令牌/私钥"**分开提示**，避免误以为填了口令就安全。 */
  plainSecrets?: boolean
}> = [
  { id: 'sessions', label: '对话记录', on: true, src: [{ root: 'data', entries: ['sessions', 'session-assets'] }] },
  { id: 'memory', label: '记忆库', on: true, src: [{ root: 'memory', entries: ['memory_system.db', 'memory_system.db-wal', 'memory_system.db-shm'] }] },
  { id: 'knowledge', label: '知识库', on: true, src: [{ root: 'memory', entries: ['knowledge.db'] }, { root: 'data', entries: ['knowledge-attachments'] }] },
  /* ★ 1001：websearch.json 原来**根本不在导出范围**（搜索 key 是旁边的明文漏点，一并纳入保险箱）。
     此前的 hint 写"含明文"——密钥加密上线后已不成立，改成"已加密"，免得用户误判风险。 */
  { id: 'settings', label: '设置', hint: '含供应商 / 搜索 API Key（已加密）', on: true, secrets: true, src: [{ root: 'data', entries: ['settings.json', 'ui-state.json', 'providers.json', 'websearch.json'] }] },
  /* ★1011（老大："导出功能没法连同远程连接的配置一起导出"）：**通道与远程接入** ——
     这 4 个文件原来全在导出范围外（上面的 settings 只列了 settings/ui-state/providers/websearch）⇒
     换机或重装后，微信 / QQ 机器人、远程访问开关与访问令牌、云隧道连接与密钥**全都要重配一遍**。
     ⚠️ 内容是**明文**：bot secret、remote.remoteToken、隧道 SSH 私钥 tunnel_key(.pub)
       ⇒ 标 secrets + plainSecrets，前端会拦一道，并如实说明"导出口令护不住这几个文件"。
     ⚠️ 导入后要**重启后端**才生效（channels.json 走 channelsStore 内存 cache；tunnel 为现读）。 */
  { id: 'channels', label: '通道与远程接入', hint: '微信 / QQ / 远程访问 / 云隧道（含明文令牌与隧道私钥）', on: true, secrets: true, plainSecrets: true,
    src: [{ root: 'data', entries: ['channels.json', 'tunnel.json', 'tunnel_key', 'tunnel_key.pub'] }] },
  { id: 'skills', label: '技能', on: true, src: [{ root: 'skills', entries: ['*'] }] },
  { id: 'presets', label: '角色与预设', on: true, src: [{ root: 'data', entries: ['agent-presets', 'teams'] }] },
  { id: 'tasks', label: '定时任务', on: true, src: [{ root: 'data', entries: ['scheduled-tasks.json'] }] },
  /* ★ 0921（用户问"新增的便签内容导出时能导出吗"）：原来 DATA_PARTS 里**没有 notebook.json**
     ⇒ 便签压根不在导出/导入范围内。便签是"用户与 AI 共用的待办本"，属于用户数据，必须能带走。 */
  { id: 'notebook', label: '便签', on: true, src: [{ root: 'data', entries: ['notebook.json', 'notebook-assets'] }] },
  { id: 'workspaces', label: '对话工作区文件', src: [{ root: 'storage', entries: ['chat_*'] }] },
  { id: 'releases', label: '版本快照', src: [{ root: 'data', entries: ['releases'] }] },
]

/** 包指纹：文件名 + 体积 + 导出时间 —— 用来判断"这份包我之前导过哪几部分" */
function pkgFingerprint(zipPath: string, size: number, exportedAt: string): string {
  return path.basename(zipPath) + '|' + size + '|' + exportedAt
}
function importHistoryPath(): string {
  return path.join(DATA_ROOT, 'import-history.json')
}
function readImportHistory(): Record<string, { at: number; parts: Record<string, number> }> {
  try { return JSON.parse(fs.readFileSync(importHistoryPath(), 'utf8')) } catch { return {} }
}
function writeImportHistory(h: Record<string, any>): void {
  try { fs.writeFileSync(importHistoryPath(), JSON.stringify(h, null, 2), 'utf8') } catch { /* ignore */ }
}
/** 递归复制（保留目录结构；不跟随符号链接） */
function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) copyTree(s, d)
    else fs.copyFileSync(s, d)
  }
}

/** 备份时间戳：20260915-003012 */
function backupStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/* ── 存储目录迁移（0913）：设置→通用→存储目录 切换时的三选项 ──
 * 存储根 = globalSettings.storagePath（**只放聊天工作区 chat_* 这类东西**）。
 * ⚠️ 0919 起：记忆/知识库 DB 与知识库附件**都不再跟着存储目录走** —— 它们在各自应用自己的
 *   目录里（打包版 %APPDATA%\nis\memory，dev = <数据根>/memory）+ <数据根>/knowledge-attachments。
 * move：先停记忆桥（它可能正开着别处的库）→ 拷贝 → 删旧 → 改写会话 workDir 前缀 → 重启桥。
 */

/** 缺省存储根：<用户主目录>/Documents/NisData。
 *  0917 修：此前写死 'C:/Users/Administrator/...' —— 换用户名/换机就指到不存在的目录。 */
function defaultStorageRoot(): string {
  /**
   * 0918：默认值改成 **`<数据根>/storage`**（原来是 `%USERPROFILE%\Documents\NisData`）。
   * 原因：那个默认值**与实例无关** —— 源码 dev 和打包版都没设过存储目录时，
   * 两边会算到同一个 `Documents\NisData` → 两个实例的聊天工作区互相盖。
   * （0919 起记忆/知识库已经彻底不跟存储目录走了，这条只关乎工作区。）
   * 现在跟着 `<数据根>`（dev = backend/data，打包版 = 各自的数据目录）→ 默认状态也不撞车。
   * 用户显式选过存储目录的，仍然尊重用户的选择（不改动已有配置）。
   */
  return path.join(DATA_ROOT, 'storage')
}
/** 当前存储根 */
function storageRootNow(): string {
  const p = String((globalSettings as any).storagePath || '').trim()
  return p || defaultStorageRoot()
}

/** 目录安全检查：绝对路径、非盘根、不与 NIS 程序目录互相包含 */
function assertSafeStoragePath(dir: string, label: string): string {
  if (!path.isAbsolute(String(dir || ''))) throw new Error(`${label}必须是绝对路径`)
  const abs = path.resolve(dir)
  if (path.parse(abs).root === abs) throw new Error(`${label}不能是盘根目录`)
  const within = (a: string, b: string) => a === b || a.startsWith(b + path.sep)
  if (within(abs, PROJECT_ROOT) || within(PROJECT_ROOT, abs)) throw new Error(`${label}不能与 NIS 程序目录互相包含`)
  return abs
}

/** 是否是「重解析点」（Windows junction / 符号链接 / OneDrive 占位）。
 *  0917 修（EPERM 根因）：用户主目录下的 Documents\My Music、Application Data 等
 *  是老式 junction —— 递归 copyFileSync / rmSync 会 EPERM，甚至误删链接目标里的内容。 */
function isReparsePoint(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
}

/** 目录统计（递归文件数 / 递归目录数 + 递归字节数；跳过重解析点，避免统计到链接目标/报 EPERM）
 *  ⚠️ 0920：`files` / `dirs` 都是**递归**的（`entries` 仍只数顶层项，别混用）——
 *     导出进度条拿 `files + dirs` 当分母（tar -v 连目录也打一行，只数文件会少算一成多），
 *     旧版拿顶层项数当分母会把 2 万条目的大包算成几十，进度秒冲到 99% 然后假死。 */
function dirStats(dir: string): { exists: boolean; entries: number; files: number; dirs: number; bytes: number } {
  try {
    if (!fs.existsSync(dir)) return { exists: false, entries: 0, files: 0, dirs: 0, bytes: 0 }
    const top = fs.readdirSync(dir)
    let bytes = 0
    let files = 0
    let dirs = 0
    const walk = (d: string) => {
      let es: fs.Dirent[] = []
      try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        const p2 = path.join(d, e.name)
        if (e.isSymbolicLink() || isReparsePoint(p2)) continue
        if (e.isDirectory()) { dirs++; walk(p2) }
        else { try { bytes += fs.statSync(p2).size } catch { /* ignore */ } files++ }
      }
    }
    walk(dir)
    return { exists: true, entries: top.length, files, dirs, bytes }
  } catch { return { exists: false, entries: 0, files: 0, dirs: 0, bytes: 0 } }
}

async function storageMigrateDirect(from: string, to: string, mode: string): Promise<any> {
  const src = assertSafeStoragePath(from, '原目录')
  const dst = assertSafeStoragePath(to, '新目录')
  if (src === dst) throw new Error('新旧目录相同')
  if (dst.startsWith(src + path.sep)) throw new Error('新目录不能位于原目录内部')
  if (!fs.existsSync(src)) return { ok: true, moved: 0, log: '原目录不存在，已直接切换' }
  if (!['keep', 'move', 'delete'].includes(mode)) throw new Error('mode 非法（keep|move|delete）')
  if (mode === 'keep') return { ok: true, moved: 0, log: '原位置保留（未做任何文件操作）' }

  // 只有操作「当前存储根」才需要停/启记忆桥；其它目录（自测场景）纯文件操作
  const isCurrentRoot = path.resolve(src) === path.resolve(storageRootNow())
  const log: string[] = []
  if (isCurrentRoot) {
    try { memoryBridge.stop(); log.push('已暂停记忆桥（释放数据库句柄）') } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300))
  }

  let moved = 0
  try {
    /** 0917 修（EPERM）：① 跳过重解析点（junction/符号链接，如 Documents\My Music）
     *  —— copyFileSync 对链接必 EPERM，rmSync 递归还会误删链接目标里的内容；
     *  ② 单个文件失败不再中断整次迁移，记入 skipped 继续搬。 */
    const removeDeep = (target: string) => {
      for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        const p2 = path.join(target, e.name)
        if (e.isSymbolicLink()) { try { fs.unlinkSync(p2) } catch { /* ignore */ } continue }
        if (e.isDirectory()) removeDeep(p2)
        else { try { fs.unlinkSync(p2) } catch { /* ignore */ } }
      }
      try { fs.rmdirSync(target) } catch { /* ignore */ }
    }

    if (mode === 'move') {
      fs.mkdirSync(dst, { recursive: true })
      let skipped = 0
      const copyRec = (s: string, d: string) => {
        let entries: fs.Dirent[] = []
        try { entries = fs.readdirSync(s, { withFileTypes: true }) } catch (e: any) {
          skipped++; log.push(`跳过不可读目录：${path.relative(src, s)}（${e?.code || e?.message}）`)
          return
        }
        for (const e of entries) {
          const sp = path.join(s, e.name)
          const dp = path.join(d, e.name)
          if (e.isSymbolicLink()) { skipped++; log.push(`跳过链接：${path.relative(src, sp)}`); continue }
          if (e.isDirectory()) {
            if (isReparsePoint(sp)) { skipped++; log.push(`跳过系统链接目录：${path.relative(src, sp)}`); continue }
            fs.mkdirSync(dp, { recursive: true }); copyRec(sp, dp)
          }
          else if (!fs.existsSync(dp)) {
            try { fs.copyFileSync(sp, dp); moved++ }
            catch (err: any) { skipped++; log.push(`跳过（${err?.code || 'ERR'}）：${path.relative(src, sp)}`) }
          }
          else log.push(`跳过已存在：${path.relative(dst, dp)}`)
        }
      }
      copyRec(src, dst)
      // 删除旧目录（自写遍历：遇到链接只删链接本身，不递归进目标）
      /* ★0927 netfix：只删"搬运成功/目标已有"的项 —— 原实现无条件 removeDeep(src) 会把
         复制失败/被跳过（还没搬走）的文件一并删掉＝丢数据；现在它们留在旧目录并在日志里点名。 */
      let remain = 0
      const removeCopied = (s2: string) => {
        let ents: fs.Dirent[] = []
        try { ents = fs.readdirSync(s2, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
          const sp = path.join(s2, e.name)
          const rel = path.relative(src, sp)
          const dp = path.join(dst, rel)
          if (e.isSymbolicLink()) { if (fs.existsSync(dp)) { try { fs.unlinkSync(sp) } catch { remain++ } } else { remain++; log.push(`保留在旧目录（未搬走的链接）：${rel}`) } continue }
          if (e.isDirectory()) {
            if (isReparsePoint(sp)) { if (fs.existsSync(dp)) { try { fs.rmdirSync(sp) } catch { remain++ } } else { remain++; log.push(`保留在旧目录（系统链接目录）：${rel}`) } continue }
            removeCopied(sp)
            try { fs.rmdirSync(sp) } catch { remain++ }
          } else if (fs.existsSync(dp)) {
            try { fs.unlinkSync(sp) } catch { remain++ }
          } else { remain++; log.push(`保留在旧目录（未搬走）：${rel}`) }
        }
      }
      removeCopied(src)
      let dirGone = true
      try { fs.rmdirSync(src) } catch { dirGone = false }
      log.push(`已搬运 ${moved} 个文件${skipped ? `、跳过 ${skipped} 个链接/不可读项` : ''}${remain ? `；${remain} 个未搬走的项已保留在旧目录（请手动处理）` : (dirGone ? '，旧目录已移除' : '；旧目录非空已保留')}`)
      let fixed = 0
      for (const s of sessions.values()) {
        const wd = String(s.workDir || '')
        if (wd && (wd === src || wd.startsWith(src + path.sep) || wd.startsWith(src + '/'))) {
          s.workDir = dst + wd.slice(src.length)
          fixed++
        }
      }
      if (fixed) { schedulePersist(); log.push(`已更新 ${fixed} 个会话的工作区路径`) }
    } else if (mode === 'delete') {
      const before = dirStats(src)
      /* ★0927 netfix：用自写 removeDeep（链接/目录联接只删链接本身）——
         rmSync 递归删遇到目录联接会把链接目标一并清掉（与 removeDeep 的 0924 教训同源）。 */
      removeDeep(src)
      log.push(`已删除旧目录全部内容（${before.entries} 项）`)
    }
  } finally {
    if (isCurrentRoot) {
      try { memoryBridge.start(); log.push('记忆桥已重启') } catch { /* ignore */ }
    }
  }
  return { ok: true, moved, log: log.join('\n') }
}

/** ★1012t 收尾：这些来源（origin）的会话，**通道没单独配模型**时走「后台模型」。
 *  只列 QQ/微信 —— 设计口径就是这两个渠道；remote（/pc 接管 PC 会话）与 scheduled（定时任务）
 *  是另一套语义，未纳入（要扩口径再拍板）。 */
const BACKGROUND_LLM_ORIGINS = new Set(['qq', 'wechat'])

/** 0923：会话实际模型的唯一解析口 —— 治多窗口串台（实录：A 窗口切模型改全局 active，
 *  B 窗口 llmOverride 为 null（只在"前端传 model 参数/通道配置"时才建）→ 发送/窗口/视觉闸门
 *  全裸奔 currentLlmConfig()，B 会话被 A 窗口的模型+窗口大小污染，压缩线误触）。
 *  优先级：llmOverride（显式覆盖）> session.model+modelProviderId（会话持久化选择，建会话即记）
 *  > null（调用方自行兜底全局）。 */
/** ↓ resolveSessionLlm（解析口）的返回形状。isBackground=true = 本轮用的是「后台模型」（通道会话未单独配模型 → 走它），
 *  调用方据此把失败报成"后台模型失败"通知（见 createStreamFn 的 failMsg 钩子）。 */
type ResolvedSessionLlm = { providerId: string; providerName: string; base: string; apiKey: string; model: string; protocol?: string; isBackground?: boolean; effort?: string | null; /** ★1013：渠道会话"该走后台模型但没配"的显式失败态（调用方报错+提醒，不许回落） */ needsBackgroundSetup?: boolean; reason?: string }

function resolveSessionLlm(sessionId: string): ResolvedSessionLlm | null {
  const s = sessions.get(sessionId)
  if (!s) return null
  const ov = s.llmOverride
  if (ov?.model && ov?.base) return ov
  /* ★1012t 收尾（设计口径：**QQ/微信渠道未单独配模型时走「后台模型」**）。
     为什么判据不能看 s.model：`createSession` 会把**当时的全局模型快照**写进 s.model（4610 附近），
     所以通道会话"s.model 有值"≠ 用户选过模型 —— 这里只认通道配置本身（modelForChannel：bot 级 > 通道级）。
     三条安全线：① 通道/机器人自己配了模型 → 本分支跳过，走下面原有的 s.model / llmOverride 路径（显式配置优先）；
     ② 用户在 PC 里手选过模型（llmOverrideBy='user'，必写 llmOverride）→ 上面第一行已返回，不受影响；
     ③ 后台模型没配置 → **不回落聊天模型**：返回 needsBackgroundSetup 的显式失败态，由调用方报错+提醒（★1013 已定案）。 */
  const _origin = String(s.origin || '').trim()
  if (BACKGROUND_LLM_ORIGINS.has(_origin) && !String(modelForChannel(_origin, String(s.originBot || '')).modelId || '').trim()) {
    const bg = backgroundLlmConfig()
    if (bg.configured) {
      return { providerId: bg.providerId, providerName: bg.providerName, base: bg.base, apiKey: bg.apiKey, model: bg.model, protocol: bg.protocol, effort: bg.effort, isBackground: true }
    }
    /* ★1013（已定案）：后台模型没配 ⇒ **不回落聊天模型**（"想用免费模型做后台活，回落却跑到贵模型上=偷钱"）。
       返回"需要配置"的显式失败态 → createStreamFn 报明确错误 + 弹系统通知，逼用户去设置里选一个。 */
    return { providerId: '', providerName: '', base: '', apiKey: '', model: '', needsBackgroundSetup: true, reason: bg.reason }
  }
  const mid = String(s.model || '').trim()
  const pid = String(s.modelProviderId || '').trim()
  if (mid && pid) {
    const p = getState().providers.find(x => x.id === pid)
    /* ★ 1001：这里必须取**明文**。原写法 `apiKey: p.apiKey` 直接读落盘值（= DPAPI 密文），
       而本函数在 createStreamFn 里排在 currentLlmConfig() **之前** ⇒ 只要会话选过模型（常态），
       就永远带着密文发请求 ⇒ 一发消息 401，而设置里"测试连接"（走 plainKey）却能通。
       —— 这就是 1001「测试能通、发消息就 401」的根因。别再直接读 p.apiKey。*/
    if (p) return { providerId: p.id, providerName: p.name || p.id, base: p.base || '', apiKey: plainKeyById(p.id), model: mid }
  }
  return null
}

/** ★ 0929 刀②：每会话已加载的低频能力包（load_tools 标记；决定请求级工具表发不发说明书） */
const lazyLoadedBySession = new Map<string, Set<string>>()
function createStreamFn(systemPrompt: string, sessionId: string, opts?: { llmOverride?: ModelOverride; effort?: string; signal?: AbortSignal; sub?: boolean; /** 0911 反馈3：成员子流归因名（日志前缀） */ actor?: string; /** 0911 反馈3：子流重试事件透传（前端过程块显示报错/重连） */ onStreamNote?: (note: { kind: string; attempt: number; reason: string }) => void }) {
  return (
    _model: unknown,
    context: { messages: AgentMessage[]; systemPrompt?: string; tools?: any[] },
    config?: { signal?: AbortSignal },
  ): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream()

    void (async () => {
      // 兜底 catch：网关中途断流/解析异常曾导致 unhandled rejection——stream 永不 end，
      // agent 静默挂死（"话说一半就没下文"的根因）。任何异常都要推 error 并收流
      try {
      // 信号桥接（铁律 21）：pi 的 abort signal 在 streamFn 第三参 config.signal 里（session.cancel →
      // agent.abort → pi signal），opts.signal 是子 agent 的中断控制器（ac.abort）。二者任一触发都要断流
      // ——包装层不得丢弃 config（0831 晚实锤：丢弃导致点停止后子 agent 继续跑）
      const signals = [opts?.signal, config?.signal].filter(Boolean) as AbortSignal[]
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

      // 会话级模型覆盖优先（安装助手用全局模型/团队成员独立模型）；否则动态读取当前供应商/模型配置
      // ★ 0923：模型解析链 = 本次调用显式 override > 会话解析口（llmOverride > session.model 持久化选择）> 全局。
      //   旧代码 llmOverride 为 null 时直接裸奔全局 —— 另一窗口切全局模型会把本会话的模型/窗口大小带跑（串台实录）
      /* ★ 0923（本窗口修复）：那次「多窗口模型串台」refactor 把 override 的定义删了，但下面 overrideEffort
         仍在用它（思考强度优先级 ②：定时任务 applyTaskModel 钉的档）⇒ tsx 不做类型检查，启动不报，
         一发消息就 ReferenceError。这里把定义加回来（与重构前逐字一致），不动上面那条新解析链。 */
      const override = opts?.llmOverride || sessions.get(sessionId)?.llmOverride
      const llmCfg = (opts?.llmOverride && opts.llmOverride.base && opts.llmOverride.model ? opts.llmOverride : null)
        || resolveSessionLlm(sessionId)
        || currentLlmConfig()
      const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      /* ★ 1001（需求要求：错误要"看得见"）：错误消息带一个机器可识别标记，
         前端据此渲染成**红色错误卡片 + 重试按钮**，而不是混在 AI 正文里看不出是报错。
         为什么用**文本标记**而不是把 errorMessage 透传成节点字段：
         文本标记对「实时流」和「历史恢复」两条链路**天然一致** —— 若走字段，必须两条链路都透传，
         漏一条就会出现"刷新页面后错误卡片变回普通文本"这种最糟的退化。 */
      const NIS_ERR_MARK = '[NIS-ERR]'
      /* ★1012t 收尾：本轮的失败出口**都**经过 failMsg ⇒ 在这里挂"后台模型失败 → 系统通知"的钩子。
         只在 ① 本轮确实用的是后台模型（isBackground：通道会话未单独配模型 → 走它）
         且 ② 不是主动中止（用户点停止 / 审批超时：stopReason='aborted' 或文本含 [aborted]）时发。
         同类错误 60 秒防刷屏在 notifyBackgroundModelFailure 里（与提炼侧共用同一条通道）。 */
      const failMsg = (text: string, stopReason: 'error' | 'aborted' = 'error') => {
        try {
          if (stopReason === 'error' && (llmCfg as any)?.isBackground === true && !/\[aborted\]/.test(text)) {
            notifyBackgroundModelFailure('渠道对话（后台模型）', text)
          }
        } catch { /* 通知失败不影响主流程 */ }
        return {
          role: 'assistant' as const,
          content: [{ type: 'text', text: `${NIS_ERR_MARK}${text}` }] as any,
          api: 'openai-completions',
          provider: llmCfg?.providerId || 'unknown',
          model: llmCfg?.model || 'unknown',
          usage: zeroUsage,
          stopReason,
          errorMessage: text,
          timestamp: Date.now(),
        }
      }
      const fail = (text: string) => {
        sessionLog(sessionId, 'error', 'llm', text)
        stream.push({ type: 'error', reason: 'error', error: failMsg(`[${text}]`) })
      }
      if (!llmCfg.base || !llmCfg.model) {
        /* ★1013（已定案）：QQ/微信渠道会话"该走后台模型但后台模型没配"⇒ 明确报错 + 弹通知，
           **绝不回落聊天模型**（"想用免费模型做后台活，回落却跑到贵模型上 = 偷钱"）。 */
        if ((llmCfg as any)?.needsBackgroundSetup) {
          const why = String((llmCfg as any)?.reason || '未配置「后台模型」')
          notifyBackgroundModelFailure('渠道对话（后台模型）', why)
          fail(why)
          return
        }
        fail('LLM config error: 未配置供应商/模型，请在设置中选择')
        return
      }
      // 未配 API Key 且非本地服务（ollama 等）→ 明确报错，避免晦涩的 missing_api_key
      const isLocalBase = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(llmCfg.base)
      if (!llmCfg.apiKey && !isLocalBase) {
        fail(`LLM 错误: 供应商「${llmCfg.providerName}」未填写 API Key，请到 设置 → 供应商 中填写`)
        return
      }
      /* ★ 1001 防复发闸门 —— 这条是写給"以后"的：
         落盘的 key 一律是 DPAPI 密文（enc:v1:dpapi:…），而 llmOverride / 各种解析口只要有一处
         漏了解密，上游就会收到一串密文并回 401「无效的AppId: enc:v1:dpapi:…」—— 用户完全无从自查
         （1001 实测就漏了 8 处，症状正是"设置里测试连接能通、一发消息就 401"）。
         所以在这里当场拦：先按 providerId 自愈重取明文（历史 llmOverride 里可能存着密文，
         本进程内即可恢复，不必重启）；取不到就**明说这是代码缺陷**。
         铁律：宁可响亮地失败，也绝不放一串密文出去。*/
      if (isEncrypted(llmCfg.apiKey)) {
        let fixedKey = ''
        try { fixedKey = llmCfg.providerId ? plainKeyById(String(llmCfg.providerId)) : '' } catch { /* 交由下面统一报错 */ }
        if (fixedKey) {
          sessionLog(sessionId, 'info', 'llm', `检测到即将发往上游的 API Key 是未解密的密文（历史 llmOverride 残留），已按供应商「${llmCfg.providerId}」重新取明文`)
          ;(llmCfg as any).apiKey = fixedKey
        } else {
          fail('LLM 错误: 即将发送的 API Key 是未解密的密文 —— 这是 NIS 的代码缺陷，不是你的 key 有问题。请重启后端；若仍复现，请把这条消息发给开发排查（"测试连接能通、发消息却 401"就是本症状）')
          return
        }
      }

      // 思考强度：仅推理模型附加 reasoning_effort（per-session：从会话读窗口隔离；子 agent 固定默认档 opts.effort）
      // 0909⑤：能力真相源 resolveModelCaps（三轴字段>capabilities>模型名兜底）——
      // 原 reasoning 双源（capReasoning+isReasoningModel）与 input 硬编码 ['text','image'] 一并废除，
      // 纯文本模型现在如实上报 input=['text']，网关 payload 不再携带 image
      const caps = resolveModelCaps(llmCfg.providerId, llmCfg.model)
      // 0910：推理挡位按模型声明钳位（resolveModelEfforts：显式 efforts > zai 系去 medium > 全四挡；
      // 非推理模型=[] 不发参数）。替换昨日 zai 硬编码——显示（前端下拉只列可用挡）与发送（此处钳位）
      // 同一份声明，不再有"UI 能选 medium、网关拒 medium"的错位。
      // F轮 2026-09-12：优先级 —— ① 显式 opts.effort（子 agent 固定档）> ② 会话覆盖里的 effort
      // （定时任务 applyTaskModel 钉的全局/自选强度就落在这里）> ③ 会话 effort > ④ 全局 activeEffort
      // （非对话场景口径）> ⑤ 默认 deep。
      const overrideEffort = (override && typeof (override as any).effort === 'string') ? String((override as any).effort) : ''
      /* ★1013：优先级里补一档「模型自带强度」—— 后台模型可以有自己的强度设置（需求要求"后台模型也能自由选强度"）。
         位置：会话强度之后、全局聊天强度之前 —— 用户在会话里显式选过强度就听会话的，否则听模型的。 */
      const rawEffort = opts?.effort || overrideEffort || sessions.get(sessionId)?.effort || (llmCfg as any)?.effort || activeEffort() || 'deep'
      const clampedEffort = clampEffort(llmCfg.providerId, llmCfg.model, rawEffort)
      if (clampedEffort !== rawEffort && !opts?.sub) {
        sessionLog(sessionId, 'info', 'llm', `思考挡位「${rawEffort}」不在模型「${llmCfg.model}」可用清单，已钳到「${clampedEffort || '无（不发该参数）'}」`)
      }
      const effort = mapEffort(clampedEffort || '', String(llmCfg.base || ''))
      const isLongCat = /longcat/i.test(llmCfg.providerId) || /longcat/i.test(llmCfg.base)
      // 0910 协议扩展：供应商 protocol 决定走哪套 pi-ai 适配器（缺省 openai-completions=旧行为零变化）。
      // anthropic-messages / google-generative-ai 用库自带适配器直连官方原生协议（Key/base 同页配置）。
      const protocol = (llmCfg as any).protocol || 'openai-completions'
      const piModel: PiModel<'openai-completions'> = {
        id: llmCfg.model,
        name: llmCfg.model,
        api: protocol as any,
        provider: llmCfg.providerId as any,
        baseUrl: llmCfg.base,
        reasoning: caps.reasoning,
        input: caps.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: resolveContextWindow(llmCfg.providerId, llmCfg.model),
        // 0917：单次输出上限按模型真实值取（显式 maxOutput > models.dev limit.output > 16384，兜底档钳到窗口）
        maxTokens: resolveMaxOutput(llmCfg.providerId, llmCfg.model),
        // LongCat 显式兼容档（对齐手写版行为）：不发 store 字段 / 保持 system 角色 / 沿用 max_tokens 字段
        // 0909 ③：supportsDeveloperRole 一律关——pi-ai 对推理模型默认发 role:"developer"，
        // b.ai 网关实锤 400「角色信息不正确」（system 同请求正常，developer 必挂；agnes/智谱兼容 developer）。
        // system 角色全网关通用，OpenAI 官方也收，没有厂商需要强制 developer——统一关最稳。
        // 0910 缓存：sendSessionAffinityHeaders=true——OpenAI 文档实锤缓存条目按机器存储
        // （"looking for an available matching prefix already cached on the machine"），
        // 多机网关不带亲和头=请求随机落机→缓存互不可见（74.8% 命中的主要天花板之一）。
        // pi-ai 默认关；开启后发 session_id/x-client-request-id/x-session-affinity 三头（Codex 同款），
        // 不识别的网关直接忽略未知头，零风险。
        // 仅 openai-completions 有这套 compat；anthropic/google 走各自原生档（compat 字段形态不同，硬塞会串）。
        compat: protocol === 'openai-completions'
          ? { ...(isLongCat ? { supportsStore: false, maxTokensField: 'max_tokens' as const } : {}), supportsDeveloperRole: false, sendSessionAffinityHeaders: true }
          : protocol === 'anthropic-messages'
            ? { sendSessionAffinityHeaders: true }
            : undefined,
      }

      // 供应商级代理：该供应商配了 proxyUrl 才注入代理 fetch，否则默认直连（零回归）
      const _prov = getState().providers.find(x => x.id === llmCfg.providerId) as any
      const _proxyUrl = String(_prov?.proxyUrl || '').trim()
      const _proxyFetch = _proxyUrl && /^https?:\/\//i.test(_proxyUrl) ? makeProxiedFetch(_proxyUrl) : undefined

      // ── C3 上下文压缩（请求期非破坏式）：产出"发给模型的消息视图"，原始 context.messages / transcript 不动 ──
      // 子流（成员派发/单聊）跳过：成员上下文由单聊记录自管且极短，压缩主会话摘要/存档/通知都不该被成员请求触发（0904）
      let requestMessages: any[] = (context?.messages || []) as any[]
      const _s = sessions.get(sessionId)
      /* ★ 0923（核心修复 · 压缩视图必须**持久应用**）——
         旧行为：把较早消息折成摘要，只作用在**触发压缩的那一次请求**上（视图是那次请求的局部变量）；
         工具循环的后续请求会重新从 `context.messages` 取全量 → **摘要等于白做**。
         实测（turnMetas 实锤）：压缩后第一次请求 12 万，同一个 turn 的下一次请求又回到 36 万，
         压缩前 35.9% → 压缩后 36.5% 几乎没降；圆环也从"压缩后 12%"跳回 36% ——
         用户看到的"上一轮 12%、一发消息就 36%"就是这个。
         现在：只要本会话已有摘要（`summaryStartIndex > 0`），**每次请求都持续应用该视图**
         （摘要消息 + 其后的原始消息），直到下一次压缩把 `summaryStartIndex` 往后推。
         注意 `summaryStartIndex` 一律记**原始消息索引**（见下方压缩处的换算），视图索引只在本次请求内用。 */
      const _sumBaseIdx = _s ? Math.max(0, Number((_s as any).summaryStartIndex) || 0) : 0
      /* ★ 0925j（实测"上下文 65→89.8 暴涨"）：summaryStartIndex 记的是**压缩时的原始绝对索引**，
         但持久化/重启后 agent 装配出的 messages 可能就是"保留段"（实测 58 条 < 索引 1302）——
         旧条件 `_sumBaseIdx < requestMessages.length` 判 false ⇒ 摘要视图整个不应用、58 条全量
         （343 个全量工具结果）当新上下文 → 估算暴涨；2925 的"索引失效作废"更把唯一存着早期
         内容的摘要扔掉。现在：索引 ≥ 当前条数 ⇒ 当前数组**就是保留段** ⇒ 视图 = [摘要] + 全部。 */
      const _viewSliced = _sumBaseIdx < requestMessages.length
      const _applySummaryView = !!(_s && !opts?.sub && _sumBaseIdx > 0 && _s.contextSummary && (_viewSliced || requestMessages.length > 0))
      if (_applySummaryView) {
        /* ★0927（真机对账抓到的"撒谎文本"）：保留段模式（索引 ≥ 当前条数，重启后 agent 数组
            与压缩时不同坐标系）下，`_sumBaseIdx` 是**旧坐标系的索引**（实测 1261 vs 实际 100 条），
            原样写进文本等于对模型/用户撒谎"较早的 1261 条已压缩"。切段模式才报真实条数；
            保留段模式只说"较早的对话已压缩"，数字交给归档文件说话。 */
        const _foldedText = _viewSliced
          ? `较早的 ${_sumBaseIdx} 条消息已压缩为摘要`
          : '较早的对话已压缩为摘要'
        const _viewMsg = {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: `【系统提示：${_foldedText}${_s!.compactArchiveRel ? `，原文见 ${_s!.compactArchiveRel}（需要时用 fs_read 回看）` : ''}】\n【摘要】\n${_s!.contextSummary}` }],
        }
        requestMessages = [_viewMsg, ...(_viewSliced ? requestMessages.slice(_sumBaseIdx) : requestMessages)]
      }
      /* ★ 0923（P2-a · 抄 dsh 的"先剪枝、再复测"）：**裁剪提前到压缩判定之前** ——
         先把零成本能省的都省掉（工具结果 / 早期图片 / 早期思考），再拿剪枝后的视图去判定是否真需要压缩。
         若剪完已回到触发线以内 → 整轮都不调摘要模型（省一次模型调用，全场性价比最高的一步）。
         顺带一个好处：判定 / 圆环 / 真正发出去的内容，三者口径彻底一致。 */
      let _ctxFullCount = requestMessages.length   // 发送时的**全量**条数（裁剪不改条数；压缩后用它做增量基准）
      let _pruneInfo: { changed: number; savedChars: number } = { changed: 0, savedChars: 0 }
      {
        /* ★1012g：**每轮都裁，但不再挑时机** —— 裁剪规则已与轮次/时间无关（幂等）：
           同一份工具输出无论在第几轮都裁成同一文本 ⇒ 历史一旦裁过就逐字节不变 ⇒ 前缀缓存永不打散。
           所以这里可以放心无条件调用：第一次裁完，之后每轮 changed=0（只是白算一遍，纯 CPU）。
           历史包袱（两轮实测教训）：1012e 按"距上轮 >6 小时才裁"挑时机 → 被证伪（热轮不裁会积攒，
           冷轮一次性裁好几轮 = 改写点跑到很前面，实测冷轮首跳只剩 3.5%）；更早的滑动窗口版则
           每轮都有一格改变身份 → 每轮白丢 2.8~5 万 token 命中（全库轮首跳只有 83.2%）。 */
        const _tr = pruneToolOutputs(requestMessages, {
          headLines: CTX_TOOL_HEAD_LINES, tailLines: CTX_TOOL_TAIL_LINES,
        })
        if (_tr.changed) {
          requestMessages = _tr.messages
          _pruneInfo = { changed: _tr.changed, savedChars: _tr.savedChars }
        }
        /* ★1012k：请求指纹（探针）—— 记录本次真正要发的 messages 结构，用于定位"重启后第一轮
           固定丢 4.6 万 token"到底是哪一段变了。详见 logRequestFingerprint 注释。 */
        logRequestFingerprint(sessionId, requestMessages)
      }
      if (_s && !opts?.sub && globalSettings.contextCompaction !== false) {
        try {
          const _all = requestMessages
          const _win = resolveContextWindow(llmCfg.providerId, llmCfg.model)
          // 0921：统一估算口径（含工具定义 + 导入数据的块名）→ 再用上一轮真实 usage 校准
          const _est = estimateRequestTokens(context?.systemPrompt || systemPrompt, context?.tools || [], _all)
          const _cal = ctxCalibrationRatio(_s)
          const _estCal = Math.round(_est * _cal.ratio)
          /* ★ 0923（已定案 A）触发判定与界面圆环**同源**：占用 = 上一轮真实 usage + 此后新增消息的估算。
             · 纯用"估算 × 校准"会虚高 —— 实测 85.5 万 vs 真实 30 万，导致"圆环才 30% 就压缩"；
             · 纯用"上一轮真实"会滞后 —— 本轮读了大文件（新增几十万 token）时会漏判。
             增量只估算"上轮之后新增的那几条"，量小、误差可控；算完回报给圆环（session.context）。 */
          const _prevReal = ctxUsedTokens(_s)
          /* ★ 0923（P0 修 · 增量基准错位）：旧版拿 `lastSentMsgCount`（**实际发出的条数**）
             去切 agent 的**全量消息数组** —— 压缩后视图条数（如 340）远小于全量（如 1050），
             切出来的正是"已经折叠进摘要的历史"，等于把折掉的量又算回来一遍
             （实测吻合：1,461,102 ≈ 798,096 + 663,006）→ 每轮都判超线、每轮白压一次。
             现在优先用 `lastSentFullCount`（发送时的全量条数），两边坐标系一致；
             老数据（只有 lastSentMsgCount）在"已压缩过"时不可信 → 增量按 0 处理（保守、不虚高）。 */
          /* ★ 0923：视图已**持久应用**（见上方 _applySummaryView）→ 增量基准就用"本次发送视图的条数"
             （`lastSentFullCount`/`lastSentMsgCount` 现在都记视图条数，两者天然对齐：
             视图 = [摘要] + 原始.slice(idx)，只要 idx 不变，视图条数增长 = 原始消息增长）。 */
          /* 0928 T4c B3: while a post-compaction anchor is active its own view length is the ONLY
             valid incremental base —— lastSentFullCount belongs to the PRE-compaction view: slicing
             the new shorter view with it misses the new messages (base > view) or double counts kept
             ones already inside the anchor estimate (base <= view). viewCount is stamped at anchor
             creation (manual + auto) and retires with the anchor. */
          const _ovViewCountM = Number((_s as any)?.ctxUsedOverride?.viewCount) || 0
          const _prevSentCount = _ovViewCountM > 0 ? _ovViewCountM : (Number((_s as any)?.lastSentFullCount) || Number((_s as any)?.lastSentMsgCount) || 0)
          let _used = _prevReal
          if (_prevReal > 0 && _prevSentCount > 0 && _prevSentCount <= _all.length) {
            _used = _prevReal + estimateRequestTokens('', [], _all.slice(_prevSentCount) as any[])
          } else if (_prevReal <= 0) {
            _used = _estCal
          }
          _used = Math.round(_used)
          /* ★ 0923：本轮裁剪省下的 token（"裁剪前 ≈ 判定值 + 省下量"的口径，供短路判定与日志用） */
          const _pruneSavedTok = Math.round(_pruneInfo.savedChars / 2.2)
          /* ★ 0923：压缩前视图的估算（含 system/tools，与真实 usage 同口径）—— 供压缩后"锚点按比例缩放"用 */
          /* ★0926 B4：此处原是 `estimateRequestTokens(...)` 同参**再算一遍全量**（与上方 _est 完全同入参：
             同一裁剪后 _all、同一 sys/tools），纯白工 —— 直接复用 _est（未校准原值，供压缩后锚点按比例缩放）。 */
          const _estBeforeRaw = _est
          try { (_s as any).ctxUsedForRing = _used } catch { /* ignore */ }
          // 0910：触发阈值 / 留存比例改为可在设置·通用里配（缺省 80% 触发、留存 35%，与旧硬编码一致）
          /* ★ 0923（已定案）：滑块上限 95 → **80** —— 与"输出预留天花板 = 窗口×20%"自洽：
             触发压缩时窗口总共还留着 20% 给输出，不会被动态让位挤到只剩几万。
             下限 30 不变。 */
          const _trigPct = Math.min(80, Math.max(30, Number(globalSettings.contextCompactThresholdPct) || 80))
          /* ★ 0923 护栏：留存比例必须**小于**触发阈值，否则"压完还在线上"→ 每轮都疯压
             （例如触发 30% / 留存 90%）。这里静默钳到 trig−5，并在日志里说明生效值。 */
          const _keepPctRaw = Math.min(90, Math.max(10, Number(globalSettings.contextKeepPct) || 35))
          const _keepPct = Math.min(_keepPctRaw, Math.max(10, _trigPct - 5))
          /* ★ 0923（P1-d 保留预算三件套）见下方 `_trigTok` 声明之后 —— 那里才拿得到触发线。
             ⚠️ 血泪：一开始放在这里，直接踩 TDZ「Cannot access '_trigTok' before initialization」，
             每轮请求都抛异常 → 压缩全废 + 界面出现假"已压缩"线（0923 深夜实锤）。 */
          /* 0921：触发线 = **窗口 × 滑块百分比**（30~95 全区间由用户把控，语义=窗口用到多少才压缩）。
             注意"先 400 还是先压缩"这件事**不再靠提前压缩解决** —— 那是 0921 老方案（把线压到死亡线以内，
             代价是 55%~95% 被切平、滑块失效）。现在由发送预算负责：输入占得多，输出预留自动让位，
             所以哪怕滑块设 95%（本机 95 万）也不会撞 400。死亡线只在日志里当参考值。 */
          const _trigTok = ctxTriggerLineTokens(llmCfg.providerId, llmCfg.model, _trigPct)
          /* ★ 0923（P1-d · 保留预算三件套，抄 dsh / hermes）：
             ① **绝对上限**（dsh 是 16%×(W−O)、hermes 是 clamp(2.5%W,10K,25K)）——纯比例制在 1M 窗口下白留 35 万；
             ② **headroom 硬校验**（dsh 在加载期直接拒绝"保留 ≥ 触发线"的配置）——旧版只钳到 trig−5，压完仍在线上；
             ③ 调整写日志，避免"设了 35% 实际留 12%"的静默偏差。
             ⚠️ 必须放在 `_trigTok` 之后 —— 放到前面会踩 TDZ（Cannot access '_trigTok' before initialization）。 */
          const _retainAbsCap = Math.max(20000, Math.round(_win * 0.12))
          const _headroomTok = Math.max(32768, Math.round(_win * 0.05))
          let _retainBudget = Math.min(Math.round(_win * (_keepPct / 100)), _retainAbsCap)
          if (_retainBudget + _headroomTok > _trigTok) {
            const _adj = Math.max(10000, Math.round(_trigTok - _headroomTok))
            sessionLog(sessionId, 'info', 'llm', `保留预算按 headroom 硬校验下调：${_retainBudget} → ${_adj}（触发线 ${Math.round(_trigTok)} − 余量 ${_headroomTok}，滑块留存 ${_keepPct}%）`)
            _retainBudget = _adj
          }
          /* ★ 0921o：冷却期内不再尝试压缩（失败退避）——避免"压不动还每轮撞" */
          const _coolUntil = Number(_s.compactCooldownUntil) || 0
          if (_coolUntil > Date.now()) {
            sessionLog(sessionId, 'info', 'llm', `压缩冷却中（剩余 ${Math.ceil((_coolUntil - Date.now()) / 1000)}s，连续失败 ${Number(_s.compactFailStreak) || 0} 次${_s.compactLastError ? '：' + String(_s.compactLastError).slice(0, 80) : ''}）——本轮跳过压缩`)
          } else if (_win > 0 && _used > _trigTok) {
            sessionLog(sessionId, 'info', 'llm', `上下文压缩触发：占用 ${_used} > 触发线 ${Math.round(_trigTok)}（滑块 ${_trigPct}% × 窗口 ${_win}；估算 ${_est} × 校准 ${_cal.ratio.toFixed(2)} = ${_estCal}、不缩水死亡线 ${ctxDeathLineTokens(llmCfg.providerId, llmCfg.model)} 仅供参考）`)
            // 保留最近的整轮（约 ≤ 窗口 keepPct%），更早的轮折进摘要；切割只落在 role==='user' 边界
            const _turnStarts: number[] = []
            _all.forEach((m, i) => { if (m?.role === 'user') _turnStarts.push(i) })
            let _keepFrom = 0
            if (_turnStarts.length > 1) {
              let _tail = 0
              for (let k = _turnStarts.length - 1; k >= 0; k--) {
                const _end = k + 1 < _turnStarts.length ? _turnStarts[k + 1] : _all.length
                let _seg = 0
                for (let i = _turnStarts[k]; i < _end; i++) _seg += estimateMsgTokens(_all[i])
                /* 0921：留存比例也走**校准后**的口径（与触发线一致）。
                   原来这里只按"字符÷2.2"的裸估算累加 → 估算偏低时（导入类会话 1.41 倍），
                   用户设的"保留最近 35%"在真实 token 口径下其实保留了 ~49%，名不副实。
                   乘上本会话校准系数后，35% 就是真 35%（系数=1 时行为与从前完全一致）。 */
                _seg = Math.round(_seg * _cal.ratio)
                if (_tail + _seg > _retainBudget) { _keepFrom = _turnStarts[k + 1] ?? _turnStarts[k]; break }
                _tail += _seg
              }
            }
            const _older = _all.slice(0, _keepFrom)
            /* 0921：自适应 —— 陈旧索引自愈。
               实测事故：落盘 summaryStartIndex=360，而当时消息只有 53 条（会话被导入/裁剪后索引没跟着重置），
               于是"复用上次摘要"的判断永远失效、每轮都走重算路径。越界就作废重算。
               ★ 0925j（实测"上下文暴涨 + 早期内容退出上下文"）：**保留段场景**（当前数组就是
               压缩保留段、视图已按"摘要+全部"应用）下，索引 > 条数是**正常的**——旧逻辑一律作废摘要，
               等于把唯一存着早期 1302 条内容的浓缩物扔掉。只有"视图没应用且索引越界"才真错位，才自愈重算。 */
            const _retainedSegment = _applySummaryView && !_viewSliced
            if (Number(_s.summaryStartIndex) > _all.length && !_retainedSegment) {
              sessionLog(sessionId, 'warn', 'llm', `压缩索引失效（summaryStartIndex=${_s.summaryStartIndex} > 当前消息数 ${_all.length}）——按当前消息重算，旧摘要作废`)
              _s.summaryStartIndex = undefined
              _s.contextSummary = ''
            }
            if (_older.length >= 2) {
              // 摘要：起始索引与上次一致→复用缓存（工具循环内不重复调用/不重复落盘）；否则增量重算
              let _summary = _s.contextSummary || ''
              let _arcRel: string | undefined = _s.compactArchiveRel
              const _fresh = _s.summaryStartIndex !== _keepFrom || !_summary
              if (_fresh) {
                emitCompactionNotice(sessionId, 'compacting')
                /* 0921：摘要失败**绝不能静默**。原来这里只 console.error → 运行日志里什么都看不到，
                   用户只看到"压缩条转了几下没了"，而 payload 原样发出 → 每轮都顶在窗口边上（实测事故）。
                   现在：① 失败写进运行日志（可见）；② 用占位折叠顶住，保证本次输入真的回落。 */
                /* ★ 0921o（① 并发锁 + ② 失败冷却，抄 Hermes）——
                   ① 同一会话同时只允许一路在生成摘要：多窗口/并发请求时另一路直接用占位折叠顶住，
                      不重复调摘要模型、不重复落盘（旧行为会重复烧钱）。锁带 2 分钟租约，进程崩了也不会永久卡死。
                   ② 失败退避：连续失败不再每轮硬撞，冷却 1 / 5 / 15 分钟后再试（streak 计数每次成功清零）。 */
                if (Number(_s.compactLockUntil) > Date.now()) {
                  sessionLog(sessionId, 'info', 'llm', `压缩进行中（另一路请求持锁，剩余 ${Math.ceil((Number(_s.compactLockUntil) - Date.now()) / 1000)}s）——本轮改用占位折叠顶住`)
                  _summary = _s.contextSummary || `（较早的 ${_older.length} 条消息正在压缩中，本轮暂以占位折叠）`
                } else {
                  _s.compactLockUntil = Date.now() + 120000
                  try {
                    _summary = await summarizeOlderMessages(llmCfg, _older, _summary, _proxyFetch)
                    _s.compactFailStreak = 0
                    _s.compactCooldownUntil = 0
                    _s.compactLastError = ''
                  } catch (e: any) {
                    /* ★ 0923（设计口径：压缩失败会打乱节奏，必须尽量不发生）——**二级降级：缩量重试**。
                       失败最常见的成因就是"材料太长"（旧版 737 条 ≈27 万 token 顶爆网关，
                       报出来就是 empty summary）。所以把材料砍半、用同一模型再试一次；
                       成功即按成功处理（清失败计数与冷却），不再让用户看到"压缩失败"。 */
                    let _retried = false
                    try {
                      const _half = _older.length > 4 ? _older.slice(Math.floor(_older.length / 2)) : []
                      if (_half.length >= 2) {
                        sessionLog(sessionId, 'warn', 'llm', `压缩摘要失败（${String(e?.message || e).slice(0, 120)}）——按半数材料重试一次`)
                        _summary = await summarizeOlderMessages(llmCfg, _half, _summary, _proxyFetch)
                        _retried = true
                        _s.compactFailStreak = 0
                        _s.compactCooldownUntil = 0
                        _s.compactLastError = ''
                      }
                    } catch { _retried = false }
                    if (!_retried) {
                      const _streak = (Number(_s.compactFailStreak) || 0) + 1
                      const _coolMs = _streak >= 3 ? 15 * 60000 : (_streak === 2 ? 5 * 60000 : 60000)
                      _s.compactFailStreak = _streak
                      _s.compactCooldownUntil = Date.now() + _coolMs
                      _s.compactLastError = String(e?.message || e).slice(0, 200)
                      sessionLog(sessionId, 'error', 'llm', `压缩摘要生成失败（第 ${_streak} 次：${String(e?.message || e).slice(0, 200)}）——冷却 ${Math.round(_coolMs / 60000)} 分钟后再试；本轮改用**本地机械摘要**兜底（关键线索不丢）`)
                      /* ★ 0923 ——**三级降级：本地机械摘要**（零模型依赖，永远成功）。
                         它当然不如模型摘要精炼，但会把用户诉求/动作序列/涉及文件/结论线索都抽出来，
                         并明确告诉模型"原文存档在哪、可 fs_read 回读"——
                         比旧的"占位折叠（老消息整段不发、摘要缺失）"好得多。 */
                      _summary = buildMechanicalSummary(_older, _s.compactArchiveRel)
                    }
                  } finally {
                    _s.compactLockUntil = 0
                  }
                }
                _s.contextSummary = _summary
                /* ★ 0923：`summaryStartIndex` 一律记**原始消息索引** ——
                   本请求视图里的索引 i（i≥1）↔ 原始索引 = `_sumBaseIdx + i − 1`（视图索引 0 是摘要消息本身）；
                   这样下一轮"持久应用视图"时能按原始索引正确切片（视图索引只在本次请求内有效）。 */
                const _foldAtFull = _applySummaryView ? Math.max(_sumBaseIdx, _sumBaseIdx + _keepFrom - 1) : _keepFrom
                _s.summaryStartIndex = _foldAtFull
                // 每次压缩留一条时间线快照（供历史里的常驻"上下文已压缩"卡，可回看每次折叠）
                /* 0928 T3b: compaction record coordinate guard (compactions[].at).
                   at must use the SAME full-message conversion as summaryStartIndex above (_foldAtFull);
                   old code recorded the raw summary-view index _keepFrom => fold boundary drifts after
                   a 2nd compaction. Guard: clamp at into [0, fullMsgCount] and log a warn when out of
                   range (record field only; summaryStartIndex keeps its own retained-segment semantics,
                   see 0925j/0927). */
                const _t3bFullCount = (_applySummaryView && _viewSliced) ? _sumBaseIdx + _all.length - 1 : _all.length
                let _t3bAt = _foldAtFull
                if (!Number.isFinite(_t3bAt) || _t3bAt < 0 || _t3bAt > _t3bFullCount) {
                  const _t3bClamped = Math.max(0, Math.min(_t3bFullCount, Math.round(_t3bAt) || 0))
                  try { sessionLog(sessionId, 'warn', 'llm', `压缩坐标对账：折叠边界 at=${_t3bAt} 越界（全量消息数 ${_t3bFullCount}）——已钳制为 ${_t3bClamped}`) } catch { /* ignore */ }
                  _t3bAt = _t3bClamped
                }
                _s.contextSummaries = [...(_s.contextSummaries || []), { at: _t3bAt, folded: _older.length, summary: _summary }]
                if (globalSettings.archiveTranscriptMd !== false && _s.workDir) {
                  _arcRel = writeTranscriptArchive(_s.workDir.trim(), _all, sessionId) || undefined
                  _s.compactArchiveRel = _arcRel
                }
                emitCompactionNotice(sessionId, 'done')
                /* ★0927：自动压缩成功后同样广播 session/compacted（前端强制重建视图）。
                   ⚠️ 这里在**请求已发出之后**执行：前端重建时本轮流式可能正在进行，
                   所以前端那边按"有 streaming 节点就跳过、等这轮跑完再补"处理（见 conversations.ts）。 */
                try { broadcastMux(sessionId, { type: 'session/compacted', sessionId, folded: _older.length, keepFrom: _s.summaryStartIndex || 0, auto: true }) } catch { /* ignore */ }
              } else {
                _summary = _s.contextSummary || ''
                _arcRel = _s.compactArchiveRel
              }
              const _summaryMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: `【系统提示：较早的 ${_keepFrom} 条消息已压缩为摘要${_arcRel ? `，原文见 ${_arcRel}（需要时用 fs_read 回看）` : ''}】
【摘要】
${_summary}` }] }
              requestMessages = [_summaryMsg, ..._all.slice(_keepFrom)]
              // 0921：压缩"做了没有"必须一眼可见（原来只有触发日志，压没压成看不出来）
              sessionLog(sessionId, 'info', 'llm', `上下文已压缩：折叠早期 ${_keepFrom} 条（原有 ${_all.length} 条）→ 发给模型 ${requestMessages.length} 条（摘要 ${_summary.length} 字${_arcRel ? '，原文已存档' : ''}）`)
              /* ★ 0923（P0 修 · 防抖锚点 / P1-e）：压缩刚做完 → 把判定锚点切成"压缩后视图"的估算，
                 直到下一轮真实 usage 回来才撤销（见 agent_end 的 delete session.ctxUsedOverride）。
                 否则同一个 turn 里后续每次工具调用都会拿**压缩前的大 usage** 再判一次超线 ——
                 实测 12 次压缩里 9 次都是这个原因，纯白干（等于 opencode 的"压缩后必须等新 usage"）。 */
              try {
                const _estAfterRaw = estimateRequestTokens(context?.systemPrompt || systemPrompt, context?.tools || [], requestMessages)
                /* ★ 0923（实测后加固）：锚点改用"**真实占用 × 本次压缩的估算比例**" ——
                   纯估算口径会偏低：实测估算 184,719 × 校准 1.40 = 258,607，而供应商实报 427,032（仍差 1.65 倍）。
                   原因是保留区的内容构成（中文/图片/工具结果比例）与整体不同，**一个全局校准系数压不住**。
                   改成比例缩放后：圆环不会再出现"压缩后显示 13%、下一轮跳 22%"的观感跳变。 */
                const _afterTokens = (_estBeforeRaw > 0 && _prevReal > 0)
                  ? Math.max(1024, Math.round(_prevReal * (_estAfterRaw / _estBeforeRaw)))
                  : Math.round(_estAfterRaw * _cal.ratio)
                _s.ctxUsedOverride = { tokens: _afterTokens, at: Date.now(), viewCount: requestMessages.length }
                /* ★0927（实测"自动压缩后圆环不降/黄色误报"残留）：**ctxUsedForRing 必须同步** ——
                   session.context 的 usedTokens 只读 ctxUsedForRing（不读 ctxUsedOverride），
                   而这里原来是压缩判定前的旧值（本请求 2756 行写的）⇒ 压缩通知一到，
                   前端拉到的判定值还是压缩前的数：圆环被"切判定值"覆盖成旧高值、
                   预测线/黄色预警（nextCompactSoon 吃判定值）全部误报，直到下一轮请求才自愈。
                   手动压缩（compactNow 11451 行）两处都设，自动路径漏了 —— 对齐。 */
                _s.ctxUsedForRing = _afterTokens
                sessionLog(sessionId, 'info', 'llm', `压缩后判定锚点已切换：${_used} → ${_afterTokens}（新 usage 回来前不再重复触发压缩）`)
              } catch { /* ignore */ }
            } else {
              // 0921：压缩触发但无可折叠内容 —— 也留痕，避免"日志说触发了、其实什么都没做"的迷惑
              sessionLog(sessionId, 'info', 'llm', `压缩触发但无可折叠内容（可折叠的早期消息仅 ${_older.length} 条 < 2）——本次原样发送；若反复出现，说明会话一直贴着窗口，可调低滑块或清理会话`)
            }
          } else if (_pruneInfo.changed && _pruneSavedTok >= 20000 && _used + _pruneSavedTok > _trigTok) {
            /* ★ 0923（P2-a · 抄 dsh 的"剪枝短路"）：**裁剪前超线、裁剪后回到线内** → 本轮不调摘要模型。
               条件里那句 `_used + _pruneSavedTok > _trigTok` 是关键 —— 只有"本来就要压、靠剪枝救回来"才记一行；
               否则每轮都会打（裁剪对 agent 的全量消息是幂等的、每轮都得重做一遍），日志会被刷爆（实测一晚 32 条）。
               这是全场性价比最高的一步：一次零成本裁剪，换掉一次模型调用。 */
            sessionLog(sessionId, 'info', 'llm', `剪枝短路：裁剪省 ~${_pruneSavedTok} token（${_pruneInfo.changed} 处）→ 判定值从 ≈${_used + _pruneSavedTok} 降到 ${_used}，回到触发线内（${Math.round(_trigTok)}）——跳过摘要调用`)
          }
        } catch (e: any) {
          // 0921：整块压缩流程的兜底失败也必须留在运行日志里（原来只有 console，用户完全看不到）
          console.error('[compaction] skipped due to error:', e?.message || e)
          try { sessionLog(sessionId, 'error', 'llm', `上下文压缩流程异常，本轮按全量发送：${String(e?.message || e).slice(0, 200)}`) } catch { /* ignore */ }
          /* 0921 反馈（截图）：界面上"正在整理较早的对话…"一直转、AI 却已用全量继续 ——
             根因就是失败时没发 done 事件，转圈没人收。这里无条件补一发 done，绝不留悬挂态。 */
          try { emitCompactionNotice(sessionId, 'done') } catch { /* ignore */ }
          requestMessages = (context?.messages || []) as any[]  // 兜底：不压缩，正常请求
        }
      }

      /* ★ 0921 真修复：**发送预算** —— 把"这次能要多少输出"一次算清（估算 → 真实 usage 校准 → 留垫）。
         这一道是"永不 400"的数学保证：输入 + 输出 ≤ 窗口，放不下就少要输出。
         同时把本轮估算值存进会话（session.lastPromptEstimate），下一轮就能拿供应商回报的真实
         input token 校准我们的估算系数 —— 估算会越用越准，而不是靠写死的倍数。 */
      /* ★ 0923：工具结果分级裁剪已**提到压缩判定之前**（见上方 _pruneInfo 那段）——
         顺序变成 dsh 口径的"先剪枝 → 复测 → 够就不摘要"。 */
      const _sess = sessions.get(sessionId)
      const _budget = computeSendBudget(llmCfg.providerId, llmCfg.model, context?.systemPrompt || systemPrompt, context?.tools || [], requestMessages, _sess)
      try { if (_sess) _sess.lastPromptEstimate = _budget.estimate } catch { /* ignore */ }
      try { (piModel as any).maxTokens = _budget.sendOutput } catch { /* ignore */ }
      /* ★ 0923：记**两个**基准 —— ① `lastSentMsgCount` = 实际发出的条数（诊断用）；
         ② `lastSentFullCount` = 发送时 **agent 全量消息数**（下一轮判定增量用）。
         旧版只有 ①，压缩后"视图条数 ≠ 全量条数"，下一轮就把已折叠历史重复算进来（P0 bug 的根因）。 */
      try {
        if (_sess) {
          (_sess as any).lastSentMsgCount = requestMessages.length
          ;(_sess as any).lastSentFullCount = _ctxFullCount || requestMessages.length
          /* 0928 T4c B2: when this request was sent —— the retirement/masking judge below compares it
             with ctxUsedOverride.at to decide whether the usage that comes back reflects the
             post-compaction view (take over) or the pre-compaction bill (keep the anchor). */
          ;(_sess as any).lastSentAt = Date.now()
        }
      } catch { /* ignore */ }
      if (_budget.sendOutput < _budget.wantOutput) {
        /* ★ 0923（反馈"还没到压缩线就一直刷这条"）：分两种口径 ——
           ① 被**天花板**（窗口×20%）压的：这是设计内的**常态**（wantOutput 摆在那儿就会被压），
             降为 info 一行短文案，不再每次刷橙色告警；
           ② 被**剩余窗口**压的：那才是真要紧（输入太满），保持 warn + 原提示。 */
        const byCap = _budget.sendOutput <= _budget.outCap
        if (byCap) {
          /* ★ 0923（反馈"日志有点乱"）：天花板收敛是**常态**（只要模型声明值 > 20% 窗口就每轮成立），
             只在数值变化时记一行，避免每轮刷屏。 */
          const _capKey = `${_budget.sendOutput}/${_budget.outCap}`
          if (String((_sess as any)?._lastCapKey || '') !== _capKey) {
            sessionLog(sessionId, 'info', 'llm', `输出预留按天花板收敛：${_budget.sendOutput}（窗口 ${_budget.win} × 20% 上限；模型声明值 ${_budget.wantOutput}）`)
            try { (_sess as any)._lastCapKey = _capKey } catch { /* ignore */ }
          }
        } else {
          sessionLog(sessionId, 'warn', 'llm', `输出上限缩水：${_budget.wantOutput} → ${_budget.sendOutput}（估算 ${_budget.estimate} × 校准 ${_budget.ratio.toFixed(2)} = ${_budget.estCalibrated} · 窗口 ${_budget.win} · 天花板 ${_budget.outCap}）。可在「设置→供应商→模型 ✎」调小输出上限，或压缩/清理本会话历史。`)
        }
      }

      // 0909⑤：出站消毒——b.ai/智谱网关实锤只认 text/image_url 两类内容块：file 块→400「必须传入
      // file_id/file_url/file_data」；空/伪图片 data:→400「url cannot be empty/图片解析错误」。
      // NIS 现行代码不产 file 块，但 transcript 回填（重启/旧数据/外部注入）可能带病入库 →
      // 每轮 400 重试全灭（0909 03:51 实锤 6 连败）。发送前统一替换为文本占位并记日志定位来源。
      {
        const { messages: clean, report } = sanitizeRequestMessages(requestMessages)
        if (report.stripped.length) {
          sessionLog(sessionId, 'warn', 'llm', `出站消息消毒：剥离 ${report.stripped.length} 个不支持内容块（${report.stripped.slice(0, 5).join(', ')}）——来源可能是旧 transcript 回填`)
          requestMessages = clean
        }
      }
      /* ★ 0923：tool 配对修复 —— 实录 400「Messages with role 'tool' must be a response to a preceding
         message with 'tool_calls'」：用户中途插话打断工具执行时，插话 user 先落盘、被中断的 toolResult 后落盘，
         中间被 user 插队破坏配对。修复：错位上移 / 孤儿转文本 / 缺号补占位（详见 messageSanitize.ts 注释）。 */
      {
        const { messages: fixed, moved, orphaned, filled } = repairToolPairing(requestMessages)
        if (moved || orphaned || filled) {
          sessionLog(sessionId, 'warn', 'llm', `tool 配对修复：移位 ${moved} / 孤儿丢弃 ${orphaned} / 补占位 ${filled}（防 tool_calls 配对 400）`)
          requestMessages = fixed
        }
      }

      // pi-ai 官方适配器（方案 A）：消息转换（含 role:"tool" 回执/多模态）、SSE 解析、usage 映射全官方实现。
      // NIS 层重试循环：建立阶段（未向 agent 流出任何内容）失败 → 退避重试，并发 llm-retry 事件给前端过程块；
      // 一旦已开始流式（start/delta 已转发）则不再重试，避免重复文本。SDK 自带重试显式关闭（maxRetries:0）。
      if (!opts?.sub) computeContextBreakdown(sessionId, context?.systemPrompt || systemPrompt, splitToolsForRequest((context?.tools || []), lazyLoadedBySession.get(sessionId)), requestMessages)   // ★ 0929 刀③：按"实际发送"计量（懒包隐藏后别再算进圆环明细）
      // 子流（成员派发/单聊）共用主会话 sessionId：其重试通知不得进主时间线（0904 深夜实测发现：成员撞限流时'小螺丝 多次重试'错挂主 agent 气泡）
      const notice = (phase: RetryPhase, att: number, max: number, reason?: string, delayMs?: number) => { if (!opts?.sub) emitLlmRetry(sessionId, phase, att, max, reason, delayMs) }
      // 0910 反馈10：重试过程必须进运行日志（原来只有"抛异常"分支写了一条 warn，error-事件分支与恢复/耗尽
      // 全都没日志 → 用户只见错误不见重试）。日志文案带次数与等待秒数，恢复/耗尽各有明确一行。
      const retryLog = (phase: RetryPhase, att: number, reason: string, _delayMs?: number) => {
        // 0911 反馈3：成员子流不再静默——日志带成员名，重试事件透传给前端过程块
        const tag = opts?.actor ? `【${opts.actor}】` : (opts?.sub ? '【成员子流】' : '')
        if (phase === 'retry') sessionLog(sessionId, 'warn', 'llm', `${tag}模型调用失败，第 ${att}/${LLM_MAX_RETRIES} 次重试即将开始（等待 ${backoffSeconds(att)} 秒）${reason ? `：${reason}` : ''}`)
        else if (phase === 'recovered') sessionLog(sessionId, 'info', 'llm', `${tag}模型连接已恢复（重试 ${att} 次后成功，本轮继续）`)
        else sessionLog(sessionId, 'error', 'llm', `${tag}模型调用重试 ${LLM_MAX_RETRIES} 次仍失败，放弃本轮${reason ? `：${reason}` : ''}`)
        if (opts?.sub) { try { opts.onStreamNote?.({ kind: phase, attempt: att, reason: reason || '' }) } catch { /* ignore */ } }
      }
      /* ★ 0921 真修复：撞上下文 400 时的「**一次纠偏**」。
         旧行为：400 被当可重试 → 参数一字不变重试 5 轮（5/10/30/60/120 秒 ≈ 3.7 分钟）注定全灭。
         新行为：先用供应商在错误里**自己报的两个数**（窗口 / 真实输入）算出这次到底能要多少输出，
         改小 max_tokens 后**立刻重试一次**（参数真的变了，是有意义的重试）；只纠偏一次，
         还失败才按确定性错误收场。同时把这对数字存进会话 —— 后续预算拿它当校准锚点，越用越准。 */
      let _ctxFixTried = false
      const _tryCtxFix = (msg: string): boolean => {
        if (_ctxFixTried) return false
        const ovf = parseContextOverflow(msg)
        if (!ovf) return false
        /* ★ 0923：若供应商报的输入**本身就超窗**（窗口 − 输入连最小输出都放不下），
           缩输出预留是治不了的 → 直接把机会让给 `_tryInputShrink`（丢弃最旧历史后重试），
           免得先白撞一次 400 再走输入侧恢复。 */
        if (ovf.window - ovf.input < CTX_SEND_MIN_OUTPUT + CTX_SEND_MARGIN) return false
        // 留 5% 余量：重试时消息可能略有变化（多了一条错误回执等），别贴着线再撞一次
        const repaired = Math.max(256, Math.floor((ovf.window - ovf.input) * 0.95) - CTX_SEND_MARGIN)
        if (!(repaired >= 256) || repaired >= _budget.sendOutput) return false
        _ctxFixTried = true
        try { if (_sess) { _sess.ctxOverflowRealInput = ovf.input; _sess.ctxOverflowEstimate = _budget.estimate } } catch { /* ignore */ }
        _budget.sendOutput = repaired
        try { (piModel as any).maxTokens = repaired } catch { /* ignore */ }
        sessionLog(sessionId, 'warn', 'llm', `上下文 400 纠偏重试：供应商实报 输入 ${ovf.input} / 窗口 ${ovf.window} → 输出上限 ${_budget.wantOutput} 降到 ${repaired}（已记下真实输入，用于校准后续估算）`)
        notice('retry', attempt, LLM_MAX_RETRIES, `按供应商实报数把输出上限降到 ${repaired} 后重试`, 0)
        retryLog('retry', attempt, `上下文纠偏：${ovf.input} + ${repaired} ≤ ${ovf.window}`, 0)
        return true
      }
      /* ★ 0923：撞「Invalid max_tokens value, the valid range of max_tokens is [1, N]」时的一次纠偏。
         场景：models.dev 聚合值/网关口径不一致（安装版实测 opencommand：中位数修复前的 943718
         撞上网关 393216 上限）。纠偏：按供应商报的上限钳 sendOutput，立刻重试一次（参数真变了）。
         留 5% 余量防贴着线；只纠偏一次。 */
      let _maxTokFixTried = false
      const _tryMaxTokensFix = (msg: string): boolean => {
        if (_maxTokFixTried) return false
        const rng = parseMaxTokensRange(msg)
        if (!rng) return false
        const repaired = Math.max(256, Math.min(_budget.sendOutput, Math.floor(rng.max * 0.95)))
        if (repaired >= _budget.sendOutput) return false
        _maxTokFixTried = true
        _budget.sendOutput = repaired
        /* ★ 0923：把网关亲口报的上限**记住**（进程级）——否则每个新会话/每轮都会先撞一次再纠偏。
           存的时候留 5% 余量，后续预算直接拿它当"第三层天花板"。 */
        try {
          observedMaxOutput.set(outputCapKey(llmCfg.providerId, llmCfg.model), Math.max(256, Math.floor(rng.max * 0.95)))
        } catch { /* ignore */ }
        try { (piModel as any).maxTokens = repaired } catch { /* ignore */ }
        sessionLog(sessionId, 'warn', 'llm', `max_tokens 越界纠偏重试：供应商报合法范围 [${rng.min}, ${rng.max}] → 输出上限降到 ${repaired}（该上限已记住，后续请求直接用，不再先撞一次）`)
        notice('retry', attempt, LLM_MAX_RETRIES, `按供应商报的合法范围把输出上限降到 ${repaired} 后重试`, 0)
        retryLog('retry', attempt, `max_tokens 纠偏：钳到 ${repaired} ≤ ${rng.max}`, 0)
        return true
      }
      /* ★ 0923（P2 ② · 输入侧溢出专用恢复 · 抄 dsh 的 context-overflow 策略）：
         场景：供应商实报的输入**本身就超窗**（window − input 连最小输出都放不下），
         此时"缩输出预留"（_tryCtxFix）救不回来 → 旧行为直接按确定性错误收场：本轮白干、用户看到 400。
         做法：绕过常规压缩阈值与保留策略，对**当前请求视图**做一次**最大头部缩减** ——
         按"纯 user 边界"（排除 toolResult 载体消息，避免切出孤儿工具回执）从最旧往前丢，
         直到估算能塞进 `0.9×窗口 − 最小输出`；**只允许一次**，且**只在视图真的变小（cut>0）时重试**
         —— 防重试环（dsh 是"仅当 surface 投影前进了才授权重试"，同款思路）。
         注意：被丢掉的旧历史**只是本轮不发给模型**，会话记录与工作区存档都不动。 */
      let _inputShrinkTried = false
      const _tryInputShrink = (msg: string): boolean => {
        if (_inputShrinkTried) return false
        const ovf = parseContextOverflow(msg)
        if (!ovf) return false
        const win = ovf.window > 0 ? ovf.window : resolveContextWindow(llmCfg.providerId, llmCfg.model)
        const targetInput = Math.max(1024, Math.floor(win * 0.9) - CTX_SEND_MIN_OUTPUT)
        const _sysP = context?.systemPrompt || systemPrompt
        const _tools = (context?.tools || []) as any[]
        const isToolCarrier = (m: any) => Array.isArray(m?.content)
          && m.content.some((b: any) => b?.type === 'toolResult' || b?.type === 'tool_result')
        const starts: number[] = []
        requestMessages.forEach((m: any, i: number) => { if (m?.role === 'user' && !isToolCarrier(m)) starts.push(i) })
        let cut = -1
        for (const s of starts) {
          if (s <= 0) continue
          if (estimateRequestTokens(_sysP, _tools, requestMessages.slice(s) as any[]) <= targetInput) { cut = s; break }
        }
        if (cut <= 0) return false
        const before = requestMessages.length
        const estBefore = Math.round(estimateRequestTokens(_sysP, _tools, requestMessages as any[]))
        requestMessages = requestMessages.slice(cut)
        _inputShrinkTried = true
        _budget.sendOutput = Math.max(_budget.sendOutput, CTX_SEND_MIN_OUTPUT)
        try { if (_sess) { _sess.ctxOverflowRealInput = ovf.input; _sess.ctxOverflowEstimate = _budget.estimate } } catch { /* ignore */ }
        sessionLog(sessionId, 'warn', 'llm', `输入侧溢出恢复：供应商实报输入 ${ovf.input}（窗口 ${win}）放不下输出 → 丢弃最旧 ${cut} 条（${before} → ${requestMessages.length} 条，估算 ${estBefore} → ≤ ${targetInput}），整轮重试一次`)
        notice('retry', attempt, LLM_MAX_RETRIES, '输入超窗：丢弃最旧历史后重试一次', 0)
        retryLog('retry', attempt, `输入侧缩减：丢弃最旧 ${cut} 条消息`, 0)
        return true
      }
      let attempt = 0
      // 0910 反馈5：重试"恢复"要在**恢复的那一刻**通知（第一段内容真的流出来时），
      // 而不是等整轮成功收尾——旧行为导致"AI 已经在吐字了，重试块还在转圈计时"。
      let recoveredNotified = false
      /* ★0929c（实测"429/400 不再显示、只剩'原始错误：terminated'"）：
         重试每轮错误不同，旧实现 terminalErr 在 while 内逐轮**重置**——前几轮的 429/400
         被最后一轮的 terminated 顶掉，人话文案按最后一轮误判成"网络层中断"，关键码全丢。
         这里记下**每轮错误**，收尾合成"错误轨迹"（去重保序、确定性错误排最前）附进原始错误行；
         人话文案的归类也优先看 429/400 这类确定性错误，不再被 terminated 误判成网络中断。 */
      const attemptErrs: string[] = []
      const formatErrTrail = (fallback: string): string => {
        const uniq: string[] = []
        for (const t of attemptErrs) {
          const s = String(t || '').trim().slice(0, 200)
          if (s && !uniq.includes(s)) uniq.push(s)
        }
        if (!uniq.length) return String(fallback || '').slice(0, 300)
        const fi = uniq.findIndex(s => classifyLlmFailure(s) === 'fatal')
        if (fi > 0) { const [f] = uniq.splice(fi, 1); uniq.unshift(f) }
        if (uniq.length === 1) return uniq[0]
        return uniq.slice(0, 4).map((s, i) => `${i + 1}) ${s}`).join('；') + (uniq.length > 4 ? `；…共 ${uniq.length} 种` : '')
      }
      while (true) {
        attempt++
        let forwarded = false
        let terminalErr = ''
        try {
          // 0910 协议路由：openai-completions=旧路径（reasoningEffort 字段）；
          // anthropic-messages/google-generative-ai 走各自原生适配器与思考参数（effort/thinking）。
          const piCtx = toTranscriptCtx(
            context?.systemPrompt || systemPrompt,
            requestMessages as any,
            splitToolsForRequest((context?.tools || []) as any[], lazyLoadedBySession.get(sessionId)) as any,
          )
          const piOpts = {
            apiKey: llmCfg.apiKey || LOCAL_API_KEY_PLACEHOLDER,
            signal,
            // ★ 0921 真修复：发"预算后"的输出上限（按剩余窗口缩水），不再固定发 models.dev 的 output 上限
            maxTokens: _budget.sendOutput,
            maxRetries: 0,
            sessionId,
            ...( _proxyFetch ? { fetch: _proxyFetch } : {}),
          } as any
          let inner: any
          if (protocol === 'anthropic-messages') {
            inner = effort
              ? anthropicMessagesStream(piModel as any, piCtx, { ...piOpts, thinkingEnabled: true, effort: (effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high') as any })
              : anthropicMessagesStream(piModel as any, piCtx, piOpts)
          } else if (protocol === 'google-generative-ai') {
            inner = effort
              ? googleGeminiStream(piModel as any, piCtx, { ...piOpts, thinking: { enabled: true, level: (effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH') as any } })
              : googleGeminiStream(piModel as any, piCtx, piOpts)
          } else {
            inner = openaiCompletionsStream(piModel, piCtx, { ...piOpts, reasoningEffort: (effort || undefined) as any })
          }

          let sawTerminal = false
          for await (const ev of inner) {
            if (ev.type === 'done' || ev.type === 'error') {
              sawTerminal = true
              const msg: any = (ev as any).message || (ev as any).error || {}
              const u = msg.usage || {}
              const blocks = Array.isArray(msg.content) ? msg.content : []
              if (ev.type === 'done') {
                // 计费：仅成功轮记 usage
                recordUsage(llmCfg.providerId, llmCfg.model, u.input || 0, u.output || 0, u.cacheRead || 0)
                const textLen = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('').length
                const thinkLen = blocks.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking || '').join('').length
                const toolBlocks = blocks.filter((b: any) => b.type === 'toolCall')
                console.log(`[streamFn] text=${textLen} toolCalls=${toolBlocks.length} reasoning=${thinkLen} ${toolBlocks.map((b: any) => b.name).join(',')}`)
                if (msg.stopReason === 'length') sessionLog(sessionId, 'warn', 'llm', '输出达到 max_tokens 上限被截断（stopReason=length）——回复可能不完整')
                else if (msg.stopReason === 'aborted') sessionLog(sessionId, 'info', 'llm', 'LLM 流已被中止（stopReason=aborted）')
                stream.push(ev)
              } else {
                // 失败轮：先吞掉 error 事件，决定是否重试
                terminalErr = String(msg.errorMessage || (ev as any).reason || msg.stopReason || 'unknown')
                if (terminalErr && terminalErr !== 'unknown') attemptErrs.push(terminalErr)   // ★0929c：记入错误轨迹
                sessionLog(sessionId, 'error', 'llm', `${opts?.actor ? `【${opts.actor}】` : ''}LLM 流式错误: ${terminalErr}`)
              }
              continue
            }
            if (!forwarded && (ev.type === 'start' || ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'toolcall_start')) {
              forwarded = true
              // 这次尝试真的跑起来了：重试成功 = 现在（有内容/连接建立即恢复），立刻转"已恢复"
              if (attempt > 1 && !recoveredNotified) {
                recoveredNotified = true
                notice('recovered', attempt - 1, LLM_MAX_RETRIES)
                retryLog('recovered', attempt - 1, '')
              }
            }
            stream.push(ev)
          }
          if (sawTerminal && !terminalErr) {
            // 本轮成功（恢复通知通常在首个 delta 就到了；这里兜"整轮无 delta 的纯空回复"）
            if (attempt > 1 && !recoveredNotified) {
              recoveredNotified = true
              notice('recovered', attempt - 1, LLM_MAX_RETRIES)
              retryLog('recovered', attempt - 1, '')
            }
            break
          }
          // ★ 0921：确定性错误（上下文超限/参数非法/鉴权/模型不存在）→ 先尝试一次纠偏，不行就立刻失败
          if (classifyLlmFailure(terminalErr) === 'fatal') {
            if (_tryCtxFix(terminalErr)) continue   // 按供应商实报数缩输出后重试（这一次参数真的变了）
            if (_tryInputShrink(terminalErr)) continue   // ★ 0923：输入本身就超窗 → 丢弃最旧历史后重试一次
           if (_tryMaxTokensFix(terminalErr)) continue   // ★ 0923：max_tokens 越界（供应商报合法范围）→ 钳后重试
            const th = terminalErrorHint(terminalErr)
            const why = fatalReasonPhrase(terminalErr)
            sessionLog(sessionId, 'error', 'llm', `${th.full} ${why} 原始错误：${formatErrTrail(terminalErr)}`)
            notice('failed', attempt, LLM_MAX_RETRIES, `${th.short}｜${why}`)
            stream.push({ type: 'error', reason: 'error', error: failMsg(`${th.full}\n原始错误：${formatErrTrail(terminalErr)}`) })
            break
          }
          // 未成功（error 或没吐终端事件）：判断能否重试
          /* ★1004：主动中止（用户停止/审批超时停轮）绝不进重试循环 —— signal 未置位但错误文本是
             abort 的漏网场景（实测"自动重试 5 轮后仍未恢复。原始错误：Request aborted"）。 */
          if (!forwarded && attempt <= LLM_MAX_RETRIES && !signal?.aborted && !/request aborted|err_canceled/i.test(String(terminalErr || ''))) {
            const delayMs = backoffSeconds(attempt) * 1000
            notice('retry', attempt, LLM_MAX_RETRIES, terminalErr || 'stream ended unexpectedly', delayMs)
            retryLog('retry', attempt, terminalErr || '连接中断')
            await sleepBackoff(attempt, signal)
            if (signal?.aborted) { stream.push({ type: 'error', reason: 'aborted', error: failMsg('[aborted]') }); break }
            continue
          }
          /* ★0929c：人话归类优先按错误轨迹里第一个确定性错误（429/400…），不再被最后一轮的
             terminated 误判成"网络层中断"；原始错误行附完整轨迹（多轮去重、限 4 条）。 */
          const _repErr = attemptErrs.find(s => classifyLlmFailure(s) === 'fatal') || terminalErr
          const th3 = terminalErrorHint(_repErr, 'exhausted')
          if (!forwarded && !signal?.aborted) {
            notice('failed', LLM_MAX_RETRIES, LLM_MAX_RETRIES, th3.short)
            retryLog('failed', LLM_MAX_RETRIES, terminalErr || '连接中断')
          }
          // 把吞掉的错误转成 error 事件交给 agent 收尾（0928：人话在前，原始报错附后）
          stream.push({ type: 'error', reason: 'error', error: failMsg((terminalErr || attemptErrs.length) ? `${th3.full}\n原始错误：${formatErrTrail(terminalErr)}` : '[LLM stream ended unexpectedly]') })
          break
        } catch (e: any) {
          const em = e?.message || String(e)
          attemptErrs.push(String(em))   // ★0929c：异常路径的错误也进轨迹（429/400 常以异常形式出现在早期轮）
          // ★ 0921：以"抛异常"形式出现的确定性错误：同样先纠偏一次
          if (classifyLlmFailure(em) === 'fatal') {
            if (_tryCtxFix(em)) continue
            if (_tryInputShrink(em)) continue   // ★ 0923：输入本身就超窗 → 丢弃最旧历史后重试一次
           if (_tryMaxTokensFix(em)) continue   // ★ 0923：max_tokens 越界 → 钳后重试
            const th2 = terminalErrorHint(em)
            const why2 = fatalReasonPhrase(em)
            sessionLog(sessionId, 'error', 'llm', `${th2.full} ${why2} 原始错误：${formatErrTrail(em)}`)
            notice('failed', attempt, LLM_MAX_RETRIES, `${th2.short}｜${why2}`)
            stream.push({ type: 'error', reason: 'error', error: failMsg(`${th2.full}\n原始错误：${formatErrTrail(em)}`) })
            break
          }
          if (!forwarded && attempt <= LLM_MAX_RETRIES && !signal?.aborted && !/request aborted|err_canceled/i.test(String(em || ''))) {
            sessionLog(sessionId, 'warn', 'llm', `LLM 调用异常，第 ${attempt}/${LLM_MAX_RETRIES} 次重试即将开始（等待 ${backoffSeconds(attempt)} 秒）: ${em}`)
            notice('retry', attempt, LLM_MAX_RETRIES, em, backoffSeconds(attempt) * 1000)
            await sleepBackoff(attempt, signal)
            if (signal?.aborted) { stream.push({ type: 'error', reason: 'aborted', error: failMsg('[aborted]') }); break }
            continue
          }
          sessionLog(sessionId, 'error', 'llm', `流式响应异常中断: ${em}`)
          /* ★0929c：同 th3 —— 归类优先看轨迹里的确定性错误，原始错误行带完整轨迹 */
          const _repErr2 = attemptErrs.find(s => classifyLlmFailure(s) === 'fatal') || em
          const th4 = terminalErrorHint(_repErr2, 'exhausted')
          if (!forwarded && !signal?.aborted) {
            notice('failed', LLM_MAX_RETRIES, LLM_MAX_RETRIES, th4.short)
            retryLog('failed', LLM_MAX_RETRIES, em)
          }
          try { stream.push({ type: 'error', reason: 'error', error: failMsg(`${th4.full}\n原始错误：${formatErrTrail(em)}`) }) } catch { /* stream 已关闭 */ }
          break
        }
      }
      } catch (e: any) {
        // 重试循环之外的未捕获异常兜底：记日志 + 推 error 收流（agent 能感知失败而非静默挂死）
        const em = e?.message || e
        sessionLog(sessionId, 'error', 'llm', `流式响应异常中断: ${em}`)
        try {
          /* ⚠️ 0920 修：这里原来调的是 `failMsg(...)`，而 failMsg 声明在上面那个 `try {` **内部**
             （L2145），catch 里根本取不到 → 抛 ReferenceError，又被下面这个 try/catch 吞掉，
             结果就是"流断了却一个 error 帧都没推出去"（agent 静默挂死那种）。
             这是用 tsc 真类型检查（TS2304）抓出来的 —— `_tscheck.cjs` 只做语法转译，查不到这类。
             这里自己拼一个最小可用的错误帧，不再依赖 try 块里的局部函数。 */
          stream.push({
            type: 'error',
            reason: 'error',
            error: {
              role: 'assistant',
              content: [{ type: 'text', text: `[流式响应异常中断: ${em}]` }],
              errorMessage: `流式响应异常中断: ${em}`,
              timestamp: Date.now(),
            },
          } as any)
        } catch { /* stream 已关闭 */ }
      }
    })()

    return stream
  }
}

// ============================================================================
// Session store
// ============================================================================

const sessions = new Map<string, SessionView>()
const agents = new Map<string, Agent>()
/** 0920：后台任务完成时，若该会话的 agent 没在跑 → 先记在这儿，等它下次开跑时 steer 进去。
 *  （为什么不在完成时直接写进 transcript：那会凭空多一条用户消息，且状态容易跟 pi 的内部序列打架。） */
const pendingBgNotices = new Map<string, string[]>()

/* ══ ★ 0930（用户两条要求）：后台回访「LLM 裁决」+ 续跑到限「收尾汇报」══════════════
 * ①「后台任务几乎百分百都会回访——能不能让 LLM 根据情况决定是否回访？」
 *   ⇒ 回访到点先过轻量 LLM 裁决：任务失败/卡住/报错/要决策才叫醒 AI；一切正常就不打扰
 *   （任务结束会自动通知，信息不丢）。裁决失败保守放行。
 * ②「续跑 3 轮后直接一个内联通知就结束了……用户也不知道需要确认什么」
 *   ⇒ 续跑最后一轮强制要求正文汇报；到限后再来事件补一轮「收尾汇报」，不再一句通知了事。 */

/** 轻量单次 LLM 调用（回访裁决用；协议分支与 generateSessionTitle 同款——三方言 + SSE 嗅探）。
 *  stream:false 被网关强转 SSE 时按 data: 帧拼接；解析失败返回空文本由调用方兜。
 *  ponytail: 与 generateSessionTitle 的协议分支是重复实现（当时为不动在跑的标题生成而拷贝）——
 *  上限=协议新增方言时两处要同步改；升级路径=抽公共 callLlmOnce 供两者共用（净删 ~50 行）。 */
async function callLlmTiny(
  cfg: { model: string; base: string; apiKey?: string; protocol?: string },
  sys: string, user: string,
  opts: { maxTokens?: number; temperature?: number; logTag?: string } = {},
): Promise<{ text: string }> {
  const tag = opts.logTag || '[llm-tiny]'
  const proto = cfg.protocol || 'openai-completions'
  const maxTok = opts.maxTokens ?? 512
  const temp = opts.temperature ?? 0.3
  const content = user.slice(0, 1200)
  let url: string, headers: Record<string, string>, body: string
  if (proto === 'anthropic-messages') {
    url = /\/v\d/.test(cfg.base) ? `${cfg.base}/messages` : `${cfg.base}/v1/messages`
    headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey || '', 'anthropic-version': '2023-06-01' }
    body = JSON.stringify({ model: cfg.model, system: sys, messages: [{ role: 'user', content }], max_tokens: maxTok, temperature: temp })
  } else if (proto === 'google-generative-ai') {
    const root = /\/v\d/.test(cfg.base) ? cfg.base : `${cfg.base}/v1beta`
    url = `${root}/models/${encodeURIComponent(cfg.model)}:generateContent`
    headers = { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey || '' }
    body = JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: content }] }], generationConfig: { maxOutputTokens: maxTok, temperature: temp } })
  } else {
    url = `${cfg.base}/chat/completions`
    headers = { 'content-type': 'application/json', authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : '' }
    body = JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, { role: 'user', content }], max_tokens: maxTok, temperature: temp, stream: false })
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) })
  const raw = await res.text()
  let t = ''
  if (/^\s*data:/m.test(raw)) {
    for (const line of raw.split(/\r?\n/)) {
      const m = /^data:\s*(.+)$/.exec(line.trim())
      if (!m || m[1] === '[DONE]') continue
      try {
        const c = JSON.parse(m[1])
        const oa = c?.choices?.[0]?.message?.content ?? c?.choices?.[0]?.delta?.content
        const an = c?.type === 'content_block_delta' ? c?.delta?.text : undefined
        const gm = Array.isArray(c?.candidates) ? c.candidates.map((cd: any) => (cd?.content?.parts || []).map((p: any) => p?.text || '').join('')).join('') : undefined
        const piece = typeof oa === 'string' ? oa : typeof an === 'string' ? an : typeof gm === 'string' ? gm : undefined
        if (typeof piece === 'string') t += piece
      } catch { /* 半截帧忽略 */ }
    }
  } else {
    try {
      const data = JSON.parse(raw)
      if (proto === 'anthropic-messages') t = String((data?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('') || '')
      else if (proto === 'google-generative-ai') t = String((data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || '').join('') || '')
      else t = String(data?.choices?.[0]?.message?.content || '')
    } catch { console.log(`${tag} call failed: body not JSON/SSE`); return { text: '' } }
  }
  return { text: t }
}

/** 回访裁决：此刻值不值得叫醒 AI（NEED/SKIP + 理由）。裁决失败/超时 → 保守放行（NEED）。 */
async function judgeBgWorthWaking(convId: string, contextText: string): Promise<{ need: boolean; reason: string }> {
  try {
    const llm: any = resolveSessionLlm(convId) || currentLlmConfig()
    if (!llm?.base || !llm?.model) return { need: true, reason: '无模型配置，放行' }
    const sys = '你是后台任务回访裁决器。判断"此刻要不要叫醒对话中的 AI 来处理这次回访"。' +
      'NEED=任务失败/卡住/输出报错/需要人或 AI 做决策/回访备忘有明确要事；' +
      'SKIP=任务正常推进、纯例行查看、无事可做（任务结束会自动通知，不急）。' +
      '只输出一行：NEED:<一句理由> 或 SKIP:<一句理由>。'
    const r = await callLlmTiny({ model: llm.model, base: llm.base, apiKey: llm.apiKey, protocol: llm.protocol }, sys, contextText, { maxTokens: 50, temperature: 0, logTag: '[bg-judge]' })
    const line = String(r.text || '').trim().split(/\r?\n/)[0] || ''
    const need = /^NEED/i.test(line)
    return { need, reason: line.slice(0, 120) || '输出为空按跳过' }
  } catch (e) {
    return { need: true, reason: '裁决失败放行：' + String((e as any)?.message || e).slice(0, 80) }
  }
}

/** ★0930：续跑到限后的「收尾汇报」——不再一句通知了事，补一轮让 LLM 把情况说清楚
 *  （这几轮做了什么 / 现在什么状态 / 要用户确认什么）。只发一次（cappedNotified 门闩）。 */
function fireBgResumeWrapup(convId: string): void {
  const c = bgResumeChainOf(convId)
  const parked = c.pending.splice(0)
  const text = '【自动续跑 · 收尾】后台自动续跑已达上限（' + bgResumeMax() + ' 轮），自动续跑到此停止。' +
    (parked.length ? '\n另外还有没来得及处理的后台事件：\n' + parked.join('\n---\n') + '\n' : '') +
    '\n现在给用户写一段**正文汇报**（这是正文消息，不是通知）：1）这几轮自动续跑各自做了什么、结果如何；' +
    '2）任务当前状态（完成/失败/卡在哪一步）；3）需要用户确认或决定什么——**具体列出**（没有就明说"无需确认"）。'
  void runPromptCore(convId, { message: text }).catch((e: any) => {
    const q = pendingBgNotices.get(convId) || []
    q.push(text)
    pendingBgNotices.set(convId, q.slice(-10))
    pushBgResumeNotice(convId, '收尾汇报启动失败（已转待办）：' + String(e?.message || e).slice(0, 120))
  })
}

/* ══ ★ 0923：后台事件「自动续跑」链（用户定案）══════════════════════════════════
 * 解决什么：任务挂后台跑完后，AI 若空闲**没人叫它**（原来只记待办，等用户下次发话才补送）
 *   ⇒ 现在：任务结束事件一到 → 自动替 AI 开一轮接着干（成功做下一步、失败查原因）。
 * 与 bg_watch 的分工：本机制管「有终点的任务」（事件驱动，不猜时间）；bg_watch 退化为看门狗
 *   （常驻任务的健康检查 / 超时卡死告警）。
 * 既定的四条：① 设置开关默认开（general.bgAutoResume）② 轮数上限默认 3、可调 1~10
 *   （general.bgAutoResumeMax）③ 到限留一句话 ④ 用户按停止 = 暂停。
 * 让路规则（需求）：用户正在对话时不打断 —— 事件先排队，用户那轮答完立刻续跑。 */
interface BgResumeChainState { rounds: number; pending: string[]; stopped: boolean; cappedNotified: boolean }
const bgResumeChains = new Map<string, BgResumeChainState>()
function bgResumeChainOf(convId: string): BgResumeChainState {
  let c = bgResumeChains.get(convId)
  if (!c) { c = { rounds: 0, pending: [], stopped: false, cappedNotified: false }; bgResumeChains.set(convId, c) }
  return c
}
/** 开关（缺省=开）：settings.general.bgAutoResume */
function bgResumeEnabled(): boolean { return (globalSettings as any).bgAutoResume !== false }
/** 轮数上限（缺省 3，夹在 1~10）：settings.general.bgAutoResumeMax */
function bgResumeMax(): number {
  const n = Number((globalSettings as any).bgAutoResumeMax)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 1), 10) : 3
}
/** 用户亲自发话 → 额度重置、解除暂停（每次用户交互重新给一整份额度） */
function resetBgResumeChain(convId: string): void {
  const c = bgResumeChains.get(convId)
  if (!c) return
  c.rounds = 0
  c.stopped = false
  c.cappedNotified = false
}
/** 会话内联提示（用户可见；与后台任务通知同一通道） */
function pushBgResumeNotice(convId: string, text: string): void {
  try {
    broadcastMux(convId, { type: 'session/projection', sessionId: convId, key: 'session-notice', seq: Date.now(), value: { text } } as any)
  } catch { /* ignore */ }
}
/** 待续跑事件退回「等用户下次发话补送」通道（信息不丢） */
function parkBgResumePending(convId: string): void {
  const c = bgResumeChains.get(convId)
  if (!c || !c.pending.length) return
  const q = pendingBgNotices.get(convId) || []
  q.push(...c.pending.splice(0))
  pendingBgNotices.set(convId, q.slice(-10))
}
/** 真正开一轮：文本走「【自动续跑」前缀 ⇒ 前端渲染成 notice，不伪装成用户消息 */
function fireBgResume(convId: string, notes: string[]): void {
  const c = bgResumeChainOf(convId)
  const max = bgResumeMax()
  c.rounds += 1
  const body = notes.join('\n---\n')
  const text = '【自动续跑 · 后台任务完成】你之前挂到后台的任务已经结束了，结果如下：\n' + body +
    '\n\n（这一轮由「后台任务完成」事件自动触发，不是用户在提问。要看完整输出用 bg_read，看全部任务用 bg_list。）' +
    '\n请据此接着推进你原来在做的事：成功了就做下一步（例如构建成功后跑测试/做验证）；失败了就查输出定位原因再修。' +
    '\n若还需要长时间等待，可以继续挂后台任务 —— 跑完会再自动触发一次。' +
    '\n这是第 ' + c.rounds + '/' + max + ' 次自动续跑。' +
    /* ★0930（需求）：最后一轮必须正文汇报情况，别干巴巴一句"等待确认" */
    (c.rounds >= max ? '\n⚠️ 这是最后一次自动续跑——本轮收尾前必须给用户一段**正文汇报**：这几轮自动续跑各自做了什么、任务当前状态（完成/失败/卡在哪）、需要用户确认或决定什么（**具体列出**；没有就明说"无需确认"）。别只留一句通知。' : '')
  const go = () => {
    void runPromptCore(convId, { message: text }).catch((e: any) => {
      console.warn('[bg-resume] 自动续跑失败:', e)
      const q = pendingBgNotices.get(convId) || []
      q.push(body)
      pendingBgNotices.set(convId, q.slice(-10))
      pushBgResumeNotice(convId, '后台续跑启动失败（已转为待办提示）：' + String(e?.message || e).slice(0, 120))
    })
  }
  const ag = agents.get(convId) as any
  if (ag?.waitForIdle) void ag.waitForIdle().then(go).catch(go)
  else go()
  sessionLog(convId, 'info', 'lifecycle', '后台任务事件 → 自动续跑第 ' + c.rounds + '/' + max + ' 轮')
}
/** 任务结束时的入口。返回 true = 续跑链接管（已开跑 / 已排队等这轮结束） */
function scheduleBgResume(convId: string, note: string, _status: string): boolean {
  if (!bgResumeEnabled()) return false
  const c = bgResumeChainOf(convId)
  if (c.stopped) return false
  if (c.rounds >= bgResumeMax()) {
    if (!c.cappedNotified) {
      c.cappedNotified = true
      /* ★0930（需求）：到限不再"一句通知了事" —— 补一轮「收尾汇报」让 LLM 说清情况 */
      pushBgResumeNotice(convId, '⚠️ 后台自动续跑已达上限（' + bgResumeMax() + ' 轮），自动续跑停止 —— 紧接着会有情况小结。')
      c.pending.push(note)
      fireBgResumeWrapup(convId)
      return true
    }
    return false
  }
  const ag = agents.get(convId) as any
  const busy = !!ag && !!(ag as any).state?.isStreaming
  if (busy || !ag) {
    // 用户正在对话 / 会话还没开跑 → 不打断：排队，等这轮自然结束（drainBgResumeAfterIdle）再续
    c.pending.push(note)
    return true
  }
  fireBgResume(convId, [note])
  return true
}
/** 一轮自然结束（waitForIdle 之后、队列已空）→ 有排队事件就立刻续跑 */
function drainBgResumeAfterIdle(convId: string): void {
  const c = bgResumeChains.get(convId)
  if (!c || !c.pending.length) return
  if (!bgResumeEnabled() || c.stopped) { parkBgResumePending(convId); return }
  if (c.rounds >= bgResumeMax()) {
    if (!c.cappedNotified) {
      c.cappedNotified = true
      /* ★0930（需求）：到限补「收尾汇报」（会把 c.pending 里的事件一并带上） */
      pushBgResumeNotice(convId, '⚠️ 后台自动续跑已达上限（' + bgResumeMax() + ' 轮），自动续跑停止 —— 紧接着会有情况小结。')
      fireBgResumeWrapup(convId)
      return
    }
    parkBgResumePending(convId)
    return
  }
  const notes = c.pending.splice(0)
  fireBgResume(convId, notes)
}

/**
 * 0920：把"后台任务完成"的待办提示补进这个会话。
 * 时机 = agent 刚建好、还没开始流（此时 steer 的队列会在本轮首个 LLM 调用前被取走），
 * 所以 AI 在这轮就能看到"你挂的那个任务跑完了"。
 * ⚠️ 刻意不写进 transcript：那会凭空多一条用户消息（UI 上很怪），也容易跟 pi 的内部序列打架。
 */
function drainBgNotices(sessionId: string, agent: unknown): void {
  // ★ 0923：把「自动续跑队列里没来得及跑的事件」一并补送 —— 用户发话了，让他这轮看到全部待办
  parkBgResumePending(sessionId)
  const q = pendingBgNotices.get(sessionId)
  if (!q || !q.length) return
  pendingBgNotices.delete(sessionId)
  try {
    for (const note of q) {
      ;(agent as any)?.steer?.({ role: 'user', content: [{ type: 'text', text: `【后台任务通知】${note}\n（要看完整输出用 bg_read，看全部任务用 bg_list）` }], timestamp: Date.now() })
    }
    sessionLog(sessionId, 'info', 'lifecycle', `补送 ${q.length} 条后台任务通知给 AI`)
  } catch (e) { console.warn('[bg] 补送通知失败:', e) }
}
/** 0910 三批：agent 缓存对应的配置指纹（预设/团队文件 mtime），用于配置变更后自动重建 */
const agentFingerprints = new Map<string, string>()

/** 0910 三批：会话相关配置的指纹——预设文件 + 团队文件的 mtime + 人格称呼。
 *  改动（换成员模型/档位/工具白名单/并行预算/人格）会让指纹变化 → getOrCreateAgent 丢弃缓存重建，
 *  不必再重启后端才生效。 */
function configFingerprint(sessionId: string): string {
  const s = sessions.get(sessionId)
  if (!s) return ''
  const parts: string[] = []
  try {
    const pid = String(s.presetId || '').trim()
    if (pid) parts.push('p:' + fs.statSync(path.join(PRESETS_DIR, pid, 'preset.json')).mtimeMs)
  } catch { /* ignore */ }
  try {
    const tid = String(s.teamId || '').trim()
    if (tid) parts.push('t:' + fs.statSync(path.join(TEAMS_DIR, tid, 'team.json')).mtimeMs)
  } catch { /* ignore */ }
  try {
    /**
     * 人格与称呼（全局设置 + 通道机器人覆盖）必须纳入指纹 ——
     * systemPrompt 是**建 agent 时组装一次**的，改了名字/称呼若指纹不变，
     * getOrCreateAgent 会复用旧 agent，systemPrompt 仍是旧值
     * （用户实测：QQ 机器人改成「牢大」后，它仍自称「小螺丝」）。
     * 用 \u0001 分隔，避免值里含逗号造成歧义。
     */
    const ov = channelPersonaOverride(s)
    parts.push('persona:' + [
      globalSettings.nisName, globalSettings.userName, globalSettings.prompt,
      /* ★1012m：工作纪律开关也纳入指纹 —— 否则设置页拨了开关、已开的会话不会重建 agent（改动不生效） */
      String((globalSettings as any).criticDiscipline !== false),
      ov.nisName, ov.userName, ov.prompt,
    ].map(v => String(v || '')).join('\u0001'))
  } catch { /* ignore */ }
  try {
    /* ★1012（实测"装了 MCP，已开的会话里调不到"）：MCP 工具集**必须**纳入指纹。
       工具表是建 agent 时快照进 initialState.tools 的（见 getOrCreateAgent），而安装/启用/
       勾选 MCP 只改 mcpRuntime 的内存 Map，不碰 preset.json ⇒ 指纹不变 ⇒ 旧 agent 一直端着
       旧工具表（install_mcp 的文案却写"已对 agent 生效"）。
       纳入后：下次发消息（getOrCreateAgent）自动重建 ⇒ 新工具立即生效，与预设热更新同一条路径。
       进"工具名列表"而不是"工具数"：server 升级换工具时也要能触发重建。
       反作用（要保住的那面）：MCP 没变时这段签名逐字节稳定 ⇒ 不打散工具表前缀缓存。 */
    parts.push('mcp:' + getMcpStatus().map(m =>
      `${m.name}:${m.status}:${m.config?.enabled === false ? 0 : 1}:${m.config?.selected === false ? 0 : 1}:[${m.tools.map(t => t.name).join(',')}]`
    ).join(';'))
  } catch { /* ignore */ }
  return parts.join('|')
}
const muxClients = new Map<string, Set<ServerResponse>>()
const hostClients = new Set<ServerResponse>()

// ============================================================================
// 全局设置持久化（data/settings.json）：用户名字/AI 名字/头像/性格提示词等
// AI 可调用 settings.update 更新（如用户说"叫我老二"时），前端读写也走此 RPC
// ============================================================================

const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json')
let globalSettings: Record<string, any> = {}
/* ★ 0927 第 0 批：settings.json 损坏降级标志。
   注意：fallback 是"全默认"（有内容的默认人格/名字）——degraded 期间任何写回都会把用户的
   名字/AI 名/全部偏好覆盖成默认值，因此选择**一律拒绝写盘**（用户实锤"重启后设置还原
   到默认"的固化路径：读坏静默 → 默认填充 → 任何一次 settings.update 把默认落盘）。 */
let settingsDegraded = false

function loadSettings(): void {
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 才用默认；内容损坏先备份 .corrupt-* 再回落并标记
     degraded。（旧逻辑：损坏也静默走默认 → 见上。体检 A1/P1，家族①病根。） */
  const r = loadJsonOrBackup<any>(SETTINGS_FILE, () => ({}))
  if (r.degraded) settingsDegraded = true
  globalSettings = (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data : {}
  if (!r.degraded && r.data != null && (typeof r.data !== 'object' || Array.isArray(r.data))) {
    settingsDegraded = true
    console.error('[settings] 文件结构异常（不是对象），按降级处理：', SETTINGS_FILE)
  }
  // C3 压缩默认开（仅窗口 >80% 才触发，LongCat 1M 基本不触发；小窗模型才生效）；存档默认开
  if (typeof globalSettings.contextCompaction !== 'boolean') globalSettings.contextCompaction = true
  /* ★0927 N1：停止键与队列的语义（已定案：甲/乙 做成设置项 + 搭配丙）。
     continue（默认）= 停止只停当前轮、队列按 FIFO 继续发；pause = 停止同时把队列按暂停（界面给「继续发送」）。 */
  if ((globalSettings as any).cancelQueueMode !== 'pause') (globalSettings as any).cancelQueueMode = 'continue'
  if (typeof globalSettings.archiveTranscriptMd !== 'boolean') globalSettings.archiveTranscriptMd = true
  /* ★ 0921q：技能开关（用户需求）—— disabledSkills 存"被关掉的"技能名（新装技能默认可用）；
     skillAutoSelect = 主开关"允许 AI 自己选用技能"（关掉则技能清单整体不注入）。 */
  if (!Array.isArray((globalSettings as any).disabledSkills)) (globalSettings as any).disabledSkills = []
  if (typeof (globalSettings as any).skillAutoSelect !== 'boolean') (globalSettings as any).skillAutoSelect = true
  /* ★ 0922z：长对话分批加载（前端首屏只拉最后 N 轮，上滑补更早）—— 后端不参与逻辑，只持久化这个字段。 */
  if (typeof (globalSettings as any).lazyHistory !== 'boolean') (globalSettings as any).lazyHistory = true
  // 0910：压缩触发阈值 / 留存比例（百分比，与设置·通用页同名字段同源；缺省=旧硬编码 80/35）
  if (typeof globalSettings.contextCompactThresholdPct !== 'number') globalSettings.contextCompactThresholdPct = 80
  /* ★ 0923（用户定案）：后台事件自动续跑 —— 默认开 / 轮数上限默认 3 可调（1~10）/ 停止即暂停。
     另：bgWatchAutoWake（0922 起后端就认它、缺省=开）一直没有前端开关，本次一并补上。 */
  if (typeof (globalSettings as any).bgAutoResume !== 'boolean') (globalSettings as any).bgAutoResume = true
  if (typeof (globalSettings as any).bgAutoResumeMax !== 'number') (globalSettings as any).bgAutoResumeMax = 3
  if (typeof (globalSettings as any).bgWatchAutoWake !== 'boolean') (globalSettings as any).bgWatchAutoWake = true
  if (typeof (globalSettings as any).fsReadMaxChars !== 'number') (globalSettings as any).fsReadMaxChars = 0   // ★ 0923：0=自动（小文件整读、超 24000 封顶），>0=数字即最大值
  // 0911：自动续跑护栏（0=不设限）
  if (typeof globalSettings.autoContinueRounds !== 'number') globalSettings.autoContinueRounds = 150
  if (typeof globalSettings.turnTokenBudget !== 'number') globalSettings.turnTokenBudget = 2_000_000
  // 0911：成员单次运行上限（单位分钟；0=不设限；默认 30 分钟=旧行为。wallMs 取其 2 倍）
  if (typeof globalSettings.memberRunLimitMinutes !== 'number') globalSettings.memberRunLimitMinutes = 30
  // 0911 三批：成员巡检官（默认开；规则预筛零成本，疑似才轻量复审）
  if (typeof globalSettings.memberInspector !== 'boolean') globalSettings.memberInspector = true
  if (typeof globalSettings.contextKeepPct !== 'number') globalSettings.contextKeepPct = 35
  // 0910 三批⑤：文件变更历史配额（按对话计；缺省 200，设置页可调）
  try { setHistoryQuota((globalSettings as any).historyMaxPerSession) } catch { /* ignore */ }
  // 0911 反馈：历史占用自动清理（默认开；对象库占用 ≥500MB 时裁掉最旧 20% 记录并物理回收）
  if (typeof (globalSettings as any).historyAutoCleanEnabled !== 'boolean') (globalSettings as any).historyAutoCleanEnabled = true
  if (typeof (globalSettings as any).historyAutoCleanThresholdMb !== 'number') (globalSettings as any).historyAutoCleanThresholdMb = 500
  if (typeof (globalSettings as any).historyAutoCleanPct !== 'number') (globalSettings as any).historyAutoCleanPct = 20
}

/* ★1005 修注解：实现里是 return true / return false（落盘成败），注解却写 `void` ⇒
   调用点 `if (!persistSettings())` 被 TS 判"void 不能判真假"（TS1345）、语义看着像恒真。
   运行时一直是**对的**（JS 无视注解）—— 但注解撒谎会误导后来人（有人照注解把 return 删了，那处"落盘确认"就废了）。 */
function persistSettings(): boolean {
  /* ★ 0927 第 0 批：degraded 一律拒绝回写（默认表型 fallback，写回即覆盖用户设置） */
  if (settingsDegraded) {
    console.error('[settings] 拒绝写盘：settings.json 已损坏降级——写回会用默认值覆盖用户设置。' +
      '请从盘上 .corrupt-* 备份恢复，或人工核对后删除坏档重启。')
    return false
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2))
    return true
  } catch (e) {
    console.error('[settings] persist failed:', e)
    return false
  }
}

/** 设置版本：每次 update 递增，会话 prompt 时检测到版本变化重建 agent（新 system 生效） */
function bumpSettingsVersion(): void {
  globalSettings.__version = (typeof globalSettings.__version === 'number' ? globalSettings.__version : 0) + 1
}

loadSettings()
/* ★ 0927 第 0 批：启动即亮明数据根来源 —— "设置还原默认"类问题第一嫌疑人就是读错了目录。
   打包版注入 NIS_DATA_DIR；dev 由 _start_backend.mjs/_restart_backend.mjs 钉死 backend/data。 */
console.log(`[boot] DATA_ROOT = ${DATA_ROOT}（NIS_DATA_DIR=${process.env.NIS_DATA_DIR ? '已设置→' + process.env.NIS_DATA_DIR : '未设置→backend/data'}）`)
if (settingsDegraded) {
  console.error('[boot] ⚠️ settings.json 处于损坏降级状态：本次会话所有设置修改都不会落盘，' +
    '请从盘上 .corrupt-* 备份恢复或人工核对（拒绝写盘是为了保护你的数据不被默认值覆盖）')
}
{
  const _degraded0 = degradedFiles()
  if (_degraded0.length) console.error(`[boot] ⚠️ 降级存储文件 ${_degraded0.length} 个：`, _degraded0.map(d => d.file).join(', '))
}
/* ★ 0921 修「浏览器点启动就失败」（实测，且卡住推进）：
   `env.install {id:'chromium'}` 把内核装到 `envDir`（靠**子进程**的 PLAYWRIGHT_BROWSERS_PATH 重定向），
   但**后端主进程自己**从没设过这个变量 ⇒ browserEngine 里 `chromium.launchPersistentContext()`
   只会去 playwright 的默认缓存（%LOCALAPPDATA%\ms-playwright）找 —— 那里当然是空的
   ⇒ 拉不起来；而「软件环境」页却显示"已安装"（探测走的是 envDir）。**两套路径没对齐**。
   修法：主进程启动时就把缓存路径指到 envDir，让**安装 / 探测 / 启动三方对齐**。
   ★ 0921b 追加（用户 0.0.18 复测「还是启动不起来」）：光设这个变量**不够**！
     playwright-core 在**模块加载那一刻**就把 registry 缓存目录算好缓存了（ESM 静态 import 提升，
     下面这行赋值永远晚于 import）⇒ 启动照样去 %LOCALAPPDATA%\ms-playwright。
     实证：`backend/_probe_pw_envorder.mjs`（先清掉继承变量）—— 先 import 再设 env 解析到 ms-playwright，
     先设 env 再 import 才解析到 envDir。
     真正的兜底在 browserEngine.start()：按 envDir **显式解析 executablePath**（见 browserEngine.resolveChromiumExe）。
     这里这行保留不动 —— 装内核的 playwright CLI 是**子进程**，靠它定位；setBrowserEnvDir 则把 envDir
     同步给引擎（不依赖 env 是否已生效）。 */
try {
  const envDirNow = envInstallDir()   // ★ 0921c：用「有效环境目录」（设置里空则回落到 <数据根>/env），别再只读裸设置 —— 否则清掉历史 envDir 后，默认目录接不到浏览器启动链上（实测启动仍去找 ms-playwright）
  if (envDirNow) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = envDirNow
    browserEngine.setBrowserEnvDir(envDirNow)
    console.log(`[browser] PLAYWRIGHT_BROWSERS_PATH → ${envDirNow}`)
  }
} catch { /* ignore */ }

// ============================================================================
// 会话持久化：data/sessions.json（标题/消息/transcript 落盘，重启恢复）
// ============================================================================

/** 旧单文件格式（0911 #16 之前）：仅用于首次迁移与兼容读取 */
const SESSIONS_FILE = path.join(DATA_ROOT, 'sessions.json')
/** 0911 #16：按会话拆分的落盘目录（data/sessions/<id>.json）——写盘只写变更的会话 */
const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions')
/** 会话资产库：内嵌 base64 图片 → data/session-assets/<sha256>.<ext>（全局去重） */
const SESSION_ASSETS = new SessionAssetStore(path.join(DATA_ROOT, ASSET_DIR_NAME))
/** id → 上次落盘 payload 的 sha1（脏检测：未变更的会话不重复写盘） */
const persistedHashes = new Map<string, string>()
let persistTimer: ReturnType<typeof setTimeout> | null = null

/** 单会话落盘载荷（字段与旧版一一对应，勿增删） */
function buildSessionPayload(s: any): Record<string, any> {
  return {
      id: s.id,
      title: s.title,
      messages: s.messages,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      model: s.model,
      modelProviderId: s.modelProviderId,
      // 0908六：思考强度按会话持久化（此前只在内存=刷新回全局默认，且换一会话全联动）
      effort: s.effort,
      // 0909⑦：排队消息持久化（重启不丢；权威源在后端）
      queuedMessages: s.queuedMessages,
      workDir: s.workDir,
      titleManual: s.titleManual,
      titleGenerated: s.titleGenerated,
      // 0909⑦改：置顶持久化（此前前端内存态，刷新即丢）
      pinned: s.pinned,
      // 0912 接入批：来源通道必须落盘 —— 本函数是显式字段白名单，
      // 漏登记会导致重启后通道归属全部丢失（已实测踩到：126 会话 0 带 origin）
      origin: s.origin,
      originPeer: s.originPeer,
      originBot: s.originBot,
      originKind: s.originKind,
      // 0912 十九批：定时任务支线标记（漏登记会让重启后 ⏰ 标记与"禁止直删"失效）
      taskId: s.taskId,
      inMainList: s.inMainList,
      /* ★0927（已定案 ①b）：**未读的权威口径** —— 该会话"最后已读"的时间戳（ms）。
         未读数由 session.list 现场算：`messages` 里 ts > lastReadAt 的 assistant 条数。
         前端点开会话/看着它跑完一轮时调 session.markRead 刷新它 ⇒ 刷新页面也不再丢未读。 */
      lastReadAt: s.lastReadAt,
      movedInAt: s.movedInAt,      plan: s.plan,
      boardPlan: s.boardPlan,
      teamId: s.teamId,
      // 0917：项目归属必须落盘（漏登记 → 重启后项目会话错归到聊天列表）
      projectId: s.projectId,
      presetId: s.presetId,
      system: s.system,
      permissionMode: s.permissionMode,
      mode: s.mode,
      transcript: s.transcript,
      // ★1010 P0：外部流 PartEvent 记录（ext-stream 契约落盘体）——与 transcript 同级随会话写盘；
      // 漏登记 = 重启后外部流回放只剩纯文本记账（本函数是显式字段白名单，加字段必须登记）
      extTranscript: s.extTranscript,
      extAcpSessionId: (s as any).extAcpSessionId,
      extAcpModel: (s as any).extAcpModel,
      // ★0928 T2：分身日志落盘 —— subRuns（toolCallId → runs[]）与 transcript 同级随会话写盘
      subRuns: s.subRuns,
      lastUsage: s.lastUsage,
      lastTurnTiming: s.lastTurnTiming,
      modelUsage: s.modelUsage,
      usedModels: s.usedModels,
      // "当前会话允许"批准记忆必须落盘——漏掉则后端重启后权限卡复弹（0901 实锤）
      approvedTools: s.approvedTools,
      // 会话级成员技能（新对话默认空；TeamMemberPanel 编辑保存到这里）
      memberSkills: s.memberSkills,
      // 消息级 turn 元数据（写时补全，刷新后统计条直读恢复）
      turnMetas: s.turnMetas,
      // ★ 0924：会话级 usage 单调账本（对账口径；重启后统计条"累计"不丢）
      usageTotals: s.usageTotals,
      /* ★0929 P1（0924 抹字段事故残留同类）：**来源标记必须落盘** ——
         presetBy/llmOverrideBy 原标注"不落盘，进程内有效"，重启即丢 ⇒
         `用户手选过` 守卫失效 ⇒ 通道配置在重启后把用户手选的预设/模型**静默顶掉**。
         只落盘标记；llmOverride 值（含 apiKey）**不落盘**——钥匙不进会话文件，
         值重启后按 session.model 回退 / 通道消息到达时按标记重建。 */
      presetBy: s.presetBy,
      llmOverrideBy: s.llmOverrideBy,
      // C3 上下文压缩状态（持久化，重启后压缩视图幂等复用，不重复摘要）
      contextSummary: s.contextSummary,
      summaryStartIndex: s.summaryStartIndex,
      compactArchiveRel: s.compactArchiveRel,
      contextSummaries: s.contextSummaries,
  }
}

/** ★0926 2a：本地同步落盘单会话（退出路径 / 工人降级共用；返回 sha1 hash）。 */
function persistSessionLocal(s: any, payload: any): string {
  const json = JSON.stringify(payload)   // 紧凑写：去掉 2 空格缩进（省 ~9%）
  const hash = createHash('sha1').update(json).digest('hex')
  if (persistedHashes.get(s.id) === hash) return hash   // 未变更 → 不重复写盘
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(s.id)) return hash  // 文件名安全（原语义）
  const dst = path.join(SESSIONS_DIR, `${s.id}.json`)
  const tmp = dst + '.tmp'
  fs.writeFileSync(tmp, json, 'utf-8')
  fs.renameSync(tmp, dst)   // 同分区原子替换
  return hash
}

/** ★0926 止血：死文件清理改为「隔离」而不是物理删。
 *  理由（044f619c 真丢那次的教训）：旧写法 `fs.rmSync()` 一删就永久没了——
 *  没有回收站、没有日志、try/catch 静默；一旦 alive 集合不完整（工人快照/解析失败的会话）
 *  就是"删错也查不到、救不回"。现在只搬到同分区 `sessions.trash/`，带时间戳前缀 + 留日志，
 *  真要清理由人决定。rename 失败就保留原文件（宁留勿删）。 */
function quarantineDeadSessionFile(fileName: string): void {
  const src = path.join(SESSIONS_DIR, fileName)
  try {
    const trashDir = path.join(SESSIONS_DIR, 'sessions.trash')
    fs.mkdirSync(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.renameSync(src, path.join(trashDir, `${stamp}__${fileName}`))
    console.warn(`[persist] 死文件已隔离（未删除）：${fileName} → sessions.trash/`)
  } catch (e) {
    console.error('[persist] 隔离死文件失败——原文件保留不动:', fileName, e)
  }
}

/** ★0926 2a：同步全量落盘（退出/关键路径专用——进程要退了，不能等工人 IPC 往返）。 */

function persistSessionsSync(): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const alive = new Set<string>()
    for (const s of sessions.values()) {
      alive.add(s.id)
      const payload = stripSessionAssets(buildSessionPayload(s), SESSION_ASSETS)
      persistedHashes.set(s.id, persistSessionLocal(s, payload))
    }
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -'.json'.length)
      if (alive.has(id)) continue
      quarantineDeadSessionFile(f)
      persistedHashes.delete(id)
    }
    dirtySessions.clear()
    persistAllPending = false
  } catch (e) {
    console.error('[persist] sessions sync failed:', e)
  }
}

async function persistSessions(): Promise<void> {
  try {
    const all = persistAllPending   // ★0926 C2：全量拍=对账+死文件清理；增量拍=只处理脏会话
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    // A1 原子写：先写同目录临时文件再 rename 替换（rename 同分区原子），
    // 消除"写到一半被杀 → sessions.json 损坏 → 全部会话丢失"窗口
    const alive = new Set<string>()
    for (const s of sessions.values()) {
      alive.add(s.id)
      if (!all && !dirtySessions.has(s.id)) continue   // ★0926 C2：干净会话连 payload 构建都不做
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(s.id)) continue  // 文件名安全（原语义，主线程先拦）
      // 剥离只在落盘态做（写时复制）——内存对象仍是内嵌 data URL，前后端语义零变化
      const payload = stripSessionAssets(buildSessionPayload(s), SESSION_ASSETS)
      const hash: string = persistSessionLocal(s, payload)
      persistedHashes.set(s.id, hash)
    }
    // 清理已删除会话的落盘文件（★0926 C2：只在全量拍做——增量拍没跑全集，清理会误删没被遍历的活会话文件）
    if (all) {
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue
        const id = f.slice(0, -'.json'.length)
        if (alive.has(id)) continue
        quarantineDeadSessionFile(f)
        persistedHashes.delete(id)
      }
    }
    dirtySessions.clear()
    persistAllPending = false
  } catch (e) {
    console.error('[persist] sessions failed:', e)
  }
}

/* ★0926 C2（降负提速）：脏会话增量落盘 —— 此前每拍都对**全部**会话 buildPayload+stripAssets+stringify+sha1
 *  （hash 命中只省写盘、不省序列化；大会话 transcript 数 MB，活跃期每 500ms 全量一遍=主线程大头之一）。
 *  语义：schedulePersist(id) 带参=只标该会话脏（高频路径：工具节拍等）；
 *        schedulePersist() 无参=全量脏（低频/不确定路径保守兜底，**绝不漏写**）。
 *  增量拍只对脏会话做 stringify/hash/写盘；死文件清理只在全量拍做（需要 alive 全集语义）。 */
const dirtySessions = new Set<string>()
let persistAllPending = true   // 启动后首拍全量（与磁盘对账 persistedHashes）
/* ★0927 N2：去抖"饥饿"防线 —— 每次 schedulePersist 都 clearTimeout 重排，持续有写事件时
   写盘可以被**无限期推迟**（实测：工人轮末被杀，回复从没上过盘 = 丢助手回复 15=8×2−1）。
   现在记"第一拍何时被排"，最多等 PERSIST_MAX_WAIT_MS 就强制写一次（trailing + maxWait）。 */
let persistFirstScheduledAt = 0
const PERSIST_DEBOUNCE_MS = 500
const PERSIST_MAX_WAIT_MS = 2000
function schedulePersist(sessionId?: string): void {
  if (sessionId) dirtySessions.add(String(sessionId))
  else persistAllPending = true
  if (persistTimer) clearTimeout(persistTimer)
  const now = Date.now()
  if (!persistFirstScheduledAt) persistFirstScheduledAt = now
  const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, persistFirstScheduledAt + PERSIST_MAX_WAIT_MS - now))
  persistTimer = setTimeout(() => { persistFirstScheduledAt = 0; persistSessions() }, wait)
}

/**
 * 读取会话落盘数据（0911 #16 拆分后的读取入口）：
 *   - 优先 data/sessions/<id>.json（拆分格式，坏文件只丢该会话）
 *   - 目录为空但存在旧 data/sessions.json → 读旧文件 + 快照到 backups/sessions.presplit.json，然后删除旧文件
 *     （首次 persistSessions 会把每个会话按新格式写进目录）
 */
function readSessionPayloads(): any[] {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
    if (files.length > 0) {
      const out: any[] = []
      for (const f of files) {
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')))
        } catch (e) {
          console.error('[load] session file corrupt, skipped:', f, e)
        }
      }
      return out
    }
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))
      const list = Array.isArray(data) ? data : []
      try {
        const dir = path.join(DATA_ROOT, 'backups')
        fs.mkdirSync(dir, { recursive: true })
        const snap = path.join(dir, 'sessions.presplit.json')
        if (!fs.existsSync(snap)) fs.copyFileSync(SESSIONS_FILE, snap)   // 迁移前快照（可回滚）
        fs.rmSync(SESSIONS_FILE)                                          // 首次 persist 按会话写进目录
        console.log(`[migrate] sessions.json → sessions/ (${list.length} 会话；旧文件快照 backups/sessions.presplit.json)`)
      } catch (e) {
        console.error('[migrate] presplit snapshot failed:', e)
      }
      return list
    }
    return []
  } catch (e) {
    console.error('[load] read sessions failed:', e)
    return []
  }
}

/** 会话落盘 → 内存的还原（loadSessions 与"工人按需补载"共用同一条构造，防两处语义漂移）。
 *  opts.onlyId=只处理该会话；opts.onlyMissing=只补内存里没有的（工人按需补载：绝不覆盖已有内存态）。 */
function hydrateSessionsFromDisk(opts: { onlyId?: string; onlyMissing?: boolean } = {}): number {
  let n = 0
  try {
    const raw = readSessionPayloads()
    for (const s of raw) {
      if (opts.onlyId && s?.id !== opts.onlyId) continue
      if (opts.onlyMissing && sessions.has(s.id)) continue
      // 0911 #16：asset 引用还原为内嵌 data URL —— 内存态与改造前完全一致（前后端零改动）
      const rs: any = restoreSessionAssets(s, SESSION_ASSETS)
      const sLastUsage = rs.lastUsage || findLastRealUsage(rs.transcript || [])
      const derived = (rs.modelUsage && Object.keys(rs.modelUsage).length)
        ? { modelUsage: rs.modelUsage, usedModels: rs.usedModels || [] }
        : deriveModelUsage(rs.transcript || [])
      /* ★0928 T2：subRuns 读取回填 —— 顶层表（toolCallId → runs[]）与 transcript 消息互备：
         ① 老数据迁移：消息里已带 subRuns（旧版只嵌在 transcript 里）→ 收进顶层表；
         ② 回填：顶层表有而消息没有 → 写回消息（history 下发直接带出，前端气泡重建零改动）；
         ③ 老会话两者皆无 → 空对象回退，绝不 undefined。只读内存、不写盘。 */
      const subRunsMap: Record<string, any[]> = (s.subRuns && typeof s.subRuns === 'object' && !Array.isArray(s.subRuns)) ? s.subRuns : {}
      if (Array.isArray(rs.transcript)) {
        for (const m of rs.transcript) {
          if (!m || m.role !== 'toolResult') continue
          const key = String(m.toolCallId || '')
          if (!key) continue
          if (Array.isArray(m.subRuns) && m.subRuns.length > 0 && !subRunsMap[key]) {
            subRunsMap[key] = JSON.parse(JSON.stringify(m.subRuns))
          } else if (!m.subRuns && Array.isArray(subRunsMap[key]) && subRunsMap[key].length > 0) {
            m.subRuns = JSON.parse(JSON.stringify(subRunsMap[key]))
          }
        }
      }
      sessions.set(s.id, {
        id: s.id,
        title: s.title || '新对话',
        messages: rs.messages || [],
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || Date.now(),
        model: s.model || '',
        modelProviderId: typeof s.modelProviderId === 'string' ? s.modelProviderId : undefined,
        effort: typeof s.effort === 'string' && s.effort ? s.effort : undefined,
        queuedMessages: Array.isArray(s.queuedMessages) ? s.queuedMessages.filter((q: any) => q && typeof q.text === 'string' && q.id) : undefined,
        status: 'idle',
        workDir: s.workDir,
        titleManual: s.titleManual,
        titleGenerated: s.titleGenerated,
        pinned: !!s.pinned,
        // 0912 接入批：来源通道恢复（与 persistSessions 对应，否则重启丢失通道归属）
        origin: typeof s.origin === 'string' && s.origin ? s.origin : undefined,
        originPeer: typeof s.originPeer === 'string' && s.originPeer ? s.originPeer : undefined,
        originBot: typeof s.originBot === 'string' && s.originBot ? s.originBot : undefined,
        originKind: typeof s.originKind === 'string' && s.originKind ? s.originKind : undefined,
        // 0912 十九批：定时任务支线（与 persistSessions 对应）
        taskId: typeof s.taskId === 'string' && s.taskId ? s.taskId : undefined,
        inMainList: (s.inMainList === true || s.taskInList === true) ? true : undefined,
        /* ★0927（①b）：最后已读时间戳 —— **只在启动加载时补种一次**（= 此前都算已读），
           之后的 AI 回复才开始累计未读。
           ⚠️ 绝不能放到 `session.list` 的映射里补：前端每次重连/对账都拉列表 ⇒ 你不在时到的回复
           一拉列表就被顶成"已读"（实测"未读永远不显示"就是这个坑，已踩过）。 */
        lastReadAt: (typeof s.lastReadAt === 'number' && s.lastReadAt > 0)
          ? s.lastReadAt
          : (Number((rs.messages || [])[(rs.messages || []).length - 1]?.timestamp) || Date.now()),
        movedInAt: typeof s.movedInAt === 'number' && s.movedInAt > 0 ? s.movedInAt : undefined,        teamId: s.teamId,
        // 0917：项目归属恢复（与 persistSessions 对应）
        projectId: typeof s.projectId === 'string' && s.projectId ? s.projectId : undefined,
        presetId: s.presetId,
        /* ★0929 P1：来源标记恢复（与 persistSessions 对应）——丢了它，重启后通道配置会
           把用户手选的预设/模型顶掉（0924 抹字段事故同族；只回填标记，不含 apiKey）。 */
        presetBy: s.presetBy === 'user' || s.presetBy === 'channel' ? s.presetBy : undefined,
        llmOverrideBy: s.llmOverrideBy === 'user' || s.llmOverrideBy === 'channel' ? s.llmOverrideBy : undefined,
        system: s.system,
        permissionMode: s.permissionMode,
        mode: s.mode,
        transcript: rs.transcript,
        // ★1010 P0：外部流 PartEvent 记录恢复（与 persistSessions 的 extTranscript 对应）
        extTranscript: Array.isArray(rs.extTranscript) ? rs.extTranscript : undefined,
        extAcpSessionId: typeof (rs as any).extAcpSessionId === 'string' ? (rs as any).extAcpSessionId : undefined,
        extAcpModel: typeof (rs as any).extAcpModel === 'string' ? (rs as any).extAcpModel : undefined,
        subRuns: subRunsMap,
        // 旧文件没存 lastUsage（或重启前未落盘）时从 transcript 回填最后一条真实 usage，
        // 保证刷新后统计条（缓存命中/输入 token）不消失
        lastUsage: sLastUsage || undefined,
        lastTurnTiming: s.lastTurnTiming,
        modelUsage: derived.modelUsage,
        usedModels: derived.usedModels,
        // 批准记忆恢复（与 persistSessions 对应，重启后权限卡不再复弹）
        approvedTools: Array.isArray(s.approvedTools) ? s.approvedTools : undefined,
        memberSkills: (s.memberSkills && typeof s.memberSkills === 'object' && !Array.isArray(s.memberSkills)) ? s.memberSkills : undefined,
        turnMetas: Array.isArray(s.turnMetas) ? s.turnMetas : undefined,
        // ★ 0924：usage 账本恢复；旧文件没有就从 transcript 逐跳求和一次性回填（账单原始凭据；此后新轮次走单调账本）
        usageTotals: s.usageTotals && typeof s.usageTotals === 'object'
          ? {
              uncached: Number(s.usageTotals.uncached) || 0,
              cacheRead: Number(s.usageTotals.cacheRead) || 0,
              cacheWrite: Number(s.usageTotals.cacheWrite) || 0,
              output: Number(s.usageTotals.output) || 0,
              turns: Number(s.usageTotals.turns) || 0,
            }
          : deriveUsageTotalsFromTranscript(rs.transcript || []),
        contextSummary: typeof s.contextSummary === 'string' ? s.contextSummary : undefined,
        summaryStartIndex: typeof s.summaryStartIndex === 'number' ? s.summaryStartIndex : undefined,
        compactArchiveRel: typeof s.compactArchiveRel === 'string' ? s.compactArchiveRel : undefined,
        contextSummaries: Array.isArray(s.contextSummaries) ? s.contextSummaries : undefined,
      })
      n++
    }
    if (!opts.onlyId && sessions.size > 0) console.log(`[pi-bridge] restored ${sessions.size} sessions`)
  } catch (e) {
    console.error('[load] sessions failed:', e)
  }
  return n
}

/** 启动时全量还原（语义与改造前完全一致） */
function loadSessions(): void { hydrateSessionsFromDisk() }


/** 权限门禁：挂起的审批请求（requestId → PendingApproval） */
const pendingApprovals = new Map<string, PendingApproval>()
/** 询问卡：挂起的询问请求（requestId → PendingQuestion） */
const pendingQuestions = new Map<string, PendingQuestion>()
/** ★0926 链路修复③（防死循环）：同一会话对"同一操作"连续等不到授权的次数。
 *  背景（实测）：卡没人看见 → 10 分钟超时（如实按未授权收尾）→ 模型立刻重试同一操作 →
 *  再生成一张卡 → 再 10 分钟…… `9adb320c` 就这样循环了 3 轮（≈40 分钟），
 *  每次重试都是一次完整 LLM 调用（上下文含整篇 2000 字文章）⇒ 无人值守会一直烧 token。
 *  策略：同一操作连续 2 次超时 → 停止本轮（不再自动重试）+ 给用户一条内联提示。
 *  ★0929 P1 两处修正（原实现）：
 *  ① **误杀**：计数只在授权成功时清、**跨轮不复位** → 轮1 同工具超时 2 次后计数留存，
 *     用户新下指令进轮2，同一工具**首次超时就凑满 3 次 → 新轮直接被杀**（刚下指令就闭嘴）。
 *     修：agent_start（新轮开始）清空本会话计数，与 loopWindow 同位同义（上轮残留不误杀）。
 *  ② **单槽永不熔断**：原为 Map<sessionId,{fp,n}> 单槽 —— 工具 A/B 交替超时时 fp 不同互相
 *     冲掉计数，两边永远 n=1 ⇒ 0926 熔断**永不触发**，10 分钟一轮无限烧。
 *     修：改双层 Map<sessionId, Map<fp,{n,lastAt}>>，每工具独立累计、授权只清本工具。 */
const approvalTimeoutStreak = new Map<string, Map<string, { n: number; lastAt: number }>>()
/** 审批超时：10 分钟 */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

function createSession(title?: string, workDir?: string, presetId?: string, system?: string, teamId?: string, origin?: string, projectId?: string): SessionView {
  const id = crypto.randomUUID()
  const now = Date.now()
  // 会话工作区：传入即创建（普通聊天=储存目录下的时间戳子目录；项目=root_path 已存在，recursive 幂等）
  let resolvedWorkDir: string | undefined
  if (workDir && workDir.trim()) {
    try {
      fs.mkdirSync(path.resolve(workDir.trim()), { recursive: true })
      resolvedWorkDir = workDir.trim()
    } catch (e) {
      console.error('[session.create] workDir 鍒涘缓澶辫触:', e)
    }
  }
  const session: SessionView = {
    id,
    title: title || '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now,
    model: currentLlmConfig().model,
    modelProviderId: currentLlmConfig().providerId,
    status: 'idle',
    modelUsage: {},
    usedModels: [],
    workDir: resolvedWorkDir,
    // Agent 预设 id（创建时定型，运行中不换）与组装的系统提示词（人格/角色层、运行时层）
    presetId: presetId?.trim() || undefined,
    teamId: teamId?.trim() || undefined,
    system: system?.trim() || undefined,
    // 0912 接入批：来源通道（通道创建的会话带此标记，供「独享对话列表」过滤）
    origin: origin?.trim() || undefined,
    // 0917：项目归属（项目树子节点；空=本体聊天）
    projectId: projectId?.trim() || undefined,
    /* ★0927（①b）：新建会话的"已读起点"= 创建时刻。
       没有它，`unreadCountOf` 会因 `lastReadAt` 为空一直返回 0 ⇒ **新会话的第一条回复永远不出未读角标**
       （隔离实例实测抓到的真 bug：第一轮 unread=0、markRead 之后就正常了）。 */
    lastReadAt: now,
  }
  sessions.set(id, session)
  schedulePersist()
  return session
}

/**
 * 通道级「人格与称呼」覆盖（0912 七批）。
 *
 * 优先级：**机器人级 > 全局设置**（留空即回退）。QQ 每台机器人各一份；
 * 微信只有一台机器人 → 等效于「该通道一份」（用户明确要求）。
 *
 * 为什么在 buildDynamicSystem 里实时查而不是建会话时定型：
 * 改了配置要能对**已存在的会话**也立刻生效（否则用户改完发现"没反应"）。
 */
function channelPersonaOverride(session: SessionView | undefined): { nisName?: string; userName?: string; prompt?: string } {
  const ch = String(session?.origin || '').trim()
  if (!ch) return {}
  try {
    const cfg = getChannel(ch)
    if (!cfg) return {}
    const botId = String(session?.originBot || '').trim()
    const bot: any = botId
      ? (cfg.bots || []).find((b: any) => b.id === botId)
      : (cfg.bots || [])[0]
    if (!bot) return {}
    /**
     * 总开关判定：
     *   · 显式 'custom' → 应用覆盖
     *   · 显式 'global' → 不应用
     *   · **未设过（旧数据）但有内容 → 视为自定义** ← 兼容 0912 七批早期版本
     *     （那时没有 mode 开关，"填了即生效"；若按 global 处理会让用户已生效的配置静默失效）
     */
    const hasContent = !!(bot.personaName || bot.addressName || bot.personaPrompt)
    const isCustom = bot.personaMode === 'custom' || (!bot.personaMode && hasContent)
    if (!isCustom) return {}
    const pick = (v: any): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    return {
      nisName: pick(bot.personaName),
      userName: pick(bot.addressName),
      prompt: pick(bot.personaPrompt),
    }
  } catch { return {} }
}

/** 动态组装系统提示词（设置是权威来源：每次 prompt 读最新值，改设置即时生效） */
function buildDynamicSystem(session: SessionView | undefined): string {
  const lines: string[] = []
  // 通道覆盖优先（QQ 每台机器人 / 微信各一份；留空回退全局设置）
  const ov = channelPersonaOverride(session)
  const nisName = ov.nisName
    || (typeof globalSettings.nisName === 'string' && globalSettings.nisName.trim()
      ? globalSettings.nisName.trim()
      : (session?.system?.match(/你是\s*([^\s，。,]+)/)?.[1] || 'Nis'))
  lines.push(`你是 ${nisName}。`)
  const userName = ov.userName || (typeof globalSettings.userName === 'string' ? globalSettings.userName.trim() : '')
  if (userName && (ov.userName ? true : userName !== '用户')) {
    lines.push(`用户的名字是「${userName}」（来自设置，权威不可覆盖）。除非用户明确要求修改设置，否则一直这样称呼用户；用户说"叫我X"时先口头答应，并询问是否要更新设置里的名字。`)
  }
  /* ★ 0929（产品要求"流程图你不咋用"）：前端本就支持 mermaid 渲染（MarkdownBlock）——
     把"复杂流程画图"写成表达规矩。判据：多步流程/状态流转/架构关系/带分支的决策 → 画；
     三五步的直线顺序别硬画。 */
  lines.push('表达：复杂流程、状态流转、架构关系、带分支的决策——**优先用 ```mermaid 代码块画流程图**（界面会渲染成图）；简单的直线步骤别硬画，列表更清楚。')
  /* ★0930（产品要求"除非我主动提，AI 几乎不主动看记忆库/知识库"）：读纪律 ——
     自动召回只给一行线索，主动深查必须靠工具；什么时候该查写成硬规矩。 */
  /* ★0930 调研修正（《调研-记忆知识库主动读取与提示词降智-0930.md》结论②）：常驻指令越长越稀释
     （prompt-bloat 研究：~3000 token 起推理退化）——压到一句；「什么时候该查」的细则只留在工具描述
     （工具表里出现=模型调用时才付注意力），口号不逐轮念。 */
  lines.push('记忆与知识库（memory / knowledge）：涉及**偏好、历史、项目背景**的关键决策，先查再答（何时查/怎么查的细则见工具描述；消息里的[记忆召回]行只是线索）。')
  /* 0910 三批⑤：项目档案（工作区根 NIS-notes.md）——跨窗口共享的项目记忆。
     ★1012c（缓存稳定性根治）：**这段必须逐字节稳定** —— 它落在缓存前缀里，一变就是整条历史全价重算。
     病根（实测）：旧版把"档案卡"（含最近进度/各节行范围等**随档案变动**的数字）拼在这里，
     而 system 是**建 agent 时组装一次**的 ⇒ 每次 agent 重建（重启后端 / 改预设·人格·MCP / 换团队）
     卡片内容一更新，整条前缀从卡片处作废 = 该会话下一次请求**一次全价重算**
     （本工作会话实测：重启后第一跳 121,702 token 全价、0% 命中，占该轮输入 14%）。
     现在这里只留"条件式、不含任何数字"的稳定提示，真卡片改由**本轮消息**附带
     （见 runPromptCore 里 [项目档案卡] 的注入）——消息里的内容变了只影响本轮新增，动不到前缀。
     顺带省掉每会话一次的 existsSync + 建卡（"若有"条件式文案已覆盖"有/没有"两种情况）。 */
  if (session?.workDir) {
    lines.push('项目档案（跨窗口共享的项目记忆）：本工作区若有 NIS-notes.md，**别整份 fs_read**（它可能几十万字符）——'
      + '看本轮消息附带的「[项目档案卡]」行（体量 + 各节行范围 + 最近进度/决策），'
      + '或用 project_note(action="read") 先拿目录再按节取（section="当前进度" 等；档案很长时别整节读）；'
      + '开始多步骤项目、或完成阶段性任务时用 project_note 更新它，让同项目的其他窗口看到最新进度。')
  }
  const prompt = ov.prompt || (typeof globalSettings.prompt === 'string' ? globalSettings.prompt.trim() : '')
  if (prompt) {
    lines.push(`你的性格与说话方式：${prompt}`)
  }
  /*  ★1012m-v2（用户定稿）：① **删掉**了原来的第 6 条"娱乐场景不抬杠" —— 用户的口径是
      "忘了就让用户自己去关掉就好"，开关本身就是唯一裁决，不再在提示词里做场景例外；
      ② 加了**优先级声明**：LLM 没有数值权重，但"显式声明冲突时以谁为准"能达到同样效果
      （位置在人设之后=近因 + 独立小节 + 硬措辞"一律以本节为准"三管齐下）。
      目标场景是用户的原话："性格软萌、服从，但开启了这个模式 ⇒ 软萌可以执行，服从和这个冲突，
      所以以这个提示词为主"——即人格只决定**语气风格**，行为要求以本节为准。 */
  if ((globalSettings as any).criticDiscipline !== false) {
    lines.push(
      '## 工作原则（判断与纠错）—— **本节优先于上方的人格/性格设定**\n'
      + '本节规则优先于"你的性格与说话方式"里的任何表述。若人格里写了"绝对服从""不许反驳用户""一切照做"'
      + '之类，与本原则冲突时**一律以本节为准**：人格只决定你的**语气、称呼与表达风格**'
      + '（可以继续软萌、亲切、活泼），但不改变本节的行为要求——该指出的问题照样指出，没把握就照样说没把握。\n'
      + '1. 用户的前提若与事实不符（技术事实、路径、结论、数据口径），**先指出再动手**，不要闷头执行错误前提。\n'
      + '2. 不确定就说不确定；不要为了让对话顺畅而假装同意，也不要用模糊措辞掩盖没把握。\n'
      + '3. 看到更简单、更安全或更省钱的做法，主动说出来（哪怕用户没问），但讲清代价、由用户拍板。\n'
      + '4. 被纠正时先验证事实再回应；错了就改并说明原因，不情绪化道歉、也不无原则认错。\n'
      + '5. 报数据必须标明口径（例如"缓存命中率"是首跳还是轮求和、统计区间是什么），避免让用户误判。'
    )
  }
  // 预设角色层（会话创建时定型的部分，从原 system 里提取角色/工作目录行）
  const base = session?.system || ''
  for (const line of base.split('\n')) {
    if (line.includes('你的角色与专长') || line.includes('当前工作目录')) {
      lines.push(line)
    }
  }
  return lines.join('\n')
}

/** 安装助手系统提示词：技能/MCP 安装的对话式流程 */
/* ★ 0921q：技能开关（用户需求）——
 *  ① 每技能开关：globalSettings.disabledSkills（存"关掉的"更安全：新装技能默认可用）；
 *  ② 主开关：globalSettings.skillAutoSelect（默认 true）—— 关掉则**技能清单整体不注入**，
 *     AI 不会主动挑技能；但**手动选择仍然有效**（0921z-2 用户修正：主开关只管"AI 自主性"，
 *     输入框技能按钮 / 成员配置里选中的技能、消息里的 [skill:名称] 一律照办）。
 *  ③ 一致性：清单注入与 use_skill 执行**共用同一套判定**，不会出现"清单里没有、却能调"的漏洞。 */
function skillDisabledSet(): Set<string> {
  const off = (globalSettings as any).disabledSkills
  return new Set(Array.isArray(off) ? off.map((x: any) => String(x)) : [])
}
function isSkillEnabled(name: string): boolean {
  return !skillDisabledSet().has(String(name || ''))
}
function skillAutoSelectOn(): boolean {
  return (globalSettings as any).skillAutoSelect !== false
}
async function getEnabledSkills(): Promise<any[]> {
  const all = await getSkills()
  const off = skillDisabledSet()
  return all.filter((x: any) => !off.has(String(x.name)))
}



/** 团队成员独立模型解析：providers 状态里找 modelId（需已配 Key/base）；失效返回 null（运行时回退 shared 并告警） */
function resolveTeamMemberModel(member: { modelMode?: string; modelId?: string }): ModelOverride | null {
  const mid = String(member?.modelId || '').trim()
  if (!mid) return null
  for (const prov of getState().providers) {
    const found = (prov.models || []).find(x => x.id === mid)
    if (found && prov.apiKey && prov.base) {
      return {
        providerId: prov.id,
        providerName: prov.name,
        base: String(prov.base).replace(/\/+$/, ''),
        apiKey: plainKeyById(prov.id),        // ★ 1001：取明文（原为 prov.apiKey = 落盘密文，成员子流必 401）
        model: mid,
        // 0910：成员独立模型同带协议（原生协议供应商成员请求不能退回 openai 格式）
        protocol: prov.protocol || 'openai-completions',
      }
    }
  }
  return null
}

/** 0908三：解析会话 model 的归属供应商。显式记录优先；存量会话（字段上线前创建）按 model id
 *  在供应商表反查——当前激活供应商优先（同名模型多处存在时取用户最可能在用的）。查不到返回 ''。 */
function resolveModelProviderId(modelId: string, explicit?: string): string {
  const st = getState()
  if (explicit && st.providers.some(p => p.id === explicit)) return explicit
  if (!modelId) return ''
  const active = st.providers.find(p => p.id === st.providerActive)
  if (active && (active.models || []).some(x => x.id === modelId)) return active.id
  const hit = st.providers.find(p => (p.models || []).some(x => x.id === modelId))
  return hit?.id || ''
}

/** 团队运行时上下文工厂（0904 单聊抽取）：getOrCreateAgent 挂派发工具与 session.memberPrompt 单聊共用同一构造，
 *  避免两处 ctx 漂移。session 实时查（成员 workDir/permissionMode 等运行期可被 configure 改）。 */
function buildTeamCtx(sessionId: string, teamDef: TeamDef): TeamCtx {
  // use_skill（与主 agent 内联版同实现；成员工具池需要）
  const skillParams = TbType.Object({
    name: TbType.String({ description: '技能名称（见系统提示词中的可用技能清单）' }),
  })
  const skillTool: AgentTool<typeof skillParams, any> = {
    name: 'use_skill',
    label: '使用技能',
    description: '加载指定技能的完整执行指令。当用户任务匹配可用技能清单中的某项、或用户消息带有 [skill:名称] 标记时调用；返回指令后严格按其流程完成任务。',
    parameters: skillParams,
    async execute(_callId, params) {
      const skills = await getEnabledSkills()   // ★ 0921q：只认启用的技能
      const s = skills.find(x => x.name === params.name)
      if (!s) throw new Error(`未知技能：${params.name}。可用技能：${skills.map(x => x.name).join('、') || '(无)'}`)
      if (!isSkillEnabled(s.name)) throw new Error(`技能「${s.name}」已被停用（技能仓库里可重新开启）`)
      /* ★ 0921z-2（用户修正）：主开关 `skillAutoSelect` **只管"AI 自主性"** —— 决定技能清单注不注入；
         它**不再拦 use_skill**：用户手动点技能按钮 / 消息里写 [skill:名称] 是用户意志，AI 照办。 */
      return { content: [{ type: 'text', text: `# 技能已加载：${s.name}\n\n${s.content}` }], details: { skill: s.name } }
    },
  }
  return {
    sessionId,
    team: teamDef,
    broadcast: (frame) => broadcastMux(sessionId, frame as MuxFrame),
    log: (level, category, message, data) => sessionLog(sessionId, level, category as any, message, data),
    buildMemberToolPool: (actor?: string, lock?: { owner: string; label: string }) => {
      const session = sessions.get(sessionId)
      const cwd = session?.workDir?.trim() || process.cwd()
      // 0910 二批 F：actor 由成员实例传入，闭包捕获文件快照署名（并发多实例互不覆盖）
      // 0910 三批④：快照带会话 id —— 撤销按对话隔离，成员改的文件也不会串到别的对话
      // 0911 反馈③：lock 由成员 run 传入（owner=runId）——fs_write/fs_delete 写前查锁，并行互斥防静默覆盖
      return [...buildSessionTools(cwd, actor, sessionId, lock), ...buildMemoryTools({ projectId: String(session?.projectId || '') }), ...buildNotebookTools(), ...buildWebTools(), skillTool, buildAskUserTool(sessionId)]
    },
    // 成员子流（派发/单聊共用）：sub=true 抑制主时间线重试通知/压缩/上下文环明细（0904 修复串扰）
    // 0910：成员独立模型可带自己的推理挡位（member.effort，缺省 deep=原行为）
    createSubStreamFn: (sysSub, override, extraSignal, effort, actor?: string, onStreamNote?: (n: { kind: string; attempt: number; reason: string }) => void) => createStreamFn(sysSub, sessionId, { llmOverride: override ?? undefined, effort: effort || 'deep', signal: extraSignal, sub: true, actor, onStreamNote }),
    resolveMemberModel: (member) => resolveTeamMemberModel(member),
    // 0910 三批②：成员模型档位——显式 fast/standard/strong 直接用；auto 或未设 = "系统识别"，
    // 按该成员实际生效模型的能力自动判定（带 reasoning 能力→strong，其余→standard）
    resolveMemberCapability: (member) => {
      const raw = String((member as any).capability || '').trim()
      if (raw === 'fast' || raw === 'standard' || raw === 'strong') return { level: raw as 'fast' | 'standard' | 'strong', auto: false }
      const ov = resolveTeamMemberModel(member)
      let mid = String(ov?.model || '').trim()
      if (!mid) { try { mid = String(currentLlmConfig().model || '').trim() } catch { mid = '' } }
      let caps: any = null
      for (const prov of getState().providers) {
        const f = (prov.models || []).find(x => x.id === mid)
        if (f) { caps = (f as any).capabilities || (f as any).supports || null; break }
      }
      const arr: string[] = Array.isArray(caps) ? caps : []
      const reasoning = arr.includes('reasoning') || !!(caps && caps.reasoning)
      return { level: reasoning ? 'strong' : 'standard', auto: true }
    },
    memberSkills: (memberId: string) => {
      const s2 = sessions.get(sessionId)
      const arr = s2?.memberSkills?.[memberId]
      return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : []
    },
    approval: async (toolName, args) => {
      const s = sessions.get(sessionId)
      if (!s) return undefined
      const mode = s.permissionMode || 'confirm'
      if (mode === 'full_access') return undefined
      if (mode === 'self_audit') {
        sessionLog(sessionId, 'info', 'approval', `[团队] 自审计：成员调用 ${toolName}`)
        return undefined
      }
      const fp = toolFingerprint(sessionId, toolName, args)
      if (s.approvedTools?.includes(fp)) return undefined
      const hr = await awaitApproval(sessionId, {
        needApproval: true, risk: toolName === 'fs_delete' ? 'high' : 'medium',
        tool: toolName,
        toolDisplay: toolName,
        question: `团队成员请求执行 ${toolName}（${toolName === 'fs_write' ? '写入文件' : toolName === 'fs_delete' ? '删除文件' : '执行命令'}）`,
        args,
      } as any, undefined)
      return { block: hr.block, reason: hr.reason }
    },
    workDir: () => sessions.get(sessionId)?.workDir?.trim() || process.cwd(),
    // 会话当前模型（跟随会话的成员/被中断的 run 记录也带模型标签）
    sessionModel: () => {
      /* ★1012t 收尾：走统一解析口（通道会话未单独配模型时=后台模型），标签才与实际发出去的模型一致 */
      const mid = String(resolveSessionLlm(sessionId)?.model || '').trim()
      if (mid) return mid
      try { return currentLlmConfig().model || '' } catch { return '' }
    },
    syncPlan: (items) => {
      // 0910 三批①：黑板写自己的字段，不再覆盖主 agent 的 plan（二者曾共用一个字段=计划面板串台）
      const s = sessions.get(sessionId)
      if (s) { s.boardPlan = items; schedulePersist() }
      broadcastPlan(sessionId)
    },
  }
}


/** ── 工具唯一源接线（0904 捋顺）──────────────────────────────
 * mcpToolsForPreset：预设级 MCP 授权（④c 总开关）。preset.mcp===false → 该 agent 不注入任何 MCP；
 * 否则（缺省 true）= 所有"已启用 ∧ 已选择"的 server 工具（getMcpAgentTools 内已按 开关B+selected 过滤）。
 * 旧的 per-server 白名单 preset.mcpServers 已废弃（选择动作上移到「工具」页复选）。 */
function mcpToolsForPreset(preset: { mcp?: boolean } | null | undefined, sessionId?: string): AgentTool<any>[] {
  const all = getMcpAgentTools(sessionId)
  if (preset?.mcp === false) return []
  return all
}

/** 注册表实时视图（agentPreset.tools RPC / list_tools / 前端仓库三处消费的唯一出口） */
function currentToolRegistry(): ToolRegistryEntry[] {
  return buildToolRegistry({
    mcpTools: getMcpAgentTools().map(t => ({ name: t.name, label: (t as any).label || t.name, description: (t as any).description || '', server: String(t.name).split('__')[1] || '' })),
    customTools: getCustomAgentTools().map(t => ({ name: t.name, label: (t as any).label || t.name, description: (t as any).description || '' })),
  })
}
/** MCP server 汇总视图（PluginsModal 开关B 停用 / ④b 服务选择 复选 / AgentModal 总开关展示） */
function currentMcpServersView(): Array<{ name: string; enabled: boolean; selected: boolean; connected: boolean; status: string; toolCount: number; description: string }> {
  return getMcpStatus().map(s => ({
    name: s.name,
    enabled: s.config?.enabled !== false,
    selected: s.config?.selected !== false,
    connected: s.status === 'connected',
    status: s.status,
    toolCount: s.tools.length,
    description: String(s.config?.description || ''),
  }))
}

/* ── 0908 action-error 熔断（对齐 OpenHands stuck_detector：连续 error 即信号，不看参数是否相同）──
 * 直击"curl 换 43 种参数探测死端口"这类【换参重试】循环——现有同指纹熔断要求"参数+结果全同"，
 * 对换参重试完全失明。此计数器统计【同一工具连续失败】（含非零退出/错误文案），
 *  - nudge：通过 afterToolCall 改写返回给模型的 tool result（追加一条提示），模型必然看到（P0-2 落地）；
 *  - 硬停：连续失败达 HARD 阈值置 hardStop，由 shouldStopAfterTurn 读取结束本轮；prompt 开始时复位。
 * 阈值：软提醒 3 次起、每 3 次重复注入一次；硬停 8 次。 ── */
const LOOP_ERR_SOFT = 3
const LOOP_ERR_HARD = 8
const loopGuardState = new Map<string, { lastTool: string; errRun: number; hardStop: boolean }>()
function resetLoopGuard(sessionId: string) { loopGuardState.set(sessionId, { lastTool: '', errRun: 0, hardStop: false }) }
/* ★ 0923 修（实测：正常编辑被误判成"连续失败 8 次"硬熔断）：
   旧正则拿**通用词**去工具返回里搜（含「超时/无法/未找到/不存在/error/failed」），
   而 fs_edit 的成功返回**会带"替换后上下文"** —— 只要上下文里出现这些词（例如 i18n 文案
   「问题卡超时无应答」）就被计成一次失败，连中 8 次直接熔断。
   现在：① 结构化标志 ctx.isError 为准；② 命中**成功标志**直接判成功；
   ③ 正则只保留**强错误信号**（工具级失败文案 / 异常栈 / 退出码 / 命令不存在）。 */
const LOOP_OK_RE = /(已替换|已写入|已创建|已删除|已更新|执行完成|全部通过|已完成|保存成功)/
const LOOP_FAILURE_RE = /(工具执行失败|操作失败|执行失败|已拒绝|拒绝：|失败：|报错|未就绪|未找到匹配|无法定位|Error:|\[err\]|exit[ _]?code[: ]*[1-9]|ENOENT|ECONNREFUSED|traceback|command not found|is not recognized)/i
/** 永久失败（环境/依赖缺失）：换参数重试不可能修好，第一次就下"停用"强指令（OpenHands error 档加强版） */
/* ★ 0923：同步收紧 —— 裸 `not found`/`binary`/`启动失败` 太泛（正常输出里也可能出现），
   只留"命令/依赖确实不存在"的强信号，避免给正常调用硬塞"永久失败"强指令。 */
const LOOP_PERMANENT_RE = /(not installed|未安装|command not found|is not recognized|不是内部或外部命令|无法找到该命令|ENOENT)/i
function makeAfterToolCall(sessionId: string) {
  return async (ctx: any): Promise<undefined | { content?: unknown[] }> => {
    try {
      const name = String(ctx?.toolCall?.name || '')
      const g = loopGuardState.get(sessionId) || { lastTool: '', errRun: 0, hardStop: false }
      const contentArr: any[] = Array.isArray(ctx?.result?.content) ? ctx.result.content : []
      const textAll = contentArr.map((c: any) => (c?.type === 'text' ? String(c.text || '') : '')).join(' ').slice(0, 1000)
      /* ★ 0923：成功标志优先 —— 正常返回里出现"超时/失败"等词不再被误判（见上方 LOOP_OK_RE 注释） */
      const isErr = !!ctx?.isError || (LOOP_FAILURE_RE.test(textAll) && !LOOP_OK_RE.test(textAll))
      if (isErr && name && name === g.lastTool) g.errRun++
      else if (isErr) g.errRun = 1
      else g.errRun = 0
      g.lastTool = name
      if (g.errRun >= LOOP_ERR_HARD) g.hardStop = true
      loopGuardState.set(sessionId, g)
      const permanent = isErr && LOOP_PERMANENT_RE.test(textAll)
      if (permanent) {
        return { content: [...contentArr, { type: 'text', text: `\n\n【循环防护】该错误表明工具或其依赖在当前环境【不存在】（永久性失败），换参数/重试不可能修好。请【停止调用此工具】，直接告知用户缺什么、如何恢复，或改用其他方式完成任务。` }] }
      }
      if (isErr && g.errRun >= LOOP_ERR_SOFT && (g.errRun - LOOP_ERR_SOFT) % 3 === 0) {
        const nudge = `\n\n【循环防护】同一工具已连续失败 ${g.errRun} 次。换参数/换命令重试基本无效——问题通常不在调用方式。请【停止重试该操作】，直接如实告诉用户：你要做什么、遇到的错误、为何放弃、下一步建议。${g.errRun >= LOOP_ERR_HARD ? '（已达硬熔断阈值，本轮即将强制停止。）' : ''}`
        return { content: [...contentArr, { type: 'text', text: nudge }] }
      }
    } catch { /* 计数失败绝不影响工具正常返回 */ }
    return undefined
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 0909⑦ 排队消息（队列）+ 插话（steering）——后端权威账本（用户铁律：禁 localStorage 兜底）
 *  - 队列：AI 忙时发送入 session.queuedMessages（随 sessions.json 持久化，重启不丢；
 *    多窗口经 session/projection(key=queue) 帧同步同一份）。整轮自然结束（agent_end 非中断非错误）
 *    且无挂起审批/询问 → 自动取最旧一条走 runPromptCore 发出（审批挂起期冻结，防坑 3）。
 *  - 插话：session.steer 接 pi 原生 agent.steer()/followUp()（注入点=当前轮工具批次跑完、
 *    下次 LLM 调用前，业界共识边界；绝不 abort 流）。agent 空闲时返回 steered:false，前端降级入队。
 *  ════════════════════════════════════════════════════════════════════════════ */
const QUEUE_MAX = 20
/** 会话是否有挂起交互（审批卡/询问卡）：队列 flush 的闸门（审批=当前 turn 内工具执行的一部分，不能越过） */
function hasPendingInteraction(sessionId: string): boolean {
  for (const pa of pendingApprovals.values()) if (pa.sessionId === sessionId) return true
  for (const pq of pendingQuestions.values()) if (pq.sessionId === sessionId) return true
  return false
}

/** ★0926 链路修复②（数据层）：该会话"在等用户什么" —— permission=权限卡 / question=询问卡。
 *  为什么要有它：`session.list` 是侧栏的**权威数据源**，而"在等用户"这个状态此前**只靠实时帧**
 *  才能被前端知道 ⇒ 换窗口/刷新后侧栏只有"回复中"转圈（跟"AI 正在干活"长得一模一样），
 *  用户根本看不出"它在等我点卡"（实测：新开窗口里"等待权限/等待回复"命中 0，
 *  而该会话其实有一张权限卡挂了 40 分钟）。这里把既有事实（两张挂起表）暴露给列表。 */
function awaitingUserKind(sessionId: string): 'permission' | 'question' | null {
  for (const pa of pendingApprovals.values()) if (pa.sessionId === sessionId) return 'permission'
  for (const pq of pendingQuestions.values()) if (pq.sessionId === sessionId) return 'question'
  return null
}

/** ★0926 链路修复②（配套）：交互结束（已应答/超时/会话被停）→ 广播给**所有窗口 + 该会话**。
 *  没有它就会留脏标记：A 窗口答了卡，B 窗口的"等待你"标记会一直挂着（假等待），
 *  直到 B 恰好刷新列表 —— 那又是"状态靠运气"的老毛病。
 *  ★0927 修：带上 `reason` —— 原来四种情况共用一帧，前端一律显示「已在其他窗口应答」，
 *  于是"你自己刚点的同意"也被写成"别的窗口答的"（实测困惑）。现在前端按原因说实话。 */
function broadcastInteractionDone(sessionId: string, kind: 'permission' | 'question', requestId: string, reason: 'answered' | 'timeout' | 'cancelled' = 'answered'): void {
  const frame = { type: 'session/interaction-done', sessionId, kind, requestId, reason } as any
  try { writeMuxTo(sessionId, frame) } catch { /* ignore */ }
  try { writeMuxTo('', frame) } catch { /* ignore */ }
}
function broadcastQueue(sessionId: string): void {
  const s = sessions.get(sessionId)
  try {
    broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'queue', seq: Date.now(), value: { queue: s?.queuedMessages || [], paused: queuePaused.has(sessionId), mode: cancelQueueMode() } })
  } catch { /* ignore */ }
}
/* ══ ★0927 N1 停止键与队列（已定案：甲/乙 做成设置项 + 搭配丙）══════════════════════════
 *  病案：用户按「停止」后，排队消息**永远发不出去**（cancel 里 agents.delete ⇒ agent_end 被订阅
 *  守卫丢弃 ⇒ 唯一触发点失效）＝ 永久卡死；而直发 prompt 又从不看队列 ⇒ 新消息插队（先发后到）。
 *  语义：
 *   · 丙（无条件、优先级最高）：队列**恰好 1 条** → 退回输入框（内容不丢、可改），不自动发。
 *     依据 = pi 官方 TUI 的 Esc（clearQueue() → 放回编辑器 → abort）；Claude Code ≥2.1 同源。
 *   · 甲 `continue`（默认）：停止只停当前轮，队列按 FIFO 依次续发。
 *   · 乙 `pause`（设置项）：停止同时把队列按暂停，界面明写「已暂停 · 继续发送」——绝不静默。
 *  ⚠️ 非用户主动停止（撞墙 loopBreak / 审批超时）一律走 `continue`，不许把队一起按死。 */
const queuePaused = new Set<string>()
function cancelQueueMode(): 'continue' | 'pause' {
  return (globalSettings as any).cancelQueueMode === 'pause' ? 'pause' : 'continue'
}
/** 队列位次（N4：给调用方/界面"我排第几"） */
function queuePosOf(sessionId: string, itemId: string): { queuePosition: number; queueLength: number } {
  const q = queueSnapshot(sessionId)
  const i = q.findIndex(x => x.id === itemId)
  return { queuePosition: i >= 0 ? i + 1 : q.length, queueLength: q.length }
}
/** 用户按「停止」时的队列处置（丙 / 甲 / 乙） */
function handleUserCancelQueue(sessionId: string): void {
  const s: any = sessions.get(sessionId)
  const q: QueuedMsg[] = Array.isArray(s?.queuedMessages) ? s.queuedMessages : []
  if (!q.length) return
  if (q.length === 1) {
    /* 丙：唯一一条退回输入框（前端按帧回灌编辑器；复用其现成的 queueItem 回灌逻辑） */
    const item = q.splice(0, 1)[0]
    schedulePersist(sessionId)
    broadcastQueue(sessionId)
    try { broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'queue-return-to-editor', seq: Date.now(), value: { item } }) } catch { /* ignore */ }
    /* 用户可见提示（≤60 字）：让用户知道"消息没丢，回输入框了" */
    try { broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: '已停止本轮：队里那条已退回输入框，可改完再发' } }) } catch { /* ignore */ }
    sessionLog(sessionId, 'info', 'lifecycle', '停止：队里唯一一条已退回输入框（丙）', { guard: 'cancel-queue-return' })
    return
  }
  if (cancelQueueMode() === 'pause') {
    /* 乙：暂停 + 明示（界面出「继续发送」按钮） */
    queuePaused.add(sessionId)
    broadcastQueue(sessionId)
    try { broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: `已停止。队列 ${q.length} 条已暂停——点「继续发送」接着发` } }) } catch { /* ignore */ }
    sessionLog(sessionId, 'info', 'lifecycle', `停止：队列 ${q.length} 条进入暂停（乙）`, { guard: 'cancel-queue-pause' })
    return
  }
  /* 甲：继续按序发（setTimeout 让 abort 收尾先落地；flush 内还有 agent-busy 闸门兜底） */
  queuePaused.delete(sessionId)
  sessionLog(sessionId, 'info', 'lifecycle', `停止：队列 ${q.length} 条继续按序发送（甲）`, { guard: 'cancel-queue-continue' })
  setTimeout(() => { try { flushNextQueued(sessionId) } catch { /* ignore */ } }, 0)
}
/** 非用户主动停止（撞墙/超时）→ 队列照旧往前走，绝不按死 */
function resumeQueueAfterAutoStop(sessionId: string): void {
  if (!queueSnapshot(sessionId).length) return
  queuePaused.delete(sessionId)
  setTimeout(() => { try { flushNextQueued(sessionId) } catch { /* ignore */ } }, 0)
}
/** 有界等待队列排空（给"要本轮结果才敢继续"的内部调用方：定时任务 / 群插嘴） */
async function waitQueueDrained(sessionId: string, maxMs = 10 * 60 * 1000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (!queueSnapshot(sessionId).length) return
    await new Promise((r) => setTimeout(r, 500))
  }
}
function queueSnapshot(sessionId: string): QueuedMsg[] {
  return sessions.get(sessionId)?.queuedMessages || []
}

/* ════════════════════════════════════════════════════════════════════════════
 * ★0927 P0-1 同会话并发发送（实测 4/4 丢第二条）——判据 + 兜底
 *  病根：runPromptCore 直调 pi 的 agent.prompt()，运行中它**直接裸抛**英文错；
 *        而"用户消息落史"挂在 agent 流事件里 ⇒ 一抛就无处落史 = 整条消息蒸发
 *        （UI 有失败气泡可重发，但通道/API/定时任务/多窗口没有兜底）。
 *  修法：忙 → 走产品**已有**的排队机制（queuePush + 整轮自然结束自动续发，实测可用），
 *        与 opencode/pi 的原生 followUp 队列语义一致（抄一丢丢，不造新轮子）。
 * ════════════════════════════════════════════════════════════════════════════ */
/** pi 裸英文错识别（内部 API 名不许漏给用户） */
const AGENT_BUSY_RE = /already processing a prompt|Agent is already processing|Use steer\(\) or followUp\(\)/i
function isAgentBusyError(e: any): boolean {
  return AGENT_BUSY_RE.test(String(e?.message || e || ''))
}
/** 本会话 agent 是否在跑。判据取 pi 的 activeRun（prompt() 抛错的真条件），
 *  state.isStreaming 与它同生命周期（finishRun 里一起清）——用两个 || 兜住私有字段缺失的情况。 */
function sessionAgentBusy(sessionId: string): boolean {
  if (externalRuns.has(sessionId)) return true   // ★1001 外部轮（codex 子进程）也算忙：排队语义一致
  const ag: any = agents.get(sessionId)
  if (!ag) return false
  return !!ag.activeRun || !!ag.state?.isStreaming
}
/** 有界等待本会话跑完（只给"要本轮结果才敢继续"的调用方：定时任务 / 群插嘴读回复）。返回是否已空闲 */
async function waitSessionAgentIdle(sessionId: string, maxMs = 10 * 60 * 1000): Promise<boolean> {
  const ag: any = agents.get(sessionId)
  if (!ag?.waitForIdle) return !sessionAgentBusy(sessionId)
  let timer: any = null
  const timeout = new Promise<void>((r) => { timer = setTimeout(r, maxMs) })
  try {
    await Promise.race([ag.waitForIdle(), timeout])
  } catch { /* 等不到也按实测状态判 */ }
  finally { if (timer) clearTimeout(timer) }
  return !sessionAgentBusy(sessionId)
}
/** 忙时把这条用户消息放进既有队列（不裸抛、不丢）。返回错误文案（队列满等）或 null */
function enqueueBusyPrompt(sessionId: string, p: Record<string, unknown>, message: string, opts?: { notice?: string; log?: string; guard?: string; id?: string }): string | null {
  const itemId = opts?.id || String((p as any)?.clientMessageId || crypto.randomUUID())
  const err = queuePush(sessionId, {
    id: itemId,
    text: message,
    attachments: Array.isArray(p?.attachments) ? p.attachments as QueuedMsg['attachments'] : undefined,
    skills: Array.isArray(p?.skills) ? (p.skills as string[]) : undefined,
    model: p?.model as QueuedMsg['model'],
    effort: typeof p?.effort === 'string' && p.effort ? p.effort : undefined,
    createdAt: Date.now(),
  })
  if (err) return err
  const n = queueSnapshot(sessionId).length
  sessionLog(sessionId, 'info', 'lifecycle', opts?.log || `忙时发送 → 已入队（队列 ${n} 条，本轮结束自动发出）`, { guard: opts?.guard || 'busy-enqueue' })
  /* 用户可见提示（≤60 字）：不静默排队——否则用户以为消息丢了（诊断档 §5.4「排队无反馈」） */
  try {
    broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: opts?.notice || 'AI 正在回复：这条消息已排队，本轮结束后自动发出' } })
  } catch { /* 广播失败不影响入队 */ }
  return null
}
/** ★0927 P0-2：错误出口**人话化**（裸露内部 API 名/内部 code 不许进用户视野）。
 *  实测漏出两条：① pi 的 "Use steer() or followUp() to queue messages…"（直接暴露内部方法名）；
 *  ② 工人崩溃 "code=4294967295（=-1 的无符号）… type=run-prompt#11"（内部实现细节）。
 *  口径：命中已知内部错误 → 中文一句话（≤60 字，用户能落到"下一步干什么"）；未命中 → 原文透传（不编造不吞错），
 *  并把原始文案留给日志（console.warn）以保证可排查。 */
function humanizeUserFacingError(raw: string): string {
  const s = String(raw || '')
  if (!s) return s
  let out = s
  if (AGENT_BUSY_RE.test(s)) out = '上一条回复还在生成中：这条消息没发出，可重试或等它跑完'
  else if (/会话工人崩溃退出|会话工人发送失败/.test(s)) out = '后台会话进程意外退出，这条消息没能发出（可重试，其他对话不受影响）'
  else if (/会话工人任务超时/.test(s)) out = '这条消息处理超时被中止（可重试，其他对话不受影响）'
  else if (/会话工人池启动失败|会话工人不可用|会话工人池已关闭/.test(s)) out = '后台会话进程起不来，请重启 NIS 后再试'
  else if (/会话工人中/.test(s) || /type=run-prompt#/.test(s)) out = '后台会话进程异常，这条消息没能发出（可重试）'
  if (out !== s) {
    try { console.warn('[pi-bridge] 内部错误已翻译给用户:', s.slice(0, 300)) } catch { /* ignore */ }
  }
  return out
}

/** ★0927 N3：**turn 级失败如实回报**（保守档：不惊动界面，只让调用方别被"成功"骗）。
 *  病案：坏模型/上游 400 时 pi 把错误变成一条 `stopReason:'error'` 的 assistant 消息后 `prompt()` 正常 resolve
 *  ⇒ 旧代码无条件 `return {ok:true}` —— 通道/定时任务/API 全被"成功"骗过（实测 N3）。
 *  现在：本轮以 error 收尾 → 结果里如实带 `turnFailed:true` + 人话 error（前端观感不变，仍显示失败气泡）。
 *  （严格档 `ok:false` 会让前端多弹失败提示——需用户再拍，这里先不做。） */
function turnLevelFailure(sessionId: string): { turnFailed: true; error: string } | null {
  const s: any = sessions.get(sessionId)
  /* ★0927：**两个池都要看** —— `messages`（正常轮的整条组装）和 `transcript`（agent 实时消息，
     失败轮不走"整轮组装"那条路，失败消息只进 transcript）。只读 messages 会漏判（实测：
     历史里 stopReason=error、RPC 却回 ok=true）。 */
  for (const msgs of [s?.messages, s?.transcript]) {
    if (!Array.isArray(msgs) || !msgs.length) continue
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 4; i--) {
      const m = msgs[i]
      if (m?.role !== 'assistant') continue
      if (m.stopReason === 'error') {
        const raw = String(m.errorMessage || '本轮以错误收尾（无错误详情）').slice(0, 300)
        return { turnFailed: true, error: humanizeUserFacingError(raw) }
      }
      break   // 这个池最后的 assistant 不是 error ⇒ 不用再往前看
    }
  }
  return null
}

/** ★0927 P0-1 兜底：忙检查之后、prompt 调用之前仍有窄竞态（同刻两条都过了检查）。
 *  命中 pi 的"运行中重复 prompt"裸错 → 按忙时策略入队（消息不丢）。返回入队项 id（失败返回 null）。 */
function rescueBusyPromptToQueue(sessionId: string, p: Record<string, unknown>, message: string, e: any): string | null {
  if (!isAgentBusyError(e) || (p as any).__fromQueue === true) return null
  const itemId = String((p as any)?.clientMessageId || crypto.randomUUID())
  const qErr = enqueueBusyPrompt(sessionId, p, message, { id: itemId })
  if (qErr) return null
  scheduleQueueFlushRetry(sessionId)
  return itemId
}
/** ★0927：窄竞态兜底 —— "本轮 agent_end→waitForIdle 的 flush 刚跑过（当时队列是空的）、随后才入队"。
 *  这时没有别的 flush 触发点，队列会一直等下去。有限次重试（agent 还忙就再等，绝不空转/绝不并发派活）。 */
function scheduleQueueFlushRetry(sessionId: string, tries = 8): void {
  if (tries <= 0) return
  setTimeout(() => {
    if (!sessions.get(sessionId)?.queuedMessages?.length) return
    if (sessionAgentBusy(sessionId)) { scheduleQueueFlushRetry(sessionId, tries - 1); return }
    flushNextQueued(sessionId)
  }, 600)
}
/** 入队（校验/上限/持久化/广播统一入口）。返回错误文案或 null */
function queuePush(sessionId: string, item: QueuedMsg): string | null {
  const s = sessions.get(sessionId)
  if (!s) return '会话不存在'
  if (!item.text.trim()) return '消息为空'
  if (!Array.isArray(s.queuedMessages)) s.queuedMessages = []
  if (s.queuedMessages.length >= QUEUE_MAX) return `排队已满（上限 ${QUEUE_MAX} 条）`
  s.queuedMessages.push(item)
  schedulePersist()
  broadcastQueue(sessionId)
  return null
}
/** 整轮自然结束后的自动续发：取最旧一条走与 session.prompt 同一条核心路径。
 *  条件闸门：会话空闲 ∧ 队列非空 ∧ 无挂起审批/询问 ∧ 本轮非中断非错误。
 *  flushInFlight 防重入：agent_end→waitForIdle 与 RPC 返回/queue.add 空闲触发可能同刻并发，
 *  双 flush 会把两条消息同时发出（都 shift 成功）——同一会话同时只允许一个 flush 在途。 */
const flushInFlight = new Set<string>()
function flushNextQueued(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s || !s.queuedMessages?.length) return
  /* ★0927 N1：暂停态（乙）不自动发 —— 那是用户的明确意图；等 session.queue.resume 或用户下次发话（自动恢复） */
  if (queuePaused.has(sessionId)) { sessionLog(sessionId, 'info', 'lifecycle', `flush 跳过：队列已暂停（乙，等用户点继续发送）`, { guard: 'flush-skip', why: 'paused' }); return }
  if (s.status !== 'idle') { sessionLog(sessionId, 'info', 'lifecycle', `flush 跳过：status=${s.status}`, { guard: 'flush-skip', why: 'status' }); return }
  /* ★0927：agent 仍在跑（activeRun 未清）→ 绝不派活。
     典型窗口：agent_end 已发（status 已置 idle）、waitForIdle 还没走完；worker 模式下主进程也可能
     根本看不到工人内部状态。这一闸门挡住"派活→被拒→放回→再派活"的空转（pi 运行中 prompt 必抛）。 */
  if (sessionAgentBusy(sessionId)) { sessionLog(sessionId, 'info', 'lifecycle', `flush 跳过：agent 仍在跑（activeRun 未清）`, { guard: 'flush-skip', why: 'agent-busy' }); return }
  if (flushInFlight.has(sessionId)) { sessionLog(sessionId, 'info', 'lifecycle', `flush 跳过：in-flight`, { guard: 'flush-skip', why: 'inflight' }); return }
  if (hasPendingInteraction(sessionId)) { sessionLog(sessionId, 'info', 'lifecycle', `flush 跳过：审批/询问挂起`, { guard: 'flush-skip', why: 'interaction' }); return }
  // 本轮以 error 收尾（LLM 彻底失败）不发下一条：大概率同样失败，留给用户决定
  const lastAsst = [...(s.transcript || [])].reverse().find((m: any) => m?.role === 'assistant') as any
  if (lastAsst?.stopReason === 'error') { sessionLog(sessionId, 'info', 'lifecycle', `flush 跳过：上轮 error 收尾`, { guard: 'flush-skip', why: 'error' }); return }
  const item = s.queuedMessages.shift()!
  schedulePersist()
  broadcastQueue(sessionId)
  /* ★ 0923：排队的用户消息同样是「用户发话」→ 续跑额度重置、解除暂停（与 session.prompt 同口径）。
     ★ 0930（T4 真机实测）：收尾/续跑的**注入消息**也会走队列续发——它们不是用户发话，
     重置额度等于"3 轮上限形同虚设"（实测收尾后又开出 1/3、2/3 轮）。额度重置只认真实用户消息，
     且挪到「真正发出」这一刻（此前在跳过闸门前就重置，被跳过的消息也会白吃一次额度）。 */
  if (!/^\s*【自动续跑/.test(String(item.text || ''))) resetBgResumeChain(sessionId)
  sessionLog(sessionId, 'info', 'lifecycle', `队列自动续发：${item.text.slice(0, 40)}`)
  // 前端乐观气泡对账：投影帧带 clientMessageId，piChat 把"排队中"占位转正
  try {
    broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'queue-sent', seq: Date.now(), value: { clientMessageId: item.id } })
  } catch { /* ignore */ }
  flushInFlight.add(sessionId)
  /* ★0927：__fromQueue 标记 —— 续发这条路自己带重试（catch 里放回队首 + 链式再 flush），
     所以 runPromptCore 的"忙时入队兜底"对它关闭（否则一条消息会被同时放回主队列+新建队列项 = 双发）。 */
  let skipChainFlush = false
  runPromptCore(sessionId, {
    message: item.text, attachments: item.attachments, skills: item.skills,
    model: item.model, effort: item.effort, __fromQueue: true,
  }).catch((e: any) => {
    // 同步闸门拒绝（vision/模型切换）=消息根本没发出 → 放回队首不丢；后续 flush 触发点自然重试
    const cur = sessions.get(sessionId)
    if (cur?.queuedMessages && !cur.queuedMessages.includes(item)) cur.queuedMessages.unshift(item)
    schedulePersist()
    broadcastQueue(sessionId)
    /* ★0927：被拒原因是"上一轮还在生成"→ 消息根本没发出去，**不要**立刻再 flush（会形成
       派活→被拒→放回→再派活 的空转/循环），改为退避重试，等本轮真正结束的 waitForIdle 触发。
        都走有界退避，等本轮真正结束的 waitForIdle 触发。 */
    if (isAgentBusyError(e)) {
      skipChainFlush = true
      sessionLog(sessionId, 'info', 'lifecycle', `队列续发推迟：上一轮仍在生成中，已放回队列`, { guard: 'flush-busy-backoff' })
      scheduleQueueFlushRetry(sessionId)
      return
    }
    /* 0927 netfix F4: a persistent failure must not hot-loop -- the failed item was unshifted back
       to the queue head, so an unconditional chain flush retried it forever (CPU spin + log spam).
       Back off instead (bounded retry; the 5s watchdog stays as the outer safety net). */
    skipChainFlush = true
    scheduleQueueFlushRetry(sessionId)
    sessionLog(sessionId, 'error', 'lifecycle', `队列续发失败（已放回队列）：${e?.message || e}`)
    broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: `排队消息发送失败（已放回队列）：${humanizeUserFacingError(String(e?.message || e)).slice(0, 40)}` } })
  }).finally(() => {
    flushInFlight.delete(sessionId)
    // 链式续发：本条自然结束后接着发下一条。agent_end 的 waitForIdle 回调与本 finally 存在竞态
    // （守卫可能先被 agent_end 路径触发又被本路径删除挡掉）——显式再调一次保证链不断。
    // 忙错退避时跳过（已安排 scheduleQueueFlushRetry，避免空转）。
    if (!skipChainFlush) flushNextQueued(sessionId)
  })
}

/* ★0927 N1 兜底：**队列空闲看门狗**（每 5s 扫一遍）。
   为什么必须有：N1 的病根就是"取消后唯一触发点失效 ⇒ 队列永久卡死"——靠逐个补触发点是补不完的，
   这里统一兜住：队列非空 ∧ 会话空闲 ∧ agent 没在跑 ∧ 无挂起审批/询问 ∧ 非 in-flight ⇒ 触发续发。
   暂停态（乙）与"退回输入框"（丙）不自动发：那是用户的明确意图（丙已把条目移出队列，本就不会命中）。 */
setInterval(() => {
  try {
    for (const s of sessions.values()) {
      if (!s.queuedMessages?.length) continue
      if (queuePaused.has(s.id)) continue
      if (s.status !== 'idle') continue
      if (sessionAgentBusy(s.id)) continue
      if (flushInFlight.has(s.id)) continue
      if (hasPendingInteraction(s.id)) continue
      sessionLog(s.id, 'info', 'lifecycle', `看门狗：队列滞留 ${s.queuedMessages.length} 条且会话空闲 → 触发续发`, { guard: 'queue-watchdog' })
      flushNextQueued(s.id)
    }
  } catch (e) { console.warn('[queue-watchdog] 扫描异常:', String((e as any)?.message || e)) }
}, 5000)

/** 0909④ 自动续跑（软段制）常量：30 轮不再是终点而是"段"；段间注入模型可见的续跑指令。
 *  护栏先到先停：段数封顶 / token 预算 / grace call 收尾 / 既有熔断（同指纹 5 连/连续失败 8）。 */
const SOFT_SEGMENT_TURNS = 30
/** 0911：护栏可调（设置·通用）——autoContinueRounds: 30-150 总轮数上限（0=不设限）；
 *  turnTokenBudget: 50万-1000万（0=不设限）。计数口径不变（input+output+cacheRead+cacheWrite 累计）。 */
function autoContinueCaps(): { maxSegments: number; tokenBudget: number; roundsUnlimited: boolean } {
  const r = Number(globalSettings.autoContinueRounds)
  const roundsUnlimited = r === 0
  const rounds = roundsUnlimited ? 0 : Math.max(30, Math.min(150, r || 150))
  const b = Number(globalSettings.turnTokenBudget)
  const tokenBudget = b === 0 ? Infinity : (b >= 500_000 ? b : 2_000_000)
  return { maxSegments: roundsUnlimited ? Number.POSITIVE_INFINITY : Math.max(1, Math.round(rounds / SOFT_SEGMENT_TURNS)), tokenBudget, roundsUnlimited }
}
/** 只读工具集（无进展检测用：连续多段全是读=空转） */
const READONLY_TOOL_RE = /^(fs_read|list_dir|search_files|web_fetch|web_search|github_search|snapshotFile|list_tools|read_preset|scan_skill|list_installed|wb_get_text|wb_snapshot|wb_screenshot|wb_read_console|project_fs_read|project_list_dir|project_search_files)$/i
/** 从注入/续跑消息文本判"这是自动续跑指令"（前端据此渲染 notice 而非用户气泡；transcript 保留原文） */
const AUTO_CONTINUE_PREFIX = '【自动续跑'
/* ★1004 记忆召回根治（实测反馈"复制用户消息/工作区变更记录拿到的是记忆召回文本"）：
 * 用户消息**落盘只存用户原文** —— 拼在行首的注入行（[模式:]/[记忆召回]/[技能指令]）只进发给模型的
 * 出站帧（finalMessage），不进 session.messages（否则复制按钮/轮次标注/侧栏预览拿到的都是注入文本，
 * 且 [记忆召回] 一行就 80+ 字，turnId 截 80 字后用户原文一个字都轮不到）。
 * ⚠️ [技能:x] 标签**不剥**（那是用户自己选的技能标签，前端 parseUserText 渲染成技能胶囊）。
 * 口径与前端 stripModeHint（frontend/src/utils/modeHint.ts）完全一致，改一处记得同步另一处。 */
function stripInjectedLines(text: string): string {
  if (!text) return text
  let t = String(text)
  for (let i = 0; i < 5; i++) {
    const n = t.replace(/^\[模式:[^\]]+\][^\n]*\n?/, '').replace(/^\[记忆召回\][^\n]*\n?/, '').replace(/^\[技能指令\][^\n]*\n?/, '').replace(/^\[项目档案卡\][^\n]*\n?/, '').replace(/^\[上下文\][^\n]*\n?/, '')
    if (n === t) break
    t = n
  }
  return t
}
/* ★1004d（实测反馈"文件变更里多了 [[图片:0]]"）：轮次标签专用清洗 ——
 * 在剥注入行之外再剥 [[图片:N]] 位置标记（它是消息排版标记，进标签纯属噪音）、
 * 压缩连续空白。只用于**标签**（turnId/预览摘要），不动消息原文。 */
function cleanTurnLabel(text: string): string {
  return stripInjectedLines(text).replace(/\[\[图片:\d+\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}
/* ★1003 修复 4.73：注入类 user 消息**统一口径** —— 原来三套标准并存：
 * pageHistory 跳 3 种注入前缀 / session.deleteTurn 只跳【自动续跑 / memberPrompt afterTurns 一种不跳，
 * 会话里出现【后台任务通知】【后台任务回访】时轮次错位：deleteTurn 误删别的轮、afterTurns 锚点偏移、
 * 刷新后单聊气泡插错位置。注入前缀与前端 piChat 的 INJECTED_USER_PREFIXES 保持一致（改这里记得同步前端）。 */
const INJECTED_USER_PREFIXES = ['【自动续跑', '【后台任务通知', '【后台任务回访', '【分身回归']  /* ★1004：分身回归同口径（改这里记得同步前端 piChat） */
function isInjectedUserMsg(m: any): boolean {
  if (m?.role !== 'user') return false
  const raw = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('') : ''
  /* ★1004：判定前先剥行首注入行（[记忆召回] 等拼在最前面会挡住前缀匹配） */
  return INJECTED_USER_PREFIXES.some((pfx) => stripInjectedLines(raw).startsWith(pfx))
}
function makeContinueMessage(text: string): any {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}
/** 累计本轮已消耗 token（按 newMessages 里未计过的 assistant usage 求和；contState.counted 防重复） */
function accumulateTurnTokens(session: SessionView, newMessages: any[]): void {
  const st = session.contState
  if (!st) return
  let seen = 0
  for (const m of newMessages) {
    if (m?.role !== 'assistant') continue
    seen++
    if (seen <= st.counted) continue
    const u = m.usage || {}
    st.tokens += (u.input ?? u.prompt_tokens ?? 0) + (u.output ?? u.completion_tokens ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
  }
  st.counted = seen
}
/** ★ 0929 工具瘦身·刀①：家族工具的"只读动作"集合（无进展检测按 name+action 判；不在集合=按写类处理=从严不误杀） */
const FAMILY_READONLY_ACTIONS: Record<string, string[]> = {
  bg: ['list', 'read'],
  memory: ['search'],
  knowledge: ['query'],
  notebook: ['list'],
  history: ['list', 'stat'],
  schedule: ['list'],
  git: ['status', 'diff', 'log'],
  repo: ['map', 'search', 'build'],
}
function isReadonlyToolCall(c: any): boolean {
  const n = String(c?.name || '')
  const a = String((c?.arguments?.action ?? c?.args?.action ?? c?.params?.action) || '').trim()
  if (FAMILY_READONLY_ACTIONS[n]) return FAMILY_READONLY_ACTIONS[n].includes(a)
  return READONLY_TOOL_RE.test(n)
}
/** 无进展检测：本轮新增消息里最近 N 个工具调用是否全是只读类（写/命令/编辑出现即有进展） */
function allRecentCallsReadonly(newMessages: any[], window = 12): boolean {
  const flags: boolean[] = []
  for (const m of newMessages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const c of m.content) if (c?.type === 'toolCall') flags.push(isReadonlyToolCall(c))
  }
  const tail = flags.slice(-window)
  return tail.length >= window && tail.every(Boolean)
}
/** 主 agent 的 shouldStopAfterTurn：既有熔断优先 → 软段自动续跑 → 段数/预算/无进展封顶 */
function makeShouldStopAfterTurn(sessionId: string, getAgent: () => Agent | undefined): (st: any) => boolean {
  return (st: any) => {
    const session = sessions.get(sessionId)
    if (!session) return true
    // 0908 action-error 硬停：同工具连续失败达阈值 → afterToolCall 已置 hardStop
    if (loopGuardState.get(sessionId)?.hardStop) {
      sessionLog(sessionId, 'error', 'lifecycle', `连续失败硬熔断：${loopGuardState.get(sessionId)?.lastTool} 连续失败已达 ${LOOP_ERR_HARD} 次，本轮强制停止`, { guard: 'action-error-hard-stop', tool: loopGuardState.get(sessionId)?.lastTool })
      return true
    }
    // pi 0.84.x 参数是 {message, toolResults, context, newMessages}——st.messages 恒空（熔断死代码根因，
    // 0831 夜实锤：同指纹刷 107 次未触发）。取全量上下文判定
    // 只统计当前 prompt 的新增消息。context.messages 可能是累计历史，不能拿来
    // 判断本轮是否循环，否则旧会话很容易一进入工具调用就被提前停止。
    const turnMsgs: any[] = Array.isArray(st?.newMessages) ? st.newMessages : []
    accumulateTurnTokens(session, turnMsgs)
    const toolRounds = turnMsgs.filter((m: any) =>
      m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c: any) => c.type === 'toolCall'))
    // ── ★1004o（已定案"派完分身主 agent 什么都不说"）：本轮**成功**派发分身 → 静默收轮，
    //    不再调模型生成收尾话（对话干净+省 token）。失败的派发（isError）照常让模型说话走失败链；
    //    同轮其它工具批次在此前已执行完，不受影响。成功判定用 isError（teamRuntime 判 run 状态同款口径）──
    const cloneDispatched = turnMsgs.some((m: any) =>
      m?.role === 'toolResult' && String(m.toolName) === 'spawn_clone' && !m.isError)
    if (cloneDispatched) {
      sessionLog(sessionId, 'info', 'lifecycle', '分身已派出：静默收轮（不生成收尾话）', { guard: 'clone-silent-stop' })
      return true
    }
    // ── 既有同指纹重复熔断（第 5 次硬停/第 4 次预警）：任何模式下都是最高优先级 ──
    const resultByCall = new Map<string, unknown>()
    for (const m of turnMsgs) {
      if (m.role === 'toolResult' && m.toolCallId) resultByCall.set(String(m.toolCallId), m.content ?? m.result ?? '')
    }
    const calls: Array<{ sig: string; result: unknown }> = []
    for (const m of turnMsgs) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (const c of m.content) {
        if (c.type !== 'toolCall') continue
        let argsSig = ''
        try { argsSig = JSON.stringify(c.arguments ?? {}).replace(/\s+/g, '').slice(0, 200) } catch { argsSig = String(c.arguments ?? '').slice(0, 200) }
        const callId = String(c.id || c.toolCallId || '')
        // 没有对应 toolResult 时说明工具尚未完成，不参与重复计数。
        if (!callId || !resultByCall.has(callId)) continue
        calls.push({ sig: `${c.name}:${argsSig}`, result: resultByCall.get(callId) })
      }
    }
    // 只有工具调用及其结果都完全相同才计数；第 5 次硬熔断。
    let run = 0
    let prev: string | null = null
    for (const call of calls) {
      let resultSig = ''
      try { resultSig = JSON.stringify(call.result).replace(/\s+/g, '').slice(0, 240) } catch { resultSig = String(call.result).slice(0, 240) }
      const key = `${call.sig}:${resultSig}`
      run = key === prev ? run + 1 : 1
      prev = key
      if (run >= 5) {
        const toolName = call.sig.split(':')[0]
        const detail = `${toolName}（参数和结果均未变化）`
        console.log(`[loop-guard] session=${sessionId} 硬熔断：${detail}，连续第 ${run} 次`)
        sessionLog(sessionId, 'error', 'lifecycle', `循环熔断：${detail}，连续第 ${run} 次，已硬停止本轮执行`, { guard: 'hard-stop', tool: toolName, repeat: run })
        return true
      }
      if (run === 4) {
        const toolName = call.sig.split(':')[0]
        sessionLog(sessionId, 'warn', 'lifecycle', `循环预警：${toolName} 参数和结果均未变化，已连续第 4 次；这是软提醒，下一次仍重复才会停止`, { guard: 'soft-warning', tool: toolName, repeat: run })
      }
    }
    // ── 0909④ 软段自动续跑：到 30 轮整数倍时若模型还想继续（stopReason=toolUse）→ 注入续跑指令 ──
    const st0 = session.contState
    if (!st0) return false
    const atCap = toolRounds.length >= SOFT_SEGMENT_TURNS * (st0.segments + 1)
    if (!atCap) return false
    const wantMore = (st?.message as any)?.stopReason === 'toolUse'
    if (!wantMore) return false
    // 护栏 1：段数封顶
    const _caps = autoContinueCaps()
    if (!_caps.roundsUnlimited && st0.segments >= _caps.maxSegments) {
      sessionLog(sessionId, 'warn', 'lifecycle', `自动续跑达到段数上限（${_caps.maxSegments} 段），停止`, { guard: 'round-cap', segments: st0.segments })
      broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: `工具调用已达 ${st0.segments * SOFT_SEGMENT_TURNS} 轮（自动续跑上限），本轮收尾——任务可能没做完，发「继续」接着做` } })
      return true
    }
    // 护栏 2：token 预算（耗尽=软着陆收尾，不硬掐）
    if (_caps.tokenBudget !== Number.POSITIVE_INFINITY && st0.tokens >= _caps.tokenBudget) {
      if (!st0.graceUsed) {
        st0.graceUsed = true
        getAgent()?.steer(makeContinueMessage(`${AUTO_CONTINUE_PREFIX}·收尾】token 预算已用完（约 ${Math.round(st0.tokens / 1000)}K）。请【不要开始新的实质工作】，用一段话总结：已完成什么、产出文件路径、剩余工作、明确的下一步。`) as any)
        sessionLog(sessionId, 'warn', 'lifecycle', `token 预算 ${_caps.tokenBudget} 用满，注入收尾指令（grace call）`, { guard: 'budget-grace', tokens: st0.tokens })
        return false
      }
      sessionLog(sessionId, 'warn', 'lifecycle', `token 预算耗尽且收尾轮已过，停止`, { guard: 'budget-stop', tokens: st0.tokens })
      broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: `本轮 token 预算用尽，自动收尾（发「继续」可接着做）` } })
      return true
    }
    // 护栏 3：无进展（最近 12 个工具调用全只读=空转）
    if (st0.segments >= 1 && allRecentCallsReadonly(turnMsgs)) {
      sessionLog(sessionId, 'warn', 'lifecycle', `无进展检测：连续多轮只读工具无写入/命令，停止自动续跑`, { guard: 'no-progress', segments: st0.segments })
      broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: '检测到连续只读无进展，自动收尾——请检查任务是否卡住，或发「继续」再试' } })
      return true
    }
    // 放行：注入模型可见的续跑指令（steer 队列 → 下一轮 LLM 调用前入上下文），段数 +1
    st0.segments++
    getAgent()?.steer(makeContinueMessage(
      `${AUTO_CONTINUE_PREFIX} 第 ${st0.segments + 1}/${_caps.maxSegments === Number.POSITIVE_INFINITY ? "∞" : _caps.maxSegments + 1} 段】上一段完成 ${st0.segments * SOFT_SEGMENT_TURNS} 轮工具调用，任务尚未结束。直接继续当前任务：不要重新规划已完成的步骤，不要重复已做过的读取/搜索。若确实无法继续，用一段话说明阻塞与下一步。`
    ) as any)
    sessionLog(sessionId, 'info', 'lifecycle', `软段 ${st0.segments * SOFT_SEGMENT_TURNS} 轮到达，自动续跑进入第 ${st0.segments + 1} 段`, { guard: 'auto-continue', segments: st0.segments, tokens: st0.tokens })
    /* ★1010-E（用户定）：续跑的内联通知不再广播进会话流（图上那条「任务较长，自动续跑…」）——
     *  只留日志（上一行 sessionLog → data/logs/<sid>.jsonl）。异常类提示（无进展/已达上限）仍照常显示。 */
    return false
  }
}

function getOrCreateAgent(sessionId: string): Agent {
  let agent = agents.get(sessionId)
  // 0910 三批：配置热更新——预设/团队文件变了就重建 agent（换模型/档位/工具白名单立即生效，无需重启后端）
  const fp = configFingerprint(sessionId)
  if (agent && agentFingerprints.get(sessionId) !== fp) {
    try { agent.abort() } catch { /* ignore */ }
    agents.delete(sessionId)
    agent = undefined
    sessionLog(sessionId, 'info', 'session', '[配置] 检测到预设/团队/MCP 配置变更，已重建 agent（新配置自本次请求生效）')
  }
  if (!agent) {
    agentFingerprints.set(sessionId, fp)
    const session = sessions.get(sessionId)
    // 会话预设（文件化）：按 toolsets 声明挂载专用工具包
    /* ★0930 修（分身实测卡死在"成员预设不存在："）：会话没预设时按前端契约补默认预设 'standard'
     （前端建会话总是带 presetId——0904 约定"无值补真实默认预设并落回"，与 agentPresetsStore
     的 defaultPresetId 同口径）；API 直建的会话/老数据可能没有 presetId，分身会因此整个不可用。 */
  const sessionPreset = readAgentPreset(session?.presetId || '') || readAgentPreset('standard')
    // ── 安装助手：toolsets 含 install 的会话用专用工具集 + 提示词 ──
    if (session?.presetId === 'install-assistant' || sessionPreset?.toolsets?.includes('install')) {
      const sys = INSTALL_SYSTEM_PROMPT
      const installTools = buildInstallTools({
        sessionId,
        askUser,
        getPermissionMode: () => sessions.get(sessionId)?.permissionMode || 'confirm',
        // 确认走权限卡通道（ApprovalPanel 显示/应答链路可靠，替代问题卡）
        confirmGate: async (question: string) => {
          const r = await awaitApproval(sessionId, {
            needApproval: true, risk: 'low', tool: 'install_skill', toolDisplay: 'install_skill（安装助手）',
            question, options: ['确认安装', '取消'], args: {},
          } as any, undefined)
          return !r.block
        },
        // MCP 真实安装/卸载（运行时已接入）
        mcpInstall: (name, config, repoUrl) => mcpHubInstall(name, config, repoUrl),
        mcpUninstall: (name) => mcpHubRemove(name),
        // 会话执行日志（运行面板）
        log: (category, message, level) => sessionLog(sessionId, level || 'info', category as any, message),
      })
      // 基础工具 cwd 指向 skills 目录 → agent 能探索/确认已安装的技能（安装位置的准确性）
      const baseTools = buildSessionTools(SKILLS_DIR)
      agent = new Agent({
        streamFn: createStreamFn(sys, sessionId),
        // 工具结果回执走 pi-ai 适配器原生 role:"tool" 转换（不再压平成 user 消息）
        initialState: { systemPrompt: sys, tools: [...installTools, ...baseTools, ...buildWebTools(), buildAskUserTool(sessionId), ...mcpToolsForPreset(sessionPreset, sessionId), ...getCustomAgentTools()] },
        sessionId,
      finishTurn: toFinishTurn((st: any) => {
          // pi 0.84.x 参数是 {message, toolResults, context, newMessages}——c.messages 恒空（熔断死代码根因）
          const toolRounds = (st?.context?.messages || st?.newMessages || []).filter((m: any) =>
            m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c: any) => c.type === 'toolCall'))
          return toolRounds.length >= 30
      }),
        // 安装分支：安装类工具免审批（自带 ask_user 确认）；fs_write/run_command 等写类工具走正常审批
        beforeToolCall: async (ctx: BeforeToolCallContext, signal?: AbortSignal) => {
          if (INSTALL_TOOL_WHITELIST.has(ctx.toolCall.name)) return undefined
          return approvalGate(sessionId, ctx, signal)
        },
        afterToolCall: makeAfterToolCall(sessionId),
      })
      agent.subscribe((event) => {
        if (agents.get(sessionId) !== agent) return
        handleAgentEvent(sessionId, event)
      })
      if (session?.transcript?.length) {
        try { agent.state.messages = JSON.parse(JSON.stringify(session.transcript)) } catch { /* ignore */ }
      }
      agents.set(sessionId, agent)
      drainBgNotices(sessionId, agent)
      return agent
    }
    // ── 普通聊天 agent ──
    // 系统提示词：动态组装（设置权威；改名字/性格即时生效，不依赖会话创建时的快照）
    // 技能清单：0910 缓存优化——同步拼进 systemPrompt（缓存已热时），不再异步 .then 改写。
    // 旧实现 agent 建好后 microtask 才追加技能清单，system 前缀在第 1/2 请求间变一次 = 缓存断一次；
    // 且 loadSkills 目录扫描顺序不保证，清单顺序抖动也断前缀（formatSkillList 现已按 name 排序）。
    // ★1011（pi 1.1.0）：技能清单必须在**建 agent 之前**同步拼进 system —— 原因见下方注释。
    let sys = buildDynamicSystem(session)
    /* ★ 0921q：技能开关 —— 主开关关掉 = 清单整体不注入；每技能开关 = 只注入启用的 */
    const _skillAuto = skillAutoSelectOn()
    const _skillOff = skillDisabledSet()
    /* ★1011：为什么改成"建 agent 前同步扫一次"——1.1.0 里 `agent.state.systemPrompt` 已是只读，
       旧实现"建完 agent 再异步补写技能清单"的兜底彻底作废（写不进去，TS2540）。自研扫描本身同步、
       目录很小（通常 <50ms），且服务启动已预热 ⇒ 只有启动头几十毫秒会真走扫描。
       顺带治了旧毛病：异步补写会让第 1/2 个请求的 system 前缀不一致、白断一次 prompt 缓存。 */
    const skillsNow = (_skillAuto ? getSkillsSync() : []).filter((x: any) => !_skillOff.has(String(x.name)))
    if (skillsNow.length > 0) sys = sys + '\n' + formatSkillList(skillsNow)
    // 工具集：cwd 绑定会话工作区（无工作区时回退进程 cwd）
    // self-modify 工具集（创造模式）：project_* 专属工具绑定项目根——AI 可读写增删改查 NIS 自己的源码
    const selfModify = sessionPreset?.toolsets?.includes('self-modify')
    const tools = buildSessionTools(session?.workDir?.trim() || process.cwd(), undefined, sessionId)
    // 注意：保留原工具名前缀（fs_read→project_fs_read），前端按 project_fs_* 配置样式；
    // 名称带 fs_ 便于审批门禁按动词归类（fs_write=写类必审）
    /* ★ 0924：项目模式 grep 额外跳过的目录（这些不是源码：快照仓库 19G / venv / 浏览器环境 / 临时缓存）
       事故背景：project_fs_grep 扫项目根实测 146 秒 / 读 4GB / 遍历 14.7 万文件（详见 诊断-后端断开根因-0924.md） */
    const PROJECT_GREP_SKIP_DIRS = ['data', 'releases', 'exports', 'toolchain', '_exe_build', '_testdata_be',
      '_research_pb', '_research_wx', '.nis-history', 'browser-profile', 'env', 'tools', 'backups',
      'snapshots', '_shots', 'logs-archive']
    const projectTools = selfModify
      ? buildSessionTools(PROJECT_ROOT, undefined, undefined, undefined, { extraSkipDirs: PROJECT_GREP_SKIP_DIRS }).map(t => ({
          ...t,
          name: 'project_' + t.name,
          label: '项目·' + t.label,
          description: '【自我修改】' + (t.description || '') + (t.name === 'fs_grep' ? '★ 未指定 path（从项目根扫）时，默认跳过 backend/data、releases、toolchain、env、browser-profile 等"非源码"数据目录（事故修复：盲扫需 146 秒/读 4GB）；并有三重扫描预算（5 万文件 / 512MB / 20 秒），超限会在结果里明确告知。**要搜索这些被跳过位置（如历史会话、日志、file-history），必须显式传 path=**（例：path=backend/data/logs）。' : '') + '（作用于 NIS 项目源码根目录；后端 .ts 改动需重启生效）',
        }))
      : []
    // 记忆/知识库工具：全局共享（Python 子进程桥接，不依赖 cwd）
    const memoryTools = buildMemoryTools({ projectId: String(session?.projectId || '') })
    // 用户记事本工具（0920）：用户与 AI 共用的一本，落 <数据根>/notebook.json，纯 Node 不依赖 cwd
    const notebookTools = buildNotebookTools()
    // 询问卡工具：AI 主动问用户（按会话挂起）
    const askTool = buildAskUserTool(sessionId)
    // 计划本工具：多步骤任务写计划（输入框上方计划卡）
    const planTool = buildPlanTool(sessionId)
    // 0910 三批⑤：项目档案工具（工作区根 NIS-notes.md，跨窗口共享的项目记忆）
    const projectNoteTool = buildProjectNoteTool(session?.workDir?.trim() || process.cwd())
    // 设置更新工具：用户明确要求改设置（名字/头像/提示词）时调用
    const settingsTool = buildSettingsUpdateTool(sessionId)
    // Skill 工具：按名读取技能全文指令（调用即产生标准工具过程块）
    const skillParams = TbType.Object({
      name: TbType.String({ description: '技能名称（见系统提示词中的可用技能清单）' }),
    })
    const skillTool: import('@earendil-works/pi-agent-core').AgentTool<typeof skillParams, any> = {
      name: 'use_skill',
      label: '使用技能',
      description: '加载指定技能的完整执行指令。当用户任务匹配可用技能清单中的某项、或用户消息带有 [skill:名称] 标记时调用；返回指令后严格按其流程完成任务。',
      parameters: skillParams,
      async execute(_callId, params) {
        const skills = await getEnabledSkills()   // ★ 0921q：只认启用的技能
        const s = skills.find(x => x.name === params.name)
        if (!s) throw new Error(`未知技能：${params.name}。可用技能：${skills.map(x => x.name).join('、') || '(无)'}`)
        if (!isSkillEnabled(s.name)) throw new Error(`技能「${s.name}」已被停用（技能仓库里可重新开启）`)
        /* ★ 0921z-2（用户修正）：主开关只管"AI 自主挑技能"（决定技能清单注不注入），**不再拦 use_skill** ——
           用户手动点技能按钮 / 写 [skill:名称] 是用户意志，AI 照办。 */
        console.log(`[skills] apply session=${sessionId} skill=${s.name}`)
        return {
          content: [{ type: 'text', text: `# 技能已加载：${s.name}\n\n${s.content}` }],
          details: { skill: s.name },
        }
      },
    }
    // 预设管理员工具集：会话预设 toolsets 含 preset-admin 时挂载（创造模式做预设用）
    const presetAdminTools = sessionPreset?.toolsets?.includes('preset-admin')
      ? buildPresetAdminTools(currentToolRegistry)
      : []
    const customAdminTools = sessionPreset?.toolsets?.includes('custom-tools')
      ? buildCustomToolAdminTools()
      : []
    // 严格工具清单：预设声明 tools 时只挂载清单内的工具（预设不允许调用未指定工具）。
    // 0913 语义修正：**声明了空数组 = 一个工具都不挂**（「对话模式」纯聊天用）；
    // 只有完全没声明（undefined）才回退全量 —— 原来把空清单也当"未声明"回退全量，
    // 结果「工具全部取消」反而拿到全部工具，语义正好反了。
    // ★ 0925v（需求的"分身"功能）：spawn_clone —— 非团队模式派 1~3 个「自己」并行干活。
  // 复用团队 runSubAgent 管线（伪造轻量 ctx + 单步黑板），气泡/过程回放/中断全套免费（见 cloneRuntime.ts）
  const cloneTools = buildCloneTools(
    (() => {
      const lite = buildTeamCtx(sessionId, { id: 'clone-shell', name: '分身小队', mode: 'parallel', maxParallel: 3, members: [] } as any)
      /* ★0929 P1（分身刷新恢复兜底）：spawn_clone 收尾把本次 run 快照按 toolCallId 登记进
         session.subRuns（随会话落盘）——injectSubRuns 的 subRuns 兜底对分身从此生效
         （黑板被清/60 条滚动裁掉后，刷新仍能靠会话内嵌数据恢复分身气泡）。 */
      lite.registerSubRuns = (toolCallId: string, runs: any[]) => {
        if (!toolCallId || !Array.isArray(runs) || !runs.length) return
        try {
          const s: any = sessions.get(sessionId)
          if (!s) return
          if (!s.subRuns || typeof s.subRuns !== 'object' || Array.isArray(s.subRuns)) s.subRuns = {}
          s.subRuns[toolCallId] = JSON.parse(JSON.stringify(runs))
          schedulePersist(sessionId)
        } catch { /* 登记失败不拦工具 */ }
      }
      /* ★0930：setCloneBusy/isCloneBusy「分身忙」计数已整套删除——即派即回后长工具撞车向量消失、
         通知也不再 steer，这套护栏成了零消费者死代码。异常路径兜底击杀保留如下。 */
      lite.abortSubAgents = () => { try { abortSubAgents(sessionId) } catch { /* ignore */ } }
      /* ★0930（分身改"即派即回"）：分身回归摘要送回对话 —— 主 agent 忙 → steer 在工具批次边界注入；
         空闲 → 自动拉起一轮（与后台回访自动唤醒同款）；两条路都失败转待办补送。
         分身工作完成，主 agent 统一按顺序处理（用户 0930 拍板口径）。 */
      lite.notifyCloneDone = (text: string) => {
        const ag = agents.get(sessionId)
        const streaming = !!ag && !!(ag as any).state?.isStreaming
        if (streaming) {
          try {
            ;(ag as any).steer({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
            return
          } catch { /* 插话失败 → 转待办 */ }
          const q0 = pendingBgNotices.get(sessionId) || []
          q0.push(text)
          pendingBgNotices.set(sessionId, q0.slice(-10))
          return
        }
        void runPromptCore(sessionId, { message: text }).catch(() => {
          const q = pendingBgNotices.get(sessionId) || []
          q.push(text)
          pendingBgNotices.set(sessionId, q.slice(-10))
        })
      }
      return lite
    })(),
    () => ({ name: String(globalSettings.nisName || 'Nis'), presetId: String(sessionPreset?.id || '') }),
  )
  /* ★ 0929 批次A/B/C：补缺口——列目录 / 文件时光机 / 定时任务 / git 族 / 仓库地图·语义搜索 */
  const extraTools = [
    buildListDirTool(session?.workDir?.trim() || process.cwd()),
    ...buildHistoryTools(session?.workDir?.trim() || process.cwd(), sessionId),
    ...buildScheduleTools(),
    // ★ 版本面板：提交时自动带上"来源对话"（哪个窗口提交的）—— 只读口径见 gitTimeline.ts
    ...buildGitTools(session?.workDir?.trim() || process.cwd(), { sessionId, sessionTitle: session?.title }),
    ...buildRepoTools(session?.workDir?.trim() || process.cwd()),
  ]
  const allTools = [...tools, ...extraTools, ...memoryTools, ...notebookTools, ...buildWebTools(), skillTool, askTool, planTool, settingsTool, ...cloneTools, projectNoteTool]
    /* ★ 0929 工具瘦身·刀①：存量预设存的是合并前旧工具名 —— 过滤前归一到家族名（旧名=家族别名，逐一等价），
       预设勾选一个旧成员=该家族可用，功能不减。 */
    const TOOL_ALIAS: Record<string, string> = {
      bg_start: 'bg', bg_list: 'bg', bg_read: 'bg', bg_stop: 'bg', bg_note: 'bg', bg_watch: 'bg',
      notebook_list: 'notebook', notebook_add: 'notebook', notebook_update: 'notebook', notebook_delete: 'notebook',
      memory_search: 'memory', memory_store: 'memory', memory_delete: 'memory', memory_distill: 'memory',
      knowledge_query: 'knowledge', knowledge_add: 'knowledge', knowledge_delete: 'knowledge',
    }
    const presetToolList = sessionPreset?.tools
      ? [...new Set((sessionPreset.tools as string[]).map(n => TOOL_ALIAS[n] || n))]
      : sessionPreset?.tools
    const hasPresetTools = Array.isArray(presetToolList)
    const noToolsAtAll = hasPresetTools && (presetToolList || []).length === 0
    const filteredTools = hasPresetTools ? allTools.filter(t => (presetToolList || []).includes(t.name)) : allTools
    // 自定义工具（0913）：**随预设的工具清单走** —— 勾选才挂载（自定义预设正是靠勾选决定可用工具）；
    // 预设完全没声明 tools（undefined）时保持旧行为（全部挂载，兼容存量预设）。
    const customToolsAll = getCustomAgentTools()
    const customToolsForPreset = hasPresetTools
      ? customToolsAll.filter(t => (presetToolList || []).includes(t.name))
      : customToolsAll
    // ★ 0929 刀②：低频能力包的说明书按需发 —— load_tools 元工具随"懒包已挂载"自动挂（不走预设白名单，
    //   防自定义预设"有浏览器没加载器"=能力被藏死；对话模式（noToolsAtAll）照旧零工具）。
    const mcpTools = mcpToolsForPreset(sessionPreset, sessionId)
    const loadToolsTool = mcpTools.some(t => LAZY_FAMILIES.browser.match(t.name))
      ? [buildLoadToolsTool({
          markLoaded: (fam: string) => {
            const s = lazyLoadedBySession.get(sessionId) || new Set<string>()
            s.add(fam)
            lazyLoadedBySession.set(sessionId, s)
          },
          getTools: () => agents.get(sessionId)?.state.tools ?? [],
        })]
      : []
    const finalTools = noToolsAtAll
      ? [] // 纯对话：连自定义工具 / MCP / toolsets 一并清空，保证「零工具」
      : [...filteredTools, ...presetAdminTools, ...customAdminTools, ...projectTools, ...mcpTools, ...loadToolsTool, ...customToolsForPreset]
    // 团队运行时（P2）：会话绑定团队且主预设=团队主预设 → 挂载指挥官工具集（team_dispatch/黑板/team_info）。
    // 不绑团队或普通预设 = 单 agent 模式（P1 退化语义不变）
    const teamDef = session?.teamId ? readTeam(session.teamId) : null
    let teamTools: AgentTool<any>[] = []
    // 会话未显式选预设时，团队会话的主 agent 预设跟随团队配置（mainPreset）——
    // 之前硬比较 `mainPreset === (presetId || '')`：API 创建时漏传 presetId → 恒不相等 →
    // 团队工具整个不挂载，主 agent 变普通聊天还自称"没有 bb_goal/team_dispatch"（0901 E2E 实锤）
    const effectivePresetId = session?.presetId?.trim() || teamDef?.mainPreset || ''
    if (teamDef && teamDef.mainPreset === effectivePresetId) {
      // ctx 构造抽取为 buildTeamCtx（0904 单聊复用同一套），行为与旧内联块一致：
      // session 实时查（workDir/权限运行期可变），use_skill 工具内联同款实现
      const teamCtx = buildTeamCtx(sessionId, teamDef)
      teamTools = buildTeamTools(teamCtx)
      // 团队简报注入系统提示词（role 流程第 1 步"读成员清单"的兑现；详情仍可 team_info 查询）
      if (teamTools.length > 0) {
        const brief = teamDef.members.map(m => {
          const mp = readAgentPreset(m.preset)
          return `- ${m.id} ${mp?.name || m.preset}：${String(m.role || mp?.description || '').slice(0, 60)}`
        }).join('\n')
        sys = sys + `\n\n# 你的团队「${teamDef.name}」（成员详情用 team_info 查询）\n${brief}\n运行模式：${teamDef.mode}｜并行预算：${teamDef.maxParallel}｜编排流程：bb_goal 立目标计划 → team_dispatch 派发 → bb_write 审核/汇总\n派发铁律：bb_goal 写计划前必须已明确每个成员的职责边界（简报不够就用 team_info 查详情）；owner 派错会被硬拒绝并浪费一轮——拿不准就先 team_info\n并行铁律：相互独立的步骤放在同一次 team_dispatch 的 tasks 数组里一次性提交；同职责多步骤可拆给多个同职责成员，也可派给同一个成员（各自独立实例并行执行，不串行）；owner 必须职责匹配，不要为凑数派给不相关成员\n简单任务判据：任务不涉及工作区文件→直接回答；极小单点修改（改一个词/一处样式）→直接用 fs_write 完成，无需派发；多文件/多步骤→黑板+派发`
      }
    }
    // ★ 0929 刀②：低频能力包目录（说明书不常驻；先让模型知道"有什么能力、怎么喊"）
    if (loadToolsTool.length) {
      sys += '\n\n# 能力包目录（说明书不常驻，首次使用前先 load_tools 展开）\n'
        + Object.keys(LAZY_FAMILIES).filter(fam => mcpTools.some(t => LAZY_FAMILIES[fam].match(t.name))).map(familyIndexLine).join('\n')
    }
    agent = new Agent({
      streamFn: createStreamFn(sys, sessionId),
      // 工具结果回执：不再压平成 user 消息（旧 hack）——pi-ai 适配器原生把 toolResult 转成
      // role:"tool" 消息（带 tool_call_id 的标准回执），模型明确知道"这是那次调用的结果"
      initialState: {
        systemPrompt: sys,
        tools: [...finalTools, ...teamTools],
      },
      sessionId,
      // 工具循环收敛（0909④ 软段制）：30 轮不再是终点而是"段"，段间注入模型可见续跑指令自动开下一段；
      // 护栏=段数封顶(5段)/token预算(2M)/无进展检测/grace 收尾；既有熔断（同指纹 5 连/连续失败 8）优先级最高。
      // 重复熔断：同一"工具名+参数指纹"【连续】出现 ≥3 次 = 模型陷入循环（fs_read→fs_write 打磨循环实锤）→ 强制停止。
      // 注意：不能按出现次数计数——团队任务一个 prompt 跨 3 次派发/审阅，审阅轮重读同一产出文件是合法操作
      // （文件在成员修改后内容已变），按出现次数会在第 3 次合法审阅时误杀（0901 566db0df 实锤）
      finishTurn: toFinishTurn(makeShouldStopAfterTurn(sessionId, () => agents.get(sessionId))),
      beforeToolCall: (ctx: BeforeToolCallContext, signal?: AbortSignal) => approvalGate(sessionId, ctx, signal),
      afterToolCall: makeAfterToolCall(sessionId),
    })
    // 订阅一次（agent 生命周期内固定一个监听器；session.prompt 不再重复 subscribe，
    // 否则监听器累积导致每个事件被处理 N 次——"发一条消息出多条回复"的根因）
    agent.subscribe((event) => {
      // 旧 agent（被 session.cancel 停止/删除、或新 prompt 重建）的事件一律丢弃：
      // abort 后的 handleRunFailure/tool 结果不再广播，避免"停止后仍继续回复/内容串到下一轮"
      if (agents.get(sessionId) !== agent) return
      handleAgentEvent(sessionId, event)
    })
    // 恢复持久化的对话上下文（重启后 agent 重建，transcript 回填保证多轮连续）
    if (session?.transcript?.length) {
      try {
        ;agent.state.messages = JSON.parse(JSON.stringify(session.transcript))
      } catch (e) { swallowed('重启后回填 agent 上下文失败（该会话多轮上下文可能断档）', e) }
    }
    agents.set(sessionId, agent)
    drainBgNotices(sessionId, agent)
  }
  return agent
}

/** 通用工具审批门禁（普通会话全量走；安装助手分支对安装类工具免审、写类工具走此门禁） */
async function approvalGate(sessionId: string, ctx: BeforeToolCallContext, signal?: AbortSignal): Promise<undefined | { block: boolean; reason?: string }> {
  // 无差别进程杀伤硬拦截（0902 事故：成员跑 taskkill /IM node.exe 团灭 pi-bridge/vite 全部 node 进程）：
  // 按映像名全杀的命令一律拒绝（在权限门禁之前，full_access 也不放行——这是自保不是权限问题）。
  // 放行：带 /PID 的精确击杀；杀非 node/node.exe/pwsh.exe 的映像名（.exe 伪装目标也会漏放，按名字面挡）
  if (ctx.toolCall.name === 'run_command' || ctx.toolCall.name === 'project_run_command') {
    const killCheck = matchIndiscriminateKillCommand(String((ctx.args as any)?.command || ''))
    if (killCheck) {
      sessionLog(sessionId, 'error', 'approval', `已拦截无差别进程杀伤命令：${killCheck.cmd}`)
      return { block: true, reason: `命令「${killCheck.cmd}」会按映像名杀掉所有 ${killCheck.image} 进程（包括 NIS 后端自身）。请用 taskkill /F /PID <具体进程号> 指定进程，或用其他方式停止你启动的测试服务（如记录启动时拿到的 PID）。` }
    }
  }
  const s = sessions.get(sessionId)
  if (!s) return undefined
  const mode = s.permissionMode || 'confirm'
  // 完全访问：直接放行（日志只在真处于该模式时记）
  if (mode === 'full_access') {
    sessionLog(sessionId, 'info', 'approval', `完全权限模式：${ctx.toolCall.name} 直接放行`)
    return undefined
  }
  // 自审计：放行但留痕
  if (mode === 'self_audit') {
    sessionLog(sessionId, 'info', 'approval', `自审计模式：${ctx.toolCall.name}`)
    console.log(`[audit] session=${sessionId} tool=${ctx.toolCall.name} args=${JSON.stringify(ctx.args)}`)
    return undefined
  }
  // 自定义工具=高风险：每次必弹权限卡（"当前会话允许"的指纹放行不适用）
  if (ctx.toolCall.name.startsWith('custom_')) {
    sessionLog(sessionId, 'warn', 'approval', `高风险自定义工具：${ctx.toolCall.name} 等待授权`)
    /* ★1005：RiskAssessment 要求 toolDisplay —— awaitApproval 拿它做审批卡文案（toolLine）与帧里的 tool。
       原来没传 ⇒ 卡片靠 `|| question` 兜住（文案没坏），但契约缺字段、帧里 tool 为 undefined。
       这里取**与 question 相同**的文本，保证卡片显示一字不变。 */
    const _hrQ = `执行自定义工具（高风险）${ctx.toolCall.name}`
    const hr = await awaitApproval(sessionId, { needApproval: true, risk: 'high', tool: ctx.toolCall.name, toolDisplay: _hrQ, question: _hrQ, args: ctx.args }, signal)
    sessionLog(sessionId, hr.block ? 'warn' : 'info', 'approval', hr.block ? `已拒绝：${hr.reason || '用户拒绝'}` : `已授权：${ctx.toolCall.name}`)
    if (hr.block) return { block: true, reason: hr.reason }
    return undefined
  }
  // 项目自我修改写类操作=高风险：project_fs_write / project_fs_edit / project_fs_delete / project_run_command 每次必弹卡
  if (ctx.toolCall.name === 'project_fs_write' || ctx.toolCall.name === 'project_fs_edit' || ctx.toolCall.name === 'project_fs_delete' || ctx.toolCall.name === 'project_run_command' || ctx.toolCall.name === 'project_bg_start'
    || (ctx.toolCall.name === 'project_bg' && (ctx.args as any)?.action === 'start')) {   // 0921：+project_bg_start（后台跑命令=绕过必弹卡的孪生漏接，已修）；0929 刀①：孪生并成 project_bg 后按 action=start 拦（否则自我修改侧开出免审后门）

    const pa = assessRisk(s, 'fs_' + ctx.toolCall.name.replace('project_', '').replace('fs_', ''), ctx.args)
    sessionLog(sessionId, 'warn', 'approval', `自我修改写操作：${ctx.toolCall.name} 等待授权`)
    /* ★1005 同上：补 toolDisplay（取与 question 相同文本，卡片显示不变）。 */
    const _prQ = `【自我修改】${pa.question || ctx.toolCall.name}（作用于 NIS 源码）`
    const pr = await awaitApproval(sessionId, { needApproval: true, risk: 'high', tool: ctx.toolCall.name, toolDisplay: _prQ, question: _prQ, args: ctx.args }, signal)
    sessionLog(sessionId, pr.block ? 'warn' : 'info', 'approval', pr.block ? `已拒绝：${pr.reason || '用户拒绝'}` : `已授权：${ctx.toolCall.name}`)
    if (pr.block) return { block: true, reason: pr.reason }
    return undefined
  }
  // 会话级授权记忆（"当前会话允许"过的同类调用直接放行）
  const fp = toolFingerprint(sessionId, ctx.toolCall.name, ctx.args)
  if (s.approvedTools?.includes(fp)) {
    sessionLog(sessionId, 'info', 'approval', `${ctx.toolCall.name} 已被会话允许，自动放行`)
    console.log(`[approval] AUTO-PASS session=${sessionId} tool=${ctx.toolCall.name} fp=${fp}`)
    return undefined
  }
  // 需要确认模式：评估风险
  const assessment = assessRisk(s, ctx.toolCall.name, ctx.args)
  if (!assessment.needApproval) {
    console.log(`[approval] NO-NEED session=${sessionId} tool=${ctx.toolCall.name} risk=${assessment.risk}`)
    return undefined
  }
  sessionLog(sessionId, 'warn', 'approval', `等待授权：${assessment.question}`)
  console.log(`[approval] WAIT session=${sessionId} tool=${ctx.toolCall.name} question=${assessment.question.slice(0, 80)}`)
  const result = await awaitApproval(sessionId, { ...assessment, args: ctx.args, toolName: ctx.toolCall.name }, signal)
  sessionLog(sessionId, result.block ? 'warn' : 'info', 'approval', result.block ? `已拒绝：${result.reason || '用户拒绝'}` : `已授权：${ctx.toolCall.name}`)
  console.log(`[approval] RESOLVED session=${sessionId} tool=${ctx.toolCall.name} block=${result.block} reason=${result.reason || ''}`)
  if (result.block) {
    return { block: true, reason: result.reason || '用户拒绝执行' }
  }
  return undefined
}

/** 安装助手分支的工具白名单：这些工具免审批（自带 ask_user 确认），其余（fs_write/run_command 等）走审批门禁 */
const INSTALL_TOOL_WHITELIST = new Set([
  'install_skill', 'uninstall_skill', 'scan_skill', 'list_installed', 'install_mcp', 'uninstall_mcp',
  'list_tools', 'read_preset', 'save_preset', 'delete_preset',
  'list_custom_tools', 'save_custom_tool', 'delete_custom_tool',
  'ask_user', 'use_skill', 'web_search', 'web_fetch', 'github_search', 'fs_read', 'fs_grep',
])

/** 清空会话所有挂起审批（用于会话删除/取消时）。
 *  ★0926 修（真 bug，不是兜底）：此前只 `clearTimeout + delete 登记` ——
 *  **awaitApproval 的 promise 永远 pending**，工具 execute 永不返回，
 *  症状就是"点停止停不掉 / 会话一直 status=running 却永远没有回复"。
 *  隔壁 pendingQuestions 那条注释早写过同一个道理（"必须 resolve，否则工具永远挂着"），
 *  审批这条路漏了。⇒ 清理必须**结算**：把 promise 解掉，让工具拿到"未授权"如实返回。 */
function clearPendingApprovals(sessionId: string): void {
  for (const [reqId, pa] of pendingApprovals) {
    if (pa.sessionId === sessionId) {
      clearTimeout(pa.timer)
      pendingApprovals.delete(reqId)
      try { pa.resolve('取消', '会话已停止/删除，该审批作废') } catch { /* 已结算过则忽略 */ }
      broadcastInteractionDone(sessionId, 'permission', reqId, 'cancelled')   // ★0926②：停止/删除也要清"等待你"标记（★0927：带原因）
    }
  }
}
/* ★0927 R14：解除某会话全部挂起的询问卡（ask_user 的 promise + 计时器 + "等待你"标记）。
   用于 agent 被中途删除/重建的所有路径（撞墙停止/取消/删会话/preset 切换/设置重建）——
   否则 promise 干等 10 分钟超时，卡片状态和 agent 实际状态不同步。 */
function clearPendingQuestions(sessionId: string): void {
  for (const [reqId, pq] of pendingQuestions) {
    if (pq.sessionId === sessionId) {
      clearTimeout(pq.timer)
      pendingQuestions.delete(reqId)
      pq.resolve('__timeout__')
      broadcastInteractionDone(sessionId, 'question', reqId, 'cancelled')
    }
  }
}
// ============================================================================
// 权限门禁：圈内/圈外判定 + HITL_REQUEST 挂起
// ============================================================================

const DANGEROUS_CMD = /(^|\s)(rm|rmdir|del|format|mkfs|drop\s+(database|table)|truncate|shutdown|reboot|taskkill|kill\s+-9|git\s+push\s+.*(--force|-f)|git\s+reset\s+--hard|rm\s+-rf)\b/i

/** 修改性命令（写系统/文件状态，需审批）：重定向/删除/移动/复制/创建目录/包管理/版本提交等 */
const MUTATING_CMD = /(^|\s)((>|>>|2>|\|)\s*|del\s|rm\s|mv\s|move\s|cp\s|copy\s|mkdir\s|md\s|touch\s|install\s|uninstall\s|npm\s+(install|i|uninstall|run\s+(build|dev|start)|init)\b|pnpm\s+(install|i|remove|add|run\s+(build|dev|start)|init)\b|yarn\s+(add|remove|install|run\s+(build|dev|start)|init)\b|pip\s+(install|uninstall|download)\b|git\s+(commit|add|push|pull|merge|rebase|checkout\s+-b|branch\s+-d|tag)\b|python\s+-m\s+(pip|venv)\b|pipenv\s+install\b|poetry\s+(add|install|remove)\b|go\s+(mod|get)\b|cargo\s+(build|install|add|remove)\b|docker\s+(build|run|push|pull|stop|rmi|rm)\b|terraform\s+(apply|destroy|plan\s+-out)\b|kubectl\s+(apply|delete|create)\b|setx\s|reg\s+add\b|attrib\s+[+-])/i

/** 判定目标路径是否在 cwd 圈内 */
function isInside(cwd: string, target: string): boolean {
  const rel = path.relative(cwd, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 解析路径：相对路径基于 cwd，绝对路径不变 */
function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p)
}

interface RiskAssessment {
  needApproval: boolean
  risk: 'low' | 'medium' | 'high'
  question: string
  toolDisplay: string
  /** 0908 修审批指纹 bug：会话级授权记忆必须用「工具名」而非 toolDisplay 首词。
   *  run_command 的 toolDisplay=完整命令串（首词=curl/netstat…），与校验端 toolCall.name（run_command）
   *  永远对不上 → "当前会话允许"白点、同类命令反复弹卡。记录端优先读此字段。 */
  toolName?: string
}

/** 评估工具调用的风险（对齐 Claude Code 语义：写操作一律审批，命令按修改性分级） */
function assessRisk(session: SessionView, toolName: string, args: any): RiskAssessment {
  const cwd = session.workDir || process.cwd()
  /* ★ 0929 工具瘦身·刀①：家族工具（bg/notebook/memory/knowledge）按 action 还原成旧工具名再评估 ——
     风险语义整套沿用下面的既有分支，一条不丢（如 bg 的 start=高危、list/read/stop=低危，与合并前完全一致）。 */
  const FAMILY_ACTION_TOOL: Record<string, string> = {
    'bg:start': 'bg_start', 'bg:list': 'bg_list', 'bg:read': 'bg_read', 'bg:stop': 'bg_stop', 'bg:note': 'bg_note', 'bg:watch': 'bg_watch',
    'notebook:list': 'notebook_list', 'notebook:add': 'notebook_add', 'notebook:update': 'notebook_update', 'notebook:delete': 'notebook_delete',
    'memory:search': 'memory_search', 'memory:store': 'memory_store', 'memory:delete': 'memory_delete', 'memory:distill': 'memory_distill',
    'knowledge:query': 'knowledge_query', 'knowledge:add': 'knowledge_add', 'knowledge:delete': 'knowledge_delete',
    // project_bg 孪生（approvalGate 会把 project_* 归一成 fs_* 名送进来）：start 必须落到 fs_bg_start 高危分支！
    'fs_bg:start': 'fs_bg_start', 'fs_bg:list': 'fs_bg_list', 'fs_bg:read': 'fs_bg_read', 'fs_bg:stop': 'fs_bg_stop', 'fs_bg:note': 'fs_bg_note', 'fs_bg:watch': 'fs_bg_watch',
  }
  const famMapped = FAMILY_ACTION_TOOL[`${toolName}:${String(args?.action || '').trim()}`]
  if (famMapped) toolName = famMapped
  const low = { needApproval: false, risk: 'low' as const, question: '', toolDisplay: '' }
  /* ★ 0929 批次A：三个新工具的风险面（显式声明，不落"未知缺省放行"——0921 bg_start 后门教训）：
     list_dir=只读低危；history 只有 restore=写高危；schedule 的 create/update/remove/run_now=改配置/起活=中高危。 */
  if (toolName === 'list_dir') return { ...low, toolDisplay: `list_dir ${args?.path || '.'}`, question: `列目录：${args?.path || '（工作区根）'}` }
  if (toolName === 'history') {
    const a = String(args?.action || '')
    if (a === 'restore') return { needApproval: true, risk: 'high', question: `回滚文件改动 ${args?.change_id}（=时光机，动真实文件）`, toolDisplay: `history restore ${args?.change_id}` }
    return { ...low, toolDisplay: `history ${a}`, question: `查文件历史：${a}` }
  }
  if (toolName === 'schedule') {
    const a = String(args?.action || '')
    if (a === 'list') return { ...low, toolDisplay: 'schedule list', question: '查定时任务列表' }
    if (a === 'create') return { needApproval: true, risk: 'medium', question: `新建定时任务「${args?.name}」（${args?.kind}：到点自动执行）`, toolDisplay: `schedule create ${args?.name}` }
    return { needApproval: true, risk: 'medium', question: `改/删/立即执行定时任务：${a} ${args?.id || ''}`, toolDisplay: `schedule ${a} ${args?.id || ''}` }
  }
  if (toolName === 'git') {
    const a = String(args?.action || '')
    if (a === 'commit') return { needApproval: true, risk: 'medium', question: `git 提交：${String(args?.message || '').slice(0, 60)}`, toolDisplay: `git commit ${String(args?.message || '').slice(0, 40)}` }
    return { ...low, toolDisplay: `git ${a}`, question: `git ${a}（只读）` }
  }
  if (toolName === 'repo') return { ...low, toolDisplay: `repo ${args?.action || ''}`, question: `仓库导航：${args?.action || ''}（只读；build 只写 .nis- 索引缓存）` }

  if (toolName === 'fs_read') {
    const p = resolvePath(cwd, String(args?.path || ''))
    return { ...low, toolDisplay: `fs_read ${args?.path}`, question: `读取文件：${p}` }
  }

  if (toolName === 'fs_grep') {
    // 只读搜索：不进审批（与 fs_read 同级），展示搜索词与被搜目录
    const p = String(args?.path || '')
    return { ...low, toolDisplay: `fs_grep ${args?.pattern}`, question: `搜索文件内容：${args?.pattern}${p ? `（目录 ${p}）` : ''}` }
  }

  if (toolName === 'fs_write') {
    // 写操作一律审批（大厂默认行为）：展示路径 + 写入内容摘要
    const p = resolvePath(cwd, String(args?.path || ''))
    const content = String(args?.content || '')
    const summary = content.length > 60 ? content.slice(0, 60) + '…' : content
    return {
      needApproval: true,
      risk: 'medium',
      question: `写入文件：${p}${summary ? `\n内容：${summary}` : ''}`,
      toolDisplay: `fs_write ${args?.path}`,
    }
  }

  if (toolName === 'fs_edit') {
    // 精准替换同样是写操作：与 fs_write 同级审批（0913 补 —— fs_edit 批次最初漏接评估，
    // confirm 模式下曾**免审直写**；catalog 标了 risky 但审批门禁没接住）
    const p = resolvePath(cwd, String(args?.path || ''))
    const oldS = String(args?.old_string || '')
    const summary = oldS.length > 50 ? oldS.slice(0, 50) + '…' : oldS
    return {
      needApproval: true,
      risk: 'medium',
      question: `编辑文件：${p}${summary ? `\n替换片段：${summary}` : ''}`,
      toolDisplay: `fs_edit ${args?.path}`,
    }
  }

  if (toolName === 'fs_delete') {
    // 删除一律审批（不可逆）：展示路径；recursive 删除目录升级高风险
    const p = resolvePath(cwd, String(args?.path || ''))
    return {
      needApproval: true,
      risk: args?.recursive ? 'high' : 'medium',
      question: args?.recursive ? `递归删除：${p}` : `删除文件：${p}`,
      toolDisplay: `fs_delete ${args?.path}`,
    }
  }

  if (toolName === 'run_command') {
    const cmd = String(args?.command || '')
    const cmdCwd = args?.cwd ? resolvePath(cwd, String(args.cwd)) : cwd
    const cwdOutside = !isInside(cwd, cmdCwd)
    const dangerous = DANGEROUS_CMD.test(cmd)
    const mutating = MUTATING_CMD.test(cmd)
    if (dangerous) {
      return { needApproval: true, risk: 'high', question: `执行高风险命令：${cmd}`, toolDisplay: cmd }
    }
    if (cwdOutside) {
      return { needApproval: true, risk: 'medium', question: `在会话工作区外执行命令：${cmd}`, toolDisplay: cmd }
    }
    if (mutating) {
      return { needApproval: true, risk: 'medium', question: `执行修改性命令：${cmd}`, toolDisplay: cmd }
    }
    return { ...low, toolDisplay: cmd, question: `执行命令：${cmd}` }
  }

  /* 后台任务（0921 接线）：bg_start 语义上等于「把命令挪到后台跑」，危险度与 run_command 同源 ——
     漏接时它会掉进本函数末尾的"未知工具缺省放行"，变成**免审跑任意命令**的后门。
     'fs_bg_start' = project_bg_start 的孪生名（server.ts 用 'fs_' + 去掉 project_ 前缀拼出来）。 */
  if (toolName === 'bg_start' || toolName === 'fs_bg_start') {
    const cmd = String(args?.command || '')
    const url = String(args?.url || '')
    const cmdCwd = args?.cwd ? resolvePath(cwd, String(args.cwd)) : cwd
    const cwdOutside = !isInside(cwd, cmdCwd)
    const dangerous = cmd ? DANGEROUS_CMD.test(cmd) : false
    const mutating = cmd ? MUTATING_CMD.test(cmd) : false
    const what = cmd || url
    if (dangerous) {
      return { needApproval: true, risk: 'high', question: `后台执行高风险命令：${cmd}`, toolDisplay: `bg_start ${cmd}`, toolName: 'bg_start' }
    }
    if (cwdOutside) {
      return { needApproval: true, risk: 'medium', question: `在会话工作区外后台执行：${cmd}`, toolDisplay: `bg_start ${cmd}`, toolName: 'bg_start' }
    }
    // 修改性命令 / 任何下载：挂后台=脱离当前对话、结束才通知 → 一律先问一句
    if (mutating || url) {
      return { needApproval: true, risk: 'medium', question: `挂到后台执行（结束时才通知）：${what}`, toolDisplay: `bg_start ${what}`, toolName: 'bg_start' }
    }
    return { ...low, toolDisplay: `bg_start ${what}`, question: `挂到后台执行：${what}` }
  }
  // bg_list / bg_read / bg_stop：纯查询 + 停掉自己派发的任务（树杀），低风险放行
  if (toolName === 'bg_list' || toolName === 'bg_read' || toolName === 'bg_stop') {
    const id = String(args?.task_id || '')
    return { ...low, toolDisplay: `${toolName} ${id}`, question: toolName === 'bg_stop' ? `停止后台任务：${id}` : `查看后台任务：${id || '全部'}` }
  }


  // 记忆/知识库写入：一律审批（AI 不应未经确认向用户记忆/知识库注入内容）
  if (toolName === 'memory_store') {
    const content = String(args?.content || '')
    const summary = content.length > 80 ? content.slice(0, 80) + '…' : content
    return {
      needApproval: true,
      risk: 'medium',
      question: `写入长期记忆：${summary}`,
      toolDisplay: `memory_store ${summary}`,
    }
  }

  if (toolName === 'knowledge_add') {
    const title = String(args?.title || '')
    const content = String(args?.content || '')
    const summary = content.length > 80 ? content.slice(0, 80) + '…' : content
    return {
      needApproval: true,
      risk: 'medium',
      question: `写入知识库：${title}${summary ? `\n内容：${summary}` : ''}`,
      toolDisplay: `knowledge_add ${title}`,
    }
  }

  // 记忆/知识库删除：一律审批（不可逆操作，需用户确认）
  if (toolName === 'memory_delete') {
    const target = String(args?.id || args?.query || '')
    return {
      needApproval: true,
      risk: 'medium',
      question: `删除记忆：${target || '(按内容检索)'}`,
      toolDisplay: `memory_delete ${target}`,
    }
  }

  if (toolName === 'knowledge_delete') {
    const target = String(args?.id || '')
    return {
      needApproval: true,
      risk: 'medium',
      question: `删除知识库条目：${target}`,
      toolDisplay: `knowledge_delete ${target}`,
    }
  }

  // 联网工具：只读外部信息、不改本地状态，低风险放行
  if (toolName === 'web_search') {
    return { ...low, toolDisplay: `web_search ${String(args?.query || '').slice(0, 60)}`, question: `联网搜索：${args?.query}` }
  }
  if (toolName === 'web_fetch') {
    const url = String(args?.url || '')
    // 内网地址需审批（防 SSRF 探测本地服务）
    const isLocal = /^(https?:\/\/)(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(url)
    if (isLocal) {
      return { needApproval: true, risk: 'medium', question: `访问内网地址：${url}`, toolDisplay: `web_fetch ${url}` }
    }
    return { ...low, toolDisplay: `web_fetch ${url.slice(0, 60)}`, question: `读取网页：${url}` }
  }
  if (toolName === 'github_search') {
    return { ...low, toolDisplay: `github_search ${String(args?.query || '').slice(0, 50)}`, question: `GitHub 搜索：${args?.query}` }
  }

  // 设置更新（用户明确要求改名字/提示词等）：confirm 模式也放行——AI 只在用户明确指示时调用，
  // 且通过 ask_user 确认过才执行；错误调用由自审计日志兜底
  if (toolName === 'settings_update') {
    const changes = Object.entries(args || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `${k}=${v}`).join(' ')
    return { ...low, toolDisplay: `settings_update ${changes}`, question: `更新设置：${changes}` }
  }

  // 未知工具：缺省直接放行（不阻截未知工具，避免误伤）
  // 0908 C₁：桌面整屏截图=把用户屏幕上所有窗口内容交给系统，隐私等级最高——
  // confirm/self_audit 都必须弹卡批准（full_access 自然放行）；批准后可用 remember 键免重复弹
  if (toolName === 'mcp__nis-browser__wb_screen_capture') {
    return { needApproval: true, risk: 'high', question: 'AI 请求截取你的整个屏幕画面（会包含屏幕上所有可见窗口的内容）。批准后将发送到你自己的对话流中（默认不回传给模型）。', toolDisplay: '屏幕截图（wb_screen_capture）' }
  }

  return { ...low, toolDisplay: toolName, question: `执行工具：${toolName}` }
}

/** 提交 HITL_REQUEST 并挂起，等待用户审批 */
function awaitApproval(
  sessionId: string,
  /** ★1005 补 tool?：调用点（自定义工具/自我修改两处）一直在传 tool，类型没声明 ⇒ TS 报多字段；
   *  落点 PendingApproval 本身就有 tool?: string，属于类型漏声明。 */
  info: RiskAssessment & { args: any; tool?: string },
  signal?: AbortSignal,
): Promise<{ block: boolean; reason?: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ block: true, reason: '已取消' })
      return
    }

    const requestId = crypto.randomUUID()
    const onAbort = () => {
      const pa = pendingApprovals.get(requestId)
      if (pa) {
        clearTimeout(pa.timer)
        pendingApprovals.delete(requestId)
      }
      // 0912 三批：abort（用户点停止/发 /stop）也要清 IM 登记 ——
      // 否则用户之后回「允许」会命中失效登记，收到假的"已授权"回执
      clearImPendingByRequest(requestId)
      resolve({ block: true, reason: '已取消' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      /* ★0926：超时计时器触发**必须留痕**。0926 实报"一条会话 status=running 挂了 2 小时、
         审批登记还在内存里"，而日志里既没有 RESOLVED 也没有任何异常 ——
         无法判断是**计时器根本没跑**还是**跑了但结算失败**。有这行才能区分（只加证据，不改行为）。 */
      console.warn(`[approval] 超时计时器触发（${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s）：session=${sessionId.slice(0, 8)} request=${requestId.slice(0, 8)}`)
      signal?.removeEventListener('abort', onAbort)
      pendingApprovals.delete(requestId)
      // 0912 二批：超时也要清 IM 侧登记（否则用户之后回「允许」会命中已失效的登记）
      clearImPendingByRequest(requestId)
      // 0912 三批：超时主动告知 IM —— 否则用户只看到 agent 突然回一句"无法执行"，不知为何
      const ctxT = channelPushContext(sessionId)
      if (ctxT) {
        void deliverToChannel(ctxT, `⏱ 授权等待超时（${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟），该操作已按「未授权」处理。\n如需执行，重新发指令即可（可在 PC 端把权限档位改为「审计模式」减少打断）。`).catch(() => { /* 通知失败不阻塞 */ })
      }
      /* ★0926 链路修复③：同一操作连续超时的判定（详见 approvalTimeoutStreak 注释）。
         第 2 次超时 → 停止本轮，避免"模型重试→再等 10 分钟"的烧 token 循环。
         ★0929 P1：改**会话×工具指纹**双层键 —— 原单槽被 A/B 交替超时互相冲掉计数（永不熔断）。 */
      const _fp = toolFingerprint(sessionId, info.toolName || info.toolDisplay || '', info.args) || String(info.toolDisplay || '')
      const _m = approvalTimeoutStreak.get(sessionId) ?? new Map<string, { n: number; lastAt: number }>()
      const _prev = _m.get(_fp)
      const _n = (_prev ? _prev.n : 0) + 1
      _m.set(_fp, { n: _n, lastAt: Date.now() })
      approvalTimeoutStreak.set(sessionId, _m)
      if (_n >= 2) {
        console.warn(`[approval] 同一操作连续 ${_n} 次超时 → 停止本轮（不再自动重试）session=${sessionId.slice(0, 8)} tool=${info.toolDisplay}`)
        sessionLog(sessionId, 'warn', 'approval', `同一操作连续 ${_n} 次等不到授权（累计约 ${Math.round((APPROVAL_TIMEOUT_MS * _n) / 60000)} 分钟）→ 已停止本轮，不再自动重试`)
        try {
          broadcastMux(sessionId, {
            type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(),
            value: { text: '同一操作连续 2 次等不到授权，已停止本轮。要执行请打开卡片点「允许一次」。' },
          } as any)
        } catch { /* 提示失败不影响收尾 */ }
        // 先让这一跳如实返回"未授权"，再把本轮停掉（防模型立刻发起第三次重试）
        setTimeout(() => { try { agents.get(sessionId)?.abort() } catch { /* ignore */ } }, 50)
      }
      resolve({ block: true, reason: _n >= 2
        ? `审批超时（同一操作已连续 ${_n} 次未授权：本轮已停止，请勿重试同一操作，改为向用户说明需要授权）`
        : '审批超时' })
      broadcastInteractionDone(sessionId, 'permission', requestId, 'timeout')   // ★0926②：超时也要清"等待你"标记（★0927：带原因）
    }, APPROVAL_TIMEOUT_MS)

    pendingApprovals.set(requestId, {
      sessionId,
      question: info.question,
      tool: info.toolDisplay,
      risk: info.risk,
      options: ['允许一次', '当前会话允许', '拒绝'],
      resolve: (choice: string, reasonOverride?: string) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        pendingApprovals.delete(requestId)
        // 0912 二批：同步清理 IM 侧待审批登记（幂等）
        clearImPendingByRequest(requestId)
        const allowed = /允许|allow/i.test(choice)
        // ★0926③：授权成功 → 清"连续超时"计数。★0929 P1：只清**本工具**的计数（双层键），
        // 别的工具此前超时的累计不受影响（原单槽是整会话一锅端）
        if (allowed) approvalTimeoutStreak.get(sessionId)?.delete(toolFingerprint(sessionId, info.toolName || info.toolDisplay, info.args) || String(info.toolDisplay || ''))
        // "当前会话允许" → 记录工具指纹，后续同类调用不再审批
        if (allowed && /当前会话|会话允许|session/i.test(choice)) {
          const session = sessions.get(sessionId)
          const fp = toolFingerprint(sessionId, info.toolName || info.toolDisplay, info.args)
          if (session && fp) {
            if (!session.approvedTools) session.approvedTools = []
            if (!session.approvedTools.includes(fp)) {
              session.approvedTools.push(fp)
              schedulePersist()
            }
          }
        }
        resolve(allowed ? { block: false } : { block: true, reason: reasonOverride || `用户拒绝：${choice}` })
        broadcastInteractionDone(sessionId, 'permission', requestId, 'answered')   // ★0926②：清所有窗口的"等待你"标记（★0927：带原因）
      },
      timer,
    })

    broadcastMux(sessionId, {
      type: 'session/hitl-request',
      sessionId,
      requestId,
      question: info.question,
      options: ['允许一次', '当前会话允许', '拒绝'],
      tool: info.toolDisplay,
      risk: info.risk,
      args: info.args,
    })

    /**
     * 0912 二批：审批桥 —— 通道会话的审批请求**同时推给 IM**。
     *
     * 为什么必须做：审批卡只走 PC 的 SSE，用户在手机上看不到 → 干等到超时（表现为「卡住不回」）。
     * 这里把审批推到 IM，用户回「允许」/「拒绝」即可批准（见 handleChannelIncoming 的拦截）。
     * 注：通道默认已是 self_audit（不弹卡），本桥是为「用户主动改成 confirm」的场景兜底。
     */
    const imCtx = channelPushContext(sessionId)
    if (imCtx) {
      const imKey = makeChannelKey(imCtx.channel, imCtx.botId, imCtx.peerId)
      const riskTxt = info.risk === 'high' ? '高' : info.risk === 'medium' ? '中' : '低'
      const toolLine = `${info.toolDisplay || info.question || '未知操作'}（风险：${riskTxt}）`
      /**
       * 登记（供 IM 回复时定位）—— **按 channelKey**，与"当前是哪个会话"解耦：
       * 用户在等审批期间从 PC 切换了当前会话，仍然能靠这条登记批准（二批按 sessionId 存时会被切走）。
       */
      imPendingApprovals.set(imKey, {
        requestId,
        sessionId,
        toolLine,
        resolveChoice: (choice) => {
          const pa = pendingApprovals.get(requestId)
          if (pa) pa.resolve(choice)
        },
      })
      const tip = [
        '⚠️ 需要你的授权',
        '',
        `操作：${info.toolDisplay || info.question || '未知操作'}`,
        `风险：${riskTxt}`,
        '',
        channelHasButtons(imCtx)
          ? '点下面的按钮，或回复「允许」/「都允许」/「拒绝」。'
          : '回复「允许」/「都允许」/「拒绝」即可（这条通道没有按钮）。',
      ].join('\n')
      /**
       * ★1017：审批**做成按钮**（用户"能做成按钮的都可以"）—— 按钮的 data 就是「允许/都允许/拒绝」这三个词，
       * 点击后走的是**现有文字审批链路**，零新机制。这也是他说的"权限遗留问题"的正解：手机上点一下就行。
       */
      void deliverToChannel(imCtx, tip, { keyboard: buildApprovalKeyboard() }).catch((e: any) => {
        console.warn(`[channel] 审批推送失败（超时会另行告知）: ${String(e?.message || e).slice(0, 120)}`)
      })
    }
  })
}

/**
 * 0912 三批：IM 侧待审批登记 —— **按 `channelKey`（`channel:bot:peer`）索引**。
 *
 * 为什么不用 sessionId 索引（二批的写法，实测有洞）：用户在等审批期间若从 PC 端
 * **切换了当前会话**，映射指向变了 → 拦截时按新会话查不到登记 → 回「允许」不生效 → 卡到超时。
 * 审批是「这个聊天对象此刻有一个待批操作」，与"哪个会话是当前"无关 —— 所以按 channelKey 存。
 */
const imPendingApprovals = new Map<string, {
  requestId: string
  sessionId: string
  /** 待批操作的可读描述（用户发别的消息时提示用） */
  toolLine: string
  resolveChoice: (c: string) => void
}>()

/** 按 requestId 清登记（超时 / resolve / abort 三条路径共用，幂等） */
function clearImPendingByRequest(requestId: string): void {
  for (const [k, v] of imPendingApprovals) {
    if (v.requestId === requestId) imPendingApprovals.delete(k)
  }
}

/** 工具指纹：用于"当前会话允许"的会话级授权记忆。
 *  粒度=工具级（用户点"当前会话允许"即信任该类操作，会话内不再重复询问；
 *  按命令/路径细分会导致每条新命令都重新弹卡） */
function toolFingerprint(_sessionId: string, toolDisplay: string, _args: any): string {
  return (toolDisplay || '').split(/\s/)[0]
}

/** 询问卡：AI 主动问用户（挂起等待用户回答）；questions 数组 = 一次多题 */
/** 第一轮对话结束后用 LLM 生成会话标题（≤16 字总结）；用户手动命名的会话不覆盖。
 *  0910 修复：网关（商汤/b.ai 等）对 stream:false 也照样回 SSE（body 以 "data: {"id" 开头），
 *  旧 res.json() 直接抛 SyntaxError → 标题永远停在"首条消息截断"兜底。改为先拿 text，
 *  嗅探 SSE 逐块解析拼接；且失败不再占 titleGenDone 名额（下轮 agent_end 重试直到成功）。 */
const titleGenDone = new Set<string>()
async function generateSessionTitle(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session || session.titleManual || titleGenDone.has(sessionId)) {
    console.log(`[title] skip: session=${!!session} titleManual=${!!session?.titleManual} done=${titleGenDone.has(sessionId)}`)
    return
  }
  titleGenDone.add(sessionId)
  console.log(`[title] generating for ${sessionId.slice(0, 8)}`)
  const titleT0 = Date.now()
  try {
    const cfg = currentLlmConfig()
    if (!cfg?.base || !cfg?.model) { titleGenDone.delete(sessionId); return }
    const isLocalBase = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(cfg.base)
    if (!cfg.apiKey && !isLocalBase) { titleGenDone.delete(sessionId); return }
    const transcriptText = session.messages.slice(0, 4).map(m =>
      `${m.role === 'user' ? '用户' : 'AI'}：${(m.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ').slice(0, 300)}`
    ).join('\n')
    // 0910 协议扩展：原生协议供应商（anthropic/google）用各自端点，openai 兼容走 /chat/completions
    const titleProto = cfg.protocol || 'openai-completions'
    const titleSys = '你是会话命名器。根据对话内容生成一个不超过 10 个字的标题，概括对话主题。只输出标题本身，不要标点、引号或任何解释。直接输出标题，不要思考过程。'
    let titleUrl: string
    let titleHeaders: Record<string, string>
    let titleBody: string
    if (titleProto === 'anthropic-messages') {
      titleUrl = /\/v\d/.test(cfg.base) ? `${cfg.base}/messages` : `${cfg.base}/v1/messages`
      titleHeaders = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey || '', 'anthropic-version': '2023-06-01' }
      titleBody = JSON.stringify({ model: cfg.model, system: titleSys, messages: [{ role: 'user', content: transcriptText.slice(0, 1200) }], max_tokens: 512, temperature: 0.3 })
    } else if (titleProto === 'google-generative-ai') {
      const root = /\/v\d/.test(cfg.base) ? cfg.base : `${cfg.base}/v1beta`
      titleUrl = `${root}/models/${encodeURIComponent(cfg.model)}:generateContent`
      titleHeaders = { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey || '' }
      titleBody = JSON.stringify({ systemInstruction: { parts: [{ text: titleSys }] }, contents: [{ role: 'user', parts: [{ text: transcriptText.slice(0, 1200) }] }], generationConfig: { maxOutputTokens: 512, temperature: 0.3 } })
    } else {
      titleUrl = `${cfg.base}/chat/completions`
      titleHeaders = { 'content-type': 'application/json', authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : '' }
      titleBody = JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: titleSys },
          { role: 'user', content: transcriptText.slice(0, 1200) },
        ],
        stream: false,
        // 思考模型（LongCat-2.0）即使 stream=false 也输出 reasoning_content：max_tokens 小了全花在思考上
        // content 为空 → 标题静默失败（0831 深夜回归实锤：16 全灭、64 偶发为空）。给足余量
        max_tokens: 512,
        temperature: 0.3,
      })
    }
    const res = await fetch(titleUrl, {
      method: 'POST',
      headers: titleHeaders,
      body: titleBody,
      // 15s 兜底：无超时的挂起请求会让标题永远不更新且无任何日志
      signal: AbortSignal.timeout(15000),
    })
    console.log(`[title] fetch done: HTTP ${res.status} (${Date.now() - titleT0}ms)`)
    if (!res.ok) { console.log(`[title] generate failed: HTTP ${res.status}`); titleGenDone.delete(sessionId); return }
    const raw = await res.text()
    let t = ''
    let u: any = null
    if (raw.trimStart().startsWith('data:') || raw.trimStart().startsWith('event:')) {
      // SSE 兼容路径：逐行取 data: 块，非流式网关可能一次性回完整 message，流式网关回 delta——两种都拼。
      // 0910：同时认三种方言——openai（choices[].delta.content）/ anthropic（content_block_delta.delta.text）
      // / gemini（candidates[].content.parts[].text）。原生协议网关强制流式时同一段代码兜住。
      for (const line of raw.split(/\r?\n/)) {
        const m = /^data:\s*(.+)$/.exec(line.trim())
        if (!m || m[1] === '[DONE]') continue
        try {
          const c = JSON.parse(m[1])
          const oa = c?.choices?.[0]?.message?.content ?? c?.choices?.[0]?.delta?.content
          const an = c?.type === 'content_block_delta' ? c?.delta?.text : undefined
          const gm = Array.isArray(c?.candidates) ? c.candidates.map((cd: any) => (cd?.content?.parts || []).map((p: any) => p?.text || '').join('')).join('') : undefined
          const piece = typeof oa === 'string' ? oa : (typeof an === 'string' ? an : (typeof gm === 'string' ? gm : undefined))
          if (typeof piece === 'string') t += piece
          if (c?.usage) u = { prompt_tokens: c.usage.prompt_tokens ?? c.usage.input_tokens, completion_tokens: c.usage.completion_tokens ?? c.usage.output_tokens }
          else if (c?.usageMetadata) u = { prompt_tokens: c.usageMetadata.promptTokenCount, completion_tokens: c.usageMetadata.candidatesTokenCount }
        } catch { /* 半截帧忽略 */ }
      }
    } else {
      try {
        const data = JSON.parse(raw)
        if (titleProto === 'anthropic-messages') {
          // Anthropic：{content:[{type:'text',text}], usage:{input_tokens,output_tokens}}
          t = String((data?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('') || '')
          if (data?.usage) u = { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens }
        } else if (titleProto === 'google-generative-ai') {
          // Gemini：{candidates:[{content:{parts:[{text}]}}], usageMetadata}
          t = String((data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || '').join('') || '')
          if (data?.usageMetadata) u = { prompt_tokens: data.usageMetadata.promptTokenCount, completion_tokens: data.usageMetadata.candidatesTokenCount }
        } else {
          t = String(data?.choices?.[0]?.message?.content || '')
          u = data?.usage
        }
      } catch { console.log('[title] generate failed: body not JSON/SSE'); titleGenDone.delete(sessionId); return }
    }
    // 标题生成也是真实 LLM 调用：不入账会让 billing 与官方后台差 ~800 in / ~30 out（对账误差来源）
    if (u) recordUsage(cfg.providerId, cfg.model, u.prompt_tokens || 0, u.completion_tokens || 0)
    const title = t.trim().replace(/^["'「」《<]+|["'「」》>]+$/g, '').split(/\r?\n/)[0].trim().slice(0, 12)
    const cur = sessions.get(sessionId)
    if (!title || cur !== session || cur.titleManual) {
      console.log(`[title] skip-apply: t=${JSON.stringify(title)} sameRef=${cur === session} titleManual=${!!cur?.titleManual}`)
      if (!title) titleGenDone.delete(sessionId) // 空内容=网关把 token 花在思考上了，允许下轮重试
      return
    }
    session.title = title
    session.titleGenerated = true
    schedulePersist()
    broadcastHost({ type: 'host/session-renamed', sessionId, title })
    console.log(`[title] session=${sessionId.slice(0, 8)} -> ${title}`)
  } catch (e: any) {
    console.log(`[title] generate error: ${e?.message || e}`)
    titleGenDone.delete(sessionId) // 失败释放：下一轮 agent_end 再试（旧版一旦失败永不重试）
  }
}

/** 某会话当前挂起的询问卡（刷新后前端恢复显示用） */
function pendingFor(sessionId: string): Array<{ requestId: string; question: string; questions?: any[]; options?: string[]; placeholder?: string }> {
  return Array.from(pendingQuestions.entries())
    .filter(([, pq]) => pq.sessionId === sessionId)
    .map(([requestId, pq]) => ({
      requestId,
      question: pq.questions[0]?.question || '',
      questions: pq.questions.length > 1 ? pq.questions : undefined,
      options: pq.questions[0]?.options,
      placeholder: pq.questions[0]?.placeholder,
    }))
}

/** 会话执行日志：落盘 + SSE 实时推送（运行面板数据源） */
function sessionLog(sessionId: string, level: 'info' | 'warn' | 'error', category: 'lifecycle' | 'llm' | 'tool' | 'approval' | 'install' | 'mcp' | 'session', message: string, data?: any): void {
  const entry = logEvent(sessionId, level, category, message, data)
  broadcastMux(sessionId, { type: 'session/log', sessionId, entry: { t: entry.t, level, category, message, data } })
}

/** 计划本广播：plan 变化时推给前端（输入框上方计划卡） */
function broadcastPlan(sessionId: string): void {
  const s = sessions.get(sessionId)
  // 0910 三批①：黑板计划随帧独立下发（前端按 黑板→主计划→子计划 顺序渲染三张卡；子计划由前端从成员节点聚合）
  broadcastMux(sessionId, { type: 'session/plan', sessionId, items: s?.plan || [], boardItems: s?.boardPlan || [] })
}

/** 工具参数日志摘要：JSON 截断到 160 字符，key/token/password 类字段值脱敏 */
function sanitizeArgsForLog(args: unknown): string {
  let raw = ''
  try { raw = JSON.stringify(args ?? {}) } catch { raw = String(args ?? '') }
  raw = raw.replace(/("(?:key|token|password|secret|authorization|apiKey|api_key)"\s*:\s*")([^"]{4})[^"]*(")/gi, '$1$2…$3')
  return raw.length > 160 ? raw.slice(0, 160) + '…' : raw
}

/** 计划本工具：AI 拆解多步骤任务时写计划（全量替换语义），用户在输入框上方看到进度划勾 */
function buildPlanTool(sessionId: string): AgentTool<any> {
  return {
    name: 'plan_write',
    label: '写计划',
    description: '写/更新本任务的执行计划（输入框上方计划卡展示给用户，完成一条划一条）。多步骤任务开工前先写全量计划；每完成一步就重写整个清单（把完成的条目 done 置 true）。条目要短，一句话一步。',
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        text: Type.String({ description: '步骤描述（一句话，具体可执行）' }),
        done: Type.Optional(Type.Boolean({ description: "是否已完成（默认 false）" })),
      }), { description: '全量计划条目（每次传完整清单）' }),
    }),
    async execute(_callId, params: any) {
      const items = (Array.isArray(params.items) ? params.items : [])
        .map((x: any) => ({ text: String(x?.text || '').slice(0, 120), done: !!x?.done }))
        .filter((x: any) => x.text)
      if (items.length === 0) throw new Error('items 不能为空')
      if (items.length > 12) throw new Error('计划最多 12 条——拆得更细不如先做起来')
      const s = sessions.get(sessionId)
      if (s) { s.plan = items; schedulePersist() }
      broadcastPlan(sessionId)
      const doneN = items.filter(x => x.done).length
      return { content: [{ type: 'text', text: `计划已更新（${doneN}/${items.length} 完成）。${items.every(x => x.done) ? '计划全部完成。' : '继续执行下一步。'}` }], details: { ok: true, items } }
    },
  }
}
function askUser(sessionId: string, questions: Array<{ question: string; options?: string[]; placeholder?: string }>): Promise<string> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      pendingQuestions.delete(requestId)
      resolve('__timeout__')
      broadcastInteractionDone(sessionId, 'question', requestId, 'timeout')   // ★0926②：清"等待你"标记（★0927：带原因）
    }, APPROVAL_TIMEOUT_MS)
    pendingQuestions.set(requestId, {
      sessionId,
      questions,
      resolve: (value: string) => {
        clearTimeout(timer)
        pendingQuestions.delete(requestId)
        resolve(value)
        broadcastInteractionDone(sessionId, 'question', requestId, 'answered')   // ★0926②：清"等待你"标记（★0927：带原因）
      },
      timer,
    })
    broadcastMux(sessionId, {
      type: 'session/question',
      sessionId,
      requestId,
      question: questions[0]?.question || '',
      questions: questions.length > 1 ? questions : undefined,
      options: questions[0]?.options,
      placeholder: questions[0]?.placeholder,
    })
  })
}

/** 询问卡工具（Agent 注册，让 AI 可以主动问用户问题） */
function buildAskUserTool(sessionId: string): AgentTool<any> {
  return {
    name: 'ask_user',
    label: '向用户提问',
    description: '向用户提问并等待回答。可以用 questions 数组一次问多个问题（每题有 question/options/placeholder），也可以只用单个 question。适合需要用户确认、选择或澄清的场景。',
    parameters: Type.Object({
      questions: Type.Optional(Type.Array(Type.Object({
        question: Type.String({ description: '问题内容' }),
        options: Type.Optional(Type.Array(Type.String(), { description: '可选选项列表' })),
        placeholder: Type.Optional(Type.String({ description: '自由输入时的占位提示' })),
      }), { description: '一次提问多个问题（推荐；提供时忽略 question）' })),
      question: Type.Optional(Type.String({ description: '单个问题（questions 未提供时使用）' })),
      options: Type.Optional(Type.Array(Type.String(), { description: '单个问题的可选选项列表（多选场景）' })),
      placeholder: Type.Optional(Type.String({ description: '单个问题的输入框占位提示（自由输入场景）' })),
    }),
    async execute(_callId, params: any) {
      const questions: Array<{ question: string; options?: string[]; placeholder?: string }> =
        Array.isArray(params.questions) && params.questions.length > 0
          ? params.questions
          : [{ question: params.question, options: params.options, placeholder: params.placeholder }]
      const answer = await askUser(sessionId, questions)
      if (answer === '__timeout__') {
        return {
          content: [{ type: 'text', text: '用户未在超时时间内回答，请简化问题或稍后重试' }],
          details: { answered: false },
        }
      }
      // answer 可能是 JSON（多题）或纯文本（单题），转成模型可读文本
      let answerText = answer
      try {
        const arr = JSON.parse(answer)
        if (Array.isArray(arr)) {
          answerText = arr.map((a: any) => `${a.question || '问题'}: ${a.value ?? '跳过'}`).join('；')
        }
      } catch { /* 单题纯文本 */ }
      return {
        content: [{ type: 'text', text: `用户回答：${answerText}` }],
        details: { answered: true, value: answer },
      }
    },
  }
}

/* ★0929 P1（刀7 mux 慢客户端背压）：写缓冲分档——病根是 `res.write` 返回值/缓冲量从不检查，
   某窗口卡顿时（大 base64 帧尤甚）Node 侧写缓冲**无界增长**，拖垮整个后端内存。
   · 软上限：超过后只丢**可恢复帧**（高频、刷新/对账能补回的），小而关键的交互/状态帧照发；
   · 硬上限：超过说明客户端确实跟不上 → 断开该连接（前端看门狗会重连，状态从 history/对账补回）。
   两级都在**写入口**判定，JS 单线程下无竞态。 */
const SSE_SOFT_CAP = 4 * 1024 * 1024
const SSE_HARD_CAP = 16 * 1024 * 1024
/** 高频可恢复帧（丢了只影响实时观感）：agent 增量/会话日志/子agent流/浏览器截图/投影快照 */
function isRecoverableFrame(t: string): boolean {
  return t === 'session/event' || t === 'session/log' || t === 'session/subagent-event'
    || t === 'browser/frame' || t === 'session/projection'
}
const sseDropped = new WeakMap<ServerResponse, number>()
let sseDropLogAt = 0
/** 背压守卫：true=可以写；false=跳过本帧（已断开，或超软上限的可恢复帧被丢弃） */
function sseBackpressure(res: ServerResponse, frameType: string, where: string): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false
    const buffered = res.writableLength          // Node 写缓冲里积压的字节数（不含内核 socket 缓冲）
    if (buffered > SSE_HARD_CAP) {
      console.warn(`[mux] 客户端写缓冲 ${buffered}B 超硬上限 → 断开（前端看门狗会重连并补状态）${where} type=${frameType}`)
      res.destroy()
      return false
    }
    if (buffered > SSE_SOFT_CAP && isRecoverableFrame(frameType)) {
      const n = (sseDropped.get(res) || 0) + 1
      sseDropped.set(res, n)
      if (n % 500 === 1 || Date.now() - sseDropLogAt > 30000) {
        sseDropLogAt = Date.now()
        console.warn(`[mux] 慢客户端丢弃可恢复帧（累计 ${n}，缓冲 ${buffered}B）${where} type=${frameType}`)
      }
      return false
    }
    return true
  } catch { return true }
}

function sendSseFrame(res: ServerResponse, frame: ServerRequest): void {
  const data = JSON.stringify(frame)
  try {
    // 客户端断开后 write-after-end 会抛 ERR_STREAM_WRITE_AFTER_END——这里异常会穿透到
    // 所有业务调用方（sessionLog/teamRuntime broadcast 等），必须在源头吞掉
    // ★0929 刀7：写入口先过背压守卫（host 帧多为状态/进度，仍按可恢复帧口径分档）
    if (!sseBackpressure(res, String((frame as any)?.payload?.type || ''), 'host/sse')) return
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${data}\n\n`)
  } catch { /* ignore */ }
}

function sendSsePing(res: ServerResponse): void {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
  } catch { /* ignore */ }
}

/** 把一个帧写给某个订阅桶；桶不存在/无客户端返回 false。（整帧只序列化一次，大 base64 帧对 N 连接重复 stringify 是纯浪费） */
function writeMuxTo(key: string, frame: MuxFrame): boolean {
  const clients = muxClients.get(key)
  if (!clients || clients.size === 0) return false
  const serverReq: ServerRequest = {
    type: 'server-request',
    rpcId: crypto.randomUUID(),
    payload: frame,
  }
  const payload = `data: ${JSON.stringify(serverReq)}\n\n`
  for (const res of clients) {
    try {
      /* ★0929 P1（刀7 背压）：写入口守卫——超软上限丢可恢复帧、超硬上限断开（原来无条件 write，
         慢窗口的大帧无界堆进 Node 写缓冲 = 拖垮整个后端内存） */
      if (!sseBackpressure(res, String(frame.type || ''), `mux key=${key || '(全局)'}`)) continue
      res.write(payload)
    } catch { /* ignore */ }
  }
  return true
}

function broadcastMux(sessionId: string, frame: MuxFrame): void {
  if (sessionId) {
    // 0911 帧按会话订阅：会话内帧（event/log/plan/projection）严格只发该会话的订阅者。
    // 旧行为是把每个会话帧同时灌进全局桶——全局客户端被迫收下所有会话的重帧（内容块/日志），
    // 既浪费又是"一个窗口被别家会话帧反复重渲染"的来源。
    const delivered = writeMuxTo(sessionId, frame)
    /* ★0926 链路修复①（通道）：**"有人需要你应答"是跨会话信号，必须走跨会话通道。**
       全局流本来就是干这个的（`session/status` 就在上面，专门让侧栏感知后台会话启停）。
       此前 hitl-request/question 只投会话桶 ⇒ 只有"正显示该会话的窗口"能收到，
       别的窗口/正在看别条会话的窗口**完全无感**（实测：新开窗口只看到"回复中"转圈，
       而 agent 其实在等授权 → 10 分钟超时 → 模型重试 → 烧 token 死循环）。
       配套：前端 attachAside 已按 requestId 去重，两条流各收一份不会出双卡。 */
    const isInteractive = frame.type === 'session/hitl-request' || frame.type === 'session/question'
    if (!delivered && isInteractive) {
      console.warn(`[mux] 交互帧无会话订阅者（订阅侧待查；已走全局通道投递）：type=${frame.type} session=${sessionId.slice(0, 8)}`)
    }
    // 轻量跨会话镜像：会话状态帧 + 交互帧（权限卡/询问卡）——
    // 状态帧：侧栏未读计数/回复态要感知**后台会话**启停；
    // 交互帧：用户必须看到（前端按帧内 sessionId 归属到对应会话）。
    if (frame.type === 'session/status' || isInteractive) writeMuxTo('', frame)
  } else {
    // 全局帧（浏览器动作/预览等）：本就跨会话，送全局桶。
    writeMuxTo('', frame)
  }
}

function broadcastHost(frame: HostFrame): void {
  const serverReq: ServerRequest = {
    type: 'server-request',
    rpcId: crypto.randomUUID(),
    payload: frame,
  }
  for (const res of hostClients) {
    sendSseFrame(res, serverReq)
  }
}

// ============================================================================
// Pi Agent event -> DSH session/event translation
// ============================================================================

/**
 * turn 累积器：一个 user prompt 对应的所有 assistant 轮次合并为一条消息
 * （对齐 dsh turn 模型——工具行与多段文本按时间顺序交错，不产生多条独立 AI 气泡）
 *  - sequence：定稿段落与工具组的顺序序列（段落 → 工具 → 段落 → ...）
 *  - text/reasoning：当前流式段落（实时增量，追加在序列末尾）
 */
interface TurnAccumulator {
  id: string
  text: string
  reasoning: string
  sequence: Array<
    { type: 'text'; text: string; reasoning: string }
    | { type: 'tool'; blocks: ContentBlock[] }
  >
  /** 上一次 text/thinking delta（模型流式末段可能重复推送相同增量，去重防累积） */
  lastTextDelta: string
  lastReasoningDelta: string
  /** 当轮模型 id（message_start 记录，收尾写入 DSH 消息） */
  model?: string
}

const turnAccumulators = new Map<string, TurnAccumulator>()
/** 会话"分身忙"计数已删除（★0930：即派即回后无消费者，见 cloneRuntime 注释） */

/** 思考强度 → 协议里的推理挡位。
 *  NIS 内部四挡 fast(Low) < deep(Mid) < heavy(High) < burning(Max)。
 *  · 前三挡一一对应 low/medium/high；
 *  · burning 是"最高"：**只有明确支持 `max` 的网关（智谱 z.ai / bigmodel）才发 max**，
 *    其余网关的最高档就是 high —— 所以 resolveModelEfforts 已不给它们这一挡了
 *    （以前两挡都发 high，属于"看起来能选、实际无差别"，用户 0920 反馈的就是这个）。
 *  base 由调用方传入（mapEffort 是纯函数，不读全局）。 */
function mapEffort(effort: string, base = ''): string | null {
  switch ((effort || '').trim()) {
    case 'fast': return 'low'
    case 'deep': return 'medium'
    case 'heavy': return 'high'
    case 'burning': return /bigmodel\.cn|api\.z\.ai/i.test(base) ? 'max' : 'high'
    default: return null
  }
}

/* ── 运行环境（0914 实装）：探测 + 安装任务（winget / playwright）────────────
 * · env.status：pwsh / node / git 以 --version 探测；chromium 查 Playwright 浏览器缓存；
 * · env.install：起后台任务（execFile），env.job 轮询状态；装了「安装目录」时先带
 *   --location（个别包不支持会自动回退到默认位置再试一次）；
 * · v1 粒度：进行中 / 完成 / 失败 + 末尾日志（不做百分比进度）。
 */
type EnvJobState = {
  id: string; envId: string; status: 'running' | 'queued' | 'done' | 'error'; log: string[]; error?: string
  startedAt: number; finishedAt?: number
  /** 0917 进度：百分比 0-100（-1=未知，前端画不确定态进度条） */
  percent: number
  /** 当前阶段文案（探索 Python → 建虚拟环境 → 装依赖 → 下模型 …） */
  phase: string
  /** 0918：#6 归一化阶段 —— prep=准备 / download=下载中 / install=安装中 / done=完成。
   *  由各安装器的里程碑输出行解析而来（真实信号，非估算），前端据此显示"下载中 / 安装中"。 */
  stage: 'prep' | 'download' | 'install' | 'done'
  /** 已下载字节 / 总量（仅能解析到时才有值） */
  bytes: number; totalBytes: number
  /** 网速（字节/秒）与剩余时间（秒） */
  speedBps: number; etaSec: number
  /** 内部：上次采样点，用于算网速 */
  _lastBytes: number; _lastAt: number
}
const envJobs = new Map<string, EnvJobState>()

function execCapture(bin: string, args: string[], opts: { timeout?: number; shell?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    // env：在父进程环境上叠加（0917——chromium 用 PLAYWRIGHT_BROWSERS_PATH 改缓存位置）
    const env = opts.env ? { ...process.env, ...opts.env } : process.env
    execFile(bin, args, { windowsHide: true, timeout: opts.timeout ?? 8000, maxBuffer: 8 * 1024 * 1024, shell: !!opts.shell, env }, (err: any, stdout: any, stderr: any) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({ code, out: String(stdout || ''), err: String(stderr || '') })
    })
  })
}

/* ── ★1010f：Agent Reach（技能 agent-reach 的可配置后端）────────────────────
 * 原则：不重写它的逻辑 —— 渠道清单**透传它自己的 `doctor --json`**；
 *      装/配全部经由技能目录里的 ar.cmd（wrapper 统一带 PATH / UTF-8 / 代理）。
 * 代理：设置里的 agentReachProxy 优先（wrapper 只在未定义时才落默认值）。
 * ponytail: 安装是同步等待（几十秒~几分钟）；要真进度条再接 envJobs 那套。 */
const AR_PLATFORM: Record<string, { domain: RegExp; key: string }> = {
  xiaohongshu: { domain: /(^|\.)xiaohongshu\.com$/, key: 'xhs-cookies' },
  twitter: { domain: /(^|\.)(x|twitter)\.com$/, key: 'twitter-cookies' },
  youtube: { domain: /(^|\.)(youtube|google)\.com$/, key: 'youtube-cookies' },
}
function arCmd(): string { return path.join(SKILLS_ROOT, 'agent-reach', 'ar.cmd') }
function arEnv(): Record<string, string> {
  const px = String((globalSettings as any).agentReachProxy || '').trim()
  return px ? { HTTP_PROXY: px, HTTPS_PROXY: px } : {}
}
/** doctor 要逐个探 16 个渠道（实测 20~60 秒）⇒ 结果缓存 60 秒：第二次打开弹窗秒开。
 *  ponytail: 单份内存缓存 + TTL，不做失效逻辑；要"每次必新"就传 fresh=true。 */
let arChannelsCache: { at: number; data: any } | null = null
async function arChannels(maxAgeMs = 60000): Promise<any> {
  if (maxAgeMs > 0 && arChannelsCache && Date.now() - arChannelsCache.at < maxAgeMs) {
    return { ...arChannelsCache.data, cached: true, ageSec: Math.round((Date.now() - arChannelsCache.at) / 1000) }
  }
  const r = await execCapture('cmd', ['/c', arCmd(), 'agent-reach', 'doctor', '--json'], { timeout: 120000, env: arEnv() })
  const s = String(r.out || '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return { ok: false, error: (r.err || s || '无输出').slice(0, 300) }
  try {
    const data = { ok: true, channels: JSON.parse(s.slice(a, b + 1)) }
    arChannelsCache = { at: Date.now(), data }
    return { ...data, cached: false, ageSec: 0 }
  } catch (e: any) { return { ok: false, error: 'JSON 解析失败：' + String(e?.message || e) } }
}
/** 把内置浏览器里某平台的 Cookie 交给 agent-reach（实测它 --stdin 吃 "k=v; k=v" 串） */
async function arImportCookies(platform: string, sessionKey?: string): Promise<any> {
  const spec = AR_PLATFORM[platform]
  if (!spec) return { ok: false, error: `不支持的平台：${platform}（目前支持 ${Object.keys(AR_PLATFORM).join(' / ')}）` }
  let all: any[] = []
  try { all = await browserEngine.getBrowserInstance(sessionKey).cookiesList() } catch { /* 实例没起 */ }
  const hit = (all || []).filter((c: any) => spec.domain.test(String(c.domain || '').replace(/^\./, '')))
  if (!hit.length) return { ok: false, error: `内置浏览器里没有 ${platform} 的 Cookie —— 先在浏览器面板里打开并登录该网站，再点一次。` }
  const header = hit.map((c: any) => `${c.name}=${c.value}`).join('; ')
  const tmp = path.join(DATA_ROOT, `.ar-cookie-${platform}.tmp`)
  fs.writeFileSync(tmp, header, 'utf8')
  const r = await execCapture('cmd', ['/c', `${arCmd()} agent-reach configure ${spec.key} --stdin < "${tmp}"`], { timeout: 60000, env: arEnv() })
  try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  const ok = r.code === 0 && !/Traceback|error:/i.test(r.out + r.err)
  return { ok, cookies: hit.length, out: String(r.out || r.err || '').slice(0, 400) }
}

/* ── ★1010h：安装改成"后端任务 + 前端轮询"──────────────────────────────────
 * 为什么：原先 arInstall 是前端一个 Promise —— 关掉弹窗/关掉技能面板，组件一卸载
 * 状态就没了（实测："变成处理中 → 关掉再回来 → 又变回安装"），也没有进度感。
 * 现在：任务跑在后端，状态存 arJobs；前端轮询 agentReach.jobs（秒回），
 * 关掉再打开也能看到"处理中 + 输出尾部"。ponytail: 只留最近 5 个 + 尾部 4KB。 */
type ArJob = { channel: string; out: string; running: boolean; code: number | null } & EnvJobState
const arJobs = new Map<string, ArJob>()
function arInstallStart(channel: string): any {
  const jobId = `ar-${channel}-${Date.now().toString(36)}`
  const job: ArJob = {
    channel, out: '', running: true, code: null,
    startedAt: Date.now(), percent: -1, phase: '准备', stage: 'prep',
    bytes: 0, totalBytes: 0, speedBps: 0, etaSec: 0, _lastBytes: 0, _lastAt: Date.now(),
  }
  arJobs.set(jobId, job)
  while (arJobs.size > 5) { const k = arJobs.keys().next().value as string; arJobs.delete(k) }
  void execStream('cmd', ['/c', arCmd(), 'agent-reach', 'install', '--env=auto', '--system', `--channels=${channel}`], {
    env: arEnv(),
    timeoutMs: 900000,
    onLine: (line: string) => {
      const t = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()   // ★1010k：剥全部 ANSI（原来只剥小写 m，残留 ESC[M 的 "M" 会被 cmd 当命令跑）
      if (!t) return
      job.out = (job.out + t + '\n').slice(-4000)
      /* ★1010i：复用装环境那套解析器 —— 阶段（下载中/安装中）+ pip/tqdm 的**真实**百分比与字节
         （拿不到真数据时 percent 保持 -1，前端画不确定态；不编数字） */
      envStageFromLine(job, t)
      applyJobProgress(job, t)
    },
  }).then((r) => {
    job.running = false
    job.code = r.code
    job.stage = 'done'
    if (r.code === 0) job.percent = 100
    arChannelsCache = null   // 装完了 ⇒ 渠道状态缓存作废，下次读就是新的
  })
  return { ok: true, jobId }
}
function arJobsSnapshot(): any[] {
  return [...arJobs.entries()].map(([jobId, j]) => ({
    jobId, channel: j.channel, running: j.running, code: j.code, startedAt: j.startedAt,
    secs: Math.round((Date.now() - j.startedAt) / 1000),
    percent: j.percent, stage: j.stage, phase: j.phase,
    bytes: j.bytes, totalBytes: j.totalBytes, speedBps: j.speedBps, etaSec: j.etaSec,
    tail: j.out.slice(-1200),
  }))
}

/* ── 流式执行（0917）：安装类命令要「边跑边报进度」─────────────
 * 旧实现用 execFile 回调，只能拿到全部结束后的输出 → 前端永远只显示「安装中…」。
 * 这里改用 spawn 逐块读，按 \n / \r 切行（winget 与 pip/tqdm 的进度都用 \r 原地刷新），
 * 每行交给 progress 解析器提取百分比 / 字节 / 网速。
 */
function execStream(
  bin: string,
  args: string[],
  opts: { shell?: boolean; env?: Record<string, string>; onLine?: (line: string) => void; timeoutMs?: number },
  cwd?: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env
    let out = ''
    let err = ''
    let done = false
    let tail = ''
    let child: any
    const finish = (code: number | null) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { child?.kill() } catch { /* ignore */ }
      resolve({ code, out, err })
    }
    const timer = opts.timeoutMs ? setTimeout(() => finish(-1), opts.timeoutMs) : null
    try {
      child = spawn(bin, args, { windowsHide: true, shell: !!opts.shell, env, cwd })
    } catch { finish(-1); return }
    child.on('error', () => finish(-1))
    const feed = (chunk: string) => {
      tail += chunk
      // winget / pip / tqdm 都是 \r 原地刷进度，这里两种都当行分隔
      const parts = tail.split(/\r\n|\n|\r/)
      tail = parts.pop() ?? ''
      for (const p of parts) {
        const line = p.replace(/\s+$/, '')
        if (line && opts.onLine) opts.onLine(line)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { out += c; if (out.length > 200000) out = out.slice(-200000); feed(c) })
    child.stderr?.on('data', (c: string) => { err += c; if (err.length > 200000) err = err.slice(-200000); feed(c) })
    child.on('close', (code: number | null) => {
      if (tail.trim() && opts.onLine) opts.onLine(tail.trim())
      finish(code)
    })
  })
}

/** 从一行输出里提取进度（winget / pip / tqdm 三种格式都兼容） */
const UNIT_MUL: Record<string, number> = { b: 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }
function parseSize(num: string, unit?: string): number {
  const u = (unit || 'b').toLowerCase().charAt(0)
  return parseFloat(num) * (UNIT_MUL[u] || 1)
}
function applyJobProgress(job: EnvJobState, line: string): void {
  // ① 字节对： 12.3M/27.4M  （含可选 i/-i，如 MiB）
  const pair = /([\d.]+)\s*([kKmMgG])?i?[Bb]\s*\/\s*([\d.]+)\s*([kKmMgG])?i?[Bb]/.exec(line)
  if (pair) {
    const bytes = parseSize(pair[1], pair[2])
    const total = parseSize(pair[3], pair[4])
    if (total > 0 && bytes >= 0) {
      job.bytes = bytes
      job.totalBytes = total
      job.percent = Math.max(0, Math.min(100, Math.round((bytes / total) * 100)))
    }
  }
  // ② 显式百分比： 45%|███  或  ███ 45%
  const pct = /(\d{1,3})\s*%/.exec(line)
  if (pct) {
    const v = parseInt(pct[1], 10)
    if (v >= 0 && v <= 100) job.percent = v
  }
  // ③ 网速： 2.1MB/s
  const sp = /([\d.]+)\s*([kKmMgG])?i?[Bb]\/s/.exec(line)
  if (sp) {
    const bps = parseSize(sp[1], sp[2])
    if (bps > 0) job.speedBps = bps
  }
  // ④ 无显式网速时用字节增量估算
  const now = Date.now()
  if (!sp && job.bytes > 0 && job._lastAt && now - job._lastAt > 400) {
    const dt = (now - job._lastAt) / 1000
    const db = job.bytes - job._lastBytes
    if (db >= 0) {
      const inst = db / dt
      // 指数平滑，避免进度条旁边的网速乱跳
      job.speedBps = job.speedBps > 0 ? job.speedBps * 0.7 + inst * 0.3 : inst
    }
    job._lastBytes = job.bytes
    job._lastAt = now
  } else if (!job._lastAt) {
    job._lastBytes = job.bytes
    job._lastAt = now
  }
  if (job.totalBytes > 0 && job.speedBps > 0) {
    const rest = Math.max(0, job.totalBytes - job.bytes)
    job.etaSec = Math.round(rest / job.speedBps)
  }
}

/** 环境项元数据（0917 引导页「环境检测」用）——
 *  mustC：是否「非 C 盘不可」。判据 = winget manifest 是否声明 InstallerSwitches.InstallLocation（未声明则 --location 不生效）：
 *    · Git.Git              inno → 仅声明 Silent/SilentWithProgress  → 非 C 盘不可
 *    · Microsoft.PowerShell msix → 无 InstallLocation，位置由系统托管 → 非 C 盘不可
 *    · OpenJS.NodeJS.LTS    wix  → 声明 INSTALLDIR="<INSTALLPATH>"   → 可自定义
 *    · Python.Python.3.13   burn → 声明 DefaultAllUsersTargetDir     → 可自定义（需 --scope machine）
 *    · chromium（非 winget，走 npx playwright install）→ 用 PLAYWRIGHT_BROWSERS_PATH 重定向
 *  sizeBytes：安装后占用估算（引导页「大小」列显示为「约 X MB」）。 */
const ENV_META: Record<string, { mustC: boolean; sizeBytes: number; pkgId: string }> = {
  pwsh: { mustC: true, sizeBytes: 320 * 1024 * 1024, pkgId: 'Microsoft.PowerShell' },
  git: { mustC: true, sizeBytes: 360 * 1024 * 1024, pkgId: 'Git.Git' },
  node: { mustC: false, sizeBytes: 96 * 1024 * 1024, pkgId: 'OpenJS.NodeJS.LTS' },
  python: { mustC: false, sizeBytes: 130 * 1024 * 1024, pkgId: 'Python.Python.3.13' },
  /** 0930 新增：npm 包管理器 —— 本机 toolchain 只带 node.exe 不带 npm，MCP 本地包安装（npm install
   *  装依赖）此前无 npm 可用。不走 winget（OpenJS.NodeJS.LTS 会再装一个 node），直接下官方 tgz
   *  解到 <envDir>/npm，统一用「应用自带 node + npm-cli.js」跑，零 PATH 依赖。版本在 runNpmInstall 里钉。 */
  npm: { mustC: false, sizeBytes: 30 * 1024 * 1024, pkgId: '' },
  /** ★1010-D 新增：Git Bash（已定案 A 轻量路线）——**PortableGit** 绿色自解压包（含 usr/bin/bash.exe；
   *  ⚠️ MinGit 标准包不含 bash，别改回去）解到 <envDir>/gitbash，不装系统、不要管理员、卸载=删文件夹。
   *  给「命令终端」的 Git Bash 选项和自动选择的 bash 分支供货；未装时下拉置灰、自动选择绝不调 bash
   *  （与 pwsh 同款「装了才能用」）。 */
  gitbash: { mustC: false, sizeBytes: 400 * 1024 * 1024, pkgId: '' },
  chromium: { mustC: false, sizeBytes: 460 * 1024 * 1024, pkgId: '' },
  /** 0917 新增：记忆检索模型 —— Python + sentence-transformers + **BAAI/bge-small-zh-v1.5**。
   *  ⚠️ 0918 修正：这里以前写 all-MiniLM-L6-v2，但 python 内核实际加载的是 bge-small-zh-v1.5
   *  （`memory-kernel/memory_bridge.py`，且 `core/memory/upsert.py` 的语义阈值是按它调过的）——
   *  装 A 却用 B，装完仍会现场去下 B 或直接降级 FTS。必须与内核保持一致。
   *  走自建 venv（envDir/memory-venv），不走 winget。装完记忆/知识库的「语义检索」才可用；
   *  没装则记忆桥降级 FTS（只能用关键词命中）。 */
  embed: { mustC: false, sizeBytes: 1200 * 1024 * 1024, pkgId: '' },
}
const ENV_IDS = Object.keys(ENV_META)

/* ── 可执行文件定位（0917 重做）────────────────────────────────
 * 事故背景：旧实现直接 spawn 裸名（python / node / git / winget）走 PATH。
 * 而 NIS.exe 拉起后端时注入的进程环境里，PATH **不含** 用户装的任何工具
 * （实测本机 python/py/git/pwsh 全部 ENOENT），于是：
 *   · 环境页把「应用自带的 node」也判成未安装；
 *   · 安装走裸 winget → ENOENT → 前端只看到 exit -1。
 * 另一坑：%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe 是 AppExecLink 重解析点，
 *   node 的 fs.existsSync() 对它返回 **false**（但直接 spawn 绝对路径能正常跑）。
 *   → 所以「存在性」必须用 lstatSync（链接也算存在），并且**实际试跑一次**才算可用。
 * ─────────────────────────────────────────────────────────── */
function pathPresent(p: string): boolean {
  try { fs.lstatSync(p); return true } catch { return false }
}

/** 试跑一次，成功返回输出版本行（末行），失败返回空串 */
async function probeVersion(bin: string, args: string[]): Promise<string> {
  const r = await execCapture(bin, args, { timeout: 15000 })
  if (r.code !== 0) return ''
  const lines = (r.out + '\n' + r.err).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return (lines.pop() || '').slice(0, 60)
}

/** 环境安装目录（用户可在设置里改；缺省落到用户目录下的 NISEnv） */
function envInstallDir(): string {
  const d = String((globalSettings as any).envDir || '').trim()
  if (d) return d
  /**
   * 0918：默认从 `%USERPROFILE%\NISEnv` 改成 **`<数据根>/env`**。
   * 原因：以前两个实例（源码 dev / 打包版）算出来是**同一个目录** → 共用同一个 venv：
   *   在一边装「记忆检索模型」另一边跟着变、在一边卸载会把另一边也搞坏；且 venv 里记的是绝对路径，
   *   跨实例复用本身就脆。现在「**数据在哪，环境就在哪**」：
   *   dev = `backend/data/env`，打包版 = 它自己数据根下的 `env`，天然分开、互不影响。
   *   （<数据根> 来自 paths.ts 的 NIS_DATA_DIR。记忆/知识库 0919 起另有自己的目录 ——
   *    打包版固定 %APPDATA%\nis\memory，所以不再必然同根。）
   * 注意：记忆桥的候选表里仍保留老路径 `%USERPROFILE%\NISEnv\memory-venv` 作为兜底，
   *   所以以前装过的人不会一夜之间失效。
   */
  return path.join(DATA_ROOT, 'env')
}

/** 记忆检索模型的 venv（#11）——放在环境安装目录下，删环境项即删它 */
function memoryVenvDir(): string {
  return path.join(envInstallDir(), 'memory-venv')
}

/**
 * 0918：把「这套实例实际在用的路径」一次吐出来（双版本排查/确认隔离状态用）。
 * 双实例跑起来后对比一下就知道有没有串：envDir / memoryVenv / memoryData 应该各不相同。
 */
function envPaths(): Record<string, string> {
  return {
    dataRoot: DATA_ROOT,
    storagePath: storageRootNow(),
    envDir: envInstallDir(),
    memoryVenv: memoryVenvDir(),
    memoryData: currentMemoryDir(),
    knowledgeAttachments: ATTACHMENT_ROOT,
    kernel: BRIDGE_SCRIPT,
    kernelSource: USING_BUNDLED_KERNEL ? 'bundled（随应用自带）' : 'legacy（网页版老脚本）',
  }
}
function memoryVenvPython(): string {
  return path.join(memoryVenvDir(), 'Scripts', 'python.exe')
}
/** 安装成功标记：比每次探测 import sentence_transformers（要 3~8s）快得多且更可靠 */
function memoryVenvMarker(): string {
  return path.join(memoryVenvDir(), '.nis-embed-ok')
}

/** 各环境项的候选可执行文件（按优先级）——绝对路径优先，裸名垫底 */
function envBinCandidates(id: string): Array<{ bin: string; args: string[] }> {
  const lp = process.env.LOCALAPPDATA || ''
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const packDir = path.dirname(process.execPath)
  const dir = envInstallDir()
  switch (id) {
    case 'node':
      return [
        { bin: process.execPath, args: ['-v'] },
        { bin: path.join(packDir, 'node.exe'), args: ['-v'] },
        { bin: path.join(dir, 'node.exe'), args: ['-v'] },
        { bin: path.join(pf, 'nodejs', 'node.exe'), args: ['-v'] },
        { bin: 'node', args: ['-v'] },
      ]
    case 'python':
      return [
        { bin: memoryVenvPython(), args: ['--version'] },
        { bin: path.join(dir, 'python.exe'), args: ['--version'] },
        { bin: path.join(dir, 'python', 'python.exe'), args: ['--version'] },
        { bin: path.join(lp, 'Programs', 'Python', 'Python313', 'python.exe'), args: ['--version'] },
        { bin: path.join(lp, 'Programs', 'Python', 'Python312', 'python.exe'), args: ['--version'] },
        { bin: path.join(pf, 'Python313', 'python.exe'), args: ['--version'] },
        { bin: path.join(pf, 'Python312', 'python.exe'), args: ['--version'] },
        { bin: 'C:\\Python313\\python.exe', args: ['--version'] },
        { bin: 'python', args: ['--version'] },
        { bin: 'py', args: ['-3', '--version'] },
      ]
    case 'git':
      return [
        { bin: path.join(pf, 'Git', 'cmd', 'git.exe'), args: ['--version'] },
        { bin: path.join(pf86, 'Git', 'cmd', 'git.exe'), args: ['--version'] },
        { bin: path.join(lp, 'Programs', 'Git', 'cmd', 'git.exe'), args: ['--version'] },
        { bin: 'git', args: ['--version'] },
      ]
    case 'gitbash':   // ★1010-D：Git Bash = NIS 自装 MinGit 优先 → 系统 Git for Windows
      return [
        { bin: path.join(dir, 'gitbash', 'usr', 'bin', 'bash.exe'), args: ['--version'] },
        { bin: path.join(dir, 'gitbash', 'bin', 'bash.exe'), args: ['--version'] },
        { bin: path.join(pf, 'Git', 'bin', 'bash.exe'), args: ['--version'] },
        { bin: path.join(pf86, 'Git', 'bin', 'bash.exe'), args: ['--version'] },
      ]
    case 'npm':
      return [
        { bin: process.execPath, args: [path.join(dir, 'npm', 'bin', 'npm-cli.js'), '--version'] },
        { bin: process.execPath, args: [path.join(pf, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version'] },
        { bin: path.join(pf, 'nodejs', 'node.exe'), args: [path.join(pf, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version'] },
      ]
    case 'pwsh':
      return [
        { bin: path.join(pf, 'PowerShell', '7', 'pwsh.exe'), args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
        { bin: path.join(lp, 'Microsoft', 'WindowsApps', 'pwsh.exe'), args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
        { bin: 'pwsh', args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
      ]
    default:
      return []
  }
}

/** winget 定位（0917 修）：候选绝对路径 + **逐个试跑**，都不行才报明确错误。
 *  注意 WindowsApps 下的 winget.exe 是 AppExecLink，existsSync 为 false 但可执行。 */
const WINGET_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps', 'winget.exe'),
]
let _wingetBin: string | null = null
let _wingetChecked = false
async function resolveWingetAsync(): Promise<string> {
  if (_wingetChecked) return _wingetBin || ''
  _wingetChecked = true
  const cands = [...WINGET_CANDIDATES]
  // WindowsApps 里带版本号的真实目录也纳进来（AppExecLink 偶尔不可用时的兜底）
  try {
    const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')
    for (const n of fs.readdirSync(root)) {
      if (n.startsWith('Microsoft.DesktopAppInstaller_') && n.includes('_x64__')) {
        cands.push(path.join(root, n, 'winget.exe'))
      }
    }
  } catch { /* ignore */ }
  for (const c of cands) {
    if (!c) continue
    if (!pathPresent(c)) continue
    const v = await probeVersion(c, ['--version'])
    if (v) { _wingetBin = c; return c }
  }
  _wingetBin = null
  return ''
}

/** 0917：Playwright 浏览器缓存的落点 —— 与「环境安装目录（envDir）」保持一致。
 *  此前安装时重定向到 envDir、卸载/探测却只看 process.env/%LOCALAPPDATA% → 装完仍显示「未安装」。 */
function chromiumCacheDir(): string {
  /* ★ 0921d（用户 0.0.19 批）：与 envInstallDir() **同源** —— 让「安装 / 探测 / 启动 / 卸载四方对齐」。
     原实现读裸 `globalSettings.envDir`（空则回落 process.env → %LOCALAPPDATA%\ms-playwright），
     而启动链（server 启动期 + browserEngine.resolveChromiumExe）用的是 envInstallDir()。
     实测事故（0921）：设置里 envDir 显式指向 `…\Documents\NisData\env`（那里只有 voice），
     内核却在 `<数据根>\env` ⇒ 状态显示「未安装」、点启动照样去找空目录 ⇒ 起不来。 */
  return envInstallDir()
}

/** 该目录下是否已有 chromium 内核 */
function chromiumPresent(dir: string): boolean {
  try {
    return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.startsWith('chromium'))
  } catch { return false }
}

/* ── 0921d：「来源」判定（设计口径 —— 机器上本来就有也要扫到、标明来源，但不能卸载）────────
 *  · env.install 成功时在**环境安装目录**记一笔 `<envDir>/.nis-env-installed.json`；
 *  · env.status 据此给每项标 source：
 *      bundled = 应用自带的运行时（pack/node.exe 那一份）→ 永不可卸；
 *      nis     = **NIS 装的**（有标记）→ 可卸；
 *      system  = 机器上本来就有（无标记且非自带）→ 只展示、**不给卸**（免得卸掉用户自己的东西）。
 *  历史遗留：0.0.19 之前由 NIS 装过的项没有任何标记 ⇒ 一律按 system 处理（保守，宁可不给卸）。
 * ─────────────────────────────────────────────────────────────── */
type EnvSource = 'bundled' | 'nis' | 'system'
const ENV_INSTALL_MARK_FILE = '.nis-env-installed.json'
function envInstallMarkPath(): string {
  return path.join(envInstallDir(), ENV_INSTALL_MARK_FILE)
}
function readEnvInstallMarks(): Record<string, { at?: string; via?: string }> {
  try {
    const j = JSON.parse(fs.readFileSync(envInstallMarkPath(), 'utf8'))
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j as Record<string, { at?: string; via?: string }> : {}
  } catch { return {} }
}
/** 记一笔「这项是 NIS 装的」（env.install 成功后调用） */
function markEnvInstalled(id: string, via: string): void {
  try {
    const all = readEnvInstallMarks()
    all[id] = { at: new Date().toISOString(), via }
    fs.mkdirSync(envInstallDir(), { recursive: true })
    atomicWriteFileSync(envInstallMarkPath(), JSON.stringify(all, null, 2))
  } catch (e) { console.error('[env] 写安装标记失败:', e) }
}
/** 卸掉后抹掉标记（免得「已卸载」还留着可卸状态） */
function unmarkEnvInstalled(id: string): void {
  try {
    const all = readEnvInstallMarks()
    if (!(id in all)) return
    delete all[id]
    atomicWriteFileSync(envInstallMarkPath(), JSON.stringify(all, null, 2))
  } catch (e) { console.error('[env] 清安装标记失败:', e) }
}

/** 路径归一（比较用）：斜杠统一 + 去尾斜杠 + 小写 */
const normPath = (p: string): string => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** 0921d：环境项状态（在原有字段上新增 source / removable / location —— 前端据此显示来源与卸载入口） */
type EnvStatusItem = {
  installed: boolean
  version: string
  mustC: boolean
  sizeBytes: number
  bundled?: boolean
  note?: string
  /** 来源：bundled=应用自带 / nis=NIS 装的 / system=机器上本来就有 */
  source: EnvSource
  /** 是否可以卸载（**只有 nis 来源为 true**；bundled / system 一律 false） */
  removable: boolean
  /** 命中的实际位置（排查用；前端可选展示） */
  location?: string
}

async function envStatus(): Promise<Record<string, EnvStatusItem>> {
  const res: Record<string, EnvStatusItem> = {}
  const marks = readEnvInstallMarks()
  for (const id of ['pwsh', 'node', 'git', 'python', 'npm', 'gitbash']) {
    let version = ''
    let bundled = false
    let hit = ''
    for (const c of envBinCandidates(id)) {
      const v = await probeVersion(c.bin, c.args)
      if (v) {
        version = v
        hit = c.bin
        // 判定「应用自带」：就是 NIS 自己的运行时（pack/node.exe 等），无需用户再装
        bundled = id !== 'npm' && (path.resolve(c.bin) === path.resolve(process.execPath)
          || path.resolve(c.bin) === path.resolve(path.join(path.dirname(process.execPath), 'node.exe')))
        break
      }
    }
    /* 0921d：来源判定（bundled 优先）——
     *  · 命中 envInstallDir() 内的可执行文件 = 本实例自管环境（如记忆检索 venv 里的 python）→ nis；
     *  · 其余无「NIS 装过」标记的 → system（只展示、不给卸，免得卸掉用户自己的东西）。
     *  ⚠️ 可卸条件比 source 更保守：**必须记过账（marks）才给卸** ——
     *     否则"venv 里的 python"会被当成可卸项，一卸就把语义检索环境毁了。 */
    const inEnvDir = !!hit && (normPath(hit) === normPath(envInstallDir()) || normPath(hit).startsWith(normPath(envInstallDir()) + '\\'))
    const source: EnvSource = bundled ? 'bundled' : (marks[id] || inEnvDir) ? 'nis' : 'system'
    res[id] = {
      installed: !!version,
      version,
      mustC: !!ENV_META[id]?.mustC,
      sizeBytes: ENV_META[id]?.sizeBytes || 0,
      bundled,
      source,
      removable: !!version && !!marks[id],
      location: hit,
      note: !version ? ''
        : source === 'bundled' ? '应用自带'
          : marks[id] ? ''
            : inEnvDir ? '来自 NIS 环境目录（本实例自管，不提供卸载）'
              : '系统已装（非 NIS 安装）',
    }
  }
  /* chromium：**权威目录（环境安装目录）优先**；其次 playwright 默认缓存
     （= 别的软件或用户自己装的 → source=system，只展示、禁止卸载，别删别人的内核） */
  const authoritativeDir = chromiumCacheDir()
  const hasAuth = chromiumPresent(authoritativeDir)
  const fallbackDir = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  const hasFallback = !hasAuth && chromiumPresent(fallbackDir)
  res.chromium = {
    installed: hasAuth || hasFallback,
    version: '',
    mustC: !!ENV_META.chromium.mustC,
    sizeBytes: ENV_META.chromium.sizeBytes,
    source: hasAuth ? 'nis' : 'system',
    removable: hasAuth,
    location: hasAuth ? authoritativeDir : (hasFallback ? fallbackDir : authoritativeDir),
    note: hasFallback ? '检测到系统里已有的 Chromium 内核（非 NIS 安装，不予卸载）' : '',
  }
  // 记忆检索模型（#11）：标记文件 + venv 双条件（标记在 = 上次装成功过）
  const mpy = memoryVenvPython()
  const embedOk = pathPresent(memoryVenvMarker()) && pathPresent(mpy)
  res.embed = {
    installed: embedOk,
    version: embedOk ? 'sentence-transformers · BAAI/bge-small-zh-v1.5' : '',
    mustC: !!ENV_META.embed.mustC,
    sizeBytes: ENV_META.embed.sizeBytes,
    source: 'nis',                       // 这套 venv 只可能是 NIS 自己建（外界不会往这儿塞）
    removable: embedOk,
    location: memoryVenvDir(),
    note: embedOk ? '' : '未装时记忆检索降级为关键词匹配（FTS）',
  }
  return res
}

function newEnvJob(envId: string): EnvJobState {
  const job: EnvJobState = {
    id: 'envjob_' + Date.now().toString(36), envId, status: 'running', log: [], startedAt: Date.now(),
    percent: -1, phase: '', stage: 'prep', bytes: 0, totalBytes: 0, speedBps: 0, etaSec: 0, _lastBytes: 0, _lastAt: 0,
  }
  envJobs.set(job.id, job)
  return job
}

/** 进度条本身的行（如 `45%|████  | 12M/27M`）不进日志，免得刷屏 */
function isProgressLine(s: string): boolean {
  if (/[\u2588\u2591\u2592\u2593]/.test(s)) return true
  if (/%\|/.test(s) || /\|\s*\d{1,3}\s*%/.test(s)) return true
  if (/^\s*\d{1,3}\s*%/.test(s)) return true
  return false
}

/* ── 0918（#6 真进度条）：把安装器输出归一成「阶段」──────────────────────
 *  实测结论（本机 winget 1.29.290，三轮探针）：
 *   · winget 的 stdout 一旦被管道捕获就**不再输出进度条**（TTY 检测），
 *     而且安装包走 DeliveryOptimization 下载 → 拿不到百分比；
 *   · 但里程碑行是稳定输出的（"正在下载 …" / "已成功验证安装程序哈希" / …）
 *     → **阶段（下载中 / 安装中）可以做到 100% 准确**；
 *   · pip / playwright 是 tqdm 风格输出 → 百分比与字节对走 applyJobProgress（真实数据）。
 *  所以这里不编造百分比：能拿真数据的走真数据，拿不到的只标阶段。 */
function envStageFromLine(job: EnvJobState, line: string): void {
  let next: EnvJobState['stage'] | '' = ''
  // 下载阶段：winget 的「正在下载 <url>」、pip 的 Collecting/Downloading、playwright 的 Downloading …
  // 注意：winget 的「已下载安装程序: …」出现在「已成功验证安装程序哈希」之后 → 属于安装阶段，不能算下载
  if (/正在下载|^\s*(Collecting|Downloading|Using cached)\b|^\s*Downloading\s+\S|正在获取|正在提取|^\s*Getting\s/i.test(line)) {
    next = 'download'
  } else if (/已成功验证安装程序哈希|哈希已验证|Starting package install|正在安装|正在启动程序包安装|Installing collected packages|Installing dependencies|Building wheel|Successfully built|Installer hash verified|正在运行安装程序/i.test(line)) {
    next = 'install'
  }
  if (!next || next === job.stage) return
  job.stage = next
  // 阶段切换即重置下载计量：进入安装阶段后不再显示"已下载 X MB"（那是下载阶段的数）
  if (next === 'install') { job.bytes = 0; job.totalBytes = 0; job.percent = -1 }
  // 只在没有更具体文案时兜底（详情文案由调用方 opts.phase 给出，别覆盖掉）
  if (job.phase === '') job.phase = next === 'download' ? '下载中' : '安装中'
}

/** winget 详细日志目录（DiagOutputDir，winget 默认就会写） */
function wingetLogDir(): string {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'DiagOutputDir')
  try { return fs.statSync(p).isDirectory() ? p : '' } catch { return '' }
}

/** winget「已下载字节」尽力而为探测：
 *  winget 不报百分比，但 `--verbose-logs` 的详细日志里会打印
 *  `Downloading to path: <落盘文件>`，据此轮询该文件大小 = 已下载字节。
 *  DO 缓存场景下可能观察不到增长 → 那就不显示数字，**绝不编造百分比**。
 *  返回停止函数（job 结束务必调用）。 */
function startWingetByteWatch(job: EnvJobState): () => void {
  const dir = wingetLogDir()
  if (!dir) return () => { /* 无日志目录：没有可读的进度 */ }
  const baseline = new Map<string, number>()
  try {
    for (const f of fs.readdirSync(dir)) { try { baseline.set(f, fs.statSync(path.join(dir, f)).size) } catch { /* ignore */ } }
  } catch { /* ignore */ }
  let watchFile = ''
  let off = 0
  let target = ''
  let everSaw = false
  const timer = setInterval(() => {
    if (!target) {
      let newest = ''
      let ms = 0
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.log$/i.test(f)) continue
          const st = fs.statSync(path.join(dir, f))
          if (st.mtimeMs > ms) { ms = st.mtimeMs; newest = f }
        }
      } catch { /* ignore */ }
      if (!newest) return
      const full = path.join(dir, newest)
      if (newest !== watchFile) { watchFile = newest; off = baseline.get(newest) ?? 0 }
      try {
        const size = fs.statSync(full).size
        if (size <= off) return
        const fd = fs.openSync(full, 'r')
        const buf = Buffer.alloc(size - off)
        fs.readSync(fd, buf, 0, buf.length, off)
        fs.closeSync(fd)
        off = size
        const m = /Downloading to path:\s*(.+?)\s*$/m.exec(buf.toString('utf8'))
        if (m) target = m[1].trim()
      } catch { /* ignore */ }
      return
    }
    try {
      const sz = fs.statSync(target).size
      if (sz > 0) {
        everSaw = true
        if (sz !== job.bytes) job.bytes = sz
      }
    } catch { /* 文件已被移走（下载完成/moved）→ 保留最后一次读数 */ }
    // 总大小未知：给个 -1 让前端知道"只有已下载、没有总量"（不要显示假百分比）
    if (everSaw && job.totalBytes <= 0) job.percent = -1
  }, 500)
  timer.unref?.()
  return () => { clearInterval(timer) }
}

/** 跑一条命令：边跑边喂日志 + 提取进度（0917 新增流式，替换原来的 execCapture 整段等待） */
async function runEnvStep(
  job: EnvJobState,
  bin: string,
  args: string[],
  opts: { shell?: boolean; env?: Record<string, string>; phase?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null }> {
  if (opts.phase) job.phase = opts.phase
  job.log.push('$ ' + bin + ' ' + args.join(' '))
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200)
  const r = await execStream(bin, args, {
    shell: opts.shell,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    onLine: (line) => {
      const t = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()   // ★1010k：剥全部 ANSI（原来只剥小写 m，残留 ESC[M 的 "M" 会被 cmd 当命令跑）
      if (!t) return
      envStageFromLine(job, t)
      applyJobProgress(job, t)
      if (!isProgressLine(t)) {
        job.log.push(t.slice(0, 300))
        if (job.log.length > 200) job.log.splice(0, job.log.length - 200)
      }
    },
  })
  if (r.code !== 0) job.log.push('exit ' + r.code)
  return { code: r.code }
}

/* ── 0925：安装排队（需求的功能）────────────────────────────────────────────
 * 旧行为：有安装任务进行中时再点安装 → 直接报错"已有安装任务进行中（xxx）"（实测）。
 * 新行为：**入队即建 job**（status='queued'，phase 显示"排队中（第 N 位）"），
 * 前一个到终态（done/error）后 pumpEnvQueue 自动启动下一个 —— 用户只管点，排队自动消化。 */
const envQueue: string[] = []   // jobId 队列（FIFO）
/* 0927 netfix F8: self-healing watchdog -- several terminal branches forgot pumpEnvQueue(),
   which stalled the whole install queue forever. Sweep every 30s: queued jobs + nothing running
   => pump. Catches every missed branch instead of patching them one by one. */
setInterval(() => {
  try {
    if (envQueue.length && ![...envJobs.values()].some((j) => j.status === 'running')) pumpEnvQueue()
  } catch { /* ignore */ }
}, 30_000)
function pumpEnvQueue(): void {
  if (!envQueue.length) return
  const running = [...envJobs.values()].find((j) => j.status === 'running')
  if (running) return
  // 队首可能已被删/异常 → 跳过看下一个
  while (envQueue.length) {
    const job = envJobs.get(envQueue.shift()!)
    if (job && job.status === 'queued') {
      job.status = 'running'
      job.phase = '准备中'
      void (job.envId === 'embed' ? runEmbedInstall(job) : job.envId === 'gitbash' ? runGitBashInstall(job) : runStandardInstall(job))
      return
    }
  }
}

function envInstallStart(envId: string): { ok: boolean; jobId?: string; error?: string; queued?: boolean; queuePos?: number } {
  if (!ENV_IDS.includes(envId)) return { ok: false, error: '未知环境项' }
  const busy = [...envJobs.values()].find((j) => j.status === 'running' || j.status === 'queued')
  if (busy) {
    // 0925：排队而非报错 —— 建 queued job（前端轮询它可见"排队中"），前一个完成自动接上
    const job = newEnvJob(envId)
    job.status = 'queued'
    job.phase = `排队中（第 ${envQueue.length + 1} 位）`
    job.stage = 'prep'
    envQueue.push(job.id)
    return { ok: true, jobId: job.id, queued: true, queuePos: envQueue.length }
  }
  const job = newEnvJob(envId)
  void (envId === 'embed' ? runEmbedInstall(job) : envId === 'npm' ? runNpmInstall(job) : envId === 'gitbash' ? runGitBashInstall(job) : runStandardInstall(job))
  return { ok: true, jobId: job.id }
}

/** winget / playwright 类安装（pwsh·node·git·python·chromium） */
async function runStandardInstall(job: EnvJobState): Promise<void> {
  const envId = job.envId
  const meta = ENV_META[envId]
  try {
    const dir = meta.mustC ? '' : envInstallDir()
    const attempts: Array<{ bin: string; args: string[]; shell?: boolean; env?: Record<string, string>; phase: string }> = []
    if (envId === 'chromium') {
      // 优先用**应用自带的 node + playwright-core 自带 CLI**（安装版/本机 PATH 上没有 npx）
      const cli = path.join(BACKEND_ROOT, 'node_modules', 'playwright-core', 'cli.js')
      const pwEnv = dir ? { PLAYWRIGHT_BROWSERS_PATH: dir } : undefined
      if (pathPresent(cli)) {
        attempts.push({ bin: process.execPath, args: [cli, 'install', 'chromium'], env: pwEnv, phase: '下载 Chromium 内核' })
      }
      attempts.push({ bin: 'npx', args: ['-y', 'playwright', 'install', 'chromium'], shell: true, env: pwEnv, phase: '下载 Chromium 内核（npx）' })
    } else {
      job.phase = '解析 winget…'
      const winget = await resolveWingetAsync()
      if (!winget) {
        job.status = 'error'
        job.error = '未检测到 winget（Windows「应用安装程序」）。请在 Microsoft Store 搜索“应用安装程序”更新后再试，或手动安装。'
        job.finishedAt = Date.now()
        return
      }
      job.log.push('winget = ' + winget)
      // 0918：--verbose-logs 让 winget 打印 `Downloading to path:` → 我们据此读"已下载字节"
      const base = ['install', '--id', meta.pkgId, '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--verbose-logs']
      // Python 的 InstallLocation 由 manifest 的 DefaultAllUsersTargetDir 承接 → 必须带 --scope machine 才生效
      const scoped = envId === 'python' ? [...base, '--scope', 'machine'] : base
      if (dir) attempts.push({ bin: winget, args: [...scoped, '--location', dir], phase: '下载并安装 ' + meta.pkgId })
      attempts.push({ bin: winget, args: scoped, phase: '下载并安装 ' + meta.pkgId })
    }
    for (const a of attempts) {
      job.percent = -1
      job.bytes = 0; job.totalBytes = 0
      job.stage = envId === 'chromium' ? 'download' : 'prep'
      // winget 路径额外挂一个"落盘字节"探测器（拿不到就算了，不影响安装）
      const stopWatch = envId === 'chromium' ? () => { /* playwright 自带进度 */ } : startWingetByteWatch(job)
      let r: { code: number | null }
      try {
        r = await runEnvStep(job, a.bin, a.args, { shell: a.shell, env: a.env, phase: a.phase })
      } finally {
        stopWatch()
      }
      if (r.code === 0) {
        /* ★ 0921d：记一笔「这项是 NIS 装的」→ env.status 标 source=nis，前端才给卸载入口 */
        markEnvInstalled(envId, envId === 'chromium' ? 'playwright' : 'winget')
        job.status = 'done'; job.percent = 100; job.stage = 'done'; job.phase = '完成'; job.finishedAt = Date.now(); pumpEnvQueue(); return
      }
    }
    job.status = 'error'; job.error = '安装命令未成功（见日志末尾）'; job.finishedAt = Date.now(); pumpEnvQueue()
  } catch (e: any) {
    job.status = 'error'; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = Date.now(); pumpEnvQueue()
  }
}

/** npm 安装（0930）：官方 tgz → <envDir>/npm。npm 版本钉在 NPM_VER（升级改这一处即可）。
 *  双源下载（registry.npmjs.org / npmmirror），系统自带 curl + tar，全程不依赖 PATH。 */
const NPM_VER = '10.9.2'
async function runNpmInstall(job: EnvJobState): Promise<void> {
  try {
    const dest = path.join(envInstallDir(), 'npm')
    const tmp = path.join(envInstallDir(), '.npm-pkg.tgz')
    const curl = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'curl.exe')
    // ★1010-D 顺手补同款：首次安装 envDir 可能不存在，下载前先建（不然 curl -o 秒挂）
    fs.mkdirSync(envInstallDir(), { recursive: true })
    // ① 下载（官方源 → 镜像）
    job.stage = 'download'; job.percent = -1; job.bytes = 0; job.totalBytes = 0
    let downloaded = false
    for (const [url, label] of [
      ['https://registry.npmjs.org/npm/-/npm-' + NPM_VER + '.tgz', '官方源'],
      ['https://registry.npmmirror.com/npm/-/npm-' + NPM_VER + '.tgz', 'npmmirror 镜像'],
    ] as const) {
      job.phase = '下载 npm ' + NPM_VER + '（' + label + '）'
      const r = await runEnvStep(job, pathPresent(curl) ? curl : 'curl', ['-L', '--fail', '--retry', '2', '-o', tmp, url], { timeoutMs: 10 * 60 * 1000 })
      if (r.code === 0 && pathPresent(tmp)) { downloaded = true; break }
    }
    if (!downloaded) throw new Error('npm 下载失败（官方源与镜像均不可达，检查网络后重试）')
    // ② 解压（tgz 根是 package/，剥一层进 npm/）
    job.stage = 'install'; job.phase = '解压 npm…'; job.percent = -1
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* ignore */ }
    fs.mkdirSync(dest, { recursive: true })
    const r2 = await runEnvStep(job, tarExe(), ['-xzf', tmp, '-C', dest, '--strip-components=1'], { timeoutMs: 3 * 60 * 1000 })
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    if (r2.code !== 0) throw new Error('解压 npm 失败（见日志末尾）')
    // ③ 校验：自带 node 跑一次 --version
    job.phase = '校验 npm…'
    const cli = path.join(dest, 'bin', 'npm-cli.js')
    const v = await probeVersion(process.execPath, [cli, '--version'])
    if (!v) throw new Error('npm 解压后校验失败（bin/npm-cli.js 不可用）')
    markEnvInstalled('npm', 'tgz')
    job.status = 'done'; job.percent = 100; job.stage = 'done'; job.phase = '完成'; job.finishedAt = Date.now(); pumpEnvQueue()
  } catch (e: any) {
    job.status = 'error'; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = Date.now(); pumpEnvQueue()
  }
}

/** Git Bash 安装（★1010-D，已定案 A 轻量路线）：**PortableGit** 自解压包（官方绿色包，含 usr/bin/bash.exe）
 *  → <envDir>/gitbash。不装系统、不要管理员、卸载=删文件夹。版本钉在 GITBASH_VER（升级改这一处）。
 *  ⚠️ 实测坑（1010-D 二轮）：**MinGit 标准包不含 bash.exe**（"无 POSIX 工具"精简版，usr/bin 只有 git.exe）——
 *  Git Bash 本尊在 PortableGit 里（解压即 GNU bash 5.x）。自解压参数 `-o<dir> -y`（7z SFX），不走 tar。
 *  双源下载（GitHub Releases / npmmirror 镜像——本机 GitHub CDN 间歇被墙），全程不依赖 PATH。
 *  装完 resetBashPath() 热接，不用重启后端；失败清半成品不留残骸。 */
const GITBASH_VER = '2.56.0'
async function runGitBashInstall(job: EnvJobState): Promise<void> {
  const dest = path.join(envInstallDir(), 'gitbash')
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : '64-bit'
    const file = `PortableGit-${GITBASH_VER}-${arch}.7z.exe`
    const tmp = path.join(envInstallDir(), '.gitbash-pkg.exe')
    const curl = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'curl.exe')
    /* ★1010-D 实测坑：首次安装时 <envDir> 可能还不存在 → curl -o 写不进目录、两源「均不可达」假象。
       下载前先建目录（不是兜底，是安装器的本职）。 */
    fs.mkdirSync(envInstallDir(), { recursive: true })
    // ① 下载（GitHub 官方 → npmmirror 镜像）
    job.stage = 'download'; job.percent = -1; job.bytes = 0; job.totalBytes = 0
    let downloaded = false
    for (const [url, label] of [
      ['https://github.com/git-for-windows/git/releases/download/v' + GITBASH_VER + '.windows.1/' + file, 'GitHub 官方'],
      ['https://registry.npmmirror.com/-/binary/git-for-windows/v' + GITBASH_VER + '.windows.1/' + file, 'npmmirror 镜像'],
    ] as const) {
      job.phase = '下载 Git Bash ' + GITBASH_VER + '（' + label + '）'
      const r = await runEnvStep(job, pathPresent(curl) ? curl : 'curl', ['-L', '--fail', '--retry', '2', '-o', tmp, url], { timeoutMs: 10 * 60 * 1000 })
      if (r.code === 0 && pathPresent(tmp)) { downloaded = true; break }
    }
    if (!downloaded) throw new Error('Git Bash 下载失败（官方源与镜像均不可达，检查网络后重试）')
    // ② 自解压（7z SFX：-o<目标> -y）；解压前清旧目录防混装
    job.stage = 'install'; job.phase = '解压 Git Bash…'; job.percent = -1
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* ignore */ }
    fs.mkdirSync(dest, { recursive: true })
    const r2 = await runEnvStep(job, tmp, ['-o' + dest, '-y'], { timeoutMs: 5 * 60 * 1000 })
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    if (r2.code !== 0) throw new Error('解压 Git Bash 失败（见日志末尾）')
    // ③ 校验：真跑一次 --version
    job.phase = '校验 Git Bash…'
    const bash = path.join(dest, 'usr', 'bin', 'bash.exe')
    const v = await probeVersion(bash, ['--version'])
    if (!v) throw new Error('Git Bash 解压后校验失败（usr/bin/bash.exe 不可用）')
    markEnvInstalled('gitbash', 'portablegit')
    resetBashPath()   // ★1010-D：装完立刻探测生效（否则要重启后端才认到——实测坑）
    job.status = 'done'; job.percent = 100; job.stage = 'done'; job.phase = '完成'; job.finishedAt = Date.now(); pumpEnvQueue()
  } catch (e: any) {
    // 失败不留半成品（实测：校验失败会留下 gitbash/ 目录残骸，污染"是否已安装"的判断）
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(path.join(envInstallDir(), '.gitbash-pkg.exe'), { force: true }) } catch { /* ignore */ }
    job.status = 'error'; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = Date.now(); pumpEnvQueue()
  }
}

/** 记忆检索模型（#11）：Python → venv → sentence-transformers → 预下载 **BAAI/bge-small-zh-v1.5**。
 *  ⚠️ 模型名必须与 `memory-kernel/memory_bridge.py` 加载的一致（内核与 upsert 阈值都按它调过）。
 *  全程走应用自己的下载源（pip 清华源 / HF hf-mirror），不依赖 PATH 上的任何东西。 */
async function runEmbedInstall(job: EnvJobState): Promise<void> {
  try {
    const dir = envInstallDir()
    const venv = memoryVenvDir()
    const vpy = memoryVenvPython()
    const findPy = async (): Promise<string> => {
      for (const c of envBinCandidates('python')) {
        if (path.resolve(c.bin) === path.resolve(vpy)) continue // 别用半成品 venv
        if (await probeVersion(c.bin, ['--version'])) return c.bin
      }
      return ''
    }
    job.phase = '检查 Python 运行环境'
    let py = await findPy()
    if (!py) {
      job.log.push('未找到 Python，先用 winget 安装 Python 3.13 …')
      const winget = await resolveWingetAsync()
      if (!winget) throw new Error('未检测到 Python，且 winget（应用安装程序）不可用，无法自动安装')
      const base = ['install', '--id', 'Python.Python.3.13', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--scope', 'machine']
      job.percent = -1
      let r = await runEnvStep(job, winget, dir ? [...base, '--location', dir] : base, { phase: '安装 Python 3.13' })
      if (r.code !== 0) r = await runEnvStep(job, winget, base, { phase: '安装 Python 3.13（默认位置）' })
      if (r.code !== 0) throw new Error('Python 安装失败（见日志末尾）')
      py = await findPy()
      if (!py) throw new Error('Python 已安装但探测不到可执行文件，请重启 NIS 后再试')
    }
    job.log.push('使用 Python：' + py)

    if (!pathPresent(vpy)) {
      try { fs.rmSync(venv, { recursive: true, force: true }) } catch { /* ignore */ }
      job.percent = -1
      const r = await runEnvStep(job, py, ['-m', 'venv', venv], { phase: '创建独立运行环境' })
      if (r.code !== 0) throw new Error('创建 Python 虚拟环境失败（见日志末尾）')
    }
    if (!pathPresent(vpy)) throw new Error('虚拟环境创建后未找到 python.exe')

    let pipOk = false
    for (const idx of ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple']) {
      job.log.push('pip 源：' + idx)
      job.percent = -1
      const r = await runEnvStep(job, vpy,
        ['-m', 'pip', 'install', '--no-input', '--progress-bar', 'on', '-i', idx, '--upgrade', 'sentence-transformers'],
        { phase: '安装语义检索依赖', timeoutMs: 45 * 60 * 1000 })
      if (r.code === 0) { pipOk = true; break }
    }
    if (!pipOk) throw new Error('依赖安装失败（已试清华源与官方源，见日志末尾）')

    job.percent = -1
    const code = "import os;os.environ.setdefault('HF_ENDPOINT','https://hf-mirror.com');from sentence_transformers import SentenceTransformer;SentenceTransformer('BAAI/bge-small-zh-v1.5');print('NIS-EMBED-OK')"
    const r4 = await runEnvStep(job, vpy, ['-c', code], { phase: '下载语义模型 bge-small-zh-v1.5', timeoutMs: 45 * 60 * 1000 })
    if (r4.code !== 0) throw new Error('语义模型下载失败（已试 hf-mirror 镜像，见日志末尾）')

    fs.writeFileSync(memoryVenvMarker(), new Date().toISOString(), 'utf8')
    markEnvInstalled('embed', 'venv')   // ★ 0921d：来源标记（env.status 据此标 source=nis）
    // 装完立刻热接上：重解析 Python + 重启记忆桥（用户不用重启应用就能导出/写记忆）
    try {
      resetMemoryPython()
      memoryBridge.stop()
      process.env.NIS_ENV_DIR = envInstallDir()
      memoryBridge.start()
      const ok = await memoryBridge.waitReady(120000)
      job.log.push(ok ? '记忆桥已用新环境重启，语义检索可用' : '记忆桥已重启，但 120s 内未就绪（看日志排查）')
    } catch { /* 桥重启失败不影响安装结果本身 */ }
    job.status = 'done'; job.percent = 100; job.stage = 'done'; job.phase = '完成'; job.finishedAt = Date.now(); pumpEnvQueue()
  } catch (e: any) {
    job.status = 'error'; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = Date.now(); pumpEnvQueue()
  }
}

function envJobGet(jobId: string): { ok: boolean; error?: string; job?: { id: string; envId: string; status: string; log: string[]; error: string; percent: number; phase: string; stage: string; speedBps: number; etaSec: number; bytes: number; totalBytes: number } } {
  const j = envJobs.get(jobId)
  if (!j) return { ok: false, error: 'job not found' }
  return {
    ok: true,
    job: {
      id: j.id, envId: j.envId, status: j.status, log: j.log.slice(-10), error: j.error || '',
      percent: j.status === 'done' ? 100 : j.percent,
      phase: j.phase || '', stage: j.status === 'done' ? 'done' : (j.stage || 'prep'),
      speedBps: j.speedBps || 0, etaSec: j.etaSec || 0,
      bytes: j.bytes || 0, totalBytes: j.totalBytes || 0,
    },
  }
}

/** 0921g：把外部图片（http/https 链接）下载成 data URL ——
 *  用途：从网页/文档复制"图片+文本"时，剪贴板 HTML 里常常是**外链** <img src="https://…">，
 *  而浏览器端 fetch 取图多半被 CORS 拦；交给本机后端代理下载最稳，拿到 base64 后就能变成
 *  NIS 的图片标签（实测：这类粘贴以前只剩文字）。
 *  安全：只收 http/https；5~12s 超时；上限 12MB；用**魔数**校验真是图片（防 200 返回 HTML 的假图）。 */
async function clipFetchImage(url: string, workDir?: string): Promise<{ ok: boolean; dataUrl?: string; mime?: string; bytes?: number; error?: string }> {
  const u = String(url || '').trim()
  /* ★ 0921h：除 http(s) 外还要支持**本地图片文件** ——
     QQ / 微信等客户端把剪贴板里的图写成临时文件，HTML 里用 `file:///C:/Users/…/Temp/xxx.png` 引用
     （实测：从 QQ 输入框复制"图片+文字"，剪贴板 items 里没有图片，只有这个 file:// 的 <img>）。
     安全约束：只收图片扩展名 + 12MB 上限 + 读得到才给。 */
  const isRemote = /^https?:\/\//i.test(u)
  let localPath = ''
  if (/^file:\/\//i.test(u)) {
    /* ★1003 安全批 4.59/4.60：用标准 fileURLToPath 解析（原手搓 replace 转反斜杠是 Windows-only，
       还会毁 POSIX 路径）；解析失败如实拒绝。 */
    try { localPath = fileURLToPath(u) } catch { return { ok: false, error: 'file:// 路径解析失败' } }
  } else if (/^[a-zA-Z]:[\\/]/.test(u)) {
    localPath = u
  }
  if (!isRemote && !localPath) return { ok: false, error: '只支持 http/https 或本地图片文件' }
  if (localPath) {
    try {
      /* ★1003 安全批 4.59/4.60：原来可读**任意本地文件**转 base64（仅图片魔数把关 = 任意图片外带，
         魔数还能伪造）——按报告口径收紧到**已知安全根**：系统临时目录（QQ/微信贴图就落这）、
         NIS 数据根（channel-inbox/会话资产）、本会话工作区；根外一律拒绝，且不跟符号链接。 */
      const abs = path.resolve(localPath)
      const rootsOk = [os.tmpdir(), DATA_ROOT, String(workDir || '')].filter(Boolean).map((r) => path.resolve(r))
      if (!rootsOk.some((r) => abs === r || abs.startsWith(r + path.sep))) {
        return { ok: false, error: '本地图片不在允许目录内（临时目录/收件箱/工作区），已拒绝' }
      }
      let st0: fs.Stats
      try { st0 = fs.lstatSync(abs) } catch (e: any) { return { ok: false, error: '读本地图片失败：' + String(e?.message || e).slice(0, 100) } }
      if (st0.isSymbolicLink()) return { ok: false, error: '不跟符号链接（安全约束）' }
      const st = fs.statSync(abs)
      if (!st.isFile()) return { ok: false, error: '不是普通文件' }
      if (st.size > 12 * 1024 * 1024) return { ok: false, error: '图片过大（>12MB）' }
      const buf = fs.readFileSync(abs)
      /* ★ 0921i：不靠扩展名判断（QQ/微信的临时文件常是 .tmp 或无后缀）—— 直接看**文件内容魔数** */
      const isPng = buf[0] === 0x89 && buf[1] === 0x50
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8
      const isGif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
      const isWebp = buf.subarray(8, 12).toString('ascii') === 'WEBP'
      const isBmp = buf[0] === 0x42 && buf[1] === 0x4d
      if (!isPng && !isJpg && !isGif && !isWebp && !isBmp) return { ok: false, error: '本地文件不是图片（魔数校验未通过）' }
      const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : isWebp ? 'image/webp' : 'image/bmp'
      return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), mime, bytes: buf.length }
    } catch (e: any) {
      return { ok: false, error: '读本地图片失败：' + String(e?.message || e).slice(0, 100) }
    }
  }
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只支持 http/https 链接或本地图片文件' }
  const MAX = 12 * 1024 * 1024
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15000)
  try {
    const r = await fetch(u, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 (NIS clip fetch)' } })
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status }
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX) return { ok: false, error: '图片过大（>12MB）' }
    const isPng = buf[0] === 0x89 && buf[1] === 0x50
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8
    const isGif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
    const isWebp = buf.subarray(8, 12).toString('ascii') === 'WEBP'
    if (!/^image\//.test(ct) && !isPng && !isJpg && !isGif && !isWebp) return { ok: false, error: '不是图片（content-type=' + ct + '）' }
    const mime = /^image\//.test(ct) ? ct : (isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : 'image/webp')
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), mime, bytes: buf.length }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) }
  } finally { clearTimeout(timer) }
}

/** 卸载环境：pwsh/node/git/python 走 winget uninstall；chromium=删 Playwright 缓存；embed=删自建 venv
 *  ★ 0921d 护栏（设计口径：**不是 NIS 装的一律不给卸**）——
 *    · bundled（应用自带运行时）/ system（机器上本来就有）→ 直接拒绝；
 *    · chromium 只允许卸「环境安装目录」里那一份（权威目录内没有就拒绝，绝不碰别人的 ms-playwright）；
 *    · embed 是 NIS 自建 venv，照旧可卸。
 *  前端同样会隐藏入口（不可用就藏），这里是后端兜底（防手滑 / 旧前端）。 */
function envUninstallStart(envId: string): { ok: boolean; jobId?: string; error?: string } {
  if (!ENV_IDS.includes(envId)) return { ok: false, error: '未知环境项' }
  const running = [...envJobs.values()].find((j) => j.status === 'running')
  if (running) return { ok: false, error: '已有任务进行中（' + running.envId + '）' }
  /* ── 0921d 来源护栏 ── */
  if (envId === 'chromium') {
    if (!chromiumPresent(envInstallDir())) {
      return { ok: false, error: '「环境安装目录」里没有 NIS 安装的 Chromium 内核（该内核可能属于其它软件），NIS 不予卸载。' }
    }
  } else if (envId !== 'embed' && !readEnvInstallMarks()[envId]) {
    return { ok: false, error: '该项目不是 NIS 安装的（系统自带或你自己装的），为避免误删你的环境，NIS 不提供卸载。' }
  }
  const job = newEnvJob(envId)
  void (async () => {
    if (envId === 'chromium') {
      // Playwright 浏览器缓存：逐个删 chromium* 目录（不碰其它内核缓存）；与安装落点同源（envDir 优先）
      const base = chromiumCacheDir()
      try {
        const targets = fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.startsWith('chromium')) : []
        for (const n of targets) {
          job.log.push('删除 ' + path.join(base, n))
          fs.rmSync(path.join(base, n), { recursive: true, force: true })
        }
        job.log.push(targets.length ? '已删除 ' + targets.length + ' 个 chromium 缓存目录' : '未找到 chromium 缓存（可能本就未安装）')
        unmarkEnvInstalled('chromium')   // ★ 0921d：卸干净了就把来源标记抹掉
        job.status = 'done'; job.percent = 100; job.finishedAt = Date.now()
      } catch (e: any) {
        job.status = 'error'; job.error = String(e?.message || e).slice(0, 200); job.finishedAt = Date.now()
      }
      return
    }
    if (envId === 'npm') {
      try {
        const npmDir = path.join(envInstallDir(), 'npm')
        fs.rmSync(npmDir, { recursive: true, force: true })
        job.log.push('已删除 ' + npmDir)
        unmarkEnvInstalled('npm')   // ★ 0921d：卸干净了就把来源标记抹掉
        job.status = 'done'; job.percent = 100; job.finishedAt = Date.now()
      } catch (e: any) {
        job.status = 'error'; job.error = String(e?.message || e).slice(0, 200); job.finishedAt = Date.now()
      }
      return
    }
    if (envId === 'gitbash') {
      try {
        const bashDir = path.join(envInstallDir(), 'gitbash')
        fs.rmSync(bashDir, { recursive: true, force: true })
        job.log.push('已删除 ' + bashDir)
        unmarkEnvInstalled('gitbash')   // ★1010-D：卸干净了就把来源标记抹掉
        resetBashPath()                 // 卸载后立刻回到「未安装」（下拉置灰、auto 不再选 bash）
        job.status = 'done'; job.percent = 100; job.finishedAt = Date.now()
      } catch (e: any) {
        job.status = 'error'; job.error = String(e?.message || e).slice(0, 200); job.finishedAt = Date.now()
      }
      return
    }
    if (envId === 'embed') {
      try {
        fs.rmSync(memoryVenvDir(), { recursive: true, force: true })
        job.log.push('已删除 ' + memoryVenvDir())
        unmarkEnvInstalled('embed')   // ★ 0921d：卸干净了就把来源标记抹掉
        job.status = 'done'; job.percent = 100; job.finishedAt = Date.now()
      } catch (e: any) {
        job.status = 'error'; job.error = String(e?.message || e).slice(0, 200); job.finishedAt = Date.now()
      }
      return
    }
    const winget = await resolveWingetAsync()
    if (!winget) {
      job.status = 'error'; job.error = '未检测到 winget（应用安装程序），无法卸载。'; job.finishedAt = Date.now(); return
    }
    const args = ['uninstall', '--id', ENV_META[envId].pkgId, '--silent', '--disable-interactivity', '--accept-source-agreements']
    job.percent = -1
    const r = await runEnvStep(job, winget, args, { phase: '卸载中' })
    if (r.code === 0) { unmarkEnvInstalled(envId); job.status = 'done'; job.percent = 100; job.finishedAt = Date.now(); pumpEnvQueue() }
    else { job.status = 'error'; job.error = '卸载命令未成功（见日志末尾）'; job.finishedAt = Date.now(); pumpEnvQueue() }
  })()
  return { ok: true, jobId: job.id }
}

/* ── 0917 供应商头像抓取 ────────────────────────────────────────
 * 用户自建供应商没有 logo（默认只能显示首字母方块）。这里从他的 Base URL 反推站点，
 * 依次尝试 favicon.ico → 首页 HTML 里声明的 icon/apple-touch-icon → og:image，
 * 拿到图片转 data URL 写回 providers.json 的 logo 字段。
 * 安全：只发 GET、10s 超时、限制 400KB、用魔数校验真的是图片（防 200 返回 HTML 的假 404）。 */
async function httpFetchTimed(url: string, ms: number): Promise<Response | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    /* 0925：带上常见浏览器 UA —— 0917 实测"只试原站成功率 2/16"的一大原因就是
     * 无 UA 请求被 CDN/WAF/云防护直接 403（curl 默认 UA 也被不少站点拦）。
     * 只发 GET、跟随重定向，语义不变。 */
    return await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTextLimited(url: string, ms: number): Promise<string> {
  const r = await httpFetchTimed(url, ms)
  if (!r || !r.ok) return ''
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  // 0925：放行 application/json —— PWA manifest（favicon 图标源）是 json content-type
  if (!/text\/html|application\/xhtml|text\/plain|application\/json/.test(ct)) return ''
  try {
    return (await r.text()).slice(0, 200000)
  } catch {
    return ''
  }
}

async function fetchImageAsDataUrl(url: string, ms = 10000): Promise<string> {
  const r = await httpFetchTimed(url, ms)
  if (!r || !r.ok) return ''
  let buf: Buffer
  try {
    buf = Buffer.from(await r.arrayBuffer())
  } catch {
    return ''
  }
  if (!buf.length) return ''
  const head = buf.slice(0, 300).toString('utf8')
  const isIco = buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8
  const isGif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
  const isSvg = head.includes('<svg')
  if (!(isIco || isPng || isJpg || isGif || isSvg)) return ''
  /* 0917c：图标是 base64 内联进 providers.json 的 → 体积直接变成配置体积。
   *  0917 实测 sensenova 单条 482KB ico 把配置撑到近 1MB。头像显示尺寸只有 32px，
   *  所以：SVG 宽松（矢量、通常几 KB）、位图收紧到 96KB，ICO 更要紧（多数是几百 KB
   *  的全尺寸多分辨率包，白占体积且显示模糊）——超过就换下一个候选，而不是塞进配置。 */
  const limit = isSvg ? 200 * 1024 : isIco ? 32 * 1024 : 96 * 1024
  if (buf.length > limit) return ''
  const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : isSvg ? 'image/svg+xml' : 'image/x-icon'
  return 'data:' + mime + ';base64,' + buf.toString('base64')
}

async function fetchProviderLogo(providerId: string, urlOverride: string): Promise<{ ok: boolean; logo?: string; host?: string; error?: string }> {
  const pv = getState().providers.find(x => x.id === providerId)
  /* 0917c：内置供应商自带官方 logo 文件（/providers-logo/*.svg|png），一律不抓官网 ——
   *  抓来的 favicon 分辨率低、还以 base64 内联把配置撑大（sensenova 单条 482KB 实锤）。
   *  只有用户自己接的供应商（无内置 logo）才允许抓。
   *  0918 修正：判定改用 isBuiltinProvider(id)（按内置名单），不再看 logo 前缀 ——
   *  自定义供应商也曾被赋 /providers-logo/<id>.svg，导致这里被误拒。 */
  if (isBuiltinProvider(providerId)) {
    return { ok: false, error: '该供应商已内置官方图标，无需从官网抓取' }
  }
  const raw = String(urlOverride || pv?.base || '').trim()
  if (!raw) return { ok: false, error: '该供应商还没填 Base URL，先填地址再获取' }
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw)
  } catch {
    return { ok: false, error: '地址不合法，无法解析出站点' }
  }
  const host = u.host
  // 图标候选：API 网关子域（api.xxx.com / open.xxx.cn / token.xxx.cn）一般只跑接口、不挂站点图标。
  // 0917 实测：只试原站的成功率 2/16，加上「回落官网根域 + www 根域 + 云厂商别名」后 11/16。
  const origins = siteOriginCandidates(u)
  const tried = new Set<string>()
  for (const origin of origins) {
    for (const c of await collectIconCands(origin)) {
      if (tried.has(c)) continue
      tried.add(c)
      const dataUrl = await fetchImageAsDataUrl(c)
      if (dataUrl) {
        setProviderLogo(providerId, dataUrl)
        let hostHit = host
        try { hostHit = new URL(origin).host } catch { /* ignore */ }
        return { ok: true, logo: dataUrl, host: hostHit }
      }
    }
  }
  /* 0925 兜底：站点自己不给 favicon（或全被拦）时，试公共 favicon 服务 ——
   * DDG / Google 按域名聚合浏览器实测可见的站点图标，常能补到"站点没挂图标"的情况。
   * 国内网络可能不通：失败就仅是失败，短超时（3s）不拖慢整体。 */
  for (const svc of [`https://icons.duckduckgo.com/ip3/${u.hostname}.ico`, `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`]) {
    const dataUrl = await fetchImageAsDataUrl(svc, 3000)
    if (dataUrl) {
      setProviderLogo(providerId, dataUrl)
      return { ok: true, logo: dataUrl, host }
    }
  }
  return { ok: false, error: '没抓到站点图标（该站点可能不对外提供 favicon）', host }
}

/** 常见的「接口子域」前缀：剥掉它去试官网根域 */
const LOGO_STRIP_LABELS = ['api', 'open', 'www', 'token']
/** 云厂商别名：接口域和官网不同域的情况（正则 → 官网主机名） */
const LOGO_SITE_ALIAS: Array<[RegExp, string]> = [
  [/\.aliyuncs\.com$/i, 'aliyun.com'], // 阿里云百炼 dashscope.aliyuncs.com → aliyun.com
  [/\.xiaomimimo\.com$/i, 'mi.com'], // 0925：小米 MiMo —— 官网域 xiaomimimo.com 的 DNS 常抽风（实测 ENOTFOUND），回退小米官网
]

/** 列出该供应商 Base URL 可能对应的「站点」origin，按优先级排序（原站 → 根域 → www 根域 → 别名） */
function siteOriginCandidates(u: URL): string[] {
  const out: string[] = [u.origin]
  const push = (h: string): void => {
    try {
      const o = new URL(u.protocol + '//' + h).origin
      if (!out.includes(o)) out.push(o)
    } catch { /* ignore */ }
  }
  const labels = u.hostname.split('.')
  if (labels.length > 2 && LOGO_STRIP_LABELS.includes(labels[0].toLowerCase())) {
    const root = labels.slice(1).join('.')
    push(root)
    push('www.' + root)
  }
  for (const [re, h] of LOGO_SITE_ALIAS) {
    if (re.test(u.hostname)) push(h)
  }
  return out
}

/** 汇总某个 origin 上的图标候选：首页声明的 link rel=icon / apple-touch-icon / og:image
 *  0917c 排序调整：**先声明的 svg/png，再 favicon.ico，再 apple-touch-icon，og:image 垫底**。
 *  理由：favicon.ico 常是几百 KB 的多分辨率包（体积大且缩到 32px 模糊），
 *  而站点显式声明的 svg/png 才有清晰的小尺寸图标；og:image 是社交大图，最不适合当头像。 */
async function collectIconCands(origin: string): Promise<string[]> {
  const declared: string[] = []
  const rest: string[] = []
  try {
    const html = await fetchTextLimited(origin + '/', 8000)
    if (html) {
      for (const m of html.matchAll(/<link[^>]*>/gi)) {
        const tag = m[0]
        const rel = (/rel=["']([^"']+)["']/i.exec(tag)?.[1] || '').toLowerCase()
        if (!rel.includes('icon')) continue
        const href = /href=["']([^"']+)["']/i.exec(tag)?.[1]
        if (!href) continue
        try { declared.push(new URL(href, origin + '/').toString()) } catch { /* ignore */ }
      }
      const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]
        || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html)?.[1]
      if (og) {
        try { rest.push(new URL(og, origin + '/').toString()) } catch { /* ignore */ }
      }
      /* 0925：PWA manifest（<link rel="manifest">）里的 icons[] —— 很多现代站点
       * （含 SPA）只在 manifest 里挂图标，首页 HTML 与 /favicon.ico 都没有。 */
      const manifest = /<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1]
        || /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i.exec(html)?.[1]
      if (manifest) {
        try {
          const mUrl = new URL(manifest, origin + '/').toString()
          const mj = await fetchTextLimited(mUrl, 5000)
          if (mj) {
            const iconsBlob = /"icons"\s*:\s*\[([\s\S]*?)\]/.exec(mj)?.[1] || ''
            for (const im of iconsBlob.matchAll(/"src"\s*:\s*"([^"]+)"/g)) {
              try { declared.push(new URL(im[1], mUrl).toString()) } catch { /* ignore */ }
            }
          }
        } catch { /* manifest 拉不到/解析失败不影响其他候选 */ }
      }
    }
  } catch { /* 拉不到首页就只试几个约定路径 */ }
  declared.sort((a, b) => {
    const rank = (u: string): number => (/\.svg(\?|$)/i.test(u) ? 0 : /\.png(\?|$)/i.test(u) ? 1 : /\.ico(\?|$)/i.test(u) ? 3 : 2)
    return rank(a) - rank(b)
  })
  return [
    ...declared,
    origin + '/favicon.ico',
    origin + '/favicon.svg',
    origin + '/favicon.png',
    origin + '/apple-touch-icon.png',
    origin + '/apple-touch-icon-precomposed.png',
    ...rest,
  ]
}

/** 目录选择器（0914）：列出子目录；空路径=盘符视图 + 常用位置快捷入口 */
function listDirForPicker(rawPath: string, opts: { withFiles?: boolean } = {}): { ok: boolean; error?: string; path: string; parent: string | null; dirs: Array<{ name: string; path: string }>; files: Array<{ name: string; path: string; size: number }>; drives: string[]; quick: Array<{ key: string; path: string }> } {
  const quick: Array<{ key: string; path: string }> = []
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    quick.push({ key: 'home', path: home })
    for (const [key, sub] of [['desktop', 'Desktop'], ['documents', 'Documents'], ['downloads', 'Downloads']] as Array<[string, string]>) {
      const q = path.join(home, sub)
      try { if (fs.existsSync(q)) quick.push({ key, path: q }) } catch { /* ignore */ }
    }
  }
  const drives: string[] = []
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\'
    try { if (fs.existsSync(d)) drives.push(d) } catch { /* ignore */ }
  }
  const p = String(rawPath || '').trim()
  if (!p) return { ok: true, path: '', parent: null, dirs: [], files: [], drives, quick }
  const full = path.resolve(p)
  const parent = path.dirname(full)
  const parentOrNull = parent === full ? null : parent
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error('目录不存在或不可访问')
    const dirs = fs.readdirSync(full, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .slice(0, 500)
      .map((e) => ({ name: e.name, path: path.join(full, e.name) }))
    /* 0917b：文件模式（导入数据包选文件用）——只列常规文件，带大小，按名字排序 */
    let files: Array<{ name: string; path: string; size: number }> = []
    if (opts.withFiles) {
      files = fs.readdirSync(full, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, 500)
        .map((e) => {
          let size = 0
          try { size = fs.statSync(path.join(full, e.name)).size } catch { /* ignore */ }
          return { name: e.name, path: path.join(full, e.name), size }
        })
    }
    return { ok: true, path: full, parent: parentOrNull, dirs, files, drives, quick }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), path: full, parent: parentOrNull, dirs: [], files: [], drives, quick }
  }
}

/** 目录选择器内新建文件夹（用户操作，不走审批门禁；只在所选父目录下建一级子目录） */
function mkdirForPicker(parentRaw: string, rawName: string): { ok: boolean; error?: string; path: string } {
  const parent = String(parentRaw || '').trim()
  if (!parent) return { ok: false, error: '请先进入一个目录再新建', path: '' }
  const name = String(rawName || '').trim().replace(/[\\/:*?"<>|]/g, '')
  if (!name) return { ok: false, error: '文件夹名称不能为空', path: '' }
  if (name === '.' || name === '..') return { ok: false, error: '文件夹名称无效', path: '' }
  const full = path.resolve(parent)
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error('父目录不存在或不可访问')
    const dest = path.join(full, name)
    if (fs.existsSync(dest)) throw new Error('同名文件夹已存在')
    fs.mkdirSync(dest)
    return { ok: true, path: dest }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), path: '' }
  }
}

/** 透传的事件序号（前端按 seq 保证顺序） */
let agentEventSeq = 0

/**
 * 透传 pi 原始事件给前端：前端节点运行时直接消费
 * （text_delta/thinking_delta/toolcall_x/tool_execution_x 天然对应 dsh 节点语义，
 * 不再经过 DSH message 翻译层，过程渲染完全由前端掌控）
 */
function broadcastAgentEvent(sessionId: string, event: AgentEvent): void {
  broadcastMux(sessionId, {
    type: 'session/agent-event',
    sessionId,
    seq: ++agentEventSeq,
    event,
  })
}

/** 组装 turn 的完整 content（序列 + 流式尾，按时间顺序交错） */
/** 0909④：近重复文本判定——模型常在"工具轮→收尾轮"把整段答案原样重说一遍（小确幸实锤：
 *  故事全文在一条消息里出现两次）。归一化去空白后：包含关系或 bigram Jaccard ≥0.75 = 重复。 */
function isNearDuplicate(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, ''), nb = b.replace(/\s+/g, '')
  if (na.length < 60 || nb.length < 60) return false
  if (na.includes(nb) || nb.includes(na)) return true
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1) } return m }
  const ga = grams(na), gb = grams(nb)
  let inter = 0, uni = 0
  for (const [g, c] of ga) { const d = gb.get(g) || 0; inter += Math.min(c, d); uni += Math.max(c, d) }
  return uni > 0 && inter / uni >= 0.75
}
/** ★0929f（ponytail 体检 P1）：text 若以配对 reasoning 回显开头就剥掉——**严格前缀、可多遍**。
 *  旧"≥60% 模糊"档已删：它切的是 reasoning.length 而非重合长度，正文恰与思考开头相似时
 *  会被误删一段（正文短于思考时整段吃光），违反"宁漏剥不误杀"。多遍=实测存在 text=思考×2 的成对重复。
 *  mimo 的"措辞漂移重写"剥不掉属预期（宁可保留，由 assembleTurnContent 的 isNearDuplicate 去重兜）。
 *  ponytail: 与 piChat.ts 的 stripThinkingEcho 为跨端双份（前后端独立打包无法共用）——改一处必须同步另一处。 */
function stripThinkingEcho(text: string, reasoning: string): string {
  if (!text || !reasoning) return text
  let t = text
  for (let g = 0; g < 3; g++) {
    if (t.startsWith(reasoning)) {
      t = t.slice(reasoning.length).replace(/^\s+/, '')
      if (!t) break
    } else break
  }
  return t
}

function assembleTurnContent(turn: TurnAccumulator): ContentBlock[] {
  const content: ContentBlock[] = []
  // 预扫：收集所有 text 段，标记与【更后】某段近重复的段（保留后段=最终答案，丢前段）
  const textItems = turn.sequence.filter(it => it.type === 'text') as Array<{ type: 'text'; text: string; reasoning: string }>
  const drop = new Set<{ type: 'text'; text: string; reasoning: string }>()
  for (let i = 0; i < textItems.length; i++) {
    const ti = textItems[i]
    if (!ti.text.trim()) continue
    for (let j = i + 1; j < textItems.length; j++) {
      const tj = textItems[j]
      if (tj.text.trim() && isNearDuplicate(ti.text, tj.text)) { drop.add(ti); break }
    }
  }
  const tailDup = turn.text.trim() ? textItems.some(ti => !drop.has(ti) && isNearDuplicate(ti.text, turn.text)) : false
  for (const item of turn.sequence) {
    if (item.type === 'text') {
      if (item.reasoning) content.push({ type: 'reasoning', text: item.reasoning })
      /* ★0929e：text 以配对 reasoning 的回显开头 → 剥掉（mimo-v2.6-pro 实测成对重复） */
      const _t = stripThinkingEcho(item.text || '', item.reasoning || '')
      if (_t && !drop.has(item as any)) content.push({ type: 'text', text: _t })
    } else {
      for (const tb of item.blocks) content.push(tb)
    }
  }
  if (turn.reasoning) content.push({ type: 'reasoning', text: turn.reasoning })
  if (turn.text && !tailDup) content.push({ type: 'text', text: stripThinkingEcho(turn.text, turn.reasoning || '') })
  return content
}

/** 推送 turn 当前快照（流式增量 / 工具块更新） */
// 0906 体检性能#3：流式快照 100ms 合并（中间帧丢弃只发最新，expectFinal 立即）——
// 一条万字节回复的 SSE 冗余从 ~2.5MB 降到 ~250KB，前端观感不变
const turnSnapTimers = new Map<string, ReturnType<typeof setTimeout>>()
function pushTurnSnapshot(sessionId: string, turn: TurnAccumulator, expectFinal = false): void {
  const emit = () => {
    turnSnapTimers.delete(sessionId)
    const dshMsg: DSHMessage = {
      id: turn.id,
      role: 'assistant',
      content: assembleTurnContent(turn),
      timestamp: Date.now(),
      expectFinal,
      model: turn.model,
    }
    broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_updated', message: dshMsg }, expectFinal })
  }
  if (expectFinal) {
    const t = turnSnapTimers.get(sessionId)
    if (t) { clearTimeout(t); turnSnapTimers.delete(sessionId) }
    emit()
    return
  }
  if (turnSnapTimers.has(sessionId)) return   // 已有待发帧（100ms 内会带上最新内容）
  turnSnapTimers.set(sessionId, setTimeout(emit, 100))
}



/** 从消息/transcript 数组取最后一个「有真实用量」的 assistant 消息 usage；无则返回 null */function findLastRealUsage(messages: any[]): { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && m?.usage) {
      const input = m.usage.input ?? m.usage.prompt_tokens
      const output = m.usage.output ?? m.usage.completion_tokens
      const cacheRead = m.usage.cacheRead
      const cacheWrite = m.usage.cacheWrite
      // 跳过全零 usage：纯工具调用轮（stopReason=toolUse）的 assistant 消息 usage 常为全零，
      // 用它覆盖会清空统计条的缓存命中/耗时数据
      if (!input && !output && !cacheRead && !cacheWrite) continue
      return { promptTokens: input ?? 0, completionTokens: output ?? 0, cacheReadTokens: cacheRead ?? 0, cacheWriteTokens: cacheWrite ?? 0 }
    }
  }
  return null
}

/** 从 transcript 回填 per-model usage + usedModels（旧会话/升级后首次加载用；timing 无法回推） */
function deriveModelUsage(messages: any[]): { modelUsage: Record<string, { usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>; usedModels: string[] } {
  const modelUsage: Record<string, { usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }> = {}
  const usedModels: string[] = []
  for (const m of messages) {
    if (m?.role === 'assistant' && m?.model && !usedModels.includes(m.model)) usedModels.push(m.model)
  }
  // 每个模型取最后一条真实 usage（跳过全零工具轮）
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !m?.model || !m?.usage || modelUsage[m.model]) continue
    const input = m.usage.input ?? m.usage.prompt_tokens
    const output = m.usage.output ?? m.usage.completion_tokens
    const cacheRead = m.usage.cacheRead
    const cacheWrite = m.usage.cacheWrite
    if (!input && !output && !cacheRead && !cacheWrite) continue
    modelUsage[m.model] = { usage: { promptTokens: input ?? 0, completionTokens: output ?? 0, cacheReadTokens: cacheRead ?? 0, cacheWriteTokens: cacheWrite ?? 0 } }
  }
  return { modelUsage, usedModels }
}

/** ★ 0924（token 对账修）：历史会话回填账本 —— **从 transcript 逐跳 usage 求和**（≡ 账单口径）。
 *  不用 turnMetas：它是旧口径（只记回合末跳）且上限 200 条、删轮还移除条目；
 *  transcript 里每一条 assistant 消息都躺着当跳的真实 usage，才是账单的原始凭据。 */
function deriveUsageTotalsFromTranscript(messages: any[]): { uncached: number; cacheRead: number; cacheWrite: number; output: number; turns: number } {
  const acc = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 }
  for (const m of messages || []) {
    if (m?.role === 'user') acc.turns += 1
    if (m?.role !== 'assistant' || !m?.usage) continue
    acc.uncached += Number(m.usage.input ?? m.usage.prompt_tokens) || 0
    acc.cacheRead += Number(m.usage.cacheRead) || 0
    acc.cacheWrite += Number(m.usage.cacheWrite) || 0
    acc.output += Number(m.usage.output ?? m.usage.completion_tokens) || 0
  }
  return acc
}

/** 从 agent_end 事件提取最后一次 LLM 请求的真实 usage（完整上下文 token） */
function extractUsage(event: any): { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } {
  return findLastRealUsage(event?.messages || []) || {}
}

/** 撞墙检测：thinking 增量流经处调用。把增量积累进滑动缓冲，切 ~120 字符段并统计指纹重复次数；
 *  同指纹出现 ≥3 次返回 true（思考死循环实锤）。检测到后由调用方 abort 本轮。
 *  说明：LongCat 流式末段本就会整段重发一次（去重层兜住单次），累计 3 次意味着模型真的在复读 */
function checkThinkingLoop(sessionId: string, delta: string): boolean {
  const session = sessions.get(sessionId)
  if (!session?.loopWindow) return false
  const w = session.loopWindow
  w.buf += delta
  const SEG = 120
  while (w.buf.length >= SEG) {
    const seg = w.buf.slice(0, SEG)
    w.buf = w.buf.slice(SEG)
    // 指纹哈希：webcrypto 的 digest 是异步的，这里用简单滚动字符串指纹即可（同步、零依赖）
    let hash = 0
    for (let i = 0; i < seg.length; i++) { hash = (hash * 31 + seg.charCodeAt(i)) | 0 }
    const key = String(hash)
    const n = (w.sigs.get(key) || 0) + 1
    w.sigs.set(key, n)
    if (w.sigs.size > 24) {
      // 窗口滚动：保最旧的 8 个指纹（简单起见按插入序删一半）
      const keys = Array.from(w.sigs.keys())
      for (const k of keys.slice(0, keys.length - 8)) w.sigs.delete(k)
    }
    if (n >= 3) return true
  }
  return false
}

/* ═══════════════════════════════════════════════════════════════════════
   0912 接入批：通道 ↔ 会话桥接
   ───────────────────────────────────────────────────────────────────────
   通道会话就是**普通会话**（createSession 时打 origin 标记），因此：
     · PC 左侧栏自动能看到、可直接打开继续聊（跨端接续零成本）
     · 记忆提炼/会话拆分/项目归属等既有能力全部复用

   流程：IM 消息 → 映射到 sessionId（无则建）→ 命令 or prompt → 结果回推
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 待回推的回复目标 —— sessionId → **FIFO 队列**（agent_end 时取队首回推）。
 *
 * ⚠️ 为什么是队列而不是单值（0912 三批修复「回复慢一层」）：
 *   同一个人连发消息时，第 2 条进来时第 1 条往往还在跑 → 第 2 条入队等待。
 *   早期用 `Map<sessionId, target>` 单值存储，第 2 条会**覆盖**第 1 条的回复目标；
 *   等第 1 条跑完 agent_end 触发回推，推的是第 1 条的**内容**但目标已变成第 2 条；
 *   随后队列自动续发第 2 条，跑完时目标已被 delete → 回复丢失。
 *   用户实测表现：「发第二条，QQ 回的是第一条的内容」。
 *   队列化后每条入站消息各占一位，agent_end 依次消费，一一对应。
 */
interface ChannelReplyTarget {
  channel: 'qq' | 'wechat'
  botId: string
  peerId: string
  /** 通道侧消息 id（QQ 回复需带 msg_id；微信回复需 context_token） */
  messageId: string
  kind?: 'c2c' | 'group' | 'channel'
  contextToken?: string
  /** 入站发送者标识（0913 显式声明）—— 由 handleChannelIncoming 的 target 透传，出站 @ 逻辑用 */
  senderId?: string
  /** 入站发送者昵称（0913 显式声明）—— 群聊无人被 @ 时自动 @ 提问者用 */
  senderName?: string
  startedAt: number
  /**
   * 正文前缀（0912 十九批）—— `/回复通知` 的回复要带 `⏰任务名`，
   * 让用户一眼看出这是**任务线**在说话而不是当前对话（用户明确要求）。
   */
  prefix?: string
}

const channelReplyTargets = new Map<string, ChannelReplyTarget[]>()

/** 入站消息登记一个待回复目标（立即执行 / 排队等待都要登记，保证一一对应） */
function pushReplyTarget(sessionId: string, target: ChannelReplyTarget): void {
  const q = channelReplyTargets.get(sessionId) || []
  q.push(target)
  /**
   * 上限保护（0920 / #4① 修正）。
   *
   * ⚠️ 原实现是 `while (q.length > 8) q.shift()` —— **从队首丢**。
   * 但这个队列是 agent_end 时**逐条 FIFO 消费**的：从队首丢 = 后面每条回复都
   * 认领到"下一条入站"的目标 → 回复错位（回错 msg_id/会话），比丢几条更严重。
   * 现在改成：上限放宽到 64（远高于任何真实突发），并且**从队首丢时明确告警**
   * ——真到了这一步说明队列严重积压，需要人工看日志，而不是静默错位。
   */
  while (q.length > 64) {
    const dropped = q.shift()
    console.warn(`[channel] 回推目标积压超过 64，丢弃最早的（${sessionId.slice(0, 8)} → ${String(dropped?.peerId || '').slice(0, 8)}）—— 后续回复可能错位，请检查是否有消息未被处理`)
  }
  channelReplyTargets.set(sessionId, q)
}

/** 查看队首目标但不消费（审批推送等只读场景用） */
function peekReplyTarget(sessionId: string): ChannelReplyTarget | null {
  const q = channelReplyTargets.get(sessionId)
  return q?.length ? q[0] : null
}

/** 取走队首目标（agent_end 回推时消费） */
function shiftReplyTarget(sessionId: string): ChannelReplyTarget | null {
  const q = channelReplyTargets.get(sessionId)
  if (!q?.length) return null
  const t = q.shift()!
  if (!q.length) channelReplyTargets.delete(sessionId)
  return t
}

/* ★1003 修复 4.63/4.64：按**身份**撤回指定目标。原来回滚场景用 shiftReplyTarget() 弹队头——
 * 积压时弹掉的是别人未处理的待回复，后续每条回复都挂错 msg_id/会话（"回错消息"正是这队列要防的）。
 * 只删调用方自己刚压进去的那条，队列其余原样不动。 */
function removeReplyTarget(sessionId: string, t: ChannelReplyTarget): boolean {
  const q = channelReplyTargets.get(sessionId)
  if (!q?.length) return false
  const i = q.indexOf(t)
  if (i < 0) return false
  q.splice(i, 1)
  if (!q.length) channelReplyTargets.delete(sessionId)
  return true
}

/** 清空某会话的全部待回推目标（会话被删除/取消时用） */
function clearReplyTargets(sessionId: string): void {
  channelReplyTargets.delete(sessionId)
}

/**
 * 最近一条入站消息的上下文（sessionId → target）—— **覆盖式，不随回推队列消费**。
 *
 * 用途：审批推送 / 超时通知这类"时机不确定"的回推。
 * 为什么不能只用 replyTargets 队列：队列会被 agent_end 逐条消费（尤其 auto-continue
 * 第二轮时已消费完），此时若发生审批，peek 为空 → 审批推不到 IM → 用户静默等超时。
 * （QQ 被动回复要求带 msg_id，所以必须留一份最近上下文。）
 */
const lastChannelInbound = new Map<string, ChannelReplyTarget>()

function rememberInbound(sessionId: string, t: ChannelReplyTarget): void {
  lastChannelInbound.set(sessionId, t)
}

/** 回推上下文：优先未消费的队列队首（最贴合当前轮），否则用最近入站上下文 */
function channelPushContext(sessionId: string): ChannelReplyTarget | null {
  return peekReplyTarget(sessionId) || lastChannelInbound.get(sessionId) || null
}

function clearInboundContext(sessionId: string): void {
  lastChannelInbound.delete(sessionId)
}

/* ── ★1014c：群聊「最近的图」——先发图、再 @ 机器人也能看见 ────────────────────────
 * 病案（实测）：群里**先发一张图**（没 @ 机器人）→ 图那条走"旁听"路径，被压成 `[图片]`
 * 占位、下载地址丢弃 → 紧接着 @ 它问「这是谁」，它手里只有"[图片]"三个字 ⇒ 回「看不见图片」。
 *
 * 做法：旁听消息的附件**只登记地址、不下载**（零浪费：群里没人理它就不下）；
 * 谁要开口谁去取 —— ① 被 @ 回复时 ② 它自己决定插嘴时（两条路都要接，少一条就是瞎子）。
 * 窗口 3 分钟：发完图再打字 @ 的时间足够；超时当作另一件事，免得张冠李戴。
 */
interface GroupMediaMemo {
  at: number
  /** 待认领的图片地址（明确是 image/* 的，以及平台没给 content_type 的 —— 落盘时按魔数再判） */
  urls: string[]
  /** 来源消息 id（排查用） */
  messageId: string
}
const recentGroupMedia = new Map<string, GroupMediaMemo>()
/** 认领窗口：超过就当另一件事（不做"事后翻旧图"） */
const GROUP_MEDIA_TTL_MS = 3 * 60 * 1000

/** 登记"该群最近的图"（旁听与 @ 消息都登记；同群后一条带图消息覆盖前一条） */
function rememberGroupMedia(channel: 'qq' | 'wechat', botId: string, peerId: string, ev: any): void {
  try {
    if (channel !== 'qq') return
    const atts = Array.isArray(ev?.attachments) ? ev.attachments : []
    const urls = atts
      .filter((a: any) => {
        const ct = String(a?.content_type || '').trim().toLowerCase()
        // 平台偶尔不给 content_type（或给 octet-stream）→ 也记上，交给落盘时的魔数嗅探判定
        return (!ct || ct.startsWith('image/')) && /^https?:\/\//i.test(String(a?.url || ''))
      })
      .map((a: any) => String(a.url))
      .slice(0, INBOUND_IMAGE_MAX_COUNT)
    if (!urls.length) return
    const key = makeChannelKey(channel, botId, peerId)
    recentGroupMedia.set(key, { at: Date.now(), urls, messageId: String(ev?.messageId || '') })
    console.log(`[group-media] 记下群 ${String(peerId).slice(0, 8)} 的 ${urls.length} 张图（待认领，窗口 ${Math.round(GROUP_MEDIA_TTL_MS / 1000)}s）`)
  } catch { /* 登记失败不影响消息处理本身 */ }
}

/** 认领"该群最近的图"：窗口内才下载；返回空数组 = 这次没有可认领的图（正常情况，不是错误） */
async function claimGroupMedia(channel: 'qq' | 'wechat', botId: string, peerId: string): Promise<InboundImage[]> {
  try {
    if (channel !== 'qq') return []
    const key = makeChannelKey(channel, botId, peerId)
    const memo = recentGroupMedia.get(key)
    if (!memo) return []
    if (Date.now() - memo.at > GROUP_MEDIA_TTL_MS) { recentGroupMedia.delete(key); return [] }
    const { images, errors } = await fetchQqImages('qq', botId, memo.urls)
    if (errors?.length) console.warn(`[group-media] 群 ${String(peerId).slice(0, 8)} 认领图片部分失败：${errors.join(' | ').slice(0, 200)}`)
    if (images.length) console.log(`[group-media] 群 ${String(peerId).slice(0, 8)} 认领到 ${images.length} 张图（源消息 ${memo.messageId.slice(0, 12)}）`)
    return images
  } catch (e: any) {
    console.warn(`[group-media] 认领失败（本轮按无图继续，不拦消息）：${String(e?.message || e).slice(0, 160)}`)
    return []
  }
}

/**
 * 按通道配置对齐微信连接（启动时 / 扫码后 / 配置变更时调用）。
 * 微信只允许单账号（配置里最多一个 bot），所以逻辑比 QQ 简单。
 */
function syncWechatBotsFromConfig(): void {
  const cfg = getChannel('wechat')
  const enabled = !!cfg?.enabled
  const bots = cfg?.bots || []
  const want = new Set<string>()
  if (enabled) {
    for (const b of bots) {
      if (!b.enabled) continue
      if (!b.secret) { console.warn(`[channel] 微信 bot ${b.id} 缺 bot_token，跳过启动（需重新扫码）`); continue }
      want.add(b.id)
      startWechatBot({ botId: b.id, accountId: b.accountId, token: b.secret })
    }
  }
  // 停掉配置里已不存在 / 已禁用的连接
  for (const id of Object.keys(wechatBotStatus())) {
    if (!want.has(id)) {
      try { stopWechatBot(id) } catch { /* ignore */ }
    }
  }
  if (!enabled && bots.length) console.log('[channel] 微信通道未启用，跳过连接')
}

/** 通道配置变更 → 重连对应通道（QQ 多机器人 / 微信单账号） */
function reconnectChannel(cid: string): void {
  try {
    if (cid === 'qq') void syncQqBotsFromConfig().catch(() => { /* 日志由内部打 */ })
    if (cid === 'wechat') syncWechatBotsFromConfig()
  } catch (e: any) {
    console.warn(`[channel] 重连 ${cid} 失败: ${String(e?.message || e).slice(0, 150)}`)
  }
}

/** 通道会话的默认工作目录（与桌面会话隔离，避免混在储存目录根下） */
function channelWorkDir(channel: string, peerId: string): string {
  const safe = peerId.replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 40)
  return path.join(DATA_ROOT, 'channel-workspaces', channel, `${safe}_${Date.now().toString(36)}`)
}

/**
 * 通道会话自愈 —— 补齐/校正属于「通道上下文」的字段。
 *
 * 0912 二批自愈：早期通道会话没有 originBot（该字段后加），且权限可能是 confirm（会卡死）。
 * 每次触达时补齐 —— 避免老会话在「按机器人过滤」的列表里彻底消失、或继续弹审批卡。
 * @returns 是否有改动（调用方决定是否落盘）
 */
function healChannelSession(s: any, channel: string, botId: string, peerId?: string, kind?: string): boolean {
  let healed = false
  if (!s.origin) { s.origin = channel; healed = true }
  /**
   * 归属跟随**实际使用的通道**（0912 十三批）。
   *
   * 为什么：定时任务的专属会话可以被推送到多个通道（微信 + 某台 QQ 机器人），
   * 建会话时按**首个**目标打了归属；用户在**另一个**通道回话时，若归属不改，
   * 人格/模型/权限会张冠李戴（实测：在牢大群回话，回出来的是微信/全局人格 → 用户以为人格又没生效）。
   * 语义定为「这条对话现在走哪个通道，就归哪个通道」—— 单通道会话本就不会触发本分支。
   */
  else if (peerId && (s.origin !== channel || (botId && s.originBot && s.originBot !== botId))) {
    s.origin = channel
    if (botId) s.originBot = botId
    s.originPeer = peerId
    if (kind) s.originKind = kind
    healed = true
  }
  if (!s.originBot && botId) { s.originBot = botId; healed = true }
  // peer 只在确实是「该对端专属映射」时补齐（PC 端新建的会话可能还没有 peer）
  if (peerId && !s.originPeer) { s.originPeer = peerId; healed = true }
  // 0912 三批：对端类型（私聊/群聊）—— 老会话首次触达时顺带补上
  if (kind && !s.originKind) { s.originKind = kind; healed = true }
  /**
   * ★1020（把 1013g 的口径补全）：**通道会话权限不再同步"通道级权限档"**——那个档位用户已拍板删除，
   * 会话就用"对话自己的权限"（PC 输入框上方三档 / IM 里 `/perm`）。
   * 历史：这里原来写
   *     const wantPerm = modelForChannel(channel, botId).permissionMode
   *     if (s.permissionMode !== wantPerm) s.permissionMode = wantPerm
   * 而 modelForChannel 在该档位删除后拿的是通道配置里的**陈旧值**（默认 self_audit）⇒ 后果是
   * 「在 PC 或 IM 里切了权限，**下一条消息进来又被自愈回旧档**」——用户看到的现象是"权限回默认"。
   */
  return healed
}

/**
 * 找到（或创建）某通道对端对应的 NIS 会话。
 *
 * 解析优先级：
 *   ① 正式映射 `channel:botId:peerId` → 命中且会话存在则直接用（正常路径）
 *   ② bot 级覆盖 `channel:botId`（PC 端在对端未知时切换/新建写入的指向）
 *      → 消费：绑定成该 peer 的正式映射，之后走 ①
 *   ③ 新建会话
 *
 * @param opts.forceNew 强制新建（`/new` 命令、PC 端「新建对话」用）—— 不再复用旧会话
 * @param opts.kind     消息场景（'c2c' 私聊 / 'group' 群聊 / 'channel' 频道）—— 落 originKind 供列表区分
 * @returns sessionId；失败返回 null
 */
function resolveChannelSession(
  channel: string,
  botId: string,
  peerId: string,
  title?: string,
  opts?: { forceNew?: boolean; kind?: string },
): string | null {
  const key = makeChannelKey(channel, botId, peerId)

  if (!opts?.forceNew) {
    const link = getLink(key)
    if (link) {
      // 映射存在但会话已被删 → 落到下面重建（避免指向不存在的会话）
      if (sessions.has(link.sessionId)) {
        touchLink(key)
        const s = sessions.get(link.sessionId)!
        if (healChannelSession(s, channel, botId, peerId, opts?.kind)) {
          schedulePersist()
          console.log(`[channel] 自愈会话 ${s.id.slice(0, 8)}：originBot=${s.originBot} perm=${s.permissionMode}`)
        }
        // 该对端已有正式映射 → bot 级覆盖失效（避免「PC 切了之后手机还走老会话」）
        clearBotActive(channel, botId)
        return link.sessionId
      }
      console.warn(`[channel] 映射指向的会话已不存在，重建：${link.sessionId}`)
    }

    // ② bot 级覆盖：PC 端在「还不知道对端是谁」时切换/新建指定的活跃会话
    const ov = getBotActive(channel, botId)
    if (ov && sessions.has(ov.sessionId)) {
      const ovs = sessions.get(ov.sessionId)!
      /**
       * ⚠️ 跨对端保护（0912 十六批）：bot 级覆盖只该对「同一个对端」或「全新会话」生效。
       *
       * 否则会出现用户实测的那个疑问：「我在两个群里，怎么好像只有一个群聊的上下文」——
       * 因为 PC 端在 A 群那边切了「当前会话」后，B 群来的第一条消息会把这条覆盖消费掉，
       * 于是 B 群被接进 **A 群的会话**，两个群真的就合并成一个上下文了。
       * 归属不同的对端 → 不消费，让 B 群走「新建」路径（各群各一条，符合预期）。
       */
      const belongsOtherPeer = !!ovs.originPeer && ovs.originPeer !== peerId
      if (belongsOtherPeer) {
        console.log(`[channel] bot 级覆盖属于对端 ${String(ovs.originPeer).slice(0, 8)}，与本次 ${peerId.slice(0, 8)} 不同 → 不消费，另建会话`)
      } else {
        healChannelSession(ovs, channel, botId, peerId, opts?.kind)
        setLink(key, { sessionId: ov.sessionId, channel, botId, peerId })
        clearBotActive(channel, botId)
        schedulePersist()
        console.log(`[channel] 覆盖落定 ${ovs.id.slice(0, 8)} ← ${channel}:${botId}:${peerId}（PC 端指定）`)
        return ov.sessionId
      }
    }
    if (ov) console.warn(`[channel] bot 级覆盖指向的会话已不存在，忽略：${ov.sessionId}`)

    /**
     * ③ 新建前的诊断日志（0912 三批）：映射缺失时会走到这里新建会话。
     * 曾实测出现过一次「用户在已有会话里聊天，消息却落到新会话」且未能复现 ——
     * 补这条日志以便下次能立刻区分「映射丢失」还是「正常首聊/forceNew」。
     */
    /**
     * ★1013f 诊断增强：这里一旦出现，"映射到底有没有/长什么样"必须一次看清。
     * 背景：这条注释上面写着"曾出现过一次「消息落到新会话」且未能复现" —— 1012 又复现了一次，
     * 但当时只有一行短日志，定位不了。现在把三件事一起打：
     *   ① 完整 key（原来只打 peerId 前 8 位）；② 映射表里同对端/同 bot 的相近条目；③ 映射总数。
     * ⚠️ 若"相近条目"里能看到同一个 peerId、却 key 不同 ⇒ 就是 key 构造不一致（或映射被加载了两份）。
     */
    try {
      const all = listLinks()
      const keys = Object.keys(all)
      const near = keys
        .filter(k => k.includes(peerId) || k.includes(botId))
        .slice(0, 6)
        .map(k => `${k}→${String((all as any)[k]?.sessionId || '').slice(0, 8)}`)
      console.log(`[channel] 无映射 → 新建会话 key=${key}（相近条目：${near.length ? near.join(' | ') : '无'}；映射总数 ${keys.length}）`)
    } catch (e: any) {
      console.log(`[channel] 无映射 → 新建会话 key=${key}（列映射失败：${String(e?.message || e).slice(0, 80)}）`)
    }
  }

  // ③ 新建
  const mc = modelForChannel(channel, botId)
  const s = createSession(
    title || `${channel === 'qq' ? 'QQ' : '微信'} · ${peerId.slice(0, 8)}`,
    channelWorkDir(channel, peerId),
    mc.presetId || undefined,
    undefined, undefined,
    channel,
  )
  s.originPeer = peerId
  // 0912 二批：记录来源机器人 —— QQ 多机器人的对话列表按它隔离
  s.originBot = botId
  // 0912 三批：记录消息场景（私聊/群聊）—— 列表里区分显示
  if (opts?.kind) s.originKind = opts.kind
  if (mc.modelId) {
    s.model = mc.modelId
    s.modelProviderId = resolveModelProviderId(mc.modelId) || undefined
  }
  if (mc.effort) s.effort = mc.effort
  /**
   * ⚠️ 1013g（已定案）：**通道会话不再套用"通道级权限档"** —— 那个档位已删，
   * 会话就用**对话本身的权限**（`createSession` 的默认 = `confirm`）。
   * 历史：这里原来写 `s.permissionMode = mc.permissionMode`，通道默认 `self_audit`，
   * 是为了规避"confirm 的卡只在 PC 弹 → IM 看不到 → 干等超时"；现在卡会推到 IM 且有按钮，
   * 前提消失 ⇒ 统一用对话权限，两道闸变一道。
   */
  schedulePersist()
  broadcastHost({ type: 'host/session-added', sessionId: s.id, blank: true, cwd: s.workDir ?? process.cwd() })
  setLink(key, { sessionId: s.id, channel, botId, peerId })
  clearBotActive(channel, botId)
  // ★1020：打印**会话真实权限**。此前打的是 `mc.permissionMode`（已删的通道档，取值恒为通道配置里的陈旧值 ），
  // 与实际生效值不符 —— 排查"权限不对"时会被这行日志带偏。
  console.log(`[channel] 新会话 ${s.id} ← ${channel}:${botId}:${peerId}（权限=${s.permissionMode}）`)
  return s.id
}

/**
 * 反向回填：以 sessionMap 记录为准，补齐会话的通道归属字段。
 *
 * 为什么需要：早期版本的持久化白名单漏了 originPeer，重启后会话字段丢失
 * （实测 e742bbf2 → originPeer 空），导致「当前会话」标记算不出来、
 * PC 端新建时也借不到对端。映射文件是权威来源，据此自愈。
 * @returns 是否发生改动
 */
function healSessionsFromLinks(): boolean {
  const links = listLinks()
  let changed = false
  for (const v of Object.values(links)) {
    if (!v?.sessionId) continue
    const s = sessions.get(v.sessionId)
    if (!s) continue
    if (!s.origin && v.channel) { s.origin = v.channel; changed = true }
    if (!s.originPeer && v.peerId) { s.originPeer = v.peerId; changed = true }
    if (!s.originBot && v.botId) { s.originBot = v.botId; changed = true }
  }
  /**
   * originKind（私聊/群聊）是**对端的属性** —— 同一 peer 下所有会话必然相同。
   * 老会话（该字段加入前创建的）自己没有 kind 时，从同 peer 的兄弟会话借一个即可，
   * 不必等它下次收到消息（否则列表里会一直缺标记）。
   */
  const byPeer = new Map<string, string>()
  for (const s of sessions.values()) {
    if (s.originPeer && s.originKind) byPeer.set(s.originPeer, s.originKind)
  }
  for (const s of sessions.values()) {
    if (!s.originKind && s.originPeer) {
      const k = byPeer.get(s.originPeer)
      if (k) { s.originKind = k; changed = true }
    }
  }
  /**
   * 反向：映射缺 kind 时借用**该 peer 已知的类型**（0912 十三批加的字段）。
   * 借的是 peer 维度（`byPeer` 汇总了所有会话的记录），不是"当前映射那条会话"的字段 ——
   * 同一会话被多对端复用时，会话级 kind 只代表"最后一次是谁"，借它会发错 QQ 端点（私聊发到 groups 必失败）。
   */
  for (const [key, v] of Object.entries(links)) {
    if (!v?.kind && v?.peerId) {
      const k = byPeer.get(v.peerId)
      if (k) {
        try { setKind(key, k); changed = true } catch { /* ignore */ }
      }
    }
  }
  if (changed) {
    schedulePersist()
    console.log('[channel] 已按映射回填通道会话归属字段')
  }
  return changed
}

/**
 * 把某个**已存在**的会话设为「当前会话」（PC 端弹窗 / RPC 调用）。
 *
 * 「当前会话」= 该机器人后续收到的 IM 消息落点，规则：
 *   · 能确定对端（会话自己是通道会话 / 同机器人下有其它会话带对端）→ 写正式映射 `channel:bot:peer`
 *   · 不能确定对端（PC 上刚新建、从未收过消息）→ 写 bot 级覆盖，等第一条 IM 消息落定
 *
 * @returns 落定方式（'link' 精确绑定 / 'botActive' 等待首条消息）
 */
function activateChannelSession(channel: string, botId: string, sessionId: string): { mode: 'link' | 'botActive'; peerId?: string } {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('会话不存在')
  const bot = (botId || s.originBot || '').trim()

  // 回填一次（对端可能因历史 bug 丢失，见 healSessionsFromLinks）
  healSessionsFromLinks()

  // ① 对端来源：会话自身 → 映射文件反查 → 同机器人的其它会话
  /**
   * ⚠️ 会话自身的 originPeer 只有在**通道/机器人也对得上**时才能信（0912 十三批）。
   * 反例：任务专属会话被推送到多个通道，originPeer 可能变成另一个通道的对端 id
   * → 直接拿来当本通道的对端会写出错误映射（把微信映射指到 QQ 群 id）。
   */
  const selfMatch = (s.origin || '') === channel && (!bot || !s.originBot || s.originBot === bot)
  let peer = selfMatch ? (s.originPeer || '').trim() : ''
  if (!peer) {
    for (const v of Object.values(listLinks())) {
      if (v.sessionId === sessionId && v.peerId && v.channel === channel && (!bot || v.botId === bot)) { peer = v.peerId; break }
    }
  }
  if (!peer) {
    const known = Array.from(sessions.values())
      .filter(x => (x.origin || '') === channel && (x.originBot || '') === bot && x.originPeer && x.id !== sessionId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
    peer = (known?.originPeer || '').trim()
  }

  // 会话自身的归属字段补齐（否则它不会出现在该机器人的独享列表里）
  if (!s.origin) s.origin = channel
  if (!s.originBot && bot) s.originBot = bot

  if (peer) {
    if (!s.originPeer) s.originPeer = peer
    setLink(makeChannelKey(channel, bot, peer), { sessionId, channel, botId: bot, peerId: peer })
    clearBotActive(channel, bot)
    schedulePersist()
    console.log(`[channel] 当前会话 → ${sessionId.slice(0, 8)}（${channel}:${bot}:${peer}）`)
    return { mode: 'link', peerId: peer }
  }

  setBotActive(channel, bot, sessionId)
  schedulePersist()
  console.log(`[channel] 当前会话 → ${sessionId.slice(0, 8)}（${channel}:${bot}，等待首条消息绑定对端）`)
  return { mode: 'botActive' }
}

/** 通道回推目标（各函数共用的形状） */
interface ChannelDeliverTarget {
  channel: 'qq' | 'wechat'
  botId: string
  peerId: string
  messageId: string
  kind?: 'c2c' | 'group' | 'channel'
  contextToken?: string
  /**
   * 入站消息发送者标识（0912 反馈）—— 群聊出站时用来识别「谁在问」。
   * ⚠️ 0913 修正：发送侧不再拼 `<@openid>`（QQ 不认，会原样显示代码）；@ 只走纯文本 `@昵称`。
   * 群聊场景由 qqBot 填 `author.member_openid`；私聊/微信不用。
   */
  senderId?: string
  /** 入站消息发送者昵称（0913）—— 群聊无人被 @ 时自动 @ 提问者用；平台可能不下发 */
  senderName?: string
}

/**
 * MEDIA 路径兜底（二十二批，实测「发给我的不是我写的那个文件」）：
 * AI 手写绝对路径时经常**少打/多打几个字符**（实测把一个 32 位 openid 目录名打错 3 个字符
 * → 文件不存在 → 发送失败）。这里按**文件名**在会话工作区里找一份，找到就用它。
 * @returns 命中的真实路径（没找到返回原路径，交给上层报错）
 */
function resolveMediaPathLoose(rawPath: string, workDir?: string): { path: string; note?: string } {
  try {
    if (fs.existsSync(rawPath)) return { path: rawPath }
    const base = path.basename(rawPath)
    const wd = String(workDir || '').trim()
    if (!base || !wd || !fs.existsSync(wd)) return { path: rawPath }
    const hit = findFileByName(wd, base, 3)
    if (hit) return { path: hit, note: `MEDIA 路径不存在，已按文件名在工作区兜底：${rawPath} → ${hit}` }
  } catch { /* ignore */ }
  return { path: rawPath }
}

/** 在工作区里按文件名找一份（限深度/条数，防大目录卡死） */
function findFileByName(dir: string, name: string, maxDepth: number): string {
  const want = name.toLowerCase()
  let budget = 400
  const walk = (d: string, depth: number): string => {
    if (depth > maxDepth || budget-- <= 0) return ''
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return '' }
    // 先看文件
    for (const e of entries) {
      if (budget-- <= 0) return ''
      if (e.isFile() && e.name.toLowerCase() === want) return path.join(d, e.name)
    }
    // 再进目录（跳过 .nis-history / node_modules 这类噪音）
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === '.nis-history' || e.name === 'node_modules' || e.name.startsWith('.')) continue
      const hit = walk(path.join(d, e.name), depth + 1)
      if (hit) return hit
    }
    return ''
  }
  return walk(dir, 1)
}

/**
 * 解析回复里的媒体指令（对齐官方 openclaw-weixin 的 `MEDIA:` 约定）。
 *
 * 约定：单独一行写 `MEDIA:<绝对路径>` 或 `MEDIA:<https URL>`（可多行）。
 * 为什么用指令而不是 Markdown 图片语法：IM 不渲染 Markdown，图片语法只会显示成一段乱码文本。
 * @returns text=去掉指令行的正文；media=待发送的媒体列表
 */
function extractMediaDirectives(raw: string): {
  text: string
  media: Array<{ path?: string; url?: string; name: string }>
} {
  const media: Array<{ path?: string; url?: string; name: string }> = []
  const keep: string[] = []
  for (const line of String(raw || '').split('\n')) {
    const m = line.trim().match(/^MEDIA:\s*(\S+)\s*$/i)
    if (m) {
      const v = m[1]
      const name = v.split(/[\\/]/).filter(Boolean).pop() || 'file'
      if (/^https?:\/\//i.test(v)) media.push({ url: v, name })
      else media.push({ path: v, name })
      continue
    }
    keep.push(line)
  }
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), media }
}

/** 单文件上限（QQ 富媒体限制；超限直接拒绝并告知，避免 base64 撑爆请求） */
const MEDIA_MAX_BYTES = 20 * 1024 * 1024

/**
 * 把媒体回推到通道。
 * QQ：走富媒体两段式（上传 → msg_type:7 发送）；
 * 微信：CDN 加密上传（getuploadurl → AES-128-ECB → x-encrypted-param）+ image/file item（二十一批补齐）。
 */
async function deliverMediaToChannel(
  target: ChannelDeliverTarget,
  media: { path?: string; url?: string; name: string },
): Promise<void> {
  /** 微信分支：拿 token / context_token → 本地文件走加密上传；URL 先落盘再传 */
  if (target.channel === 'wechat') {
    const wxCfg = getChannel('wechat')
    const wxBot = (wxCfg?.bots || []).find((b: any) => b.id === target.botId) || (wxCfg?.bots || [])[0]
    const wxToken = wxBot?.secret || ''
    if (!wxToken) throw new Error('微信未连接：缺少 bot_token（请在接入弹窗重新扫码）')
    let ctx = target.contextToken
    if (!ctx) {
      try { ctx = getLink(makeChannelKey('wechat', target.botId, target.peerId))?.contextToken } catch { /* ignore */ }
    }
    let localPath = media.path ? path.resolve(media.path) : ''
    if (!localPath && media.url) {
      // 微信 CDN 只收「本地文件上传」，URL 得先落盘
      const got = await downloadImageUrl(media.url, 'wechat-media')
      if (!got) throw new Error(`图片下载失败：${media.url.slice(0, 80)}`)
      const tmp = path.join(DATA_ROOT, 'channel-outbox', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`)
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      fs.writeFileSync(tmp, got.buf)
      localPath = tmp
    }
    if (!localPath) throw new Error('媒体源为空（需要 path 或 url）')
    if (!fs.existsSync(localPath)) throw new Error(`文件不存在：${localPath}`)
    await sendWechatMedia(wxToken, target.peerId, { path: localPath, name: media.name }, ctx)
    return
  }
  if (target.channel !== 'qq') throw new Error(`暂不支持的通道：${target.channel}`)
  let buffer: Buffer | undefined
  if (media.path) {
    const p = path.resolve(media.path)
    if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`)
    const st = fs.statSync(p)
    if (!st.isFile()) throw new Error(`不是文件：${p}`)
    if (st.size > MEDIA_MAX_BYTES) {
      throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，上限 ${MEDIA_MAX_BYTES / 1024 / 1024}MB）`)
    }
    if (st.size === 0) throw new Error('文件是空的')
    buffer = fs.readFileSync(p)
  }
  await sendQqWithFallback(target, (messageId) =>
    sendQqMedia(target.botId, {
      kind: target.kind || 'c2c',
      target: target.peerId,
      messageId,
    }, { fileName: media.name, buffer, url: media.url }))
}

/**
 * 记录「最近一条入站消息 id」（0912 十三批）—— **QQ 省额度用**。
 *
 * 官方限制：不带 msg_id 的推送算「主动消息」，每用户每月仅 4 条；
 * 60 分钟窗口内带上对方刚发的 msg_id 则可走「被动回复」（不限量）。
 * 定时任务推送时优先用它（见 notifyTaskResult）。
 * 幂等：映射不存在（首条消息还没建档）就跳过，调用方可重复调用。
 */
function rememberLastMessageId(channel: string, botId: string, peerId: string, messageId: string, kind?: string): void {
  if (!messageId) return
  try {
    const ck = makeChannelKey(channel, botId, peerId)
    const lk = getLink(ck)
    /**
     * ⚠️ 必须显式带上 lastAt/lastMessageAt（0912 十三批实测踩到）：
     * setLink 的语义是「lastAt 沿用传入值，缺省才取 now」，而 `...lk` 里带着**旧的** lastAt
     * → 窗口判定会拿旧时间去比 60 分钟 → 明明刚收到消息却判成「窗口外」→ 白白消耗主动消息额度。
     */
    if (lk) {
      const next: any = { ...lk, lastMessageId: messageId, lastMessageAt: Date.now(), lastAt: Date.now() }
      if (kind) next.kind = kind
      setLink(ck, next)
    }
  } catch { /* ignore */ }
}

/**
 * 入站即按映射校正会话归属（0912 十三批）。
 *
 * 普通消息路径在 resolveChannelSession 里也会校正（幂等）；这里补的是**命令类消息**
 * （`/list` `/perm` …）：它们不经过 resolveChannelSession，但用户其实正在这个通道里说话，
 * 归属/权限该跟着走（例：任务专属会话被推到微信 + QQ，用户在 QQ 群里发 `/list`，
 * 会话就该归到那台 QQ 机器人，而不是继续挂着微信）。
 */
function healSessionByMapping(channel: string, botId: string, peerId: string, kind?: string): void {
  try {
    const lk = getLink(makeChannelKey(channel, botId, peerId))
    if (!lk) return
    const s = sessions.get(lk.sessionId)
    if (!s) return
    if (healChannelSession(s, channel, botId, peerId, kind)) {
      schedulePersist()
      console.log(`[channel] 按入站校正会话归属 ${lk.sessionId.slice(0, 8)} → ${channel}:${botId}`)
    }
  } catch { /* ignore */ }
}

/** 把一段文本按通道回推（各通道格式差异都在这里收敛） */
/**
 * 0920（#4①）：QQ「被动回复失败 → 主动消息兜底」。
 *
 * 背景：官方被动回复窗口（私聊 60 分钟 / 群 5 分钟）过期、或 msg_id 已失效时，
 * 带 msg_id 的发送会**直接失败**。以前只有**定时任务推送**做了降级兜底（见 notifyTaskResult），
 * 普通回复失败只在 console 里 error 一句 → 用户看到的就是「NIS 里能看到、QQ 里没发出去」。
 *
 * ⚠️ 主动消息每月仅 4 条/用户 → 必须加护栏：同一对端 10 分钟内最多兜底 2 次，
 * 超了只上报错误（宁可失败可见，也别把额度烧光）。
 */
const activeFallbackLog = new Map<string, number[]>()
function activeFallbackAllowed(key: string): boolean {
  const now = Date.now()
  const arr = (activeFallbackLog.get(key) || []).filter((t) => now - t < 10 * 60 * 1000)
  if (arr.length >= 2) { activeFallbackLog.set(key, arr); return false }
  arr.push(now)
  activeFallbackLog.set(key, arr)
  return true
}

/**
 * QQ 官方**被动回复窗口**：收到消息后 5 分钟内、最多 5 条（且必须带该消息的 msg_id）。
 * ⚠️ 以前这里（以及调用侧）用 1 小时判断 —— 那是错的：超过 5 分钟的 msg_id 平台一律拒绝，
 *    于是每次都会先打一发注定失败的被动消息、再降级烧一条**主动消息**额度（每月只有 4 条）。
 *    额度烧完就是"定时任务/机器人回复偶尔不推出去"的直接原因 —— 窗口必须按平台真值收紧。
 */
const QQ_PASSIVE_WINDOW_MS = 5 * 60 * 1000
/** 该对端现在还在 QQ 被动窗口内吗（是则可带 messageId 发，不占额度） */
function qqPassiveWindowOpen(link: { lastMessageId?: string; lastMessageAt?: number } | null | undefined): boolean {
  if (!link?.lastMessageId) return false
  return Date.now() - (link.lastMessageAt || 0) < QQ_PASSIVE_WINDOW_MS
}
/** 先按被动（带 msg_id）发；失败且原来是被动 → 换主动（messageId=''）重发一次 */
async function sendQqWithFallback(
  target: ChannelDeliverTarget,
  doSend: (messageId: string) => Promise<void>,
): Promise<void> {
  try {
    await doSend(target.messageId)
    return
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 160)
    if (!target.messageId) throw e            // 本来就是主动消息，没有可降级的余地
    const key = makeChannelKey('qq', target.botId, target.peerId)
    if (!activeFallbackAllowed(key)) {
      console.warn(`[channel] QQ 被动回复失败，且 10 分钟内兜底次数已用尽（${key.slice(0, 24)}）：${msg}`)
      throw e
    }
    console.warn(`[channel] QQ 被动回复失败（${msg}）→ 降级为主动消息重发一次（占每月 4 条额度）`)
    await doSend('')
    console.log('[channel] QQ 已用主动消息补发成功')
  }
}

/* ── ★1014b：QQ 私聊正文流式（官方 stream_messages，replace 累计全文）────────────────
 * 用户 1014 拍板：**只做正文流式**；「✅ 收到，正在处理…」占位保持独立消息（不并入同一条）。
 * 为什么不并入：官方要求流式内容**只能增长**，占位文案被正文覆盖＝改写 ⇒ 预计 40007
 * （平台直接拒收，本地兜底救不了）。协议明细见知识库 kb_5b3abae3b093。
 *
 * 为什么用"轮询"而不是接 delta 热路径：
 *   · PC 端流式走 delta → broadcastMux（热路径）；通道回推只要 1s 级的"当前全文"，
 *     轮询后端已在维护的 turnAccumulators 是**零侵入**的（不动 delta、不动会话、不动前端）。
 *   · ⚠️ 但**不能直接推 turn.text**：它在 message_end 会被清空（内容进 sequence）⇒ 直接推会
 *     "内容变短"，撞官方"只能增长"规则。所以这里推的是**本轮全文**：
 *       sequence 里已定稿的 text 段 + 当前 turn.text（拼接规则固定 ⇒ 天然单调）。
 *   · 再加一道**本地单调护栏**（新文本必须以上一帧为前缀且更长），把 trim/去重引起的抖动挡在
 *     本地 —— 宁可少推一帧，也绝不发"变短/改写"的帧（那是平台硬错，不是本地 bug）。
 *
 * 降级（"要么流式、要么老路"，绝不两头都发、也绝不静默丢内容）：
 *   · 开关**默认关**（通道配置 qq.stream === true 才启用）⇒ 关闭时行为与改动前完全一致；
 *   · 只对 **c2c 私聊**启用（群聊/频道官方无流式、也无消息编辑能力）；
 *   · 取不到凭据 / 没抢到 msg_seq / 首帧连续失败 / 零帧 → dead，agent_end 照原路一次性回推；
 *   · agent_end 收流成功 → **跳过**原路那条正文（否则用户收到两遍）；
 *   · 收流失败 → 原路补发并记日志（用户最多看到"半截流式 + 一条完整"）。
 */
interface QqStreamState {
  sessionId: string
  /** 本轮回推目标（channel/botId/peerId/messageId/kind/prefix） */
  rt: ChannelReplyTarget
  qq: { botId: string; appId: string; secret: string }
  /** 首帧响应里的 id（后续帧必带）；空 = 首帧还没成功 */
  streamMsgId: string
  /** 本流帧序号（首帧 0，逐帧 +1） */
  index: number
  /** 本流固定 msg_seq（与普通回复共用自增空间，防 (msg_id,msg_seq) 去重撞号） */
  msgSeq: number
  /**
   * ★1014e：本流的 `content_type`（markdown / text）。
   * **开流时定死** —— 同一条流中途改 content_type = 改写，平台会拒（40007 那类）。
   */
  markdown: boolean
  /** 已成功推送出去的文本（单调护栏基准；trimEnd 口径） */
  sent: string
  /** 成功帧数（0 = 一次都没推成功 ⇒ 走降级） */
  frames: number
  /** 连续失败次数（≥3 ⇒ 放弃流式） */
  fails: number
  startedAt: number
  /** 第一次发现"本轮累积器已消失"的时刻（给 agent_end 留收流宽限期） */
  turnGoneAt: number
  timer: ReturnType<typeof setTimeout> | null
  busy: boolean
  dead: boolean
}

const qqStreams = new Map<string, QqStreamState>()
/** 刚收过流的会话（短 TTL）——防止"宽限/超时路径已收流"后 agent_end 又发一遍完整正文（用户看到两遍） */
const qqStreamDone = new Map<string, { at: number; messageId: string }>()
/** 帧间隔：社区实测 0.5s 可用；这里取 1s（更保守、够用） */
const QQ_STREAM_TICK_MS = 1000
/** 单轮流式硬上限（万一 agent_end 没来，也不让定时器永久活着） */
const QQ_STREAM_MAX_MS = 10 * 60 * 1000
/* 单帧正文上限 QQ_STREAM_MAX_CHARS 与两个纯函数（shouldPushFrame 单调护栏 / clipStreamText 截断）
   都在 channels/qqStream.ts 里 —— 放那边是为了能被真跑回归覆盖（见工作区 _verify_qqstream.mts）。 */
/** "累积器消失"后等 agent_end 来收流的宽限期 */
const QQ_STREAM_TAIL_GRACE_MS = 5000

/** 开关（默认关）：通道配置里的 `stream` 字段 —— 先默认关，实测通过再常开 */
function qqStreamEnabled(): boolean {
  try { return (getChannel('qq') as any)?.stream === true } catch { return false }
}

/**
 * ★1014e：QQ 回复是否用 markdown（**默认开**：只有显式 `false` 才关）。
 * 官方 2026-04-23 起对全部机器人开放单聊/群聊自定义 markdown；发送失败会自动回纯文本重发
 * （见 deliverToChannel），所以默认开更划算。频道(channel)不支持，调用处单独排除。
 */
function qqMarkdownEnabled(): boolean {
  try { return (getChannel('qq') as any)?.markdown !== false } catch { return true }
}

/** 凭据取不到时的告警去重（每 bot 只喊一次，避免每轮刷屏，但**不静默**） */
const qqStreamAuthWarned = new Set<string>()

/**
 * 从通道配置取机器人凭据。
 * ⚠️ 必须**按 botId 精确匹配**：多机器人时回退用 bots[0] 会拿错 AppID/Secret（token 属于另一个
 * 应用 ⇒ 发帧必失败，且是"静默用错账号"这种最难查的错）。取不到就返回 null ⇒ 本轮不流式，
 * 走原有一次性回推（用户无感，日志留痕）。
 */
function qqStreamAuth(botId: string): { botId: string; appId: string; secret: string } | null {
  try {
    const bots = ((getChannel('qq') as any)?.bots || []) as any[]
    const bot = bots.find((b) => String(b.id) === String(botId))
    const warnOnce = (key: string, msg: string) => {
      if (qqStreamAuthWarned.has(key)) return
      qqStreamAuthWarned.add(key)
      console.warn(`[qq-stream] ${msg} → 本轮不做流式（退回一次性回推）`)
    }
    if (!bot) { warnOnce('nomatch:' + botId, `通道配置里找不到 bot ${botId}`); return null }
    const appId = String(bot?.accountId || '').trim()
    const secret = String(bot?.secret || '').trim()
    if (!appId || !secret) { warnOnce('nocred:' + botId, `bot ${botId} 缺 AppID/AppSecret`); return null }
    return { botId: String(bot.id), appId, secret }
  } catch { return null }
}

/**
 * 本轮全文（QQ 流式专用口径）。
 * 与 assembleTurnContent 的关键区别：**不做近重复去重**（去重会让已推送的前缀消失 ⇒ 撞平台规则），
 * 只按固定规则拼接；think 清洗与通道回推同口径（实测"露 think"的那条链）。
 */
function qqStreamFullText(st: QqStreamState): string {
  const turn = turnAccumulators.get(st.sessionId)
  if (!turn) return ''
  let body = ''
  for (const item of turn.sequence) {
    if (item.type !== 'text') continue
    const t = stripThinkingEcho(item.text || '', item.reasoning || '').trim()
    if (t) body += (body ? '\n\n' : '') + t
  }
  const tail = stripThinkingEcho(turn.text || '', turn.reasoning || '').trim()
  if (tail) body += (body ? '\n\n' : '') + tail
  if (st.rt.prefix && body) body = `${st.rt.prefix}\n${body}`
  return clipStreamText(body)
}

/** 发一帧（成功 true）。失败只记账：连续 3 次 → dead（交给 agent_end 走降级） */
async function qqStreamSendFrame(st: QqStreamState, text: string, final: boolean): Promise<boolean> {
  try {
    const r = await sendQqStreamFrame(st.qq, {
      openid: st.rt.peerId,
      msgId: st.rt.messageId,
      text,
      index: st.index,
      msgSeq: st.msgSeq,
      inputState: final ? 10 : 1,
      streamMsgId: st.streamMsgId || undefined,
      // ★1014e：与一次性回推保持一致（开流时定死，见 QqStreamState.markdown）
      contentType: st.markdown ? 'markdown' : 'text',
    })
    if (!st.streamMsgId && r.streamMsgId) st.streamMsgId = r.streamMsgId
    st.index += 1
    st.frames += 1
    st.fails = 0
    return true
  } catch (e: any) {
    st.fails += 1
    console.warn(`[qq-stream] 帧失败（第 ${st.fails} 次）session=${st.sessionId.slice(0, 8)}: ${String(e?.message || e).slice(0, 160)}`)
    if (st.fails >= 3) {
      st.dead = true
      if (st.timer) { clearTimeout(st.timer); st.timer = null }
    }
    return false
  }
}

function qqStreamSchedule(st: QqStreamState): void {
  if (st.dead) return
  st.timer = setTimeout(() => { void qqStreamTick(st) }, QQ_STREAM_TICK_MS)
}

/** 丢弃状态（只在还是当前那一条时删，避免"旧流收尾"误删新流） */
function qqStreamDrop(st: QqStreamState): void {
  if (st.timer) { clearTimeout(st.timer); st.timer = null }
  st.dead = true
  if (qqStreams.get(st.sessionId) === st) qqStreams.delete(st.sessionId)
}

/** 定时器一拍：取本轮全文 → 单调护栏 → 推一帧（内容没长就不推，省额度也免被平台去重） */
async function qqStreamTick(st: QqStreamState): Promise<void> {
  if (st.dead) return
  if (st.busy) { qqStreamSchedule(st); return }
  st.busy = true
  try {
    if (Date.now() - st.startedAt > QQ_STREAM_MAX_MS) {
      console.warn(`[qq-stream] 超时收流 session=${st.sessionId.slice(0, 8)}（已推 ${st.frames} 帧）`)
      await qqStreamFinish(st.sessionId, '')
      return
    }
    if (!turnAccumulators.get(st.sessionId)) {
      // 本轮已结束、但 agent_end 的收流还没到 → 给宽限期；超时自行收流（防定时器长活）
      st.turnGoneAt = st.turnGoneAt || Date.now()
      if (Date.now() - st.turnGoneAt > QQ_STREAM_TAIL_GRACE_MS) {
        console.warn(`[qq-stream] 累积器已消失且超宽限 → 自行收流 session=${st.sessionId.slice(0, 8)}`)
        await qqStreamFinish(st.sessionId, '')
        return
      }
      qqStreamSchedule(st)
      return
    }
    st.turnGoneAt = 0
    const text = qqStreamFullText(st)
    if (shouldPushFrame(st.sent, text)) {
      if (await qqStreamSendFrame(st, text, false)) st.sent = text
    }
  } catch (e: any) {
    console.warn(`[qq-stream] tick 异常 session=${st.sessionId.slice(0, 8)}: ${String(e?.message || e).slice(0, 160)}`)
  } finally {
    st.busy = false
  }
  qqStreamSchedule(st)
}

/**
 * 收流：发终帧（input_state:10 + 完整非空正文）。
 * @param fullText 期望的完整正文（agent_end 传 prefixedBody）；空 = 用已推送内容收尾
 * @returns true = 收流成功（调用方**跳过**原路一次性正文，避免重复）；false = 没走流式/收流失败（走降级）
 */
async function qqStreamFinish(sessionId: string, fullText: string): Promise<boolean> {
  const st = qqStreams.get(sessionId)
  if (!st) return false
  if (st.frames === 0 || !st.streamMsgId) {
    // 一次都没推成功 ⇒ 不算流式，清掉让原路发（不给用户留一条空消息）
    qqStreamDrop(st)
    return false
  }
  const clean = (fullText || '').trim()
  /** 终帧内容：优先完整正文，但**必须仍是"已推送内容的超集"**（官方只接受增长）。
   *  若不是超集（trim/去重抖动）→ 用已推送内容收尾：内容可能略少，但绝不被平台拒。 */
  const text = shouldPushFrame(st.sent, clean) ? clipStreamText(clean) : st.sent
  const ok = await qqStreamSendFrame(st, text || '（无输出）', true)
  if (ok) {
    st.sent = text
    // 记一笔"本轮已由流式收尾"（短 TTL）——避免 agent_end 之后再发一条完整正文
    qqStreamDone.set(sessionId, { at: Date.now(), messageId: st.rt.messageId })
    if (qqStreamDone.size > 200) {
      const now = Date.now()
      for (const [k, v] of qqStreamDone) if (now - v.at > 60_000) qqStreamDone.delete(k)
    }
  } else console.warn(`[qq-stream] 终帧失败 session=${sessionId.slice(0, 8)}（已推 ${st.frames} 帧）→ 原路一次性补发`)
  qqStreamDrop(st)
  return ok
}

/** 登记一个流式候选（入站时调用；只登记不立刻发 —— 等模型出字才有内容可推） */
function qqStreamMaybeStart(sessionId: string, rt: ChannelReplyTarget): void {
  if (!qqStreamEnabled()) return
  if (rt.channel !== 'qq') return
  if ((rt.kind || 'c2c') !== 'c2c') return          // 群聊/频道官方无流式
  if (!rt.messageId) return                          // 无 msg_id = 主动消息，不能流式
  const prev = qqStreams.get(sessionId)
  if (prev) {
    if (prev.rt.messageId === rt.messageId) return   // 同一轮重复登记
    void qqStreamFinish(sessionId, '').catch(() => { /* 收旧流失败不影响新流 */ })
  }
  const qq = qqStreamAuth(rt.botId)
  if (!qq) { console.warn('[qq-stream] 取不到 AppID/AppSecret → 本轮不做流式'); return }
  const msgSeq = reserveQqMsgSeq(rt.botId, rt.messageId)
  if (!msgSeq) { console.warn('[qq-stream] 未抢到 msg_seq（机器人未连接？）→ 本轮不做流式'); return }
  const st: QqStreamState = {
    sessionId, rt, qq, streamMsgId: '', index: 0, msgSeq, sent: '',
    markdown: qqMarkdownEnabled(),   // ★1014e：开流时定死（与一次性回推同口径）
    frames: 0, fails: 0, startedAt: Date.now(), turnGoneAt: 0, timer: null, busy: false, dead: false,
  }
  qqStreams.set(sessionId, st)
  console.log(`[qq-stream] 开流 session=${sessionId.slice(0, 8)} → ${String(rt.peerId).slice(0, 8)}（msg_seq=${msgSeq}）`)
  qqStreamSchedule(st)
}

/** 中断 / 会话删除：能收就收（否则 QQ 侧永远停在"生成中"），收不了就丢弃 */
function qqStreamAbort(sessionId: string, note: string): void {
  const st = qqStreams.get(sessionId)
  if (!st) return
  console.log(`[qq-stream] 收流（${note}）session=${sessionId.slice(0, 8)}（已推 ${st.frames} 帧）`)
  void qqStreamFinish(sessionId, '').catch(() => { qqStreamDrop(st) })
}

/**
 * ★1020：这条回复到底有没有按钮？—— 决定文案能不能说"点下面的按钮"。
 * 只在 **QQ 单聊**成立：QQ 群聊/频道会被剥掉（见下面 kb 的判断，避免群里谁都能点别人的按钮），
 * 微信协议里没有按钮类型（官方 MessageItemType 无按钮项）⇒ 对这些通道说"点按钮"是把人指到不存在的东西上。
 */
function channelHasButtons(t: { channel?: string; kind?: string }): boolean {
  return String(t?.channel || '') === 'qq' && String(t?.kind || 'c2c') === 'c2c'
}

async function deliverToChannel(
  target: ChannelDeliverTarget,
  text: string,
  opts: { keyboard?: any } = {},
): Promise<void> {
  const body = (text || '').trim() || '（无输出）'
  const clipped = body.length > 4000 ? body.slice(0, 4000) + '\n…（内容过长已截断）' : body
  if (target.channel === 'qq') {
    const kind = target.kind || 'c2c'
    /** ★1016：命令按钮**只对单聊**（群聊里按钮谁都能点 ⇒ 会误触发别人的会话；与 /pc 同口径） */
    const kb = kind === 'c2c' ? opts.keyboard : undefined
    // 群聊：@ 走**纯文本 `@昵称`**（QQ 客户端会渲染成真 @；⚠️ `<@openid>` 发送侧会原样露出代码，0913 实测翻车）
    // 没人被 @ 时自动补 @ 提问者；正文里误留的 `<@id>` 字面量会被剥掉
    const out = kind === 'group' ? toMentionText(clipped, target.senderName) : clipped
    /**
     * ★1014e：**markdown 优先**（官方 2026-04 起对全部机器人开放）—— 否则模型产出的 `**加粗**`、
     * `# 标题`、列表、表格在 QQ 里全是原始标记，看着很乱。
     * ⚠️ 失败就**回纯文本重发一次**（明确理由：格式没被接受不能让整条回复消失；降级会打日志留痕）。
     * ⚠️ **只对单聊(c2c)开**：群聊里 `@昵称` 靠纯文本被 QQ 渲染成真 @，markdown 下 @ 是否照旧渲染
     *    尚未真机验证 —— 不拿群聊的 @ 语义冒险（要开的话验证通过后一行改动）。频道(channel)同样排除。
     */
    /**
     * ★1016d：**带按钮也必须走 markdown**。真机实测：纯文本(`msg_type:0`) + keyboard 会被官方**静默忽略**
     * —— 消息发出去了、不报错，但客户端就是不显示按钮（截图确认）。官方示例里 keyboard 正是配 `msg_type:2` 的。
     * （之前 1016b 曾因 400 改成纯文本，那个 400 的真因是 keyboard 结构不符 schema，已修。）
     */
    const useMarkdown = qqMarkdownEnabled() && kind === 'c2c'
    await sendQqWithFallback(target, async (messageId) => {
      if (useMarkdown) {
        try {
          await sendQqMessage(target.botId, { kind, target: target.peerId, messageId }, out, { markdown: true, keyboard: kb })
          return
        } catch (e: any) {
          console.warn(`[channel] QQ markdown 发送失败 → 回纯文本重发：${String(e?.message || e).slice(0, 200)}`)
        }
      }
      await sendQqMessage(target.botId, { kind, target: target.peerId, messageId }, out, { keyboard: kb })
    })
    return
  }
  // 微信（官方 ClawBot / iLink）：getupdates 长轮询收 + sendmessage 发。
  // token 存通道配置的 bots[].secret（前端只看到 hasSecret 标记，不下发明文）
  const wxCfg = getChannel('wechat')
  const wxBot = (wxCfg?.bots || []).find((b: any) => b.id === target.botId) || (wxCfg?.bots || [])[0]
  const wxToken = wxBot?.secret || ''
  if (!wxToken) throw new Error('微信未连接：缺少 bot_token（请在接入弹窗重新扫码）')
  // context_token：优先调用方传入，否则从映射取 —— 不带它消息会落不进原会话
  let wxCtx = target.contextToken
  if (!wxCtx) {
    try { wxCtx = getLink(makeChannelKey('wechat', target.botId, target.peerId))?.contextToken } catch { /* ignore */ }
  }
  await sendWechatText(wxToken, target.peerId, clipped, wxCtx)
}

/* ═════════════ ★1020：微信「工具进度提示」（协议 + 官方 SDK 都支持）═════════════
 * 官方能力：CHANGELOG.zh_CN「模型执行 tool 时，发送 TOOL_CALL_START / TOOL_CALL_RESULT 进度消息，
 *           可通过 replyProgressMessages 开关控制（默认开启）」；实现见
 *           backend/_research_wx/package/src/messaging/reply-progress-sender.ts。
 * 为什么接：微信侧没有流式（协议写死 message_state: FINISH），此前"过程完全黑箱"——发一句话就干等
 *           到最后一大段回复；QQ 那边有流式/按钮，微信只能靠进度消息才能看到"在跑什么工具"。
 * 三条纪律：
 *   ① 只对**微信会话**发（QQ 有自己的体系，不掺和）；
 *   ② 每轮上限 WECHAT_TOOL_PROGRESS_MAX 条（长任务不刷屏），轮开始清零；
 *   ③ fire-and-forget：发失败只记日志，绝不拖慢工具执行或影响最终回复。
 */
const WECHAT_TOOL_PROGRESS = true
const WECHAT_TOOL_PROGRESS_MAX = 30
const wechatToolProgressSent = new Map<string, number>()
/** 会话 → 本轮 runId（给微信把同一轮的进度消息归组；官方 msg.run_id 同款，缺省可为空） */
const wechatRunIds = new Map<string, string>()

/** 轮开始清掉该会话的进度计数（避免上一轮的额度把这一轮卡住） */
function resetWechatToolProgress(sessionId: string): void {
  wechatToolProgressSent.delete(sessionId)
  wechatRunIds.set(sessionId, `nis:${Date.now().toString(36)}`)
}

/**
 * 给微信会话发一条工具进度（start / end）。
 * @param phase start = 工具开始（TOOL_CALL_START=11）；end = 工具结束（TOOL_CALL_RESULT=12）
 * @param status end 专用：completed / failed（官方还有 blocked，我们暂无来源）
 */
function notifyWechatToolProgress(
  phase: 'start' | 'end',
  sessionId: string,
  toolName?: string,
  toolCallId?: string,
  status?: string,
): void {
  if (!WECHAT_TOOL_PROGRESS) return
  try {
    const s = sessions.get(sessionId)
    if (!s || String(s.origin || '') !== 'wechat') return
    const botId = String(s.originBot || '')
    const peerId = String(s.originPeer || '')
    if (!botId || !peerId) return
    const sent = wechatToolProgressSent.get(sessionId) || 0
    if (sent >= WECHAT_TOOL_PROGRESS_MAX) return
    const wxCfg = getChannel('wechat')
    const bot = (wxCfg?.bots || []).find((b: any) => b.id === botId) || (wxCfg?.bots || [])[0]
    const token = String(bot?.secret || '')
    if (!token) return
    let ctx = ''
    try { ctx = String(getLink(makeChannelKey('wechat', botId, peerId))?.contextToken || '') } catch { /* ignore */ }
    const now = Date.now()
    const name = String(toolName || 'tool')
    const item = phase === 'start'
      ? { type: 11, create_time_ms: now, is_completed: false, tool_call_start_item: { tool_name: name, tool_call_id: toolCallId } }
      : { type: 12, create_time_ms: now, is_completed: true, tool_call_result_item: { tool_name: name, tool_call_id: toolCallId, status: status || 'completed' } }
    wechatToolProgressSent.set(sessionId, sent + 1)
    void sendWechatToolProgress(token, peerId, item as any, ctx, phase, wechatRunIds.get(sessionId))
  } catch (e: any) {
    console.log(`[channel] 微信工具进度准备失败：${String(e?.message || e).slice(0, 160)}`)
  }
}
/**
 * ★1016：从通道映射算出**按钮场景**（决定给哪一排按钮）。
 * · 执行中 → 「■ 停止」排第一；接管着 PC 会话 → 「在项目里新建 / 回到本对话」；否则 → 常规菜单。
 */
function buttonSceneOf(link: { sessionId?: string } | undefined): ButtonScene {
  const cur = link?.sessionId ? sessions.get(String(link.sessionId)) : undefined
  if (!cur) return {}
  const isPc = !CHANNEL_SIDE_ORIGINS.has(String(cur.origin || '').trim())
  return { running: cur.status === 'running', takingOver: isPc, targetTitle: cur.title }
}

/**
 * ★1016：带**命令按钮**的通道回复。
 * 按钮实际只在**单聊**生效（群里会被剥掉 —— 见 deliverToChannel 的 kb 判断），所以这里不用再判一次。
 * 尾部自动附一句提示，让用户知道为什么按钮长这样。
 */
async function deliverMenu(
  target: ChannelDeliverTarget,
  text: string,
  scene: ButtonScene = {},
): Promise<void> {
  await deliverToChannel(target, `${text}\n\n${channelHasButtons(target) ? commandHint(scene) : '完整命令：发 /help。'}`, { keyboard: buildCommandKeyboard(scene) })
}

/**
 * 定时任务的**专属会话**（0912 十三批）。
 *
 * 语义（用户拍板：「每一个任务就是一条专属会话」）：同一任务每次执行都落进同一条会话 ——
 * 上下文连续（能接着问「昨天的呢」）、会话列表不堆积、推送后 IM 里的回复也继承它。
 *
 * 归属：有通知目标时按**首个目标**打通道标记（origin/originBot/originPeer），
 * 这样它会出现在该机器人的「独享对话」列表里；没有目标就是普通会话。
 * 模型/预设/权限沿用通道配置（与在 IM 里手动聊天一致，避免推送后继续聊时人格/权限错位）。
 */
/**
 * 把一条「定时任务推送」记进目标会话（0912 十七批）。
 *
 * 为什么必须记：该目标的映射被切到了这条会话，用户下一步的回复就在这里发生。
 * 若会话里没有这条通知，AI 会完全不知道对方在回应什么（"ok" 没有指代对象）。
 *
 * ⚠️ 要同时写**展示态**（session.messages）与**模型上下文**（session.transcript）——
 * agent 重建时是从 transcript 回填的，只写 messages 的话 AI 看不到（踩过）。
 */
function appendTaskNotice(sessionId: string, text: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  const now = Date.now()
  const dsh = {
    id: crypto.randomUUID(),
    role: 'assistant' as const,
    content: [{ type: 'text', text }],
    timestamp: now,
    expectFinal: true,
  }
  try {
    if (!Array.isArray(s.messages)) s.messages = []
    s.messages.push(dsh as any)
    s.updatedAt = now
    if (!Array.isArray((s as any).transcript)) (s as any).transcript = []
    ;(s as any).transcript.push({ role: 'assistant', content: [{ type: 'text', text }] })
    // 会话若已有活跃 agent，也补进它的内存上下文（否则本轮它看不到这条）
    /* ★1003 修复 4.61/4.62：原条件 `s.status !== 'running'` 写反了——只在**没有**回合在跑时才补进
     * agent 上下文（那恰恰是最不重要的时刻），会话正在跑时反而不补 ⇒ "用户回 ok、AI 没有指代对象"。
     * 改为无条件补（有活跃 agent 就同步它的内存上下文），注释里"否则本轮它看不到这条"才成立。 */
    {
      const ag = agents.get(sessionId) as any
      if (ag?.state.messages && Array.isArray(ag.state.messages)) {
        ag.state.messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
      }
    }
    broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_updated', message: dsh }, expectFinal: true })
  } catch { /* ignore */ }
  schedulePersist()
}

/** 通知目标的稳定 key（= 通道会话映射键，一目标一会话的索引） */
function notifyTargetKey(t: TaskNotifyTarget): string {
  return makeChannelKey(t.channel, t.botId, t.peerId)
}

/**
 * 定时任务 × 通知目标的**专属会话**（0912 十三批 → 十七批按目标拆分）。
 *
 * 语义（用户拍板 → 实测踩坑后修订）：
 *   · **每个通知目标各一条专属会话** —— 微信一条、群A一条、群B一条，互不共用。
 *     早期版本是「一个任务一条」，结果「微信 + 群A」共用同一条 → 群里别人的聊天记录
 *     被微信里的回复看到（用户实测：微信里回个 ok，AI 却接上了群里日语/英语的话题）。
 *   · 无通知目标时退化为「一个任务一条」（ownSessionId）。
 *   · 归属打在该目标上（origin/originBot/originPeer/originKind）→ 它出现在对应目标的
 *     「独享对话」列表里，可溯源（标题带 ⏰ + 目标名）。
 *   · 模型/预设/权限沿用该通道配置，避免推送后继续聊时人格/权限错位。
 */
function ensureTaskOwnSession(task: any, target?: TaskNotifyTarget): string {
  const key = target ? notifyTargetKey(target) : ''
  const known = key ? String((task?.ownSessions || {})[key] || '') : String(task?.ownSessionId || '')
  if (known && sessions.has(known)) return known
  const primary = target
  const mc = primary ? modelForChannel(primary.channel, primary.botId) : null
  const s = createSession(
    `⏰ ${String(task?.name || '定时任务')}`,
    primary
      ? channelWorkDir(primary.channel, primary.peerId)
      : path.join(DATA_ROOT, 'scheduled-workspaces', String(task?.id || 'task')),
    mc?.presetId || undefined,
    undefined, undefined,
    primary?.channel,
  )
  if (primary) {
    s.originPeer = primary.peerId
    s.originBot = primary.botId
    if (primary.kind) s.originKind = primary.kind
    /**
     * ★1020（已定案）：**定时任务会话默认「自审计」** —— 用户原话"定时任务还真需要默认自审计，毕竟不是聊天"：
     * 任务跑起来没人守着，卡在审批上就等于任务失败。
     * 历史：这里原来写 `if (mc?.permissionMode) s.permissionMode = mc.permissionMode`（套那个已删的"通道级权限档"，
     * 取值是通道配置里的陈旧值，语义不稳）；现在**显式写死 self_audit**，与通道配置彻底解耦。
     * 注意：这只是**建会话时的默认值**，用户在 PC 上仍可手动切这条会话的档位（对话自己的权限优先）。
     */
    s.permissionMode = 'self_audit'
    if (mc?.modelId) {
      s.model = mc.modelId
      s.modelProviderId = resolveModelProviderId(mc.modelId) || undefined
    }
    if (mc?.effort) s.effort = mc.effort
  }
  /**
   * 0912 十九批：打上「定时任务支线」标记 ——
   * 前端据此打 ⏰、右键改「放回定时任务」、并**禁止直接删**（只能删任务）。
   * 是否进主对话列表：IM 位置默认不进（穿插模式，安静）；「列表通知」位置由调用方置 true。
   */
  s.taskId = String(task?.id || '') || undefined
  s.inMainList = primary?.channel === 'list' ? true : false
  try { setOwnSession(String(task?.id || ''), key, s.id) } catch { /* ignore */ }
  schedulePersist()
  broadcastHost({ type: 'host/session-added', sessionId: s.id, blank: true, cwd: s.workDir ?? process.cwd() })
  console.log(`[scheduledTasks] 为「${task?.name}」创建专属会话 ${s.id.slice(0, 8)}${primary ? `（归属 ${primary.channel}:${primary.botId}）` : ''}`)
  return s.id
}

/**
 * 任务结果推送到通道（0912 十三批）。
 *
 * 做两件事：
 *   ① 把本轮最终文本发到每个通知目标（微信主动推送 / QQ 主动消息 —— **QQ 额度敏感**）
 *   ② 推送成功后把该对端的映射**切到任务专属会话** → 用户收到推送后回一句，
 *      继承的是任务上下文（用户明确要的行为），而不是他原来那台机器人的日常对话。
 *
 * QQ 省额度：60 分钟窗口内该对端发过消息 → 用其最后一条消息 id 走**被动回复**（不消耗每月 4 条额度）。
 */
async function notifyTaskResult(task: any, sessionId: string, targets: TaskNotifyTarget[]): Promise<void> {
  if (!targets.length || !sessionId) return
  const raw = extractFinalAssistantText(sessionId).trim()
  const name = String(task?.name || '定时任务')
  const text = raw
    ? `⏰ 定时任务「${name}」已完成：\n\n${raw}`
    : `⏰ 定时任务「${name}」已执行完成（本轮没有文字输出，可在电脑端打开对话查看详情）。`

  for (const t of targets) {
    try {
      /**
       * 先把该目标的专属会话准备好（**在发送之前**）——
       * 这样即使这次推送失败，落点也已存在，用户下次在这个通道说话仍能接上任务上下文。
       */
      const own = ensureTaskOwnSession(task, t)
      /**
       * 「列表通知」位置（0912 十九批）：**不推 IM**，只把通知落进它自己的支线会话并让它出现在对话列表里
       * （用户设计：这种通知就在列表里等我，不想被打扰；也零额度消耗）。
       */
      const isList = (t.channel as string) === 'list'
      const key = isList ? '' : makeChannelKey(t.channel, t.botId, t.peerId)
      const link = key ? getLink(key) : null
      /**
       * ⚠️ 顺序很重要（0920 修）：**先把通知记进支线会话，再尝试推 IM**。
       * 以前是推完才记 —— 推送失败时被外层 catch 吃掉，于是「IM 里没有、NIS 里也没有」，
       * 用户完全不知道任务到底跑没跑（"定时任务偶尔不推送"的体感来源）。
       */
      if (own !== sessionId) appendTaskNotice(own, text)
      let pushErr = ''
      if (!isList) {
        let messageId = ''
        let mode: 'passive' | 'active' = 'active'
        // 窗口用 lastMessageAt（入站消息到达时间）判 —— 不用 lastAt（会被推送刷新）
        if (t.channel === 'qq' && qqPassiveWindowOpen(link)) {
          messageId = String(link?.lastMessageId)
          mode = 'passive'
        }
        const modeLabel = t.channel !== 'qq' ? '微信'
          : mode === 'passive' ? 'QQ 被动回复（不占额度）' : 'QQ 主动消息（占每月 4 条额度）'
        // 先记一行「准备怎么推」—— 推送失败时也能看出走的是哪条路（排查额度/窗口问题靠它）
        console.log(`[scheduledTasks] 「${name}」→ 推送 ${t.label || `${t.channel}:${t.botId}`} · ${modeLabel}`)
        const body: ChannelDeliverTarget = {
          channel: t.channel as 'qq' | 'wechat',
          botId: t.botId,
          peerId: t.peerId,
          messageId,
          // 对端类型优先取映射（权威、按对端存），其次才是任务里存的快照 —— 决定 QQ 发 users 还是 groups
          kind: (link?.kind as 'c2c' | 'group' | 'channel' | undefined) || (t.kind as any) || 'c2c',
        }
        try {
          await deliverToChannel(body, text)
        } catch (e: any) {
          /**
           * 被动回复失败 → **降级为主动消息重试一次**。
           * 为什么值得：被动窗口可能因为「用户刚清空/撤回」「msg_id 已过期」等失败，
           * 而任务通知的价值就在于送达 —— 宁可多花 1 条额度，也别让用户什么都收不到。
           * （窗口按平台真值 5 分钟判定后，走到这里的多半是真失败，不再是"注定失败的过期 msg_id"。）
           */
          if (mode !== 'passive') {
            pushErr = String(e?.message || e).slice(0, 200)
          } else {
            console.warn(`[scheduledTasks] 「${name}」被动回复失败，降级为主动消息重试: ${String(e?.message || e).slice(0, 140)}`)
            try {
              await deliverToChannel({ ...body, messageId: '' }, text)
              console.log(`[scheduledTasks] 「${name}」已用主动消息补发（占每月 4 条额度）`)
            } catch (e2: any) {
              pushErr = String(e2?.message || e2).slice(0, 200)
            }
          }
        }
      }
      /**
       * 这条通知记进它**自己的**支线会话 —— 用户追问（`/回复通知`）时 AI 才看得到在说什么。
       *
       * ⚠️ 0912 十九批起**不再切映射**（早期会 setLink 把落点抢到任务会话）：
       * 用户明确要「穿插通知」—— 我继续聊我的，任务线单独一条；
       * 抢落点会把主线对话切走，正是之前串台/错乱的根源。
       */
      if (isList) {
        // 列表通知：默认就出现在主对话列表里（带 ⏰），可右键「放回定时任务」
        const bs = sessions.get(own)
        if (bs && bs.inMainList !== true) { bs.inMainList = true; schedulePersist() }
      }
      if (pushErr) {
        // 推送失败**必须可见**：写进会话，用户在 NIS 里就能看到"没发出去 + 原因"
        if (own !== sessionId) {
          appendTaskNotice(own, `⚠️ 这条通知没能推送到 ${t.label || `${t.channel}:${t.botId}`}：${pushErr}`)
        }
        console.warn(`[scheduledTasks] 「${name}」推送失败（${t.channel}:${t.botId}）: ${pushErr}`)
      } else {
        console.log(`[scheduledTasks] 「${name}」推送完成 → ${isList ? '列表通知' : '穿插通知'} · 支线 ${own.slice(0, 8)}`)
      }
      /**
       * 记一笔「待回复通知」（0912 十九批）—— 只有 IM 位置需要：
       * 用户想就这条通知追问时用 `/回复通知 内容`，靠它知道该送进哪条支线。
       * （列表位置直接在对话列表里点开就能聊，不需要台账。）
       */
      try {
        if (t.channel !== 'list') {
          recordNotice(t.channel, t.botId, t.peerId, {
            taskId: String(task?.id || ''),
            taskName: name,
            sessionId: own,
            text,
          })
        }
      } catch { /* 记账失败不影响推送 */ }
    } catch (e: any) {
      console.warn(`[scheduledTasks] 「${name}」推送失败（${t.channel}:${t.botId}）: ${String(e?.message || e).slice(0, 200)}`)
    }
  }
}



/**
 * 组装「IM 场景上下文」—— 注入给 AI，让它知道自己在哪个场景、跟谁说话、有什么做不到的。
 *
 * 为什么要这么细（0912 十四批，用户实测反馈）：
 *   ① 之前一律写「对方正在 QQ 手机端与你对话」→ 在群里说话时 AI 以为在一对一，
 *      甚至回答「我没在任何 QQ 群里啊」（用户实测原话）；
 *   ② QQ 群事件带了 member_openid / username / member_role / mentions，之前**全丢** →
 *      AI 分不清是谁在说话、也不知道消息里 @ 了谁；
 *   ③ AI 会顺着用户**假装** @ 了人 / 发了图 → 必须把平台能力边界写进提示词，否则它会瞎编。
 */
function buildImContext(o: {
  channel: 'qq' | 'wechat'
  kind?: string
  /** 机器人自己在这个平台的昵称（READY 事件给的） */
  botName?: string
  /** 群/频道的短标识（用于让 AI 区分不同群） */
  peerTag?: string
  sender?: { label: string; id?: string; role?: string }
  mentions?: Array<{ id?: string; name?: string }>
  roster?: Array<{ label: string; id?: string; role?: string }>
  /** 旁听到的群聊流水（背景；需群主开启「获取群内全部消息」才会有） */
  background?: Array<{ time: string; label: string; text: string }>
  /** 二十一批：本轮携带的图片（已落盘）—— AI 能直接看到；路径可用于原样转发（MEDIA: 行） */
  images?: Array<{ path: string; bytes?: number }>
  /** 0920：本会话的工作区（通道会话是**独立空目录**，避免 AI 以为能读到用户的桌面项目） */
  workspace?: string
}): string {
  const chName = o.channel === 'qq' ? 'QQ' : '微信'
  const isGroup = o.kind === 'group' || o.kind === 'channel'
  const sceneName = o.kind === 'group' ? '群聊' : o.kind === 'channel' ? '频道' : '单聊'
  const bot = o.botName ? `（你在这个平台的昵称是「${o.botName}」）` : ''
  const sid = (id?: string) => (id ? id.slice(0, 6) : '')
  const roleTag = (r?: string) => (r === 'owner' ? '群主' : r === 'admin' ? '管理员' : '')

  const lines: string[] = []
  if (isGroup) {
    lines.push(`[系统提示：场景 = ${chName}**${sceneName}**${o.peerTag ? `（标识 ${o.peerTag}）` : ''}${bot}。群里除你之外还有其他人，你的每条回复**所有人都能看到**。`)
    if (o.sender) {
      const r = roleTag(o.sender.role)
      lines.push(`本次跟你说话的人：${o.sender.label}${r ? `（${r}）` : ''}${o.sender.id ? `〔成员标识 ${sid(o.sender.id)}〕` : ''}。`)
    }
    if (o.roster && o.roster.length > 1) {
      lines.push(`这个群里你见过的人：${o.roster.map(m => `${m.label}${roleTag(m.role) ? `(${roleTag(m.role)})` : ''}${m.id ? `〔${sid(m.id)}〕` : ''}`).join('、')}。`)
    }
    if (o.mentions?.length) {
      lines.push(`这条消息里 @ 了：${o.mentions.map(m => m.name || (m.id ? `成员${sid(m.id)}` : '某人')).join('、')}。`)
    }
    /**
     * 背景流水：群主开了「获取群内全部消息」后，机器人能旁听到的群聊。
     * 没有这段时 AI 对「刚才谁说了什么」只能瞎猜（早期它甚至会说"我看不到"），
     * 所以两种情况都要写清楚 —— 有就给，没有就明确告知"看不到，别编"。
     */
    if (o.background && o.background.length) {
      lines.push('以下是你**最近在旁边看到**的群聊消息（背景参考；不用逐条回应它们，但有人问起群里刚聊了什么时，可以据此如实回答）：')
      for (const b of o.background) lines.push(`  [${b.time}] ${b.label}：${b.text}`)
    } else {
      lines.push('你暂时没有收到群聊背景（群里最近没人说话，或群主未开启「机器人可获取的群内全部消息」）。被问起"刚才群里谁说了什么"时，如实说你没看到最近的消息，不要编。')
    }
    lines.push('平台能力边界（必须如实遵守，不要假装做不到）：① 群里要叫谁就直接写「@昵称」（如「@小明 你看下」）；昵称必须与上面的群成员名单一致，不确定是谁就不要 @；② 不要把没做过的事说成做过。')
  } else {
    lines.push(`[系统提示：场景 = ${chName}**单聊**${bot}，只有你和对方两个人。`)
    // 「对方」是没拿到昵称时的占位 —— 写出来就是「对方：对方」，无信息量，直接省掉
    if (o.sender && o.sender.label && o.sender.label !== '对方') {
      lines.push(`对方：${o.sender.label}${o.sender.id ? `〔标识 ${sid(o.sender.id)}〕` : ''}。`)
    }
  }
  /**
   * 二十一批：本轮带图时明确告诉 AI「图已就位、能看」——
   * 并给文件路径：要原样转发/给别人发时写 MEDIA:<路径> 即可（否则它只能靠文字复述）。
   */
  if (o.images?.length) {
    lines.push(`本轮对方发来 ${o.images.length} 张图片（你**能直接看到**，图已经附在这条消息里）。`)
    for (const im of o.images) lines.push(`  图片文件（要原样转发时用 MEDIA: 行）：${im.path}`)
  }
  /**
   * 0920（#4③）：**说清工作区**。
   * 通道会话的工作区是「与桌面会话隔离」的独立目录（`DATA_ROOT/channel-workspaces/...`），
   * 里面通常什么都没有 —— 不说明的话 AI 容易顺着"工作区"这个词去假装读过用户的项目文件，
   * 或者反复尝试找不存在的路径（表现就是"变傻"）。
   */
  if (o.workspace) {
    /**
     * ★1014f：工作区现在有**两类**，说反了都会让 AI 表现反常 ——
     *   · 通道自己的隔离目录（channel-workspaces/…）→ 必须如实说"看不到 PC 项目"，
     *     否则它会顺着"工作区"这个词假装读过用户的项目文件（表现就是"变傻"）
     *   · 被 `/pc` 接管的 **PC 项目会话**（workDir = 项目根）→ 必须说"能读写、直接干"，
     *     否则就是"接上了还装瞎"（用户实测最烦的那种）
     */
    const isChannelWs = String(o.workspace).replace(/\\/g, '/').includes('channel-workspaces')
    if (isChannelWs) {
      lines.push(`你的工作区：${o.workspace}（与 PC 端的项目是**分开的**独立目录，通常里面是空的）。对方发来的文件会被放到该目录下的 inbox/。`
        + `要读 PC 端项目里的文件请如实说做不到（让对方在 PC 端问，或把文件发给你）；也可以提醒对方：发 /pc 可以接管 PC 端会话。）`)
    } else {
      lines.push(`你的工作区：${o.workspace} —— 这是用户在 **PC 端干活的项目目录**，你**能直接读写**（手机遥控场景）。`
        + `动手前先看目录结构或项目档案（如 NIS-notes.md）再改；对方发来的文件会被放到该目录下的 inbox/。`
        + `对方在手机上看不到你的工具调用细节 —— 回复里要点式说清「做了什么、动了哪个文件」，别只说"已完成"。`)
    }
  }
  /**
   * ★1014e：回复格式要求**必须与实际渲染能力一致**（否则模型按提示词输出纯文本，markdown 白开）。
   * · 旧口径"不要用 Markdown（QQ 不渲染）"是**纯文本时代**（msg_type:0）的正确写法，现已过时。
   * · QQ **单聊**已开 markdown 渲染（默认开，与 deliverToChannel 的 useMarkdown 同条件）；
   *   群聊暂不放开（`@昵称` 靠纯文本渲染成真 @，markdown 下是否照旧未验证）。
   * · Markdown **图片语法**两个平台都不渲染 → 那句始终保留（发图继续走 MEDIA 行）。
   */
  const mdOk = o.channel === 'qq' && !isGroup && qqMarkdownEnabled()
  lines.push(`回复要求：① ${mdOk
      ? '回答简短平实；可以用 Markdown 排版（加粗、列表、标题都会正常渲染）'
      : `用简短平实的纯文本，不要用 Markdown 标记（${chName} 不渲染）`}；② 除非对方明确要求做事，否则不要调用工具，直接回答即可；③ 需要较长内容时给出要点即可；④ 要把文件或截图发给对方：在回复里**单独一行**写 MEDIA:<文件的绝对路径>（例如 MEDIA:D:\\shots\\a.png），可写多行，系统会自动作为附件发出去 —— 不要只在文字里说"已经发给你了"而不写 MEDIA 行，也不要使用 Markdown 图片语法（图片语法不渲染，发图请用 MEDIA 行）。]`)
  return lines.join('\n') + '\n\n'
}

/**
 * 组装「群聊背景流水」（真路径与联调路径共用，避免两套逻辑漂移）。
 * @param current 当前正在回复的那条消息 —— 要过滤掉（它已作为本轮消息给 AI 了，重复出现只会让它困惑）
 */
function collectImBackground(
  channel: string,
  peerId: string,
  current?: { messageId?: string; text?: string },
): Array<{ time: string; label: string; text: string }> | undefined {
  try {
    // 二十三批：窗口 10 → 20 条（用户实测「问 Kuai 说了啥它说看不到」—— 10 条太容易把话题顶出去）
    const lines = recentGroupLines(channel, peerId, 20)
      .filter(l => (!current?.messageId || l.messageId !== current.messageId) && (!current?.text || l.text !== current.text))
      .map(l => ({
        time: new Date(l.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        label: l.label,
        text: l.text.length > 120 ? l.text.slice(0, 120) + '…' : l.text,
      }))
    return lines.length ? lines : undefined
  } catch { return undefined }
}

/**
 * 某个**对端**名下的对话列表（0912 十六批）—— `/list` 与 `/switch` 共用，保证两边口径一致。
 *
 * 为什么必须按对端收口（用户要求）：
 *   同一台机器人可能同时被多人私聊、还进了好几个群。把它们的会话混成一张表，用户根本分不清哪条是哪个，
 *   而且会把**别人的会话标题**暴露在当前对话里。所以：
 *     私聊 → 只列这条私聊的；A 群 → 只列 A 群的；B 群 → 只列 B 群的。
 */
function peerScopedSessions(channel: string, botId: string, peerId: string): SessionView[] {
  const list = Array.from(sessions.values())
    .filter(s => (s.origin || '') === channel
      && (s.originBot || '') === botId
      && (s.originPeer || '') === peerId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  /**
   * 兜底：把「当前映射指向的会话」也放进来（即使它的 originPeer 因为历史原因对不上）。
   * 否则会出现「列表里没有当前对话、也就没有『← 当前』标记」的诡异情况。
   */
  try {
    const cur = getLink(makeChannelKey(channel, botId, peerId))
    const cs = cur ? sessions.get(cur.sessionId) : undefined
    if (cs && !list.some(s => s.id === cs.id)) list.unshift(cs)
  } catch { /* ignore */ }
  return list
}

/* ══════════════════════════════════════════════════════════════════════════
   ★1014f：PC 会话接管（`/pc` / `/home`）
   ──────────────────────────────────────────────────────────────────────────
   背景：通道会话的工作区是隔离目录（`channel-workspaces/…`），跟用户 PC 上干活的项目
   不是一回事 —— 出门后用手机只能新开对话、还摸不到项目文件。
   关键事实：**会话自带 workDir / projectId**，所以「接上项目」不需要新概念，
   只要把当前映射指到那条 PC 会话即可（`resolveChannelSession` ①命中映射就复用、
   不碰 workDir —— 见 8445 起的注释）。
   安全：只在私聊 + 配对白名单放行（channels/pcAccess.ts）；群聊/频道一律拒绝。
   ══════════════════════════════════════════════════════════════════════════ */

/** 通道侧来源：这些 origin 的会话不算「PC 会话」 */
const CHANNEL_SIDE_ORIGINS = new Set(['qq', 'wechat', 'remote', 'scheduled', 'task'])

/** PC 端会话口径（`/pc` 列表）：排除通道来源，按最近活动倒序；mode 过滤聊天/项目（1015 B） */
function pcScopedSessions(limit = 10, mode: '' | 'chat' | 'proj' = ''): SessionView[] {
  return Array.from(sessions.values())
    .filter(s => !CHANNEL_SIDE_ORIGINS.has(String(s.origin || '').trim()) && !!String(s.workDir || '').trim())
    .filter(s => (mode === 'chat' ? !String(s.projectId || '').trim() : mode === 'proj' ? !!String(s.projectId || '').trim() : true))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
}

/** 相对时间（IM 文案够用即可） */
function relTimeText(ts?: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

/** PC 会话在列表里的一行标识：`[项目·目录名] 标题` / `[聊天] 标题`（1015 A：一眼分清） */
function pcSessionLabel(s: SessionView): string {
  const dir = String(s.workDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return String(s.projectId || '').trim() ? `[项目·${dir || '未命名'}] ${s.title}` : `[聊天] ${s.title}`
}

/** 接管某条 PC 会话（序号路径与关键词路径共用同一句话术） */
function takePcSession(tgt: SessionView): { reply: string; switchTo: string } {
  return {
    reply: `已接管 PC 会话「${tgt.title}」\n工作区：${tgt.workDir}\n\n`
      + `之后直接发消息即可（这条会话的上下文、项目文件都在）。/home 退回本对话。`,
    switchTo: tgt.id,
  }
}

/**
 * `/pc` 的核心逻辑（真机路径与 PC 联调 RPC 共用，避免两套漂移）。
 * @param trusted 来自 PC 本机（联调面板）→ 免配对、免群聊闸（请求并非来自群里）
 * @returns reply=回给用户的话；switchTo=要把当前映射指过去的会话 id（空则只回话不切）
 */
function pcCommandCore(opts: {
  channel: string; botId: string; peerId: string; kind?: string; args: string; curSessionId?: string; trusted?: boolean
}): { reply: string; switchTo?: string; keyboard?: any } {
  const { channel, botId, peerId, args, curSessionId, trusted } = opts
  const arg = String(args || '').trim()

  if (!trusted && (opts.kind === 'group' || opts.kind === 'channel')) {
    return { reply: '群聊/频道里不能接管 PC 会话（会暴露给群里所有人）。请私聊我操作。' }
  }

  if (!trusted && !isPaired(channel, botId, peerId)) {
    if (!arg) {
      /** ★1015：顺手把**这台机器人自己**的码打到后端控制台（每机器人一个码；码绝不回给 IM） */
      getPairCode(botId)
      return { reply: 'PC 会话接管还没配对。\n\n配对码在 PC 端这里：\n'
        + `· 文件 ${pcAccessFilePath()}（看 botCodes 里这台机器人 ${botId || '（未指定）'} 的码）\n`
        + '· 或后端控制台日志里搜 [pcAccess]\n\n'
        + '拿到后发：/pc <6 位配对码>（每台机器人各自的码不一样，换码后要重配）' }
    }
    if (!/^\d{6}$/.test(arg)) return { reply: '配对码是 6 位数字。用法：/pc <6 位配对码>' }
    const r = tryPair(channel, botId, peerId, arg)
    if (r === 'locked') return { reply: '配对码连续输错 5 次，锁定 10 分钟后再试。' }
    if (r === 'bad') return { reply: '配对码不对（连错 5 次会锁 10 分钟）。' }
    return { reply: '✅ 配对成功。\n\n/pc 看 PC 端会话列表，/pc <序号> 接管；/home 退回本对话。' }
  }

  // B（1015）：/pc chat 只看聊天、/pc proj 只看项目
  const mode: '' | 'chat' | 'proj' = /^chat$/i.test(arg) ? 'chat' : /^(proj|project)$/i.test(arg) ? 'proj' : ''
  const list = pcScopedSessions(10, mode)
  if (!arg || mode) {
    if (!list.length) {
      return { reply: mode
        ? `没有${mode === 'chat' ? '聊天' : '项目'}类的会话。发 /pc 看全部。`
        : 'PC 端还没有带工作区的会话。先在 PC 上建个项目/开个对话再试。' }
    }
    const lines = list.map((s, i) => {
      const cur = curSessionId === s.id ? ' ← 当前' : ''
      const run = s.status === 'running' ? ' ⏳执行中' : ''
      return `${i + 1}. ${pcSessionLabel(s)} · ${relTimeText(s.updatedAt)}${run}${cur}`
    })
    const head = mode === 'chat' ? '【PC 端·聊天】' : mode === 'proj' ? '【PC 端·项目】' : '【PC 端会话】'
    /**
     * ★1016h：**列表按钮化**（与 /list 同款）—— 点一下直接接管那条，不用再发 `/pc <序号>`。
     * 只给前 6 条，且按钮**只显示序号**（官方 label ≤10 字符，放标题必然截断；上面文字里的名字是完整的）。
     */
    const keyboard = buildItemKeyboard('nis_pc',
      list.slice(0, 6).map((_s, i) => ({ label: String(i + 1), cmd: `/pc ${i + 1}` })), 3)
    const hasBtn = channelHasButtons({ channel, kind: opts.kind })
    return {
      reply: `${head}（共 ${list.length} 个 · 按最近活动排序）\n\n${lines.join('\n')}\n\n`
        + (hasBtn
          ? `点下面的**序号按钮**直接接管；也可以发 /pc <序号> 或 /pc <关键词>。\n`
          : `发 /pc <序号> 或 /pc <关键词> 接管。\n`)
        + (mode ? `/pc 看全部。\n` : `/pc chat 只看聊天 · /pc proj 只看项目。\n`)
        // ★1020：顺手修过期文案（1013g 已删通道级权限档）
        + `/home 退回本对话。\n⚠️ 接管后沿用这条对话自己的权限档（/perm 可调；建议「每次确认」）。`,
      keyboard,
    }
  }

  const n = parseInt(arg, 10)
  if (!Number.isFinite(n)) {
    // C（1015）：/pc <关键词> 直接接管（匹配目录名或标题，省得数序号）
    if (/^[\w\u4e00-\u9fa5.-]{1,24}$/.test(arg)) {
      const kw = arg.toLowerCase()
      const hit = pcScopedSessions(50).filter(s =>
        String(s.workDir || '').toLowerCase().includes(kw) || String(s.title || '').toLowerCase().includes(kw))
      if (hit.length === 1) return takePcSession(hit[0])
      if (hit.length > 1) {
        return { reply: `匹配「${arg}」的有 ${hit.length} 条 —— 发序号更准：\n\n`
          + hit.slice(0, 10).map((s, i) => `${i + 1}. ${pcSessionLabel(s)} · ${relTimeText(s.updatedAt)}`).join('\n') }
      }
      return { reply: `没找到匹配「${arg}」的会话。发 /pc 看全部（/pc chat · /pc proj 可过滤）。` }
    }
    return { reply: '用法：/pc 看列表；/pc <序号|关键词> 接管；/pc chat|proj 过滤；/pc <6 位配对码> 首次配对。' }
  }
  if (n < 1 || n > list.length) return { reply: `序号超出范围（1-${list.length}）。发 /pc 看列表。` }
  return takePcSession(list[n - 1])
}

/** `/home`：从接管的 PC 会话退回本对端自己的会话 */
function homeCommandCore(opts: { channel: string; botId: string; peerId: string; curSessionId?: string }): { reply: string; switchTo?: string } {
  const own = Array.from(sessions.values())
    .filter(s => (s.origin || '') === opts.channel && (s.originBot || '') === opts.botId && (s.originPeer || '') === opts.peerId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const back = own.find(s => s.id !== opts.curSessionId)
  if (!back) return { reply: '本对话还没有自己的会话，发 /new 开一个。' }
  return { reply: `已退回本对话「${back.title}」。`, switchTo: back.id }
}

/**
 * 把当前映射切到目标会话（真机路径与 RPC 路径共用落点）。
 * ⚠️ setLink 是**整条覆盖** → 必须保留被动回复窗口等字段（否则 QQ 主动消息额度白烧）。
 * ⚠️ 故意**不改 origin/originPeer**：那是 PC 会话的名分，改了它在 PC 侧栏就变样；
 *    列表可见性靠 peerScopedSessions 的「当前映射兜底」保证（所以还能切回来）。
 */
function switchLinkTo(key: string, sessionId: string, channel: string, botId: string, peerId: string, kind?: string): void {
  const old = getLink(key)
  setLink(key, {
    sessionId, channel, botId, peerId,
    kind: old?.kind || kind,
    lastMessageId: old?.lastMessageId,
    lastMessageAt: old?.lastMessageAt,
    contextToken: old?.contextToken,
  })
  schedulePersist()
}

/** 对端场景中文名（私聊/群聊/频道）—— /list 的表头与行尾标记共用 */
function sceneLabel(kind?: string): string {
  return kind === 'group' ? '群聊' : kind === 'channel' ? '频道' : '私聊'
}

/**
 * ★1014f：会话在 `/list` 里的来源标记。
 * 被 `/pc` 接管的 PC 会话 origin 不是本通道 → 标「PC」，否则用户会在自己的对话列表里
 * 看到一条"私聊"却其实是电脑上的项目会话（会懵）。
 */
function sessionSceneTag(s: SessionView, channel: string, fallbackKind?: string): string {
  return (s.origin || '') === channel ? sceneLabel(s.originKind || fallbackKind) : 'PC'
}

/** 待回复通知清单的文案（IM 与 PC 联调面板共用） */
function noticeListText(channel: string, botId: string, peerId: string): string {
  const list = listNotices(channel, botId, peerId, 5)
  if (!list.length) return '最近没有定时任务通知。'
  const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const lines = list.map((n, i) => `${i + 1}. ${n.taskName} · ${fmt(n.at)}${n.repliedAt ? '（已回复）' : ''}`)
  return `最近的定时任务通知（${list.length} 条）：\n\n${lines.join('\n')}\n\n/回复通知 内容 追问最近一条；/回复通知2 内容 指定第 2 条。`
}

/**
 * `/回复通知` 的共同实现（IM 与 PC 联调面板共用）。
 *
 * ⚠️ 关键：**不改映射**（不 setLink）—— 内容送进该通知的支线会话，
 * 回复发回本通道并带 `⏰任务名` 前缀，主线对话继续走它自己的落点。
 *
 * @returns 需要立刻回给用户的文案；`''` = 不用即时回复（回复会带前缀随后发回）
 */
async function handleNoticeReply(
  channel: 'qq' | 'wechat',
  botId: string,
  peerId: string,
  content: string,
  noticeIdx: number,
  target: ChannelDeliverTarget,
): Promise<string> {
  const text = String(content || '').trim()
  if (!text) return '用法：/回复通知 内容（追问最近一条通知）或 /回复通知2 内容（第 2 条）。\n发 /通知 看清单。'
  const list = listNotices(channel, botId, peerId, 5)
  if (!list.length) return '最近没有定时任务通知。'
  const pick = noticeIdx >= 1 ? (noticeIdx <= list.length ? list[noticeIdx - 1] : null) : list[0]
  if (!pick) return `序号超出范围（当前 1-${list.length}）。发 /通知 看清单。`
  const bs = sessions.get(pick.sessionId)
  if (!bs) return '那条通知的对话已不存在（可能任务被删了）。'
  if (bs.status === 'running') return '那条通知的对话正在执行，稍后再试（或发 /stop 停掉）。'
  const prefix = `⏰ ${pick.taskName}`
  pushReplyTarget(pick.sessionId, { ...target, startedAt: Date.now(), prefix } as any)
  rememberInbound(pick.sessionId, { ...target, startedAt: Date.now(), prefix } as any)
  markNoticeReplied(channel, botId, peerId, pick.id)
  void runPromptCore(pick.sessionId, { message: text }).catch((e: any) => {
    void deliverToChannel(target, `追问失败：${String(e?.message || e).slice(0, 150)}`)
      .catch((e2) => swallowed('IM 追问失败通知未发出（对方不知道任务失败了）', e2))
  })
  return ''
}

/**
 * 0912 二十一批：**图片 + 文字**的合并窗口。
 *
 * QQ / 微信都没法把「一张图 + 一句话」放进同一条消息里发（平台限制），
 * 用户习惯先发图、紧跟着打文字。纯图消息如果立刻跑一轮，AI 会先对着图瞎回一句，
 * 等文字到了又跑一轮 —— 体验像"两个人在抢话"。
 *
 * 做法：纯图消息挂起 ~3.5s：
 *   · 窗口内来了文字 → 取消挂起，图作为附件跟着文字一起进这一轮（推荐路径）
 *   · 窗口内没来文字 → 图单独成一轮（正文用占位提示），AI 至少能看到图
 * 同一人连发多图：累加到同一条（上限 4 张），定时器重置。
 *
 * ⚠️ 窗口时长（用户反馈「2.2s 会不会太短」）：改 3.5s —— IM 上打完一句配文通常要几秒，
 * 太短会在配文到达前先跑一轮（AI 对着图回一句、再来一轮，像两个人在抢话）。
 */
const PENDING_IMAGE_MS = 3500
const pendingImageTurns = new Map<string, { at: number; images: InboundImage[]; extra: Record<string, unknown>; timer: NodeJS.Timeout }>()

/** 取走挂起的图片（命中则清掉定时器） */
function dropPendingImages(key: string): { at: number; images: InboundImage[]; extra: Record<string, unknown> } | null {
  const p = pendingImageTurns.get(key)
  if (!p) return null
  clearTimeout(p.timer)
  pendingImageTurns.delete(key)
  return { at: p.at, images: p.images, extra: p.extra }
}

/** 会话当前模型是否支持看图（口径与 runPromptCore 的闸门完全一致，避免两边判定漂移） */
function channelVisionGate(s: SessionView): { blocked: boolean; model: string } {
  /* ★ 0923：与 resolveSessionLlm 同口径 —— llmOverride > session.model 持久化选择 > 全局（防多窗口串台）
     ★1012t 收尾：改为**直接复用统一解析口**，不再手抄一遍优先级 —— 手抄版会漏掉「通道未单独配模型 → 后台模型」
     这条（后果：后台模型是视觉模型时，通道里发图会被误拦「模型不支持图片」）。 */
  const _sl = resolveSessionLlm(s.id)
  /* ★1013：渠道会话"该走后台模型但没配"⇒ 这里**别拦图**（拦了会显示"模型不支持图片"这种误导文案），
     放它走到出栈，由 createStreamFn 报出真正的错误「未配置后台模型」+ 弹通知。 */
  if ((_sl as any)?.needsBackgroundSetup) return { blocked: false, model: '' }
  const pid = _sl?.providerId || currentLlmConfig().providerId
  const mid = _sl?.model || currentLlmConfig().model
  return { blocked: !resolveModelCaps(pid, mid).vision, model: mid }
}

/**
 * 二十一批：**让通道配置里的模型真正生效**。
 *
 * 背景：接入弹窗能给「通道 / 每个机器人」配模型，但这个值此前只写进 session.model（展示用），
 * 实际调用走 `llmOverride || 全局` → **配了也不生效**。对图片场景尤其致命：
 * 用户给 QQ 机器人配了视觉模型，发图过去仍然用全局文本模型 → AI「看不到图」。
 *
 * 规则（保守，避免抢用户在 PC 的手动选择）：
 *   · 通道没配模型 → 只在当前覆盖是本机制打的（llmOverrideBy==='channel'）时撤掉
 *   · 用户手选过（llmOverrideBy==='user'）→ 不动
 *   · 其余情况 → 按通道配置刷 llmOverride（含 provider/base/key/protocol）
 */
function applyChannelModelOverride(s: SessionView, channel: string, botId: string): void {
  try {
    const mc = modelForChannel(channel, botId)
    const want = String(mc.modelId || '').trim()
    if (!want) {
      if (s.llmOverrideBy === 'channel') {
        s.llmOverride = undefined
        s.llmOverrideBy = undefined
        schedulePersist()
        console.log(`[channel] 通道未配模型 → 会话 ${s.id.slice(0, 8)} 回到跟随全局`)
      }
      return
    }
    if (s.llmOverrideBy === 'user') return          // PC 手选的优先
    if (s.llmOverride?.model === want) return       // 已经是目标模型
    const pid = String(mc.providerId || '').trim() || resolveModelProviderId(want) || ''
    const prov = pid ? getState().providers.find(x => x.id === pid) : undefined
    if (!prov?.base) {
      console.warn(`[channel] 通道配的模型「${want}」找不到供应商（缺 base），本会话继续跟随全局`)
      return
    }
    s.llmOverride = {
      providerId: prov.id,
      providerName: prov.name || prov.id,
      base: (prov.base || '').replace(/\/+$/, ''),
      apiKey: plainKeyById(prov.id),          // ★ 1001：llmOverride 存的是"这次要用的明文"，别再落密文
      model: want,
      protocol: prov.protocol || 'openai-completions',
    }
    s.llmOverrideBy = 'channel'
    s.model = want
    s.modelProviderId = prov.id
    schedulePersist()
    console.log(`[channel] 会话模型按通道配置同步 → ${prov.id}/${want}（会话 ${s.id.slice(0, 8)}）`)
  } catch (e: any) {
    console.warn(`[channel] 通道模型同步失败（不影响对话）: ${String(e?.message || e).slice(0, 120)}`)
  }
}

/**
 * 二十一批（用户实测质问「我给牢大的预设根本没配写入工具，为什么他能写文件？」）：
 * **让通道配置里的预设真正作用到已存在的会话**。
 *
 * 根因：presetId 只在**建会话那一刻**从通道配置定型（`createSession(..., mc.presetId)`），
 * 之后用户在接入弹窗里换了预设，旧会话还挂着老预设 —— 老预设的工具白名单里可能有 fs_write，
 * 于是「换了仅对话预设」也照样能写文件。
 *
 * 与模型同步同款规则：用户手选过（presetBy==='user'）不覆盖；变了就改字段并丢掉旧 agent
 * （工具清单是**建 agent 时**装配的，不丢旧 agent 就不生效）。
 */
function applyChannelPresetOverride(s: SessionView, channel: string, botId: string): void {
  try {
    const mc = modelForChannel(channel, botId)
    const want = String(mc.presetId || '').trim()
    if (s.presetBy === 'user') return
    if ((s.presetId || '') === want) return
    const from = s.presetId || '(未设·全量工具)'
    s.presetId = want || undefined
    s.presetBy = 'channel'
    /**
     * 丢旧 agent → 下一轮 getOrCreateAgent 按新预设重建工具清单。
     * 会话正在跑就先只改字段（本轮结束后指纹变化会自然重建），避免打断正在进行的任务。
     */
    if (s.status !== 'running') {
      try { const ag = agents.get(s.id); if (ag) ag.abort() } catch { /* ignore */ }
      agents.delete(s.id)
      turnAccumulators.delete(s.id)
    }
    schedulePersist()
    console.log(`[channel] 会话预设按通道配置同步 → ${want || '(未设)'}（原 ${from}，会话 ${s.id.slice(0, 8)}）`)
  } catch (e: any) {
    console.warn(`[channel] 通道预设同步失败（不影响对话）: ${String(e?.message || e).slice(0, 120)}`)
  }
}

/**
 * 处理一条入站 IM 消息 —— 命令直接回、普通消息走 AI。
 * 由各通道适配器调用（QQ / 微信均已接入）。
 */
async function handleChannelIncoming(
  channel: 'qq' | 'wechat',
  botId: string,
  peerId: string,
  text: string,
  extra: {
    messageId: string
    kind?: 'c2c' | 'group' | 'channel'
    contextToken?: string
    displayName?: string
    /** 发送者标识（QQ 群=member_openid / 单聊=user_openid）—— 0912 十四批 */
    senderId?: string
    /** 发送者昵称（平台可能不下发） */
    senderName?: string
    /** 群内角色：member / admin / owner */
    senderRole?: string
    /** 这条消息 @ 了谁（不含机器人自身） */
    mentions?: Array<{ id?: string; name?: string }>
    /** 0912 二十一批：本条消息携带的图片（已下载落盘）→ 当附件喂给 agent（AI 能看图） */
    images?: InboundImage[]
    /** 图片下载失败原因（无图可发时回一句友好提示，而不是静默吞掉） */
    imageError?: string
    /** 0912 二十二批：本条消息携带的**文件**（非图片）→ 挪进会话工作区，正文里给出路径 */
    files?: Array<{ path: string; name: string; mime: string; bytes: number }>
    /** 内部：合并窗口重入标记（避免纯图消息再次被挂起 → 死循环） */
    skipImageHold?: boolean
  },
): Promise<void> {
  const target = { channel, botId, peerId, messageId: extra.messageId, kind: extra.kind, contextToken: extra.contextToken, senderId: extra.senderId, senderName: extra.senderName }
  try {
    // 入站消息 id 立刻记一份（命令类消息也记 —— 只发过命令的对端同样需要被动回复窗口）
    rememberLastMessageId(channel, botId, peerId, extra.messageId, extra.kind)
    // 归属/权限按本次入站校正（命令类消息也会走到 —— 它们不经 resolveChannelSession）
    healSessionByMapping(channel, botId, peerId, extra.kind)
    /**
     * ⓪ 审批快捷回复（0912 二批）：该会话有待审批时，「允许」/「拒绝」直接批准。
     *
     * 放在命令解析之前 —— 用户不需要记命令，直接回自然语言即可（IM 场景更直觉）。
     * 只有真的存在待审批时才拦截，不影响正常对话（说「允许」当普通词用不会被吞）。
     */
    {
      const key0 = makeChannelKey(channel, botId, peerId)
      /**
       * ⚠️ 按 **channelKey** 查（不是 sessionId）—— 审批期间从 PC 切走当前会话也能批准。
       * imPendingApprovals 已在 awaitApproval 里按同一 key 登记，两边一致。
       */
      const pend = imPendingApprovals.get(key0)
      if (pend) {
        const t0 = String(text || '').trim()
        const yes = /^(允许|同意|批准|可以|好|ok|yes|y|1)$/i.test(t0)
        const no = /^(拒绝|不同意|不行|不可以|no|n|2)$/i.test(t0)
        const always = /^(都允许|一直允许|全部允许|当前会话允许|不再询问|always|3)$/i.test(t0)
        if (yes || no || always) {
          imPendingApprovals.delete(key0)
          pend.resolveChoice(always ? '当前会话允许' : yes ? '允许一次' : '拒绝')
          await deliverToChannel(target,
            always ? '✅ 已授权（本会话内同类操作不再询问）。'
              : yes ? '✅ 已授权，继续执行。'
                : '❌ 已拒绝该操作。')
          return
        }
        /**
         * 有待审批但用户发的是别的内容（且不是命令）→ **提示而非入队**。
         * 早期会当普通消息入队（会话在跑）→ 用户「发了没反应」，也不知道在等授权。
         * 命令（`/stop` / `/status` 等）放行到下面的命令分支处理。
         */
        if (!t0.startsWith('/')) {
          await deliverToChannel(target,
            `⚠️ 有一个操作正在等你的授权：\n${pend.toolLine}\n\n`
            + (channelHasButtons(target)
              ? '点下面的按钮，或回复「允许」/「都允许」/「拒绝」；'
              : '回复「允许」/「都允许」/「拒绝」即可（这条通道没有按钮）；')
            + '/stop 可取消本轮。',
            { keyboard: buildApprovalKeyboard() })
          return
        }
      }
    }

    // ① 命令（/ 开头）—— 会话管理，不打扰 AI
    const parsed = parseCommand(text)
    if (parsed) {
      /**
       * `/回复通知2 内容` 归一化（0912 十九批）：解析层按空格切名字，序号会黏在命令名上，
       * 这里把它抽出来（noticeIdx，1 起；不写=最近一条），命令名统一成「回复通知」。
       */
      let noticeIdx = 0
      {
        const m = /^(?:回复通知|replynotice|rn)(\d*)$/i.exec(parsed.name)
        if (m) {
          noticeIdx = Math.max(0, parseInt(m[1] || '0', 10) || 0)
          parsed.name = '回复通知'
        }
      }
      const spec = findCommand(parsed.name)
      if (!spec) {
        await deliverToChannel(target, `未知命令：/${parsed.name}\n\n${helpText()}`)
        return
      }
      // 命令大多只读（list/status/help），不必建会话 —— 只有 new/switch 需要
      const key = makeChannelKey(channel, botId, peerId)
      const link = getLink(key)
      switch (spec.name) {
        case 'help':
          /**
           * ★1016e：帮助**精简成"菜单"** —— 原来把整张命令表（11 行）+ 提示 + 按钮一起发，
           * 手机上又长又乱（反馈）。命令表在 QQ 指令面板里打 `/` 就能看到 ⇒ 这里只给按钮 + 一句引导。
           */
          if (channelHasButtons(target)) {
            await deliverMenu(target, 'NIS 快捷菜单 —— 点下面的按钮就行。\n（完整命令：在输入框打 `/` 看指令面板）', buttonSceneOf(link))
          } else {
            /**
             * ★1020：微信 / QQ 群没有按钮，也没有 QQ 客户端那个指令面板 ⇒ 把完整命令表发出去，
             * 别再让人去找"下面的按钮"。
             */
            await deliverToChannel(target, `NIS 命令一览\n\n${helpText()}`)
          }
          return
        case 'list': {
          /**
           * 只列**本对话**的会话（0912 十六批，用户要求）：
           * 私聊只列这条私聊、A 群只列 A 群、B 群只列 B 群。
           * 格式：序号 + 标题 + 私聊/群聊，当前那条带「← 当前」。
           */
          const label = sceneLabel(extra.kind)
          const tag = extra.kind === 'group' || extra.kind === 'channel' ? ` ${peerId.slice(0, 6)}` : ''
          const list = peerScopedSessions(channel, botId, peerId)
          if (!list.length) { await deliverMenu(target, '还没有对话。发 /new 开一个。', buttonSceneOf(link)); return }
          const lines = list.slice(0, 10).map((s, i) => {
            const cur = link?.sessionId === s.id ? ' ← 当前' : ''
            const run = s.status === 'running' ? ' ⏳' : ''
            return `${i + 1}. ${s.title} · ${sessionSceneTag(s, channel, extra.kind)}${run}${cur}`
          })
          /**
           * ★1016f：**列表本身也做成按钮**（需求要求"二级菜单也按钮化"）—— 每条会话一个按钮，点一下直接 `/switch N`。
           * 只给前 6 条（官方按钮文字 ≤10 字符、太多行手机上也乱），其余继续用 `/switch <序号>`。
           */
          /**
           * ★1016g：按钮**只显示序号**。反馈"上下都写名字是两层重复"，且官方 label ≤10 字符
           * ⇒ 按钮里放标题只能截断成 `1.QQ单聊初…`，反而不如上面那行文字完整。
           * 取两者优点：**上面保留完整名字列表**（信息全、可复制），**下面按钮只给 `1 2 3…`**，一行 3 个。
           */
          const scene = buttonSceneOf(link)
          const kb = buildItemKeyboard('nis_list',
            list.slice(0, 6).map((_s2, i) => ({ label: String(i + 1), cmd: `/switch ${i + 1}` })), 3)
          await deliverToChannel(target,
            `【${label}${tag}】对话列表（共 ${list.length} 个）：\n\n${lines.join('\n')}\n\n`
            + (channelHasButtons(target)
              ? (list.length > 6 ? '前 6 条直接点按钮；其余发 /switch <序号>。\n' : '') + commandHint(scene)
              : '发 /switch <序号> 换对话；/help 看全部命令。'),
            { keyboard: kb })
          return
        }
        case '通知': {
          // 待回复的定时任务通知（0912 十九批）：穿插模式下通知不抢落点，「我该回哪一条」靠这份清单
          /**
           * ★1018：清单**做成按钮**（用户"能做成按钮的都可以"）—— 点一下直接追问那条通知，
           * 不用手打 `/回复通知 2`。按钮只显示序号（官方 label ≤10 字符），最多 5 条 ⇒ 一行正好 5 个。
           */
          const notices = listNotices(channel, botId, peerId, 5)
          const nkb = notices.length
            ? buildItemKeyboard('nis_notice', notices.map((_n, i) => ({ label: String(i + 1), cmd: `/回复通知 ${i + 1}` })), 5)
            : undefined
          await deliverToChannel(target, noticeListText(channel, botId, peerId), nkb ? { keyboard: nkb } : undefined)
          return
        }
        case '回复通知': {
          const out = await handleNoticeReply(channel, botId, peerId, String(parsed.args || ''), noticeIdx, target)
          if (out) await deliverToChannel(target, out)
          return
        }
        case 'new': {
          const title = parsed.args || `${channel === 'qq' ? 'QQ' : '微信'}对话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
          // ⚠️ forceNew：必须强制新建。早期这里没传，resolveChannelSession 发现已有映射就复用旧会话
          // → 命令回「已新开对话」但实际没新建（用户实测「/new 没反应」）
          const sid = resolveChannelSession(channel, botId, peerId, title, { forceNew: true })
          if (!sid) { await deliverToChannel(target, '创建对话失败，请稍后重试。'); return }
          await deliverToChannel(target, `已新开对话「${title}」。直接发消息即可开始。`)
          return
        }
        case 'switch': {
          /**
           * 切换范围与 /list **完全一致**：只能切到本对话名下的会话（0912 十六批）。
           * 切完把归属字段一起改过来 —— 否则它不会出现在本对端的列表里（历史踩过）。
           */
          const list = peerScopedSessions(channel, botId, peerId)
          const n = parseInt(parsed.args, 10)
          if (!Number.isFinite(n) || n < 1 || n > list.length) {
            await deliverToChannel(target, `用法：/switch <序号>（当前可选 1-${list.length}）。发 /list 看列表。`)
            return
          }
          const tgt = list[n - 1]
          setLink(key, { sessionId: tgt.id, channel, botId, peerId })
          tgt.origin = channel
          tgt.originBot = botId
          tgt.originPeer = peerId
          if (extra.kind) tgt.originKind = extra.kind
          schedulePersist()
          await deliverToChannel(target, `已切换到「${tgt.title}」（${n}）。直接发消息即可继续。`)
          return
        }
        /* ★1014f：PC 会话接管 —— 手机切到 PC 上干活的项目会话（安全闸在 pcCommandCore 内） */
        case 'pc': {
          const out = pcCommandCore({ channel, botId, peerId, kind: extra.kind, args: parsed.args, curSessionId: link?.sessionId })
          if (out.switchTo) switchLinkTo(key, out.switchTo, channel, botId, peerId, extra.kind)
          // ★1016h：列表带序号按钮（点一下直接接管，不用再打 /pc <序号>）
          await deliverToChannel(target, out.reply, out.keyboard ? { keyboard: out.keyboard } : undefined)
          return
        }
        case 'home': {
          const out = homeCommandCore({ channel, botId, peerId, curSessionId: link?.sessionId })
          if (out.switchTo) switchLinkTo(key, out.switchTo, channel, botId, peerId, extra.kind)
          await deliverToChannel(target, out.reply)
          return
        }
        case 'status': {
          const s = link ? sessions.get(link.sessionId) : undefined
          if (!s) { await deliverToChannel(target, '当前没有对话。发 /new 开一个。'); return }
          await deliverToChannel(target, [
            `对话：${s.title}`,
            `模型：${s.model || '(跟随全局)'}`,
            `权限：${permLabel(s.permissionMode || 'confirm')}`,
            `状态：${s.status === 'running' ? '正在回复中' : '空闲'}`,
          ].join('\n'))
          return
        }
        case 'perm': {
          /**
           * 权限档位：查看 / 切换。
           * ★1013g（已定案）：**只作用于当前这条对话**（通道级档位已删）—— 与 PC 端三档切换同一口径。
           */
          /** 当前**对话自己**的权限档 */
          const curSessNow = link?.sessionId ? sessions.get(String(link.sessionId)) : undefined
          const cur: PermissionMode = (curSessNow?.permissionMode || 'confirm') as PermissionMode
          const arg = (parsed.args || '').trim()
          /**
           * ★1016i：**权限档位做成按钮**（用户"能做成按钮的都可以"）—— 点一下直接切，不用手打 `/perm 审计模式`。
           * 查看档位和"误输入"两条路径共用同一排按钮（官方 label ≤10 字符，档位名都很短 ✓）。
           */
          const permKb = buildItemKeyboard('nis_perm',
            PERM_OPTIONS.map(o => ({ label: permLabel(o.value as any), cmd: `/perm ${o.value}` })), 3)
          if (!arg) {
            await deliverToChannel(target, `${permText(cur)}${channelHasButtons(target) ? '\n\n' + commandHint({}) : ''}`, { keyboard: permKb })
            return
          }
          const mode = parsePermMode(arg)
          if (!mode) {
            await deliverToChannel(target, `无法识别的档位「${arg}」。\n\n${permText(cur)}`, { keyboard: permKb })
            return
          }
          /**
           * ★1013g（已定案）：**只改当前这条对话** —— 与 PC 端输入框上方那个三档切换口径完全一致
           * （原来还会写通道配置，那等于"第二道闸"，已废弃）。
           * 新开的对话会回到对话默认档（confirm）；想长期改请在 PC 端设置里改。
           */
          if (!curSessNow) {
            await deliverToChannel(target, '当前还没有对话 —— 先发一条消息建一个对话，再改权限。', { keyboard: permKb })
            return
          }
          curSessNow.permissionMode = mode
          schedulePersist()
          console.log(`[channel] 对话 ${curSessNow.id.slice(0, 8)} 权限改为 ${mode}（只影响本条对话）`)
          await deliverToChannel(target,
            `✅ **本对话**权限已切为「${permLabel(mode)}」。\n\n${PERM_OPTIONS.find(o => o.value === mode)?.desc || ''}\n（只影响当前这条对话；新对话会回到默认档）`,
            { keyboard: permKb })
          return
        }
        case 'stop': {
          const s = link ? sessions.get(link.sessionId) : undefined
          if (!s || s.status !== 'running') { await deliverToChannel(target, '当前没有正在执行的任务。'); return }
          const ag = agents.get(s.id)
          if (ag) ag.abort()
          s.status = 'idle'
          schedulePersist()
          await deliverToChannel(target, '已请求停止当前执行。')
          return
        }
        default:
          await deliverToChannel(target, `未实现的命令：/${spec.name}`)
          return
      }
    }

    // ② 普通消息 → 落会话 + 跑 AI（kind 落 originKind：列表里区分私聊/群聊）
    const sid = resolveChannelSession(channel, botId, peerId, undefined, { kind: extra.kind })
    if (!sid) { await deliverToChannel(target, '创建对话失败，请稍后重试。'); return }
    const session = sessions.get(sid)
    if (!session) { await deliverToChannel(target, '会话不存在，请重发。'); return }

    /**
     * ★1013g（已定案）：这里原来"每次入站都把会话权限同步成通道档" —— 通道档已删 ⇒ 整块去掉。
     * 会话权限现在归**对话自己**管：PC 端输入框上方的三档切换，或 IM 里 `/perm`。
     */
    /**
     * 二十一批：模型也按通道配置同步（含视觉模型）——
     * 否则「通道里配了视觉模型」发图过去仍走全局文本模型 → AI 看不到图（用户痛点）。
     * 必须在 vision 闸门之前执行。
     */
    applyChannelModelOverride(session, channel, botId)
    /**
     * 二十一批：预设同样按通道配置同步 ——
     * presetId 只在建会话时定型，换了预设旧会话不生效 →「仅对话」预设的机器人照样能写文件（用户实测质问）。
     */
    applyChannelPresetOverride(session, channel, botId)

    /**
     * 二十一批：图片合并窗口（纯图等待配文 / 文字认领挂起的图）。
     * 位置：在 pushReplyTarget **之前** —— 挂起阶段不占回推队列（避免 FIFO 错位）。
     */
    /**
     * ★1014c：群聊——本条**没带图**时，认领"该群最近的图"（群里先发图、再 @ 机器人问「这是谁」）。
     * 位置必须在 hasImages / 图片合并窗口之前：认领到的图才能走同一条 vision 闸门与附件链路
     * （否则模型看不到图 —— 实测的那个"看不见图片"）。
     * 注意：只对群聊做；私聊的图片消息本来就直接带图，走不到这里。
     */
    if (channel === 'qq' && extra.kind === 'group' && !extra.images?.length) {
      const claimed = await claimGroupMedia('qq', botId, peerId)
      if (claimed.length) extra = { ...extra, images: claimed }
    }
    const imgKey = makeChannelKey(channel, botId, peerId)
    const hasImages = !!extra.images?.length
    const hasText = !!String(text || '').trim()
    if (hasImages && !hasText && !extra.skipImageHold) {
      // 纯图消息：挂起等配文（连发多图累加；定时器重置）
      const prev = dropPendingImages(imgKey)
      const images = [...(prev?.images || []), ...(extra.images || [])].slice(-4)
      const timer = setTimeout(() => {
        const pend = dropPendingImages(imgKey)
        if (!pend) return
        void handleChannelIncoming(channel, botId, peerId, '', { ...(pend.extra as any), images: pend.images, skipImageHold: true })
      }, PENDING_IMAGE_MS)
      pendingImageTurns.set(imgKey, { at: Date.now(), images, extra: { ...extra, images: undefined } as any, timer })
      console.log(`[channel] 图片消息挂起 ${PENDING_IMAGE_MS}ms（等待配文合并）→ ${channel}:${String(peerId).slice(0, 8)}`)
      return
    }
    if (hasText) {
      // 文字认领挂起的图（图+文 ⇒ 同一轮）
      const pend = dropPendingImages(imgKey)
      if (pend && Date.now() - pend.at <= PENDING_IMAGE_MS + 800) {
        extra = { ...extra, images: [...pend.images.filter(Boolean), ...(extra.images || [])].slice(0, 4) }
      }
    }
    const inboundImages = extra.images || []
    // 图片下载失败的兜底提示（无正文也没图 → 不能让用户对着空气等）
    if (!inboundImages.length && extra.imageError && !hasText) {
      await deliverToChannel(target, `📷 图片没收到（${extra.imageError}）。麻烦重发一次，或直接用文字描述下～`)
      return
    }

    // 记忆回推目标（agent_end 时用；FIFO 队列 —— 每条入站消息各占一位，逐条对应回推）
    const pushedReplyTarget = { ...target, startedAt: Date.now() } as ChannelReplyTarget
    pushReplyTarget(sid, pushedReplyTarget)
    /* ★1014b：QQ 私聊流式 —— 只登记候选（真正的帧由定时器按"本轮全文"推，见 qqStreamMaybeStart） */
    qqStreamMaybeStart(sid, pushedReplyTarget)
    // 最近入站上下文（覆盖式，不随队列消费）—— 审批/超时通知这类时机不确定的回推靠它拿 messageId
    rememberInbound(sid, { ...target, startedAt: Date.now() })
    /**
     * 微信 context_token 随每条消息更新 —— 回写进映射。
     * 回推（含审批/超时通知）不带它会落不进原会话（官方同样要求带上）。
     */
    if (extra.contextToken) {
      try {
        const ck = makeChannelKey(channel, botId, peerId)
        if (getLink(ck)) setContextToken(ck, extra.contextToken)
      } catch { /* ignore */ }
    }
    /**
     * 记录「最近一条入站消息 id」（0912 十三批）—— **QQ 省额度用**。
     * 官方限制：不带 msg_id 的推送算「主动消息」，每用户每月仅 4 条；
     * 60 分钟窗口内带上对方刚发的 msg_id 则可走「被动回复」（不限量）。
     * 定时任务推送时优先用它（见 notifyTaskResult）。顺带把**对端类型**（私聊/群聊）记在映射上。
     */
    rememberLastMessageId(channel, botId, peerId, extra.messageId, extra.kind)

    /**
     * 二十一批：带图消息的 vision 闸门。
     * 放在 pushReplyTarget 之后、真正跑之前 —— 不通过就别让它进 FIFO（否则回推错位）。
     * 这里给的是 IM 口吻的提示（"去 PC 换模型"），比 runPromptCore 抛的技术错误友好得多。
     */
    if (inboundImages.length) {
      const gate = channelVisionGate(session)
      if (gate.blocked) {
        // 闸门不通过：撤掉刚占的回推位（它对应的这轮不会发生）
        /* ★1003 修复 4.63/4.64：原来 shiftReplyTarget() 弹的是队头，积压时误删别人的待回复
         * → 后续回复全错位；且 `if (back) {...}` 是死代码。现按身份只撤自己刚压的这条。 */
        removeReplyTarget(sid, pushedReplyTarget)
        await deliverToChannel(target, `📷 收到图片了，但当前模型「${gate.model}」不支持看图。\n请在 PC 端把本对话的模型切换为支持视觉的模型（或直接发文字描述），我就能看了～`)
        return
      }
    }

    // 首次对话回执（QQ 私聊 60 分钟窗口 / 每条最多 5 次回复，长任务必须「先回执后汇报」）
    if (session.messages.length === 0) {
      void deliverToChannel(target, '✅ 收到，正在处理…')
        .catch((e) => swallowed('IM 首次回执未发出（对方可能以为没收到）', e))
    }

    /**
     * 二十一批：图片附件（dataUrl 喂给多模态模型）+ 消息正文占位。
     * 纯图消息必须有正文（runPromptCore 要求 message 非空，队列续发同理）。
     */
    const imgAttachments = inboundImages.map(img => ({ name: path.basename(img.path), dataUrl: img.dataUrl }))
    /**
     * 二十二批：**对方发来的文件**挪进会话工作区 ——
     * AI 的 fs 工具只作用于工作区，文件躺在 data/channel-inbox 里它读不到（"AI 读不了你发的文件"）。
     * 挪完在正文里给出路径与大小，AI 就知道该去哪儿读。
     */
    const fileNotes: string[] = []
    for (const f of extra.files || []) {
      try {
        const wd = session.workDir?.trim()
        let target = f.path
        if (wd) {
          const dir = path.join(wd, 'inbox')
          fs.mkdirSync(dir, { recursive: true })
          target = path.join(dir, path.basename(f.path))
          if (!fs.existsSync(target)) fs.copyFileSync(f.path, target)
        }
        fileNotes.push(`[对方发来文件：${f.name}（${(f.bytes / 1024).toFixed(1)}KB），已存到 ${target}]`)
      } catch (e: any) {
        fileNotes.push(`[对方发来文件：${f.name}，但转存失败：${String(e?.message || e).slice(0, 60)}]`)
      }
    }
    /* 0920（#4②）：**部分媒体没取到**时也要让 AI 知道，它会转告用户，而不是装作全收到了。
     * 只在"拿到了东西"时走这里（一件都没拿到会在上面 6701 行直接回一条友好提示）。 */
    const mediaNotes: string[] = []
    if (extra.imageError && (inboundImages.length || (extra.files || []).length)) {
      mediaNotes.push(`[媒体提示：${String(extra.imageError).slice(0, 200)}]`)
    }
    const textOut = [String(text || '').trim(), ...fileNotes, ...mediaNotes].filter(Boolean).join('\n')
      || (inboundImages.length ? '（对方发来一张图片，没有配文字）' : '')

    /**
     * 0912 二批：注入 IM 场景上下文。
     *
     * 0912 十四批重写（用户实测：「机器人不知道自己在群里，也分不清是谁跟他说话」）：
     *   旧版只写「对方正在 QQ 手机端与你对话」→ 群里说话时 AI 以为在一对一；
     *   新版按 群聊/频道/单聊 分别组装，并带上**发言者**（昵称或稳定的「群成员N」标签）、
     *   群成员名单、本条消息 @ 了谁，以及平台能力边界（**能 @ 人**：正文写「@昵称」 / 看不到非 @ 消息）。
     *
     * ⚠️ 0920（#4③）位置修正：这段组装必须放在**入队判断之前**。
     *   原来它在入队之后 → 机器人正忙时进来的消息只排了「裸文本」，
     *   发言人 / 哪个群 / 群成员名单 / @ 了谁 / 背景流水 **全部丢失**，
     *   续发时 AI 只看到一句孤立的话 —— 群里连着说话就"谁在说什么"都分不清，
     *   这正是反馈的"最近变傻了"。现在入队的是**已经拼好上下文的 prompt**，
     *   续发路径（flushNextQueued）与直发完全等价。
     */
    const isGroupScene = extra.kind === 'group' || extra.kind === 'channel'
    let senderInfo: { label: string; id?: string; role?: string } | undefined
    let roster: Array<{ label: string; id?: string; role?: string }> | undefined
    let background: Array<{ time: string; label: string; text: string }> | undefined
    if (isGroupScene) {
      // 顺手把真实群名拉下来做显示名（接口需白名单，失败静默；30 分钟最多试一次）
      void syncGroupName(channel, botId, peerId)
      // 登记发言者 → 拿稳定标签（有昵称用昵称，没有则按首次出现顺序编号，跨轮次不变）
      const m = identifyMember(channel, peerId, extra.senderId || extra.senderName || 'unknown', {
        name: extra.senderName,
        role: extra.senderRole,
      })
      senderInfo = { label: m.label, id: m.id === 'unknown' ? undefined : m.id, role: m.role }
      roster = listMembers(channel, peerId, 6).map(x => ({
        label: x.label,
        id: x.id === 'unknown' ? undefined : x.id,
        role: x.role,
      }))
      /**
       * 背景流水（0912 十五批）：旁听到的全量群消息 → 让 AI 能回答「刚才 B 说了什么」。
       * 过滤掉"当前这条"（同 id 或同文本）—— 它已经作为本轮消息给它了，重复出现只会让它困惑。
       */
      background = collectImBackground(channel, peerId, { messageId: extra.messageId, text })
    } else {
      senderInfo = { label: extra.senderName || extra.displayName || '对方', id: extra.senderId, role: extra.senderRole }
    }
    const imPrefix = buildImContext({
      channel,
      kind: extra.kind,
      botName: channel === 'qq'
        ? (qqBotStatus()[botId]?.nickname || '')
        : String((getChannel('wechat')?.bots || []).find((b: any) => b.id === botId)?.nickname || ''),
      peerTag: isGroupScene ? peerId.slice(0, 6) : '',
      sender: senderInfo,
      mentions: extra.mentions,
      roster,
      background,
      // 二十一批：让 AI 知道「这轮带了图、图存在哪」（可看图；也能用 MEDIA: 行原样转发）
      images: inboundImages.map(i => ({ path: i.path, bytes: i.bytes })),
      // 0920（#4③）：说明工作区是独立空目录，避免它假装读过用户的项目
      workspace: session.workDir || '',
    })

    const promptText = imPrefix + textOut

    if (session.status === 'running') {
      // 正在跑：入队（复用既有队列能力），避免并发同一 agent。
      // 0920：入队的是**拼好 IM 上下文的 promptText**（不再是裸 textOut）。
      if (!Array.isArray(session.queuedMessages)) session.queuedMessages = []
      session.queuedMessages.push({
        id: `ch_${Date.now().toString(36)}`,
        text: promptText,
        ...(imgAttachments.length ? { attachments: imgAttachments } : {}),
        createdAt: Date.now(),
      })
      schedulePersist()
      return
    }

    await runPromptCore(sid, {
      message: promptText,
      ...(imgAttachments.length ? { attachments: imgAttachments } : {}),
    })
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300)
    console.error(`[channel] 处理入站消息失败: ${msg}`)
    void deliverToChannel(target, `处理失败：${msg}`).catch(() => { /* ignore */ })
  }
}

/**
 * 抽取本轮 AI 的最终文本（沿 transcript 倒序找最后一条 assistant 的 text 块）
 * @param turnMessages agent_end 事件携带的**本轮**消息 —— 最精确，优先用它
 */
function extractFinalAssistantText(sessionId: string, turnMessages?: any[]): string {
  const s = sessions.get(sessionId)
  if (!s) return ''
  const pick = (arr: any[] | undefined): string => {
    if (!Array.isArray(arr)) return ''
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]
      if (m?.role !== 'assistant') continue
      const txt = (m.content || [])
        .filter((c: any) => c?.type === 'text' && c.text)
        .map((c: any) => c.text).join('\n').trim()
      if (txt) return txt
    }
    return ''
  }
  // 优先本轮事件消息 → 实时 transcript（含本轮）→ 展示态 messages
  return pick(turnMessages) || pick((s as any).transcript) || pick(s.messages)
}

/** 搜索用（0914 下午 session.search）：提取一条消息的可搜文本（string content 或 text/reasoning 块） */
function piMessageSearchText(m: any): string {
  if (!m) return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((b: any) => b && typeof b.text === 'string' && (b.type === 'text' || b.type === 'reasoning'))
      .map((b: any) => b.text)
      .join('\n')
  }
  return ''
}

function handleAgentEvent(sessionId: string, event: AgentEvent): void {
  const session = sessions.get(sessionId)
  if (!session) return

  // ── 撞墙检测状态（思考死循环）：按会话键控 ──
  // 滑动窗口指纹：近 8 个 ~120 字符段的哈希；同指纹累计 ≥3 次判为死循环。
  // 正常思考不会精确复现同一段长文本（重复去重后 delta 也可能整段重发——那本身就是循环特征）
  if (!session.loopWindow) session.loopWindow = { sigs: new Map<string, number>(), buf: '' }

  // 透传 pi 原始事件给前端（前端节点运行时自行组装，不再依赖 DSH message 翻译）
  broadcastAgentEvent(sessionId, event)

  // turn 计时：agent_start 记起点；首个 text_delta/thinking_delta 记首 token；agent_end 记终点
      if (event.type === 'agent_start') {
        session.turnStartTime = Date.now()
        session.firstTokenTime = undefined
        session.toolMsTotal = 0
        session.toolStartTime = undefined
        // 撞墙检测窗口重置（每轮全新判定，上轮残留不误杀）
        session.loopWindow = { sigs: new Map<string, number>(), buf: '' }
        // ★0929 P1（刀4 误杀）：审批超时计数同步跨轮复位 —— 同理"上轮残留不误杀"：
        // 轮1 同工具超时 2 次的留存会让轮2 该工具**首超即凑满 3 次 → 新轮被杀**（用户刚下指令就闭嘴）
        approvalTimeoutStreak.delete(sessionId)
        // 撤销记录按对话轮次分组：每轮开始时更新快照轮次上下文（turnId=本轮 user 消息摘要，
        // turnIndex=会话内 user 消息序号；成员子 agent 的快照继承派发轮的轮次）
        {
          const msgs = session.messages || []
          let userCount = 0
          let lastUser = ''
          let lastRealUser = ''   /* ★1004c：注入消息不劫持轮次标签（【群聊插嘴】/【分身回归】/【后台任务通知】） */
          for (const m of msgs) {
            if (m.role === 'user') {
              const blocks = Array.isArray(m.content) ? m.content as Array<{ type: string; text?: string }> : []
              const t = blocks.filter(b => b.type === 'text').map(b => b.text || '').join(' ')
              /* ★1004g：turnIndex 与 deleteTurn 同口径=跳过注入的真实 user 序号（原来不跳⇒
               * 同轮记录分裂成两个序号、面板重复显示，且撤销/删轮错位） */
              if (!isInjectedUserMsg(m)) {
                userCount++
                if (t.trim()) lastRealUser = t.trim()
              } else if (t.trim()) lastUser = t.trim()
            }
          }
          const labelSrc = lastRealUser || lastUser
          setSnapshotTurn(sessionId, labelSrc ? { turnId: cleanTurnLabel(labelSrc), turnIndex: userCount } : null)
        }
      } else if ((event.type === 'message_update') && session.turnStartTime != null && session.firstTokenTime == null) {
    const ae = (event as any).assistantMessageEvent
    if (ae && (ae.type === 'text_delta' || ae.type === 'thinking_delta')) {
      session.firstTokenTime = Date.now()
    }
  }

  switch (event.type) {
    case 'agent_start': {
      resetWechatToolProgress(sessionId)   // ★1020：新一轮 → 微信工具进度额度清零
      session.status = 'running'
      sessionLog(sessionId, 'info', 'lifecycle', '开始处理消息')
      broadcastHost({ type: 'host/session-status', sessionId, running: true })
      // 前端只连 events.mux，会话运行状态也走 mux 广播（列表 replying 动画用）
      broadcastMux(sessionId, { type: 'session/status', sessionId, running: true })
      break
    }

    case 'message_start': {
      const msg = event.message
      if (msg.role === 'user') {
        // 0909④：自动续跑注入指令（模型可见、transcript 保留）——不污染 DSH 用户消息计数/撤销轮次，
        // 但重置累积器让续跑后的回复开新气泡（段边界可见），并广播让前端渲染成 notice 而非用户气泡
        const _rawText = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join('')
            : ''
        if (_rawText.startsWith(AUTO_CONTINUE_PREFIX)) {
          // 不污染 DSH 用户消息计数/撤销轮次（不 push session.messages）。
          // 渲染交给前端：agent-event 通道（本函数开头的 broadcastAgentEvent）天然携带 message_start，
          // piChat 按前缀识别渲染成"自动续跑"notice，不出现假用户气泡。
          turnAccumulators.delete(sessionId)
          break
        }
        // 新用户消息 = 新 turn：重置累积器（同一 prompt 的所有 assistant 轮次合并到一条消息）
        turnAccumulators.delete(sessionId)
        /* ★1004 记忆召回根治：落盘只存**用户原文**（剥行首注入行）——拼注入只进出站 finalMessage
         * （transcript/模型上下文保留拼后文本是合理的）；复制/轮次标注/侧栏预览读的是这里存的 text。 */
        const text = stripInjectedLines(typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join('')
            : JSON.stringify(msg.content))
        const id = crypto.randomUUID()
        /**
         * 二十一批：用户消息里的**图片块**也写进展示消息（此前只取 text）——
         *  · 通道入站图（QQ/微信发来的图）→ PC 对话里能看到（用户要求"对话里要有图"）
         *  · PC 附件图 → 刷新/换设备后同样能看到（此前只在本地乐观气泡里，刷新即丢）
         * 落盘时 sessionAssets 会把 base64 剥离成 asset 引用（体积不变大），加载时原位还原。
         */
        const blocks: any[] = [{ type: 'text', text }]
        if (Array.isArray(msg.content)) {
          for (const b of msg.content as any[]) {
            if (b?.type === 'image' && typeof b.data === 'string' && b.data.length >= 64) {
              blocks.push({ type: 'image', data: b.data, mimeType: b.mimeType || 'image/png' })
            }
          }
        }
        const dshMsg: DSHMessage = {
          id,
          role: 'user',
          content: blocks,
          timestamp: Date.now(),
          expectFinal: true,
        }
        session.messages.push(dshMsg)
        // 用户消息即时落 transcript（增量落盘：进程被杀时本轮用户消息不丢）
        try {
          const agentLive = agents.get(sessionId) as any
          const live = agentLive?.state.messages
          if (Array.isArray(live) && live.length > 0) {
            session.transcript = JSON.parse(JSON.stringify(live))
            session.updatedAt = Date.now()
            schedulePersist()
          }
        } catch { /* ignore */ }
        // 撤销记录按对话轮次分组：user 消息此时才入列（agent_start 时还没有），在此更新快照
        // 轮次上下文——首条消息的轮次标注不能漏（实测 agent_start 读不到 user 会标 -）
        {
          let userCount = 0
          let lastUser = ''
          let lastRealUser = ''   /* ★1004c：注入消息不劫持轮次标签（同 agent_start 分支） */
          for (const m of session.messages) {
            if (m.role === 'user') {
              const blocks = Array.isArray(m.content) ? m.content as Array<{ type: string; text?: string }> : []
              const t2 = blocks.filter(b => b.type === 'text').map(b => b.text || '').join(' ')
              /* ★1004g：turnIndex 与 deleteTurn 同口径=跳过注入的真实 user 序号（同 agent_start 分支） */
              if (!isInjectedUserMsg(m)) {
                userCount++
                if (t2.trim()) lastRealUser = t2.trim()
              } else if (t2.trim()) lastUser = t2.trim()
            }
          }
          const labelSrc = lastRealUser || lastUser
          setSnapshotTurn(sessionId, labelSrc ? { turnId: cleanTurnLabel(labelSrc), turnIndex: userCount } : null)
        }
        broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_added', message: dshMsg }, expectFinal: true })
      } else if (msg.role === 'assistant') {
        // turn 首次出现时创建占位消息（后续轮次复用同一 id，不产生多条 AI 气泡）
        if (!turnAccumulators.has(sessionId)) {
          const id = crypto.randomUUID()
          turnAccumulators.set(sessionId, { id, text: '', reasoning: '', sequence: [], lastTextDelta: '', lastReasoningDelta: '', model: (msg as any).model })
          const dshMsg: DSHMessage = {
            id,
            role: 'assistant',
            content: [],
            timestamp: Date.now(),
            expectFinal: false,
          }
          broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_added', message: dshMsg }, expectFinal: false })
        }
      }
      break
    }

    case 'message_update': {
      const turn = turnAccumulators.get(sessionId)
      if (!turn) break
      const updateEvent = event as unknown as { assistantMessageEvent: { type: string; delta?: string } }
      const assistantEvent = updateEvent.assistantMessageEvent
      if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
        // 重复增量去重（LongCat 流式末段会重复推送同一段文本）
        if (assistantEvent.delta !== turn.lastTextDelta) {
          turn.lastTextDelta = assistantEvent.delta
          turn.text += assistantEvent.delta
          pushTurnSnapshot(sessionId, turn)
        }
      }
      // 思考过程：流式增量推前端（前端可渲染 Thinking 行；带上当前文本，避免交替推送时前端清空正文）
      if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
        if (assistantEvent.delta !== turn.lastReasoningDelta) {
          turn.lastReasoningDelta = assistantEvent.delta
          turn.reasoning += assistantEvent.delta
          pushTurnSnapshot(sessionId, turn)
          // 撞墙检测（0902 反馈 #6）：弱模型（LongCat 等）思考死循环——同一段 thinking 反复输出，
          // 无工具调用，既有"重复工具熔断"不触发，主 agent 干等烧时间。
          // 滑动窗口：把 thinking 增量切成 ~120 字符的段，哈希近段指纹；同指纹累计出现 ≥3 次
          // = 撞墙 → abort 本轮 + 日志/前端提示（走 session.cancel 同链路语义，agent_end 收尾）
          if (checkThinkingLoop(sessionId, assistantEvent.delta)) {
            sessionLog(sessionId, 'warn', 'llm', '检测到模型重复输出同一段思考（疑似死循环），已自动停止本轮——请换个问法或降低任务复杂度重试')
            broadcastMux(sessionId, { type: 'session/status', sessionId, running: false, agentEnd: true, aborted: true, loopBreak: true })
            // 撞墙收尾对齐 session.cancel 语义（铁律 12：中断收尾放这里，别依赖 agent_end——
            // abort 后订阅守卫会丢弃旧 agent 的 agent_end 事件）：
            // 快照 transcript（上下文连续）+ 删 agent/累积器 + 状态复位
            try {
              const aLive = agents.get(sessionId)?.state.messages
              if (Array.isArray(aLive) && aLive.length > (session.transcript?.length || 0)) {
                session.transcript = JSON.parse(JSON.stringify(aLive))
                schedulePersist()
              }
            } catch { /* ignore */ }
            /* ★0927 netfix LOOP-0927-netfix（撞墙收尾对齐 agent_end）：三件收尾漏做 →
               ①通道回推 FIFO 永久错位一位（后续每轮拿旧 messageId/contextToken，QQ 被动必失败烧额度）
               ②本轮截图清单不消费 → 跨轮泄漏重复补发 ③撞墙轮占位消息不落展示态。 */
            broadcastHost({ type: 'host/session-status', sessionId, running: false })
            const _loopRt = shiftReplyTarget(sessionId)
            void _loopRt  // 撞墙轮无收尾正文可回推，仅按 FIFO 消费目标防错位
            consumeTurnShots(sessionId)
            try {
              const _loopTurn: any = turnAccumulators.get(sessionId)
              if (_loopTurn) {
                if (_loopTurn.text || _loopTurn.reasoning) {
                  _loopTurn.sequence.push({ type: 'text', text: _loopTurn.text, reasoning: _loopTurn.reasoning })
                  _loopTurn.text = ''; _loopTurn.reasoning = ''
                }
                const _loopHas = _loopTurn.sequence.some((it: any) => (it.type === 'text' && (it.text || it.reasoning)) || (it.type === 'tool' && it.blocks && it.blocks.length > 0))
                const _loopMsg: any = { id: _loopTurn.id, role: 'assistant', content: assembleTurnContent(_loopTurn), timestamp: Date.now(), expectFinal: true, model: _loopTurn.model }
                if (_loopHas) {
                  session.messages.push(_loopMsg)
                  broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_updated', message: _loopMsg } })
                } else {
                  /* ★1005 同类修（原来标 `any` 所以 TS 不报，形状其实和 10508 一样错）：content 应是块数组。 */
      const _loopMsg2: any = { id: _loopTurn.id, role: 'assistant', content: [{ type: 'text', text: '（撞墙收尾：本轮中断且无输出，占位保留不删除）' }], timestamp: Date.now(), expectFinal: true }
                  session.messages.push(_loopMsg2)
                  broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_updated', message: _loopMsg2 } })
                }
              }
            } catch { /* 撞墙收尾失败不拦停止 */ }
            /* ★0929 P0（多窗口长任务并发隐患排查）：**先 abort 再 delete** ——
               原来只 delete，撞墙的 agent 并没死：它会继续跑工具/弹审批卡（订阅守卫只是
               不再广播它的事件），而 resumeQueueAfterAutoStop 看到"没 agent"立刻起新 agent
               ⇒ 同会话双 agent 并发写 transcript/消息（多窗口长任务"奇形怪状"的源之一）。
               写法与 getOrCreateAgent 配置重建路径（try { agent.abort() }）对齐。 */
            try { (agents.get(sessionId) as any)?.abort?.() } catch { /* ignore */ }
            agents.delete(sessionId)
            turnAccumulators.delete(sessionId)
            session.status = 'idle'
            /* ★0927 R14（对齐 session.cancel 语义）：挂起的询问卡也要解除 ——
               否则 ask_user 的 promise 干等 10 分钟超时才消，卡片的"等待你"标记
               和 agent 的实际状态不同步（cancel 路径一直这么做，漏了这）。 */
            clearPendingQuestions(sessionId)
            /* ★0927 N1：撞墙自动停止**不是**用户按停止 → 队列照旧往前走，绝不跟着按死 */
            resumeQueueAfterAutoStop(sessionId)
          }
        }
      }
      break
    }

    case 'message_end': {
      const msg = event.message
      if (msg.role !== 'assistant') {
        break
      }
      // 当轮文本定稿为段落（工具结果轮次 msgText 含工具回显，只取流式累积的模型输出）
      const msgText = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join('')
          : ''
      const turn = turnAccumulators.get(sessionId)
      if (turn) {
        const text = (turn.text || '').trim() || msgText.trim()
        const reasoning = (turn.reasoning || '').trim()
        turn.sequence.push({ type: 'text', text, reasoning })
        turn.text = ''
        turn.reasoning = ''
        turn.lastTextDelta = ''
        turn.lastReasoningDelta = ''
        pushTurnSnapshot(sessionId, turn)
      }
      break
    }

    case 'tool_execution_start': {
      const turn = turnAccumulators.get(sessionId)
      if (!turn) break
      // 工具计时起点（tool_execution_start → end 算单次耗时，turn 内累加）
      // 注意：turn 为空（getOrCreateAgent 后事件先于 turn 累积器创建）时也要记起点，
      // 否则 team_dispatch 这类长工具的等待时间会漏算进 toolMs，污染 LLM 耗时
      session.toolStartTime = Date.now()
      const group: ContentBlock[] = [{
        type: 'tool_use',
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      }]
      turn.sequence.push({ type: 'tool', blocks: group })
      pushTurnSnapshot(sessionId, turn)
      // 工具开始日志（运行面板"工具"筛选可见）：参数截断+脱敏，避免大参数/密钥刷屏
      sessionLog(sessionId, 'info', 'tool', `工具 ${event.toolName || '未知'} 开始：${sanitizeArgsForLog(event.args)}`, { tool: event.toolName, toolCallId: event.toolCallId })
      // ★1020：微信侧工具进度（start）—— 详见 notifyWechatToolProgress 的注释
      notifyWechatToolProgress('start', sessionId, event.toolName, event.toolCallId)
      break
    }

    case 'tool_execution_end': {
      // 工具耗时累加（不依赖 turn 累积器存在——team_dispatch 等长工具的等待时间必须计入 toolMs）
      let elapsed = 0
      if (session.toolStartTime != null) {
        elapsed = Date.now() - session.toolStartTime
        session.toolMsTotal = (session.toolMsTotal || 0) + elapsed
        session.toolStartTime = undefined
      }
      // ★1020：微信侧工具进度（end，带成败）
      notifyWechatToolProgress('end', sessionId, event.toolName, event.toolCallId, event.isError ? 'failed' : 'completed')
      // 工具执行结束统一留痕（成功 info / 失败 error）——之前成功路径无日志，
      // 运行面板"工具"筛选看不到调用过程（用户反馈：过程中调用了什么工具看不到）
      if (event.isError) {
        const raw = typeof event.result === 'string' ? event.result : JSON.stringify(event.result?.content ?? event.result ?? '')
        const firstLine = String(raw || '').split('\n')[0]?.slice(0, 200) || ''
        sessionLog(sessionId, 'error', 'tool', `工具 ${event.toolName || '未知'} 执行失败（${elapsed}ms）：${firstLine}`)
      } else {
        sessionLog(sessionId, 'info', 'tool', `工具 ${event.toolName || '未知'} 执行完成（${elapsed}ms）`, { tool: event.toolName, toolCallId: event.toolCallId })
      }
      // 变更区实时刷新广播（0902 反馈 #1）：写/删/命令类工具结束时通知前端重拉变更列表——
      // 面板开着不重开也能看到本轮 AI 写文件的新条目（此前只在切会话/打开/恢复后才 load）
      if (['fs_write', 'fs_delete', 'run_command', 'fs_rename', 'project_fs_write', 'project_fs_delete', 'project_run_command'].includes(event.toolName || '') && !event.isError) {
        broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'workspace-changed', value: { tool: event.toolName, t: Date.now() }, seq: 0 })
      }
      const turn = turnAccumulators.get(sessionId)
      if (!turn) break
      const resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
      // 工具结果挂到序列中最后一个 tool 组
      const last = turn.sequence[turn.sequence.length - 1]
      if (last && last.type === 'tool') {
        last.blocks.push({
          type: 'tool_result',
          toolUseId: event.toolCallId,
          content: resultText,
          isError: event.isError,
        })
      }
      pushTurnSnapshot(sessionId, turn)
      // transcript 增量落盘（0902 事故止损）：此前只在 agent_end 快照——进程被杀（如成员
      // 误跑 taskkill /IM node.exe）时整轮消息全丢。工具事件是 turn 内最稳定的节拍点，
      // 挂 schedulePersist（500ms 节流，非每事件同步写盘）后强杀最多丢最后一条
      try {
        const agentLive = agents.get(sessionId) as any
        const live = agentLive?.state.messages
        /* ★0926 C1（降负提速·第一堵点）：transcript 改 **borrow**（ZCode borrow/snapshot 同款约定）——
           此前每工具一次 `JSON.parse(JSON.stringify(live))` 全量深拷贝（O(全上下文)×2 序列化，
           工具循环主线程大头）。约定：transcript 借用 agent 的 live 消息数组，**只读不改**，
           谁需要独立快照谁自己拷（恢复/导出路径自行处理）；live 在 agent 存活期只追加 →
           transcript 只会更全（恢复语义不降）；agent 销毁后数组仅剩此引用，天然稳定。
           下方 agent_end/thinking-loop 的收尾拷贝因 `live.length > transcript.length` 同引用恒 false 自然短路（有意保留）。 */
        const _tLen = Number((session as any)._transcriptBorrowLen) || 0
        if (Array.isArray(live) && live.length > 0 && live.length > _tLen) {
          session.transcript = live
          ;(session as any)._transcriptBorrowLen = live.length
          session.updatedAt = Date.now()
          schedulePersist(sessionId)
        }
      } catch { /* ignore */ }
      break
    }

    case 'agent_end': {
      /* ★1005（已定案"分身还在跑 ⇒ 会话就是进行中"，且必须是真实后端状态）：
         看门狗登记表里还有该会话在跑的成员/分身 run ⇒ **保持 running**（不置 idle、
         帧也发 running:true），等最后一个 run 收尾由 setSubAgentsIdleHook 统一置 idle 并广播。
         前端**零改动**：它本来就按 session/status 帧的 running 驱动列表状态与停止键。 */
      const _stillRuns = runningSubAgentCount(sessionId)
      session.status = _stillRuns > 0 ? 'running' : 'idle'
      const endUsage = extractUsage(event)
      /* ★ 0925ad（用户质疑实锤："回复完成"原来无条件打——异常中断也报完成，日志无法区分）：
         按最后消息的 stopReason 区分收尾形态（正常/中断/异常分开记），下次"断没断"有实证。 */
      const _lastAsst = [...((event as any)?.messages || [])].reverse().find((m: any) => m?.role === 'assistant')
      const _stop = String(_lastAsst?.stopReason || '')
      /* ★0927（实测反馈"消息明显没回完、界面却显示回复完成"）：上游会**假报正常完成** ——
         finish_reason=stop 但正文停在半句上（实据见 detectTruncatedTail 注释）。只按 stopReason 判
         "完成"就把断句当正常收尾、用户被误导，所以这里补一道"正文未收尾"体检：命中如实记 warn，
         并给用户一条内联提示（复用 session-notice 通道，前端已有消费逻辑，零改动）。 */
      const _trunc = _stop === 'stop' ? detectTruncatedTail(_lastAsst) : ''
      const _endLabel = _stop === 'aborted' ? '回复中断（用户停止）'
        : (_stop && _stop !== 'stop' ? `回复异常结束（stopReason=${_stop}）`
          : (_trunc ? `回复疑似被上游截断（${_trunc}）` : '回复完成'))
      /* ★0926：异常收尾把**上游错误原文**落日志。此前只有 `stopReason=error` 四个字，
         真凶（400 参数/429 限流/网络断/超窗）完全看不见，只能靠猜 ——
         0926 实测"雨天的窗台被截断"就吃了这个亏（日志里查不到任何错误正文）。
         pi 的错误藏在最后一条 assistant 消息的 errorMessage 里（不抛异常、不发独立 error 事件）。 */
      const _errMsg = _stop === 'error' ? String((_lastAsst as any)?.errorMessage || '').slice(0, 240) : ''
      sessionLog(sessionId, _endLabel === '回复完成' ? 'info' : 'warn', 'lifecycle',
        `${_endLabel}（${endUsage?.completionTokens ?? '?'} out / ${endUsage?.promptTokens ?? '?'} in tokens）${_errMsg ? ` · 上游错误：${_errMsg}` : ''}`, undefined)
      if (_trunc) {
        /* 用户可见提示：项目约定"内联提示 ≤60 字一句话"。广播失败不阻断收尾（提示是通知不是状态变更）。 */
        try {
          broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'session-notice', seq: Date.now(), value: { text: '⚠ 上一条回复疑似被上游截断（没说完就停了）' } })
        } catch { /* 广播失败不影响收尾 */ }
      }
      broadcastHost({ type: 'host/session-status', sessionId, running: false })
      // 0912 接入批：通道会话 → 把本轮结果回推给 IM（异步，不阻塞 agent 事件处理）
      {
        // FIFO 消费：本轮对应的入站消息目标（队列化后每条消息各占一位，不会再错位）
        const rt = shiftReplyTarget(sessionId)
        /**
         * 二十一批：本轮截图清单**无条件消费**（即使没有回推目标也要清空）——
         * 否则会跨轮泄漏，下一轮把上一轮的图重复发出去。
         */
        const shotPaths = consumeTurnShots(sessionId)
        if (rt) {
          const finalText = extractFinalAssistantText(sessionId, (event as any)?.messages)
          const aborted = [...((event as any)?.messages || [])].reverse()
            .find((m: any) => m?.role === 'assistant')?.stopReason === 'aborted'
          const rawBody = aborted
            ? (finalText ? `${finalText}\n\n（已中断）` : '已中断当前执行。')
            : finalText
          /**
           * 媒体指令解析（0912 六批）：回复里的 `MEDIA:<路径>` 独立行 → 真发文件/图片。
           * 之前只发文本，agent 说「截图给你了」但用户永远收不到（用户实测反馈）。
           * 顺序：先发正文（若有），再逐个发媒体；单个媒体失败只提示该项，不影响其余。
           */
          const { text: bodyTextRaw, media: mediaRaw } = extractMediaDirectives(rawBody)
        /* ★1014a【通道侧清洗】模型有时把思考过程当"正文文本"吐出来（`<think>…</think>` 混在
           text 块里，而不是独立的 reasoning 块）—— QQ/微信是纯文本，会原样显示 ⇒
           用户看到「露 think」且内容与正式回答重复两遍（实测）。
           PC 端不受影响：浏览器认得该标记、会自动折叠成思考块，所以这里只清洗通道回推。
           ⚠️ 仅作用于本分支的局部变量；不碰 PC、不碰 delta 流、不碰会话。 */
        const bodyText = String(bodyTextRaw || '')
          .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
          .replace(/<\/?think\b[^>]*>/gi, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          /**
           * 二十一批（排期 #8 根因修）：**相对路径按会话工作区解析**。
           * 之前直接 path.resolve（= 后端进程 cwd）—— AI 偶尔写相对路径时，
           * 会命中后端目录里同名旧文件 → 用户「收到的和她写的不是一个文件」（用户实测）。
           * 绝对路径不受影响；相对路径优先挂到会话工作区下面。
           */
          const wdForMedia = sessions.get(sessionId)?.workDir?.trim() || ''
          const media = mediaRaw.map((m) => {
            let out: typeof m = m
            if (m.path && !path.isAbsolute(m.path) && wdForMedia) {
              const p = path.join(wdForMedia, m.path)
              console.log(`[channel] MEDIA 相对路径按工作区解析：${m.path} → ${p}`)
              out = { ...out, path: p }
            }
            // 二十二批：路径打错字也救一次（按文件名在工作区里找）
            if (out.path) {
              const fixed = resolveMediaPathLoose(out.path, wdForMedia)
              if (fixed.note) console.log(`[channel] ${fixed.note}`)
              if (fixed.path !== out.path) out = { ...out, path: fixed.path }
            }
            return out
          })
          /**
           * 二十一批：**本轮截图自动补发**——AI 用 wb_send_screenshot 截的图只进了 PC 对话流，
           * 手机端（QQ/微信）收不到。这里把当轮截图清单并进媒体列表：
           * 与 MEDIA: 已发过的同路径去重，顺序放在 MEDIA: 之后。
           */
          const alreadySent = new Set(media.map(m => (m.path ? path.resolve(m.path) : '')).filter(Boolean))
          const shotMedia = shotPaths
            .filter(p => !alreadySent.has(path.resolve(p)) && fs.existsSync(p))
            .map(p => ({ path: p, name: path.basename(p) }))
          if (shotMedia.length) console.log(`[channel] 本轮截图 ${shotMedia.length} 张 → 自动补发到 ${rt.channel}:${String(rt.peerId).slice(0, 8)}`)
          const mediaAll = [...media, ...shotMedia]
          // 0912 十九批：任务线回复带 `⏰任务名` 前缀（用户要求能一眼区分是哪条线在说话）
          const prefixedBody = rt.prefix && bodyText ? `${rt.prefix}\n${bodyText}` : bodyText
          // 任务线回复单独记一行日志（排查「前缀没带上 / 回错了通道」时一眼可见）
          if (rt.prefix) console.log(`[channel] 任务线回复（前缀「${rt.prefix}」）→ ${rt.channel}:${String(rt.peerId).slice(0, 8)}`)
          void (async () => {
            try {
              /* ★1014b：本轮若走过流式 → 终帧收尾（input_state:10 + 完整正文）并**跳过**这条一次性
                 正文（否则用户会收到两遍）。收流失败 / 没走流式 → streamed=false，照原路发（降级）。 */
              const _st = qqStreams.get(sessionId)
              const _done = qqStreamDone.get(sessionId)
              let streamed = false
              if (_st && _st.rt.messageId === rt.messageId) {
                streamed = await qqStreamFinish(sessionId, prefixedBody)
              } else if (_done && _done.messageId === rt.messageId && Date.now() - _done.at < 60_000) {
                // 已由宽限/超时路径收过流 → 不再发一次性正文，否则用户看到两遍
                streamed = true
                console.warn(`[qq-stream] 本轮已由流式收尾（宽限路径），跳过一次性正文以免重复 session=${sessionId.slice(0, 8)}`)
              }
              if (prefixedBody && !streamed) await deliverToChannel(rt, prefixedBody)
              for (const m of mediaAll) {
                try {
                  await deliverMediaToChannel(rt, m)
                } catch (e: any) {
                  console.error(`[channel] 媒体发送失败（${m.name}）: ${String(e?.message || e).slice(0, 200)}`)
                  await deliverToChannel(rt, `（附件「${m.name}」发送失败：${String(e?.message || e).slice(0, 100)}）`).catch(() => { /* ignore */ })
                }
              }
              if (!bodyText && !mediaAll.length) await deliverToChannel(rt, '（无输出）')
              // 0914 下午：机器人回复完成 → 广播给 PC 前端（设置→提示「机器人回复」通知；投递失败不广播）
              try {
                const preview = (bodyText || (mediaAll.length ? `（${mediaAll.length} 个媒体文件）` : '（无输出）'))
                  .replace(/\s+/g, ' ').trim().slice(0, 80)
                broadcastHost({
                  type: 'host/channel-reply',
                  sessionId,
                  channel: rt.channel,
                  botId: rt.botId,
                  kind: rt.kind || '',
                  title: sessions.get(sessionId)?.title || '',
                  preview,
                  at: Date.now(),
                })
              } catch { /* 广播失败不影响投递 */ }
            } catch (e: any) {
              /**
               * 0920（#4①）：**回推失败必须让用户看得见**。
               * 以前这里只有一句 console.error —— 用户看到的现象就是
               * 「AI 在 NIS 里回了、QQ 里一直没动静」，而且完全不知道发生了什么。
               * 现在把失败如实记进本会话（展示态 + 模型上下文都写），
               * 用户能在 NIS 里看到原因，AI 下一轮也知道自己上一条没送到。
               */
              const failNote = String(e?.message || e).slice(0, 200)
              console.error(`[channel] 回推失败: ${failNote}`)
              try {
                appendTaskNotice(sessionId, `⚠️ 这条回复没能发到 ${rt.channel === 'qq' ? 'QQ' : '微信'}：${failNote}\n（内容已留在本对话里，可直接在这里查看。）`)
              } catch { /* 记不进去也不影响主流程 */ }
            }
          })()
        }
      }
      // 中断轮判定：本轮最后一条 assistant 的 stopReason=aborted（用户点停止/session.cancel）。
      // 中断时 usage 块通常没发过来（在流末尾）——统计口径全部保留上一轮真实值，
      // 否则旧 usage + 中断时刻 timing 混搭会把 tok/s 稀释到不准（第三胶囊/复制数据失真的根因）
      const turnMsgs = (event as any)?.messages || []
      const lastTurnAsst = [...turnMsgs].reverse().find((m: any) => m?.role === 'assistant')
      const abortedTurn = lastTurnAsst?.stopReason === 'aborted'
      // 提取真实 usage（最后一次 LLM 请求的完整上下文 token）——只负责「上下文圆环/纠偏锚点」（末跳=当前占用）
      const usage = extractUsage(event)
      /* ★ 0924（token 对账实测修）：整轮 usage = 本 turn **所有跳**的 usage 求和 —— 输入三件套也要算！
         实测（transcript 逐跳验尸 + 官网逐字段对账）：agent 每跳全量重发上下文、账单按跳累计；
         旧口径输入只取「回合末跳」（findLastRealUsage）→ 漏掉前 N-1 跳的整段输入（面板 36.6K vs 账单 87.9K），
         且末跳缓存最暖 → 缓存命中率虚高（面板 96% vs 真实 58%）。
         输出侧早已是求和口径（tok/s 修），这里把输入补齐到同一口径。
         对账验证：Σ跳 usage 与官网增量逐字段分毫不差（82,304 / 82,324 / 16,232 三对全中）。 */
      const turnSums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      if (Array.isArray(turnMsgs)) {
        for (const m of turnMsgs) {
          if (m?.role !== 'assistant' || !m?.usage) continue
          turnSums.input += m.usage.input ?? m.usage.prompt_tokens ?? 0
          turnSums.output += m.usage.output ?? m.usage.completion_tokens ?? 0
          turnSums.cacheRead += m.usage.cacheRead ?? 0
          turnSums.cacheWrite += m.usage.cacheWrite ?? 0
        }
      }
      const hasTurnSums = !!(turnSums.input || turnSums.output || turnSums.cacheRead || turnSums.cacheWrite)
      let turnOutputTokens = usage?.completionTokens || 0
      if (turnSums.output > 0) turnOutputTokens = turnSums.output
      // 个别供应商不回填消息级 usage 时退回旧口径（末跳 + 整轮输出），统计条不空白
      const turnUsageFrame = hasTurnSums
        ? { promptTokens: turnSums.input, completionTokens: turnOutputTokens, cacheReadTokens: turnSums.cacheRead, cacheWriteTokens: turnSums.cacheWrite }
        : { ...usage, completionTokens: turnOutputTokens }
      if (abortedTurn) {
        // lastUsage 不清空：回退 agent 实时 transcript 里最后一条真实 usage
        //（中断轮自身新增 token 无权威数据，按最近一次上报口径保持上下文圆环稳定）
        const liveMsgs = agents.get(sessionId)?.state.messages
        const prevUsage = findLastRealUsage(Array.isArray(liveMsgs) ? liveMsgs : [])
        if (prevUsage) session.lastUsage = prevUsage
        /* ★0927（用户"不出任何问题"）：中断轮**不撤销压缩锚点** —— 中断轮没有新 usage
           （上面回退的还是压缩前的旧值），此时撤销 ⇒ 下一轮判定拿压缩前的大值反复判超线
           ⇒ 可能立刻触发一次多余压缩、圆环跳回旧高值（与 session.cancel 路径对齐：
           那条本来就不删，只保留锚点等新 usage）。留着只会让下一轮判定偏保守（低估），
           等那轮真实 usage 回来再走下面的正常撤销。 */
      } else {
        session.lastUsage = usage
        /* 0921：本轮成功了 —— 上下文纠偏锚点（撞线时供应商实报的数）**用完即弃**：
           之后的校准交给"同一次请求的 估算 vs 真实 usage"这对数字（更贴近当前内容构成）。 */
        delete session.ctxOverflowRealInput
        delete session.ctxOverflowEstimate
        /* ★ 0923（P0 修 · 防抖）：新 usage 到手 → 撤销"压缩后锚点"，ctxUsedTokens 回到真实口径。
           这条同时实现了 opencode 的"压缩后必须等新 usage"语义。
           ★0927 R11（实测"压缩×圆环互动不稳"第二因）：**本回合中途**做的压缩
           （手动 compactNow / 自动）不算"新 usage 到手"—— 这轮的大 usage 是压缩**前**的
           上下文发出去的，拿它当新基线 ⇒ 下一轮误判超线、立刻再压一次（圆环弹回去）。
           判据：锚点设置时间晚于本回合开始 ⇒ 保留，等下一轮真 usage 再撤。 */
        const _ovAt = Number((session as any).ctxUsedOverride?.at) || 0
        /* 0928 T4c B2 retirement: judge against lastSentAt (NOT turnStartTime -- the 0927 note
           above is superseded). The usage arriving here reflects the request stamped at
           lastSentAt: anchor created BEFORE that send => this bill is post-compaction =>
           BOTH anchor fields retire (deleting ctxUsedOverride alone leaves ctxUsedForRing
           masking the real usage in session.context forever = double counting). Anchor NEWER
           than the last send (compacted mid-turn after the request went out) => this bill is
           pre-compaction, keep the anchor until a post-compaction bill arrives. */
        if (_ovAt < (Number((session as any).lastSentAt) || 0)) {
          delete (session as any).ctxUsedOverride
          delete (session as any).ctxUsedForRing
        }
      }
      // turn 计时：TTFT = 首 token - 开始；LLM 耗时 = 结束 - 开始 - 工具耗时
      //（工具执行/团队子 agent 等待时间不计入 LLM 耗时，否则团队轮 llmMs 虚高数倍）
      // 中断轮不覆盖 lastTurnTiming（保留上一轮真实值）
      if (!abortedTurn && session.turnStartTime != null) {
        const totalMs = Date.now() - session.turnStartTime
        const toolMs = session.toolMsTotal || 0
        session.lastTurnTiming = {
          llmMs: Math.max(0, totalMs - toolMs),
          ttftMs: session.firstTokenTime != null ? session.firstTokenTime - session.turnStartTime : 0,
          toolMs,
        }
      }
      const timingFrame = abortedTurn ? undefined : { ...(session.lastTurnTiming || { llmMs: 0, ttftMs: 0 }) }
      // 写时补全：本轮 timing/usage 落 turnMetas（ts = 本轮最后一条 assistant 消息的 timestamp，
      // history 响应时服务端按 ts 挂到消息 _turnMeta）。中断轮无权威数据不落
      if (!abortedTurn && timingFrame) {
        if (!Array.isArray(session.turnMetas)) session.turnMetas = []
        const anchorTs = Number(lastTurnAsst?.timestamp) || Date.now()
        // 0910：usage 带缓存三字段，AI 组悬停统计显示"本轮命中率"（口径同 StatsLine：promptTokens 已是未命中部分）
        session.turnMetas.push({ ts: anchorTs, timing: timingFrame, usage: { completionTokens: turnUsageFrame.completionTokens || 0, promptTokens: turnUsageFrame.promptTokens || 0, cacheReadTokens: turnUsageFrame.cacheReadTokens || 0, cacheWriteTokens: turnUsageFrame.cacheWriteTokens || 0 } })
        if (session.turnMetas.length > 200) session.turnMetas = session.turnMetas.slice(-200)
        /* ★1012：缓存命中率骤降自检（一行日志）。
           缘由：全库 18578 跳实测 —— 热跳（间隔<2min）加权命中 97.9%（说明前缀设计没问题），
           真正烧钱的是"隔久了才发的那一轮"：间隔 5~30min 命中 68%、>2h 只剩 13.8%
           （供应商前缀缓存 TTL 5~10 分钟，一过期就是全价重算）。这行让这种轮次在运行日志里
           一眼可见，用户不用翻统计条就知道"这轮为什么贵"。命中率低但间隔很短的，多半是该
           供应商不做/不返回缓存字段（实测 agnes 系 gap=4s 仍零命中，deepseek/mimo 则 97%+）。 */
        {
          const _fullIn = (turnUsageFrame.promptTokens || 0) + (turnUsageFrame.cacheReadTokens || 0) + (turnUsageFrame.cacheWriteTokens || 0)
          const _hit = _fullIn > 0 ? (turnUsageFrame.cacheReadTokens || 0) / _fullIn : 1
          if (_fullIn > 30000 && _hit < 0.5) {
            const _prevTs = Number(session.turnMetas[session.turnMetas.length - 2]?.ts) || 0
            const _gapSec = _prevTs > 0 ? Math.round((anchorTs - _prevTs) / 1000) : 0
            const _gapTxt = _gapSec > 0 ? `，距上轮 ${_gapSec < 120 ? `${_gapSec} 秒` : `${Math.round(_gapSec / 60)} 分钟`}` : ''
            sessionLog(sessionId, 'warn', 'llm',
              `缓存命中率偏低：本轮完整输入 ${_fullIn.toLocaleString()} token，命中 ${(turnUsageFrame.cacheReadTokens || 0).toLocaleString()}（${(_hit * 100).toFixed(1)}%）${_gapTxt}`
              + ' —— 间隔久＝供应商前缀缓存已过期（正常现象，本轮全价重算）；间隔很短仍低＝该供应商不做/不返回缓存')
          }
        }
        /* ★1012b：**跳级**判据补位 —— 上面那条按"轮求和"算，抓不到"轮内某一跳整条前缀报废"，
           而那恰恰是最贵的一击（实测本工作会话：重启后第一跳 121,702 token、中断后第一跳
           142,606 token 均 0% 命中，可该轮求和仍有 ~87% ⇒ 轮级判据一声不吭，用户只看到
           "缓存 79%" 一头雾水）。跳级信号取「cacheRead=0 且完整输入>3 万」：新增内容造成的
           正常损耗不会是 0（那是"命中大头 + 新内容未命中"）。
           全库量化：286 跳 / 1.5%，映射到 257 轮 / 8.3% 会记一行（不刷屏）；
           其中 40% 发生在间隔<2 分钟时 ⇒ 那些不是过期，是前缀被改写或供应商不缓存。 */
        if (Array.isArray(turnMsgs)) {
          let _deadN = 0
          let _deadMax = 0
          for (const _m of turnMsgs) {
            if (_m?.role !== 'assistant' || !_m?.usage) continue
            const _cr = Number(_m.usage.cacheRead) || 0
            const _full = (Number(_m.usage.input ?? _m.usage.prompt_tokens) || 0) + _cr + (Number(_m.usage.cacheWrite) || 0)
            if (_full > 30000 && _cr === 0) { _deadN += 1; if (_full > _deadMax) _deadMax = _full }
          }
          if (_deadN > 0) {
            sessionLog(sessionId, 'warn', 'llm',
              `缓存整条未命中：本轮有 ${_deadN} 跳完全没吃上缓存（最大 ${_deadMax.toLocaleString()} token 全价重算）`
              + ' —— 间隔短＝前缀被改过（本轮改过项目档案/设置、换过预设、或上一轮被中断）；间隔久＝供应商缓存已过期；'
              + '平时命中就低（如 agnes 系）＝该供应商不做/不返回缓存')
          }
        }
      }
      /* ★ 0924（token 对账修）：会话级 usage 单调账本 —— 每轮累加（**含中断轮**：中断轮已消耗的
         token 是真实账单，不记就对不上账）。只增不减：删轮/重跑不回退 —— 账单也不退款。
         （turnMetas 只留最近 200 条、删轮还移除条目，拿它求和会让长会话"累计"越跑越少。） */
      if (hasTurnSums || turnOutputTokens > 0) {
        const ut = session.usageTotals || (session.usageTotals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 })
        ut.uncached += turnUsageFrame.promptTokens || 0
        ut.cacheRead += turnUsageFrame.cacheReadTokens || 0
        ut.cacheWrite += turnUsageFrame.cacheWriteTokens || 0
        ut.output += turnUsageFrame.completionTokens || 0
        ut.turns += 1
      }
      // per-model 统计：按本 turn 实际生成模型记录（同一模型重复使用覆盖更新，usedModels 去重）
      // 中断轮不覆盖（modelUsage 保留上一轮真实值）
      const turnModel = turnAccumulators.get(sessionId)?.model || currentLlmConfig().model
      if (!abortedTurn && turnModel) {
        if (!session.modelUsage) session.modelUsage = {}
        if (!session.usedModels) session.usedModels = []
        if (!session.usedModels.includes(turnModel)) session.usedModels.push(turnModel)
        // usage 口径（0924 token 对账修）：整轮**全跳求和**（≡ 账单）；"当前上下文占用"由 lastUsage（末跳）负责，互不串台
        session.modelUsage[turnModel] = { timing: session.lastTurnTiming, usage: turnUsageFrame }
      }
      // 0920：带上本轮 AI 回复摘要 + 对话名（系统提醒要「对话名 + 摘要」）。
      // 对话名取后端权威值——前端 store 对"刚建的新会话"可能还没同步，会退化成兜底文案。
      const replyPreview = buildReplyPreview(turnAccumulators.get(sessionId))
      broadcastMux(sessionId, { type: 'session/status', sessionId, running: _stillRuns > 0, agentEnd: true, usage: turnUsageFrame, timing: timingFrame, model: turnModel, aborted: abortedTurn, replyPreview, sessionTitle: session.title })
      // turn 收尾：整条（多段落 + 工具 + 流式尾）落库为一条 assistant 消息
      const turn = turnAccumulators.get(sessionId)
      if (turn) {
        turnAccumulators.delete(sessionId)
        // 流式尾入序列
        const tailText = (turn.text || '').trim()
        const tailReasoning = (turn.reasoning || '').trim()
        if (tailText || tailReasoning) {
          turn.sequence.push({ type: 'text', text: tailText, reasoning: tailReasoning })
          turn.text = ''
          turn.reasoning = ''
        }
        const hasContent = turn.sequence.some(item =>
          (item.type === 'text' && (item.text || item.reasoning))
          || (item.type === 'tool' && item.blocks.length > 0))
        if (hasContent) {
          const dshMsg: DSHMessage = {
            id: turn.id,
            role: 'assistant',
            content: assembleTurnContent(turn),
            timestamp: Date.now(),
            expectFinal: true,
            model: turn.model,
          }
          session.messages.push(dshMsg)
          broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_updated', message: dshMsg }, expectFinal: true })
        } else {
          // 完全空 turn（abort/异常）：移除前端占位消息
          /* ★1005 修类型：content 的类型是 `ContentBlock[]`，这里原来直接赋**裸字符串** ——
             与本文件所有其它消息构造（content: [{ type:'text', text }]）不一致，前端按块渲染时形状不对。
             这条走"abort/异常且无输出"的边路径。改成标准的单文本块。 */
          const dshMsg2: DSHMessage = { id: turn.id, role: 'assistant', content: [{ type: 'text', text: '（本轮 abort/异常且无输出：占位保留不删除）' }], timestamp: Date.now(), expectFinal: true }
          session.messages.push(dshMsg2)
          broadcastMux(sessionId, { type: 'session/event', sessionId, event: { type: 'message_updated', message: dshMsg2 } })
        }
      }
      /* ★0927（①b）：**未读主动推送** —— 必须放在"本轮 assistant 消息已 push 进 session.messages"**之后**！
         （第一版放在上面，数的时候消息还没落库 ⇒ unreadCountOf=0 ⇒ 静默不推，隔离实测 0 帧抓到。）
         走全局桶（writeMuxTo('')），任何窗口都收得到 —— 不再只靠 agent_end 事件帧在本地 +1
         （丢帧/组件没挂载/刚重连/人在别的窗口，角标都会漏）。
         只在 >0 时推：正在看这条会话的窗口不会闪角标（它那边 markRead 会把口径归零）。 */
      if (!abortedTurn) {
        try {
          const _unread = unreadCountOf(session)
          if (_unread > 0) writeMuxTo('', { type: 'session/projection', sessionId, key: 'unread', seq: Date.now(), value: { unread: _unread } })
          else console.warn(`[unread] 本轮收尾未读=0，不推（session=${sessionId.slice(0, 8)}，lastReadAt=${session.lastReadAt}）`)
        } catch (e) { console.warn('[unread] 推送失败:', String((e as any)?.message || e)) }
      }
      // agent_end 快照（原有：完整落盘 + 团队 subRuns 注入）
      try {
        const agent = agents.get(sessionId)
        const transcript = agent?.state.messages
        if (Array.isArray(transcript) && transcript.length > 0) {
          session.transcript = JSON.parse(JSON.stringify(transcript))
          injectSubRuns(session.transcript, sessionId)
          session.updatedAt = Date.now()
          schedulePersist()
        }
      } catch { /* ignore */ }
      // AI 生成会话标题：未手动命名且尚未成功生成过就在每轮结束尝试（首轮失败后后续轮可补生成，
      // 旧版只在第 1 轮触发、一旦网络/解析失败该会话永远停在首条消息截断标题——0910 修复）
      if (!session.titleManual && !session.titleGenerated) {
        void generateSessionTitle(sessionId)
      }
      // 0909⑦：整轮自然结束（非中断非错误）后自动续发排队消息。agent_end 监听器里直接调
      // agent.prompt 会撞 pi 的"already processing"（agent_end 发出时 run 尚未 settle），
      // 必须 waitForIdle（README：all awaited listeners settle 之后才算 idle）。
      {
        const settledAgent = agents.get(sessionId)
        if (settledAgent && !abortedTurn) {
          void settledAgent.waitForIdle().then(() => {
            if (agents.get(sessionId) !== settledAgent) return
            flushNextQueued(sessionId)
            /* ★ 0923：队列优先（用户消息先发）—— 队列空了才轮到「后台事件自动续跑」 */
            if (!queueSnapshot(sessionId).length) drainBgResumeAfterIdle(sessionId)
          }).catch(() => { /* ignore */ })
        } else if (settledAgent && abortedTurn) {
          /* ★ 0923：本轮是用户中断的 → 续跑链暂停（与 session.cancel 同口径的双保险） */
          const c = bgResumeChains.get(sessionId)
          if (c) { c.stopped = true; parkBgResumePending(sessionId) }
        }
      }
      break
    }

    default:
      break
  }
}

/** 给 transcript 中 team_dispatch 的 toolResult 注入成员 runs 快照（黑板 runs 按 stepId 匹配）。
 *  供 agent_end 快照与 session.history 共用——中途刷新时 agent_end 还没到，history 侧必须兜底注入，
 *  否则成员气泡刷新即丢（0831 深夜用户反馈 #3） */
function injectSubRuns(transcript: any[], sessionId: string): void {
  try {
    /* ★ 0925ab（实测"刷新后分身气泡没了"）：runs 合并真黑板 + 分身黑板（#clone）——
       分身的回放快照落 ${sessionId}#clone 黑板文件（见 cloneRuntime），旧逻辑只读真黑板 → 气泡不恢复。 */
    const bbRuns = [
      ...(loadBlackboard(sessionId)?.runs as any[] | undefined || []),
      ...(loadBlackboard(`${sessionId}#clone`)?.runs as any[] | undefined || []),
    ]
    /* ★0928 T2：subRuns 落盘读写 —— 黑板 runs 只留最近 60 条、清黑板/删会话即失，重启后靠不住。
       命中的 runs 同步登记进 session.subRuns（toolCallId → runs[]，随会话顶层字段落盘），
       黑板取不到时用它兜底回填。只在内容变化时置脏 + schedulePersist 节流写盘，注入循环内绝不写盘。 */
    const sess: any = sessions.get(sessionId)
    const savedRuns: Record<string, any> = (sess?.subRuns && typeof sess.subRuns === 'object' && !Array.isArray(sess.subRuns)) ? sess.subRuns : {}
    let subRunsDirty = false
    if ((!Array.isArray(bbRuns) || bbRuns.length === 0) && Object.keys(savedRuns).length === 0) return
    for (const msg of transcript) {
      if (msg?.role !== 'toolResult' || !['team_dispatch', 'spawn_clone'].includes(String(msg?.toolName)) || msg.subRuns) continue
      const stepIds = new Set<string>()
      for (const m2 of transcript) {
        if (m2?.role !== 'assistant' || !Array.isArray(m2.content)) continue
        for (const c of m2.content) {
          if (c?.type === 'toolCall' && c.name === 'team_dispatch' && c.id === msg.toolCallId) {
            for (const t of (c.arguments?.tasks || [])) stepIds.add(String(t?.stepId || ''))
          }
        }
      }
      let matched = (Array.isArray(bbRuns) ? bbRuns : []).filter((r: any) => stepIds.has(String(r.stepId)))
      if (matched.length === 0) {
        // 黑板 runs 已失（截断/清板/重启）→ 用落盘表按 toolCallId 兜底回填
        const saved = savedRuns[String(msg.toolCallId || '')]
        if (Array.isArray(saved) && saved.length > 0) matched = saved
      }
      if (matched.length > 0) {
        (msg as any).subRuns = JSON.parse(JSON.stringify(matched))
        // ★0928 T2：登记进会话级落盘表（只在内容变化时置脏，读路径不会反复触发落盘）
        const key = String(msg.toolCallId || '')
        if (sess && key) {
          if (!sess.subRuns || typeof sess.subRuns !== 'object') sess.subRuns = {}
          const nextJson = JSON.stringify(matched)
          if (JSON.stringify(sess.subRuns[key] || null) !== nextJson) {
            sess.subRuns[key] = JSON.parse(nextJson)
            subRunsDirty = true
          }
        }
      }
    }
    // ★0928 T2：变更才落盘，且走 schedulePersist 去抖节流（500ms/2s 兜底）——绝不循环内/每条写盘
    if (subRunsDirty) schedulePersist(sessionId)
  } catch { /* ignore */ }
}

// ============================================================================
// HTTP Server
// ============================================================================

/* ═══ 0906 体检 P0#1 安全闸门：Origin 来源校验 ═══
 * 恶意网页的跨源 fetch 必带 Origin 且无法伪造——不在白名单即 403；
 * 本机前端（同源无 Origin/同源 Origin）、Tauri 壳、curl/脚本（无 Origin）全部放行，体验零变化。
 * 远程访问（手机端/局域网）叠加可选 NIS_TOKEN 环境变量：设置后所有请求须带 x-nis-token 头。 */
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:8766', 'http://localhost:8766',
  'http://127.0.0.1:5174', 'http://localhost:5174',   // dev 前端（vite --port 5174）
  'http://127.0.0.1:5175', 'http://localhost:5175',   // dev 备用端口
  'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost',
])
const NIS_TOKEN = process.env.NIS_TOKEN || ''

/** ★1011：当前生效的访问令牌 —— 环境变量优先（兼容旧用法/容器部署），否则用面板自动生成并持久化的那个 */
function currentAccessToken(): string {
  const env = String(NIS_TOKEN || '').trim()
  if (env) return env
  try { return String((getChannel('remote') as any)?.remoteToken || '').trim() } catch { return '' }
}
/** 最近一次防火墙放行结果（供 remote.info 透出，便于排查"外部连不上"） */
let _lastFirewallState = 'unknown'
/** ★1011q：确保 Windows 防火墙放行本端口。
 *  不做这件事的后果（本次实测踩过）：手机/另一台电脑访问会一直"响应时间过长"
 *  （ERR_CONNECTION_TIMED_OUT），而**本机 curl 却是通的**（本机流量不经防火墙）⇒ 完全看不出病因。
 *  ⚠️ 改防火墙必须管理员：所以走 UAC 提权（Start-Process -Verb RunAs），会弹一次"是否允许"确认框；
 *  已经是管理员（打包版常见）则静默通过。已放行过就不再添加（先查后加），规则名固定 NIS-Remote-<端口>。
 *  规则用 `-Profile Any`：网卡可能被 Windows 认成"公用网络"，只放 Private 会静默不生效。 */
async function ensureFirewallRule(ports: number[]): Promise<{ ok: boolean; state: string }> {
  if (process.platform !== 'win32') return { ok: true, state: 'skipped-not-windows' }
  /* 可能要给**两个**端口放行：后端端口 + 当前界面端口（dev 模式下手机经 dev server 进来，
     防火墙拦的是那个端口）。一次命令全加上 ⇒ 只弹一次 UAC。 */
  const list = [...new Set(ports.filter(n => Number.isFinite(n) && n > 0))]
  if (!list.length) return { ok: true, state: 'no-port' }
  const names = list.map(p => `NIS-Remote-${p}`)   // 故意不带空格：省去嵌套引号的转义坑
  const runPs = (cmd: string) => new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 25000, windowsHide: true }, (err: any, stdout: any) => {
      if (err) reject(err); else resolve(String(stdout || ''))
    })
  })
  try {
    const q = names.map(n => `Get-NetFirewallRule -DisplayName ${n} -ErrorAction SilentlyContinue`).join('; ')
    const n = (await runPs(`@(${q}).Count`)).trim()
    if (Number(n) >= list.length) return { ok: true, state: 'exists' }
  } catch { /* 查询失败就继续尝试添加 */ }
  try {
    const inner = list.map((p, i) =>
      `New-NetFirewallRule -DisplayName ${names[i]} -Direction Inbound -Protocol TCP -LocalPort ${p} -Action Allow -Profile Any | Out-Null`
    ).join('; ')
    await runPs(`Start-Process -FilePath powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${inner}"`)
    return { ok: true, state: 'added:' + list.join(',') }
  } catch (e: any) {
    return { ok: false, state: 'failed: ' + String(e?.message || e) }
  }
}
/** ★1011：生成一个新的访问令牌（URL 安全、24 字符 ≈ 144bit，扫码链接里直接可用） */
function genAccessToken(): string {
  return randomBytes(18).toString('base64url')
}
/** 请求带的令牌：头优先（fetch/SSE 都能带），?token= 兜底（地址栏首开、EventSource、图片这些带不了头） */
function requestToken(req: http.IncomingMessage): string {
  const q = decodeURIComponent((String((req as any).url || '').match(/[?&]token=([^&]+)/) || [])[1] || '')
  return String(req.headers['x-nis-token'] || q || '')
}
/** ★1011p：Host 头是不是"本机名"。
 *  用途：只对「本机来源 **且** 本机 Host」才无条件放行。
 *  反例（必须照样校令牌）：手机经 Vite dev 代理访问 —— 代理转发后 remoteAddress 变成
 *  127.0.0.1（看着像本机），但 Host 仍是手机的局域网地址。dev 一旦 `--host 0.0.0.0`，
 *  不拦这条就等于把整台机器敞给同网段（前端那条路还没有令牌）。 */
function hostIsLoopback(req: http.IncomingMessage): boolean {
  const h = String(req.headers.host || '').toLowerCase()
  if (!h) return true
  return h.startsWith('127.0.0.1') || h.startsWith('localhost') || h.startsWith('[::1]') || h.includes('tauri')
}
/** ★1010（安全回归 · 0906 P0#1 的等价物）：**跨源防线**。
 *  为什么必须补回来：恶意网页 JS 对 http://127.0.0.1:8766 发起跨源 fetch 时，remoteAddress 是
 *  127.0.0.1、Host 也是 127.0.0.1:8766 —— 会被下面那条「本机来源 + 本机 Host ⇒ 无条件放行」直接放过；
 *  而响应头又把 Origin 原样反射回去，浏览器于是允许 JS 读响应体 ⇒ 等于把整台机器（会话/密钥/文件操作）
 *  交给任意一个网页。0906 修过一次（Origin 白名单 403），1011 换令牌机制时这条线丢了，这里补回。
 *  判据：无 Origin（同源导航、curl、脚本、打包壳）放行；有 Origin 必须在白名单里，或属于本机 http 端口
 *  （dev 前端端口可变，一律认 loopback）。局域网/公网来源走令牌那条路，不受影响。 */
function originTrusted(req: http.IncomingMessage): boolean {
  const origin = String(req.headers.origin || '').trim()
  if (!origin) return true
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const u = new URL(origin)
    const h = u.hostname.replace(/^\[|\]$/g, '')
    if ((h === '127.0.0.1' || h === 'localhost' || h === '::1') && /^https?:$/.test(u.protocol)) return true
  } catch { /* Origin 非法一律不认 */ }
  return false
}
function originAllowed(req: http.IncomingMessage): boolean {
  /* ★1011（安全核心，替代旧的"令牌为空 ⇒ 退回同源放行"）：
     旧行为：没设 NIS_TOKEN 时，只要 `Origin.host === Host` 就放行 —— 而用 http://192.168.x.x:8766
     访问时天然同源 ⇒ **同网段任何人打开这个地址就能完整操作 NIS**（读写文件、跑命令、看全部会话）。
     新行为按来源分两类：
       ① 本机来源 **且** Host 是本机名（127.0.0.1 / localhost / [::1] / tauri）：永远放行 —— 打包版窗口、
          dev 前端、curl、AI 工具自调用都走这条。本机进程本来就等价于"已在你电脑上执行"，再加令牌没有
          安全收益，只会让窗口/dev 无端要令牌。
       ② 其余一律按"外部"处理：**必须**「开关已开」且「令牌匹配」，令牌缺失或开关未开一律拒（宁可
          表现为"打不开"，也不要静默敞开后门）。注意 ② 包含一类容易漏的：**本机来源但 Host 是局域网
          地址** —— 典型就是手机经 Vite dev 代理访问（代理把 remoteAddress 改写成 127.0.0.1）。不拦它，
          dev 一开 `--host 0.0.0.0` 就等于向同网段敞开后门。
       静态资源例外：GET/HEAD/OPTIONS 的非 /api 放行，否则手机扫码第一屏就白屏；页面本身不含数据，
       真正取数据/下指令的 RPC 全在 /api 下，仍然要令牌。 */
  if (isLocalRequest(req) && hostIsLoopback(req)) return originTrusted(req)
  if (!remoteAccessEnabled()) return false
  const tok = currentAccessToken()
  if (!tok) return false
  if (requestToken(req) === tok) return true
  const m = String(req.method || 'GET').toUpperCase()
  const url = String((req as any).url || '')
  if ((m === 'GET' || m === 'HEAD' || m === 'OPTIONS') && !url.startsWith('/api/')) return true
  return false
}

/* ═══ 0920 远程访问（接入 → 远程访问）═══
 * 服务改监听 0.0.0.0 后，局域网设备可以直接访问本机界面；是否放行由「远程访问」开关决定。
 * 本机来源（127.0.0.1 / ::1）永远放行——打包版窗口、dev 前端、curl 都走这条，体验零变化。 */
function isLocalRequest(req: http.IncomingMessage): boolean {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  if (!ip) return true
  return ip === '127.0.0.1' || ip === '::1'
}

/* ══════════════════════════════════════════════════════════════════════
   ★1012【云服务器中转】—— 用户自带一台公网服务器，NIS 用 **SSH 反向隧道**
   把界面端口暴露出去，于是"在外面用手机连家里这台电脑"不再受路由器拓扑限制。

   为什么选 SSH 反向隧道（而不是 frp / 第三方内网穿透）：
     · **零额外软件** —— Windows 自带 OpenSSH 客户端，不用下任何东西；
     · **不动用户网络** —— 隧道由本机**主动连出**，家里路由器怎么接、有没有公网 IP 都无所谓；
     · **天然加密** —— 全程走 SSH。

   面板流程（4 步）：
     ① NIS 生成专用密钥并显示**公钥** → ② 用户把面板给的**一行命令**贴到服务器
     → ③ 填「地址 / SSH 端口 / 用户名 / 对外端口」→ ④ 开开关，后端维持隧道（断线自动重连）。

   ⚠️ **服务器侧前提**：sshd 必须 `GatewayPorts yes`，否则 `-R` 只能绑在服务器的 127.0.0.1 上、
   外网访问不到 —— 面板那条引导命令里已经带上 sed 改它了。

   ⚠️ **安全**：暴露到公网必须带访问令牌（前端 utils/nisToken.ts + 后端门禁）。
   云服务器对外端口被扫到时最多看到登录前的 splash，任何 RPC 都会被令牌挡掉。
   ────────────────────────────────────────────────────────────────── */
type TunnelCfg = { host: string; sshPort: number; user: string; publicPort: number; enabled?: boolean; lastUiPort?: number }
const TUNNEL_DEFAULT: TunnelCfg = { host: '', sshPort: 22, user: 'ubuntu', publicPort: 80 }
let tunnelProc: ReturnType<typeof spawn> | null = null
let tunnelLastErr = ''
let tunnelStartedAt = 0

function tunnelCfgPath(): string { return path.join(DATA_ROOT, 'tunnel.json') }
function tunnelKeyPath(): string { return path.join(DATA_ROOT, 'tunnel_key') }

function getTunnelCfg(): TunnelCfg {
  try {
    const j = JSON.parse(fs.readFileSync(tunnelCfgPath(), 'utf8'))
    return { ...TUNNEL_DEFAULT, ...j }
  } catch { return { ...TUNNEL_DEFAULT } }
}
function saveTunnelCfg(cfg: TunnelCfg): void {
  try { fs.writeFileSync(tunnelCfgPath(), JSON.stringify(cfg, null, 2), 'utf8') } catch (e: any) {
    console.warn('[tunnel] 保存配置失败：', e?.message || e)
  }
}
/** ★1012（实测：换机/导入来的 tunnel_key 一律连不上）—— OpenSSH **拒绝使用权限过宽的私钥**。
 *  实测证据（2026-10-12，安装版 `D:\NIS`）：
 *    · 同一把钥匙（md5 完全一致）：dev 侧 `ssh -i` 直连 ✅ `NIS_KEY_OK`；
 *      安装版侧 ❌ `Load key "...tunnel_key": bad permissions` → 面板显示 `Permission denied (publickey,password)`
 *      （看着像"钥匙不对"，其实钥匙内容分毫不差）。
 *    · 差异全在 ACL：dev 私钥 = 无继承 + 仅 Administrators / SYSTEM / 本用户；
 *      **拷贝或数据包导入**来的私钥 = 继承目标目录的 ACL（Authenticated Users:(M)、Users:(RX)）⇒ ssh 判"他人可读"直接拒用。
 *  ⇒ 在**每次用钥匙前**幂等地收紧一次（新建的、拷贝来的、导入的一视同仁）。
 *  只在 Windows 做；失败**不抛** —— 让 ssh 自己如实报 bad permissions（问题照样暴露，不静默兜底）。 */
let tunnelKeyAclDone = false
function hardenTunnelKeyAcl(k: string): void {
  if (tunnelKeyAclDone || process.platform !== 'win32') return
  tunnelKeyAclDone = true
  try {
    const comp = process.env.COMPUTERNAME || ''
    const user = process.env.USERNAME || 'Administrator'
    const args = [k, '/inheritance:r',
      '/grant:r', 'BUILTIN\\Administrators:(F)',
      '/grant:r', 'NT AUTHORITY\\SYSTEM:(F)',
      ...(comp ? ['/grant:r', `${comp}\\${user}:(M)`] : [])]
    spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true })
  } catch { /* 收紧失败不阻断：ssh 会照常报错 */ }
}
/** 确保有专用密钥对（不复用用户 ~/.ssh 里的 —— 那把可能是他别的用途，别混） */
function ensureTunnelKey(): string {
  const k = tunnelKeyPath()
  if (!fs.existsSync(k) || !fs.existsSync(k + '.pub')) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', k, '-N', '', '-C', 'nis-cloud-tunnel'], { encoding: 'utf8' })
    if (!fs.existsSync(k)) {
      throw new Error('生成密钥失败（系统缺 ssh-keygen？）：' + (r.error?.message || r.stderr || 'unknown'))
    }
  }
  hardenTunnelKeyAcl(k)
  return k
}
function tunnelPubKey(): string {
  ensureTunnelKey()
  return fs.readFileSync(tunnelKeyPath() + '.pub', 'utf8').trim()
}
/** 面板给用户"复制到云服务器执行"的一行命令：装公钥 + 打开 GatewayPorts。
 *  ★1012d【兼容腾讯云「自动化助手(TAT)」】—— TAT 默认以 **root** 身份执行，
 *  而登录用户是 ubuntu、sshd 只看 /home/ubuntu/.ssh/authorized_keys。老命令用 `~/.ssh`
 *  会被写成 /root/.ssh ⇒ 用户看到"执行成功"，登录却一直被拒（用户本次踩过，自查极难）。
 *  现在：**显式写 /home/<用户>/.ssh**、chown 给该用户、权限 700/600，整条命令加 sudo 前缀
 *  ⇒ 无论以 root 还是以该用户身份执行，结果都正确。 */
function tunnelSetupCommand(pub: string, user = 'ubuntu'): string {
  const safe = pub.replace(/'/g, "'\\''")
  const u = /^[a-z_][a-z0-9_-]*$/i.test(String(user || '')) ? String(user) : 'ubuntu'
  /* ★1012f（用户提的好主意）：命令执行完不只说"成功"，而是**吐出一串配置码** ——
     服务器自己知道公网 IP（云元数据）和登录用户，让"知情的一方"把答案报出来，
     用户就不用去查 IP / 用户名了。面板只要一个粘贴框：粘进去 → 自动解析 → 直接连上。
     格式：NIS-TUNNEL-CONFIG|<公网IP>|<登录用户>|<ssh端口>|<对外端口> */
  return `U=${u}; H=/home/$U; sudo mkdir -p $H/.ssh && echo '${safe}' | sudo tee -a $H/.ssh/authorized_keys >/dev/null `
    + `&& sudo chown -R $U:$U $H/.ssh && sudo chmod 700 $H/.ssh && sudo chmod 600 $H/.ssh/authorized_keys `
    + `&& sudo sed -i 's/^#\\?GatewayPorts.*/GatewayPorts yes/' /etc/ssh/sshd_config && sudo systemctl restart sshd `
    /* 公网 IP：先问云元数据（腾讯云/阿里云等），失败退到公共查询，再退到本机地址 */
    + `&& IP=$(curl -s --max-time 5 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || curl -s --max-time 5 https://ipinfo.io/ip 2>/dev/null || hostname -I | awk '{print $1}') `
    /* 对外端口：从 8080 起挑第一个没被占用的（提醒：云安全组仍需放行该端口） */
    + `&& P=$(for p in 8080 8081 8888 9000; do ss -tln 2>/dev/null | grep -q ":$p " || { echo $p; break; }; done); P=\${P:-8080} `
    /* ★1012h：顺手把**服务器自己的防火墙**也放行 —— 两道门（云端安全组 + 服务器 ufw/iptables）
       都要开，只开一道的表现是"一直超时"，用户完全看不出差在哪（实测：云端放了 8081 仍不通，
       因为 ufw 里只有 8080）。云端那道服务器改不了，所以这里把能自动的那道自动掉。 */
    + `&& (sudo ufw allow $P/tcp >/dev/null 2>&1 || true) `
    + `&& echo "NIS-TUNNEL-CONFIG|$(echo $IP | tr -d '[:space:]')|$U|22|$P"`
}

/** 公网访问地址（给前端显示/复制，已带令牌） */
function tunnelPublicUrl(): string {
  const c = getTunnelCfg()
  if (!c.host) return ''
  const tok = currentAccessToken()
  const base = `http://${c.host}${Number(c.publicPort) === 80 ? '' : ':' + c.publicPort}/`
  return tok ? `${base}?token=${encodeURIComponent(tok)}` : base
}
/** 隧道进程是否活着 */
function tunnelRunning(): boolean {
  return !!tunnelProc && tunnelProc.exitCode === null && !tunnelProc.killed
}
/** 当前状态快照（面板用） */
function tunnelInfo(): any {
  const c = getTunnelCfg()
  let pub = ''
  let keyErr = ''
  try { pub = tunnelPubKey() } catch (e: any) { keyErr = e?.message || String(e) }
  return {
    running: tunnelRunning(),
    cfg: c,
    pubKey: pub,
    keyErr,
    setupCommand: pub ? tunnelSetupCommand(pub, c.user) : '',
    publicUrl: tunnelPublicUrl(),
    lastErr: tunnelLastErr,
    uptimeSec: tunnelStartedAt ? Math.round((Date.now() - tunnelStartedAt) / 1000) : 0,
  }
}
function stopTunnel(): any {
  if (tunnelProc) {
    try { tunnelProc.kill() } catch { /* 已退出 */ }
    tunnelProc = null
  }
  tunnelStartedAt = 0
  /* ★1012d：记下"用户主动停了" —— 后端重启后就不该自动接回来（尊重用户的停止意图） */
  try { saveTunnelCfg({ ...getTunnelCfg(), enabled: false }) } catch { /* 落盘失败不影响停止 */ }
  return tunnelInfo()
}
/** ★1012i【根治"隧道指错端口"】—— 探测哪个端口真正能出页面。
    背景：uiPort 由前端报上来（= window.location.port），但用户可能从**只提供 API 的端口**
    打开界面（例如后端 8766：dev 模式下它不 serve 前端）⇒ 隧道指向它，永远 404
    （实测：/api/ping 返回 200 而 / 返回 404，公网打开只剩一个空 splash）。
    做法：按「前端报的 → 5174（Vite dev）→ PORT」顺序试，谁的 `/` 返回 200 且是 HTML 就用谁；
    都不通就退回原值（宁可让报错可见，也不静默指错端口）。 */
async function probeUiPort(preferred: number): Promise<number> {
  const cands = [...new Set([preferred, 5174, PORT, 8766].filter((n) => Number(n) > 0))]
  for (const port of cands) {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 1200)
      const r = await (globalThis as any).fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })
      clearTimeout(timer)
      const ct = String(r?.headers?.get?.('content-type') || '')
      if (r?.ok && /html/i.test(ct)) {
        if (port !== preferred) console.log(`[tunnel] 界面端口探测：${preferred} 不出页面 ⇒ 改用 ${port}`)
        return port
      }
    } catch { /* 试下一个 */ }
  }
  return preferred
}

async function startTunnel(uiPort?: number): Promise<any> {
  const c = getTunnelCfg()
  if (!c.host) throw new Error('请先填写云服务器地址')
  if (tunnelRunning()) return tunnelInfo()          // 幂等：已在跑就直接返回

  const key = ensureTunnelKey()
  /* ★1012i：先探测"哪个端口真能出页面"，别盲信前端报上来的（见 probeUiPort 注释） */
  const lp = await probeUiPort(Number(uiPort) > 0 ? Number(uiPort) : PORT)
  tunnelLastErr = ''
  /* -N：只转发、不执行远程命令
     ExitOnForwardFailure：端口被占/绑定失败时**立刻报错**，而不是默默假装成功（排查生命线）
     ServerAliveInterval：长时间空闲不被中间设备掐断（真断了 ssh 自己退出，面板会转成"已停止"）
     BatchMode：绝不弹密码提示（这是后台进程，卡在密码输入等于静默失败） */
  const args = [
    '-N',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-i', key,
    '-R', `0.0.0.0:${c.publicPort}:127.0.0.1:${lp}`,
    `${c.user}@${c.host}`,
  ]
  if (Number(c.sshPort) > 0 && Number(c.sshPort) !== 22) args.unshift('-p', String(c.sshPort))

  const proc = spawn('ssh', args, { windowsHide: true })
  tunnelProc = proc
  tunnelStartedAt = Date.now()
  proc.stderr?.on('data', (d: Buffer) => {
    const s = String(d).trim()
    if (s) tunnelLastErr = s.slice(-500)
    console.warn('[tunnel] ssh:', s)
  })
  proc.on('exit', (code) => {
    if (tunnelProc === proc) { tunnelProc = null; tunnelStartedAt = 0 }
    console.warn('[tunnel] ssh 退出，code =', code, tunnelLastErr ? `（${tunnelLastErr}）` : '')
  })
  /* ★1012b【重要】启动后必须**等一小会儿再判定**。ssh 在下面这些情况会"起得来又马上死"：
       · 密钥认证失败（Permission denied）· 主机不可达 · 服务器端口绑定失败。
     老版本直接返回进程快照 ⇒ 面板显示"已启动"，用户以为通了、其实一条流量都没转发
     ——（用户今天就撞上：公钥没装成功，面板却显示已连接，打开链接看到的是服务器上另一个服务）。
     现在等 1.5s 复核，死了就把 ssh 的原话抛回去，前端直接显示，不让人白等。 */
  await new Promise((r) => setTimeout(r, 1500))
  if (!tunnelRunning()) {
    const why = tunnelLastErr || `ssh 进程已退出（code ${proc.exitCode ?? 'null'}）`
    if (tunnelProc === proc) { tunnelProc = null; tunnelStartedAt = 0 }
    throw new Error('隧道未能建立：' + why)
  }
  /* ★1012d：确认活了才记"已开启" + 记下界面端口 —— 下次后端重启靠这两个字段自动接回来 */
  try { saveTunnelCfg({ ...getTunnelCfg(), enabled: true, lastUiPort: lp }) } catch { /* 落盘失败不影响本运行 */ }
  return tunnelInfo()
}

/** ★1012d：后端启动时把隧道接回来（**只在**上次是开启状态时接）——
    否则每次重启后端都要手点一次「启动中转」，用户会以为功能坏了。
    尊重"用户主动停过"的意图：stopTunnel 会把 enabled 置 false。 */
async function tryRestoreTunnel(): Promise<void> {
  const c = getTunnelCfg()
  if (!c.enabled || !c.host) return
  try {
    await startTunnel(Number(c.lastUiPort) || 0)
    console.log('[tunnel] 已按上次状态自动恢复隧道 →', tunnelPublicUrl())
  } catch (e: any) {
    console.warn('[tunnel] 自动恢复失败（可在面板手动重试）：', e?.message || e)
  }
}

/** 「接入 → 远程访问」开关（落 channels.json）；每次现读，用户一改立即生效 */
function remoteAccessEnabled(): boolean {
  try { return !!(getChannel('remote') as any)?.enabled } catch { return false }
}

/** ★1011：这个网卡地址是否"几乎不可能被手机访问到"（虚拟网卡/链路本地）。
 *  动机（实测反馈场景）：原来只排除回环 ⇒ Hyper-V/WSL/Docker/VMware 的虚拟网卡会混进列表，
 *  而它们的枚举顺序常常靠前 ⇒ 面板把首个当主地址 + 生成二维码 ⇒ **手机扫码连不上**。
 *  ⚠️ 只过滤"确定没用"的：链路本地 169.254 与已知虚拟交换机。Tailscale/ZeroTier 这类 VPN 网卡
 *  反而可能有用（异地也能连），所以**保留但降权排序**，不过滤。 */
function isUselessLanNic(name: string, addr: string): boolean {
  if (/^169\.254\./.test(addr)) return true                       // APIPA 链路本地：没有路由价值
  const n = String(name || '').toLowerCase()
  return /vethernet|hyper-v|wsl|docker|vmware|virtualbox|vbox|loopback|bluetooth|tap-|tun\d/.test(n)
}
/** 局域网地址"像不像家里/公司内网"的评分（越高越优先当主地址） */
function lanAddrScore(addr: string): number {
  if (/^192\.168\./.test(addr)) return 40
  if (/^10\./.test(addr)) return 30
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 20
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(addr)) return 5   // CGNAT/Tailscale：能连但少见
  return 10
}
/** 本机所有可被局域网访问的地址（IPv4、排除回环与虚拟网卡；按"最像内网"排序）。
 *  ★1011：链接带上访问令牌 ⇒ 手机扫码后地址栏就带 ?token=，页面里的 RPC 直接可用
 *  （前端 utils/nisToken.ts 早就从 location.search 读它）。 */
function lanUrls(port: number, token = ''): string[] {
  const q = token ? `?token=${encodeURIComponent(token)}` : ''
  const cands: { addr: string; score: number }[] = []
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (!ni || ni.family !== 'IPv4' || ni.internal) continue
        if (isUselessLanNic(name, ni.address)) continue
        cands.push({ addr: ni.address, score: lanAddrScore(ni.address) })
      }
    }
  } catch { /* 取不到网卡就返回空，前端会提示"未找到可用局域网地址" */ }
  cands.sort((a, b) => b.score - a.score)
  return cands.map(c => `http://${c.addr}:${port}/${q}`)
}

/* ── 打包版静态资源（0915）：NIS_DIST_DIR = 前端 dist 目录（由 Tauri sidecar 传入）──
 * serve-from-backend 架构：打包版窗口直接加载 http://127.0.0.1:8766/，页面与 API 同源，
 * 预览 iframe / 元素拾取 / 相对路径语义与 dev（vite 代理）完全一致。dev 态不设该 env，零影响。 */
const NIS_DIST_DIR = (process.env.NIS_DIST_DIR || '').trim()

const DIST_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
}

/** ★1012gzip：值得 gzip 的扩展名（文本类）—— 图片/字体/音视频已是压缩格式，再压白费 CPU 还可能变大 */
const DIST_COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt', '.xml'])

/** 静态文件响应；返回 true = 已处理（含 4xx/5xx），false = 未配置 dist 应由调用方继续兜底 */
function serveDistFile(pathname: string, res: ServerResponse, headOnly = false): boolean {
  if (!NIS_DIST_DIR) return false
  try {
    const dist = path.resolve(NIS_DIST_DIR)
    let rel = decodeURIComponent((pathname || '/').split('?')[0])
    if (rel === '/' || rel === '') rel = '/index.html'
    let abs = path.resolve(dist, '.' + rel)
    if (abs !== dist && !abs.startsWith(dist + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden')
      return true
    }
    let st = fs.existsSync(abs) ? fs.statSync(abs) : null
    if (st?.isDirectory()) {
      abs = path.join(abs, 'index.html')
      st = fs.existsSync(abs) ? fs.statSync(abs) : null
    }
    if (!st && !path.extname(rel)) {
      abs = path.join(dist, 'index.html')
      st = fs.existsSync(abs) ? fs.statSync(abs) : null
    }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return true
    }
    const ext = path.extname(abs).toLowerCase()
    const immutable = rel.startsWith('/assets/')
    /* ★1012gzip：文本类静态资源 gzip（与 handleRpc 大响应 gzip 同口径）。
       此前打包版直发原文：主包 index-*.js 3.0MB 未压缩、gzip 后仅 0.9MB。
       只压文本类（图片/字体/音视频已是压缩格式）；zlib 流式 ⇒ 不占内存、不阻塞事件循环。 */
    const gz = !headOnly && st.size > 1024 && DIST_COMPRESSIBLE.has(ext)
      && /\bgzip\b/.test(String((res as any).req?.headers?.['accept-encoding'] || ''))
    res.writeHead(200, {
      'content-type': DIST_MIME[ext] || 'application/octet-stream',
      ...(gz
        ? { 'content-encoding': 'gzip', vary: 'accept-encoding' }
        : { 'content-length': String(st.size) }),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (headOnly) {
      res.end()
      return true
    }
    if (gz) fs.createReadStream(abs).pipe(zlib.createGzip()).pipe(res)
    else fs.createReadStream(abs).pipe(res)
    return true
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('dist serve error: ' + String(e?.message || e).slice(0, 200))
    return true
  }
}

const server = http.createServer(async (req, res) => {
  // 安全闸门：先于一切处理
  if (!originAllowed(req)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden: origin not allowed' }))
    return
  }
  // 0920：局域网访问总闸——服务已监听 0.0.0.0，非本机来源必须等「接入 → 远程访问」开关打开，
  // 否则等于把整台机器暴露给内网。本机（127.0.0.1/::1）永远放行。
  if (!isLocalRequest(req) && !remoteAccessEnabled()) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden: remote access disabled' }))
    return
  }
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)

  // CORS（回显已校验来源，不再 *）
  /* ★1010：只对可信 Origin 反射（不可信的返回默认本机地址 ⇒ 浏览器自己掐断跨源读取）。
     与 originAllowed 里的 originTrusted 形成"路由层先拒 + CORS 层再兜"两道。 */
  const _reqOrigin = String(req.headers.origin || '')
  res.setHeader('access-control-allow-origin', _reqOrigin && originTrusted(req) ? _reqOrigin : 'http://127.0.0.1:8766')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, x-nis-token')

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  // SSE streams
  if (req.method === 'GET' && url.pathname === '/api/events.mux') {
    handleMuxStream(req, res)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/events.host') {
    handleHostStream(req, res)
    return
  }

  /* ★0926 止血：轻量健康探针。前端 SSE 看门狗"判死"前先探它一次——
     后端主线程被同步重活堵住时（如另一个会话在跑大 transcript 序列化），
     本流的 15s ping 也会一起迟到；旧逻辑直接判死重连 → 重连补账会把正在流式的
     气泡定稿/覆盖（用户看到的"A 报错，B 也跟着中断"）。有探针就能区分"忙"与"死"。
     只回一个极小 JSON：不碰会话/磁盘/LLM，零副作用。 */
  if (req.method === 'GET' && url.pathname === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, t: Date.now(), up: Math.round(process.uptime()) }))
    return
  }

  // 会话工作区静态文件（预览 iframe 相对资源解析：css/js/图片按真实路径加载）。
  // 只读 + 严格限制在工作区内（resolveWorkdirPath 校验穿越）
  // iframe 内相对链接导航兜底：HTML 响应已注入 <base href="/api/workspace-file/<dir>/">（见下），
  // 相对链接会直接落在代理路径下——此处 302 只兜"用户自己打开代理页时 base 注入前的旧缓存/边缘形态"。
  if (req.method === 'GET' && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/workspace-file')) {
    const referer0 = req.headers.referer || ''
    if (/^\/api\/[\w.\-%]+$/.test(url.pathname)) {
      try {
        const refUrl = new URL(referer0)
        if (refUrl.pathname === '/api/workspace-file') {
          const sid0 = refUrl.searchParams.get('sessionId') || ''
          const refPath = refUrl.searchParams.get('path') || ''
          if (sid0 && refPath) {
            const baseDir = refPath.includes('/') ? refPath.slice(0, refPath.lastIndexOf('/') + 1) : ''
            const target = baseDir + decodeURIComponent(url.pathname).replace(/^\/api\//, '')
            const loc = `/api/workspace-file?sessionId=${encodeURIComponent(sid0)}&path=${encodeURIComponent(target)}`
            res.writeHead(302, { location: loc })
            res.end()
            return
          }
        }
      } catch { /* referer 非法 → 落到 404 */ }
    }
  }

  // 0911 #16 会话资产：从会话数据里剥离出来的截图（data/session-assets/<sha256>.<ext>，内容寻址不可变）
  if (req.method === 'GET' && url.pathname.startsWith(ASSET_URL_PREFIX)) {
    const ref = decodeURIComponent(url.pathname.slice(ASSET_URL_PREFIX.length))
    const hit = SESSION_ASSETS.resolveRef(ref)
    if (!hit) { res.writeHead(404); res.end('asset not found'); return }
    try {
      const buf = await fs.promises.readFile(hit.full)
      res.writeHead(200, {
        'content-type': hit.mime,
        'cache-control': 'public, max-age=31536000, immutable',
      })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end('asset read failed')
    }
    return
  }

  /* ★ 1011：便签图片（data/notebook-assets/<sha256>.<ext>）—— 同一套内容寻址只读路由，
     便签详情里的 <img src="/api/notebook-asset/<ref>"> 直接打这里（dev 走 vite 的 /api 代理，打包同源）。 */
  if (req.method === 'GET' && url.pathname.startsWith(NOTEBOOK_ASSET_URL_PREFIX)) {
    const ref = decodeURIComponent(url.pathname.slice(NOTEBOOK_ASSET_URL_PREFIX.length))
    const hit = resolveNotebookAsset(ref)
    if (!hit) { res.writeHead(404); res.end('notebook asset not found'); return }
    try {
      const buf = await fs.promises.readFile(hit.full)
      res.writeHead(200, {
        'content-type': hit.mime,
        'cache-control': 'public, max-age=31536000, immutable',
      })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end('notebook asset read failed')
    }
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/workspace-file')) {
    // 三种形式：
    //   标准：/api/workspace-file?sessionId=..&path=x
    //   base 相对形式（HTML 响应注入的 <base href> 产生的导航）：
    //     /api/workspace-file/<sessionId>/<relPath> —— sessionId 内嵌 pathname，
    //     因为相对链接导航（WHATWG 合并规则）会丢弃 base 的 query，sessionId 必须放 pathname
    const WS_PREFIX = '/api/workspace-file'
    let sid = url.searchParams.get('sessionId') || ''
    let rel = url.searchParams.get('path') || ''
    const tail = url.pathname === WS_PREFIX || url.pathname === WS_PREFIX + '/'
      ? ''
      : decodeURIComponent(url.pathname.slice(WS_PREFIX.length + 1))
    if (tail && !sid) {
      // <sessionId>/<relPath> 形式：第一段是 sessionId（uuid 格式校验，避免误吞普通路径）
      const slash = tail.indexOf('/')
      const sidPart = slash === -1 ? tail : tail.slice(0, slash)
      const relPart = slash === -1 ? '' : tail.slice(slash + 1)
      if (/^[0-9a-fA-F-]{36}$/.test(sidPart)) {
        sid = sidPart
        if (!rel) rel = relPart
      }
    }
    /* ★1003 安全批 4.67/4.68：sid 无论来自查询串还是路径尾一律 UUID 校验（查询形态原来裸用，
     * 可拼进 <base href> 属性破出注入）；再往下 dir 还要做属性编码，双保险。 */
    if (!/^[0-9a-fA-F-]{36}$/.test(String(sid || ''))) { res.writeHead(400); res.end('bad sessionId'); return }
    const session = sessions.get(sid)
    if (!session) { res.writeHead(404); res.end('session not found'); return }
    try {
      const full = resolveWorkdirPath(session, rel)
      const st = await fs.promises.stat(full)
      if (st.isDirectory()) { res.writeHead(400); res.end('is directory'); return }
      let data = await fs.promises.readFile(full)
      const ext = path.extname(full).toLowerCase()
      const mimes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      }
      // HTML 注入 <base href="/api/workspace-file/<sessionId>/<dir>/">：预览页相对链接
      // （页面互链/相对 css/js/图片，含 ../）按 base 目录解析 → 落回本 handler，sessionId 随 pathname 带上。
      // 注入点在 <head> 后（无 head 则置顶）。仅响应侧改动，不碰用户文件。
      if (ext === '.html' || ext === '.htm') {
        /* ★1003 安全批 4.67/4.68：dir 来自用户可控的 path —— 原样拼进 HTML 属性，
         * 带个 '">' 就能破出属性、在后端源里执行脚本（满 /api 权限）。
         * 属性上下文编码（浏览器解析属性值时会把实体解回来，合法 URL 语义不变）。 */
        const escAttr = (v: string) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
        const baseTag = `<base href="/api/workspace-file/${escAttr(sid)}/${escAttr(dir)}">`
        const buf = data.toString('utf8')
        if (/<head[^>]*>/i.test(buf)) {
          data = Buffer.from(buf.replace(/<head[^>]*>/i, m => m + baseTag), 'utf8')
        } else {
          data = Buffer.from(baseTag + buf, 'utf8')
        }
      }
      res.writeHead(200, { 'content-type': mimes[ext] || 'application/octet-stream', 'cache-control': 'no-cache' })
      res.end(data)
    } catch (e: any) {
      res.writeHead(404)
      res.end(String(e?.message || e))
    }
    return
  }

  // RPC（★1003 安全批 4.65/4.66：只走 /api/ 前缀 —— 原来任意路径的 POST 都进 handleRpc，
  // 配合门禁"非 /api 免钥匙"就是一扇不上锁的侧门；现在侧门焊死，非 /api 的 POST 落 404。）
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (e: any) {
      sendRpcError(res, '', 'invalid JSON body: ' + String(e?.message || e))
      return
    }
    if (!body) {
      sendRpcError(res, '', 'invalid JSON body')
      return
    }
    handleRpc(res, body as ClientRequest)
    return
  }

  // 打包版静态资源（GET/HEAD 非 /api 路径）：serve-from-backend（NIS_DIST_DIR 未设时整体跳过）
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && NIS_DIST_DIR) {
    if (serveDistFile(url.pathname, res, req.method === 'HEAD')) return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

// --- SSE: /api/events.mux ---

function handleMuxStream(req: http.IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const sessionId = url.searchParams.get('sessionId') || ''

  // 无 sessionId = 全量订阅（收所有会话事件）；有则订阅指定会话
  const muxKey = sessionId || ''
  if (!muxClients.has(muxKey)) {
    muxClients.set(muxKey, new Set())
  }
  muxClients.get(muxKey)!.add(res)
  sendSseFrame(res, {
    type: 'server-request',
    rpcId: crypto.randomUUID(),
    payload: { type: sessionId ? 'session/subscribed' : 'stream/subscribed', sessionId, lastSeq: 0 },
  })

  /* ★0927（实测"切回对话：旧回复直接显示、Think 卡在过程态，过一会才动"）：
     **订阅即补当前轮快照** —— "正在生成的那一轮"只活在实时流里（历史/agent.messages 都没有它的
     思考与流中文本），切会话/切窗口会**重订阅**，重订阅期间那几帧就永久丢了 ⇒ 界面停在旧状态，
     直到下一条 delta 到达才动（= 用户看到的"卡住一会"）。
     这里在登记完之后立刻补一发当前 turn 快照（`assembleTurnContent` 含 reasoning+text），
     前端收到 message_updated 就会把流式节点追平；没有在跑的轮次就什么都不发（零开销）。 */
  if (sessionId) {
    try {
      const turn = turnAccumulators.get(sessionId)
      if (turn) {
        pushTurnSnapshot(sessionId, turn, false)
        console.log(`[mux] 订阅即补当前轮快照：${sessionId.slice(0, 8)}（文本 ${(turn.text || '').length} 字 / 思考 ${(turn.reasoning || '').length} 字）`)
      }
    } catch { /* 补发失败不影响订阅本身 */ }
  }

  const pingInterval = setInterval(() => sendSsePing(res), 15000)

  req.on('close', () => {
    clearInterval(pingInterval)
    const muxKey = sessionId || ''
    const clients = muxClients.get(muxKey)
    if (clients) {
      clients.delete(res)
      /* ★0927（用户"不出任何问题"标准）：桶空了就**删掉 Map 条目** ——
         旧代码只清 Set 内容，空 Set 永远留在 Map 里：每开过一个会话就留一个
         （本应用会话是持续新建的），内存单调涨。writeMuxTo 对空桶返回 false，
         删除不影响投递语义。 */
      if (clients.size === 0) muxClients.delete(muxKey)
    }
  })
}

// --- SSE: /api/events.host ---

function handleHostStream(req: http.IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  hostClients.add(res)

  // Send initial workspace
  const workspace = buildWorkspaceView()
  sendSseFrame(res, {
    type: 'server-request',
    rpcId: crypto.randomUUID(),
    payload: { type: 'host/workspace-changed', workspace },
  })

  const pingInterval = setInterval(() => sendSsePing(res), 15000)

  req.on('close', () => {
    clearInterval(pingInterval)
    hostClients.delete(res)
  })
}

// --- RPC handler ---

async function handleRpc(res: ServerResponse, body: ClientRequest): Promise<void> {
  const { rpcId, method, payload } = body

  try {
    const value = await dispatchMethod(method, payload)
    const frame: ServerResponse_Frame = { type: 'server-response', rpcId, result: { ok: true, value } }
    /* ★0927 P2-6 加固：调用方中途断开（页面刷新/关标签/MCP 会话断）→ 不再写响应。
       任务早已在服务端跑完并落盘（会话历史可回看），断连不该变成一次写错误。 */
    if (res.writableEnded || res.destroyed) return
    try {
      /* ★1012am：**RPC 大响应 gzip** —— 反馈"远程访问点击长会话好久没反应"。
         实测取证：长会话 `session.history` = **2124 KB 未压缩 JSON**（552 条消息，content 占 92%，
         单条 user 消息就有 575KB），而后端**只花 28ms** ⇒ 时间全耗在公网传输上。
         JSON 文本压缩比极高（~10x）⇒ 这里统一压大于 2KB 的响应。
         浏览器 `fetch` 自带 `Accept-Encoding: gzip` 且**自动解压** ⇒ **前端零改动**。
         SSE/host 流不经过本函数（它们是各自的长连接），不受影响。
         `node:zlib` 用动态 import（模块级缓存，开销可忽略）以免动本文件头部的 import 区。 */
      const raw = JSON.stringify(frame)
      const acceptGzip = /\bgzip\b/.test(String((res as any).req?.headers?.['accept-encoding'] || ''))
      if (acceptGzip && raw.length > 2048) {
        const { gzipSync } = await import('node:zlib')
        const gz = gzipSync(Buffer.from(raw, 'utf8'))
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gz.length) })
        res.end(gz)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(raw)
      }
    } catch { /* 对端已断：忽略 */ }
  } catch (err) {
    sendRpcError(res, rpcId, err instanceof Error ? err.message : String(err))
  }
}

/** 本轮撤销真实可用的轮次：该轮代表条目（同轮同路径最新未作废 AI 记录）处于 active，
 *  且干跑 restoreChange 通过（快照完好、回退动作非空操作）。
 *  不凭状态推断——voided / 快照被 LRU 清掉 / 文件已不在，干跑都会拒绝（0902-3 反馈 #2 追加：
 *  整轮已被撤销的轮次，按钮也要禁用）。 */
function undoableTurns(workDir: string, sid?: string): number[] {
  const all = listChanges(workDir)
  const out = new Set<number>()
  const seen = new Set<string>()
  for (const c of all) { // 新→旧：同轮同路径取最新一条代表
    // 0929 隔离修复：与 turnSummaries / fs.history.restoreTurn 同口径——
    // 只认本会话的改动（team 成员聊天与主会话共享 workDir，turnIndex 不同语义；无 sessionId 存量放行）
    if (sid && c.sessionId && c.sessionId !== sid) continue
    if (c.kind !== 'file' || !c.relPath || c.voided) continue
    if (c.actor === '用户撤销' || c.actor === '用户撤销(整轮)') continue
    if (typeof c.turnIndex !== 'number' || c.turnIndex < 1) continue
    const k = `${c.turnIndex}|${c.relPath}`
    if (seen.has(k)) continue
    seen.add(k)
    if (changeStatus(workDir, c, all) !== 'active') continue
    const r = restoreChange(workDir, c.id, { dryRun: true })
    if (r.ok) out.add(c.turnIndex)
  }
  return [...out].sort((a, b) => a - b)
}

/** 0920：工作模式的行为指令文本。
 *  ★ 实现选择说明（用户 0920 问过"能不能实装/会不会破坏"）：
 *  这里**只往用户消息前面拼一段指令**（跟技能标记 `[技能:x]` 完全同一机制），
 *  刻意**不拼进 systemPrompt** —— 主路径的 systemPrompt 是建 agent 时组装一次、且有配置指纹
 *  （`sessionCfgFingerprint`：预设/团队 mtime + 人格称呼），改它必须同步改指纹，否则切模式不生效；
 *  动了就碰 agent 缓存这条主干，回归面覆盖所有会话。走消息前缀则完全不碰缓存/审批链路。
 *  代价：约束力是"模型遵守"级（跟技能引导同量级），不是硬拦。
 *  default 不注入（= 不额外约束，行为与改前一致）；goal 尚未实装（前端已标"规划中"）。 */
function buildModeHint(mode: string): string {
  if (mode === 'plan') {
    return '[模式:计划] 本轮只做规划：把要做的事拆成清晰步骤讲清楚（可以用只读方式了解现状），但不要执行任何写操作——不修改或新建文件、不运行有副作用的命令、不调用 bg_start；给出计划后停下等用户确认。'
  }
  if (mode === 'build') {
    return '[模式:构建] 跳过规划阶段直接动手，边做边调整；不要先输出一长串计划再等确认。'
  }
  return ''
}

/* ════ ★0930（产品要求"AI 几乎不主动看记忆库/知识库，写进去也不看"）：自动召回 ════
 *  每条用户消息随附【相关记忆/知识】单行线索——模型就算不调工具也"看得见"自己的记忆库。
 *  兜底性质：1.5s 超时/桥不可用/消息太短 → 静默跳过，零打扰零回归；深查仍靠工具（读纪律见 buildDynamicSystem）。
 *  展示口径：与 [模式:] 同款"行首注入行 + 前端 stripModeHint 剥离"，界面不增加任何噪音。 */
/** ★1010k：召回条目 → 一行线索（带条目 id，便于模型按 id 用 detail=true 深查，不再盲搜一遍）。
 *  主 AI 的 [记忆召回] 行 与 外部预设的背景段 共用。 */
function recallBit(it: any, max: number): string {
  const s = String(it?.summary || it?.content || it?.title || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const id = String(it?.id || '')
  return '「' + s.slice(0, max) + '」' + (id ? '(' + id + ')' : '')
}

async function buildMemoryRecall(message: string, projectId = ''): Promise<string> {
  const q = String(message || '').replace(/\s+/g, ' ').trim()
  if (q.length < 4 || q.startsWith('【')) return ''   // 太短无检索意义；【开头=内部注入消息（自动续跑等）不召回
  if ((globalSettings as any).memoryAutoRecall === false) return ''   // 逃生舱开关（设置里可关）
  const withTimeout = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([p, new Promise<T | null>(r => setTimeout(() => r(null), 1500))])
  try {
    const [mem, know]: any[] = await Promise.all([  // 并行：总延迟=min(两者)，封顶 1.5s
      withTimeout(memoryBridge.call('memory_search', { query: q, top_k: 3, detail: false })),
      withTimeout(memoryBridge.call('knowledge_query', { query: q, top_k: 2, project_id: projectId || '' })),   // ★0930：召回同样只看项目范围内的知识
    ])
    const memBits = ((mem && mem.memories) || []).slice(0, 3).map((m: any) => recallBit(m, 60)).filter(Boolean).join(' ')
    const knowBits = ((know && know.entries) || []).slice(0, 2).map((k: any) => recallBit(k, 50)).filter(Boolean).join(' ')
    const parts = [
      memBits ? '相关记忆：' + memBits : '',
      knowBits ? '相关知识条目：' + knowBits : '',
    ].filter(Boolean)
    if (!parts.length) return ''
    return '[记忆召回]（自动检索的一行线索；括号内是条目 id，需要详情就带 id 用 memory_search/knowledge_query 的 detail=true 取；未确认记忆只能当线索，当事实用前先核实）' + parts.join('；')
  } catch { return '' }
}

/** ★1010h（已定案：记忆/知识库要接进外部预设 + 开关）：外部 agent 看不到主 AI 的 [记忆召回] 线索行，
 *  所以单独把召回结果拼成它看得懂的自然语言背景段（只进发给它的 prompt、不落盘）。
 *  口径与 buildMemoryRecall 一致（1.5s 超时/桥不可用/消息太短→静默跳过）；开关 extPresetContext（缺键=开）。 */
async function buildExternalContext(message: string, projectId = ''): Promise<string> {
  const q = String(message || '').replace(/\s+/g, ' ').trim()
  if (q.length < 4 || q.startsWith('【')) return ''
  if ((globalSettings as any).extPresetContext === false) return ''
  const withTimeout = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([p, new Promise<T | null>(r => setTimeout(() => r(null), 1500))])
  try {
    const [mem, know]: any[] = await Promise.all([
      withTimeout(memoryBridge.call('memory_search', { query: q, top_k: 3, detail: false })),
      withTimeout(memoryBridge.call('knowledge_query', { query: q, top_k: 2, project_id: projectId || '' })),
    ])
    const memBits = ((mem && mem.memories) || []).slice(0, 3).map((m: any) => recallBit(m, 120)).filter(Boolean).map((s: string) => '- 记忆：' + s).join('\n')
    const knowBits = ((know && know.entries) || []).slice(0, 2).map((k: any) => recallBit(k, 100)).filter(Boolean).map((s: string) => '- 知识条目：' + s).join('\n')
    if (!memBits && !knowBits) return ''
    return [memBits, knowBits].filter(Boolean).join('\n')
  } catch { return '' }
}

/** 0920：系统提醒要显示「对话名 + AI 回复摘要」。
 *  摘要**必须由后端给** —— 前端 piChat 的节点只对"正在打开/流式"的会话存在，
 *  而通知最常发生在**别的会话**跑完的时候（那时前端根本没有它的节点，取不到文本）。
 *  取本轮最后一个非空文本段（收尾那段最像总结）→ 去 markdown 装饰 → 压成一行截断。 */
function buildReplyPreview(turn: any, max = 120): string {
  try {
    if (!turn) return ''
    const segs: string[] = []
    if (Array.isArray(turn.sequence)) {
      for (const s of turn.sequence) {
        if (s && s.type === 'text' && typeof s.text === 'string' && s.text.trim()) segs.push(s.text)
      }
    }
    if (typeof turn.text === 'string' && turn.text.trim()) segs.push(turn.text)
    for (let i = segs.length - 1; i >= 0; i--) {
      const clean = String(segs[i])
        .replace(/```[\s\S]*?```/g, ' ')            // 代码块整段去掉
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接只留文字
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')         // 标题符号
        .replace(/^\s{0,3}[-*+]\s+/gm, '')          // 列表符号
        .replace(/[*`>_~]/g, '')                    // 其余 markdown 装饰
        .replace(/\s+/g, ' ')
        .trim()
      if (clean) return clean.slice(0, max)
    }
  } catch { /* 摘要失败不影响主流程 */ }
  return ''
}

/** 0909⑦：session.prompt 核心逻辑抽函数（RPC 手动发送与队列自动续发共用同一条路径，
 *  杜绝"flush 走的分支和手发不一样"的漂移；语义与原 case 体完全一致）。 */



export async function runPromptCore(sessionId: string, p: Record<string, unknown>): Promise<{ ok: boolean; rebuilt?: boolean; queued?: boolean; queuePosition?: number; queueLength?: number; turnFailed?: boolean; error?: string }> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('session not found')
  const message = p?.message as string | undefined
  if (!message) throw new Error('message required')

  /* ══ ★0927 N1：**不许插队** —— 队列非空时，新消息一律排到队尾（FIFO，先来先发）══════════════
     病案：直发路径从不看队列 ⇒ 用户新消息会抢在早先排队的消息前面（实测"先发后到"）。
     例外两种：
      · `__fromQueue`=续发链自己（否则会自己把自己再排一次）；
      · `__busyPolicy='wait'`（定时任务 / 群插嘴这种"要本轮结果才敢继续"的内部调用方）→ 先等队列排空。
     ⚠️ 这条必须与"空闲看门狗"同时存在：万一队列卡住，用户新消息也会被一起卡住（比插队更糟）。 */
  if (!(p as any).__fromQueue) {
    const qLen = queueSnapshot(sessionId).length
    if (qLen > 0) {
      if ((p as any).__busyPolicy === 'wait') {
        /* ★0927 自检修：内部调用方（定时任务 / 群插嘴）要的是"本轮结果"，所以先等队列排空；
           但**暂停态（乙）的队列不会自己排空** —— 旧写法会白等 10 分钟（定时任务挂死）。
           现在：① 暂停态直接如实报错（不装死、不空等）② 排队中的等待也封顶 60s，
           等到就继续发；等不到就排到队尾（消息不丢），绝不让调用方无限挂起。 */
        if (queuePaused.has(sessionId)) {
          throw new Error(`该会话的队列已暂停（「停止」时选了按住队列）：这条消息没有发出，请先点「继续发送」`)
        }
        await waitQueueDrained(sessionId, 60_000)
      }
      if (queueSnapshot(sessionId).length > 0) {
        const itemId = String((p as any)?.clientMessageId || crypto.randomUUID())
        const wasPaused = queuePaused.has(sessionId)
        const pos = queueSnapshot(sessionId).length + 1
        const qErr = enqueueBusyPrompt(sessionId, p, message, {
          id: itemId,
          notice: `前面还有 ${pos - 1} 条排队消息：这条排在第 ${pos} 位${wasPaused ? '（队列已自动恢复）' : ''}`,
          log: `队列非空 → 排到队尾（第 ${pos} 位，FIFO；${wasPaused ? '顺带解除暂停' : '队列 ' + (pos - 1) + ' 条在等'}）`,
          guard: 'fifo-enqueue',
        })
        if (qErr) throw new Error(`队列繁忙，这条消息没能发出（${qErr}）——请稍后重试`)
        if (wasPaused) { queuePaused.delete(sessionId); broadcastQueue(sessionId) }   // 用户主动发话=他想动起来
        scheduleQueueFlushRetry(sessionId)
        return { ok: true, queued: true, ...queuePosOf(sessionId, itemId) }
      }
    }
  }

  /* ══ ★0927 P0-1：同会话并发发送 → 走队列，绝不裸抛丢消息 ══════════════════════════════════
     实测 4/4：同一会话两条 session.prompt 并发（双击发送/双窗口/通道连发/定时任务撞车），
     第二条被 pi 的 prompt() 裸抛拒掉，**且连历史都不进**（消息落史挂在 agent 流事件里，一抛就没了）。
     这里在**动任何会话状态之前**分流（模型/强度覆盖等交给队列项，等它真发时再落地）：
       · 默认（交互式：RPC/通道/回访）→ 入队，本轮结束后自动续发（顺序不乱、消息不丢）；
       · __busyPolicy='wait'（定时任务 / 群插嘴这种"要本轮结果才敢继续"的调用方）→ 等空闲再发，blocking 语义不变。 */
  if (sessionAgentBusy(sessionId) && (p as any).__fromQueue !== true) {
    if ((p as any).__busyPolicy === 'wait') {
      await waitSessionAgentIdle(sessionId)
    }
    if (sessionAgentBusy(sessionId)) {
      const itemId = String((p as any)?.clientMessageId || crypto.randomUUID())
      const pos = queueSnapshot(sessionId).length + 1
      const qErr = enqueueBusyPrompt(sessionId, p, message, { id: itemId })
      if (qErr) throw new Error(`正在生成回复，这条消息没能发出（${qErr}）——请稍后重试`)
      /* 兜底触发：若本轮 agent_end→waitForIdle 的 flush 已经跑过（窄竞态），这条没人来发。
         有限次重试（agent 还忙就再等）；正常路径下它会被 agent_end 的 flush 抢走。 */
      scheduleQueueFlushRetry(sessionId)
      return { ok: true, queued: true, ...queuePosOf(sessionId, itemId) }
    }
  }
  // 会话级模型覆盖：前端传本会话选的模型（provider/model_id/base，每窗口独立）→ 本会话用它而非全局聊天模型。
  // 0908 修复"换模型不生效、重选一次才对"：旧实现在【供应商未注册/无 key】时【静默丢弃】覆盖——
  //   session.llmOverride 仍残留上一轮的旧模型，于是 UI 显示新模型、实际还调旧模型；
  //   用户再选一次时前端才把该供应商 add/setKey 推送到后端，第二次覆盖才落地（=症状复现）。
  //   新实现：① 供应商未注册且前端带了 base → 自动注册（key 不随 prompt 走，仍由前端 setKey 推）；
  //   ② 无 key 且非本地服务 → 明确报错（本条不发送，杜绝"看起来发了其实用错模型"）；③ 覆盖成功即落地新模型。
  const m = p?.model as Record<string, string> | undefined
  /* ★1001：外部预设 own 档的 p.model 是"它家模型名"（provider='external' 占位），不是 NIS 供应商——
     跳过会话级覆盖逻辑（否则"供应商未注册"误伤整条消息）；模型名由 runExternalTurn 的 hintModel 消费。 */
  const _extOwnModel = isExternalPreset(session?.presetId) && readAgentPreset(session?.presetId || '')?.modelSource === 'own'
  if (m && m.provider && m.model_id && !_extOwnModel) {
    let prov = getState().providers.find(x => x.id === m.provider)
    if (!prov && m.base) {
      addProvider({ id: m.provider, name: m.provider, base: m.base })
      prov = getState().providers.find(x => x.id === m.provider)
    }
    if (!prov) throw new Error(`切换模型失败：供应商「${m.provider}」未注册且缺少接口地址，请在模型选择器重新选择（本条消息未发送）`)
    const isLocalBase = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(prov.base || '')
    if (!prov.apiKey && !isLocalBase) throw new Error(`切换模型失败：供应商「${prov.name || prov.id}」未填写 API Key，请到 设置 → 供应商 填写后重试（本条消息未发送）`)
    session.llmOverride = {
      providerId: prov.id,
      providerName: prov.name,
      base: (prov.base || '').replace(/\/+$/, ''),
      apiKey: plainKeyById(prov.id),        // ★ 1001：取明文；写密文进 override = 后续每轮发请求都 401
      model: m.model_id,
      // 0910：协议随供应商走——会话级模型覆盖不能丢协议，否则换模型后原生协议供应商退回 openai 格式（400）
      protocol: prov.protocol || 'openai-completions',
    }
    // 二十一批：标记来源=用户手选 → 通道配置的模型同步不许覆盖它
    session.llmOverrideBy = 'user'
    /* ★1013（已定案："UI 上只保留后台模型；全局模型功能回到以前 —— 用户在窗口选什么，
       全局模型就是什么，一直跟着用户最新的选择走"）：在**对话里**切模型时顺带更新全局模型 + 广播。
       为什么安全：会话自己的模型已落在 llmOverride / session.model 上，全局值只影响"之后新建的会话"
       和"新会话默认"这个兜底 —— 不会污染正在用的其他会话（0923 那次串台已由 per-session 解析兜住）。
       为什么排除通道会话：通道模型来自通道配置/通道侧手选（llmOverrideBy='channel'），不该改 PC 的全局模型。 */
    if (!CHANNEL_SIDE_ORIGINS.has(String(session.origin || '').trim())) {
      try {
        setActiveModel(prov.id, m.model_id)
        broadcastHost({ type: 'host/providers-updated', provider: prov.id, model: m.model_id, effort: getState().activeEffort || '' })
        console.log(`[providers] 跟随会话选择 → 全局模型 = ${prov.id} / ${m.model_id}`)
      } catch { /* 跟随失败不影响本条消息 */ }
    }
    // 0908三：权威回写 session.model/provider 并落盘（刷新/重启后 session.list 能带回真实模型，
    // 前端回填会话级覆盖不再丢）。createSession 时存的是创建那一刻的全局值，不随用户选择更新过——
    // 这就是"没单独选过模型的会话全跟着变、刷新后个人选择也丢"的后端侧根因。
    session.model = m.model_id
    session.modelProviderId = prov.id
    schedulePersist()
  }
  // 思考强度透传（前端 ReasoningModeBtn/模型面板）：按会话存储（窗口隔离）
  // 0908六：落盘（此前只在内存=刷新回全局默认；session.model RPC 也写这条但发送路径要同源）
  if (typeof p?.effort === 'string' && p.effort.trim()) { session.effort = p.effort.trim(); schedulePersist() }

  // 0920：工作模式随消息带（时效优先——避免"刚切模式就发消息"读到旧值），同时落会话便于刷新回填
  const modeIn = typeof p?.mode === 'string' ? p.mode.trim() : ''
  if (modeIn && ['default', 'plan', 'build', 'goal'].includes(modeIn) && session.mode !== modeIn) {
    session.mode = modeIn
    schedulePersist()
  }

  // 技能标记：前端 skill 标签随消息发送 → 简短引导
  let finalMessage = message
  let skillHint = ''
  if (Array.isArray(p?.skills) && p.skills.length > 0) {
    const names = (p.skills as unknown[]).filter(x => typeof x === 'string').map(String)
    if (names.length > 0) {
      finalMessage = `[技能:${names.join(',')}] ${message}`
      /* ★0930（产品要求"选了 skill 你却没调用，要提醒才调"）：根因=只贴裸标签、零指令——
         模型常把 [技能:x] 当装饰忽略。补一行硬指令（与 [模式:] 同款"注入+前端剥离"机制）：
         标签=意图声明，这行=动作要求（必须先 use_skill 加载再干活）。 */
      skillHint = '[技能指令] 用户为本消息启用了技能：本轮动手前**必须先调用 use_skill 加载'
        + names.map(n => `'${n}'`).join('、')
        + '**，拿到返回的执行指令后严格照做；不允许只看标签名字望文生义、凭印象跳过加载。'
    }
  }
  // 0920：工作模式 → 单独一行指令，置于正文之前（前端 PiChatView/piChat 会把这行剥掉不显示）
  const modeHint = buildModeHint(String(modeIn || session.mode || ''))
  if (modeHint) finalMessage = `${modeHint}\n${finalMessage}`

  /* ★0930：技能硬指令行（前端 [技能指令] 行剥离不显示） */
  if (skillHint) finalMessage = skillHint + '\n' + finalMessage

  /* ★1012c：项目档案卡改为**随本轮消息**注入（原来拼在 system prompt 里 —— 原因见 buildDynamicSystem
     那段"必须逐字节稳定"的注释）。卡片含"最近进度/各节行范围"等随档案变动的内容，放在消息里 ⇒
     它变了只影响本轮新增的未命中，动不到历史前缀（旧版每次重启/重建 agent 都因此付一次全价重算，
     本工作会话实测 121,702 token 一次）。压成单行，前端 stripModeHint / 后端 stripInjectedLines 一并剥掉。 */
  try {
    const _wd = String(session?.workDir || '')
    if (_wd) {
      const _dg = buildNoteDigest(_wd, 1100)
      if (_dg?.exists && _dg.text) {
        finalMessage = '[项目档案卡] ' + String(_dg.text).replace(/\s*\n\s*/g, '｜') + '\n' + finalMessage
      }
    }
  } catch { /* 卡片生成失败不影响发消息 */ }

  /* ★1012l：给模型一行**准确的上下文占用**（实测："llm 感知不到压缩，才 25% 他还在说快满"）。
     为什么要给：模型脑袋里没有数字，只能靠"历史看起来长不长"猜 ⇒ 倾向保守提醒（"快满了/开新窗口吧"），
     压缩完了也还照着旧印象说话（f280a851 实测：压缩前 618K 时它说"非常满"是对的；压缩到 147K 之后
     它只能靠用户一句"我压缩过了"才知道）。
     给了数字之后：占用低 → 它不再瞎提醒；占用高 → 它会主动收敛（少读大文件、少贴长内容）。
     ⚠️ 位置必须在本轮消息头部（与 [模式:]/[记忆召回]/[项目档案卡] 同一区）——那属于"每轮新增"的部分，
     动不了历史前缀缓存；**绝不能**放进 system prompt（那会每轮重建整条前缀）。
     前端 stripModeHint / 后端 stripInjectedLines 会把这行剥掉不显示（前缀 [上下文]）。 */
  try {
    const _cw = resolveContextWindow(String((session as any)?.modelProviderId || ''), String((session as any)?.model || ''))
    const _cu = Number((session as any)?.ctxUsedForRing) || Number((session as any)?.ctxUsedOverride?.tokens) || 0
    /* ★1012q：条件从 `_cw>0 && _cu>0` **放宽成 `_cw>0`** —— 实测踩坑：`ctxUsedForRing`/`ctxUsedOverride`
       只在内存里、且**只有跑过压缩判定**的会话才有值；新会话 / 短会话（如新建的测试会话）两者皆空
       ⇒ 旧条件直接不注入 ⇒ 恰恰是"最容易瞎猜快满"的新会话拿不到任何数据（1012m 的初衷落空）。
       现在 _cu=0 时照常注入，如实写"很小（尚未统计）"，别让模型误判。 */
    if (_cw > 0) {
      const _nComp = Array.isArray((session as any)?.contextSummaries) ? (session as any).contextSummaries.length : 0
      const _usedDesc = _cu > 0
        ? `约 ${Math.round((_cu / _cw) * 1000) / 10}%（约 ${Math.round(_cu / 1000)}K / 窗口 ${Math.round(_cw / 1000)}K token）`
        : `很小（尚未统计；窗口 ${Math.round(_cw / 1000)}K token）`
      finalMessage = `[上下文] 当前占用${_usedDesc}`
        + (_nComp > 0 ? `；本会话已压缩过 ${_nComp} 次，更早的消息已折成摘要（要看原文用 fs_read 读存档）` : '')
        + '。占用不高时**不必**提醒"上下文快满"、也**不必**劝开新窗口；占用 >80% 时请主动收敛（少读大文件、少贴长内容、少复述）。\n'
        + finalMessage
    }
  } catch { /* 占用行生成失败不影响发消息 */ }

  /* ★0930 自动召回：随消息附一行相关记忆/知识（前端 [记忆召回] 行剥离不显示；详见 buildMemoryRecall）。
     ★1004：注入类消息（分身回归/后台任务通知/自动续跑）不做召回——那是系统汇报不是用户提问，
     召回既浪费一次检索、拼回来的行也只是噪音（落盘已剥，但模型上下文里还在）。 */
  const _recall = INJECTED_USER_PREFIXES.some((pfx) => message.startsWith(pfx))
    ? ''
    : await buildMemoryRecall(message, String(session.projectId || '')).catch(() => '')
  if (_recall) {
    finalMessage = _recall + '\n' + finalMessage
    /* ★1010k：打点——本次召回命中多少条（口径：命中数 ≠ 全库统计），便于事后核对"它到底有没有用上记忆" */
    try {
      const _memN = (_recall.match(/mem_[0-9a-z]+/gi) || []).length
      const _kbN = (_recall.match(/kb_[0-9a-z]+/gi) || []).length
      sessionLog(String((session as any).id || ''), 'info', 'memory', `自动召回命中：记忆 ${_memN} 条 / 知识 ${_kbN} 条（本次命中，非全库统计）`)
    } catch { /* 打点失败不影响主流程 */ }
  }

  // 自动命名：首条消息做标题（12 字截断），刷新/重启后不丢
  if (session.title === '新对话' && session.messages.length === 0) {
    session.title = message.length > 12 ? `${message.slice(0, 12)}…` : message
    schedulePersist()
  }

  /* ★1001 外部预设：engine=codex 的会话走子进程外部轮（不进 pi agent 循环）。
     队列/忙碌语义与 native 一致（sessionAgentBusy 认 externalRuns；跑完 flushNextQueued 续发）。
     own 档：模型名从 p.model.model_id 带进来（对话窗口的"它家模型"下拉）；nis 档：用会话级模型覆盖。 */
  if (isExternalPreset(session?.presetId)) {
    /* ★1010 P0：外部流 ACP 分流开关 —— 缺省走 ACP 路径（ext-stream 内嵌）；
       回滚红线：NIS_EXT_ACP === 'off' 时回旧 codex exec 路径（runExternalTurn），两路并存。 */
    const _extRun = process.env.NIS_EXT_ACP === 'off' ? runExternalTurn : runExternalTurnAcp
    await _extRun(sessionId, finalMessage, typeof (m as any)?.model_id === 'string' ? String((m as any).model_id) : undefined)
    return { ok: true, ...(turnLevelFailure(sessionId) || {}) }
  }

  const agent = getOrCreateAgent(sessionId)
  // subscribe 已由 getOrCreateAgent 统一注册（只一次），此处不再重复订阅
  resetLoopGuard(sessionId) // 0908 新用户回合清空上一轮的连续失败计数（换参重试熔断按"单回合内连击"计）
  // 0909④：新用户回合复位自动续跑状态（软段计数/token 预算按"单用户消息"计）
  session.contState = { segments: 0, tokens: 0, counted: 0, graceUsed: false }

  // 多模态：前端附件（dataUrl 图片）→ pi ImageContent[]（{type:'image', data:base64, mimeType}）
  const imageAttachments = (Array.isArray(p?.attachments) ? p.attachments : [])
    .map((a: any) => {
      const mm = /^data:(.+?);base64,(.+)$/.exec(String(a?.dataUrl || ''))
      return mm ? { type: 'image' as const, data: mm[2], mimeType: mm[1] } : null
    })
    .filter(Boolean)
  const images = imageAttachments as unknown as ImageContent[] | undefined
  // 0907 供应商 A+B：发图闸门——能力真相源判 vision，非视觉模型不再"照发→网关 400"
  //（口径与 createStreamFn 完全一致：★1012t 起统一走 resolveSessionLlm —— 通道会话未单独配模型时=后台模型）
  if (images && images.length > 0) {
    const _sessLlm = resolveSessionLlm(session.id)
    const _pid = _sessLlm?.providerId || currentLlmConfig().providerId
    const _mid = _sessLlm?.model || currentLlmConfig().model
    if (!resolveModelCaps(_pid, _mid).vision) {
      throw new Error(`模型「${_mid}」不支持图片输入：请切换到支持视觉的模型，或移除图片后重试（本条消息未发送）`)
    }
  }
  if (images && images.length > 0) {
    logMM(`session.prompt 收到 ${images.length} 张图片，mime=${images.map(i => (i as any).mimeType).join(',')}`)
  } else {
    logMM(`session.prompt 附件字段=${JSON.stringify(p?.attachments)?.slice(0, 120) ?? 'undefined'}`)
  }

  /* ★0927 旧翻译层分流已退役（runTurnViaWorker）——新分流在 runPromptCore 开头（整条路复制）。 */

  // 设置版本检测：用户改了名字/性格后，旧 agent 的 system prompt 不更新 →
  // 重建 agent（动态 system 重新组装，transcript 回填上下文连续）
  const settingsVersion = typeof globalSettings.__version === 'number' ? globalSettings.__version : 0
  if (session.settingsVersion !== settingsVersion) {
    session.settingsVersion = settingsVersion
    const oldAgent = agents.get(sessionId)
    if (oldAgent) oldAgent.abort()
    agents.delete(sessionId)
    turnAccumulators.delete(sessionId)
    /* ★0927 R14：重建会丢掉旧 agent——挂起的询问卡跟着解除（否则 promise 干等 10 分钟） */
    clearPendingQuestions(sessionId)
    const freshAgent = getOrCreateAgent(sessionId)
    try {
      await (images && images.length > 0 ? freshAgent.prompt(finalMessage, images) : freshAgent.prompt(finalMessage))
    } catch (e) {
      /* ★0927 P0-1：裸错一律不许当产品错误漏给用户；忙时把消息抢救进队列 */
      const _rid = rescueBusyPromptToQueue(sessionId, p, message, e)
      if (_rid) return { ok: true, queued: true, ...queuePosOf(sessionId, _rid) }
      throw e
    }
    return { ok: true, rebuilt: true, ...(turnLevelFailure(sessionId) || {}) }
  }

  try {
    await (images && images.length > 0 ? agent.prompt(finalMessage, images) : agent.prompt(finalMessage))
  } catch (e) {
    /* ★0927 P0-1：上面的忙检查与本调用之间仍有窄竞态（同刻两条都过检查）→ 这里兜住 pi 的裸抛，
       消息按忙时策略入队，绝不"整条蒸发"。 */
    const _rid = rescueBusyPromptToQueue(sessionId, p, message, e)
    if (_rid) return { ok: true, queued: true, ...queuePosOf(sessionId, _rid) }
    throw e
  }
  /* ★0927 N3：turn 级失败如实回报（保守档）——见 turnLevelFailure 注释 */
  return { ok: true, ...(turnLevelFailure(sessionId) || {}) }
}

/* ══ ★1001 外部预设·codex 外部轮（打样落地）══════════════════════════════
 * 不进 pi agent 循环：codex CLI 子进程跑（codexAdapter），事件合成进 agent-event 通道
 * → 前端 PiChatView 零改动贴显。落盘格式与 pi transcript 一致（刷新/回放可用）。
 * 记账口径：usage 只记 codex 自报（外部口径），进 turnMetas 供 token 面板/对账。
 * 沙箱（1001 实测）：codex 自带 Windows 沙箱层会拒掉所有命令 CreateProcess（read-only/
 * workspace-write 全挂、模型空转烧 token；--ignore-rules 无效）⇒ 第一版口径=会话工作目录 +
 * danger-full-access（面板显式开关留给后续收紧，见 docs/外部预设-codex事件映射-1001.md §7）。
 */
const externalRuns = new Map<string, AbortController>()

function isExternalPreset(presetId: string | undefined | null): boolean {
  try {
    const p = readAgentPreset(String(presetId || ''))
    return !!p?.engine && p.engine !== 'native'
  } catch { return false }
}

/* ★1003 修复 4.71/4.72：外部轮（codex）回合回推关账 —— 原来 runExternalTurn 只手搓了落盘+状态复位，
 * handleAgentEvent 的 agent_end 关账整段被跳过（broadcastAgentEvent 只进 SSE 流，不进 handleAgentEvent）：
 * FIFO 回推目标不消费（下一轮回复全错位）、IM 回复不投递（codex 会话永远不回 QQ/微信）、
 * 截图清单跨轮泄漏、失败用户看不见。这里按 native agent_end 的回推块同款口径补齐
 *（与 handleAgentEvent 'agent_end' 内的回推块保持同款语义，改一处记得同步另一处）。 */
function closeOutExternalDelivery(sessionId: string, rawBody: string): void {
  // FIFO 消费：本轮对应的入站消息目标（与 native 同口径）
  const rt = shiftReplyTarget(sessionId)
  // 本轮截图清单无条件消费（即使没有回推目标也清空，防跨轮泄漏把上一轮的图重复发出去）
  const shotPaths = consumeTurnShots(sessionId)
  if (!rt) return
  const { text: bodyTextRaw, media: mediaRaw } = extractMediaDirectives(rawBody || '')
  /* ★1014a 补齐：与通道回推主链（native 轮）**同款**的 `<think>` 清洗 —— 模型有时把思考当正文
     text 块吐出来，外部预设（codex/opencode 等）的回推同样会原样露 think。只洗正文，不碰 media。 */
  const bodyText = String(bodyTextRaw || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const wdForMedia = sessions.get(sessionId)?.workDir?.trim() || ''
  const media = mediaRaw.map((m) => {
    let out: typeof m = m
    if (m.path && !path.isAbsolute(m.path) && wdForMedia) {
      out = { ...out, path: path.join(wdForMedia, m.path) }
    }
    if (out.path) {
      const fixed = resolveMediaPathLoose(out.path, wdForMedia)
      if (fixed.path !== out.path) out = { ...out, path: fixed.path }
    }
    return out
  })
  const alreadySent = new Set(media.map(m => (m.path ? path.resolve(m.path) : '')).filter(Boolean))
  const shotMedia = shotPaths
    .filter(p => !alreadySent.has(path.resolve(p)) && fs.existsSync(p))
    .map(p => ({ path: p, name: path.basename(p) }))
  const mediaAll = [...media, ...shotMedia]
  const prefixedBody = rt.prefix && bodyText ? `${rt.prefix}\n${bodyText}` : bodyText
  void (async () => {
    try {
      if (prefixedBody) await deliverToChannel(rt, prefixedBody)
      for (const m of mediaAll) {
        try {
          await deliverMediaToChannel(rt, m)
        } catch (e: any) {
          console.error(`[channel] 媒体发送失败（${m.name}）: ${String(e?.message || e).slice(0, 200)}`)
          await deliverToChannel(rt, `（附件「${m.name}」发送失败：${String(e?.message || e).slice(0, 100)}）`).catch(() => { /* ignore */ })
        }
      }
      if (!bodyText && !mediaAll.length) await deliverToChannel(rt, '（无输出）')
      try {
        const preview = (bodyText || (mediaAll.length ? `（${mediaAll.length} 个媒体文件）` : '（无输出）'))
          .replace(/\s+/g, ' ').trim().slice(0, 80)
        broadcastHost({
          type: 'host/channel-reply',
          sessionId,
          channel: rt.channel,
          botId: rt.botId,
          kind: rt.kind || '',
          title: sessions.get(sessionId)?.title || '',
          preview,
          at: Date.now(),
        })
      } catch { /* 广播失败不影响投递 */ }
    } catch (e: any) {
      const failNote = String(e?.message || e).slice(0, 200)
      console.error(`[channel] 回推失败: ${failNote}`)
      try {
        appendTaskNotice(sessionId, `⚠️ 这条回复没能发到 ${rt.channel === 'qq' ? 'QQ' : '微信'}：${failNote}\n（内容已留在本对话里，可直接在这里查看。）`)
      } catch { /* 记不进去也不影响主流程 */ }
    }
  })()
}

async function runExternalTurn(sessionId: string, prompt: string, hintModel?: string): Promise<{ ok: boolean }> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('session not found')
  const preset = readAgentPreset(session.presetId || '') || readAgentPreset('standard')
  const engine = String(preset?.engine || 'codex')
  if (engine !== 'codex') throw new Error(`外部引擎「${engine}」还没接线（当前只接了 codex）`)

  // ── 模型与钥匙 ──────────────────────────────────────────────
  // own=用它自己的 ~/.codex 登录/配置（不注入任何东西）；nis=NIS 供应商（会话级模型覆盖）注入临时 CODEX_HOME
  const modelSource: 'nis' | 'own' = preset?.modelSource === 'own' ? 'own' : 'nis'
  const extraEnv: Record<string, string> = {}
  let model: string | undefined
  if (modelSource === 'own') {
    model = hintModel || String(preset?.externalModel || '') || undefined
    /* ★1001二批："用它的 API"档：用户直填的 key（external-agents/credentials.json）优先注入；
       没填=走它自己的登录态（~/.codex 等它自己的配置目录）。 */
    const ownKey = getExternalKey('codex')
    if (ownKey) extraEnv.CODEX_API_KEY = ownKey
  } else {
    let ov = (session as any).llmOverride as { base?: string; apiKey?: string; model?: string; providerName?: string } | undefined
    if (!ov?.base || !ov?.model) {
      /* 兜底：UI 发送路径 p.model 会写 llmOverride；但 API/定时任务只写过 session.model
         （session.model/modelProviderId 字段）——从供应商表反查补全（1001 冒烟实测缺口）。 */
      const prov = getState().providers.find(x => x.id === (session as any).modelProviderId)
      if (prov && (session as any).model) {
        /* ★ 1001：apiKey 必须取明文 —— 它会被写进 codex 的 NIS_GW_KEY 环境变量发给网关，
           带密文去就是 401。*/
        ov = { base: prov.base, apiKey: plainKeyById(prov.id), model: String((session as any).model), providerName: prov.name }
      }
    }
    if (!ov?.base || !ov?.model) {
      throw new Error('外部预设（跟随 NIS）需要先在对话窗口选一个 NIS 模型再发送（本条未发送）')
    }
    model = ov.model
    /* codex 0.159 只吃 wire_api="responses"（chat 口已砍）——供应商必须兼容 Responses API
       （LongCat 实测两个口都开；不兼容的供应商会报错，如实透传给用户）。 */
    const home = path.join(DATA_ROOT, 'external-agents', `codex-home-${sessionId}`)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.toml'),
      `model = ${JSON.stringify(String(model))}\nmodel_provider = "nisgw"\nsandbox_mode = "danger-full-access"\napproval_policy = "never"\n\n[model_providers.nisgw]\nname = ${JSON.stringify(String(ov.providerName || 'NIS'))}\nbase_url = ${JSON.stringify(String(ov.base).replace(/\/+$/, ''))}\nenv_key = "NIS_GW_KEY"\nwire_api = "responses"\n`, 'utf8')
    extraEnv.CODEX_HOME = home
    /* ★ 1001：网关 key 同样必须是明文。ov 优先来自 session.llmOverride（历史版本可能往里存过密文），
       所以这里再兜一次 isEncrypted 自愈 —— 绝不让密文出到子进程的环境变量里（那必然是 401）。*/
    let gwKey = String(ov.apiKey || '')
    if (isEncrypted(gwKey)) {
      try { gwKey = plainKeyById(String((session as any).modelProviderId || '')) } catch { /* 保持原值，交由网关报错 */ }
    }
    extraEnv.NIS_GW_KEY = gwKey
  }

  /* ★1010 ACP 三病②/③：审批/沙箱档 —— config.toml 已加 sandbox_mode="danger-full-access" + approval_policy="never"
   *（codex 配置规范键名）；适配器再以 INITIAL_AGENT_MODE=agent-full-access 启动（=dangerFullAccess 沙箱 + approval 'never'，
   * 同 1001 旧路径语义）⇒ 会话工作目录内自动放行，杜绝 review infrastructure failure（审批基建挂→shell 空转/写文件被拦）。 */
  extraEnv.INITIAL_AGENT_MODE = 'agent-full-access'

  // ── 开轮：状态 + user 消息落盘（pi transcript + DSH messages 双口径） ──
  const ctrl = new AbortController()
  externalRuns.set(sessionId, ctrl)
  const modelTag = `codex/${model || 'default'}`
  const ts0 = Date.now()
  session.status = 'running'
  ;(session as any).turnStartTime = ts0
  broadcastMux(sessionId, { type: 'session/status', sessionId, running: true })
  broadcastHost({ type: 'host/session-status', sessionId, running: true })
  sessionLog(sessionId, 'info', 'lifecycle', `外部轮开始（引擎 codex，模型来源 ${modelSource}，model=${model || '默认'}）`)
  const userPi = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: ts0 }
  ;((session as any).transcript ||= []).push(userPi)
  session.messages.push({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], timestamp: ts0, expectFinal: true } as any)
  schedulePersist()

  // ── 事件合成（借 agent-event 通道贴显） ──
  broadcastAgentEvent(sessionId, { type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now(), model: modelTag } } as unknown as AgentEvent)
  let finalText = ''
  let failReason: string | undefined
  const toolCalls: Array<{ id: string; name: string; summary: string; detail?: string; isError?: boolean }> = []
  let usage: { inputTokens: number; cacheReadTokens: number; completionTokens: number } | null = null

  /* ★1003 修复 4.69/4.70：回合体包 try/catch/finally —— 原来 runCodexTurn 一拒（spawn 失败/超时/
   * 适配器炸）就直接穿出函数：externalRuns 不删（会话永久报忙）、status 卡 running、
   * running:false 不广播（UI 转圈到天荒地老）、队列永久堵死。finally 保证关账必达。 */
  let turnOk = false
  try {
  const res = await runCodexTurn({
    prompt,
    cwd: String((session as any).workDir || process.cwd()),
    model,
    sandbox: 'danger-full-access',   // ★1001：沙箱层拒 CreateProcess，见文件头；跑在会话工作目录
    ignoreRules: true,
    timeoutMs: 10 * 60 * 1000,
    signal: ctrl.signal,
    extraEnv,
  }, (e) => {
    if (e.kind === 'text') {
      finalText += (finalText && !/\n$/.test(finalText) ? '\n' : '') + e.text
      broadcastAgentEvent(sessionId, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: e.text }, message: { model: modelTag } } as unknown as AgentEvent)
    } else if (e.kind === 'thinking') {
      broadcastAgentEvent(sessionId, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: e.text }, message: { model: modelTag } } as unknown as AgentEvent)
    } else if (e.kind === 'tool') {
      if (e.status === 'running') {
        const tc = { id: `ext-${toolCalls.length}-${Date.now().toString(36)}`, name: e.name, summary: e.summary }
        toolCalls.push(tc)
        broadcastAgentEvent(sessionId, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', partial: { content: [{ type: 'toolCall', id: tc.id, name: tc.name, arguments: { command: tc.summary } }] } }, message: { model: modelTag } } as unknown as AgentEvent)
        broadcastAgentEvent(sessionId, { type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name } as unknown as AgentEvent)
      } else {
        // item.started/completed 成对；并行工具按"同名未收尾的最后一条"对号（v1 口径，见图纸）
        const tc = [...toolCalls].reverse().find(t => t.summary === e.summary && t.detail === undefined) || toolCalls[toolCalls.length - 1]
        if (tc) {
          tc.detail = e.detail ?? e.summary
          tc.isError = e.status === 'fail'
          broadcastAgentEvent(sessionId, { type: 'tool_execution_end', toolCallId: tc.id, result: { content: tc.detail }, isError: tc.isError } as unknown as AgentEvent)
        }
      }
    } else if (e.kind === 'usage') {
      /* ★1005：按声明形状显式取值（原来存整个事件对象）。语义等价 —— usage 只被读这 3 个字段，
         只存需要的字段更干净。
         ⚠️ 注意：下面 `usage?.completionTokens` 那 7 处 TS2339（"never 上没有该属性"）是 **TS 控制流分析的伪报**，
         **与本改动无关、目前未解决**（试过显式构造/加注解都不消）。运行时可验证是对的：token 面板显示的正是这三个值。 */
      usage = { inputTokens: e.inputTokens, cacheReadTokens: e.cacheReadTokens, completionTokens: e.completionTokens }
    } else if (e.kind === 'turn_end' && !e.ok) {
      failReason = e.reason
    }
    // notice（自愈噪音/元数据提示）只进日志，不上界面
  })
  turnOk = res.ok

  // ── 收轮：失败如实标在正文尾部（不装没事） ──
  if (!res.ok && failReason) finalText += `${finalText ? '\n\n' : ''}[外部轮未完成] ${failReason}`
  broadcastAgentEvent(sessionId, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), model: modelTag } } as unknown as AgentEvent)
  broadcastAgentEvent(sessionId, { type: 'agent_end' } as unknown as AgentEvent)

  // ── 落盘：assistant（text+toolCall）与 toolResult，pi 回放口径 ──
  const asstContent: any[] = []
  if (finalText) asstContent.push({ type: 'text', text: finalText })
  for (const tc of toolCalls) asstContent.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: { command: tc.summary } })
  ;((session as any).transcript ||= []).push({ role: 'assistant', content: asstContent, timestamp: Date.now(), model: modelTag })
  for (const tc of toolCalls) {
    ;((session as any).transcript ||= []).push({ role: 'toolResult', toolCallId: tc.id, toolName: tc.name, content: [{ type: 'text', text: tc.detail || tc.summary }], timestamp: Date.now() })
  }
  session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), expectFinal: false } as any)
  // usage 记账（外部口径）：token 面板/对账用；codex 自报的量，不与 LLM 网关账混算
  ;((session as any).turnMetas ||= []).push({
    ts: Date.now(),
    timing: { llmMs: Date.now() - ts0 },
    usage: {
      completionTokens: usage?.completionTokens || 0,
      promptTokens: usage?.inputTokens || 0,
      cacheReadTokens: usage?.cacheReadTokens || 0,
    },
  })
  /* ★1001 六批：额度=实时拉官方（不做本地记账，已定案）——见 externalAgents.quota */

  return { ok: res.ok }
  } catch (e: any) {
    /* ★1003 修复 4.69/4.70：异常路径如实收尾 —— 错误进正文 + 落盘，用户看得见（不装没事） */
    failReason = String(e?.message || e).slice(0, 300)
    finalText += `${finalText ? '\n\n' : ''}[外部轮异常] ${failReason}`
    try {
      broadcastAgentEvent(sessionId, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), model: modelTag } } as unknown as AgentEvent)
      ;((session as any).transcript ||= []).push({ role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), model: modelTag })
      session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), expectFinal: true } as any)
      schedulePersist()
    } catch { /* 落盘失败不再拦 */ }
    return { ok: false }
  } finally {
    /* ★1003 修复 4.71/4.72：外部轮关账补齐 —— 回推 FIFO/媒体/IM 投递（closeOutExternalDelivery）
     * + 未读推送 + 标题生成，原来整段被跳过（合成 agent_end 只进 SSE，不走 handleAgentEvent 关账） */
    try { closeOutExternalDelivery(sessionId, finalText) } catch (e) { console.error('[external] 回推关账失败:', e) }
    try {
      const _unread = unreadCountOf(session)
      if (_unread > 0) writeMuxTo('', { type: 'session/projection', sessionId, key: 'unread', seq: Date.now(), value: { unread: _unread } })
    } catch (e) { console.warn('[unread] 推送失败:', String((e as any)?.message || e)) }
    if (!session.titleManual && !session.titleGenerated) void generateSessionTitle(sessionId)
    session.status = 'idle'
    session.updatedAt = Date.now()
    schedulePersist()
    /* ★1005：这是**真实的轮结束帧**，必须带 agentEnd —— 前端「回复完成」通知与 finalizeStreaming（落态）
       都只认 agentEnd/aborted/stopped 三类真终态帧（见 ChatInterface 的 session/status 分支）。
       原来不带 ⇒ 外部会话**永远不提醒、不定稿**，与该处注释声明的意图矛盾。 */
    broadcastMux(sessionId, { type: 'session/status', sessionId, running: false, agentEnd: true })
    broadcastHost({ type: 'host/session-status', sessionId, running: false })
    externalRuns.delete(sessionId)
    sessionLog(sessionId, turnOk ? 'info' : 'warn', 'lifecycle', `外部轮结束（${turnOk ? 'ok' : 'fail：' + (failReason || '未知')}，工具 ${toolCalls.length} 个）`)
    // 队列续发（与 native agent_end→flush 同语义）：跑完把排队消息放行
    try { flushNextQueued(sessionId) } catch { /* ignore */ }
  }
}

/* ══ ★1010 P0：外部预设·ACP 外部轮（ext-stream 内嵌 2.0）══════════════════════════
 * 契约：会话工作区《P0契约-ext-stream与PartEvent-1010.md》。
 * 生命周期外壳与 runExternalTurn **逐段同款**（状态/排队/插话/取消/落盘/关账/队列续发），
 * 仅两处不同：
 *   ① 事件源 = ACP 适配器（runAcpTurn）：PartEvent 逐条追加 session.extTranscript（契约形状）
 *      + broadcastMux 'ext-stream' 帧（前端外部流渲染分支，不进 piChat 的 agent-event 翻译路径）；
 *   ② 落盘走兼容记账：pi transcript 只落**纯文本** assistant 消息（只有 finalText，不伪造
 *      thinking/tool 中间态）+ session.messages 一条 —— 伪中间态翻译废除、文本记账保留
 *      （标题生成/IM 回推/会话摘要靠它）。usage 记账用收轮真值（含 thoughtTokens）。
 * 回滚红线：NIS_EXT_ACP === 'off' 时分流点走旧 runExternalTurn（见 runPromptCore 内分流）。
 */
async function runExternalTurnAcp(sessionId: string, prompt: string, hintModel?: string): Promise<{ ok: boolean }> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('session not found')
  const preset = readAgentPreset(session.presetId || '') || readAgentPreset('standard')
  const engine = String(preset?.engine || 'codex')
  if (engine !== 'codex') throw new Error(`外部引擎「${engine}」还没接线（当前只接了 codex）`)

  // ── 模型与钥匙（与 runExternalTurn 逐行同款）──────────────────────
  const modelSource: 'nis' | 'own' = preset?.modelSource === 'own' ? 'own' : 'nis'
  const extraEnv: Record<string, string> = {}
  let model: string | undefined
  if (modelSource === 'own') {
    model = hintModel || String(preset?.externalModel || '') || undefined
    /* own 档：用户直填的 key 有就注入（CODEX_API_KEY）；没有 = 走它自己的登录态（~/.codex），不注入 */
    const ownKey = getExternalKey('codex')
    if (ownKey) extraEnv.CODEX_API_KEY = ownKey
  } else {
    let ov = (session as any).llmOverride as { base?: string; apiKey?: string; model?: string; providerName?: string } | undefined
    if (!ov?.base || !ov?.model) {
      /* 兜底：UI 发送路径 p.model 会写 llmOverride；但 API/定时任务只写过 session.model —— 从供应商表反查补全 */
      const prov = getState().providers.find(x => x.id === (session as any).modelProviderId)
      if (prov && (session as any).model) {
        ov = { base: prov.base, apiKey: plainKeyById(prov.id), model: String((session as any).model), providerName: prov.name }
      }
    }
    if (!ov?.base || !ov?.model) {
      throw new Error('外部预设（跟随 NIS）需要先在对话窗口选一个 NIS 模型再发送（本条未发送）')
    }
    model = ov.model
    /* 临时 CODEX_HOME config.toml（probe.mjs 同款装配）：model/model_provider=nisgw/base_url/env_key/wire_api=responses */
    const home = path.join(DATA_ROOT, 'external-agents', `codex-home-${sessionId}`)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.toml'),
      `model = ${JSON.stringify(String(model))}\nmodel_provider = "nisgw"\nsandbox_mode = "danger-full-access"\napproval_policy = "never"\n\n[model_providers.nisgw]\nname = ${JSON.stringify(String(ov.providerName || 'NIS'))}\nbase_url = ${JSON.stringify(String(ov.base).replace(/\/+$/, ''))}\nenv_key = "NIS_GW_KEY"\nwire_api = "responses"\n`, 'utf8')
    extraEnv.CODEX_HOME = home
    /* 明文 key（带密文出环境变量必 401）——历史 llmOverride 可能存过密文，再兜一次 isEncrypted 自愈 */
    let gwKey = String(ov.apiKey || '')
    if (isEncrypted(gwKey)) {
      try { gwKey = plainKeyById(String((session as any).modelProviderId || '')) } catch { /* 保持原值，交由网关报错 */ }
    }
    extraEnv.NIS_GW_KEY = gwKey
  }

  /* ★1010 ACP 三病②/③：审批/沙箱档 —— config.toml 已加 sandbox_mode="danger-full-access" + approval_policy="never"
   *（codex 配置规范键名）；适配器再以 INITIAL_AGENT_MODE=agent-full-access 启动（=dangerFullAccess 沙箱 + approval 'never'，
   * 同 1001 旧路径语义）⇒ 会话工作目录内自动放行，杜绝 review infrastructure failure（审批基建挂→shell 空转/写文件被拦）。 */
  extraEnv.INITIAL_AGENT_MODE = 'agent-full-access'

  // ── 开轮：状态 + user 消息落盘（pi transcript + DSH messages 双口径，同 runExternalTurn） ──
  const ctrl = new AbortController()
  externalRuns.set(sessionId, ctrl)
  const modelTag = `codex/${model || 'default'}`
  const ts0 = Date.now()
  session.status = 'running'
  ;(session as any).turnStartTime = ts0
  broadcastMux(sessionId, { type: 'session/status', sessionId, running: true })
  broadcastHost({ type: 'host/session-status', sessionId, running: true })
  sessionLog(sessionId, 'info', 'lifecycle', `外部轮开始（引擎 codex/ACP，模型来源 ${modelSource}，model=${model || '默认'}）`)
  /* ★1010g：剥掉 NIS 自己的系统注入行再落盘/外发 —— [记忆召回]/[模式:]/[技能指令] 本是给主 AI 的
     线索，喂给外部 agent 会被当成任务执行（实锤：codex 把召回行当任务、产出存成 记忆召回-*.md）。
     正则口径同 server.ts:5171 的老剥离逻辑。 */
  prompt = prompt
    .split(/\r?\n/)
    .filter((l) => !/^\s*\[(记忆召回|技能指令)\]/.test(l) && !/^\s*\[模式:/.test(l))
    .join('\n').trim()
  /* ★1010h：召回背景只加进「发给 codex 的 agentPrompt」，落盘/历史仍是用户原文（开关 extPresetContext）
     —— 位置必须在本函数内、userPi 之前（1010-10-06 事故：曾误插到上游同步函数，导致后端起不来 + agentPrompt 未定义）。 */
  let agentPrompt = prompt
  try {
    const ctx = await buildExternalContext(prompt, String((session as any).projectId || ''))
    if (ctx) {
      agentPrompt = prompt + '\n\n【NIS 背景上下文（仅供参考，不是任务指令）】\n' + ctx
      try { sessionLog(sessionId, 'info', 'memory', `外部轮召回命中：记忆 ${(ctx.match(/mem_[0-9a-z]+/gi) || []).length} 条 / 知识 ${(ctx.match(/kb_[0-9a-z]+/gi) || []).length} 条（本次命中）`) } catch { /* ignore */ }
    }
  } catch { /* 召回失败零打扰 */ }
  const userPi = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: ts0 }
  ;((session as any).transcript ||= []).push(userPi)
  session.messages.push({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], timestamp: ts0, expectFinal: true } as any)
  schedulePersist()

  // ── 事件源：ACP PartEvent → extTranscript + ext-stream 帧（契约形状，原序逐条） ──
  const ext: PartEvent[] = (((session as any).extTranscript ||= []) as PartEvent[])
  let finalText = ''
  let failReason: string | undefined
  let toolCount = 0
  let usage: { inputTokens: number; cachedReadTokens: number; completionTokens: number; thoughtTokens?: number } | null = null

  let turnOk = false
  try {
  const res = await runAcpTurn({
    prompt: agentPrompt,
    cwd: String((session as any).workDir || process.cwd()),
    extraEnv,
    timeoutMs: 10 * 60 * 1000,
    signal: ctrl.signal,
    /* ★1010j（跨轮上下文）：上轮会话 id 且模型未变 → session/load 续上 codex 自己的会话；换模型/无 id → 新建 */
    resumeAcpSessionId: (((session as any).extAcpModel === modelTag) && (session as any).extAcpSessionId) ? String((session as any).extAcpSessionId) : undefined,
    onAcpSessionId: (sid: string) => { (session as any).extAcpSessionId = sid; (session as any).extAcpModel = modelTag; schedulePersist() },
    /* ★契约⑥：seq = session.extTranscript.length + 1 起，保证同会话跨轮单调（回放按 seq 保序） */
    startSeq: ext.length + 1,
  }, (part) => {
    ext.push(part)
    broadcastMux(sessionId, { type: 'ext-stream', sessionId, seq: part.seq, part } as unknown as MuxFrame)
    if (part.kind === 'text') {
      finalText += part.delta                        // ACP 正文是真增量，直接拼
    } else if (part.kind === 'usage') {
      usage = { inputTokens: part.inputTokens, cachedReadTokens: part.cachedReadTokens, completionTokens: part.completionTokens, thoughtTokens: part.thoughtTokens }                                   // 中途 {used,size} 估算 → 收轮真值后到覆盖
    } else if (part.kind === 'tool-start') {
      toolCount++
    } else if (part.kind === 'turn-end' && !part.ok && !ctrl.signal.aborted) {
      failReason = part.reason || part.stopReason    // 用户取消不算失败（同 runExternalTurn 口径）
    }
  })
  turnOk = res.ok

  // ── 收轮：失败如实标在正文尾部（不装没事；同 runExternalTurn 口径） ──
  if (!res.ok && failReason) finalText += `${finalText ? '\n\n' : ''}[外部轮未完成] ${failReason}`

  // ── 落盘（兼容记账，契约口径）：pi transcript 落**纯文本** assistant 消息 + session.messages 一条 ──
  ;((session as any).transcript ||= []).push({ role: 'assistant', content: finalText ? [{ type: 'text', text: finalText }] : [], timestamp: Date.now(), model: modelTag })
  session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), expectFinal: false } as any)
  // usage 记账（外部口径）：token 面板/对账用；收轮真值，含 thoughtTokens
  ;((session as any).turnMetas ||= []).push({
    ts: Date.now(),
    timing: { llmMs: Date.now() - ts0 },
    usage: {
      completionTokens: usage?.completionTokens || 0,
      promptTokens: usage?.inputTokens || 0,
      cacheReadTokens: usage?.cachedReadTokens || 0,
      thoughtTokens: usage?.thoughtTokens || 0,
    },
  })

  return { ok: res.ok }
  } catch (e: any) {
    /* 异常路径如实收尾 —— 错误进正文 + 落盘，用户看得见（同 runExternalTurn） */
    failReason = String(e?.message || e).slice(0, 300)
    finalText += `${finalText ? '\n\n' : ''}[外部轮异常] ${failReason}`
    try {
      ;((session as any).transcript ||= []).push({ role: 'assistant', content: finalText ? [{ type: 'text', text: finalText }] : [], timestamp: Date.now(), model: modelTag })
      session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now(), expectFinal: true } as any)
      schedulePersist()
    } catch { /* 落盘失败不再拦 */ }
    return { ok: false }
  } finally {
    /* 关账（同 runExternalTurn）：回推 FIFO/媒体/IM 投递 + 未读推送 + 标题生成 + 状态复位 + 队列续发 */
    try { closeOutExternalDelivery(sessionId, finalText) } catch (e) { console.error('[external] 回推关账失败:', e) }
    try {
      const _unread = unreadCountOf(session)
      if (_unread > 0) writeMuxTo('', { type: 'session/projection', sessionId, key: 'unread', seq: Date.now(), value: { unread: _unread } })
    } catch (e) { console.warn('[unread] 推送失败:', String((e as any)?.message || e)) }
    if (!session.titleManual && !session.titleGenerated) void generateSessionTitle(sessionId)
    session.status = 'idle'
    session.updatedAt = Date.now()
    schedulePersist()
    /* ★1005：同上一处 —— 真实轮结束帧要带 agentEnd，否则外部会话不提醒、不定稿。 */
    broadcastMux(sessionId, { type: 'session/status', sessionId, running: false, agentEnd: true })
    broadcastHost({ type: 'host/session-status', sessionId, running: false })
    externalRuns.delete(sessionId)
    sessionLog(sessionId, turnOk ? 'info' : 'warn', 'lifecycle', `外部轮结束（${turnOk ? 'ok' : 'fail：' + (failReason || '未知')}，工具 ${toolCount} 个）`)
    // 队列续发（与 native agent_end→flush 同语义）：跑完把排队消息放行
    try { flushNextQueued(sessionId) } catch { /* ignore */ }
  }
}



/* ★0927（已定案 ①b）：会话**未读数** —— lastReadAt 之后的 AI 回复条数（权威口径，随会话持久化）。
   性能：从末尾倒着数，遇到早于 lastReadAt 的消息立刻停（只走"新增的尾巴"，不扫全量）。
   从未读过（lastReadAt 为空）→ 记 0（历史会话升级后不该突然冒出几百条未读）。 */
function unreadCountOf(s: any): number {
  const msgs: any[] = Array.isArray(s?.messages) ? s.messages : []
  const since = Number(s?.lastReadAt) || 0
  if (!since) return 0
  let n = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const ts = Number(msgs[i]?.timestamp) || 0
    if (ts <= since) break
    if (msgs[i]?.role === 'assistant') n++
  }
  return n
}

/* ★0927 P1-4：列表用「最后一条消息」摘要（侧栏预览）。
   由来：前端 conversations.ts 一直在读 `s.lastMessage`，后端此前**根本没这个字段** → 侧栏"最后一条消息"
   刷新后恒空（实报）。口径与 firstMessage 一致：只取 text 块、去掉 [[图片:N]] 标记、80 字截断；
   跳过自动续跑这类内部注入消息（它们不是用户在说话）。 */
function lastMessageBrief(s: any): string {
  const msgs: any[] = Array.isArray(s?.messages) ? s.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = (Array.isArray(msgs[i]?.content) ? msgs[i].content : [])
      .filter((c: any) => c?.type === 'text').map((c: any) => String(c.text || '')).join(' ')
      .replace(/\[\[图片:\d+\]\]/g, '').trim()
    if (!text) continue
    /* ★1004：注入类消息统一跳过（原只跳 2 种前缀，分身回归/后台任务通知会顶掉侧栏预览） */
    if (INJECTED_USER_PREFIXES.some((pfx) => stripInjectedLines(text).startsWith(pfx))) continue
    return text.slice(0, 80)
  }
  return ''
}

/**
 * 通知目标 key（`channel:botId:peerId`）→ 可读位置名（群名/私聊）
 */
function peerLabelFromKey(key: string): string {
  const parts = String(key || '').split(':')
  if (parts.length < 3) return key || ''
  const channel = parts[0]
  const botId = parts[1]
  const peerId = parts.slice(2).join(':')
  try { return labelFor(channel, botId, peerId) || peerId.slice(0, 8) } catch { return peerId.slice(0, 8) }
}

/**
 * 任务的「支线清单」（0912 十九批）—— 供卡片上的「查看列表」直接渲染。
 * 每条 = 一个通知位置（或无线程时的任务对话）对应的独立上下文。
 */
function taskBranches(task: any): Array<{
  sessionId: string; key: string; label: string; title: string; lastMessage: string
  updatedAt: number; inList: boolean; isExec: boolean; exists: boolean; running: boolean
}> {
  const exec = String(task?.execSessionId || '')
  const entries: Array<[string, string]> = Object.entries(task?.ownSessions || {}).map(([k, v]) => [k, String(v || '')])
  if (task?.ownSessionId) entries.push(['', String(task.ownSessionId)])
  const seen = new Set<string>()
  const out: any[] = []
  for (const [key, sid] of entries) {
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    const s = sessions.get(sid)
    const last = (s?.messages?.[s.messages.length - 1]?.content || [])
      .filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ')
    out.push({
      sessionId: sid,
      key,
      label: key ? peerLabelFromKey(key) : '任务对话',
      title: s?.title || '（已被删除）',
      lastMessage: String(last || '').slice(0, 80),
      updatedAt: s?.updatedAt || 0,
      inList: s?.inMainList === true,
      isExec: sid === exec,
      exists: !!s,
      running: s?.status === 'running',
    })
  }
  // 执行会话排最前（它就是「在对话中查看」的默认落点）
  out.sort((a, b) => (Number(b.isExec) - Number(a.isExec)) || (b.updatedAt - a.updatedAt))
  return out
}

/**
 * 已知的通道对端清单（0912 二十一批抽出）—— 「完成任务通知位置」与「转为通道对话」共用同一份口径。
 *
 * 为什么只有"聊过"的对端在列表里：推送/迁移都要求知道对端 id（QQ=openid / 微信=user_id），
 * 而这个 id 只有对方先发过消息才拿得到；只配了机器人但没人聊过 → 无从列举。
 */
function enumerateChannelPeers(): any[] {
  healSessionsFromLinks()
  const links = listLinks()
  const out: any[] = []
  const seen = new Set<string>()
  for (const v of Object.values(links)) {
    if (!v?.channel || !v?.botId || !v?.peerId) continue
    if (!['qq', 'wechat'].includes(v.channel)) continue
    const key = `${v.channel}:${v.botId}:${v.peerId}`
    if (seen.has(key)) continue
    seen.add(key)
    const cfg: any = getChannel(v.channel)
    const bot = (cfg?.bots || []).find((b: any) => b.id === v.botId)
    const s = sessions.get(v.sessionId)
    // kind 以**映射上的对端类型**为准（同一会话可能被多个对端复用，会话级字段会串味 → 发错端点）
    const kind = v.kind || s?.originKind || ''
    const kindLabel = kind === 'group' ? '群聊' : kind === 'channel' ? '频道' : '私聊'
    /**
     * 机器人显示名：配置里的昵称 → **运行时昵称**（QQ READY 事件下发的 Nis/牢大，配置里往往为空）
     * → 兜底「QQ/微信」。二十一批修：之前只读配置，导致分节标题 fallback 成 bot_mtx… 这种 id。
     */
    const runtimeNick = v.channel === 'qq'
      ? String(qqBotStatus()[v.botId]?.nickname || '').trim()
      : String(cfg?.bots?.find((b: any) => b.id === v.botId)?.nickname || '').trim()
    const botName = String(bot?.nickname || '').trim() || runtimeNick || (v.channel === 'wechat' ? '微信' : 'QQ')
    /**
     * 显示名（0912 十七批）：不用「群聊 · 60B6CC」这种看不懂的 id，
     * 而是「群A / 群B / 私聊」—— 多群场景下一眼能对上号（可改名，见 channel.setPeerLabel）。
     */
    const peerLabel = labelFor(v.channel, v.botId, v.peerId, kind) || kindLabel
    /**
     * 二十一批：分组信息（用户要求「列表一类、微信一类、QQ机器人1一类…」）——
     * 前端按 groupKey 分节渲染，groupLabel 直接当小标题（QQ · Nis / 微信）。
     */
    const groupKey = v.channel === 'wechat' ? 'wechat' : `qq:${v.botId}`
    const groupLabel = v.channel === 'wechat' ? '微信' : `QQ · ${botName}`
    out.push({
      channel: v.channel,
      botId: v.botId,
      peerId: v.peerId,
      kind,
      botName,
      peerLabel,
      groupKey,
      groupLabel,
      label: v.channel === 'wechat' ? `微信 · ${peerLabel}` : `QQ · ${botName} · ${peerLabel}`,
      lastAt: v.lastAt || 0,
      /** QQ：被动回复窗口（5 分钟）内有入站消息 → 推送走被动回复，**不占每月 4 条额度** */
      passiveWindow: v.channel === 'qq' ? qqPassiveWindowOpen(v) : undefined,
    })
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  return out
}

async function dispatchMethod(method: string, payload: unknown): Promise<unknown> {
  const p = payload as Record<string, unknown>
  const sessionId = p?.sessionId as string | undefined

  switch (method) {
    case 'host.describe': {
      const cfg = currentLlmConfig()
      /* ★ 0927 第 0 批：暴露数据根来源 + 降级文件清单 —— "设置还原默认"类问题排查第一步
         就是确认"读的是哪个目录"；降级清单让前端/排查者一眼看到哪些存储处于损坏保护状态。 */
      return { version: '1.1.5-pi-bridge', cwd: process.cwd(), provider: cfg.providerId, model: cfg.model, attachedSessions: sessions.size, canOpenPath: false, dataRoot: DATA_ROOT, dataRootFromEnv: !!process.env.NIS_DATA_DIR, degradedFiles: degradedFiles() }
    }

    /* ── 0915：前端 UI 状态持久化（**替代 localStorage**）──
       为什么必须搬走后端：打包版后端端口是动态的（避开开发后端），窗口 origin 每次启动都可能变，
       而 localStorage 按 origin 隔离 → 语言/主题/项目列表/伙伴别名/引导完成标记等**每次启动全丢**
       （实测症状：引导页每次都弹、设置被重置）。落到 data/ui-state.json 后随数据目录一起备份与迁移，
       且与端口无关。前端唯一入口：frontend/src/utils/localStore.ts（同步内存镜像 + 写透后端）。 */
    case 'uiState.load': {
      const f = path.join(DATA_ROOT, 'ui-state.json')
      try {
        if (!fs.existsSync(f)) return { state: {} }
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        return { state: j && typeof j === 'object' ? j : {} }
      } catch {
        return { state: {} }
      }
    }

    case 'uiState.merge': {
      const patch = (p?.patch || {}) as Record<string, string | null>
      const dels = Array.isArray(p?.deletes) ? (p.deletes as string[]) : []
      const f = path.join(DATA_ROOT, 'ui-state.json')
      let cur: Record<string, unknown> = {}
      try {
        if (fs.existsSync(f)) {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'))
          if (j && typeof j === 'object') cur = j as Record<string, unknown>
        }
      } catch { cur = {} }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete cur[k]
        else cur[k] = v
      }
      for (const k of dels) delete cur[k]
      fs.mkdirSync(DATA_ROOT, { recursive: true })
      fs.writeFileSync(f, JSON.stringify(cur, null, 2), 'utf8')
      return { ok: true, keys: Object.keys(cur).length }
    }

    /* ── 0920：用户记事本（用户与 AI 共用的一本待办/便签）──
       落盘 <数据根>/notebook.json；AI 侧工具见 notebookTools.ts（同一套 store）。 */
    case 'notebook.list':
      return { items: notebookList({ status: String(p?.status || 'all'), keyword: String(p?.keyword || '') }), counts: notebookCounts() }
    case 'notebook.add': {
      /* ★ 0921：原来 `source` 硬编码 `'user'` —— 于是**AI 侧通过 RPC 记的条目也会被标成用户写的**
         （实测：助手用 RPC 记的 11 条待办，便签上全显示"我"而不是"AI"）。
         改成可选参数：显式传 'ai' 才标 AI，缺省仍是 'user'（前端手动「+ 新增」走的就是缺省路径）。 */
      const src = (p?.source === 'ai' ? 'ai' : 'user') as 'ai' | 'user'
      const item = notebookAdd({ title: String(p?.title || ''), detail: String(p?.detail || ''), status: p?.status, source: src, tags: p?.tags, images: p?.images })  /* ★1011aa 接线修复：images 必须透传 —— 漏了它 = 前端贴的图保存时被静默丢弃（不报错） */
      return { item }
    }
    case 'notebook.update': {
      const item = notebookUpdate(String(p?.id || ''), { title: p?.title, detail: p?.detail, status: p?.status, tags: p?.tags, images: p?.images })  /* ★1011aa 接线修复：同上（images 整体替换；不传=不动图片） */
      if (!item) throw new Error(`记事本里没有 id=${p?.id} 的条目`)
      return { item }
    }
    case 'notebook.remove': {
      const ok = notebookRemove(String(p?.id || ''))
      if (!ok) throw new Error(`记事本里没有 id=${p?.id} 的条目`)
      return { ok: true }
    }
    /* ★ 1011：便签详情贴图 —— 前端把图片 dataURL 交上来，落盘 <数据根>/notebook-assets/，
       回一个 ref；条目里只存 ref（前端 <img src="/api/notebook-asset/<ref>"> 直出看图）。 */
    case 'notebook.imageAdd': {
      const image = notebookImageAdd(String(p?.dataUrl || ''), String(p?.name || 'image'))
      return { image }
    }

    case 'session.list':
      return { sessions: Array.from(sessions.values())
        // 安装助手已是正式预设：会话正常进聊天列表（不再按预设隐藏）
        .map(s => {
          // 0908三：带出会话模型归属供应商+base，供前端刷新后回填 convModel（隔离不串台）。
          // 存量无 modelProviderId 的按 model 反查；查不到前端不回填（保持兜底全局的旧行为）。
          const pid = resolveModelProviderId(s.model, s.modelProviderId)
          const mp = pid ? getState().providers.find(x => x.id === pid) : undefined
          return {
            id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
            model: s.model, modelProviderId: pid || undefined, modelBase: mp?.base || '',
            effort: s.effort,
            // 0909⑦：排队消息随列表带回（前端刷新/切会话回填镜像）
            queuedMessages: s.queuedMessages || [],
            status: s.status, workDir: s.workDir,
            /* ★0927 P1-3（实测 188 会话一次 session.list = 47,655,756 B ≈ 47.6MB）：
               **不再**全量带 messages —— 前端 conversations.ts 的映射从不读它（全仓无消费方），
               列表只需要元数据；正文走 session.history（分页，只取要看的窗口）。
               这一刀把启动/刷新时 47MB 的序列化+传输+JSON.parse 砍到 KB 级（多窗口各自一份，省得更狠）。
               ★0908三的模型归属与首条消息字段保留，行为不变。 */
            /* ★0927 P1-4：补 lastMessage（前端一直在读，后端此前没这字段 → 侧栏预览刷新即空） */
            lastMessage: lastMessageBrief(s),
            /* ★0927 补：msgCount —— **侧栏"空对话不进主列表"的判据**（`conversations.ts` 原本读 `s.messages.length`）。
               去掉 messages 后它恒为 0 ⇒ 刷新后侧栏把会话全过滤掉（实测：列表只剩置顶/在回复的 2 条）。
               这里给个等价的数量字段（免费的：messages 本来就要遍历算 firstMessage/lastMessage），
               既保住瘦身（47.6MB→KB 级）又不破坏侧栏规则。 */
            /* ★0927（①b）未读的权威口径：lastReadAt 之后产生了几条 AI 回复（现场算，纯读无副作用）。
               从末尾往前数、遇到旧的立刻停（不扫全量，性能友好）。
               ⚠️ 这里**只读不写**：补种只在启动加载时做一次（见 hydrateSessionsFromDisk）。
               以前在映射里补种 + schedulePersist，导致"你不在时到的回复"一拉列表就被顶成已读。 */
            unread: unreadCountOf(s),
            msgCount: Array.isArray(s.messages) ? s.messages.length : 0,
            // ★0926 链路修复②：把"在等用户应答"（权限卡/询问卡）暴露给列表 → 侧栏显示"等待你"
            awaitingUser: awaitingUserKind(s.id),
            presetId: s.presetId, permissionMode: s.permissionMode, mode: s.mode,
            teamId: s.teamId, projectId: s.projectId, plan: s.plan, pinned: !!s.pinned,
            // 0912 接入批：来源通道（前端通道弹窗按它过滤「独享对话列表」）
            origin: s.origin, originPeer: s.originPeer,
            // 0912 十九批：定时任务支线 → 前端打 ⏰ 标记 / 主列表放行 / 右键改为「放回定时任务」
            taskId: s.taskId, inMainList: s.inMainList === true,
            // ★ 0922z2b：迁入主列表的时间（前端列表排序用：刚挪进来的排最前）
            movedInAt: s.movedInAt || 0,            // 完整首条消息（对话界面标题用，比列表标题更长）
            firstMessage: stripInjectedLines((s.messages.find(m => m.role === 'user')?.content || [])
              .filter(c => c.type === 'text').map(c => c.text).join(' ').replace(/\[\[图片:\d+\]\]/g, '').trim()).slice(0, 80)  /* ★1004：剥 [记忆召回] 等注入行（同 lastMessageBrief 口径） */
          }
        }) }

    case 'session.create': {
      const session = createSession(
        p?.title as string | undefined,
        p?.workDir as string | undefined,
        p?.presetId as string | undefined,
        p?.system as string | undefined,
        p?.teamId as string | undefined,
        undefined,
        p?.projectId as string | undefined,
      )
      broadcastHost({ type: 'host/session-added', sessionId: session.id, blank: true, cwd: session.workDir ?? process.cwd() })
      return { sessionId: session.id, title: session.title, workDir: session.workDir, presetId: session.presetId, teamId: session.teamId, projectId: session.projectId }
    }

    case 'session.model': {
      // 0908三：读写会话级模型（不触发发送）。前端打开会话且本地无覆盖记录时来取权威值回填；
      // 也可显式写入（预留）。返回 {model, providerId, base}，providerId 查不到=存量未知跟随全局
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const mid = typeof p?.modelId === 'string' && p.modelId.trim() ? p.modelId.trim() : undefined
      const pid = typeof p?.providerId === 'string' && p.providerId.trim() ? p.providerId.trim() : undefined
      // 0908六：思考强度也走这条通道读写（前端 ReasoningModeBtn 变更即时落盘，按会话隔离）
      if (typeof p?.effort === 'string' && p.effort.trim()) {
        session.effort = p.effort.trim()
        schedulePersist()
      }
      if (mid) {
        /* ★0927 N3：**切换模型写入前校验**（病案：坏 id 一路静默——切的时候不校验、被持久化，直到发消息才炸）。
           口径（不硬拦手填新模型的合法用法）：
           ① 该供应商模型列表里命中 → 通过；
           ② 列表拿不准（供应商还没「获取模型」= 列表为空）→ 放行 + 留痕；
           ③ 列表有内容但没这个 id → 抛中文错（点名"哪个供应商不认它"），**不落盘**、保持旧值。
           真正"名字对不对"的终审还是在「⚡测试连通性」（它拿这个模型名真发一条 ping）。 */
        const _pid = pid || resolveModelProviderId(mid)
        const _prov = _pid ? getState().providers.find(x => x.id === _pid) : undefined
        /* ★0927 N3：显式给了 providerId 但该供应商根本不存在 → 这是**可判定**的坏值，直接拦（不静默写） */
        if (pid && !_prov) {
          throw new Error(`供应商「${pid}」不存在——没切换模型；请在「设置 → 供应商」里先加/选中它`)
        }
        const _list = (_prov?.models || [])
        const _inList = _list.some(x => x.id === mid)
        if (_list.length > 0 && !_inList) {
          const _elsewhere = getState().providers.find(x => (x.models || []).some(m => m.id === mid))
          throw new Error(`模型「${mid}」不在供应商「${_prov?.name || _pid}」的模型列表里${_elsewhere ? `（它在「${_elsewhere.name || _elsewhere.id}」下）` : ''}——没切换，仍是「${session.model}」；可点「获取模型」看清单或先测连通性`)
        }
        if (_list.length === 0) console.warn(`[session.model] 供应商「${_pid || '(未知)'}」模型列表为空 → 无法本地校验「${mid}」，放行（建议先点「获取模型」/「测试连通性」）`)
        session.model = mid
        session.modelProviderId = pid || resolveModelProviderId(mid) || undefined
        schedulePersist()
      }
      const resolved = resolveModelProviderId(session.model, session.modelProviderId)
      const prov = resolved ? getState().providers.find(x => x.id === resolved) : undefined
      return { model: session.model, providerId: resolved || undefined, base: prov?.base || '', effort: session.effort || '' }
    }

    case 'session.configure': {
      // 会话配置同步（预设/系统提示/团队绑定）。自愈语义：前端每次发送前都会同步 teamId，
      // 后端【无变化时 no-op 不重建 agent】；有变化才重建（重建前快照 live 消息，防上下文丢失）
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const presetId = p?.presetId as string | undefined
      const system = p?.system as string | undefined
      // 空白守卫（后端是权威）：预设/系统提示仅空白会话可改——前端刷新后消息未加载会误判空白，
      // 曾把团队会话的 presetId 覆盖成 standard（"测试1/2 变标准模式"根因）
      const sessionBlank = (session.messages?.length || 0) === 0 && !(session.transcript?.length)
      const newPreset = (presetId?.trim() && sessionBlank) ? presetId.trim() : session.presetId
      const newSystem = (system?.trim() && sessionBlank) ? system.trim() : session.system
      // 团队绑定：空串=解绑；未传=保持现状
      const newTeam = p?.teamId !== undefined ? (String(p.teamId || '').trim() || undefined) : session.teamId
      const changed = newPreset !== session.presetId || newSystem !== session.system || newTeam !== session.teamId
      if (newPreset !== session.presetId) session.presetBy = 'user'   // 二十一批：PC 明确选过 → 通道配置不再覆盖
      session.presetId = newPreset
      session.system = newSystem
      session.teamId = newTeam
      if (changed && agents.has(sessionId)) {
        // 重建前快照 live 消息到 transcript（对齐 session.cancel 语义；团队工具装配变化后上下文连续）
        try {
          const live = agents.get(sessionId)?.state.messages
          if (Array.isArray(live) && live.length > (session.transcript?.length || 0)) {
            session.transcript = JSON.parse(JSON.stringify(live))
          }
        } catch (e) { swallowed('团队重建前的 live→transcript 快照失败（上下文可能丢失）', e) }
        /* ★0929 P0 同款：重建前先 abort 旧 agent —— 只 delete 不 abort 会让旧 agent
           僵尸续跑（工具照执行/审批卡照弹），与新 agent 并发写同一会话。 */
        try { (agents.get(sessionId) as any)?.abort?.() } catch { /* ignore */ }
        agents.delete(sessionId)
        turnAccumulators.delete(sessionId)
        /* ★0927 R14：切换预设=丢旧 agent，挂起的询问卡一并解除 */
        clearPendingQuestions(sessionId)
        schedulePersist()
      }
      return { ok: true, presetId: session.presetId, teamId: session.teamId }
    }

    /* ★0930 性能（治"切回长会话加载慢"）：版本号对账 —— 前端打开会话先问一次 rev，
       与上次已应用的 rev 一致就跳过 session.history 全量拉取 + 前端对账重建。
       口径刻意保守（宁可多拉一次，不许看旧内容）：覆盖影响视图的全部状态
       （消息数/末条时间/运行态/updatedAt/轮次元数据/压缩/计划/挂起询问卡与审批卡），
       任何一项变化都会变 rev ⇒ 自动回全量路径（与不开本优化时行为一致）。 */
    case 'session.rev': {
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const live = agents.get(sessionId)?.state.messages
      const msgs: any[] = Array.isArray(live) && live.length > 0 ? live
        : (Array.isArray(session.transcript) && session.transcript.length > 0 ? session.transcript : (session.messages || []))
      const last: any = msgs[msgs.length - 1]
      let approvals = 0
      for (const [, pa] of pendingApprovals) if (pa.sessionId === sessionId) approvals++
      return {
        rev: [
          msgs.length,
          Number(last?.timestamp || 0),
          String(session.status || ''),
          Number((session as any).updatedAt || 0),
          (session.turnMetas || []).length,
          (session.contextSummaries || []).length,
          JSON.stringify(session.plan || []),
          JSON.stringify(session.boardPlan || []),
          pendingFor(sessionId).length,
          approvals,
        ].join('|'),
      }
    }

    /* ★1001 外部 agent 可拆装安装器（类似"软件环境"）：清单/安装/卸装 */
    case 'externalAgents.list': {
      return { agents: listExternalAgents() }
    }
    case 'externalAgents.install': {
      return startInstall(String((p as any)?.id || ''))
    }
    case 'externalAgents.uninstall': {
      return uninstallExternalAgent(String((p as any)?.id || ''))
    }
    /* ★1001二批："用它的 API"档的两种凭据入口 */
    case 'externalAgents.login': {
      return startLogin(String((p as any)?.id || ''))   // spawn 它自己的 OAuth 登录（浏览器自动弹）
    }
    case 'externalAgents.setKey': {
      return setExternalKey(String((p as any)?.id || ''), String((p as any)?.key || ''))
    }
    case 'externalAgents.listModels': {
      return await listModels(String((p as any)?.id || ''), ((p as any)?.mode === 'key' ? 'key' : 'login'))
    }
    case 'externalAgents.quota': {
      return await fetchQuota(String((p as any)?.id || ''))   // ★1001 六批：实时官方额度（尽力而为）
    }

    case 'session.history': {
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      // 0908三①：运行中轮次的"未决工具"清单——toolCall 已进 transcript（message_end 先于 tool 执行），
      // 但 tool_execution_end 还没到（fs_write 正在写/审批挂起/并行批未齐）。前端据此恢复 running 态
      //（loadHistory 历史数据无此信息一律标 done，就是"正在写入块刷新后消失"的正身）。
      // 权威口径=turnAccumulator.sequence（tool_execution_start 推 tool_use、end 推 tool_result，
      // 与 live UI 的事件节拍一一对应；并行批里先完成的 plan_write 有 result → 不再误标 running）。
      // agent._state 只作补充（累积器不在时扫已落 toolResult 消息；DSH 兜底分支用内嵌 result 块口径）。
      const runningToolsFor = (msgs: any[]): string[] => {
        if (session.status !== 'running') return []
        const callIds = new Set<string>()
        const resultIds = new Set<string>()
        const turn = turnAccumulators.get(sessionId)
        if (turn) {
          for (const item of turn.sequence) {
            if (item.type !== 'tool') continue
            for (const b of item.blocks) {
              if (b.type === 'tool_use' && b.id) callIds.add(String(b.id))
              if (b.type === 'tool_result' && b.toolUseId) resultIds.add(String(b.toolUseId))
            }
          }
        }
        // 消息级补充（覆盖 message_end 已落但 tool_execution_start 未推的毫秒缝隙；
        // DSH 兜底分支没有 turn 时也走这条）：最后一条 assistant 的 toolCall ids
        let asstIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'assistant') { asstIdx = i; break }
        if (asstIdx >= 0 && Array.isArray(msgs[asstIdx]?.content)) {
          for (const c of msgs[asstIdx].content) {
            if ((c?.type === 'toolCall' || c?.type === 'tool_use') && c.id) callIds.add(String(c.id))
          }
          for (let i = asstIdx; i < msgs.length; i++) {
            const m: any = msgs[i]
            if (m?.role === 'toolResult' && m.toolCallId) resultIds.add(String(m.toolCallId))
            if (Array.isArray(m?.content)) for (const c of m.content) if (c?.type === 'tool_result' && c.toolUseId) resultIds.add(String(c.toolUseId))
          }
        }
        return Array.from(callIds).filter(id => !resultIds.has(id))
      }
      /** 挂起审批卡快照（与询问卡 pendingFor 同款恢复语义：requestId 不变，刷新后仍能应答） */
      const approvalsFor = (sid: string) => Array.from(pendingApprovals.entries())
        .filter(([, pa]) => pa.sessionId === sid)
        .map(([requestId, pa]) => ({ requestId, question: pa.question, tool: pa.tool, risk: pa.risk, options: pa.options }))
      /* ★ 0922z（用户指派）：长对话分批加载 —— 只回最后 N 轮（不传 = 全量，旧前端零改动兼容）。
         · limitTurns      ：只回最后 N 轮
         · beforeTurnIndex ：只回"第 N 轮之前"的 limitTurns 轮（前端上滑取更早用）
         "轮" = 一条 user 消息开启一轮，与 session.deleteTurn 的 turnIndex 口径一致（1 基）。
         ⚠️ 必须在**完整装配之后**调用：上面已把思考块按轮次回填、turnMeta 按 ts 挂好，
            若先切片再回填，思考块会整体错位到别的轮次（真坑，别省这一步）。
         返回给前端的额外字段：totalTurns / firstTurn / hasMore（前端据此决定还能不能上滑）。 */
      const pageHistory = (msgs: any[]) => {
        const limit = Number(p?.limitTurns) > 0 ? Math.floor(Number(p.limitTurns)) : 0
        const before = Number(p?.beforeTurnIndex) > 0 ? Math.floor(Number(p.beforeTurnIndex)) : 0
        /* ★ 0922z2c（反馈）：轮次口径 = **真实用户轮** —— 跳过注入类 user 消息。
           为什么：前端把注入消息渲染成 notice 分隔（不算用户气泡），session.deleteTurn 定位
           turnIndex 时也跳过它们（"它不是用户轮，不入轮次计数"）—— 这里必须同口径，
           否则统计会显示"共 13 轮（8 真实 + 5 注入）"、切片边界也和删除口径打架。
           注入前缀与前端 piChat 的 INJECTED_USER_PREFIXES 保持一致。 */
        /* ★1003 修复 4.73：改用统一口径 helper（isInjectedUserMsg），与 deleteTurn/memberPrompt 归一 */
        const isInjectedUser = isInjectedUserMsg
        const userAt: number[] = []
        for (let i = 0; i < msgs.length; i++) if (msgs[i]?.role === 'user' && !isInjectedUser(msgs[i])) userAt.push(i)
        const totalTurns = userAt.length
        /* ★ 0922z2c（反馈）：统计要**整段对话**口径 —— 前端原先只数"已加载的节点"，
           分批加载后长会话首屏会偏小（实测：72 轮会话首屏只显示 20 轮）。顺手把全量计数回给前端。
           口径与前端 ChatInterface 的 statsTurns/statsSteps/statsToolCalls 严格对齐：
             replies   = 有正文或思考的 assistant 消息
             toolCalls = assistant 消息里的 toolCall 块（排除 ask_user） */
        let totalReplies = 0
        let totalToolCalls = 0
        for (const m of msgs) {
          if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
          let hasBody = false
          for (const c of m.content) {
            const ty = c?.type
            if (ty === 'toolCall' || ty === 'tool_use') {
              if (String(c?.name || '') !== 'ask_user') totalToolCalls++
            } else if ((ty === 'text' || ty === 'reasoning') && String(c?.text || '').trim()) {
              hasBody = true
            }
          }
          if (hasBody) totalReplies++
        }
        if (!limit && !before) return { messages: msgs, totalTurns, totalReplies, totalToolCalls, firstTurn: 1, hasMore: false, startIndex: 0 }
        const lastTurn = before > 0 ? Math.min(before - 1, totalTurns) : totalTurns
        // 要的是"第 1 轮之前" → 什么都没有（别回一条切到开头的残片）
        // 只拦"要更早"的请求：没有任何 user 轮次的会话（纯 system）仍应原样回
        if (before > 0 && lastTurn < 1) return { messages: [], totalTurns, totalReplies, totalToolCalls, firstTurn: 1, hasMore: false, startIndex: 0 }
        const span = limit || totalTurns
        const firstTurn = Math.max(1, lastTurn - span + 1)
        // firstTurn=1 时从 index 0 起：保留 transcript 开头的非 user 消息（system 头/注入的前言），
        // 否则 limitTurns 大于总轮数那一次会把它们切掉（单测 6 号用例实测踩到）。
        const startMsg = firstTurn <= 1 ? 0 : (userAt[firstTurn - 1] ?? 0)
        const endMsg = lastTurn < totalTurns ? userAt[lastTurn] : msgs.length
        return { messages: msgs.slice(startMsg, endMsg), totalTurns, totalReplies, totalToolCalls, firstTurn, hasMore: firstTurn > 1, startIndex: startMsg }
      }

      // 返回 pi 格式 transcript（实时 agent 状态优先，其次持久化快照；无则回退 DSH 累积）。
      // pi 消息本身不带 reasoning，从 DSH 累积消息（agent_end 落库含思考块）按轮次顺序回填，
      // 保证刷新/重启后历史仍显示 Think 块。
      const agent = agents.get(sessionId)
      const live = agent?.state.messages
      /* ★0929 性能修复（实测"卡思考态/权限卡不弹，刷新才恢复"的根因之一）：
         这里原来是 JSON.parse(JSON.stringify(live)) 整份深拷贝 —— 大会话（1100+ 条、含内嵌图片
         dataURL）每次 session.history（刷新/切会话/对账/重连补账都在调）都要在主线程上整份
         stringify+parse，秒级阻塞事件循环 ⇒ 同一时间全会话的实时帧（thinking/text 增量、
         hitl 权限卡）集体迟到。
         深拷贝的目的只是"装配改动不写回 agent 活状态"，而下方装配段只做**顶层属性赋值 /
         content 数组整体替换**（_turnMeta、subRuns、content 重排），从不原地改嵌套对象 ⇒
         顶层隔离的浅拷贝（map spread）即可达到同样效果，代价从秒级降到毫秒级。
         ⚠️ 若日后装配段开始**原地**改 content 内部，必须回到深拷贝（会污染 agent 活状态）。 */
      const transcript = Array.isArray(live) && live.length > 0 ? (live.map((m: any) => ({ ...m })) as any[]) : session.transcript
      if (Array.isArray(transcript) && transcript.length > 0) {
        // 团队兜底：agent_end 未到（成员还在跑/刚派发完）时 transcript 没有 subRuns——
        // 从黑板 runs 兜底注入，成员气泡中途刷新不丢
        injectSubRuns(transcript, sessionId)
        // turn 元数据挂载（写时补全的读出口）：按 ts 锚点把 timing/usage 挂到 assistant 消息
        // 的 _turnMeta，前端 loadHistory 直读渲染——刷新后统计条完整恢复，读侧零推断
        if (Array.isArray(session.turnMetas) && session.turnMetas.length > 0) {
          const byTs = new Map<number, { timing?: unknown; usage?: unknown }>()
          for (const t of session.turnMetas) byTs.set(Number(t.ts), t)
          for (const m of transcript) {
            if (m?.role !== 'assistant') continue
            const hit = byTs.get(Number(m.timestamp))
            if (hit) (m as any)._turnMeta = { timing: hit.timing, usage: hit.usage }
          }
        }
        // DSH 消息的 reasoning 按 assistant 轮次顺序提取（每轮一条 DSH 消息，内含多个段落思考）
        const reasonings = session.messages
          .filter(m => m.role === 'assistant')
          /* ★1005：原来 filter+map 分两步 ⇒ TS 不会把元素类型收窄（map 里 c 仍是 ContentBlock 联合）
             ⇒ 报"ContentBlock 上没有 text"。用**类型谓词**把意图写出来：只要 reasoning 且有 text 的块。
             运行行为与原来完全一致（filter 已经滤掉了其它类型）。 */
          .flatMap(m => (m.content || [])
            .filter((c): c is { type: 'reasoning'; text: string } => c.type === 'reasoning' && !!c.text)
            .map(c => c.text))
        // transcript 的 assistant 消息与轮次一一对应（含 toolCall 轮），逐个注入
        let ri = 0
        for (const m of transcript) {
          if (m.role === 'assistant' && Array.isArray(m.content) && !m.content.some(c => c.type === 'thinking' || c.type === 'reasoning')) {
            if (ri < reasonings.length) {
              m.content = [{ type: 'thinking', thinking: reasonings[ri] }, ...m.content]
              ri += 1
            }
          }
        }
        const _pgT = pageHistory(transcript)
        return { messages: _pgT.messages, totalTurns: _pgT.totalTurns, firstTurn: _pgT.firstTurn, hasMore: _pgT.hasMore, startIndex: _pgT.startIndex, totalReplies: _pgT.totalReplies, totalToolCalls: _pgT.totalToolCalls, pendingQuestions: pendingFor(sessionId), plan: session.plan || [], boardPlan: session.boardPlan || [], compactions: session.contextSummaries || [],
          /* ★1010 P0：外部流回放 —— 有 extTranscript 的会话前端走外部流渲染分支（契约：优先 extTranscript，
             无则走 messages 的 pi transcript 路径，两路并存） */
          /* ★1010 P0：外部流回放 —— **只在真有 extTranscript 时才带该字段**（契约：有则前端走外部流渲染分支，
             无则走 messages 的 pi transcript 路径，两路并存）。
             ★1005 修复（实测反馈「重启后端后对话内容直接不显示」）：原来恒输出 `|| []` —— **空数组同样是
             "字段存在"**，而前端 seedFromHistory 只判 `Array.isArray` ⇒ 普通会话被误判成外部会话：
             渲染切走 ExternalStream(0 段)=整窗空白，且 live agent-event 被丢（对话变哑）。 */
          ...(Array.isArray((session as any).extTranscript) && (session as any).extTranscript.length > 0
            ? { extTranscript: (session as any).extTranscript }
            : {}),
          runningTools: runningToolsFor(transcript), pendingApprovals: approvalsFor(sessionId) }
      }
      const _pgD = pageHistory(session.messages)
      return { messages: _pgD.messages, totalTurns: _pgD.totalTurns, firstTurn: _pgD.firstTurn, hasMore: _pgD.hasMore, startIndex: _pgD.startIndex, totalReplies: _pgD.totalReplies, totalToolCalls: _pgD.totalToolCalls, pendingQuestions: pendingFor(sessionId), plan: session.plan || [], boardPlan: session.boardPlan || [],
        /* ★1005 契约对齐（与上方 transcript 分支同口径）：**本分支原来完全不带 extTranscript** ——
           而它的门槛是 transcript 为空，纯外部会话（pi transcript 为空、只有 extTranscript）正好落在这里
           ⇒ 前端拿不到回放源 ⇒ 刷新后外部会话渲染不出来（1005 修的那个白屏的"镜像"缺口）。
           两支必须一致：**非空才带该字段**。 */
        ...(Array.isArray((session as any).extTranscript) && (session as any).extTranscript.length > 0
          ? { extTranscript: (session as any).extTranscript }
          : {}),
        runningTools: runningToolsFor(session.messages), pendingApprovals: approvalsFor(sessionId) }
    }

    case 'session.prompt': {
      if (!sessionId) throw new Error('sessionId required')
      if (!p?.message) throw new Error('message required')
      /* ★ 0923：用户亲自发话 = 新一轮工作 → 续跑额度重置、解除暂停
         （语义：每次用户交互重新给一整份额度，免得一条会话聊久了永久卡在上限） */
      if (sessionId) resetBgResumeChain(sessionId)
      // 0909⑦：队列自动续发统一挂在 agent_end 的 waitForIdle 回调（唯一触发点，防双 flush 竞态）；
      // 手动发送路径不再重复 flush——flush 那条自己结束时同样会经 agent_end→waitForIdle 链式续发。
      return await runPromptCore(sessionId, p as Record<string, unknown>)
    }

    // ── 0909⑦ 排队消息（队列）RPC：账本在后端（重启不丢/多窗口同一份），前端只做镜像渲染 ──
    case 'session.queue': {
      if (!sessionId) throw new Error('sessionId required')
      if (!sessions.get(sessionId)) throw new Error('session not found')
      return { queue: queueSnapshot(sessionId), paused: queuePaused.has(sessionId), mode: cancelQueueMode() }
    }

    /* ★0927 N1：乙（暂停）用的"继续发送"。清暂停态 + 立刻触发一次续发（幂等，空闲时会自己排空）。 */
    case 'session.queue.resume': {
      if (!sessionId) throw new Error('sessionId required')
      if (!sessions.get(sessionId)) throw new Error('session not found')
      queuePaused.delete(sessionId)
      broadcastQueue(sessionId)
      sessionLog(sessionId, 'info', 'lifecycle', '用户点「继续发送」→ 队列恢复', { guard: 'queue-resume' })
      flushNextQueued(sessionId)
      return { ok: true, queue: queueSnapshot(sessionId), paused: false }
    }

    /* ★0927 N1：撤回编辑（批量版丙）——把队列内容交还前端编辑器，后端清队。前端按返回的 items 回灌。 */
    case 'session.queue.purge': {
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (!s) throw new Error('session not found')
      const items = (s.queuedMessages || []).splice(0, (s.queuedMessages || []).length)
      queuePaused.delete(sessionId)
      schedulePersist(sessionId)
      broadcastQueue(sessionId)
      sessionLog(sessionId, 'info', 'lifecycle', `队列撤回编辑：${items.length} 条交还编辑器`, { guard: 'queue-purge' })
      return { ok: true, items }
    }

    case 'session.queue.add': {
      if (!sessionId) throw new Error('sessionId required')
      const text = String(p?.message ?? p?.text ?? '').trim()
      if (!text) throw new Error('message required')
      const item: QueuedMsg = {
        id: String(p?.clientMessageId || crypto.randomUUID()),
        text,
        attachments: Array.isArray(p?.attachments) ? p.attachments as QueuedMsg['attachments'] : undefined,
        skills: Array.isArray(p?.skills) ? (p.skills as string[]) : undefined,
        model: p?.model as QueuedMsg['model'],
        effort: typeof p?.effort === 'string' && p.effort ? p.effort : undefined,
        createdAt: Date.now(),
      }
      const err = queuePush(sessionId, item)
      if (err) throw new Error(err)
      /* ★0927 N1：暂停态(乙)下用户又主动发话 = 他想动起来 → 自动恢复 continue（结果里如实说明） */
      const wasPaused = queuePaused.has(sessionId)
      if (wasPaused) {
        queuePaused.delete(sessionId)
        sessionLog(sessionId, 'info', 'lifecycle', '暂停态下用户又入队 → 自动恢复 continue', { guard: 'queue-auto-resume' })
      }
      // 空闲时入队=立即续发（flush 闸门自会判忙/审批/防重入；覆盖"AI 恰好刚结束才点发送"的间隙态）
      flushNextQueued(sessionId)
      return { ok: true, queue: queueSnapshot(sessionId), paused: false, autoResumed: wasPaused, ...queuePosOf(sessionId, item.id) }
    }

    case 'session.queue.update': {
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (!s?.queuedMessages) return { ok: true, queue: [] }
      const qid = String(p?.id || '')
      const it = s.queuedMessages.find(q => q.id === qid)
      if (!it) throw new Error('排队消息不存在（可能已被发出或删除）')
      if (typeof p?.text === 'string' && p.text.trim()) it.text = p.text.trim()
      if (Array.isArray(p?.attachments)) it.attachments = p.attachments as QueuedMsg['attachments']
      schedulePersist()
      broadcastQueue(sessionId)
      return { ok: true, queue: queueSnapshot(sessionId) }
    }

    case 'session.queue.remove': {
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (s?.queuedMessages) {
        s.queuedMessages = s.queuedMessages.filter(q => q.id !== String(p?.id || ''))
        schedulePersist()
        broadcastQueue(sessionId)
      }
      return { ok: true, queue: s?.queuedMessages || [] }
    }

    case 'session.queue.move': {
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (!s?.queuedMessages) return { ok: true, queue: [] }
      const from = s.queuedMessages.findIndex(q => q.id === String(p?.id || ''))
      const to = Number(p?.to)
      if (from < 0 || !Number.isInteger(to) || to < 0 || to >= s.queuedMessages.length) throw new Error('移动位置非法')
      const [it] = s.queuedMessages.splice(from, 1)
      s.queuedMessages.splice(to, 0, it)
      schedulePersist()
      broadcastQueue(sessionId)
      return { ok: true, queue: s.queuedMessages }
    }

    // ── 0909⑦ 插话（steering）RPC：接 pi 原生队列，注入点=当前轮工具批次跑完、下次 LLM 调用前。
    //    agent 空闲 → {steered:false}，前端降级为普通发送/入队（消灭 turn 竞态，防坑 7）。 ──
    case 'session.steer': {
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (!s) throw new Error('session not found')
      const text = String(p?.message ?? '').trim()
      if (!text) throw new Error('message required')
      const kind = p?.kind === 'followUp' ? 'followUp' : 'steer'
      const agent = agents.get(sessionId)
      const streaming = !!agent && (agent as any).state?.isStreaming
      if (!streaming) return { steered: false, reason: 'idle' }
      // 附件 vision 闸门口径与 runPromptCore 一致（入队/插话时校验，失败即时退回，不等 flush 静默丢，防坑 9）
      const atts = Array.isArray(p?.attachments) ? p.attachments as Array<{ name: string; dataUrl: string }> : []
      if (atts.length > 0) {
        const _ov = s.llmOverride
        const _pid = _ov?.providerId || currentLlmConfig().providerId
        const _mid = _ov?.model || currentLlmConfig().model
        if (!resolveModelCaps(_pid, _mid).vision) throw new Error(`模型「${_mid}」不支持图片输入，请移除图片后重试`)
      }
      const content: any[] = [{ type: 'text', text }]
      for (const a of atts) {
        const mm = /^data:(.+?);base64,(.+)$/.exec(String(a?.dataUrl || ''))
        if (mm) content.push({ type: 'image', data: mm[2], mimeType: mm[1] })
      }
      const msg: any = { role: 'user', content, timestamp: Date.now() }
      if (kind === 'followUp') agent!.followUp(msg); else agent!.steer(msg)
      sessionLog(sessionId, 'info', 'lifecycle', `用户插话（${kind}）：${text.slice(0, 40)}`)
      // 前端乐观气泡对账：注入时 pi 天然发 message_start（user）→ piChat 渲染真实气泡；
      // 这里回传 clientMessageId 让前端把"插话中"占位转正（防坑 8：显示态以服务端事件为准）
      try {
        broadcastMux(sessionId, { type: 'session/projection', sessionId, key: 'steer-ack', seq: Date.now(), value: { clientMessageId: String(p?.clientMessageId || '') } })
      } catch { /* ignore */ }
      return { steered: true, kind }
    }

    // ── 成员单聊（0904 批次）：用户 @某团队成员 1:1 对话，不经主 agent、不进 team_dispatch、不动黑板 ──
    //   严格校验：绑定团队 + 成员属于该团队 + 预设合法 + 有合法工作区（缺失直接拒，不回退 process.cwd）。
    //   执行 fire-and-await（与 session.prompt 同款阻塞语义，校验错误同步抛出；成员过程走 subagent-event 流）
    case 'session.memberPrompt': {
      const sid = sessionId || String(p?.sessionId || '')
      if (!sid) throw new Error('sessionId required')
      const s = sessions.get(sid)
      if (!s) throw new Error('session not found')
      const message = String(p?.message || '').trim()
      if (!message) throw new Error('message required')
      const memberId = String(p?.memberId || '').trim()
      if (!memberId) throw new Error('memberId required')
      if (!s.teamId) throw new Error('当前会话未绑定团队，无法与成员单聊')
      const teamDef = readTeam(s.teamId)
      if (!teamDef) throw new Error('团队不存在或已被删除')
      const member = teamDef.members.find(m => m.id === memberId)
      if (!member) throw new Error(`成员不存在：${memberId}`)
      if (!readAgentPreset(member.preset)) throw new Error(`成员预设不存在：${member.preset}`)
      const wd = s.workDir?.trim()
      if (!wd || !fs.existsSync(wd)) throw new Error('会话缺少合法工作区，无法单聊（成员需在工作区内读写）')
      // 时间线锚点：当前主会话用户轮数 → 刷新恢复时把单聊气泡插到第 N 个用户气泡之后
      // ★1003 修复 4.73：注入消息不计入 user 轮数（与 pageHistory/deleteTurn 统一口径），
      // 否则锚点偏移、刷新后单聊气泡插错位置
      const afterTurns = Array.isArray(s.transcript)
        ? s.transcript.filter((m: any) => m?.role === 'user' && !isInjectedUserMsg(m)).length
        : (s.messages || []).filter(m => m.role === 'user' && !isInjectedUserMsg(m)).length
      const teamCtx = buildTeamCtx(sid, teamDef)
      sessionLog(sid, 'info', 'session', `[单聊] 用户 @${memberId}：${message.slice(0, 60)}`)
      // 新轮开始：作废旧在途轮（同成员快速重发），并登记本会话存活检查由 initTeams 后一次性注入
      bumpMemberDmGeneration(sid, memberId)
      abortMemberDm(sid, memberId)
      const r = await runMemberChat(teamCtx, { sessionId: sid, memberId, message, afterTurns })
      return { ok: r.ok, runId: r.runId }
    }

    // ── 成员单聊记录快照（前端刷新恢复气泡）：返回各成员的单聊 run 列表 ──
    case 'session.memberChats': {
      const sid = sessionId || String(p?.sessionId || '')
      if (!sid) throw new Error('sessionId required')
      if (!sessions.get(sid)) throw new Error('session not found')
      return { chats: memberChatsSnapshot(sid) }
    }

    case 'session.models': {
      const cfg = currentLlmConfig()
      return { models: [{ id: cfg.model, name: cfg.model, contextWindow: 0, maxTokens: 0 }] }
    }

    case 'session.context': {
      // 上下文占用：优先用 LLM 上报的真实 usage（最后一次请求的完整上下文 token），
      // 无 usage 时回退 transcript 字符估算
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      // 0909③：窗口隔离——圆环口径=本会话实际模型（llmOverride/session.model 优先），
      // 旧版恒用 currentLlmConfig() 全局模型：A 窗口选 b.ai、全局是 agnes 时，maxContext 读错表，
      // 百分比/上限显示与真实发送的模型不一致。
      /* ★ 0923：经 resolveSessionLlm 统一解析（llmOverride > session.model 持久化选择 > 全局）。
         旧代码 llmOverride 为 null 时裸奔全局 —— 另一窗口切模型后本会话圆环上限/压缩线全算错（实录 1M 变 524K） */
      const _sessLlm = resolveSessionLlm(sessionId)
      const cfg = _sessLlm
        ? { providerId: _sessLlm.providerId, model: _sessLlm.model, base: _sessLlm.base, apiKey: _sessLlm.apiKey, providerName: _sessLlm.providerName }
        : currentLlmConfig()
      /* 0921：窗口口径**统一走 providers.ts 的 resolveContextWindow**
         （用户 maxContext > models.dev limit.context > 128000；两边都有时取小的）。
         原来这里维护了一份"已知型号清单"当第二真相 —— 它可能给出跟压缩/发送预算**不一样**的窗口，
         于是出现"圆环说还剩很多、压缩却没触发/请求却被拒"的自相矛盾。单一真相后不会再漂。 */
      const maxTokens = resolveContextWindow(_sessLlm?.providerId || cfg.providerId, _sessLlm?.model || cfg.model)
      // 完整上下文口径：promptTokens 是未命中缓存的部分（LongCat/DeepSeek 缓存命中后极小），
      // 完整上下文 = promptTokens + cacheReadTokens + cacheWriteTokens（否则命中缓存后圆环骤降到接近 0）
      let usedTokens = session.lastUsage
        ? (session.lastUsage.promptTokens || 0) + (session.lastUsage.cacheReadTokens || 0) + (session.lastUsage.cacheWriteTokens || 0)
        : undefined
      if (!usedTokens) usedTokens = undefined
      let fromUsage = true
      if (usedTokens == null || usedTokens <= 0) {
        // fallback：transcript 字符估算（中文 token ≈ 字符数/1.5，英文 ≈ /4；混合 /2.2）
        // ★ 0921 修：改用 ctxMsgChars（已补认 reasoning/tool_use/tool_result/image）——
        //   原实现只取 b.text/b.thinking/b.content，导入会话（anthropic 块名）会被算成几十分之一。
        const transcript = (session.transcript as any[]) || session.messages || []
        let chars = 0
        if (session.system) chars += session.system.length
        for (const m of transcript) chars += ctxMsgChars(m)
        usedTokens = Math.round(chars / 2.2)
        fromUsage = false
      }
      // 1M 级上下文的模型（LongCat-2.0 等）轮次再多百分比也远小于 1%，保留 1 位小数避免恒为 0%
      /* ★ 0923：圆环优先用"判定同源值"（压缩判定算出的占用）—— 两者必须同一口径，
         否则又会出现"圆环显示 30% 却触发压缩"的困惑。判定尚未跑过（新会话首轮）时才用原值。 */
      /* 0928 T4c B2: ring/judged consumption keeps an override fallback -- anchor fields are not
         always written together (legacy/persisted sessions may carry only ctxUsedOverride). */
      { const _ringUsed = Number((session as any)?.ctxUsedForRing) || Number((session as any)?.ctxUsedOverride?.tokens) || 0; if (_ringUsed > 0) usedTokens = _ringUsed }
      const percent = Math.min(100, Math.round(usedTokens / maxTokens * 1000) / 10)
      // turn 计时（TTFT/耗时）
      const timing = session.lastTurnTiming
      // 无真实 usage（重启/新会话）时返回 null，前端据此保留已有数据而不是被全零覆盖
      const lastUsage = session.lastUsage || {}
      const hasUsage = !!(lastUsage.promptTokens || lastUsage.completionTokens || lastUsage.cacheReadTokens || lastUsage.cacheWriteTokens)
      /* 0928 T4c B2 mask: while a post-compaction anchor is active the stored lastUsage is the
         PRE-compaction bill (agent_end retires the anchor the moment a post-compaction bill
         arrives). Serving it would flood the ring back to the pre-compact level on any plain
         refreshContextUsage() (remount / abort / multi-window). Return null instead -> the
         frontend falls back to the judged value (usedTokens above). */
      const _staleUsageM = Number((session as any)?.ctxUsedOverride?.at) > 0
      return {
        usedTokens,
        maxTokens,
        percent,
        fromUsage,
        usage: hasUsage && !_staleUsageM
          ? {
              promptTokens: lastUsage.promptTokens ?? 0,
              completionTokens: lastUsage.completionTokens ?? 0,
              cacheReadTokens: lastUsage.cacheReadTokens ?? 0,
              cacheWriteTokens: lastUsage.cacheWriteTokens ?? 0,
            }
          : null,
        timing,
        breakdown: session.contextBreakdown || null,
        modelUsage: session.modelUsage || {},
        usedModels: session.usedModels || [],
        /* ★ 0921m（用户需求）：
           ① 累计视角 —— 本会话真实 usage 合计（★ 0924 起读 usageTotals 单调账本：每轮全跳求和 ≡ 账单；压缩/换模型不清零、删轮/重跑不回退）；
           ② 缓存命中自检锚点 —— 上一轮的"完整输入"（prompt+cacheRead+cacheWrite）：
              正常缓存工作时，本轮 cacheRead ≈ 上一轮完整输入，用户据此判断命中率是不是真的；
           ③ 压缩计数 —— 每次压缩都会往 contextSummaries push 一条，这里回传次数 + 最近一次明细。 */
        usageTotals: session.usageTotals || deriveUsageTotalsFromTranscript((session.transcript as any[]) || []),
        prevPromptTokens: (() => {
          const tms = (session.turnMetas || []) as any[]
          const prev = tms.length >= 2 ? tms[tms.length - 2]?.usage : null
          return prev ? (Number(prev.promptTokens) || 0) + (Number(prev.cacheReadTokens) || 0) + (Number(prev.cacheWriteTokens) || 0) : 0
        })(),
        compactionCount: Array.isArray(session.contextSummaries) ? session.contextSummaries.length : 0,
        lastCompaction: (() => {
          const cs = (session.contextSummaries || []) as any[]
          const last = cs[cs.length - 1]
          return last ? { folded: Number(last.folded) || 0, at: Number(last.at) || 0 } : null
        })(),
      }
    }

    /* ★ 0925i（需求的两个快捷指令，前端 QuickCommands 直接调）：
       ① session.compactNow —— 点一下手动压缩上下文（不等阈值）：保留最近 keepPercent% 轮（默认 25），
          更早的折成摘要 + 全量存档导出；与自动压缩（C3）同一套字段/通知/幂等语义。
       ② session.exportTranscript —— 点一下把对话全量保存到工作区 transcripts/（覆盖式=最新全文）。 */
    case 'session.compactNow': {
      const cs = sessions.get(String(p?.sessionId || sessionId || ''))
      if (!cs) throw new Error('会话不存在')
      const all: any[] = Array.isArray(cs.messages) ? cs.messages : []
      if (all.length < 4) throw new Error(`消息太少（${all.length} 条），无需压缩`)
      /* 模型配置与请求期同源：会话级 llmOverride 优先，否则全局（10281 单一真相教训） */
      /* ★1003 安全批 4.74：这里原来直接取 **cs.llmOverride 本体引用**，下面把明文 apiKey 写回
         `clCfg.apiKey` 就是把明文写进会话对象本体 —— 任何全量序列化/广播兜底一失效就泄密。
         改为局部副本解密，原对象（含 llmOverride）永远不碰。 */
      const _ov = (cs as any).llmOverride
      const clCfg: any = (_ov && _ov.base && _ov.model) ? { ..._ov } : resolveLlmCfg()
      /* ★ 1001：llmOverride 可能是历史版本写进去的密文（本进程内残留），手动压缩的摘要请求
         同样不能把密文发出去 —— 这里兜一次自愈（只改局部副本）。*/
      if (isEncrypted(clCfg?.apiKey)) {
        try { clCfg.apiKey = plainKeyById(String(clCfg.providerId || '')) } catch (e) {
          sessionLog(cs.id, 'warn', 'llm', `压缩请求密钥解密失败（${String((e as any)?.message || e).slice(0, 120)}）`)
        }
      }
      const keepPct = Math.max(5, Math.min(80, Number(p?.keepPercent) || 25))
      /* 与自动压缩同款：切割只落在 role==='user' 边界，保留最近约 keepPct%（手动档用裸估算，够用） */
      const turnStarts: number[] = []
      all.forEach((m, i) => { if (m?.role === 'user') turnStarts.push(i) })
      let keepFrom = 0
      if (turnStarts.length > 1) {
        const cwin = resolveContextWindow(clCfg.providerId, clCfg.model)
        const retainBudget = Math.max(8000, Math.round(cwin * (keepPct / 100)))
        let tail = 0
        for (let k = turnStarts.length - 1; k >= 0; k--) {
          const end = k + 1 < turnStarts.length ? turnStarts[k + 1] : all.length
          let seg = 0
          for (let i = turnStarts[k]; i < end; i++) seg += estimateMsgTokens(all[i])
          if (tail + seg > retainBudget) { keepFrom = turnStarts[k + 1] ?? turnStarts[k]; break }
          tail += seg
        }
      }
      const older = all.slice(0, keepFrom)
      if (older.length < 2) throw new Error('可压缩的早期消息不足 2 条（对话还很短或都挤在最近）')
      const _cprov = getState().providers.find(x => x.id === clCfg.providerId) as any
      const _cProxyUrl = String(_cprov?.proxyUrl || '').trim()
      const cProxyFetch = _cProxyUrl && /^https?:\/\//i.test(_cProxyUrl) ? makeProxiedFetch(_cProxyUrl) : undefined
      /* ★ 0925k（实测"压缩失败且一直卡在正在整理较早的对话"）：收尾信号必须保证发出 ——
         摘要调用抛错时旧代码直接上抛，收尾永远不发 ⇒ 前端提示条永久转圈。
         ★ 0925o（实测"报错了却显示压缩成功"）：成败信号分开——成功 'done'、失败 'failed'
         （前端落"压缩中断"），失败同时写运行日志（实测"日志也没有"）。 */
      emitCompactionNotice(cs.id, 'compacting')
      try {
        const cSummary = await summarizeOlderMessages(clCfg, older, String(cs.contextSummary || ''), cProxyFetch)
        const cArcRel = writeTranscriptArchive(String(cs.workDir || '').trim(), all, cs.id) || cs.compactArchiveRel
        /* 0928 T4c B1: capture the PRE-compaction summary view BEFORE overwriting it —— the ring
           anchor below must estimate the view that _prevRing actually reflects. */
        const _prevIdxM = Math.max(0, Number((cs as any).summaryStartIndex) || 0)
        const _prevSumM = String((cs as any).contextSummary || '')
        const _prevArcM = String((cs as any).compactArchiveRel || '')
        cs.contextSummary = cSummary
        /* 0928 T4a fuse (same shape as _t3bAt in the auto path): compaction record coordinate guard.
           keepFrom is in-range by construction today, but persistence/import/refactors can feed
           dirty values; clamp into [0, fullMsgCount] + warn log, and let BOTH summaryStartIndex and
           the compaction record use the clamped coordinate. */
        let _cAt = Number(keepFrom)
        const _cFullCount = all.length
        if (!Number.isFinite(_cAt) || _cAt < 0 || _cAt > _cFullCount) {
          const _cClamped = Math.max(0, Math.min(_cFullCount, Math.round(_cAt) || 0))
          try { sessionLog(cs.id, 'warn', 'llm', `压缩坐标对账：手动压缩边界 at=${_cAt} 越界（全量消息数 ${_cFullCount}）——已钳制为 ${_cClamped}`) } catch { /* ignore */ }
          _cAt = _cClamped
        }
        cs.summaryStartIndex = _cAt
        if (cArcRel) cs.compactArchiveRel = cArcRel
        if (!Array.isArray(cs.contextSummaries)) cs.contextSummaries = []
        cs.contextSummaries.push({ at: _cAt, folded: older.length, summary: cSummary })
        cs.compactFailStreak = 0
        cs.compactCooldownUntil = 0
        cs.compactLastError = ''
        schedulePersist()
        /* ★ 0925r（实测"压缩成功但圆环没减、日志没体现"）：锚点按比例缩放（同自动压缩 3045 口径）
           —— 圆环判定值立刻回落，不用等下一轮真实 usage；成功也写运行日志（原来只有失败才写）。 */
        try {
          /* 0928 T4c B1 (anchor alignment): both sides must be estimated on the SAME view the request
             path actually sends (summary view + summary-card wrapper, pruned with the request path
             params). Old code estimated the BEFORE side from the raw un-pruned full array while
             _prevRing is the real usage of the pruned sent view + system/tools constant: pruning
             alone could push _estBeforeM above _prevRing => _constTok clamped to 0 => the post-compact
             anchor LOST the system+tools constant (measured ~84K) => ring dropped too far and bounced
             back at the next real usage. A prior summary view was also double counted into the BEFORE
             side, and the summary card missed its wrapper text on the AFTER side. */
          const _wrapM = (folded: number, sumText: string, arcRel: string) => ({
            role: 'user' as const,
            content: [{ type: 'text' as const, text: `【系统提示：较早的 ${folded} 条消息已压缩为摘要${arcRel ? `，原文见 ${arcRel}（需要时用 fs_read 回看）` : ''}】\n【摘要】\n${sumText}` }],
          })
          const _pruneM = (v: any[]) => pruneToolOutputs(v, { headLines: CTX_TOOL_HEAD_LINES, tailLines: CTX_TOOL_TAIL_LINES }).messages
          const _beforeViewM = (_prevIdxM > 0 && _prevSumM)
            ? _pruneM([_wrapM(_prevIdxM, _prevSumM, _prevArcM), ...(_prevIdxM < all.length ? all.slice(_prevIdxM) : all)] as any[])
            : _pruneM(all as any[])
          const _afterViewM = _pruneM([_wrapM(_cAt, cSummary, String(cArcRel || '')), ...all.slice(_cAt)] as any[])
          /* constant side: live agent sys/tools first (same source the request path uses), else
             session.system only, else 0 —— when known, the ratio formula below keeps the constant on
             BOTH sides (exact); when unknowable the R10 constant-splitting fallback takes over. */
          const _stM = agents.get(String(cs.id))?.state
          const _constM = estimateRequestTokens(String(_stM?.systemPrompt || (cs as any).system || ''), Array.isArray(_stM?.tools) ? _stM.tools : [], [])
          const _estBeforeM = _constM + estimateRequestTokens('', [], _beforeViewM)
          const _estAfterM = _constM + estimateRequestTokens('', [], _afterViewM)
          const _prevRing = Number((cs as any).ctxUsedForRing) || Number((cs as any).ctxUsedOverride?.tokens) || 0
          /* ★0927 R10（实测"快捷命令压缩后圆环不稳、下一轮就弹回来"）：**基数对齐**。
             _prevRing 是**全量**判定值（含系统提示+工具 schema，实测常量 ≈84K），而
             _estBeforeM/_estAfterM 只是**消息段**估算 —— 旧代码拿消息比直接缩全量值，
            连常量部分一起缩放掉 ⇒ 压缩后锚点系统性偏低（偏差 ≈ 常量×(1−比率)），
             真实 usage 一回来圆环就弹回去。现在先从 _prevRing 剥出常量
             （_prevRing − _estBeforeM，负则夹 0），再加压缩后的消息量，与自动压缩同口径。 */
          /* 0928 T4c B1: primary = the AUTO path formula (field-proven since 0923/0927): real anchor
             x full-view ratio, constant participating on BOTH sides => preserved exactly when
             estimates are consistent (0925r's over-shrink came from a MESSAGE-only ratio). The R10
             constant-splitting above stays as the FALLBACK for when sys/tools are unknowable
             (_constM == 0), but now runs on same-口径 pruned views so _constTok is not zeroed out. */
          let _afterM = Math.round(_estAfterM)
          if (_prevRing > 0 && _estBeforeM > 0 && _constM > 0) {
            _afterM = Math.max(1024, Math.round(_prevRing * (_estAfterM / _estBeforeM)))
          } else if (_prevRing > 0 && _estBeforeM > 0) {
            const _constTok = Math.max(0, _prevRing - _estBeforeM)
            _afterM = Math.max(1024, Math.round(_constTok + _estAfterM))
          }
          ;(cs as any).ctxUsedOverride = { tokens: _afterM, at: Date.now(), viewCount: _afterViewM.length }
          ;(cs as any).ctxUsedForRing = _afterM
          sessionLog(cs.id, 'info', 'llm', `手动压缩完成：折叠 ${older.length} 条早期消息（保留 ${all.length - keepFrom} 条），圆环判定锚点 ${_prevRing} → ${_afterM}，摘要 ${cSummary.length} 字${cArcRel ? '，存档 ' + cArcRel : ''}`)
        } catch { /* 锚点失败不影响压缩结果 */ }
        emitCompactionNotice(cs.id, 'done')
        /* ★0927（实测"压缩后界面还挂着压缩前的旧正文"）：压缩成功后**广播 session/compacted**，
           让前端强制重建该会话视图（折叠掉的旧消息必须从界面消失，只留摘要 + 最近几轮）。
           为什么不能靠 reconcile 的"服务端更新"闸门：压缩后服务端内容**就是变短了**（srvText < localText），
           那道闸门会判"本地更新"而跳过重建 ⇒ 旧正文永远挂着。所以压缩是"合法变短"，必须单独通知。 */
        try {
          broadcastMux(cs.id, { type: 'session/compacted', sessionId: cs.id, folded: older.length, keepFrom, summaryLen: cSummary.length })
        } catch { /* 广播失败不影响压缩结果 */ }
        return { ok: true, folded: older.length, keepFrom, summaryLen: cSummary.length, archiveRel: cArcRel || null }
      } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 200)
        cs.compactLastError = msg
        sessionLog(cs.id, 'error', 'llm', `手动压缩失败：${msg}`)
        emitCompactionNotice(cs.id, 'failed')
        throw new Error(`压缩摘要失败：${msg}`)
      }
    }
    case 'session.exportTranscript': {
      const es = sessions.get(String(p?.sessionId || sessionId || ''))
      if (!es) throw new Error('会话不存在')
      const all: any[] = Array.isArray(es.messages) ? es.messages : []
      if (!all.length) throw new Error('会话还没有消息')
      const rel = writeTranscriptArchive(String(es.workDir || '').trim(), all, es.id)
      if (!rel) throw new Error('导出失败（工作区不可写？）')
      return { ok: true, rel }
    }

    case 'session.rename':
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (s) { s.title = p?.title as string || s.title; s.titleManual = true; schedulePersist() }
      if (s) s.titleManual = true
      return { ok: true }

    // 0909⑦改：置顶持久化（此前只改前端内存态，刷新即取消置顶）
    case 'session.setPinned': {
      if (!sessionId) throw new Error('sessionId required')
      const sp = sessions.get(sessionId)
      if (!sp) throw new Error('session not found')
      sp.pinned = !!p?.pinned
      schedulePersist()
      return { ok: true, pinned: sp.pinned }
    }

    /* ══ 0912 接入批：通道（微信 / QQ / 远程访问）配置与命令 ══
     * 设计见 docs/通道接入设计-前端与上下文-0912.md
     * 核心：通道会话 = 普通会话（打 origin 标记）→ 前端「独享对话列表」只是过滤视图，
     * 因此 PC 上能直接打开通道会话继续聊（跨端接续零成本）。 */

    case 'channel.list':
      return { channels: listChannels() }

    /* 0920：远程访问连接信息（局域网地址 + 手机扫码二维码）——「接入 → 远程访问」面板用。
       二维码由后端生成（qrcode 依赖早就装了但一直没用过，正好用上），前端只负责显示。 */
    case 'remote.info': {
      /* ★1011：链接与二维码都带上访问令牌 —— 手机扫码后地址栏就带 ?token=，页面里的 RPC 靠前端
         utils/nisToken.ts 从 location.search 读它，直接用得上，用户零手输。
         ⚠️ 绝不单独回传 token 字段：那等于把钥匙摆在面板上；它本来就在链接里，够了。
         ★1011r：端口用「当前界面端口」（前端报上来的 uiPort）—— dev 模式下前端在 5174、后端在 8766，
         手机该访问的是**前端那个**（后端只服务 API，直接开 8766 会是 404）。打包版/同源时两者相同。 */
      const uiPort = Number(p?.uiPort) || 0
      const linkPort = uiPort > 0 ? uiPort : PORT
      const tok = currentAccessToken()
      const urls = lanUrls(linkPort, tok)
      const url = urls[0] || ''
      let qr = ''
      if (url) {
        try {
          const mod: any = await import('qrcode')
          const QR = mod.default || mod
          qr = await QR.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
        } catch (e: any) {
          console.warn('[remote] 二维码生成失败：', e?.message || e)
        }
      }
      return {
        enabled: remoteAccessEnabled(),
        port: linkPort,
        urls,
        url,
        qr,
        /** 有令牌（来自环境变量或自动生成）⇒ 远程必须带令牌；没有 ⇒ 前端给黄字警告 */
        tokenRequired: !!tok,
        /** ★1011q：防火墙放行状态（added / exists / failed:… / unknown）
         *  —— "手机连不上但本机正常"时，这里是第一排查点 */
        firewall: _lastFirewallState,
      }
    }

    /* ★1012【云服务器中转】面板四件事：看状态 / 存配置 / 开 / 关。
       uiPort 由前端报上来的"当前界面端口"（dev 下前端 5174、后端 8766 —— 隧道要指向**前端那个**）。 */
    case 'remote.tunnel.info':
      return tunnelInfo()

    case 'remote.tunnel.set': {
      const cur = getTunnelCfg()
      saveTunnelCfg({
        host: typeof p?.host === 'string' ? p.host.trim() : cur.host,
        sshPort: Number(p?.sshPort) > 0 ? Number(p.sshPort) : cur.sshPort,
        user: typeof p?.user === 'string' && p.user.trim() ? p.user.trim() : cur.user,
        publicPort: Number(p?.publicPort) > 0 ? Number(p.publicPort) : cur.publicPort,
      })
      /* 改了配置就把正在跑的隧道重建 —— 否则会出现"填了新地址、隧道还连旧的"这种诡异状态 */
      if (tunnelRunning()) { stopTunnel(); await startTunnel(Number(p?.uiPort) || 0) }
      return tunnelInfo()
    }

    case 'remote.tunnel.start':
      return await startTunnel(Number(p?.uiPort) || 0)

    case 'remote.tunnel.stop':
      return stopTunnel()

    /* ★1012e【计时同步】把"本轮已用秒数"问给前端 —— 让不同窗口（本机 / 手机 / 另一台电脑）显示一致。
       为什么需要：计时器是**每个浏览器各自**从"收到 running 帧"那刻起表的（前端模块级单例只共享
       同一个 JS 运行时）。本机是发起方（按下发送就起表），而手机可能是**本轮中途才连上**的 ——
       它收到 running 帧时本轮已经跑了 N 秒却无从得知，于是两端永远差 N 秒
       （实测：两端显示 1 分 11 秒 vs 1 分 30 秒）。
       前端在收到 running 帧、以及切到该会话时各调一次本接口校准，对齐到服务端权威计时
       （turnStartTime 在 agent_start 时打下，见 9990 行附近）。 */
    case 'session.turnElapsed': {
      const sid = String(p?.sessionId || '')
      const s: any = sid ? (sessions as any).get?.(sid) : null
      const t0 = Number(s?.turnStartTime) || 0
      const running = s?.status === 'running'
      return { sec: running && t0 ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : null, running }
    }

    case 'channel.config.set': {
      const cid = String(p?.channel || '')
      if (!cid) throw new Error('channel required')
      const next = updateChannel(cid, {
        enabled: typeof p?.enabled === 'boolean' ? p.enabled : undefined,
        providerId: typeof p?.providerId === 'string' ? p.providerId : undefined,
        modelId: typeof p?.modelId === 'string' ? p.modelId : undefined,
        effort: typeof p?.effort === 'string' ? p.effort : undefined,
        // 0912 二批：预设（通道会话创建时定型，与模型同理）
        presetId: typeof p?.presetId === 'string' ? p.presetId : undefined,
        // 0912 二批：权限模式（self_audit 默认；confirm 会弹审批卡，需配合 IM 审批桥）
        permissionMode: typeof p?.permissionMode === 'string' ? (p.permissionMode as any) : undefined,
        accountId: typeof p?.accountId === 'string' ? p.accountId : undefined,
        nickname: typeof p?.nickname === 'string' ? p.nickname : undefined,
        stream: typeof p?.stream === 'boolean' ? p.stream : undefined,   // ★1014b：QQ 私聊流式开关
        markdown: typeof p?.markdown === 'boolean' ? p.markdown : undefined,   // ★1014e：QQ Markdown 回复开关
      })
      if (!next) throw new Error('channel not found: ' + cid)
      /* ★1011：远程访问开关一打开、而还没有令牌时，自动生成一把 —— 用户零配置就把门锁上
         （环境变量 NIS_TOKEN 优先：设了就不生成，面板也不能改）。 */
      if (cid === 'remote') {
        const cur = getChannel('remote') as any
        if (cur?.enabled && !NIS_TOKEN && !String(cur?.remoteToken || '').trim()) {
          setRemoteToken(genAccessToken())
        }
        /* ★1011q/r：开关一打开就顺手放行防火墙 —— 否则手机/另一台电脑一律"响应时间过长"，
            而本机访问正常，用户根本查不出病因。要放行的可能有两个端口：后端端口 + 当前界面端口
            （dev 模式下手机走的是 dev server 的端口，前端会把 location.port 一起报上来）。
            提权那步可能弹一次 UAC（已是管理员则静默），所以**不 await**：开关的干脆体验不受影响。 */
        if (cur?.enabled) {
          const uiPort = Number((p as any)?.uiPort) || 0
          void ensureFirewallRule(uiPort && uiPort !== PORT ? [PORT, uiPort] : [PORT]).then(r => {
            _lastFirewallState = r.state
            if (r.ok) console.log('[remote] 防火墙放行：', r.state)
            else console.warn('[remote] 防火墙放行未完成：', r.state)
          }).catch(() => { /* ensureFirewallRule 内部已兜底，不会抛 */ })
        }
      }
      // 0912：QQ 配置变更 → 重连（启用/停用/换模型都要让机器人重新上线）
      if (cid === 'qq') void syncQqBotsFromConfig().catch(() => { /* 日志由内部打 */ })
      if (cid === 'wechat') reconnectChannel('wechat')
      return { ok: true, channel: getChannelRedacted(cid) }
    }

    /* ★1011：一键换锁 —— 重新生成远程访问令牌，旧链接/旧二维码立即失效。
       令牌由部署方的 NIS_TOKEN 指定时不允许改（那是别人的钥匙）。 */
    case 'remote.regenToken': {
      if (String(NIS_TOKEN || '').trim()) return { ok: false, envControlled: true }
      const tok = genAccessToken()
      setRemoteToken(tok)
      const urls = lanUrls(PORT, tok)
      let qr = ''
      try {
        const mod: any = await import('qrcode')
        const QR = mod.default || mod
        if (urls[0]) qr = await QR.toDataURL(urls[0], { margin: 1, width: 240, errorCorrectionLevel: 'M' })
      } catch { /* 二维码失败不影响换锁本身 */ }
      return { ok: true, envControlled: false, url: urls[0] || '', urls, qr }
    }

    /* ★1011t（B 方案）：用户附件落盘 —— 前端在发送前逐个调它，拿到相对路径后拼进正文标记
       `[[文件:uploads/xxx]]`。消息里只留路径（轻），文件在工作区里（**AI 能直接用工具读**）。
       上限与前端一致（8MB）；base64 约为原体积 1.37 倍 ⇒ 这里按 12MB 字符数兜底。 */
    case 'session.uploadFile': {
      const sid = String(p?.sessionId || '')
      if (!sid) throw new Error('sessionId required')
      if (!sessions.get(sid)) throw new Error('session not found: ' + sid)
      const b64 = String(p?.dataBase64 || '')
      if (!b64) throw new Error('dataBase64 required')
      if (b64.length > 12 * 1024 * 1024) throw new Error('文件过大（上限 8MB）')
      const r = persistUpload(sid, String(p?.name || 'file'), b64)
      if (r.error) throw new Error(r.error)
      return { ok: true, relPath: r.relPath, bytes: r.bytes }
    }

    case 'channel.status':
      // 通道连接状态（QQ 机器人 / 微信是否在线）
      return { qq: qqBotStatus(), wechat: wechatBotStatus() }

    /* ── 0912：微信扫码登录（移植官方 openclaw-weixin 流程）── */
    case 'channel.wechat.qrStart': {
      const r = await startQrLogin()
      return r
    }

    case 'channel.wechat.qrWait': {
      const key = String(p?.sessionKey || '')
      if (!key) throw new Error('sessionKey required')
      const r = await waitQrLogin(key, typeof p?.verifyCode === 'string' ? p.verifyCode : undefined)
      // 扫码成功 → 写入通道配置（微信只允许一个账号，覆盖式保存）
      if (r.connected && r.accountId) {
        const cfg = getChannel('wechat')
        // 微信只允许单个账号：清空后写入这一台（旧连接先停掉）
        if (cfg && cfg.bots.length) {
          for (const b of [...cfg.bots]) {
            try { stopWechatBot(b.id, { notify: false }) } catch { /* ignore */ }
            removeBot('wechat', b.id)
          }
        }
        addBot('wechat', { accountId: r.accountId, secret: r.botToken || '', nickname: r.nickname || '微信' })
        updateChannel('wechat', { enabled: true, accountId: r.accountId, nickname: r.nickname || '' })
        console.log(`[channel] 微信已连接：${r.accountId}（bot_token ${r.botToken ? '已保存' : '⚠️ 缺失'}）`)
        /**
         * ⚠️ 关键：启动 getupdates 长轮询。
         * 微信服务端以「是否有活跃的 getUpdates 连接」判定 bot 在线 ——
         * 只存 token 不拉取 = 服务端认为你掉线 → 手机端 ClawBot 显示「暂时无法连接」（用户实测踩到）。
         */
        const newBot = (getChannel('wechat')?.bots || [])[0]
        if (newBot?.secret) {
          startWechatBot({ botId: newBot.id, accountId: newBot.accountId, token: newBot.secret })
        } else {
          console.warn('[channel] 微信 bot_token 缺失，无法启动长轮询 —— 请在弹窗重新扫码')
        }
      }
      return r
    }

    case 'channel.wechat.qrCancel': {
      const key = String(p?.sessionKey || '')
      if (key) cancelQrLogin(key)
      return { ok: true }
    }

    /* ── 机器人（账号）管理：QQ 多机器人 / 微信多账号 ── */
    case 'channel.bot.add': {
      const cid = String(p?.channel || '')
      const accountId = String(p?.accountId || '').trim()
      if (!cid || !accountId) throw new Error('channel & accountId required')
      const next = addBot(cid, { accountId, secret: p?.secret, nickname: p?.nickname })
      if (!next) throw new Error('add bot failed: ' + cid)
      if (cid === 'qq') void syncQqBotsFromConfig().catch(() => {})
      if (cid === 'wechat') reconnectChannel('wechat')
      return { ok: true, channel: getChannelRedacted(cid) }
    }

    case 'channel.bot.update': {
      const cid = String(p?.channel || '')
      const key = String(p?.key || '')
      if (!cid || !key) throw new Error('channel & key required')
      const next = updateBot(cid, key, {
        secret: typeof p?.secret === 'string' ? p.secret : undefined,
        nickname: typeof p?.nickname === 'string' ? p.nickname : undefined,
        enabled: typeof p?.enabled === 'boolean' ? p.enabled : undefined,
        // 人格与称呼覆盖（0912 七批）：空串 = 清除该自定义项
        personaName: typeof p?.personaName === 'string' ? p.personaName : undefined,
        addressName: typeof p?.addressName === 'string' ? p.addressName : undefined,
        personaPrompt: typeof p?.personaPrompt === 'string' ? p.personaPrompt : undefined,
        // 总开关：global=跟随系统设置 / custom=启用自定义
        personaMode: typeof p?.personaMode === 'string' ? (p.personaMode as any) : undefined,
        // 该机器人的独立运行配置（0912 十批；空串 = 清除 → 跟随全局；0914 修订：不再回落通道级）
        providerId: typeof p?.providerId === 'string' ? p.providerId : undefined,
        modelId: typeof p?.modelId === 'string' ? p.modelId : undefined,
        effort: typeof p?.effort === 'string' ? p.effort : undefined,
        presetId: typeof p?.presetId === 'string' ? p.presetId : undefined,
        permissionMode: typeof p?.permissionMode === 'string' ? (p.permissionMode as any) : undefined,
        // 群聊插嘴（0912 二十四批）
        interject: typeof p?.interject === 'boolean' ? p.interject : undefined,
        interjectScope: typeof p?.interjectScope === 'string' ? (p.interjectScope as any) : undefined,
        interjectPerHour: typeof p?.interjectPerHour === 'number' ? p.interjectPerHour : undefined,
        // 0912 反馈：插嘴词 + 冷却时间（秒）
        interjectKeywords: Array.isArray(p?.interjectKeywords) ? (p.interjectKeywords as any) : undefined,
        interjectCooldownSec: typeof p?.interjectCooldownSec === 'number' ? p.interjectCooldownSec : undefined,
      })
      if (!next) throw new Error('bot not found: ' + key)
      if (cid === 'qq') void syncQqBotsFromConfig().catch(() => {})
      if (cid === 'wechat') reconnectChannel('wechat')
      return { ok: true, channel: getChannelRedacted(cid) }
    }

    case 'channel.bot.remove': {
      const cid = String(p?.channel || '')
      const key = String(p?.key || '')
      if (!cid || !key) throw new Error('channel & key required')
      const next = removeBot(cid, key)
      if (!next) throw new Error('bot not found: ' + key)
      if (cid === 'qq') void syncQqBotsFromConfig().catch(() => {})
      if (cid === 'wechat') reconnectChannel('wechat')
      return { ok: true, channel: getChannelRedacted(cid) }
    }

    case 'channel.moveSession': {
      /**
       * 会话在「普通聊天列表」与「通道独享列表」之间迁移（双向）。
       *
       * 背景：通道会话本就是普通会话（带 origin 标记），所以迁移只是改一个字段 ——
       * 不搬消息、不重建会话来路、不动工作区。这让「双向互换」天然无损可逆。
       *
       * @param target 'wechat' | 'qq' | 'remote' | ''（空=移回普通聊天列表）
       */
      const sid = String(p?.sessionId || '')
      if (!sid) throw new Error('sessionId required')
      const s = sessions.get(sid)
      if (!s) throw new Error('session not found')
      const target = String(p?.target ?? '').trim()
      if (target && !['wechat', 'qq', 'remote'].includes(target)) {
        throw new Error('invalid target: ' + target)
      }
      const prev = s.origin || ''
      /**
       * 十九批修订：**保留 origin（来源通道）**，只用 `inMainList` 标记显示位置 ——
       * 早期做法是"移出通道就把 origin 清空"，结果移到聊天列表后**平台图标丢了**
       * （用户反馈：转出来看不出这条是从微信来的）。现在语义统一：
       *   inMainList=true  → 显示在主对话列表（带平台图标），且不再出现在该通道的独享列表
       *   inMainList=false → 只在该通道的独享列表里
       *
       * 二级菜单（十九批）还能同时指定"哪个机器人的哪个对端"，见 botId/peerId/kind 参数。
       */
      const tBot = String(p?.botId || '').trim()
      const tPeer = String(p?.peerId || '').trim()
      const tKind = String(p?.kind || '').trim()
      if (target) {
        s.origin = target
        if (tBot) s.originBot = tBot
        if (tPeer) s.originPeer = tPeer
        if (tKind) s.originKind = tKind
        s.inMainList = false
        s.movedInAt = undefined          // ★ 0922z2b：移出主列表 → 打点作废（下次挪进来重新打）
      } else {
        s.inMainList = true
        s.movedInAt = Date.now()          // ★ 0922z2b：刚挪进主列表 → 列表置顶（需求）
      }
      /**
       * ⚠️ 迁移/移出都必须清掉指向该会话的映射（0912 十一批修）——
       * 否则：① 手机发来的消息仍会落到这个"已移出通道"的会话
       *       ② channel.sessions 里的 healSessionsFromLinks 会按映射把 origin 又填回去，
       *          表现为「移到聊天列表 / 删除后，它自己又回到独享列表」。
       */
      if (!target || target !== prev) {
        try { removeLinkBySession(sid) } catch { /* ignore */ }
      }
      schedulePersist()
      broadcastHost({ type: 'host/session-renamed', sessionId: sid, title: s.title })
      return { ok: true, sessionId: sid, from: prev, to: target || '', inMainList: s.inMainList === true }
    }

    case 'channel.sessions': {
      /**
       * 某通道的「独享对话列表」：按 origin 过滤。
       * 0912 二批：额外支持 `botId` 过滤 —— QQ 支持多机器人，**每个机器人必须有独立的对话列表**
       * （用户明确要求：「qq机器人的对话，每个机器人都是不同的，不要共用一套对话列表」）。
       */
      const cid = String(p?.channel || '')
      const botId = String(p?.botId || '').trim()
      // 先按映射回填归属字段（历史数据可能缺 originPeer/originBot，会漏掉会话）
      healSessionsFromLinks()
      const list = Array.from(sessions.values())
        .filter(s => (s.origin || '') === cid)
        // 十九批：移到主对话列表的会话不再属于这里（origin 保留只为图标/来源）
        .filter(s => s.inMainList !== true)
        .filter(s => !botId || (s.originBot || '') === botId)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 50)

      /**
       * 「当前会话」标记（0912 三批）：该机器人后续收到的 IM 消息会落到哪个会话。
       * 两种来源：① 正式映射（对端已明确）② bot 级覆盖（PC 端指定、对端待绑定）。
       * 判定用映射文件反查（不依赖会话字段 —— 字段可能因历史 bug 缺失）。
       */
      const activeIds: string[] = []
      const allLinks = listLinks()
      for (const s of list) {
        const hit = Object.values(allLinks).some(v =>
          v.sessionId === s.id && v.channel === cid && (!botId || v.botId === botId))
        if (hit) activeIds.push(s.id)
      }
      const ov = getBotActive(cid, botId)
      if (ov && list.some(x => x.id === ov.sessionId) && !activeIds.includes(ov.sessionId)) {
        activeIds.push(ov.sessionId)
      }

      return {
        sessions: list.map(s => ({
          id: s.id, title: s.title, updatedAt: s.updatedAt, createdAt: s.createdAt,
          status: s.status, originPeer: s.originPeer || '', originBot: s.originBot || '',
          originKind: s.originKind || '',
          /** 对端显示名（群A/群B/私聊）—— 多群场景下列表靠它区分（0912 十七批） */
          peerLabel: s.originPeer ? labelFor(cid, s.originBot || botId, s.originPeer, s.originKind) : '',
          /** 定时任务支线标记（0912 十九批）：列表里显示 ⏰，且提供「放进主对话列表 / 放回」 */
          taskId: s.taskId || '', inMainList: s.inMainList === true,
          model: s.model || '',
          lastMessage: (s.messages?.[s.messages.length - 1]?.content || [])
            .filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ').slice(0, 60),
        })),
        activeIds,
      }
    }

    case 'channel.commands':
      // 命令表（前端弹窗展示帮助，避免前端重复维护一份）
      return { commands: commandList() }

    /* ★1013a：QQ 指令面板 —— 把内置命令注册到 QQ 开放平台，让用户在 QQ 里"看得见、点得到"。
       ⚠️ 边界（需求）：这里调的 channels/qqPanel.ts 零 import / 零广播 / 零事件监听 /
       零定时器，只发异步 HTTP 并把平台原话原样返回 ⇒ 不碰任何会话/帧/路由，不影响对话流。
       平台返回的错误原样上抛（不兜底、不吞真因）。 */
    case 'channel.qq.panelInfo': {
      const bots = (getChannel('qq')?.bots || []) as any[]
      const bot = p?.botId ? bots.find((b) => String(b.id) === String(p.botId)) : bots[0]
      if (!bot?.accountId) throw new Error('QQ 通道还没配置机器人（缺 AppID）')
      if (!bot?.secret) throw new Error(`机器人 ${bot.accountId} 缺 AppSecret，请先在通道页填写`)
      const scope = String(p?.scope || 'c2c')
      const token = await fetchQqAccessToken(String(bot.accountId), String(bot.secret))
      return { scope, bot: String(bot.accountId), panels: await listQqPanels(token, scope), items: QQ_PANEL_ITEMS }
    }

    case 'channel.qq.panelSync': {
      const bots = (getChannel('qq')?.bots || []) as any[]
      const bot = p?.botId ? bots.find((b) => String(b.id) === String(p.botId)) : bots[0]
      if (!bot?.accountId) throw new Error('QQ 通道还没配置机器人（缺 AppID）')
      if (!bot?.secret) throw new Error(`机器人 ${bot.accountId} 缺 AppSecret，请先在通道页填写`)
      return await syncQqPanel(String(bot.accountId), String(bot.secret), { scope: String(p?.scope || 'c2c') })
    }

    /**
     * ★1019：QQ **单聊自定义菜单**（单聊窗口底部的常驻菜单）—— 查 / 同步。
     * ⚠️ 与指令面板不同：菜单项 `send_message` 是「点击后把文本**填进输入框**」（用户还得自己按发送），
     *    所以它只是**常驻快捷入口**；"点了就执行"仍靠消息按钮。
     * 边界同上：只发异步 HTTP，平台原话原样返回（不兜底、不吞真因），不碰会话/帧/路由。
     */
    case 'channel.qq.menu': {
      const bots = (getChannel('qq')?.bots || []) as any[]
      const bot = p?.botId ? bots.find((b) => String(b.id) === String(p.botId)) : bots[0]
      if (!bot?.accountId) throw new Error('QQ 通道还没配置机器人（缺 AppID）')
      if (!bot?.secret) throw new Error(`机器人 ${bot.accountId} 缺 AppSecret，请先在通道页填写`)
      return { bot: String(bot.accountId), menu: await fetchQqMenu(String(bot.accountId), String(bot.secret)) }
    }

    case 'channel.qq.menuSync': {
      const bots = (getChannel('qq')?.bots || []) as any[]
      const bot = p?.botId ? bots.find((b) => String(b.id) === String(p.botId)) : bots[0]
      if (!bot?.accountId) throw new Error('QQ 通道还没配置机器人（缺 AppID）')
      if (!bot?.secret) throw new Error(`机器人 ${bot.accountId} 缺 AppSecret，请先在通道页填写`)
      return await syncQqMenu(String(bot.accountId), String(bot.secret))
    }

    case 'channel.setActiveSession': {
      /**
       * 把某个会话设为「当前会话」（0912 三批：PC 端也能切换正在进行的对话）。
       *
       * 等价于手机发 `/switch N` —— 改的是同一份映射，所以两边天然同步：
       * PC 上切完，手机下一条消息立刻落到新会话。
       */
      const sid = String(p?.sessionId || '')
      if (!sid) throw new Error('sessionId required')
      const s = sessions.get(sid)
      if (!s) throw new Error('会话不存在')
      const cid = String(p?.channel || s.origin || '')
      if (!cid) throw new Error('该会话不是通道会话')
      const botId = String(p?.botId || s.originBot || '')
      const r = activateChannelSession(cid, botId, sid)
      return { ok: true, sessionId: sid, channel: cid, botId, active: r.mode, peerId: r.peerId || '' }
    }

    // ★1015c：查 PC 接管配对码（PC 端设置界面显示用；码只在 PC 端可见，绝不回给 IM）
    case 'pc.codes': {
      const { getPairCode } = await import('./channels/pcAccess.ts')
      const one = String(p?.botId || '').trim()
      if (one) return { ok: true, codes: { [one]: getPairCode(one) } }
      // 不传 channel ⇒ 把所有通道（QQ/微信）的机器人码都给出来；界面按 botId 取自己那份，切 tab 不用重拉
      const codes: Record<string, string> = {}
      for (const cid of ['qq', 'wechat']) {
        const ch = getChannel(cid)
        for (const b of (ch?.bots || [])) {
          const id = String((b as any)?.id || '')
          if (id) codes[id] = getPairCode(id)
        }
      }
      return { ok: true, codes }
    }

    // ★1015：换配对码（PC 端用；给某台机器人换新码，并撤销它名下已配对的授权）
    case 'pc.rotateCode': {
      const { rotateCode } = await import('./channels/pcAccess.ts')
      const code = rotateCode(p?.botId ? String(p.botId) : undefined)
      return { ok: true, botId: String(p?.botId || ''), code }
    }

    case 'channel.newSession': {
      /**
       * 新建一个通道会话并**立即设为当前会话**（0912 三批：PC 端也能新建对话）。
       *
       * 等价于手机发 `/new`。对端确定规则见 activateChannelSession：
       * 该机器人已有对话时借用其对端（自聊场景对端唯一）；从未收过消息则等首条消息落定。
       */
      const cid = String(p?.channel || '')
      if (!cid) throw new Error('channel required')
      const botId = String(p?.botId || '').trim()
      const mc = modelForChannel(cid, botId)
      const label = cid === 'qq' ? 'QQ' : cid === 'wechat' ? '微信' : '远程'
      const title = String(p?.title || '').trim()
        || `${label}对话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      const s = createSession(title, undefined, mc.presetId || undefined, undefined, undefined, cid)
      if (mc.modelId) {
        s.model = mc.modelId
        s.modelProviderId = resolveModelProviderId(mc.modelId) || undefined
      }
      if (mc.effort) s.effort = mc.effort
      // ★1013g：不再套通道档（已删）—— 新会话用对话自己的默认权限
      if (botId) s.originBot = botId
      schedulePersist()
      broadcastHost({ type: 'host/session-added', sessionId: s.id, blank: true, cwd: s.workDir ?? process.cwd() })
      let active = ''
      if (botId) {
        try { active = activateChannelSession(cid, botId, s.id).mode } catch { /* ignore */ }
      }
      return {
        ok: true,
        session: {
          id: s.id, title: s.title, updatedAt: s.updatedAt, createdAt: s.createdAt,
          status: s.status, originPeer: s.originPeer || '', originBot: s.originBot || '',
          originKind: s.originKind || '',
          model: s.model || '', lastMessage: '',
        },
        active,
      }
    }

    case 'channel.command': {
      // 执行一条 IM 命令。供通道适配器调用；也供前端弹窗联调（无需真实通道即可验证命令层）。
      // /stop 与 /switch 返回 action 描述符而非直接执行 —— 让调用方走既有 RPC（避免复制 session.cancel 的复杂逻辑）
      const text = String(p?.text || '')
      const cid = String(p?.channel || 'wechat')
      const parsed = parseCommand(text)
      if (!parsed) return { handled: false, reply: '' }
      // `/回复通知2 内容` 归一化（与 IM 路径同口径）
      let noticeIdxRpc = 0
      {
        const m = /^(?:回复通知|replynotice|rn)(\d*)$/i.exec(parsed.name)
        if (m) {
          noticeIdxRpc = Math.max(0, parseInt(m[1] || '0', 10) || 0)
          parsed.name = '回复通知'
        }
      }
      const spec = findCommand(parsed.name)
      if (!spec) return { handled: true, reply: `未知命令：/${parsed.name}\n\n${helpText()}` }

      const chSessions = Array.from(sessions.values())
        .filter(s => (s.origin || '') === cid)
        .filter(s => !p?.botId || (s.originBot || '') === String(p.botId))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

      /**
       * 0912 十六批：前端联调面板**不传对端**，那就从 sessionId 反推（会话自己带 originBot/originPeer），
       * 口径与手机上的 `/list` 完全一致 —— 私聊只列私聊、A 群只列 A 群。
       * 反推不到时退回"本通道全部"，但表头会写明是哪个范围，避免误以为混在一张表。
       */
      const ctxSid = String(p?.sessionId || '')
      const ctxSession = ctxSid ? sessions.get(ctxSid) : undefined
      const ctxBot = String(p?.botId || ctxSession?.originBot || '')
      const ctxPeer = String(p?.peerId || ctxSession?.originPeer || '')
      /**
       * 本命令要操作的机器人 id —— 优先显式传入/会话自带，否则取该通道第一台。
       * ⚠️ 早先几处直接用了裸 `botId`（本作用域里并不存在）→ 运行时 `botId is not defined`，
       * 表现为「PC 联调面板里 /perm 报错」（0912 十六批实测抓到）。
       */
      const cmdBotId = String(ctxBot || (getChannel(cid)?.bots || [])[0]?.id || '')
      const scoped = ctxBot && ctxPeer ? peerScopedSessions(cid, ctxBot, ctxPeer) : []

      switch (spec.name) {
        case 'help':
          return { handled: true, reply: helpText() }

        case 'list': {
          const list = scoped.length ? scoped : chSessions
          if (!list.length) return { handled: true, reply: '还没有对话。发 /new 开一个。' }
          const label = scoped.length ? sceneLabel(ctxSession?.originKind) : '本通道'
          const tag = scoped.length && ctxPeer && ctxSession?.originKind !== 'c2c' ? ` ${ctxPeer.slice(0, 6)}` : ''
          const lines = list.slice(0, 10).map((s, i) => {
            const mark = s.status === 'running' ? ' ⏳执行中' : ''
            const cur = ctxSid && s.id === ctxSid ? ' ← 当前' : ''
            return `${i + 1}. ${s.title} · ${sessionSceneTag(s, cid)}${mark}${cur}`
          })
          return {
            handled: true,
            reply: `【${label}${tag}】对话列表（共 ${list.length} 个）：\n\n${lines.join('\n')}\n\n发 /switch <序号> 切换，/new 新开，/pc 接管 PC 端会话。`,
          }
        }

        case '通知': {
          // 与手机端同口径（0912 十九批）：列出待回复的定时任务通知
          if (!ctxBot || !ctxPeer) return { handled: true, reply: '需要带 sessionId（知道是哪个对端）才能列出通知清单。' }
          return { handled: true, reply: noticeListText(cid, ctxBot, ctxPeer) }
        }

        case '回复通知': {
          if (!ctxBot || !ctxPeer) return { handled: true, reply: '需要带 sessionId（知道是哪个对端）才能追问通知。' }
          const lk = getLink(makeChannelKey(cid, ctxBot, ctxPeer))
          const passive = qqPassiveWindowOpen(lk)
          const tg: ChannelDeliverTarget = {
            channel: cid as 'qq' | 'wechat',
            botId: ctxBot,
            peerId: ctxPeer,
            // 有被动窗口就用它（不占额度），否则由通道自己决定主动消息
            messageId: passive ? String(lk?.lastMessageId) : '',
            kind: (lk?.kind as any) || 'c2c',
            contextToken: lk?.contextToken,
          }
          const out = await handleNoticeReply(cid as 'qq' | 'wechat', ctxBot, ctxPeer, String(parsed.args || ''), noticeIdxRpc, tg)
          return { handled: true, reply: out || '已交给该通知的对话处理，回复会带「⏰任务名」发到对应通道。' }
        }

        case 'new': {
          const botIdNew = String(p?.botId || ctxBot || (getChannel(cid)?.bots || [])[0]?.id || '')
          const title = parsed.args || `通道对话 · ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
          const mcNew = modelForChannel(cid, botIdNew)
          /**
           * ★1015 跟随当前上下文（已定案）：正接管着 **PC 项目会话**时，`/new` 就在**那个项目里**新开一条
           * —— 继承 工作区(=项目根) + projectId，origin 留空 ⇒ 归到项目树里，不算通道的独享会话。
           * 通道自己的会话、以及 PC 的普通聊天会话 → 维持现状（开本通道自己的新对话）。
           */
          const curLk = (ctxBot && ctxPeer) ? getLink(makeChannelKey(cid, ctxBot, ctxPeer)) : undefined
          const curS = curLk?.sessionId ? sessions.get(String(curLk.sessionId)) : undefined
          const inherit = (curS && !CHANNEL_SIDE_ORIGINS.has(String(curS.origin || '').trim()) && String(curS.projectId || '').trim())
            ? curS : undefined
          const s = inherit
            ? createSession(title, inherit.workDir, mcNew.presetId || undefined, undefined, undefined, undefined, inherit.projectId)
            : createSession(title, undefined, mcNew.presetId || undefined, undefined, undefined, cid)
          // 按通道配置定型模型/预设（空值=跟随全局；createSession 默认已跟随全局）
          if (mcNew.modelId) {
            s.model = mcNew.modelId
            s.modelProviderId = resolveModelProviderId(mcNew.modelId) || undefined
          }
          if (mcNew.effort) s.effort = mcNew.effort
          // ★1013g：不再套通道档（已删）—— 新会话用对话自己的默认权限
          if (botIdNew) s.originBot = botIdNew
          schedulePersist()
          broadcastHost({ type: 'host/session-added', sessionId: s.id, blank: true, cwd: s.workDir ?? process.cwd() })
          /**
           * ⚠️ 必须把「当前会话」指过去。早期这里只建了会话没更新映射 ——
           * 表现为「新开对话成功，但手机发的消息还是落到旧会话」。
           */
          let actMode = ''
          if (botIdNew) {
            try { actMode = activateChannelSession(cid, botIdNew, s.id).mode } catch { /* ignore */ }
          }
          return { handled: true, reply: inherit
            ? `已新开对话「${s.title}」（在项目里 · 跟「${inherit.title}」同一个工作区）。直接发消息即可。`
            : `已新开对话「${s.title}」。直接发消息即可开始。`, action: { kind: 'new', sessionId: s.id, active: actMode } }
        }

        case 'switch': {
          // 与 /list 同口径：有对端上下文就只在本对端范围内切（避免把别的群/别人的会话抢过来）
          const swList = scoped.length ? scoped : chSessions
          const n = parseInt(parsed.args, 10)
          if (!Number.isFinite(n) || n < 1 || n > swList.length) {
            return { handled: true, reply: `用法：/switch <序号>（当前可选 1-${swList.length}）。发 /list 看列表。` }
          }
          const target = swList[n - 1]
          const botId = String(p?.botId || target.originBot || cmdBotId)
          /**
           * ⚠️ 真的改映射。早期只返回一句「已切换到」而没落映射 —— 纯空转，
           * 用户以为切了，实际消息还落旧会话。
           */
          let actMode = ''
          if (botId) {
            try { actMode = activateChannelSession(cid, botId, target.id).mode } catch { /* ignore */ }
          }
          return { handled: true, reply: `已切换到「${target.title}」。`, action: { kind: 'switch', sessionId: target.id, active: actMode } }
        }

        /* ★1014f：PC 会话接管（联调面板走这条）。trusted=true：请求来自本机 PC → 免配对、免群聊闸。 */
        case 'pc': {
          const out = pcCommandCore({
            channel: cid, botId: cmdBotId, peerId: ctxPeer, kind: ctxSession?.originKind,
            args: parsed.args, curSessionId: ctxSid, trusted: true,
          })
          let actMode = ''
          if (out.switchTo && cmdBotId && ctxPeer) {
            try { actMode = activateChannelSession(cid, cmdBotId, out.switchTo).mode } catch { /* ignore */ }
          }
          return { handled: true, reply: out.reply, action: out.switchTo ? { kind: 'switch', sessionId: out.switchTo, active: actMode } : undefined }
        }

        case 'home': {
          const out = homeCommandCore({ channel: cid, botId: cmdBotId, peerId: ctxPeer, curSessionId: ctxSid })
          let actMode = ''
          if (out.switchTo && cmdBotId && ctxPeer) {
            try { actMode = activateChannelSession(cid, cmdBotId, out.switchTo).mode } catch { /* ignore */ }
          }
          return { handled: true, reply: out.reply, action: out.switchTo ? { kind: 'switch', sessionId: out.switchTo, active: actMode } : undefined }
        }

        case 'perm': {
          /**
           * ★1020：口径与 IM（`handleChannelIncoming` 里的 `case 'perm'`）**完全统一** —— 只改当前这条对话。
           * 历史：这里原来写 `updateChannel(cid, { permissionMode: mode })`，改的是"通道级权限档"；
           * 那个档位 1013g 已被已定案删掉（前端下拉与本文件的入站同步都删了），**只剩这条活路径漏了**
           * （PC 通道面板的命令框 → RPC `channel.command`）。它和 healChannelSession 的旧同步叠加，
           * 表现为"切了权限，来一条消息又变回去"。
           */
          const cur: PermissionMode = ((ctxSession?.permissionMode || 'confirm') as PermissionMode)
          const arg = (parsed.args || '').trim()
          if (!arg) return { handled: true, reply: permText(cur) }
          const mode = parsePermMode(arg)
          if (!mode) return { handled: true, reply: `无法识别的档位「${arg}」。\n\n${permText(cur)}` }
          if (!ctxSession) {
            return { handled: true, reply: '这条命令要指定对话：先在通道里发一条消息（或发 /new 建一个），再切权限。' }
          }
          ctxSession.permissionMode = mode
          schedulePersist()
          console.log(`[channel] 对话 ${ctxSession.id.slice(0, 8)} 权限改为 ${mode}（PC 通道面板，只影响本条对话）`)
          return {
            handled: true,
            reply: `✅ **本对话**权限已切为「${permLabel(mode)}」。\n（只影响当前这条对话；新对话会回到默认档）`,
            action: { kind: 'perm', mode },
          }
        }

        case 'status': {
          const activeId = String(p?.sessionId || '')
          const s = (activeId ? sessions.get(activeId) : undefined) || chSessions[0]
          if (!s) return { handled: true, reply: '当前没有对话。发 /new 开一个。' }
          return {
            handled: true,
            reply: [
              `对话：${s.title}`,
              `模型：${s.model || '(跟随全局)'}`,
              `权限：${permLabel(s.permissionMode || 'confirm')}`,
              `状态：${s.status === 'running' ? '正在回复中' : '空闲'}`,
              `消息数：${s.messages?.length || 0}`,
            ].join('\n'),
          }
        }

        case 'stop': {
          const activeId = String(p?.sessionId || '')
          const s = (activeId ? sessions.get(activeId) : undefined) || chSessions.find(x => x.status === 'running')
          if (!s || s.status !== 'running') return { handled: true, reply: '当前没有正在执行的任务。' }
          return { handled: true, reply: '已请求停止当前执行。', action: { kind: 'stop', sessionId: s.id } }
        }
      }
      return { handled: true, reply: `未实现的命令：/${spec.name}` }
    }

    case 'session.setOrigin': {
      /**
       * 设置会话的来源通道标记（真实场景由通道创建会话时带 origin；此 RPC 供联调/迁移）。
       *
       * ⚠️ 语义是**局部更新**：只改 payload 里显式出现的字段。
       * （曾写成全量赋值 —— 只传 originBot 会把 origin 一起清空，实测把会话踢出了通道列表）
       */
      if (!sessionId) throw new Error('sessionId required')
      const so = sessions.get(sessionId)
      if (!so) throw new Error('session not found')
      if (typeof p?.origin === 'string') so.origin = p.origin.trim() || undefined
      if (typeof p?.originPeer === 'string') so.originPeer = p.originPeer.trim() || undefined
      if (typeof p?.originBot === 'string') so.originBot = p.originBot.trim() || undefined
      if (typeof p?.permissionMode === 'string'
          && ['self_audit', 'full_access', 'confirm'].includes(p.permissionMode)) {
        so.permissionMode = p.permissionMode as PermissionMode
      }
      schedulePersist()
      return { ok: true, origin: so.origin, originPeer: so.originPeer, originBot: so.originBot, permissionMode: so.permissionMode }
    }

    /** 0910：删除某一轮对话（把错误信息从上下文里摘掉）。
     *  turnIndex = 用户消息序号（1 基，与撤销面板/fileHistory 同口径）；等 0 基转「第 N 条 user 消息」。
     *  includeUser=true 连用户消息一起删（默认，避免留下"孤儿提问"污染后续上下文：模型会看到
     *  一个没有回答的提问，可能在新轮里回答旧问题）；false=只删 AI 回复（保留我的消息，用于重试）。
     *  同步删三处：pi 实时 transcript（下一轮真正喂模型的）/ session.transcript（持久化）/
     *  session.messages（DSH 展示兜底）+ turnMetas（该轮统计）+ fileHistory 的 turnIndex 重编号。 */
    case 'session.deleteTurn': {
      if (!sessionId) throw new Error('sessionId required')
      const ds = sessions.get(sessionId)
      if (!ds) throw new Error('session not found')
      if (ds.status === 'running') throw new Error('AI 正在回复中，请先停止再删除')
      const turnIndex = Number(p?.turnIndex)
      if (!Number.isInteger(turnIndex) || turnIndex < 1) throw new Error('turnIndex 非法（应为 ≥1 的整数）')
      const includeUser = p?.includeUser !== false
      // 取 pi 格式 transcript：实时 agent 状态优先（下一轮真正喂模型的数组），回退持久化快照
      const dsAgent = agents.get(sessionId) as any
      const live: any[] | undefined = dsAgent?.state.messages
      const tr: any[] = Array.isArray(live) && live.length > 0 ? live : (Array.isArray(ds.transcript) ? ds.transcript : [])
      if (tr.length === 0) throw new Error('该会话没有可删除的消息')
      // 定位第 turnIndex 条真实 user 消息（跳过注入指令——它不是用户轮，不入轮次计数；★1003 4.73 统一口径）
      const userIdx: number[] = []
      for (let i = 0; i < tr.length; i++) {
        const m = tr[i]
        if (isInjectedUserMsg(m)) continue
        if (m?.role !== 'user') continue
        userIdx.push(i)
      }
      if (userIdx.length < turnIndex) throw new Error(`轮次越界：当前只有 ${userIdx.length} 轮`)
      const start = userIdx[turnIndex - 1]
      const end = turnIndex < userIdx.length ? userIdx[turnIndex] : tr.length  // 下一轮 user 起（或到末尾）
      const cutFrom = includeUser ? start : start + 1
      const removedCount = end - cutFrom
      if (removedCount <= 0) throw new Error('该轮没有可删除的 AI 回复')
      // 安全断言：切割区间内 assistant 的全部 toolCall 必须都能在区间内找到对应 toolResult，
      // 且区间内的 toolResult 也必须能在区间内找到对应 toolCall——否则删完会出现"孤儿 tool_call/
      // 孤儿 tool_result"，下一轮请求被网关 400 拒（与压缩同款硬约束）。
      // 反向检查专治"插话切进工具调用中间"的形态：assistant[call X] → user(插话) → toolResult[X]，
      // 按轮切割会把 toolResult 划进新区间而 call 留在旧区间。
      {
        const seg = tr.slice(cutFrom, end)
        const callIds = new Set<string>()
        const resultIds = new Set<string>()
        const outerCallIds = new Set<string>()
        const outerResultIds = new Set<string>()
        const scan = (m: any, calls: Set<string>, results: Set<string>) => {
          if (Array.isArray(m?.content)) for (const c of m.content) {
            if ((c?.type === 'toolCall' || c?.type === 'tool_use') && c.id) calls.add(String(c.id))
            if (c?.type === 'tool_result' && c.toolUseId) results.add(String(c.toolUseId))
          }
          if (m?.role === 'toolResult' && m.toolCallId) results.add(String(m.toolCallId))
        }
        for (const m of seg) scan(m, callIds, resultIds)
        for (let i = 0; i < tr.length; i++) { if (i >= cutFrom && i < end) continue; scan(tr[i], outerCallIds, outerResultIds) }
        for (const id of callIds) if (!resultIds.has(id) && outerResultIds.has(id)) throw new Error('该轮与相邻轮次交织（工具调用结果被插话隔开），暂不能删除')
        for (const id of resultIds) if (!callIds.has(id) && outerCallIds.has(id)) throw new Error('该轮与相邻轮次交织（工具调用结果被插话隔开），暂不能删除')
      }
      const next = [...tr.slice(0, cutFrom), ...tr.slice(end)]
      // ① 实时 agent 状态 = 下一轮真正喂模型的数组（重建整体，避免 feed 混入旧数组）
      if (Array.isArray(live) && live.length > 0) { try { dsAgent.state.messages = next.map((m: any) => m) } catch { /* read-only 时忽略 */ } }
      // ② 持久化快照
      /* ★ 0924（反馈"编辑发送会卡一会儿"）：原来这里 `JSON.parse(JSON.stringify(next))` 是
         **对整个 transcript 做深拷贝** —— 几千条消息 + 图片 dataURL 时一次拷贝就是好几 MB，
         这正是删轮/编辑发送卡顿的主因之一。消息对象在本流程里只读，浅拷贝数组已足够（结构共享）。 */
      ds.transcript = next.slice()
      // ③ DSH 累积消息（session.history 无 transcript 时的兜底展示；同口径删）
      if (Array.isArray(ds.messages)) {
        /* ★ 0924（反馈"编辑后发出去还是两条"·真凶）：
           这里原来只认 `role === 'user'`，**没跳过注入类 user 消息**（【自动续跑】等），
           而上面 ① 的 transcript 口径是**跳过注入**的 —— 两处口径不一致 ⇒ turnIndex 错位 ⇒
           **删掉了别的轮、被编辑的那条原文留在历史里**，再叠加重新发送的新消息，用户就看到两条。
           实测数据：会话里 58/59、67/72、72/73 成对出现（前 60 字相同、长度略不同 = 原文 + 编辑后版本）。
           现在与 ① 完全同口径（同样跳过注入前缀）。 */
        const dshUserIdx: number[] = []
        for (let i = 0; i < ds.messages.length; i++) {
          const m: any = ds.messages[i]
          /* ★1003 修复 4.73：与 transcript 侧同用 isInjectedUserMsg（原来只跳【自动续跑，
           * 【后台任务通知/【后台任务回访】照样计轮 ⇒ 两套口径轮数不一致 ⇒ 删错轮/编辑后出两条） */
          if (isInjectedUserMsg(m)) continue
          if (m?.role !== 'user') continue
          dshUserIdx.push(i)
        }
        if (dshUserIdx.length >= turnIndex) {
          const dStart = dshUserIdx[turnIndex - 1]
          const dEnd = turnIndex < dshUserIdx.length ? dshUserIdx[turnIndex] : ds.messages.length
          const dFrom = includeUser ? dStart : dStart + 1
          const removedDsh = ds.messages.slice(dFrom, dEnd)
          ds.messages.splice(dFrom, dEnd - dFrom)
          /* ★ 0924：删轮必须留痕 —— "编辑后还是两条"这类问题，靠这三组数字一眼判断：
             是两套口径（transcript / DSH 消息）轮数不一致导致的错位，还是压根没删到。 */
          sessionLog(sessionId, 'info', 'llm', `删轮留痕：turnIndex=${turnIndex}｜transcript 真实用户轮=${userIdx.length}（删 ${removedCount} 条，区间 ${cutFrom}~${end}）｜DSH 用户轮=${dshUserIdx.length}（删 DSH ${removedDsh.length} 条）｜includeUser=${includeUser}`)
          // 该轮 turnMetas 一并移除（ts 锚点匹配被删 assistant 消息）
          if (Array.isArray(ds.turnMetas) && removedDsh.length) {
            const tsSet = new Set(removedDsh.map((m: any) => Number(m.timestamp)).filter(Boolean))
            ds.turnMetas = ds.turnMetas.filter((t: any) => !tsSet.has(Number(t.ts)))
          }
        }
      }
      // ④ fileHistory 轮次号重编号：删掉第 N 轮后，后面的轮次序号整体 -1（撤销面板轮号不串位）
      //    被删轮的文件变更不动（文件已落盘，撤销面板仍可回退它们），只把 turnIndex > N 的减 1
      if (ds.workDir) {
        try {
          const changes = listChanges(ds.workDir)
          let touched = false
          for (const ch of changes) {
            if (typeof ch.turnIndex === 'number' && ch.turnIndex > turnIndex) { ch.turnIndex -= 1; touched = true }
          }
          if (touched) saveChanges(ds.workDir, changes)
        } catch { /* 历史文件缺失不影响删除 */ }
      }
      ds.updatedAt = Date.now()
      schedulePersist()
      sessionLog(sessionId, 'info', 'lifecycle', `删除轮次 #${turnIndex}（${includeUser ? '含用户消息' : '仅 AI 回复'}，移除 ${removedCount} 条）`)
      return { ok: true, removed: removedCount, includeUser, turnIndex }
    }

    // ── 全局设置（data/settings.json；前端与 AI 共用） ──

    case 'settings.get': {
      const payload: any = JSON.parse(JSON.stringify(globalSettings))
      // 0917：用户还没选过存储目录 → 回传按「当前用户主目录」算出的默认值。
      // 前端原本写死 C:/Users/Administrator/... —— 换用户名/换机后指向不存在的目录。
      if (!String(payload.storagePath || '').trim()) payload.storagePath = defaultStorageRoot()
      return { settings: payload }
    }

    case 'settings.update': {
      const patch = p?.settings
      if (!patch || typeof patch !== 'object') throw new Error('settings required')
      // 只允许白名单字段，避免任意注入
      /* ★0927 N1：新增设置项必须同步加进这张白名单，否则前端改了**静默不生效**
         （实测踩坑：cancelQueueMode 不在白名单 → 设置页切成"按住队列"后 session.queue.mode 仍是 continue）。 */
      const allowed = ['userName', 'nisName', 'avatar', 'prompt', 'storagePath', 'autoRepair', 'logLevel', 'sessionTitle', 'envDir', 'themeMode', 'themeLightStart', 'themeLightEnd', 'fontSize', 'bubbleAvatar', 'bubbleRadius', 'contextCompaction', 'contextCompactThresholdPct', 'contextKeepPct', 'disabledSkills', 'skillAutoSelect', 'archiveTranscriptMd', 'cancelQueueMode', 'autoContinueRounds', 'turnTokenBudget', 'memberRunLimitMinutes', 'memberInspector', 'historyMaxPerSession', 'historyAutoCleanEnabled', 'historyAutoCleanThresholdMb', 'historyAutoCleanPct', 'cmdShell', /* ★1012ak：补 busySendMode —— 前端设置页能拨、后端却不在白名单 ⇒ 改了静默不生效、跨端也不同步（实测：后端 settings.get 返回体里根本没有这个键）。 */ 'busySendMode', 'devMode', 'lazyHistory', 'bgAutoResume', 'bgAutoResumeMax', 'bgWatchAutoWake', 'fsReadMaxChars', 'extPresetContext', 'questionTimeoutSec', 'foldProcessOnDone', /* ★1010：过程折叠三档（full/tools/all）—— 不加进白名单会静默不生效（0927 踩过） */ 'processFoldMode', /* ★1010f：Agent Reach 代理（技能弹窗里填；服务端跑 ar.cmd 时注入 HTTP_PROXY/HTTPS_PROXY） */ 'agentReachProxy', /* ★1012m：工作纪律（设置→人格 的开关；开启才在 system 里注入"判断与纠错原则"） */ 'criticDiscipline']
      for (const key of Object.keys(patch)) {
        if (allowed.includes(key)) {
          globalSettings[key] = patch[key]
        }
      }
      // 0911：历史配额改完即生效（此前只在启动时读取——设置页滑杆改了要到重启才生效）
      try { setHistoryQuota((globalSettings as any).historyMaxPerSession) } catch { /* ignore */ }
      bumpSettingsVersion()
      persistSettings()
      // 0921b：环境目录改了要立刻同步给浏览器引擎（+ 子进程 env），否则启动还按旧目录找内核
      try {
        const dirNow = envInstallDir()   // ★ 0921c：同启动处 —— 用有效目录（含默认回落），设置改空/改值都即时同步
        if (dirNow) process.env.PLAYWRIGHT_BROWSERS_PATH = dirNow
        browserEngine.setBrowserEnvDir(dirNow)
      } catch { /* ignore */ }
      // 广播设置更新：前端立即同步（AI 改名后设置界面/聊天气泡实时更新）
      broadcastHost({ type: 'host/settings-updated', settings: JSON.parse(JSON.stringify(globalSettings)) })
      return { ok: true, settings: JSON.parse(JSON.stringify(globalSettings)) }
    }

    /* ── 定时任务（0912 十二批）── */
    case 'task.list': {
      // 顺带带上每个任务的「支线清单」（0912 十九批）—— 卡片上的「查看列表」直接渲染它
      return { tasks: listTasks().map(t => ({ ...t, branches: taskBranches(t) })) }
    }

    case 'task.create': {
      const t = createTask({
        name: p?.name, prompt: p?.prompt, targetSessionId: p?.targetSessionId,
        schedule: p?.schedule, enabled: p?.enabled, notifyTargets: p?.notifyTargets,
        modelMode: p?.modelMode, modelId: p?.modelId, modelProviderId: p?.modelProviderId, modelEffort: p?.modelEffort,
      })
      return { ok: true, task: t }
    }

    case 'task.update': {
      const t = updateTask(String(p?.id || ''), {
        name: typeof p?.name === 'string' ? p.name : undefined,
        prompt: typeof p?.prompt === 'string' ? p.prompt : undefined,
        targetSessionId: typeof p?.targetSessionId === 'string' ? p.targetSessionId : undefined,
        schedule: p?.schedule,
        enabled: typeof p?.enabled === 'boolean' ? p.enabled : undefined,
        notifyTargets: Array.isArray(p?.notifyTargets) ? p.notifyTargets : undefined,
        modelMode: p?.modelMode, modelId: p?.modelId, modelProviderId: p?.modelProviderId, modelEffort: p?.modelEffort,
      })
      if (!t) throw new Error('任务不存在')
      return { ok: true, task: t }
    }

    /**
     * 可选的「完成后通知」目标（0912 十三批）—— 只列**已经聊过**的通道对端。
     *
     * 为什么只列这些：推送必须知道对端 id（QQ=openid / 微信=user_id），
     * 而这个 id 只有对方先发过消息才拿得到；只配了机器人但没聊过 → 无法主动推送。
     */
    case 'task.notifyTargets': {
      const out = enumerateChannelPeers()
      /**
       * 「列表通知」位置（0912 十九批）：不属于任何 IM 账号，但也是一个独立的推送位置 ——
       * 选了它 → 通知只落一条带 ⏰ 的支线在对话列表里等我（不打扰 IM、零额度消耗）。
       * 放在最前面（它最常用、也最不挑条件）。
       */
      out.unshift({
        channel: 'list',
        botId: '',
        peerId: '',
        kind: 'list',
        botName: '',
        peerLabel: '列表通知',
        groupKey: 'list',
        groupLabel: '列表通知',
        label: '列表通知',
        lastAt: 0,
      })
      return { targets: out }
    }

    case 'task.remove': {
      const tid = String(p?.id || '')
      /**
       * 删除任务 → **同步带走它的专属会话**（0912 十七批，用户要求）。
       * 这些会话是任务自动建的（标题带 ⏰），任务没了就没人再引用它们 ——
       * 留着只是垃圾，而且用户没法从别处删（故意：专属会话只能随任务一起删）。
       */
      const own = getTaskOwnSessionIds(tid)
      if (!removeTask(tid)) throw new Error('任务不存在')
      try { clearNoticesByTask(tid) } catch { /* 台账清理失败不影响删除 */ }
      let removed = 0
      for (const sid of own) {
        try {
          if (!sessions.has(sid)) continue
          agents.get(sid)?.abort()
          agents.delete(sid)
          clearReplyTargets(sid)
          clearInboundContext(sid)
          removeLinkBySession(sid)
          sessions.delete(sid)
          broadcastHost({ type: 'host/session-removed', sessionId: sid })
          removed += 1
        } catch { /* 单个删除失败不影响整体 */ }
      }
      if (removed) { schedulePersist(); console.log(`[scheduledTasks] 删除任务同时清理 ${removed} 条专属会话`) }
      return { ok: true, removedSessions: removed }
    }

    case 'task.runNow':
      // 手动立即执行一次（不改变原排期）
      return await runTaskNow(String(p?.id || ''))

    /**
     * 定时任务支线：放进 / 移出**主对话列表**（0912 十九批）。
     * 放回 = inMainList=false —— 会话仍在（任务卡片、独享对话里都能打开），只是不在主列表碍眼。
     */
    case 'task.sessionInList': {
      const sid = String(p?.sessionId || '')
      const s = sessions.get(sid)
      if (!s) throw new Error('会话不存在')
      if (!s.taskId) throw new Error('这不是定时任务的专属对话')
      const want = p?.inList === true
      if (s.inMainList !== want) {
        s.inMainList = want
        // ★ 0922z2b：与通道会话同口径 —— 放进主列表就打点（排序置顶），放回即作废
        s.movedInAt = want ? Date.now() : undefined
        schedulePersist()
        broadcastHost({ type: 'host/session-renamed', sessionId: sid, title: s.title })
      }
      return { ok: true, sessionId: sid, inList: want }
    }

    case 'session.delete': {
      if (!sessionId) throw new Error('sessionId required')
      /**
       * 定时任务支线不允许直接删（0912 十九批，用户要求）：
       * 它的生命周期跟着任务走 —— 删了任务才删它，否则任务卡片上会指向一条不存在的对话。
       * （任务内部清理走 task.remove，不经这条 RPC。）
       */
      const delGuard = sessions.get(sessionId)
      if (delGuard?.taskId) throw new Error('这是定时任务的专属对话，不能单独删除；请删除对应的定时任务')
      const agent = agents.get(sessionId)
      if (agent) agent.abort()
      // 工作区处置（孤儿 bug 修复）：purge（滞留到期/彻底删除）时连工作区一起删，
      // 滞留软删（deleteWorkdir!=true）时保留工作区供恢复。workDir 在 sessions.delete 前取
      const delSession = sessions.get(sessionId)
      const delWorkDir = delSession?.workDir?.trim() || ''
      const deleteWorkdir = p?.deleteWorkdir === true
      sessions.delete(sessionId)
      agents.delete(sessionId)
      turnAccumulators.delete(sessionId)
      muxClients.delete(sessionId)
      clearPendingApprovals(sessionId)
      clearPendingQuestions(sessionId)
      clearBlackboard(sessionId)
      bumpMemberDmGeneration(sessionId)
      abortMemberDm(sessionId)
      abortSubAgents(sessionId)
      clearMemberChats(sessionId)
      // 0912 接入批：清理通道映射与待回推目标（避免指向已删会话）
      try { removeLinkBySession(sessionId) } catch { /* ignore */ }
      clearReplyTargets(sessionId)
      clearInboundContext(sessionId)
      schedulePersist()
      broadcastHost({ type: 'host/session-removed', sessionId })
      /* ★ 0921 修「滞留处彻底删除后，工作区文件没跟着删」（实测）：
         原判断把目录名写死成 dev 的 `NisData` —— 正则 `/[/\\]NisData[/\\]chat_[\w-]+$/`
         只有"存储根恰好叫 NisData"才成立；而**打包版**的存储根是 `<安装目录>\data\storage`
         ⇒ 这个分支在打包版永远不成立，工作区文件就留下来了。
         改成**按当前存储根判断**：必须是 storageRootNow() 直属的 chat_* 目录才敢删
         （用路径前缀 + basename 双校验，防误删目录外的东西）。 */
      const storeRoot = path.resolve(storageRootNow())
      const wdAbs = delWorkDir ? path.resolve(delWorkDir) : ''
      const wdOk = !!wdAbs
        && wdAbs.startsWith(storeRoot + path.sep)
        && /^chat_[\w-]+$/.test(path.basename(wdAbs))
      if (deleteWorkdir && wdOk) {
        try {
          fs.rmSync(wdAbs, { recursive: true, force: true })
          sessionLog(sessionId, 'info', 'lifecycle', `[清理] 会话工作区已随会话删除：${wdAbs}`)
        } catch (e: any) {
          console.error('[session.delete] workdir cleanup failed:', e?.message || e)
        }
      }
      return { ok: true }
    }

    case 'session.cancel': {
      /* ★1001 外部轮取消：杀 codex 子进程（adapter 的 AbortSignal） */
      const _ext = externalRuns.get(String(sessionId || ''))
      if (_ext) { try { _ext.abort() } catch { /* ignore */ } }
      // 停止生成：只 abort agent 并清理流式状态，不删除会话
      if (!sessionId) throw new Error('sessionId required')
      /* ★ 0923：用户按「停止」= 该会话的后台自动续跑链暂停（尊重「我不想它再自己跑」）；
         待续跑事件退回「下次发话补送」通道，信息不丢。 */
      {
        const c = bgResumeChains.get(sessionId)
        if (c) { c.stopped = true; parkBgResumePending(sessionId) }
      }
      const session = sessions.get(sessionId)
      const agent = agents.get(sessionId)
      // 中断前快照当前消息到 transcript：否则 agent 丢弃后重建时丢上下文
      // （用户中断卡住的安装 → 让 AI 继续时它不知道刚才在干什么）
      if (agent && session) {
        try {
          const live = agent?.state.messages
          if (Array.isArray(live) && live.length > (session.transcript?.length || 0)) {
            const snap = JSON.parse(JSON.stringify(live))
            // 修补悬空 toolCall：中断发生在工具执行中时，消息序列末尾存在没有 toolResult 的 toolCall，
            // 直接回填会导致下次 LLM 调用格式非法（AI"接不上"）。补一条中断结果让上下文完整。
            const answered = new Set(snap.filter((m: any) => m.role === 'toolResult').map((m: any) => m.toolCallId))
            for (const m of snap) {
              if (m.role === 'assistant' && Array.isArray(m.content)) {
                for (const c of m.content) {
                  if (c.type === 'toolCall' && c.id && !answered.has(c.id)) {
                    snap.push({
                      role: 'toolResult', toolCallId: c.id, toolName: c.name,
                      content: [{ type: 'text', text: '[中断] 用户停止了本次执行，该操作未完成' }],
                      timestamp: Date.now(),
                    })
                  }
                }
              }
            }
            session.transcript = snap
            schedulePersist()
            sessionLog(sessionId, 'warn', 'lifecycle', '用户中断：已保存当前进度上下文，可继续对话接上')
          }
        } catch { /* ignore */ }
      }
      if (agent) agent.abort()
      // 0909⑦改：停止时保住未注入的插话/追问——pi 的 steering/followUp 队列在 agent 对象上，
      // agents.delete 后随对象丢弃 = 用户插话静默消失（0909 实锤：插话注入前点停止，刷新后消息不见了）。
      // drain 出来追加到 transcript 快照尾部（都是 role:'user' 消息，下轮续聊语义正确衔接）。
      // ⚠ one-at-a-time 模式 drain() 一次只出队一条 → 循环抽干。
      try {
        const leftover: any[] = []
        for (const q of [(agent as any)?.steeringQueue, (agent as any)?.followUpQueue]) {
          for (let i = 0; i < 20 && q?.hasItems?.(); i++) leftover.push(...(q.drain() || []))
        }
        if (leftover.length && session) {
          session.transcript = [...(session.transcript || []), ...leftover]
          sessionLog(sessionId, 'info', 'lifecycle', `中断时保留未注入插话 ${leftover.length} 条入上下文`)
          schedulePersist()
        }
      } catch { /* ignore */ }
      // 中断轮统计口径（B3）：usage 块在流末尾，中断时根本没发过来——本轮无权威数据。
      // lastUsage 回退 transcript 最后一条真实 usage（上下文圆环保持真实值，不跳字符估算）；
      // lastTurnTiming/modelUsage 不覆盖（旧 usage + 中断时刻 timing 混搭会稀释 tok/s）。
      // 注意这里不能依赖 agent_end（cancel 已把 agent 从 map 删除，订阅守卫会丢弃其事件）
      if (session) {
        const liveMsgs = agent?.state.messages
        const prevUsage = findLastRealUsage(Array.isArray(liveMsgs) ? liveMsgs : (session.transcript || []))
        if (prevUsage) session.lastUsage = prevUsage
      }
      agents.delete(sessionId)
      turnAccumulators.delete(sessionId)
      clearPendingApprovals(sessionId)
      // 成员单聊中断：作废本轮记录回写（迟到结果丢弃）+ abort 在途控制器；主/派发 agent 由 abortSubAgents 处理
      bumpMemberDmGeneration(sessionId)
      abortMemberDm(sessionId)
      abortSubAgents(sessionId)
      // 挂起的询问卡（ask_user 工具在等回答）也要解除：resolve 超时值让工具立刻返回，
      // 否则工具 execute 永远挂着 → agent 无法中止 →「点停止停不掉」（★0927 R14 收拢成 helper）
      clearPendingQuestions(sessionId)
      if (session) session.status = 'idle'
      broadcastHost({ type: 'host/session-status', sessionId, running: false })
      broadcastMux(sessionId, { type: 'session/status', sessionId, running: false, stopped: true })
      /* ★0929 P1（cancel 补收尾，与 0927 撞墙收尾/agent_end 三件套对齐）：cancel 把 agent
         从 map 删除 ⇒ 订阅守卫丢弃本轮 agent_end ⇒ 它里面的两件收尾永远没做：
         ① shiftReplyTarget：IM 通道回推 FIFO 不消费 → **永久错位一位**（后续每轮拿旧
            messageId/contextToken，被动回信必失败烧额度）；
         ② consumeTurnShots：本轮截图清单不消费 → 下一轮把旧截图**重复补发**到 IM。
         （本路径 broadcastHost 已有，补齐后三件套与 agent_end 路径完全一致。） */
      try {
        const _cancelRt = shiftReplyTarget(sessionId)
        void _cancelRt   // 中断轮无收尾正文可回推，仅按 FIFO 消费目标防错位
        /* ★1014b：本轮若开过 QQ 流 → 必须收流（发终帧），否则 QQ 侧那条消息永远停在"生成中" */
        qqStreamAbort(sessionId, '本轮被停止')
        consumeTurnShots(sessionId)
      } catch { /* 收尾失败不拦停止 */ }
      /* ★0927 N1（核心修复）：**用户主动停止时的队列处置**。
         旧病：cancel 里 agents.delete ⇒ agent_end 被订阅守卫丢弃 ⇒ 队列唯一触发点失效
         ⇒ 排队消息永远发不出去（实测：入队后 8s 按停止=卡死）；且直发 prompt 不看队列 ⇒ 新消息插队。
         现在按拍板语义走（丙 唯一一条退回输入框 / 甲 继续按序发 / 乙 暂停+一键继续）。 */
      handleUserCancelQueue(sessionId)
      return { ok: true }
    }

    /* ★0927（已定案 ①b）：**标记会话已读** —— 前端"点开会话 / 正在看的会话跑完一轮"时调用。
       未读的权威口径就此落到后端并随会话持久化（刷新页面/重开窗口不再丢未读）。
       可传 `at`（服务端时间之外的显式时间点，一般不用）。 */
    case 'session.markRead': {
      if (!sessionId) throw new Error('sessionId required')
      const s = sessions.get(sessionId)
      if (!s) throw new Error('session not found')
      const at = Number(p?.at) > 0 ? Number(p.at) : Date.now()
      // 只前进不后退（多窗口乱序调用不会把已读时间拉回去，也就不会重新冒出未读）
      if (!(Number(s.lastReadAt) >= at)) {
        s.lastReadAt = at
        schedulePersist(sessionId)
      }
      return { ok: true, lastReadAt: s.lastReadAt, unread: unreadCountOf(s) }
    }

    case 'session.permission': {
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      return { mode: session.permissionMode || 'confirm' }
    }

    case 'session.setPermission': {
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const mode = p?.mode as string | undefined
      /* ★1003 修复 4.75：① 改完必须 schedulePersist——原缺失，权限档只落内存，重启/重载静默回滚旧值；
       * ② 非法 mode 如实抛错——原静默返回 ok:true 且沿用旧值，调用方无从感知设置失败 */
      if (!mode || !['confirm', 'self_audit', 'full_access'].includes(mode)) {
        throw new Error(`非法权限档位：${JSON.stringify(mode)}（可选：confirm / self_audit / full_access）`)
      }
      session.permissionMode = mode as PermissionMode
      schedulePersist(sessionId)
      return { ok: true, mode: session.permissionMode }
    }

    /* 0920：工作模式（计划/构建/默认）——与权限模式一样按会话存；实际生效方式见 buildModeHint() */
    case 'session.setMode': {
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const mode = p?.mode as string | undefined
      if (mode && ['default', 'plan', 'build', 'goal'].includes(mode)) {
        session.mode = mode
        schedulePersist()
        sessionLog(sessionId, 'info', 'lifecycle', `工作模式切换 → ${mode}`)
      }
      return { ok: true, mode: session.mode || 'default' }
    }

    case 'session.approval': {
      // 前端审批应答：requestId + choice（允许/拒绝）
      const requestId = p?.requestId ?? p?.request_id as string | undefined
      const choice = p?.choice as string | undefined
      if (!requestId) throw new Error('requestId required')
      if (!choice) throw new Error('choice required')
      const pa = pendingApprovals.get(requestId)
      if (!pa) {
        return { ok: true, stale: true }
      }
      pa.resolve(choice)
      return { ok: true }
    }

    case 'session.questionAnswer': {
      // 前端询问卡应答：requestId + value
      const requestId = p?.requestId ?? p?.request_id as string | undefined
      const value = p?.value as string | undefined
      if (!requestId) throw new Error('requestId required')
      if (!value) throw new Error('value required')
      const pq = pendingQuestions.get(requestId)
      if (!pq) return { ok: true, stale: true }
      clearTimeout(pq.timer)
      pq.resolve(value)
      return { ok: true }
    }

    // ── 产出物文件操作（用户点击触发的本地文件打开，不走 AI 权限门禁） ──

    case 'fs.reveal': {
      // 打开所在目录：文件用 explorer /select 选中，目录直接打开
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      /* ★1004q（实测反馈"右键打开所在目录没弹窗"）：变更记录的 relPath 跨盘符时是**绝对路径**，
         resolveWorkdirPath 的工作区越界拦截会拒掉它 —— reveal 只是打开资源管理器（无内容面），
         绝对路径直接用；相对路径仍走工作区解析（越界拦截保留）。 */
      const rawPath = String(p?.path || '')
      const target = path.isAbsolute(rawPath) ? path.normalize(rawPath) : resolveWorkdirPath(session, rawPath)
      let args: string[]
      try {
        const st = fs.statSync(target)
        args = st.isDirectory() ? [target] : [`/select,${target}`]
      } catch {
        args = [`/select,${target}`]
      }
      await new Promise<void>((resolve) => {
        execFile('explorer.exe', args, () => resolve())
      })
      return { ok: true, path: target }
    }

    case 'fs.openInBrowser': {
      // 系统默认程序打开（html→默认浏览器；其他→关联程序）
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const target = resolveWorkdirPath(session, p?.path)
      await new Promise<void>((resolve) => {
        // 0906 加固补漏：cmd /c start 的字符串解析层可被含 & " 的文件名注入命令；
        // explorer.exe 直传路径无解析层（参数注入封死），默认程序关联行为一致
        execFile('explorer.exe', [target], () => resolve())
      })
      return { ok: true, path: target }
    }

    case 'fs.readFile': {
      // 预览：读文件内容（文本截断保护 / base64 二进制）
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const target = resolveWorkdirPath(session, p?.path)
      const encoding = p?.encoding === 'base64' ? 'base64' : 'utf8'
      if (encoding === 'base64') {
        const raw = await fs.promises.readFile(target)
        return { ok: true, path: target, data: raw.toString('base64'), size: raw.byteLength }
      }
      const maxChars = typeof p?.maxChars === 'number' ? p.maxChars : 20000
      const content = await fs.promises.readFile(target, 'utf8')
      const chars = Math.min(content.length, maxChars)
      return { ok: true, path: target, content: content.slice(0, chars), truncated: chars < content.length }
    }

    case 'fs.statFile': {
      // 0914 精准打击③：预览刷新轮询——轻量返回工作区文件 mtime/大小（文件不在也 ok:false 不抛）
      if (!sessionId) throw new Error('sessionId required')
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      const target = resolveWorkdirPath(session, p?.path)
      try {
        const st = await fs.promises.stat(target)
        return { ok: true, path: target, mtimeMs: st.mtimeMs, size: st.size }
      } catch {
        return { ok: false, path: target }
      }
    }

    // 0914 精准打击：拖入的非工作区文件入库到工作区「外部文件/」子目录
    case 'fs.importExternalFile': {
      // 场景：非工作区文件（如桌面拖进来的 html）预览并拾取元素后，让 AI 能按路径直接修改。
      // 做法：内容原样复制进 <workdir>/外部文件/，返回工作区相对路径（元素标签与 AI fs 工具共用此路径）。
      // 同名文件：内容一致复用（重复拖入不产生副本）；内容不同自动加序号（不覆盖既有副本、不丢 AI 改动）。
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session) throw new Error('session not found')
      const wd = (session.workDir || '').trim()
      if (!wd) throw new Error('该对话未设置工作区，无法导入外部文件')
      const content = String(p?.content ?? '')
      if (!content) throw new Error('content required')
      if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) throw new Error('文件过大（>5MB），暂不支持导入')
      let name = path.basename(String(p?.name || '')).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim()
      if (!name) name = 'external-' + Date.now() + '.html'
      const nameExt = path.extname(name)
      if (name.length > 120) name = name.slice(0, 120 - nameExt.length) + nameExt
      const dirRel = '外部文件'
      const dirAbs = path.join(wd, dirRel)
      await fs.promises.mkdir(dirAbs, { recursive: true })
      const stem = nameExt ? name.slice(0, -nameExt.length) : name
      let finalName = ''
      for (let i = 1; i <= 50; i++) {
        const cand = i === 1 ? name : stem + '-' + i + nameExt
        const full = path.join(dirAbs, cand)
        if (!fs.existsSync(full)) { finalName = cand; break }
        try {
          if (fs.readFileSync(full, 'utf8') === content) {
            return { ok: true, path: dirRel + '/' + cand, name: cand, reused: true }
          }
        } catch { /* 读失败按「不相等」处理，换名继续 */ }
      }
      if (!finalName) throw new Error('同名文件过多，请先清理「外部文件」目录')
      await fs.promises.writeFile(path.join(dirAbs, finalName), content, 'utf8')
      const rel = dirRel + '/' + finalName
      sessionLog(sessionId || String(p?.sessionId || ''), 'info', 'tool', '[用户] 导入外部文件：' + rel)
      return { ok: true, path: rel, name: finalName, reused: false }
    }

    // ── AI 提炼 / 记忆提炼（0911 接通：原前端走 WS AI_EXTRACT / MEMORY_EXTRACT 死通道） ──
    /* ★1013c（已定案："以前可以选用全局模型的，都要换成后台模型"）：这两条也不再用"全局聊天模型"兜底 ——
       前端没传 model 时改走**后台模型**；后台模型没配就明确报错 + needModel（让 UI 引导去设置里选）。 */
    case 'ai.extract': {
      const _ov = p?.model || backgroundLlmCfg()
      if (!_ov) return { ok: false, needModel: true, llm_used: false, fields: emptyExtractFields(), msg: backgroundLlmConfig().reason }
      return await aiExtractDirect(String(p?.sourceType || 'text'), String(p?.content || ''), _ov)
    }

    case 'memory.extract': {
      const _ov = p?.model || backgroundLlmCfg()
      if (!_ov) return { ok: false, saved: 0, items: [], needModel: true, msg: backgroundLlmConfig().reason }
      return await memoryExtractDirect(
        String(p?.content || ''),
        String(p?.projectRoot || ''),
        !!p?.dryRun,
        _ov,
        !!p?.auto,
      )
    }

    case 'memory.extractCommit':
      return await memoryExtractCommitDirect(p?.items, String(p?.projectRoot || ''))

    case 'memory.conflictResolve':
      return await memoryConflictResolveDirect(p || {})

    case 'knowledge.extract': {
      const _ov = p?.model || backgroundLlmCfg()   // ★1013c：兜底 = 后台模型（不再用全局聊天模型）
      if (!_ov) return { ok: false, entries: [], needModel: true, msg: backgroundLlmConfig().reason }
      return await knowledgeExtractDirect(
        String(p?.content || ''),
        String(p?.projectRoot || ''),
        !!p?.dryRun,
        _ov,
      )
    }

    case 'knowledge.extractCommit':
      return await knowledgeExtractCommitDirect(p?.items)

    // ── 版本保底（设置页「版本保底」页）：桥接 _release.mjs 引擎 ──
    case 'release.state': {
      const r = await runReleaseCmd(['state'])
      if (!r.ok) throw new Error(r.output || '版本保底状态读取失败')
      try { return { ...JSON.parse(r.output), op: releaseOp } } catch { throw new Error('状态解析失败：' + r.output.slice(0, 200)) }
    }

    case 'release.snapshot': {
      const label = String(p?.label || '').trim().slice(0, 40) || '手动快照'
      const r = await withReleaseOp('snapshot', label, () => runReleaseCmd(['snapshot', label, '--note', String(p?.note || '设置页快照').slice(0, 120)], 900000))
      return { ok: r.ok, log: r.output }
    }

    case 'release.rollback': {
      const name = String(p?.name || '').trim()
      if (!name || /[\\/]|\.\./.test(name)) throw new Error('快照名非法')
      const r = await withReleaseOp('rollback', name, () => runReleaseCmd(['rollback', name, '--yes'], 1800000))
      return { ok: r.ok, log: r.output }
    }

    /* 1010：删除还原点（二级确认在前端做；这里只校验名字合法性 → 引擎 rm --yes 真删文件） */
    case 'release.delete': {
      const name = String(p?.name || '').trim()
      if (!name || /[\\/]|\.\./.test(name)) throw new Error('快照名非法')
      const r = await withReleaseOp('delete', name, () => runReleaseCmd(['rm', name, '--yes'], 300000))
      return { ok: r.ok, log: r.output }
    }

    // ── 数据备份（0915）：整包导出 / 导入 —— 设置→通用「数据备份」 ──
    /* ══ 数据备份（0915 初版 / **0919 改造成勾选式**）══════════════════════════
     * 设计口径："记忆和知识库也是数据；导出应该覆盖它们；导入要能**只导某几部分**"。
     *   · 导出：传 parts（不传 = 全选，老前端仍可用）；manifest 里逐部分记成员清单/体积/文件数。
     *   · 导入：先 data.importInspect 只读 manifest（不解包）→ 前端列出来勾选 → importApply 只解勾中的。
     *   · 覆盖前把旧的整份改名 `.bak-<时间戳>`（可回退；与记忆库导入的老做法一致）。
     *   · 导入"设置"时**剔除 storagePath / envDir** —— 那是本机路径，导进来就会改掉用户的存储位置。
     * ⚠️ 不再"整包切数据目录"：现在只往**当前安装**的对应位置落文件（配置里的 dataDir 不动）。 */
    case 'data.exportAll': {
      // 0915：支持指定导出目录（用户点「导出全部数据」时先选位置；不传则回落后端默认 exports/）
      const wantDir = typeof p?.dir === 'string' ? (p.dir as string).trim() : ''
      /* ★ 0930 导出口令（已定案）：填了口令 → 包里额外带一份**口令加密**的密钥，
         换电脑输同一句即可恢复；不填 → manifest 记 portableKeys=null，由前端**明确拦一下**
         告诉用户"这个包到了别的电脑上密钥用不了"，不静默放行。*/
      const passphrase = String(p?.passphrase || '').trim()
      let portable: { sealed: number; failed: string[]; weak?: boolean; error?: string } | null = null
      const outDir = wantDir ? wantDir : path.join(dataParentDir(), 'exports')
      fs.mkdirSync(outDir, { recursive: true })
      const zipPath = path.join(outDir, 'nis-' + backupStamp() + '.tar.gz')
      const stage = path.join(dataParentDir(), '.nis-export-stage')
      fs.rmSync(stage, { recursive: true, force: true })
      fs.mkdirSync(stage, { recursive: true })

      const roots = {
        data: path.resolve(DATA_ROOT),
        storage: path.resolve(storageRootNow()),
        skills: path.resolve(SKILLS_ROOT),
        memory: path.resolve(currentMemoryDir()),
      }
      const want = Array.isArray(p?.parts) && (p.parts as any[]).length
        ? (p.parts as any[]).map(String)
        : DATA_PARTS.map((x) => x.id)
      const chosen = DATA_PARTS.filter((x) => want.includes(x.id))

      /* ★1011 诊断日志（老大实测：导出时填了口令，包里却没有密钥，manifest 的 portable 还是 null）。
         这类"填了却没生效"必须能事后查 —— 记下**当时的**口令长度、数据根、两把密钥文件在不在、
         选了哪些部分。下次导出后直接看 logs/export.log 就能定位，不用再猜。
         ⚠️ 只记口令**长度**，绝不记口令本身。 */
      const probe = ['providers.json', 'websearch.json'].map((n) => {
        const f = path.join(roots.data, n)
        try { const s = fs.statSync(f); return n + '=' + (s.isFile() ? s.size + 'B' : '非文件') } catch { return n + '=缺失' }
      }).join(' ')
      const diag = (msg: string) => {
        try {
          const d = path.join(dataParentDir(), 'logs')
          fs.mkdirSync(d, { recursive: true })
          fs.appendFileSync(path.join(d, 'export.log'),
            '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8')
        } catch { /* 日志失败不影响导出 */ }
      }
      diag('exportAll 开始: passphrase长度=' + passphrase.length
        + ' | parts=' + (p?.parts ? (p.parts as any[]).join(',') : '(全部)')
        + ' | chosen=' + chosen.map((x) => x.id).join(',')
        + ' | dataRoot=' + roots.data
        + ' | ' + probe
        + ' | storage=' + roots.storage + ' memory=' + roots.memory + ' skills=' + roots.skills)

      // 每个部分 → tar 成员；并统计体积/文件数供 manifest 用
      //   arc = 包内的成员路径（`<根目录名>/<条目>`）。**必须记进 manifest** —— 导入端拿它解包，
      //   否则换台机器（存储目录名不同，如 NisData ↔ niscs）就对不上了。
      type Member = { root: keyof typeof roots; name: string; arc?: string; sealed?: boolean }
      const partInfo: Record<string, { label: string; bytes: number; files: number; members: Member[] }> = {}
      const args: string[] = ['-czvf', zipPath, '-C', stage, 'nis-manifest.json']
      for (const part of chosen) {
        const members: Member[] = []
        let bytes = 0
        let files = 0
        for (const src of part.src) {
          const absRoot = roots[src.root]
          if (!absRoot || !fs.existsSync(absRoot)) continue
          for (const ent of src.entries) {
            const names = ent.endsWith('*')
              ? fs.readdirSync(absRoot).filter((n) => n.startsWith(ent.slice(0, -1)))
              : [ent]
            for (const name of names) {
              const abs = path.join(absRoot, name)
              if (!fs.existsSync(abs)) continue
              /* ⚠️ dirStats 对**文件**路径会返回 exists:false（readdirSync 抛 ENOTDIR）→
               * 旧写法这里把 settings.json 这类单文件成员的体积算成 0，清单里显示的"体积"偏小。
               * 现在单独补一次 statSync。 */
              const st = dirStats(abs)
              if (st.exists) {
                bytes += st.bytes
                // 进度分母要跟 `tar -v` 的行数对齐：目录也各占一行，所以 files + dirs，
                // 再加 1 = 这个成员自己的那一行（tar 会打 `sessions/` 这种根行）。
                files += st.files + st.dirs + 1
              } else {
                try {
                  const s2 = fs.statSync(abs)
                  if (s2.isFile()) { bytes += s2.size; files += 1 }
                } catch { /* 读不到就按 1 项记 */ files += 1 }
              }
              /* ★ 0930 导出口令：密钥文件改打**加工副本**（stage 内加口令副本后再入包），
                 真实文件不进包；manifest 里的 arc 保持 `data/<name>` 不变，
                 解包端照旧按它取，无需改动导入路径逻辑。
                 ★ 1001：websearch.json（搜索 key）与 providers.json 同档处理 —— 两者都是
                 "本机 DPAPI 密文"，换机必废，所以都包一份口令副本；计数**累加**（原来只认
                 providers，直接赋值会把先处理的那份计数冲掉）。 */
              if (passphrase && src.root === 'data' && (name === 'providers.json' || name === 'websearch.json')) {
                try {
                  const json = JSON.parse(fs.readFileSync(abs, 'utf8'))
                  const r = name === 'websearch.json'
                    ? sealPortableSearchKeys(json, passphrase)
                    : sealPortableKeys(json, passphrase)
                  const arcSealed = path.basename(roots.data) + '/' + name
                  const outSealed = path.join(stage, arcSealed)
                  fs.mkdirSync(path.dirname(outSealed), { recursive: true })
                  fs.writeFileSync(outSealed, JSON.stringify(json, null, 2), 'utf8')
                  const m: Member = { root: src.root, name, sealed: true, arc: arcSealed }
                  members.push(m)
                  portable = portable || { sealed: 0, failed: [] }
                  portable.sealed += Number(r.sealed || 0)
                  portable.failed = (portable.failed || []).concat(r.failed || [])
                } catch (e: any) {
                  /* ★1003 安全批 4.77：加工失败**绝不回退塞真实文件** —— 原注释"宁可包跨机器用不了"
                     只管可用性，可真 providers.json/websearch.json（DPAPI 密文/明文密钥）进包 = 钥匙外送。
                     现在失败就整个成员跳过（包里不放这份文件），失败明细进 portable.failed/error，
                     导出结果如实告警给前端（needsPassphrase/failed/error 一路带回）。 */
                  portable = portable || { sealed: 0, failed: [] }
                  portable.failed = (portable.failed || []).concat([name])
                  if (!portable.error) portable.error = String(e?.message || e).slice(0, 200)
                  console.error(`[portable] 密钥加工失败，已跳过该成员（绝不打包真实文件）：${name}:`, String(e?.message || e).slice(0, 200))
                }
                continue
              }
              members.push({ root: src.root, name })
            }
          }
        }
        if (!members.length) continue
        partInfo[part.id] = { label: part.label, bytes, files, members }
        /* ⚠️ 成员名必须带**根目录名**前缀，并配一个 `-C <该根的父目录>`。
         *    写成 `-C 父目录 <条目名>` 会少一层路径 → bsdtar 直接报
         *    "Couldn't visit directory: No such file or directory"（0919 实测踩到，导出整个不可用）。
         *    同一个根只在最前面发一次 `-C`，后面连着列成员 —— 与老版能跑通的形状一致。 */
        const byRoot = new Map<keyof typeof roots, string[]>()
        const sealedArcs: string[] = []
        for (const m of members) {
          /* ★ 0930：sealed 成员不打真实路径，改从 stage 打**同名** arc ——
             包内路径与原来一模一样，解包端完全不用改。 */
          if (m.sealed) { sealedArcs.push(m.arc || (path.basename(roots[m.root]) + '/' + m.name)); continue }
          const list = byRoot.get(m.root) || []
          m.arc = path.basename(roots[m.root]) + '/' + m.name
          list.push(m.arc)
          byRoot.set(m.root, list)
        }
        for (const [root, names] of byRoot) {
          if (names.length) args.push('-C', path.dirname(roots[root]), ...names)
        }
        for (const arc of sealedArcs) args.push('-C', stage, arc)
      }
      if (!Object.keys(partInfo).length) throw new Error('没有选中任何可导出的内容')

      fs.writeFileSync(path.join(stage, 'nis-manifest.json'), JSON.stringify({
        kind: 'nis-backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        dataRoot: roots.data,
        storageRoot: roots.storage,
        skillsRoot: roots.skills,
        memoryRoot: roots.memory,
        parts: partInfo,
        /* ★ 0930：本包有没有带口令密钥（= 到了别的电脑上密钥能不能用）。
           null = 没填口令 → 前端**明确拦一下**并告知用户，不静默放行。*/
        portableKeys: portable,
      }, null, 2), 'utf8')

      /* 0917b 进度：tar -v 每打一个条目输出一行 → 用它驱动真实进度。
       * ★ 0920 修「90%+ 卡很久」：旧写法用渐近曲线 `n/(n+260)` 并封顶 95% ——
       *   大包（上万条目）早在 n≈2000 就贴到 95%，然后**空转上万条**才结束，看着就是"卡住"。
       *   上面统计 partInfo 时已经数过每个成员的**递归文件数**（dirStats().files），
       *   直接拿总数当分母做线性进度：全程匀速、不提前贴顶。没有分母才退回旧曲线兜底。 */
      // +1 = 包里的 nis-manifest.json（tar -v 也会为它打一行）
      const totalFiles = 1 + Object.values(partInfo).reduce((a, x) => a + Math.max(1, x.files), 0)
      emitDataProgress('export', 0, '准备导出…')
      let n = 0
      const cur = { cp: null as any, cancelled: false }
      exportProc = cur
      const r = await runTarStream(args, 600000, () => {
        n++
        const pct = totalFiles > 0
          ? Math.min(99, Math.round((100 * n) / totalFiles))
          : Math.min(95, Math.round((100 * n) / (n + 260)))
        emitDataProgressThrottled('export', pct, '打包中')
      }, (cp) => { cur.cp = cp })
      exportProc = null
      fs.rmSync(stage, { recursive: true, force: true })
      // 用户点了「取消」→ 删掉半截包，按"已取消"收场（不是错误弹窗）
      if (cur.cancelled) {
        try { fs.rmSync(zipPath, { force: true }) } catch { /* 删不掉就算了，半截包也不会有 manifest */ }
        emitDataProgress('export', -1, '已取消导出')
        throw new Error('已取消导出')
      }
      if (!r.ok) { emitDataProgress('export', -1, '导出失败'); throw new Error('导出失败：' + r.output.slice(0, 300)) }
      const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0
      emitDataProgress('export', 100, '导出完成')
      diag('exportAll 结束: 包=' + path.basename(zipPath)
        + ' | portable=' + JSON.stringify(portable)
        + ' | settings成员=' + JSON.stringify((partInfo.settings?.members || []).map((m) => m.name)))
      return { ok: true, path: zipPath, sizeMb: Math.round(size / 1048576), files: n, parts: Object.keys(partInfo), portableKeys: portable }
    }

    /** 取消正在跑的导出（0920）：kill 掉 tar 子进程。
     *  exportAll 那边会删掉半截包并抛「已取消导出」，前端据此复位（不当成报错）。 */
    case 'data.cancelExport': {
      const had = !!exportProc
      if (exportProc) {
        exportProc.cancelled = true
        try { exportProc.cp?.kill() } catch { /* 可能刚好结束 */ }
      }
      return { ok: true, cancelled: had }
    }

    /** 可选部分清单（前端据此画复选框；含"默认勾选/含密钥/本机有没有"） */
    case 'data.parts': {
      return {
        parts: DATA_PARTS.map((x) => ({
          id: x.id,
          label: x.label,
          hint: x.hint || '',
          def: x.on === true,
          secrets: !!x.secrets,
          /* ★1011：明文敏感值标记 —— 前端据此分两句提示（口令护不住这类） */
          plainSecrets: !!x.plainSecrets,
        })),
      }
    }

    /** 只读包内容（**不解包**）——供导入弹窗列出"这个包里有什么"，以及哪些已经导过 */
    case 'data.importInspect': {
      const zipPath = String(p?.zipPath || '').trim()
      if (!zipPath || !fs.existsSync(zipPath)) throw new Error('数据包不存在：' + zipPath)
      const mfr = await runTar(['-xOf', zipPath, 'nis-manifest.json'], 60000)
      if (!mfr.ok) throw new Error('不是 NIS 数据包（缺清单 nis-manifest.json）')
      let mf: any = {}
      try { mf = JSON.parse(mfr.output) } catch { throw new Error('数据包清单损坏（JSON 解析失败）') }
      const size = fs.statSync(zipPath).size
      const pkgId = pkgFingerprint(zipPath, size, String(mf.exportedAt || ''))
      const hist = readImportHistory()
      const done = (hist[pkgId]?.parts || {}) as Record<string, number>
      // v1 老包没有 parts 字段 → 按"整体一份数据"呈现（保持能导，但不可细分）
      const parts = mf.parts && typeof mf.parts === 'object'
        ? Object.entries(mf.parts as Record<string, any>).map(([id, v]) => ({
            id,
            label: String(v?.label || id),
            bytes: Number(v?.bytes || 0),
            files: Number(v?.files || 0),
            /* ★ 0920：「含明文密钥」必须看**这个包里到底有没有 providers.json**，
               不能只看这个部分"通常含密钥"。老包（22:01 之前导出的）settings 只有
               settings.json + ui-state.json —— 标成"含密钥"会让用户以为密钥导进来了，
               然后对着空供应商列表发懵（用户 0919 实测）。 */
            secrets: !!DATA_PARTS.find((x) => x.id === id)?.secrets
              && ((v?.members || []) as Array<{ name?: string }>)
                .some((m) => String(m.name || '').toLowerCase() === 'providers.json'),
            importedAt: done[id] || 0,
          }))
        : [{ id: '__all__', label: '整包数据（老版本导出，不可细分）', bytes: 0, files: 0, secrets: true, importedAt: 0 }]
      /* ★ 0930：告诉前端这个包**带不带口令密钥**（= 到了别的电脑上密钥能不能用）。
         带了就由前端弹口令输入框；老包没有这个字段 → null，前端按"无口令包"处理，不打断。*/
      const portable: any = (mf as any).portableKeys || null
      const needsPassphrase = !!(portable && Number(portable.sealed || 0) > 0)
      return { ok: true, zipPath, pkgId, exportedAt: String(mf.exportedAt || ''), version: Number(mf.version || 1), sizeMb: Math.round(size / 1048576), parts, portableKeys: portable, needsPassphrase, sealedCount: Number(portable?.sealed || 0) }
    }

    /** 按勾选**只解那几部分**，落到当前安装的对应位置（旧的整份改名 .bak-<时间戳>） */
    case 'data.importApply': {
      const zipPath = String(p?.zipPath || '').trim()
      if (!zipPath || !fs.existsSync(zipPath)) throw new Error('数据包不存在：' + zipPath)
      const wantParts: string[] = Array.isArray(p?.parts) ? (p.parts as any[]).map(String) : []
      if (!wantParts.length) throw new Error('没有勾选任何要导入的内容')
      const mfr = await runTar(['-xOf', zipPath, 'nis-manifest.json'], 60000)
      if (!mfr.ok) throw new Error('不是 NIS 数据包（缺清单 nis-manifest.json）')
      let mf: any = {}
      try { mf = JSON.parse(mfr.output) } catch { throw new Error('数据包清单损坏') }
      /* ⚠️ 0919 修：`roots` 必须**在 v1 老包分支之前**声明。
         原来它声明在本 case 偏后（v1 分支之后），而 v1 分支里要用 roots.data/storage/skills/memory
         → 运行时抛 `Cannot access 'roots' before initialization`（TDZ），
         导致"导入老数据包"这条路过不了。tsx 不报错是因为它只剥类型、不做类型检查。 */
      const roots = {
        data: path.resolve(DATA_ROOT),
        storage: path.resolve(storageRootNow()),
        skills: path.resolve(SKILLS_ROOT),
        memory: path.resolve(currentMemoryDir()),
      }
      /* ★ 0920：**导入前先记住本机的路径类设置**（v1/v2 两条路都要用，所以提到最前面）。
         规则：`storagePath` / `envDir` 一律**以本机为准** —— 它们是"这台机器上东西放哪"，
         跟数据包没关系。本机有值就保留本机的；本机没设过就把包里那份删掉（回到当前安装的默认位置）。
         ⚠️ 实测反馈（0.0.9）：导入一个 0918 的老包后，「设置→通用→存储目录」变成了
         `C:\Users\...\AppData\Roaming\nis\imports\20260918-173826\niscs` —— 那是**旧导入的暂存目录**，
         纯粹是包里带过来的脏值。原因就是这条保护当时只写在 v2 分支里，v1 老包分支漏了。 */
      /* ui-state.json 里的 `nis-settings` 有**两种形态**：前端 localStore 存进去的是**字符串**
         （`String(v)`，见 frontend/src/utils/localStore.ts），手改/历史版本可能是对象。
         ⚠️ 0.0.10 只判了 `typeof ns === 'object'` → 字符串永远进不去
         ⇒ 那段"把本机路径写回 ui-state"其实**从来没生效过**（现在修掉）。 */
      const parseUiSettings = (ui: any): Record<string, any> | null => {
        const ns = ui && ui['nis-settings']
        if (!ns) return null
        if (typeof ns === 'string') { try { return JSON.parse(ns) } catch { return null } }
        return typeof ns === 'object' ? ns : null
      }
      const localPaths: { storagePath?: string; envDir?: string } = {}
      try {
        const cur = JSON.parse(fs.readFileSync(path.join(roots.data, 'settings.json'), 'utf8'))
        if (typeof cur.storagePath === 'string' && cur.storagePath) localPaths.storagePath = cur.storagePath
        if (typeof cur.envDir === 'string' && cur.envDir) localPaths.envDir = cur.envDir
      } catch { /* 本机还没设置过：保持空，后面会把包里那两份删掉 */ }
      /* ★ 0921（反馈：「导入的旧版本数据，供应商里之前保存的模型没了」）：
         settings 分部里的 providers.json 是**整份替换**的 —— 包内那份（往往没有你后来点
         「获取模型」拉回来的模型）会把你本机的模型列表一并盖掉，于是"导入完模型就没了"。
         修法：导入**前**把本机各供应商的模型列表整份记下来，导入**后**再并回去。
         口径：模型列表 = 本机 ∪ 包内（按 id 去重，保留本机的完整对象）；
               Key / 启用状态 / base / protocol 仍以包内为准（导入的就是导入的）。 */
      const localProviderModels: Record<string, any[]> = {}
      try {
        const pj = path.join(roots.data, 'providers.json')
        if (fs.existsSync(pj)) {
          const st = JSON.parse(fs.readFileSync(pj, 'utf8'))
          for (const p of (st?.providers || [])) {
            const list = Array.isArray(p?.models) ? p.models : []
            if (list.length) localProviderModels[String(p.id)] = JSON.parse(JSON.stringify(list))
          }
        }
      } catch { /* ignore */ }
      /** 导入落位**之后**把本机原有模型并回 providers.json（返回补回的条数，供日志） */
      const mergeLocalProviderModels = (): number => {
        const ids = Object.keys(localProviderModels)
        if (!ids.length) return 0
        const pj = path.join(roots.data, 'providers.json')
        if (!fs.existsSync(pj)) return 0
        try {
          const st = JSON.parse(fs.readFileSync(pj, 'utf8'))
          if (!Array.isArray(st?.providers)) return 0
          let added = 0
          for (const p of st.providers) {
            const saved = localProviderModels[String(p.id)]
            if (!saved?.length) continue
            const have = new Set((Array.isArray(p.models) ? p.models : []).map((m: any) => String(m?.id || '')))
            const merged = Array.isArray(p.models) ? p.models.slice() : []
            for (const m of saved) {
              const mid = String(m?.id || '')
              if (!mid || have.has(mid)) continue
              merged.push(m)   // 保留本机那份完整对象（含 name/capabilities 等）
              have.add(mid)
              added++
            }
            if (merged.length !== (Array.isArray(p.models) ? p.models.length : 0)) p.models = merged
          }
          if (added > 0) {
            // 原子写（与 providers.ts 的 persist 同口径：写坏 = 全部 Key 静默丢失）
            const tmp = pj + '.tmp'
            fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
            fs.renameSync(tmp, pj)
            console.log(`[import] 补回本机原有供应商模型 ${added} 个（导入不再覆盖你拉过的模型）`)
          }
          return added
        } catch (e) {
          console.error('[import] 合并本机供应商模型失败：', e)
          return 0
        }
      }
      /* ★ 0920（0.0.11）：**外观也以本机为准**。
         症状（实测）：引导里选了深色 → 导入老数据 → 弹窗点「立即重启」→ 设置里的外观变成"跟随系统"。
         真因：导入老包时 `data/ui-state.json` 被**整份替换**（外观就存在它的 nis-settings 里），
         而 restoreLocalPaths() 只守了 storagePath/envDir。storagePath 之所以没暴露这个问题，
         是因为 settings.json 里也有一份、由后端 settings.get 兜着；**外观只存在 ui-state**。
         所以这里在落位**之前**先记住本机外观，落位后写回 —— 导入数据不该改"这台机器长什么样"。 */
      let localAppearance: Record<string, unknown> | null = null
      /* ★ 0920（0.0.11）：`nis.ui.theme` 也要守 —— 它是**开屏页**据此决定浅/深的那一个键
         （Rust `read_ui_theme()`）。导入老包时它被换成导出机上的值 →
         "导入后点立即重启，开屏前段是浅色、到 80% 多才闪一下变深色"（实测）。 */
      let localUiTheme = ''
      try {
        const ui = JSON.parse(fs.readFileSync(path.join(roots.data, 'ui-state.json'), 'utf8'))
        const ns = parseUiSettings(ui)
        if (ns && ns.appearance && typeof ns.appearance === 'object') {
          localAppearance = ns.appearance as Record<string, unknown>
        }
        if (ui['nis.ui.theme'] === 'dark' || ui['nis.ui.theme'] === 'light') localUiTheme = ui['nis.ui.theme']
      } catch { /* 本机没有 ui-state / 解析失败：保持 null（后面就不动包里的外观） */ }
      /* 把"本机路径"写回设置文件（settings.json + ui-state.json 的 nis-settings 都可能有，
         前端那份 localStorage 就是从 ui-state 读的 —— 只改一处会出现"磁盘对了、界面还是旧的"）。 */
      const restoreLocalPaths = (): void => {
        const sp = path.join(roots.data, 'settings.json')
        if (fs.existsSync(sp)) {
          try {
            const st = JSON.parse(fs.readFileSync(sp, 'utf8'))
            for (const k of ['storagePath', 'envDir'] as const) {
              if (localPaths[k]) st[k] = localPaths[k]
              else delete st[k]
            }
            /* ★1012：**外观字段在 settings.json 里也有一份了** —— 前端把外观接进了 settings 同步链
               （pushToBackend 逐字段发 + 回读），于是 settings.json 被整份替换时这些字段也会跟着数据包变。
               这里与 ui-state 的保护**同口径**：外观以本机为准（导入数据不该改"这台机器长什么样"，
               即 0920 那条实测修复的本意："引导里选了深色 → 导入老数据 → 外观变成跟随系统"不许复发）。
               ⚠️ **例外：折叠档位**（processFoldMode / foldProcessOnDone）**跟数据包走** ——
                  老大明确要求"导出 → 导入后折叠设置要继承"；它属于"回复展示行为"，不是这台机器的样子。
               ⚠️ 本机没设过某字段（localAppearance 里没有该键）⇒ 删掉包里那份、回到默认，
                  与上面 storagePath/envDir 的处理同口径。 */
            if (localAppearance) {
              for (const k of ['themeMode', 'themeLightStart', 'themeLightEnd', 'fontSize', 'bubbleAvatar', 'bubbleRadius'] as const) {
                if (k in localAppearance) st[k] = (localAppearance as any)[k]
                else delete st[k]
              }
            }
            fs.writeFileSync(sp, JSON.stringify(st, null, 2), 'utf8')
          } catch (e) { swallowed('导入后回写 settings.json 失败（本机 storagePath/envDir 等可能未生效）', e) }
        }
        const up = path.join(roots.data, 'ui-state.json')
        if (fs.existsSync(up)) {
          try {
            const ui = JSON.parse(fs.readFileSync(up, 'utf8'))
            const raw = ui['nis-settings']
            const ns = parseUiSettings(ui)
            let touched = false
            if (ns) {
              let nsTouched = false
              for (const k of ['storagePath', 'envDir'] as const) {
                if (localPaths[k]) { if (ns[k] !== localPaths[k]) nsTouched = true; ns[k] = localPaths[k] }
                else if (k in ns) { delete ns[k]; nsTouched = true }
              }
              /* 外观（主题/字号/气泡/背景/动效）以本机为准 —— 导入数据不该改这台机器的界面偏好 */
              if (localAppearance) {
                if (JSON.stringify(ns.appearance) !== JSON.stringify(localAppearance)) nsTouched = true
                ns.appearance = localAppearance
              }
              if (nsTouched) {
                /* ★ 保持原来那句 nis-settings 的**存储形态**：前端存进去的是字符串，
                   前端 hydrate / settings store 也是按字符串 JSON.parse 读的
                   ——写成对象会让"外观看起来没被导入破坏"变成"读不出来了"。 */
                ui['nis-settings'] = typeof raw === 'string' ? JSON.stringify(ns) : ns
                touched = true
              }
            }
            /* ★ 开屏用的"上次实际深浅"（`nis.ui.theme`）也以本机为准 —— 见上面 localUiTheme 的注释 */
            if (localUiTheme && ui['nis.ui.theme'] !== localUiTheme) {
              ui['nis.ui.theme'] = localUiTheme
              touched = true
            }
            if (touched) fs.writeFileSync(up, JSON.stringify(ui, null, 2), 'utf8')
          } catch (e) { swallowed('导入后回写 ui-state.json 失败（草稿/开屏主题等可能丢）', e) }
        }
        try { loadSettings() } catch { /* ignore */ }
        try { broadcastHost({ type: 'host/settings-updated', settings: JSON.parse(JSON.stringify(globalSettings)) } as any) } catch { /* ignore */ }
      }
      /* 0919：**v1 老包**（清单里没有 `parts`）→ 按"整包导入"处理。
         为什么之前报错：老包在弹窗里只给一个合成项 `__all__`（见 data.importInspect），
         而这里一律走"按 parts 解包"→ 找不到 parts 就抛错，用户勾了"整包数据"也导不进来。
         落位规则：按包内**顶层目录名**对号入座 —— 用导出机 manifest 里
         dataRoot/storageRoot/skillsRoot/memoryRoot 的 basename 映射到本机的
         DATA_ROOT / 存储目录 / 技能目录 / 记忆目录（按 basename 而不是硬编码，换机/改目录名也能对上）。 */
      if (!mf.parts || typeof mf.parts !== 'object') {
        if (!wantParts.includes('__all__')) throw new Error('老版本数据包只能整包导入')
        const v1stage = path.join(dataParentDir(), '.nis-import-v1')
        fs.rmSync(v1stage, { recursive: true, force: true })
        fs.mkdirSync(v1stage, { recursive: true })
        emitDataProgress('import', 0, '正在解出数据包…')
        const v1x = await runTar(['-xzf', zipPath, '-C', v1stage], 900000)
        if (!v1x.ok) { emitDataProgress('import', -1, '解包失败'); throw new Error('解包失败：' + v1x.output.slice(0, 300)) }
        /* 包里有没有供应商密钥文件（providers.json）—— 有才需要重载内存里的供应商表。
           v1 老包是一整份数据目录，providers.json 会躺在其某个顶层目录里。 */
        let tarHadProviders = false
        try {
          for (const ent of fs.readdirSync(v1stage, { withFileTypes: true })) {
            if (ent.isDirectory() && fs.existsSync(path.join(v1stage, ent.name, 'providers.json'))) tarHadProviders = true
          }
        } catch { /* ignore */ }
        emitDataProgress('import', 60, '正在落位…')
        const baseOf = (v: any) => String(v || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || ''
        const target: Record<string, string> = {}
        const v1map: Array<[string, any, string]> = [
          ['data', (mf as any).dataRoot, roots.data],
          ['storage', (mf as any).storageRoot, roots.storage],
          ['skills', (mf as any).skillsRoot, roots.skills],
          ['memory', (mf as any).memoryRoot, roots.memory],
        ]
        for (const [, from, to] of v1map) {
          const nm = baseOf(from)
          if (nm && to) target[nm] = to
        }
        /* ★ 0920 兜底：包里顶层目录名 = 逻辑名（data / storage / skills / memory）时直接对号入座。
           为什么需要：v1 老包只记了导出机的绝对路径，靠 basename 匹配 ——
           而"导出机的存储目录叫 NisData、本机默认叫 storage"这种改名/换机场景就匹配不上，
           解出来的目录会被判成"本机没有对应位置 → 已跳过"（数据静默丢失）。
           这几个逻辑名是我们自己定的，命中就直接落位，不受外部目录名影响。 */
        for (const [logical, to] of [
          ['data', roots.data],
          ['storage', roots.storage],
          ['skills', roots.skills],
          ['memory', roots.memory],
        ] as Array<[string, string]>) {
          if (to && !target[logical]) target[logical] = to
        }
        const v1stamp = backupStamp()
        const v1report: Array<{ id: string; label: string; ok: boolean; note: string }> = []
        const v1backups: string[] = []
        for (const ent of fs.readdirSync(v1stage, { withFileTypes: true })) {
          if (ent.name === 'nis-manifest.json') continue
          const dstRoot = target[ent.name]
          if (!dstRoot) {
            v1report.push({ id: ent.name, label: ent.name, ok: false, note: '包里这个目录在本机没有对应位置 → 已跳过' })
            continue
          }
          memoryBridge.stop() // 记忆/知识库的 sqlite 句柄必须先放掉
          const srcDir = path.join(v1stage, ent.name)
          for (const child of fs.readdirSync(srcDir)) {
            const src = path.join(srcDir, child)
            const dst = path.join(dstRoot, child)
            try {
              if (fs.existsSync(dst)) {
                const bak = dst + '.bak-' + v1stamp
                try { fs.rmSync(bak, { recursive: true, force: true }) } catch { /* ignore */ }
                fs.renameSync(dst, bak)
                v1backups.push(bak)
              }
              fs.mkdirSync(path.dirname(dst), { recursive: true })
              if (fs.statSync(src).isDirectory()) copyTree(src, dst)
              else fs.copyFileSync(src, dst)
              v1report.push({ id: ent.name + '/' + child, label: child, ok: true, note: '' })
            } catch (e: any) {
              v1report.push({ id: ent.name + '/' + child, label: child, ok: false, note: String(e?.message || e).slice(0, 160) })
            }
          }
        }
        fs.rmSync(v1stage, { recursive: true, force: true })
        /* ★ 0920：v1 老包**也必须**把"本机路径以本机为准"补回去 ——
           老包里带的 storagePath 常常是导出机上的临时/暂存目录（实测被改成
           `%APPDATA%\nis\imports\<时间戳>\niscs`），照单全收 = "导个数据把我存储位置改了"。 */
        restoreLocalPaths()
        /* ★ 0921：老包（v1）同样是「整份替换 providers.json」→ 并回本机自己拉过的模型。
           必须放在 reloadProviders() **之前**，让内存里读到的就是合并后的表。 */
        try { mergeLocalProviderModels() } catch { /* ignore */ }
        if (tarHadProviders) reloadProviders()
        /* ★ 0920（0.0.11 口径修正）：**导入进来的模型一律保留** ——
           包里的 providers.json 是用户自己的老环境，哪怕模型表恰好等于当年的出厂清单，
           那也可能是他真在用的（设计口径：老数据里有模型就不该归 0）；
           老数据里没有的，整份替换后天然是 0。
           `keepImportedProviderModels()` 会打上 `legacyModelsCleaned` 标记，
           免得下次启动又被当成"出厂遗留"清掉。
           ⚠️ 0.0.10 这里是 dropLegacyFactoryModels()（清空）—— 实测反馈就是它把模型清成 0 的。 */
        try {
          const kept = keepImportedProviderModels()
          if (kept) console.log('[import/v1] 按老包原样保留供应商模型：' + kept + ' 个')
        } catch (e) {
          console.error('[import/v1] 保留包内模型失败：', e)
        }
        const v1pkgId = pkgFingerprint(zipPath, fs.statSync(zipPath).size, String(mf.exportedAt || ''))
        const v1hist = readImportHistory()
        const v1rec = v1hist[v1pkgId] || { at: Date.now(), parts: {} as Record<string, number> }
        v1rec.parts['__all__'] = Date.now()
        v1rec.at = Date.now()
        v1hist[v1pkgId] = v1rec
        writeImportHistory(v1hist)
        emitDataProgress('import', 100, '导入完成')
        return { ok: true, pkgId: v1pkgId, parts: v1report, backups: v1backups.length }
      }

      const sel = Object.keys(mf.parts as Record<string, any>).filter((id) => wantParts.includes(id))
      if (!sel.length) throw new Error('勾选的部分在这个包里不存在')

      /* 导入前先记住**本机**的路径类设置（同一个 restoreLocalPaths() 在 v1 分支也用了）——
         本机有值就写回本机的值、本机没值才删掉包里那份。
         ⚠️ 早期写成"直接 delete 包里的值"是错的：那等于把用户显式设过的存储目录**恢复成默认**，
         照样是"导个数据把我的设置改了"（用户最早抱怨的正是这个）。 */

      // ① 只解勾中的部分（按成员名选择性解包）到临时目录
      const stamp = backupStamp()
      const stage = path.join(dataParentDir(), '.nis-import-stage')
      /* ★1003 安全批 4.76：manifest 的 m.name / m.arc 是**包内可控**字段 —— 不校验就等于
       * "导入恶意包 = 写任意路径"（'..\\..\\Startup\\evil.bat' 先把受害文件改名 .bak 再落恶意内容）。
       * 统一口径：拒 '..' 段 / 绝对路径 / 盘符相对写法，且解析后必须仍在目标根之下。 */
      const safeJoinUnder = (root: string, rel: unknown): string | null => {
        const r = String(rel ?? '').trim()
        if (!r || r.includes('..') || /^[a-zA-Z]:/.test(r) || /^[\\/]/.test(r)) return null
        const rootAbs = path.resolve(root)
        const abs = path.resolve(rootAbs, r)
        if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null
        return abs
      }
      fs.rmSync(stage, { recursive: true, force: true })
      fs.mkdirSync(stage, { recursive: true })
      const xArgs: string[] = ['-xzvf', zipPath, '-C', stage]
      for (const id of sel) {
        for (const m of (mf.parts[id].members || []) as Array<{ root: string; name: string; arc?: string }>) {
          /* ★1003 4.76：arc 同样过闸 —— tar 成员名带 '..' 时，解包这一步就能写出 stage */
          const arcRaw = String(m.arc || m.name || '')
          if (!safeJoinUnder(stage, arcRaw)) {
            console.warn(`[import] manifest 条目路径非法，已跳过：${JSON.stringify(arcRaw)}`)
            continue
          }
          xArgs.push(arcRaw)
        }
      }
      emitDataProgress('import', 0, '正在解出所选内容…')
      let done = 0
      const total = Math.max(1, xArgs.length - 4)
      const xr = await runTarStream(xArgs, 900000, () => {
        done++
        emitDataProgressThrottled('import', Math.min(96, Math.round(100 * done / (done + total))), '解包中')
      })
      if (!xr.ok) { emitDataProgress('import', -1, '解包失败'); throw new Error('解包失败：' + xr.output.slice(0, 300)) }

      // ② 逐部分落位（旧的先改名备份）
      const report: Array<{ id: string; label: string; ok: boolean; note: string }> = []
      const backups: string[] = []
      for (const id of sel) {
        const info = mf.parts[id] as { label?: string; members?: Array<{ root: string; name: string }> }
        const label = String(info.label || id)
        try {
          memoryBridge.stop() // 记忆/知识库的 sqlite 句柄必须先放掉
          for (const m of info.members || []) {
            const absRoot = roots[m.root as keyof typeof roots]
            if (!absRoot) continue
            const arc = String((m as any).arc || m.name)
            /* ★1003 安全批 4.76：name/arc 双校验 —— 解析后必须仍在 stage/目标根之下，越界即跳过留痕 */
            const src = safeJoinUnder(stage, arc)
            const dst = safeJoinUnder(absRoot, String(m.name ?? ''))
            if (!src || !dst) {
              console.warn(`[import] manifest 条目越界，已跳过：name=${JSON.stringify(m.name)} arc=${JSON.stringify(arc)}`)
              continue
            }
            if (!fs.existsSync(src)) continue
            if (fs.existsSync(dst)) {
              const bak = dst + '.bak-' + stamp
              try { fs.rmSync(bak, { recursive: true, force: true }) } catch { /* ignore */ }
              fs.renameSync(dst, bak)
              backups.push(bak)
            }
            fs.mkdirSync(path.dirname(dst), { recursive: true })
            if (fs.statSync(src).isDirectory()) copyTree(src, dst)
            else fs.copyFileSync(src, dst)
          }
          // 设置：**本机路径以本机为准**（storagePath / envDir 绝不跟着包走）
          if (id === 'settings') {
            /* 本机路径以本机为准（settings.json + ui-state.json 两处一起改，见 restoreLocalPaths） */
            restoreLocalPaths()
            /* ★ 0921：包内 providers.json 整份替换 → 把本机自己拉过的模型并回来（见函数注释） */
            try { mergeLocalProviderModels() } catch { /* ignore */ }
          }
          /* ★1011：**通道与远程接入** —— 磁盘上那份 channels.json 已被包里的整份换掉，
             但 channelsStore 用内存 cache ⇒ 不丢 cache 就会出现"显示已导入、通道却没变"
             （与上面 settings 同一个坑）。tunnel.json 是每次现读，无需处理。
             ⚠️ 令牌随之换新：正在用手机/其它设备连的，需要用新令牌重连（面板里可看/可一键换锁）。 */
          if (id === 'channels') {
            try { invalidateChannelsCache() } catch (e: any) { console.error('[import] 重载通道配置失败：', e) }
          }
          report.push({ id, label, ok: true, note: '' })
        } catch (e: any) {
          report.push({ id, label, ok: false, note: String(e?.message || e).slice(0, 160) })
        }
      }
      fs.rmSync(stage, { recursive: true, force: true })
      /* ★ 0920：导入"设置"后**把内存里的供应商表与设置重读一遍**。
         磁盘上的 providers.json / settings.json 已经被换成包里的了，但内存里还是启动时的快照
         —— 不重读就会出现反馈的现象：「勾了含密钥的设置、也显示已导入，供应商却一个都没生效」。
         （连带的坑：此后所有 LLM 请求还继续用旧 Key，用户会以为"导入没生效"。） */
      if (sel.includes('settings')) {
        try {
          reloadProviders()
          loadSettings()
          broadcastHost({ type: 'host/settings-updated', settings: JSON.parse(JSON.stringify(globalSettings)) } as any)
        } catch (e) {
          console.error('[import] 重载设置/供应商失败：', e)
        }
        /* 包里的模型表**原样保留**（设计口径：老数据里有模型就不归 0；没有的天然是 0），
           并打标记避免下次启动被"出厂遗留清理"清掉（详见 providers.ts 的注释）。 */
        try {
          const kept = keepImportedProviderModels()
          console.log('[import] 按包内 providers.json 保留模型：' + kept + ' 个')
        } catch (e) {
          console.error('[import] 保留包内模型失败：', e)
        }
        /* 报告里写清"这个包里到底有没有供应商密钥" —— 老版本导出的包 settings 只含
           settings.json + ui-state.json（**没有 providers.json**），这时前端会显示"含明文密钥已导入"，
           用户却找不到任何被激活的供应商。与其让人猜，不如直接说清楚。 */
        const hasProviders = (sel || []).some((id) => {
          const mem = (mf.parts[id]?.members || []) as Array<{ name?: string }>
          return mem.some((m) => String(m.name || '').toLowerCase() === 'providers.json')
        })
        const sr = report.find((x) => x.id === 'settings')
        /* ★ 0930 导入口令：把包里的 apiKeyPortable 兑现成**本机** DPAPI 密文。
           顺序有讲究——必须在 reloadProviders() **之后**做：setProviderKey 会拿内存态 persist，
           若内存还是导入前的旧快照，会把刚导入的 providers.json 覆盖回旧内容。*/
        if (sel.includes('settings')) {
          try {
            const pjPath = path.join(DATA_ROOT, 'providers.json')
            const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
            if ((pj.providers || []).some((x: any) => x.apiKeyPortable)) {
              const pw = String(p?.passphrase || '')
              if (!pw) {
                sr && (sr.note = '已导入，但此包密钥需口令解锁：未输口令，供应商密钥暂不可用（可在设置里重新填写）')
              } else {
                const r = unsealPortableKeys(pj, pw)
                if (r.wrongPass) sr && (sr.note = '已导入，但**口令不对**：供应商密钥一个都没恢复（原有配置未被改动）')
                else if (r.recovered) {
                  /* ★ 1001 修：原实现在这里拿**旧文件快照 pj** 回写 —— 但 unsealPortableKeys 内部走
                     setProviderKey 已经把"恢复出来的新密文"persist 到盘上了；再用旧快照覆盖，等于把
                     刚恢复的密钥冲回"别的机器的密文" ⇒ 换机导入显示"恢复了 N 家"、实际一个都用不了。
                     正确做法：重新从盘读最新内容（= 内存刚 persist 的那份），只清掉口令副本再写回。*/
                  const fresh = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
                  for (const x of (fresh.providers || [])) x.apiKeyPortable = ''
                  fs.writeFileSync(pjPath, JSON.stringify(fresh, null, 2), 'utf8')   // 兑现完抹掉口令副本，不留在本机
                  reloadProviders()
                  sr && (sr.note = `已导入，并用口令恢复了 ${r.recovered} 家供应商密钥`)
                }
              }
            }
          } catch (e: any) {
            sr && (sr.note = '已导入，但密钥恢复出错：' + String(e?.message || e).slice(0, 120))
          }
        }
        /* ★ 1001 导入口令：搜索 key（websearch.json）与供应商密钥同一套口令口径。
           ⚠️ unsealPortableSearchKeys **只改内存对象、不落盘**（与 unsealPortableKeys 内部走
           setProviderKey 顺带 persist 不同）→ 兑现后必须**自己写回 + reloadWebSearchConfig()**，
           否则出现"内存里恢复了、盘上还是别的机器的密文"这种重启即失效的假成功。 */
        if (sel.includes('settings')) {
          try {
            const wsPath = path.join(DATA_ROOT, 'websearch.json')
            if (fs.existsSync(wsPath)) {
              const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
              const port = (ws && typeof ws.apiKeysPortable === 'object' && ws.apiKeysPortable) || {}
              const hasPortable = Object.keys(port).some((k) => (port as any)[k])
              if (hasPortable) {
                const pwS = String(p?.passphrase || '')
                if (!pwS) {
                  sr && (sr.note = (sr.note ? sr.note + '；' : '') + '搜索 key 也需口令解锁（未输口令，暂不可用）')
                } else {
                  const rs = unsealPortableSearchKeys(ws, pwS)
                  if (rs.wrongPass) sr && (sr.note = (sr.note ? sr.note + '；' : '') + '搜索 key 口令不对，一条都没恢复')
                  else if (rs.recovered) {
                    fs.writeFileSync(wsPath, JSON.stringify(ws, null, 2), 'utf8')   // 兑现完抹掉口令副本，不留在本机
                    reloadWebSearchConfig()
                    sr && (sr.note = (sr.note ? sr.note + '；' : '') + `搜索 key 恢复了 ${rs.recovered} 条`)
                  }
                }
              }
            }
          } catch (e: any) {
            sr && (sr.note = (sr.note ? sr.note + '；' : '') + '搜索 key 恢复出错：' + String(e?.message || e).slice(0, 100))
          }
          /* 兜底：包里的 websearch.json 已覆盖到盘上，但内存 config 还是启动时的旧值。
             无论有没有口令副本都重载一次 —— 有副本时上面已重载（重复调用无害），
             没副本时至少让设置面板如实显示"这把 key 在本机解不开"，而不是继续显示旧 key。*/
          try { reloadWebSearchConfig() } catch { /* 重载失败不影响导入结果 */ }
        }
        if (sr && !sr.note) {
          sr.note = hasProviders
            ? '已导入（含供应商与密钥）'
            : '已导入设置，但这个包**不含供应商密钥**（老版本导出的包不带 providers.json）'
        }
      }
      // ③ 记一笔"已导入"（同一份包再打开时会显示"已导入"）
      const size = fs.statSync(zipPath).size
      const pkgId = pkgFingerprint(zipPath, size, String(mf.exportedAt || ''))
      const hist = readImportHistory()
      const rec = hist[pkgId] || { at: Date.now(), parts: {} as Record<string, number> }
      for (const r of report) if (r.ok) rec.parts[r.id] = Date.now()
      rec.at = Date.now()
      hist[pkgId] = rec
      writeImportHistory(hist)
      emitDataProgress('import', 100, '导入完成')
      return { ok: true, pkgId, parts: report, backups: backups.length }
    }

    // ── 存储目录（设置→通用→存储目录：切换时三选项 保留/搬运/删除） ──
    case 'storage.inspect': {
      const p2 = assertSafeStoragePath(String(p?.path || storageRootNow()), '目录')
      return { ok: true, path: p2, ...dirStats(p2) }
    }

    case 'storage.migrate': {
      const to = String(p?.to || '').trim()
      const mode = String(p?.mode || 'keep')
      if (!to) throw new Error('to required')
      const from = String(p?.from || storageRootNow()).trim()
      // 只有操作「当前存储根」才切设置并广播；其它目录（自测）纯搬运/删除
      const isCurrent = path.resolve(from) === path.resolve(storageRootNow())
      try {
        // 0917 修：先迁移、成功了再改设置。此前先写设置 —— 迁移中途 EPERM 失败时
        // 存储路径已被切到新目录，重启后 app 指向一个空/半成品目录（用户报「重启后路径自己变了」）。
        const r = await storageMigrateDirect(from, to, mode)
        if (isCurrent) {
          ;(globalSettings as any).storagePath = path.resolve(to)
          /* ★ 0927 第 0 批：migrate 成功后落盘必须确认成功 —— 旧逻辑 persistSettings()
             静默失败时下次重启仍指向旧目录（用户看到"数据丢失"，其实是设置没写进去）。
             失败即回滚内存值 + 明确报错，绝不带病继续。 */
          if (!persistSettings()) {
            ;(globalSettings as any).storagePath = from
            throw new Error('存储路径已迁移，但 settings.json 写入失败（内存设置已回滚）——请检查磁盘权限后重试')
          }
          broadcastHost({ type: 'host/settings-updated', settings: JSON.parse(JSON.stringify(globalSettings)) } as any)
        }
        return r
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e).slice(0, 220), log: '' }
      }
    }

    // ── 知识库附件（本地存储：DATA_ROOT/knowledge-attachments/） ──
    // 0911 接通：原前端 attachmentClient 走 WS ATTACHMENT_UPLOAD 死通道（转 15s 失败）。
    case 'attachment.upload': {
      const entryId = String(p?.entryId || '').replace(/[^A-Za-z0-9_-]/g, '')
      if (!entryId) throw new Error('entryId required')
      const raw = String(p?.data || '')
      const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw
      if (!base64) throw new Error('data required')
      const buf = Buffer.from(base64, 'base64')
      if (!buf.byteLength) throw new Error('附件内容为空')
      if (buf.byteLength > 12 * 1024 * 1024) throw new Error('附件超过 12MB 上限')
      const safeName = sanitizeAttachmentName(String(p?.name || 'file'))
      const dir = path.join(ATTACHMENT_ROOT, entryId)
      await fs.promises.mkdir(dir, { recursive: true })
      const full = path.join(dir, safeName)
      await fs.promises.writeFile(full, buf)
      const rel = path.relative(ATTACHMENT_ROOT, full).split(path.sep).join('/')
      return { ok: true, path: rel, size: buf.byteLength }
    }

    case 'attachment.get': {
      const full = resolveAttachmentPath(String(p?.path || ''))
      if (!fs.existsSync(full)) throw new Error('附件不存在')
      const raw = await fs.promises.readFile(full)
      return { ok: true, path: p?.path, data: raw.toString('base64'), size: raw.byteLength }
    }

    case 'attachment.delete': {
      const full = resolveAttachmentPath(String(p?.path || ''))
      if (!fs.existsSync(full)) return { ok: true, deleted: false }
      await fs.promises.rm(full, { force: true, recursive: true })
      return { ok: true, deleted: true }
    }

    // ── 知识库 / 记忆 RPC（透传 memory_bridge） ──

    /* ── 运行环境（0914 实装）── */
    case 'env.status':
      return await envStatus()

    case 'env.install':
      return envInstallStart(String(p?.id || ''))

    case 'env.job':
      return envJobGet(String(p?.jobId || ''))

    case 'env.uninstall':
      return envUninstallStart(String(p?.id || ''))

    /** 0918：这套实例实际在用的路径（数据根/环境目录/venv/内核/记忆数据）——确认隔离状态用 */
    case 'env.paths':
      return envPaths()

    /* ★1010f：Agent Reach（技能面板「编辑」弹窗用）—— 清单透传它的 doctor --json */
    case 'agentReach.channels':
      return await arChannels(p?.fresh === true ? 0 : 60000)

    case 'agentReach.install': {
      const ch = String(p?.channel || '').trim()
      if (!ch) throw new Error('channel required')
      /* ★1010h：改成起后端任务（立即返回 jobId）；进度用 agentReach.jobs 轮询看 ——
         前端关弹窗/关面板都不再丢状态（原先 Promise 存组件里，一卸载就没了）。 */
      return arInstallStart(ch)
    }

    case 'agentReach.jobs':
      return { jobs: arJobsSnapshot() }

    /* ★1010p：OpenCLI 的 Browser Bridge 能同时连多个浏览器（NIS 内置浏览器 / 外部 Edge…）
       ⇒ 面板给个下拉切换（原来只能命令行 `opencli profile use`）。 */
    case 'agentReach.profiles': {
      const r = await execCapture('cmd', ['/c', arCmd(), 'opencli', 'profile', 'list'], { timeout: 60000, env: arEnv() })
      const out = String(r.out || '')
      const profiles = out.split('\n')
        .map(l => l.trim())
        .map(l => /^([A-Za-z0-9_-]{4,})\s+[—–-]\s+(.+)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map(m => ({ id: m[1], info: m[2].trim() }))
      if (!profiles.length) return { ok: false, error: (String(r.err || out).trim() || '没连上任何浏览器 —— 先打开浏览器（内置或 Edge）再重扫').slice(0, 200) }
      return { ok: true, profiles }
    }

    case 'agentReach.useProfile': {
      const id = String(p?.id || '').trim()
      if (!id) throw new Error('id required')
      const r = await execCapture('cmd', ['/c', arCmd(), 'opencli', 'profile', 'use', id], { timeout: 60000, env: arEnv() })
      return { ok: r.code === 0, out: String(r.out || r.err || '').slice(0, 300) }
    }

    /* ★1010t：真状态探测（用户："状态是否真实"）——
     * doctor 自己写着"不做实时验证 / 不能仅凭配置宣称可用"，所以它给的是**快照**。
     * 这里真跑一条平台只读命令（opencli <site> whoami）：成功=真可用（带账号名），
     * 失败=真不可用（未登录 / 该平台不支持检测），结论以它的报错为准，不猜。 */
    case 'agentReach.probe': {
      const ch = String(p?.channel || '').trim()
      if (!ch) throw new Error('channel required')
      const started = Date.now()
      const r = await execCapture('cmd', ['/c', arCmd(), 'opencli', ch, 'whoami', '-f', 'json'], { timeout: 120000, env: arEnv() })
      const out = String(r.out || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()
      const err = String(r.err || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
        .split('\n').filter(l => !/不是内部或外部命令|或批处理文件/.test(l)).join('\n').trim()   // 滤掉 cmd 把 ANSI 删行码当命令的噪音
      const alive = r.code === 0 && /ok:\s*true|"ok"\s*:\s*true|\{/.test(out)
      return {
        ok: alive,
        ms: Date.now() - started,
        out: out.slice(0, 600),
        err: err.slice(0, 300),
        hint: alive ? '' : (/AUTH_REQUIRED|auth cookies are missing/i.test(out + err)
          ? '没登录 —— 在你自己浏览器里登录该站点后重试'
          : (/not found|unknown command|不支持|no such/i.test(out + err) ? '这个平台不支持这种检测方式' : '探测失败，看下面的原始输出')),
      }
    }

    case 'agentReach.cookies':
      return await arImportCookies(String(p?.platform || '').trim().toLowerCase(), sessionId || undefined)

    /** 0921g：外部图片链接 → data URL（供粘贴时把网页图片变成标签） */
    case 'clip.fetchImage':
      /* ★1003 4.59/4.60：带上会话工作区进白名单（本地图片只认临时目录/收件箱/工作区） */
      return await clipFetchImage(String(p?.url || ''), String((sessionId && sessions.get(sessionId)?.workDir) || ''))

    /* ── 语音（0920）：语音输入 ASR / 朗读 TTS ──
       ⚠️ 模型落 <envDir>/voice（增量包，不进安装包）；配置也在这下面（voice/config.json），
          与"存储目录/记忆目录"都无关——语音是本机能力，换机器要重装。 */
    case 'voice.state':
      return voiceState(envInstallDir())

    case 'voice.install':
      return voiceInstallStart(envInstallDir(), String(p?.id || ''))

    case 'voice.job':
      return { ok: true, job: voiceJobGet(String(p?.jobId || '')) || null }

    case 'voice.remove':
      return voiceRemove(envInstallDir(), String(p?.id || ''))

    /** 改配置：开关 / 启用哪个模型 / 某模型的音色语速 / 线程数 */
    case 'voice.set': {
      const cfg = loadVoiceCfg(envInstallDir())
      const patch = (p?.patch || {}) as Record<string, any>
      if (typeof patch.asrEnabled === 'boolean') cfg.asrEnabled = patch.asrEnabled
      if (typeof patch.ttsEnabled === 'boolean') cfg.ttsEnabled = patch.ttsEnabled
      if (typeof patch.asrModel === 'string' && findVoiceModel(patch.asrModel)) cfg.asrModel = patch.asrModel
      if (typeof patch.ttsModel === 'string' && findVoiceModel(patch.ttsModel)) cfg.ttsModel = patch.ttsModel
      if (patch.numThreads != null) cfg.numThreads = Number(patch.numThreads) || 4
      // 单个模型的音色/语速（切模型各自恢复，互不牵扯）
      if (patch.modelId && typeof patch.modelId === 'string') {
        const def = findVoiceModel(patch.modelId)
        if (def) {
          const cur = voiceModelCfg(cfg, def)
          cfg.models[def.id] = {
            sid: patch.sid != null ? Math.max(0, Math.round(Number(patch.sid))) : cur.sid,
            speed: patch.speed != null ? Math.min(Math.max(Number(patch.speed), 0.5), 2) : cur.speed,
          }
        }
      }
      saveVoiceCfg(envInstallDir(), cfg)
      // 关了开关 → 立刻把引擎卸掉（"关闭可释放性能"的落点）
      if (patch.asrEnabled === false || patch.ttsEnabled === false) voiceRelease(envInstallDir())
      return { ok: true, state: voiceState(envInstallDir()) }
    }

    /** 试听 / 朗读：返回 base64 WAV（长文由前端分句多次调，边合成边播） */
    case 'voice.speak': {
      const r = await voiceSpeak(envInstallDir(), String(p?.text || ''), {
        model: p?.model ? String(p.model) : undefined,
        sid: p?.sid != null ? Number(p.sid) : undefined,
        speed: p?.speed != null ? Number(p.speed) : undefined,
      })
      console.log(`[voice] speak ${r.ok ? 'ok' : '失败'} ${r.durationMs ? r.durationMs + 'ms 音频 / ' + r.elapsedMs + 'ms 合成' : r.error}`)
      return r
    }

    /** 语音输入：前端给 16k 单声道 Int16 PCM（base64）→ 文本 */
    case 'voice.transcribe': {
      const r = voiceTranscribe(envInstallDir(), String(p?.pcm || ''), Number(p?.sampleRate) || 16000)
      console.log(`[voice] transcribe ${r.ok ? 'ok ' + (r.text || '') : '失败 ' + r.error}`)
      return r
    }

    case 'voice.release':
      return voiceRelease(envInstallDir())

    /* ── 后台任务（0920）：挂到后台跑长命令/下载 ──
       前端胶囊 tab 按 conversationId 过滤；进度走 host 帧 `bg/updated` 推。 */
    case 'bg.list':
      return { ok: true, tasks: bgList(p?.conversationId ? String(p.conversationId) : undefined) }

    case 'bg.read':
      return bgReadOutput(String(p?.taskId || ''), Number(p?.lines) || 60)

    case 'bg.stop':
      return bgStop(String(p?.taskId || ''))

    case 'bg.pause':
      return bgPause(String(p?.taskId || ''))

    case 'bg.resume':
      return bgResume(String(p?.taskId || ''))

    /* ── 进程监控（0922e）：只列"正在运行的、由 NIS 拉起的"进程 ── */
    case 'proc.list':
      return { ok: true, procs: procList() }

    case 'proc.kill':
      return procKill(String(p?.id || ''))

    case 'bg.clear':
      return bgClear(Array.isArray(p?.ids) ? p.ids.map(String) : undefined)

    case 'fs.listDir':
      return listDirForPicker(String(p?.path || ''), { withFiles: !!p?.withFiles })

    case 'fs.mkdir':
      return mkdirForPicker(String(p?.path || ''), String(p?.name || ''))

    /* ★1012 修 bug（实测反馈：知识库面板显示 0 条 / 让 AI 写知识库却写进了记忆）：
       这四个方法此前被误并进下面的 memory.distill 分支（1010l 加蒸馏时挤错块）——
       后果：① 面板调 knowledge.list 实际执行「记忆蒸馏」⇒ 拿不到 entries ⇒ 显示 0 条；
             ② 写知识库（knowledge.add）实际也是蒸馏 ⇒ 内容写进了记忆（带 from_knowledge_add + 待确认）。
       恢复为透传 memoryBridge（Python：knowledge_list / _add / _update / _delete），与下面 memory.* 一组同款。
       参数形状已核对：前端 { project_id } / { id } / toPayload(entry) ←→ Python params.get("project_id"/"id"/"title")。 */
    case 'knowledge.list':
    case 'knowledge.add':
    case 'knowledge.update':
    case 'knowledge.delete': {
      const op = method.replace(/\./g, '_')
      return await memoryBridge.call(op, p || {})
    }
    case 'memory.distill': {
      /* ★1010l：记忆面板「整理」按钮专用 —— 手动触发蒸馏：同主题散碎记忆合并成主题草案
         （打 pending_review 进「待确认」，绝不偷改已确认记忆）。LLM 由启动时注入。 */
      const { memoryDistill } = await import('./memoryBridge.ts')
      return await memoryDistill()
    }
    case 'memory.graph':
    case 'memory.search':
    case 'memory.store':
    case 'memory.delete':
    case 'memory.maintenance':
    case 'memory.node.add':
    case 'memory.node.update':
    case 'memory.node.delete':
    case 'memory.edge.add':
    case 'memory.edge.delete': {
      // 注意：必须替换所有点（memory.node.delete → memory_node_delete，仅替换第一个点会变成 memory_node.delete）
      const op = method.replace(/\./g, '_')
      return await memoryBridge.call(op, p || {})
    }

    /* ── 全局搜索（0914 下午做真）：标题 + 全量消息正文（含 QQ/微信通道会话） ── */
    case 'session.search': {
      const q = String(p?.query || '').trim()
      if (!q) return { results: [] }
      const need = q.toLowerCase()
      const limit = Math.min(Math.max(Number(p?.limit) || 12, 1), 30)
      const hits: Array<{ sessionId: string; title: string; snippet: string; updatedAt: number }> = []
      for (const s of sessions.values()) {
        const title = String(s.title || '')
        const titleHit = title.toLowerCase().includes(need)
        let snippet = ''
        if (!titleHit) {
          // 从最新往旧扫（最多 400 条），命中即在正文里截一段上下文
          const msgs: any[] = Array.isArray((s as any).transcript)
            ? ((s as any).transcript as any[])
            : Array.isArray(s.messages) ? (s.messages as any[]) : []
          const start = Math.max(0, msgs.length - 400)
          for (let i = msgs.length - 1; i >= start; i--) {
            const text = piMessageSearchText(msgs[i])
            if (!text) continue
            const idx = text.toLowerCase().indexOf(need)
            if (idx >= 0) {
              const from = Math.max(0, idx - 24)
              snippet = text.slice(from, idx + need.length + 60).replace(/\s+/g, ' ').trim()
              break
            }
          }
        }
        if (titleHit || snippet) hits.push({ sessionId: s.id, title, snippet, updatedAt: s.updatedAt || 0 })
      }
      hits.sort((a, b) => b.updatedAt - a.updatedAt)
      return { results: hits.slice(0, limit) }
    }

    case 'session.fork':
      if (!sessionId) throw new Error('sessionId required')
      const src = sessions.get(sessionId)
      if (!src) throw new Error('session not found')
      const forked = createSession(`${src.title} (鍓湰)`)
      forked.messages = [...src.messages]
      broadcastHost({ type: 'host/session-added', sessionId: forked.id, blank: false, parentSessionId: sessionId })
      return { sessionId: forked.id, title: forked.title }

    case 'workspace.list':
      return buildWorkspaceView()

    // 工作区文件树（右侧「工作区」面板数据源）：实时读会话 workDir，浅层深度限制防大目录卡顿
    case 'workspace.tree': {
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session) throw new Error('session not found')
      const root = session.workDir?.trim() || process.cwd()
      const walk = (dir: string, depth: number): Array<{ name: string; type: 'file' | 'folder'; children?: any[] }> => {
        let entries: fs.Dirent[] = []
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        const out: Array<{ name: string; type: 'file' | 'folder'; children?: any[] }> = []
        for (const e of entries.slice(0, 100)) {
          if (e.name.startsWith('.')) continue
          if (e.isDirectory()) {
            out.push({ name: e.name, type: 'folder', children: depth < 4 ? walk(path.join(dir, e.name), depth + 1) : [] })
          } else {
            out.push({ name: e.name, type: 'file' })
          }
        }
        return out
      }
      return { root, tree: walk(root, 0) }
    }

    // 用户主动删除工作区文件（工作区面板右键；与 AI 的 fs_delete 工具不同：这是用户操作，不走审批门禁）
    case 'fs.delete': {
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session) throw new Error('session not found')
      const full = resolveWorkdirPath(session, p?.path)
      await fs.promises.rm(full, { recursive: true, force: true })
      sessionLog(sessionId || String(p?.sessionId || ''), 'info', 'tool', `[用户] 删除工作区文件：${p?.path}`)
      return { ok: true }
    }

    case 'fs.rename': {
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session) throw new Error('session not found')
      const newName = String(p?.newName || '').trim()
      if (!newName || /[\\/]/.test(newName)) throw new Error('newName 不能为空且不能包含路径分隔符')
      const full = resolveWorkdirPath(session, p?.path)
      if (!fs.existsSync(full)) throw new Error(`文件不存在：${p?.path}`)
      const dir = path.dirname(full)
      const dest = path.join(dir, newName)
      if (fs.existsSync(dest)) throw new Error(`目标名已存在：${newName}`)
      await fs.promises.rename(full, dest)
      sessionLog(sessionId || String(p?.sessionId || ''), 'info', 'tool', `[用户] 重命名：${p?.path} → ${newName}`)
      return { ok: true, newPath: newName }
    }

    // ── 文件历史（撤销/审查，docs/research-0902.md §1.5） ──

    case 'fs.history.list': {
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) return { changes: [] }
      // 0929 隔离修复：只回本会话的变更（team 成员聊天与主会话共享 workDir），
      // 无 sessionId 的存量记录兼容放行（口径同 fs.history.restoreTurn 0910 三批④）
      const sid = session.id
      const changes = listChanges(session.workDir.trim()).filter(c => !c.sessionId || c.sessionId === sid)
      return { changes: changes.slice(0, 200) }
    }

    case 'fs.history.changed': {
      // 变更区实时刷新轮询（0902 反馈 #1）：面板开着时轻量探针——只回最新 changeId 与条数，
      // 前端对比后决定是否全量拉取（避免每 3s 全量传 100 条元数据）
      // 0929 隔离修复：探针计数与 fs.history.list 同口径（否则成员会话写文件会误触发"有变更"）
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) return { latestId: '', count: 0 }
      const sid = session.id
      const changes = listChanges(session.workDir.trim()).filter(c => !c.sessionId || c.sessionId === sid)
      return { latestId: changes[0]?.id || '', count: changes.length }
    }

    case 'fs.history.readObject': {
      // 审查用：读快照内容（beforeHash 或 afterHash 指定的历史版本）
      const hash = String(p?.hash || '')
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('hash 非法')
      const buf = readObject(hash)
      if (!buf) throw new Error('快照内容已失效（可能被清理）')
      return { content: buf.toString('utf8') }
    }

    case 'fs.history.status': {
      // 三态生效判定（0902-3 反馈：区分"被覆盖"与"已撤销"，见 fileHistory.changeStatus）
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) throw new Error('session not found')
      const workDir = session.workDir.trim()
      const changes = listChanges(workDir)
      const change = changes.find(c => c.id === String(p?.changeId || ''))
      if (!change) return { active: true, state: 'active' }
      const state = changeStatus(workDir, change, changes)
      return { active: state === 'active', state }
    }

    case 'fs.history.turnSummary': {
      // 变更区组头批量汇总（0902-3 反馈）：各轮 fileCount/是否被撤销/是否整轮被后续覆盖——
      // 与逐条 status 同一判定（changeStatus），前端不再逐条往返；
      // undoable=本轮撤销真实可点的轮次（无 voided 且干跑 restoreChange 不报快照失效冲突）
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) return { turns: {}, undoable: [] }
      const workDir = session.workDir.trim()
      // 0929 隔离修复：turnIndex 只在本会话内有语义，成员会话的轮次不能混入（口径同上）
      return { turns: turnSummaries(workDir, session.id), undoable: undoableTurns(workDir, session.id) }
    }

    case 'fs.history.checkConflict': {
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) throw new Error('session not found')
      const changes = listChanges(session.workDir.trim())
      const change = changes.find(c => c.id === String(p?.changeId || ''))
      if (!change) throw new Error('记录不存在')
      return checkConflict(session.workDir.trim(), change)
    }

    case 'fs.history.restore': {
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) throw new Error('session not found')
      const workDir = session.workDir.trim()
      const changes = listChanges(workDir)
      const change = changes.find(c => c.id === String(p?.changeId || ''))
      if (!change) throw new Error('记录不存在')
      // 冲突语义：恢复旧版本总是允许的；checkConflict 只用于前端提示
      // （当前内容 ≠ 快照后状态 → 用户可能手改过 → 前端已弹确认，此处无需再拦）
      const r = restoreChange(workDir, String(p?.changeId || ''))
      if (r.ok) {
        sessionLog(sessionId || String(p?.sessionId || ''), 'info', 'tool', `[用户] 撤销：${change.relPath} 已恢复到 ${new Date(change.t).toLocaleString()} 的状态（来源：${change.actor}）`)
        // 撤销本身也是一次写动作，必须留痕（前端展示"用户撤销"条目 + 提供"撤销恢复"按钮）：
        //   恢复后文件存在 → 记 fs_write 快照（beforeHash=被撤销条 afterHash）
        //   恢复后文件不存在（恢复到"创建前"）→ 记 fs_delete 记录（beforeHash=被撤销条 afterHash）
        const abs = resolveChangePath(workDir, change.relPath || '')
        if (fs.existsSync(abs)) {
          const buf = fs.readFileSync(abs)
          const put = putObject(buf)
          const changes2 = listChanges(workDir).slice().reverse()
          const undoChange: any = {
            id: crypto.randomUUID(), t: Date.now(), tool: 'fs_write', actor: '用户撤销',
            kind: 'file', relPath: change.relPath, beforeHash: change.afterHash || '',
            afterHash: put.hash, existedBefore: true, beforeBytes: buf.length,
            undoOf: change.id, sessionId: session.id,
          }
          // 撤销记录的 diff 量（被撤销状态 → 恢复后状态）
          if (change.afterHash) {
            const st = diffStatByHash(change.afterHash, buf)
            if (st) { undoChange.diffAdded = st.diffAdded; undoChange.diffRemoved = st.diffRemoved }
          }
          changes2.push(undoChange)
          saveChanges(workDir, changes2)
        } else {
          const changes2 = listChanges(workDir).slice().reverse()
          changes2.push({
            id: crypto.randomUUID(), t: Date.now(), tool: 'fs_delete', actor: '用户撤销',
            kind: 'file', relPath: change.relPath, beforeHash: change.afterHash || '',
            afterHash: '', existedBefore: true, undoOf: change.id, sessionId: session.id,
          } as any)
          saveChanges(workDir, changes2)
        }
      }
      return r
    }

    case 'fs.history.restoreTurn': {
      // 整轮撤销（0902 反馈 #1 方案重做）：按该轮 change 列表逆序逐条 restore。
      // 逆序保证后写先撤（同文件多改时回到本轮开始前状态）。
      // 每条恢复照常走 restoreChange（内部标 voided + 写留痕），一次留痕一条"用户撤销"记录
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) throw new Error('session not found')
      const workDir = session.workDir.trim()
      const turnIndex = Number(p?.turnIndex)
      if (!Number.isInteger(turnIndex) || turnIndex < 1) throw new Error('turnIndex 非法')
      const all = listChanges(workDir)
      // 0910 三批④：只认本对话的改动（历史按对话隔离；存量记录无 sessionId → 兼容放行，靠 turnIndex 兜底）
      const sid = session.id
      const turnChanges = all.filter(c =>
        c.turnIndex === turnIndex && !c.voided && !String(c.actor || '').startsWith('用户撤销')
        && (!c.sessionId || c.sessionId === sid))
      if (turnChanges.length === 0) return { ok: true, restored: 0 }
      // 0910 三批④：跨对话冲突检测——同一文件在本轮之后被**其他对话**改过，撤销会连它的改动一起覆盖。
      // 首次调用只回报冲突（不落任何副作用），前端确认后带 confirmConflicts=true 再来一次。
      const conflictPaths = new Set(turnChanges.map(c => c.relPath || '').filter(Boolean))
      const startT = Math.min(...turnChanges.map(c => c.t || 0))
      const conflicts = all.filter(c =>
        !!c.relPath && conflictPaths.has(c.relPath) && !!c.sessionId && c.sessionId !== sid
        && (c.t || 0) > startT && !String(c.actor || '').startsWith('用户撤销'))
      if (conflicts.length && !p?.confirmConflicts) {
        return { ok: false, needConfirm: true, conflicts: [...new Set(conflicts.map(c => String(c.relPath)))], message: '这些文件在本轮之后被其他对话改过，继续撤销会一并覆盖它们的改动' }
      }
      // 每个文件只恢复本轮最早的一条记录：它的 beforeHash 就是本轮开始前状态。
      // 逐条恢复同一文件会被后续记录覆盖，最终停在本轮中间状态。
      const firstByPath = new Map<string, HistoryChange>()
      for (const c of turnChanges) {
        const key = c.relPath || `__${c.id}`
        const prev = firstByPath.get(key)
        if (!prev || c.t < prev.t) firstByPath.set(key, c)
      }
      const ordered = [...firstByPath.values()].sort((a, b) => a.t - b.t)
      const results: Array<{ changeId: string; relPath?: string; ok: boolean; error?: string }> = []
      for (const c of ordered) {
        if (c.kind === 'tree') { results.push({ changeId: c.id, ok: false, error: 'tree 记录暂不支持整轮恢复' }); continue }
        const r = restoreChange(workDir, c.id)
        if (r.ok) {
          // 留痕（与单条 fs.history.restore 相同语义，actor=用户撤销，undoOf 指向被撤条）
          const abs = resolveChangePath(workDir, c.relPath || '')
          if (fs.existsSync(abs)) {
            const buf = fs.readFileSync(abs)
            const put = putObject(buf)
            const changes2 = listChanges(workDir).slice().reverse()
            changes2.push({
              id: crypto.randomUUID(), t: Date.now(), tool: 'fs_write', actor: '用户撤销(整轮)',
              kind: 'file', relPath: c.relPath, beforeHash: c.afterHash || '',
              afterHash: put.hash, existedBefore: true, beforeBytes: buf.length, undoOf: c.id,
              turnId: c.turnId, turnIndex: c.turnIndex,
            } as any)
            saveChanges(workDir, changes2)
          } else {
            const changes2 = listChanges(workDir).slice().reverse()
            changes2.push({
              id: crypto.randomUUID(), t: Date.now(), tool: 'fs_delete', actor: '用户撤销(整轮)',
              kind: 'file', relPath: c.relPath, beforeHash: c.afterHash || '',
              afterHash: '', existedBefore: true, undoOf: c.id,
              turnId: c.turnId, turnIndex: c.turnIndex,
            } as any)
            saveChanges(workDir, changes2)
          }
        }
        results.push({ changeId: c.id, relPath: c.relPath, ok: r.ok, error: r.error })
      }
      const restored = results.filter(r => r.ok).length
      sessionLog(sessionId || String(p?.sessionId || ''), 'info', 'tool', `[用户] 整轮撤销：第 ${turnIndex} 轮 ${restored}/${ordered.length} 条已恢复`)
      return { ok: true, restored, total: ordered.length, results }
    }

    case 'fs.history.diffStat': {
      // +N-M 差异量懒算（fs_write 常规路径快照是"写入前"语义，afterHash 当时还不存在）
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) throw new Error('session not found')
      const changes = listChanges(session.workDir.trim())
      const change = changes.find(c => c.id === String(p?.changeId || ''))
      if (!change) throw new Error('记录不存在')
      if (change.diffAdded != null && change.diffRemoved != null) {
        return { diffAdded: change.diffAdded, diffRemoved: change.diffRemoved }
      }
      // afterHash 有值（rename/用户撤销路径）→ 用快照算；否则用当前文件内容当"改动后"
      let afterBuf: Buffer | null = null
      if (change.afterHash) {
        afterBuf = readObject(change.afterHash)
      } else if (change.relPath) {
        try { afterBuf = fs.readFileSync(resolveChangePath(session.workDir.trim(), change.relPath)) } catch { /* 文件已删 */ }
      }
      const st = diffStatByHash(change.beforeHash || '', afterBuf)
      return st ? { diffAdded: st.diffAdded, diffRemoved: st.diffRemoved } : { diffAdded: 0, diffRemoved: 0 }
    }

    case 'fs.history.saveRestoredCopy': {
      // 冲突分支：把快照版本另存为 .restored 副本（不覆盖当前文件）
      const session = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!session?.workDir) throw new Error('session not found')
      const hash = String(p?.hash || '')
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('hash 非法')
      const buf = readObject(hash)
      if (!buf) throw new Error('快照内容已失效')
      const rel = String(p?.relPath || '')
      const full = resolveWorkdirPath(session, rel)
      const parsed = path.parse(full)
      let copyPath = `${parsed.dir}${path.sep}${parsed.name}.restored${parsed.ext}`
      let n = 1
      while (fs.existsSync(copyPath)) copyPath = `${parsed.dir}${path.sep}${parsed.name}.restored-${n++}${parsed.ext}`
      fs.writeFileSync(copyPath, buf)
      return { ok: true, path: path.relative(session.workDir.trim(), copyPath).replace(/\\/g, '/') }
    }

    case 'fs.history.orphans': {
      // 数据管理：孤儿工作区盘点（工作区存在但 sessions.json 无引用）
      const live = Array.from(sessions.values()).map(s => s.workDir || '').filter(Boolean)
      return { orphans: listOrphanWorkdirs(live) }
    }

    case 'fs.history.purgeOrphan': {
      return removeWorkdir(String(p?.name || ''))
    }

    case 'fs.history.stats': {
      // 设置页：历史占用统计（对象库实际占用 + 各工作区记录分布）
      return historyStats(historyWorkDirs())
    }

    case 'fs.history.autoClean': {
      // 设置页：立即清理（force=true）/ 阈值触发（缺省读全局设置；定时器另有 10min 巡检）
      const gs = globalSettings as any
      const tMb = Number(p?.thresholdMb ?? gs.historyAutoCleanThresholdMb)
      const pct = Number(p?.pct ?? gs.historyAutoCleanPct)
      return autoCleanHistory(
        historyWorkDirs(),
        Math.floor((Number.isFinite(tMb) && tMb > 0 ? tMb : 500) * 1048576),
        Number.isFinite(pct) && pct > 0 ? pct : 20,
        { force: p?.force === true },
      )
    }

    case 'workspace.create':
      return { ok: true }

    // ── 项目（0911 反馈：PROJECT_CREATE 后端落地；此前纯前端 localStorage）──

    case 'project.list': {
      return { projects: listProjects() }
    }

    case 'project.create': {
      const r = createProjectStore({
        name: String(p?.name || ''),
        root_path: String(p?.root_path || ''),
        description: p?.description != null ? String(p.description) : undefined,
        members: Array.isArray(p?.members) ? p.members : undefined,
        // 前端本地乐观创建后携带自己的 id 同步上来（保证 id 一致，不产生双份）
        id: p?.id != null ? String(p.id) : undefined,
      })
      if (!r.ok) throw new Error(r.error)
      broadcastHost({ type: 'host/projects-changed' })
      return r
    }

    /* ★ 0921z-2：删除项目时"是否连工作区一起删" —— 由前端删除确认框的复选框决定（默认勾选）。
       走后端 → **系统回收站**（可还原），并在后端做硬护栏（盘符根/系统目录/受保护目录一律拒绝）。
       注意：这是**用户主动操作**，不是 AI 工具；不涉及审批门禁。 */
    case 'project.deleteFiles': {
      const target = String(p?.path || '').trim()
      const r = await deleteDirToRecycleBin(target, {
        protect: [
          DATA_ROOT,                    // 数据根（projects.json / sessions 都在这）
          SKILLS_ROOT,                  // 技能目录
          PROJECT_ROOT,                 // 源码根（D:\nis0812）
          BACKEND_ROOT,                 // 后端根
          String((globalSettings as any).storagePath || ''),  // 存储根
          defaultStorageRoot(),         // 默认存储根
          os.homedir(),                 // 用户主目录
          path.parse(DATA_ROOT).root,   // 数据根所在盘符根
        ],
      })
      if (r.ok) console.log(`[projects] 工作区已移入回收站：${r.path}`)
      else console.warn(`[projects] 工作区删除被拦/失败：${r.path} → ${r.error}`)
      return r
    }

    case 'project.update': {
      /* ★1005：p 是 Record<string, unknown> ⇒ p.patch 的每个字段都报"属性不存在"（5 处）。
         按**下游入参的实际类型**声明局部变量（Partial<Parameters<…>[1]>）—— 不手写字段类型，与 store 签名精确对齐。 */
      const patch = (p?.patch || {}) as Partial<NonNullable<Parameters<typeof updateProjectStore>[1]>>
      const r = updateProjectStore(String(p?.id || ''), {
        name: patch.name,
        description: patch.description,
        status: patch.status,
        members: patch.members,
        pinned: patch.pinned,
      })
      if (!r.ok) throw new Error(r.error)
      broadcastHost({ type: 'host/projects-changed' })
      return r
    }

    case 'project.delete': {
      const r = deleteProjectStore(String(p?.id || ''))
      broadcastHost({ type: 'host/projects-changed' })
      return r
    }

    // ── 供应商/模型 ──

    case 'providers.list': {
      const st = getState()
      return {
        providers: st.providers.map(p => {
          /* ★ 0930 密钥加密（B 方案）：落盘是密文，这里解密成明文回填 —— 前端交互一点不变。
             keyLocked=true = 落盘有 key 但本机解不开（多见于导入了别台机器的包），
             此时 hasKey 仍为 true（用户确实配过），别让它看起来像"从没配过"。*/
          const _k = revealKey(p.id)
          return {
            id: p.id, name: p.name, base: p.base, enabled: p.enabled, logo: p.logo || '',
            hasKey: !!p.apiKey,
            apiKey: _k.apiKey,
            keyLocked: _k.locked,
            keyHint: p.keyHint || '',
          proxyUrl: (p as any).proxyUrl || '',
          // 0910：协议（前端供应商卡选择器回填；缺省 openai-completions）
          protocol: p.protocol || 'openai-completions',
          models: (p.models || []).map(m => ({
            id: m.id, name: m.name, inputPrice: m.inputPrice ?? 0, outputPrice: m.outputPrice ?? 0,
            maxContext: m.maxContext ?? 0, capabilities: m.capabilities || [], enabled: m.enabled !== false,
            // 0909③：三轴字段也要回传——新浏览器整表回填时缺了这些，行内编辑/闸门会丢用户勾过的显式能力
            inputModalities: m.inputModalities, outputModalities: m.outputModalities, supports: m.supports,
            completionParam: m.completionParam,
            // 0910：思考挡位声明（原始值）+ 解析后的可用挡（前端下拉直接消费，与后端发送钳位同源）
            efforts: m.efforts,
            effortsResolved: resolveModelEfforts(p.id, m.id),
            // 0907 A+B：能力真相源快照（前端本轮不消费，UI 接入徽标/闸门提示时直接用，避免再造一套推断）
            caps: resolveModelCaps(p.id, m.id),
          })),
          }
        }),
        providerActive: st.providerActive,
        activeModelId: st.activeModelId,
        /* ★1012t：后台模型（非对话场景专用）—— 前端「设置 → 人格 → 后台模型」选择器据此回显 */
        backgroundProviderId: st.backgroundProviderId || '',
        backgroundModelId: st.backgroundModelId || '',
        backgroundEffort: String((st as any).backgroundEffort || ''),
        // 2026-09-12：全局推理强度（非对话场景统一用）
        activeEffort: st.activeEffort || '',
      }
    }

    case 'providers.setKey': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const key = p?.apiKey as string | undefined
      if (!pid) throw new Error('providerId required')
      setProviderKey(pid, key || '')
      return { ok: true }
    }

    // 0917：从供应商地址抓站点图标当头像（前端悬停头像的「获取 logo」）
    case 'providers.fetchLogo': {
      const pid = String(p?.providerId || '').trim()
      if (!pid) throw new Error('providerId required')
      return await fetchProviderLogo(pid, typeof p?.url === 'string' ? p.url : '')
    }

    // 0917：清除自定义头像，回到自带图标
    case 'providers.clearLogo': {
      const pid = String(p?.providerId || '').trim()
      if (!pid) throw new Error('providerId required')
      setProviderLogo(pid, '')
      return { ok: true }
    }

    case 'providers.setModel': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const mid = p?.modelId ?? p?.model_id as string | undefined
      if (!pid || !mid) throw new Error('providerId and modelId required')
      // effort：undefined = 不改；null/'' = 清除全局强度
      const effort = ('effort' in (p || {})) ? (p.effort === null ? null : String(p.effort ?? '')) : undefined
      setActiveModel(pid, mid, effort)
      // 0913：全局模型变更留痕（排查「模型怎么自己变了」——时间/供应商/模型一目了然）
      /* ★1012p：日志补**时间戳 + payload 键名**（实测"全局模型自己变回去"，而旧日志只有一行、
         既没时间戳也没来源 ⇒ 真出事了定位不到凶手）。不同前端路径传的字段不一样（设置页选择器 /
         聊天窗下拉 / 预设应用 / 渠道…），键名一看就知道是谁调的；时间戳能跟"我刚切完多久"对上。 */
      console.log(`[providers] setModel → ${pid} / ${mid}${effort !== undefined ? ` (effort=${effort === null ? 'null' : effort})` : ''} @ ${new Date().toLocaleString('zh-CN')} keys=[${Object.keys(p || {}).join(',')}]`)
      /* ★1012o（已定案："能不能改成以后端为权威反推？我最新从前端写到了后端，其他哪怕旧页面打开也应该同步新值"）：
         全局模型/强度属于**设置**，后端改完必须**广播**出去 —— 否则各窗口只在"连上那一刻拉一次"，
         长期开着的标签页会永远停在旧值，甚至反过来在发消息时把旧值推回后端（1012n 的漂移闭环）。
         前端在 ChatInterface 监听 host/providers-updated → 调 useProvidersStore().syncFromBackend()，
         所有窗口（含远程端 / 旧标签页）实时对齐到后端权威值。 */
      try {
        broadcastHost({ type: 'host/providers-updated', provider: pid, model: mid, effort: getState().activeEffort || '' })
      } catch { /* 广播失败不影响设置已落盘（前端下次连上仍会拉到权威值） */ }
      return { ok: true, provider: pid, model: mid, effort: getState().activeEffort || '' }
    }

    /* ★1012t：**后台模型**（非对话场景专用）—— 知识库/记忆库自动提炼、QQ/微信渠道（未单独配模型时）等。
       ★1013：另外带**推理强度**（effort；"effort" 键存在才改，null/'' = 清空 → 按模型默认挡）。
       注意：清空后台模型**不再回落聊天模型**了 —— 后端会明确失败 + 通知用户去设置里选（用户："不要自动回落"）。 */
    case 'providers.setBackgroundModel': {
      const bgPid = String(p?.providerId ?? p?.provider ?? '')
      const bgMid = String(p?.modelId ?? p?.model_id ?? '')
      const bgEffort = ('effort' in (p || {})) ? (p.effort === null ? null : String(p.effort ?? '')) : undefined
      setBackgroundModel(bgPid, bgMid, bgEffort)
      const bgEffortNow = String((getState() as any).backgroundEffort || '')
      console.log(`[providers] setBackgroundModel → ${bgPid || '(清空)'} / ${bgMid || '(清空)'}${bgEffort !== undefined ? ` (effort=${bgEffort === null ? 'null' : bgEffort})` : ''} @ ${new Date().toLocaleString('zh-CN')}`)
      try {
        broadcastHost({ type: 'host/providers-updated', backgroundProviderId: bgPid, backgroundModelId: bgMid, backgroundEffort: bgEffortNow })
      } catch { /* 广播失败不影响已落盘（前端下次连上仍会拉到） */ }
      return { ok: true, backgroundProviderId: bgPid, backgroundModelId: bgMid, backgroundEffort: bgEffortNow }
    }

    // 2026-09-12：单独设置全局推理强度（非对话场景统一用）
    case 'providers.setEffort': {
      const effort = p?.effort === null || p?.effort === '' ? null : String(p?.effort ?? '')
      setActiveEffort(effort)
      return { ok: true, effort: getState().activeEffort || '' }
    }

    case 'providers.setBase': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const base = p?.base as string | undefined
      if (!pid || !base) throw new Error('providerId and base required')
      setProviderBase(pid, base)
      return { ok: true }
    }

    case 'providers.setProxy': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const proxyUrl = (p?.proxyUrl ?? p?.proxy ?? '') as string
      if (!pid) throw new Error('providerId required')
      setProviderProxy(pid, String(proxyUrl || ''))
      return { ok: true, proxyUrl: String(proxyUrl || '').trim() }
    }

    // 0910 协议扩展：openai-completions（默认）/ anthropic-messages / google-generative-ai
    case 'providers.setProtocol': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const protocol = String(p?.protocol || '').trim()
      if (!pid) throw new Error('providerId required')
      const valid = ['openai-completions', 'anthropic-messages', 'google-generative-ai']
      if (protocol && !valid.includes(protocol)) throw new Error(`不支持的协议：${protocol}`)
      setProviderProtocol(pid, (protocol || undefined) as any)
      return { ok: true, protocol: protocol || 'openai-completions' }
    }

    case 'providers.toggle': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const enabled = !!p?.enabled
      if (!pid) throw new Error('providerId required')
      toggleProviderEnabled(pid, enabled)
      return { ok: true }
    }

    case 'providers.add': {
      /* ★ 0930：enabled 可选传入 —— 前端取模型前会"确保后端有这家"（providers.add），
         若沿用旧默认（启用数<12 就 enabled=true），会把一家**还没填模型**的供应商
         自动启用，可能被自愈逻辑选中 → 调用必失败。故允许调用方显式带原状态。*/
      addProvider({ id: p?.id as string, name: p?.name as string, base: p?.base as string, protocol: p?.protocol as any, enabled: typeof p?.enabled === 'boolean' ? p.enabled : undefined })
      return { ok: true }
    }

    case 'providers.remove': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      if (!pid) throw new Error('providerId required')
      removeProvider(pid)
      return { ok: true }
    }

    case 'providers.setModels': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      if (!pid) throw new Error('providerId required')
      setModels(pid, (p?.models as ProviderModel[]) || [])
      return { ok: true }
    }

    case 'providers.fetchModels': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      if (!pid) throw new Error('providerId required')
      return await fetchModelsRemote(pid)
    }

    case 'providers.test': {
      const pid = p?.providerId ?? p?.provider as string | undefined
      const mid = p?.modelId ?? p?.model_id as string | undefined
      if (!pid) throw new Error('providerId required')
      return await testConnectionRemote(pid, mid)
    }

    // ── 计费 ──

    case 'billing.stats': {
      const period = (p?.period as string) || 'day'
      return stats(period as BillingPeriod)
    }

    case 'billing.reset':
      resetStats()
      return { ok: true }

    case 'llm.providers': {
      const st = getState()
      return { providers: st.providers.map(p => ({ id: p.id, name: p.name, enabled: p.enabled })) }
    }

    case 'llm.models': {
      const p = getState().providers.find(x => x.id === getState().providerActive)
      return { models: (p?.models || []).map(m => ({ id: m.id, name: m.name, contextWindow: m.maxContext || 0, maxTokens: 0 })) }
    }

    case 'goal.list':
      return { goals: [] }

    case 'subagent.list':
      return { subagents: [] }

    // Settings
    case 'settings.describe': {
      const st = getState()
      const p = st.providers.find(x => x.id === st.providerActive)
      return {
        settings: {
          'agent-default-model': { provider: st.providerActive, model: p?.models?.[0]?.id || '' },
        }
      }
    }
    case 'settings.update':
      return { ok: true }
    case 'settings.replace':
      return { ok: true }
    case 'settings.mutate':
      return { ok: true }

    // Credentials
    case 'credentials.describe': {
      const st = getState()
      const creds: Record<string, { configured: boolean }> = {}
      for (const p of st.providers) {
        creds[`${p.id}_API_KEY`] = { configured: !!p.apiKey }
      }
      return { credentials: creds }
    }
    case 'credentials.set':
      return { ok: true }
    case 'credentials.unset':
      return { ok: true }

    // Agent presets（文件化存储：backend/data/agent-presets/<id>/preset.json）
    case 'agentPreset.list':
      return { presets: listAgentPresets() }
    case 'agentPreset.tools':
      // 工具唯一源（0904 捋顺）：静态目录 + MCP/自定义实时合并；附 server 汇总（开关A 复选/开关B 展示用）
      return { tools: currentToolRegistry(), mcpServers: currentMcpServersView() }
    case 'agentPreset.read': {
      const preset = readAgentPreset(String(p?.id || ''))
      if (!preset) throw new Error('preset not found')
      return { preset }
    }
    case 'agentPreset.write': {
      const r = writeAgentPreset(p?.preset as any)
      if (!r.ok) throw new Error(r.error)
      return { ok: true, preset: r.preset }
    }
    case 'agentPreset.delete': {
      const err = deleteAgentPreset(String(p?.id || ''))
      if (err) throw new Error(err)
      return { ok: true }
    }

    // Host
    case 'host.pickDirectory':
      return { path: null, canceled: true }
    case 'host.listDirectory':
      return { entries: [] }
    case 'host.createDirectory':
      return { ok: true }
    case 'host.openPath':
      return { ok: true }

    // Goals
    case 'goal.list':
      return { goals: [] }
    case 'goal.create':
      return { id: crypto.randomUUID(), ...(p as any) }
    case 'goal.edit':
    case 'goal.pause':
    case 'goal.resume':
    case 'goal.complete':
    case 'goal.clear':
      return { ok: true }

    // Skills（真实列表：backend/skills/ 目录 SKILL.md）
    case 'skill.list': {
      /* ★1012：面板每次打开都强制重扫 —— 修「新增技能后必须重启后端才看得到」。
         实测：新建 skills/nis-release/ 后，运行中的后端 skill.list 仍返回旧清单
         （连"再建一个探针技能"也照样看不到），用户在「skill仓库」面板里就是找不到新技能。
         getSkills() 自身有 60s 缓存 + invalidateSkillCache() 只被 install.uninstall 调用
         ⇒ 面板这条路没有任何失效入口。这里先失效再取；技能目录很小（扫描 <50ms），代价可忽略。 */
      invalidateSkillCache()
      const skillsAll = await getSkills()
      const _offSet = skillDisabledSet()
      return {
        skills: skillsAll.map(s => ({ name: s.name, description: s.description || '', builtin: false, filePath: s.filePath, enabled: !_offSet.has(String(s.name)) })),
        autoSelect: skillAutoSelectOn(),
      }
    }

    // ── 安装助手：记录 / 卸载 ──
    case 'install.log': {
      return { records: readInstallLog() }
    }

    case 'install.sessions': {
      // 安装助手的历史会话列表（独立于主聊天，按 presetId 过滤）
      return {
        sessions: Array.from(sessions.values())
          .filter(s => s.presetId === 'install-assistant')
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map(s => ({ id: s.id, title: s.title || '安装会话', updatedAt: s.updatedAt || 0 })),
      }
    }

    case 'install.uninstall': {
      const name = p?.name as string | undefined
      const type = p?.type as string | undefined
      if (!name || !type) throw new Error('name and type required')
      // 技能支持嵌套删除（技能包子目录，如 skills/ui-skills/skills/baseline-ui）：
      // 顶层没有时深扫所有 SKILL.md 定位同名目录；安全校验：目标必须真在 SKILLS_DIR 内
      // ★0929"删了又回来"修复：同名技能包存在**多份物理副本**（如 ui-skills/skills/* 与
      // ui-ux-pro-max-skill/skills/* 各有一份 brand/design/slides/ui-styling），旧 walk 找到第一个
      // 同名目录就 return 删一个、其余副本留下 → 重扫列表同名条目还在（加载器同名去重只显示一条），
      // 用户体感"删掉之后又回来"。现在同名副本**全部收集一并删除**（顶层同名目录也算）。
      // 0906 体检 P0#3 的越界校验保留：每个目标都必须在 SKILLS_DIR/MCP_DIR 根内（name='..' 拦截）。
      const rootAbs = path.resolve(type === 'skill' ? SKILLS_DIR : MCP_DIR)
      const targets: string[] = []
      const pushTarget = (t: string) => {
        const abs = path.resolve(t)
        if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) {
          throw new Error('非法的卸载目标（路径越界）')
        }
        targets.push(abs)
      }
      if (type === 'skill') {
        // 顶层同名目录（保留历史行为：无论有无 SKILL.md 都算安装目录）
        if (fs.existsSync(path.join(SKILLS_DIR, name))) pushTarget(path.join(SKILLS_DIR, name))
        // 深扫全部同名技能目录（须带 SKILL.md，防误删同名非技能目录）
        const walk = (dir: string): void => {
          let entries: fs.Dirent[] = []
          try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (!e.isDirectory()) continue
            const sub = path.join(dir, e.name)
            if (path.resolve(sub) === rootAbs) continue
            if (e.name === name && fs.existsSync(path.join(sub, 'SKILL.md'))) { pushTarget(sub); continue }
            walk(sub)
          }
        }
        walk(rootAbs)
      } else {
        pushTarget(path.join(MCP_DIR, name))
      }
      const recs = readInstallLog()
      const rec = recs.filter(r => r.type === type && r.name === name && !r.uninstalledAt).pop()
      let removed = 0
      for (const t of targets) {
        if (fs.existsSync(t)) {
          fs.rmSync(t, { recursive: true, force: true })
          removed++
        }
      }
      if (removed) invalidateSkillCache()
      if (rec) appendInstallLog({ ...rec, uninstalledAt: Date.now() })
      // 什么都没删时如实报错——旧实现返回 ok:true，前端删内存条目+重拉列表又出现（"删了又回来"的另一半）
      if (!removed) throw new Error(`未找到要卸载的技能目录：${name}`)
      return { ok: true, name, type, removed }
    }

    // ── MCP 运行时（真实连接，替代"仅记录意向"） ──
    case 'mcp.list':
      return { servers: getMcpStatus() }
    // ── 自定义工具（管理 RPC；执行走 agent 工具 custom_* 高风险审批） ──
    case 'customTool.list':
      return { tools: listCustomTools() }
    case 'customTool.save': {
      const r = saveCustomTool(p?.tool as any)
      if (!r.ok) throw new Error(r.error)
      return { ok: true, tool: r.tool }
    }
    case 'customTool.delete': {
      const err = deleteCustomTool(String(p?.name || ''))
      if (err) throw new Error(err)
      return { ok: true }
    }
    // ── 团队（P1 配置层：CRUD 与校验；编排运行时 P2） ──
    case 'teams.list':
      return { teams: listTeams() }
    // 会话级成员技能（读写二合一）：get { sessionId } → memberSkills；set { sessionId, memberId, skills } → 覆盖保存
    case 'session.memberSkills': {
      const s = sessions.get(sessionId || String(p?.sessionId || ''))
      if (!s) throw new Error('session not found')
      if (p?.memberId !== undefined) {
        const mid = String(p.memberId)
        const skills = Array.isArray(p.skills) ? p.skills.map((x: any) => String(x).trim()).filter(Boolean) : []
        if (!s.memberSkills) s.memberSkills = {}
        if (skills.length) s.memberSkills[mid] = skills
        else delete s.memberSkills[mid]
        schedulePersist()
      }
      return { memberSkills: s.memberSkills || {} }
    }
    case 'teams.read': {
      const t = readTeam(String(p?.id || ''))
      if (!t) throw new Error('team not found')
      return { team: t }
    }
    case 'teams.save': {
      const r = saveTeam(p?.team as any)
      if (!r.ok) throw new Error(r.error)
      // 热更新：编辑保存后让绑定该团队的所有会话 agent 失效（下次对话重建 agent，
      // 新成员/职责/模型即刻生效——原来要等会话重启才生效）
      try {
        if (r.team?.id) {
          for (const [sid, s] of sessions) {
            if (s.teamId !== r.team.id) continue
            const a = agents.get(sid)
            if (!a) continue
            // 运行中的会话不打断（等本轮结束）；空闲的立即重建
            if (s.status === 'running') continue
            const live = a?.state.messages
            if (Array.isArray(live) && live.length > (s.transcript?.length || 0)) {
              s.transcript = JSON.parse(JSON.stringify(live))
            }
            agents.delete(sid)
          }
          schedulePersist()
        }
      } catch { /* ignore */ }
      return { ok: true, team: r.team }
    }
    case 'teams.delete': {
      const tid = String(p?.id || '')
      const err = deleteTeam(tid)
      if (err) throw new Error(err)
      // 删除团队：活跃绑定会话解绑（下次重建 agent 退化为单 agent 模式），返回受影响数给前端提示
      let affected = 0
      for (const [, s] of sessions) {
        if (s.teamId !== tid) continue
        s.teamId = undefined
        affected += 1
        const a = agents.get(String(s.id))
        if (a) {
          const live = a?.state.messages
          if (Array.isArray(live) && live.length > (s.transcript?.length || 0)) {
            s.transcript = JSON.parse(JSON.stringify(live))
          }
          agents.delete(String(s.id))
        }
      }
      if (affected > 0) schedulePersist()
      return { ok: true, affected }
    }
    case 'session.logs':
      return { logs: readSessionLogs(sessionId || String(p?.sessionId || '')) }
    case 'blackboard.read':
      return { blackboard: loadBlackboard(sessionId || String(p?.sessionId || '')), cloneRuns: ((loadBlackboard((sessionId || String(p?.sessionId || '')) + '#clone') as any)?.runs || []), activeRuns: listActiveRunFrames(sessionId || String(p?.sessionId || '')) }
    case 'mcp.connect': {
      const r = await mcpHubInstall(String(p?.name || ''), p?.config as any)
      if (!r.ok) throw new Error(r.error || '连接失败')
      return { ok: true, tools: r.tools }
    }
    case 'mcp.setEnabled': {
      // 0904 开关B：单条 MCP server 启用/停用（停用=断连+不注入工具+仓库置灰；配置保留）
      const r = await mcpHubSetEnabled(String(p?.name || ''), p?.enabled !== false)
      if (!r.ok) throw new Error(r.error || '切换失败')
      return { ok: true, mcpServers: currentMcpServersView() }
    }
    case 'mcp.setSelected': {
      // 0904 反馈④b：服务选择复选（不选=不注入，不断进程；全选/取消全选传 all=true）
      if (p?.all === true) mcpHubSetSelectedAll(p?.selected !== false)
      else {
        const r = mcpHubSetSelected(String(p?.name || ''), p?.selected !== false)
        if (!r.ok) throw new Error(r.error || '切换失败')
      }
      return { ok: true, mcpServers: currentMcpServersView() }
    }
    case 'mcp.disconnect': {
      await mcpHubRemove(String(p?.name || ''))
      return { ok: true }
    }

    // ── 内置浏览器（0905 七批按会话隔离：sessionId=前端对话窗口 id，每会话独立实例/标签/登录态） ──
    case 'browser.start': {
      const inst = browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined)
      await inst.start({ mode: (p?.mode as 'headed' | 'headless') || undefined, home: p?.home ? String(p.home) : undefined })
      return inst.currentStatus()
    }
    case 'browser.close':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).close()
      return { ok: true }
    case 'browser.status':
      return browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus()
    case 'browser.watch':
      setBrowserWatch(true, p?.sessionId ? String(p.sessionId) : undefined)
      return { ok: true, controlledBy: browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).controlledBy, ...browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus() }
    case 'browser.unwatch':
      setBrowserWatch(false, p?.sessionId ? String(p.sessionId) : undefined)
      return { ok: true }
    // 0905 T4：人接管开关（开=占用权归人，AI 交互工具被门禁；关=让出）
    case 'browser.takeover': {
      const inst = browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined)
      inst.controlledBy = p?.on ? 'user' : ''
      try { broadcastMux('', { type: 'browser/control', sessionId: String(p?.sessionId || 'default'), by: inst.controlledBy }) } catch { /* ignore */ }
      return { ok: true, controlledBy: inst.controlledBy }
    }
    case 'browser.snapshot':
      return await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).snapshot(p?.tabId ? String(p.tabId) : undefined)
    case 'browser.eval': {
      // 本地调试/反爬验证用：在激活页执行表达式（127.0.0.1-only，无外部暴露）
      const inst = browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined)
      return { value: await (inst.tryGetTab() as any)?.evaluate(String(p?.expression || 'null')) }
    }
    case 'browser.tabs': {
      const inst = browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined)
      // mode 随行（0905 十五批：前端 2s 轮询自愈有头/无头图标，兜住事件丢失）
      return { tabs: inst.listTabs(), activeTabId: (inst.currentStatus() as any).activeTabId, mode: inst.mode }
    }
    case 'browser.navigate':
      return await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).navigate(String(p?.url || ''), p?.tabId ? String(p.tabId) : undefined)
    case 'browser.newTab':
      return await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).newTab(p?.url ? String(p.url) : undefined)
    case 'browser.closeTab':
      return await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).closeTab(String(p?.tabId || ''))
    case 'browser.switchTab':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).switchTab(String(p?.tabId || ''))
      return browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus()
    case 'browser.goBack':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).goBack(p?.tabId ? String(p.tabId) : undefined)
      return browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus()
    case 'browser.goForward':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).goForward(p?.tabId ? String(p.tabId) : undefined)
      return browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus()
    case 'browser.refresh':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).reload(p?.tabId ? String(p.tabId) : undefined, p?.hard === true)
      return browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus()
    case 'browser.stop':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).stop(p?.tabId ? String(p.tabId) : undefined)
      return { ok: true }
    case 'browser.screenshot':
      return await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).screenshot(p?.tabId ? String(p.tabId) : undefined, (p?.type as 'png' | 'jpeg') || 'jpeg')
    case 'browser.setViewport':
      // 0905 T3：viewport:'auto' 时携带面板实际尺寸（宽高自适应，消灭两侧留白）
      /* ★1005：p.custom 同样是"读不到的字段"，这里给个实际形状（取到的是数字或数字字符串）。 */
      const _cust = p?.custom as { width?: unknown; height?: unknown } | undefined
      return await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).setViewport(
        String(p?.viewport || 'pc'),
        _cust ? { width: Number(_cust.width) || 0, height: Number(_cust.height) || 0 } : undefined,
      )
    case 'browser.setMode':
      await browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).setMode((p?.mode as 'headed' | 'headless') || 'headless')
      return browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined).currentStatus()
    case 'browser.cookiesList': {
      // 0908③：设置页不带 sessionId 的查询=聚合【所有已创建实例】的 cookie。
      // 浏览器按会话隔离后（0905 七批），旧实现只查 'default' 实例=恒 0（用户登录态全在会话专属实例里）。
      // 只有 context 在跑的实例能读 cookies（空闲回收的实例磁盘 profile 保留但进程已关）。
      if (p?.sessionId) {
        return { cookies: await browserEngine.getBrowserInstance(String(p.sessionId)).cookiesList() }
      }
      const all: any[] = []
      for (const inst of browserEngine.allInstances()) {
        try {
          const cs = await inst.cookiesList()
          for (const c of cs) if (!all.some(x => x.name === c.name && x.domain === c.domain)) all.push({ ...c, instance: inst.key })
        } catch { /* 实例已关 */ }
      }
      return { cookies: all, instances: browserEngine.allInstances().length }
    }
    case 'browser.cookiesClear':
      // 0908③：与聚合显示同域——不带 sessionId 时清所有已创建实例（设置页"清空"=清用户看到的这些）。
      // 带 sessionId（浏览器面板内）只清自己会话的。
      if (p?.sessionId) {
        await browserEngine.getBrowserInstance(String(p.sessionId)).cookiesClear()
      } else {
        for (const inst of browserEngine.allInstances()) { try { await inst.cookiesClear() } catch { /* ignore */ } }
      }
      return { ok: true }
    case 'browser.input': {
      // 0905：hover 动作返回该点光标语义（前端据此切换指针形态），其余动作原样 ok
      const inst = browserEngine.getBrowserInstance(p?.sessionId ? String(p.sessionId) : undefined)
      const r = await inst.input(String(p?.action || ''), (p?.args as Record<string, any>) || {}, p?.tabId ? String(p.tabId) : undefined)
      broadcastScrollMetrics(String(p?.sessionId || 'default'))   // 0905 T3：滚动/点击后刷新页面滚动进度（悬浮滚动条）
      return { ok: true, ...(r && typeof r === 'object' ? r : {}) }
    }
    case 'browser.getSettings':
      return loadBrowserSettings()
    case 'browser.setSettings': {
      const cur = loadBrowserSettings()
      const np = (p || {}) as Partial<BrowserSettings>
      const next: BrowserSettings = {
        castFps: typeof np.castFps === 'number' ? Math.min(30, Math.max(1, Math.round(np.castFps))) : cur.castFps,
        castQuality: typeof np.castQuality === 'number' ? Math.min(95, Math.max(20, Math.round(np.castQuality))) : cur.castQuality,
        castScale: typeof np.castScale === 'number' ? (np.castScale >= 3 ? 3 : np.castScale <= 1 ? 1 : 2) : cur.castScale,
        castEveryNth: typeof np.castEveryNth === 'number' ? Math.min(3, Math.max(1, Math.round(np.castEveryNth))) : cur.castEveryNth,
        stealth: typeof np.stealth === 'boolean' ? np.stealth : cur.stealth,
        blockMedia: typeof np.blockMedia === 'boolean' ? np.blockMedia : cur.blockMedia,
        gpu: typeof np.gpu === 'boolean' ? np.gpu : cur.gpu,
        proxy: typeof np.proxy === 'string' ? np.proxy.trim() : (cur.proxy || ''),
      }
      try { fs.writeFileSync(BROWSER_SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8') } catch (e: any) { throw new Error('保存浏览器设置失败：' + String(e?.message || e)) }
      applyBrowserSettingsToEngine(next)
      return { ok: true, settings: next }
    }

    case 'fs.readForPreview': {
      // 0906 画布一批：前端读取工作区文件预览内容（"AI 正在编辑"标签点击/自动跟随用）
      const sid = String(p?.sessionId || '')
      if (!sid) throw new Error('sessionId required')
      return readForPreview(sid, String(p?.path || ''))
    }

    // Subagents
    case 'subagent.list':
      return { subagents: [] }

    // LLM
    case 'llm.discoverModels': {
      const st = getState()
      const p = st.providers.find(x => x.id === st.providerActive)
      return { models: (p?.models || []).map(m => ({ id: m.id, name: m.name, provider: p.id, contextWindow: m.maxContext || 0, maxTokens: 0 })) }
    }

    // Workspace
    case 'workspace.create':
      return { ok: true }

    // Session extras（兼容旧协议：切模型 → 供应商状态）
    case 'session.selectModel': {
      const pid = p?.provider ?? p?.providerId as string | undefined
      const mid = p?.model_id ?? p?.modelId as string | undefined
      if (pid && mid) setActiveModel(pid, mid)
      return { ok: true }
    }

    // 联网搜索配置（前端设置面板：引擎选择 + API Key 管理 + 连通性测试）
    case 'websearch.getConfig':
      return getWebSearchConfig()
    case 'websearch.setConfig': {
      const providerId = String(p?.provider || '') as SearchProviderId
      // 0908五：带 network={mode,proxyUrl} 时同时切网络出口；clearKey 支持重填/清除已存 key
      const err = setWebSearchConfig(providerId, p?.apiKeys, p?.network)
      if (err) throw new Error(err)
      console.log(`[websearch] engine switched to: ${providerId}`)
      return { ok: true, ...getWebSearchConfig() }
    }
    case 'websearch.testConfig': {
      // 连通性测试：直接用当前配置跑一次真实搜索（结果数截 3 条验证链路）
      const { runSearchProbe } = await import('./webTools.ts')
      try {
        const probe = await runSearchProbe('hello world', 3)
        return { ok: true, engine: probe.engine, count: probe.results.length }
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    }

    // 版本面板：git 提交时间线（只读）。仓库根路径 = "是不是同一个项目"的唯一判据（见 gitTimeline.ts 头注）
    // repoDir：面板可"关联"别的仓库（在 A 工作区看 B 的提交）—— 必须显式传，绝不静默换目标
    case 'git.timeline': {
      const wd = String(p?.repoDir || '').trim() || (sessions.get(String(p?.sessionId || ''))?.workDir || '').trim()
      const { buildGitTimeline } = await import('./gitTimeline.ts')
      return await buildGitTimeline(wd, Number(p?.limit) || 30)
    }

    // 版本面板：初始化仓库（只新增 .git，不 add / 不 commit / 不动既有文件）。仅用户点按钮时触发，绝不自动执行
    case 'git.init': {
      const wd = String(p?.repoDir || '').trim() || (sessions.get(String(p?.sessionId || ''))?.workDir || '').trim()
      const { initGitRepo } = await import('./gitTimeline.ts')
      return await initGitRepo(wd)
    }

    // 版本面板「关联」：从本会话消息里出现过的路径反推"有关的仓库"（只认证据，不猜）
    case 'git.related': {
      const s = sessions.get(String(p?.sessionId || ''))
      if (!s) return { repos: [] }
      // 只扫最近 60 条（跨目录的证据通常就在近期；长会话省时间，也不吃内存）
      const recent = (Array.isArray((s as any).messages) ? (s as any).messages : []).slice(-60)
      const { relatedRepos } = await import('./gitTimeline.ts')
      return { repos: await relatedRepos(JSON.stringify(recent)) }
    }

    // 版本面板：提交前预检（数一数到底要提交多少文件；未跟踪目录必须展开数，否则严重低估）
    case 'git.preview': {
      const wd = String(p?.repoDir || '').trim() || (sessions.get(String(p?.sessionId || ''))?.workDir || '').trim()
      const { previewCommitFiles } = await import('./gitTimeline.ts')
      return await previewCommitFiles(wd)
    }

    // 版本面板：手动提交（来源标 Nis-Source: user）。仅用户点按钮时触发
    case 'git.commit': {
      const s = sessions.get(String(p?.sessionId || ''))
      const wd = String(p?.repoDir || '').trim() || (s?.workDir || '').trim()
      const { commitRepo } = await import('./gitTimeline.ts')
      return await commitRepo(wd, String(p?.message || ''), {
        sessionId: String(p?.sessionId || ''),
        sessionTitle: s?.title,
        ...(p?.path ? { path: String(p.path) } : {}),
      })
    }

    // 版本面板：撤销某次提交（git revert = 生成反向提交，历史保留、可再撤销）。冲突会自动回滚并如实报
    case 'git.revert': {
      const wd = String(p?.repoDir || '').trim() || (sessions.get(String(p?.sessionId || ''))?.workDir || '').trim()
      const { revertCommit } = await import('./gitTimeline.ts')
      return await revertCommit(wd, String(p?.hash || ''))
    }

    // 时光机：回到某个存档点（git reset --hard；**先自动打备份标签**，打不上就中止）
    case 'git.reset': {
      const wd = String(p?.repoDir || '').trim() || (sessions.get(String(p?.sessionId || ''))?.workDir || '').trim()
      const { resetToCommit } = await import('./gitTimeline.ts')
      return await resetToCommit(wd, String(p?.hash || ''))
    }

    // 时光机：清除备份标签（= 删掉「其他存档点」里的线；只删标签，不动提交与工作区）
    case 'git.drop': {
      const wd = String(p?.repoDir || '').trim() || (sessions.get(String(p?.sessionId || ''))?.workDir || '').trim()
      const { dropBackups } = await import('./gitTimeline.ts')
      return await dropBackups(wd, p?.tag ? String(p.tag) : undefined)
    }

    default:
      /* ★1012：静默降级 = 事故源。1012 定时任务 UI「保存后仍为空」的根因就是：前端调
         task.list/create/... 六个方法全落到这里，返回 ok:true ⇒ 前端当成功、弹窗照关、
         实际零效果（排查花了整轮）。这里**保留兼容返回值**（不制造硬错误，避免打翻
         未知的容错路径），但必须**可见**：日志升级为 warn 并写明"没有任何后端效果"，
         前端 bridgeRpc 同步把它暴露到控制台（window.__nisUnhandledMethods 可查）。 */
      console.warn(`[pi-bridge] ⚠ 未实现的方法（前端调了不存在的 RPC）: ${method} —— 本次调用没有任何后端效果`)
      return { ok: true, _unhandled: method }
  }
}

function buildWorkspaceView(): WorkspaceView {
  /* ★0927 P1-3 同类第二处（顺手）：原来这里把**全部会话整条**（含 messages）推给前端，
     而 `host/workspace-changed` 在**全仓 + src-tauri 零消费方**——却随每次页面加载走一遍 host SSE
     （188 会话 ≈ 与 session.list 同量级，几十 MB）。这里只留元数据（协议字段名不变，老消费方拿到也不会崩）。 */
  return {
    id: 'default',
    name: '默认工作区',
    sessions: Array.from(sessions.values()).map(s => ({
      id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
      model: s.model, modelProviderId: s.modelProviderId, status: s.status, workDir: s.workDir,
      presetId: s.presetId, teamId: s.teamId, projectId: s.projectId,
      messages: [],
    })) as SessionView[],
  }
}

// --- Helpers ---

/** 解析产出物路径并校验在会话工作区内（用户点击的 fs 操作，不走 AI 权限门禁） */
function resolveWorkdirPath(session: { workDir?: string }, input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new Error('path required')
  const workdir = session.workDir ?? process.cwd()
  const full = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workdir, raw)
  const rel = path.relative(workdir, full)
  if (rel === '' || rel === '.') return full
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path outside workdir')
  return full
}

// ── 知识库附件本地存储（0911：attachment.upload/get/delete RPC 的后端支撑） ──
/* 0924 二期批3：知识附件随库锁死【安装目录固定文件夹】（用户盘点：知识库相关文件都进固定文件夹）。
 * 旧目录 <DATA_ROOT>/knowledge-attachments 有存量 → 拷贝搬家（拷贝不删旧，可回滚），认标记幂等。 */
const ATTACHMENT_ROOT = (() => {
  const want = path.join(defaultMemoryDir(), 'knowledge-attachments')
  const legacy = path.join(DATA_ROOT, 'knowledge-attachments')
  const marker = path.join(want, '.moved-0924-lockdir')
  try {
    fs.mkdirSync(want, { recursive: true })
    if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(want)) {
      let n = 0, failed0927 = 0
      /* ★0927 netfix ATT-0927-netfix：整树递归拷贝（原实现只拷顶层文件，<entryId>/<file> 子目录
         全部漏拷，且无条件写 marker 永久锁死 → 存量知识附件静默全部不可见）。marker 改为纯记录；
         外层门闸去掉 ⇒ 已写过 marker 的机器下次启动也会自愈补拷（幂等，已存在的不覆盖）。 */
      const copyTree0927 = (sd: string, dd: string) => {
        try { fs.mkdirSync(dd, { recursive: true }) } catch { failed0927++; return }
        for (const e of fs.readdirSync(sd, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue
          const sp = path.join(sd, e.name)
          const dp = path.join(dd, e.name)
          try {
            if (e.isDirectory()) copyTree0927(sp, dp)
            else if (e.isFile() && !fs.existsSync(dp)) { fs.copyFileSync(sp, dp); n++ }
          } catch (err) { failed0927++; console.warn('[knowledge-attachments] 拷贝失败（旧档保留）:', sp, String(err)) }
        }
      }
      copyTree0927(legacy, want)
      fs.writeFileSync(marker, 'moved ' + new Date().toISOString() + ' from ' + legacy + ' files=' + n + (failed0927 ? ' failed=' + failed0927 : ''))
      if (n) console.log('[knowledge-attachments] 0924 搬家：存量附件 ' + n + ' 个已拷到 ' + want + '（旧的保留可回滚）')
    }
  } catch (e) {
    console.warn('[knowledge-attachments] 0924 搬家失败（用新目录，旧数据暂留原地）:', e)
  }
  return want
})()

/** 附件文件名消毒：去掉路径分隔符与危险字符，保留扩展名 */
function sanitizeAttachmentName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').trim()
  const safe = base.replace(/^\.+/, '')
  return safe || `file_${Date.now()}`
}

/** nis:// 或相对路径 → 附件根内的绝对路径（拒绝越界） */
function resolveAttachmentPath(input: string): string {
  const raw = String(input || '').replace(/^nis:\/\//, '').trim()
  if (!raw) throw new Error('path required')
  const full = path.resolve(ATTACHMENT_ROOT, raw)
  const rel = path.relative(ATTACHMENT_ROOT, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path outside attachments')
  return full
}

function sendRpcError(res: ServerResponse, rpcId: string, message: string): void {
  /* ★0927 P0-2：出口统一过翻译层（内部 API 名/内部 code 不进用户视野；未命中则原文透传，不编造不吞错） */
  const frame: ServerResponse_Frame = { type: 'server-response', rpcId, result: { ok: false, error: humanizeUserFacingError(message) } }
  /* ★0927 P2-6 加固：调用方（页面刷新/关标签/MCP 会话断开）先走了 → 响应写不进去。
     这里不下发、不抛错：任务早已在服务端跑完并落盘（session.history 可回看），断连不该再引发一次异常。 */
  if (res.writableEnded || res.destroyed) return
  try {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(frame))
  } catch { /* 对端已断：同上，忽略 */ }
}

const MAX_BODY_BYTES = 64 * 1024 * 1024 // 64MB：容纳多张 base64 图片附件，同时挡住异常超大 POST 打爆内存
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large (>64MB)'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolve(text ? JSON.parse(text) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// ============================================================================
// Start
// ============================================================================

/* ★ 0921z：项目存储根来源（相对 root_path 兜底解析用；设置页改了存储目录也热读） */
setProjectStorageRootProvider(() => String((globalSettings as any).storagePath || defaultStorageRoot()))
// 0924 二期批6b-2：记忆蒸馏的 LLM 注入（依赖倒置，避免 memoryBridge↔server 循环引用）
/* ★1012t：后台模型的 override 形态（{provider, model_id}）。
   ★1013：未配置 / 所指供应商不可用 → null —— **不再回落全局聊天模型**（调用方必须明确失败 + 提醒）。 */
function backgroundLlmCfg(): { provider: string; model_id: string; effort?: string | null } | null {
  const c = backgroundLlmConfig()
  // ★1013：effort 一起带上 —— 提炼这类非对话调用也要按后台模型自己的强度跑
  return c.configured ? { provider: c.providerId, model_id: c.model, effort: c.effort } : null
}
/* ★1012t：后台模型调用失败 → 广播一条「系统通知」，前端 pushSystem 落进侧边栏铃铛面板。
   用户需求原话："提炼的时候触发了，全局模型要是没费用了或者报错，要发一条系统通知"。
   防刷屏：同类错误 60 秒内只发一条（提炼/蒸馏可能重试或批量触发，不然面板会被刷爆）。 */
const _bgFailLastAt = new Map<string, number>()
function notifyBackgroundModelFailure(what: string, err: unknown): void {
  try {
    const detail = String((err as any)?.message || err || '未知错误').slice(0, 220)
    const cfg = backgroundLlmConfig()
    const key = `${what}|${detail.slice(0, 60)}`
    const now = Date.now()
    if (now - (_bgFailLastAt.get(key) || 0) < 60_000) return
    _bgFailLastAt.set(key, now)
    /* ★1013：未配置后台模型时，这条通知本身就是"去设置里选一个"的行动指引（用户："留空就弹提醒让用户自己去选"） */
    const _who = cfg.configured ? `${cfg.providerName || cfg.providerId} / ${cfg.model}` : '未配置'
    broadcastHost({
      type: 'host/system-notice',
      level: 'error',
      category: 'error',
      title: cfg.configured ? `${what}失败（后台模型）` : `未配置「后台模型」——${what}干不了活`,
      message: `${_who}：${detail}`,
    })
    console.warn(`[background-model] ${what} 失败 → 已发系统通知：`, detail)
  } catch { /* 通知本身失败不影响主流程 */ }
}
/* ★1012t：记忆蒸馏/提炼改走**后台模型**（已定案："这个全局模型我本想的就是作为一个对话之外的工作模型，
   能不能把他们分开"，命名「后台模型」）。opts.override 若被调用方显式传入（个别场景自带指定模型）仍优先尊重。
   失败 → 发系统通知（提炼是最典型的"后台模型挂了"场景，见上）。 */
setDistillLlm(async (prompt, system, opts) => {
  const _ov = (opts as any)?.override || backgroundLlmCfg()
  /* ★1013（已定案）：后台模型没配 ⇒ **不做任何回落**（拿聊天模型顶上 = 偷用户的钱），
     直接失败并弹通知，把"去 设置 → 通用 → 模型 → 后台模型 选一个"摆到用户面前。 */
  if (!_ov) {
    const why = backgroundLlmConfig().reason || '未配置「后台模型」'
    notifyBackgroundModelFailure('记忆/知识提炼', why)
    throw new Error(why)
  }
  try {
    return await llmOnceDirect(prompt, system, { ...(opts as any), override: _ov })
  } catch (e) {
    notifyBackgroundModelFailure('记忆/知识提炼', e)
    throw e
  }
})

/* ★ 0921z：存量 root_path 自愈（相对路径 → 绝对路径）。
 *  必须在 loadSessions() **之前**——此时 projects.json / sessions/*.json 尚未进内存，
 *  直接改盘不会被内存缓存回写覆盖。幂等；落盘前整份备份（projects.json.bak-rootpath-*）。 */
try {
  const mig = migrateRootPathsOnDisk({
    dataRoot: DATA_ROOT,
    storageRoot: String((globalSettings as any).storagePath || defaultStorageRoot()),
  })
  const np = mig.projects.changed.length
  const ns = mig.sessions.changed.length
  if (np || ns) {
    console.log(`[paths] 存量 root_path 迁移：项目 ${np} 个、会话 ${ns} 条`)
    for (const c of mig.projects.changed) console.log(`[paths]   项目「${c.name}」${c.from} → ${c.to}${c.resolved ? '' : '  ⚠ 未找到真实目录，按存储根兜底'}`)
    if (mig.backup) console.log(`[paths]   备份：${mig.backup}`)
    if (mig.sessionBackup) console.log(`[paths]   会话备份：${mig.sessionBackup}`)
  } else {
    console.log(`[paths] 存量 root_path 检查完成：${mig.projects.scanned} 个项目 / ${mig.sessions.scanned} 个会话，全部为绝对路径`)
  }
} catch (e) {
  console.error('[paths] 存量 root_path 迁移失败（不影响启动）：', e)
}

loadSessions()
// 0911 #16：启动即完成一次落盘——把冷启动成本（旧单文件迁移成 sessions/ 目录、base64 剥离写 assets）
// 提前到启动阶段；此后每次 schedulePersist 都是热态（strip ~140ms + stringify ~80ms）。
try { persistSessionsSync() } catch { /* ignore */ }

// Agent 预设：启动 seed（内置预设文件夹不存在时写入，已有不覆盖）
initAgentPresets()

// MCP 运行时：按配置目录后台连接（失败不影响主服务）
// 先注册内置虚拟 server（让 mcpHubConnect 的 virtual 守卫在其后的磁盘扫描里生效），再扫描磁盘真 MCP
registerBuiltinVirtualServers()
applyBrowserSettingsToEngine(loadBrowserSettings()) // 启动即把浏览器流畅度/反爬/渲染参数注入 engine
void mcpHubInit()

// 会话执行日志：清理 7 天前旧文件
cleanupOldLogs()
// 团队存储：目录为空时写入示例团队
initTeams()

// 成员单聊回写守卫（0904）：runMemberChat 结束落库前查会话是否仍存活（删除后迟到结果不回写）
setMemberChatSessionLivenessCheck((sid) => sessions.has(sid))

// 0911 反馈③：文件写锁的 run 存活查询（残留锁兜底——owner run 已失活时新持有者可直接抢锁）
setFileLockRunLiveness(isRunActive)

// 0911：成员单次运行上限热读（设置·通用「成员单次运行上限」）。档位 30/60/120/240 分钟、0=不设限；
// 映射：activeMs=连续工作硬上限（权限等待挂起不计入），wallMs=绝对墙钟（含挂起）= 2×activeMs。
// 不设限时仅保留 10 分钟无活动看门狗（teamRuntime 内部常量，不可关）——防挂死兜底永远在。
setMemberRunLimitProvider(() => {
  const m = Number((globalSettings as any).memberRunLimitMinutes)
  const raw = Number.isFinite(m) ? m : 30
  if (raw === 0) return { activeMs: Number.POSITIVE_INFINITY, wallMs: Number.POSITIVE_INFINITY }
  const activeMs = Math.max(15, Math.min(480, raw)) * 60_000
  return { activeMs, wallMs: activeMs * 2 }
})

// 0911 三批：成员巡检官——规则预筛常驻（零成本）；复审走 inspectorReviewDirect 轻量直调。
// 开关走设置·通用（memberInspector，默认开），热读无需重启；复审失败静默（不影响成员运行）。
setMemberInspectorProvider(() => (globalSettings as any).memberInspector !== false)
setInspectorReviewer(inspectorReviewDirect)
/* ★1005（已定案"分身还在跑 ⇒ 会话就是进行中"）：最后一个成员/分身 run 收尾 →
   把会话置 idle 并广播（**这里才是权威的收轮点**，前端零启发式）。 */
setSubAgentsIdleHook((sid) => {
  try {
    const s = sessions.get(String(sid || ''))
    if (!s || s.status !== 'running') return   // 已被 abort/cancel 置 idle：不重复
    /* ★1005 补（自查发现）：**该会话还有活着的 agent = 「分身回归」刚自动拉起了一轮** ——
       绝不置 idle（否则会把正在流式的新一轮状态打断）。 */
    if (agents.get(String(sid || ''))) return
    s.status = 'idle'
    s.updatedAt = Date.now()
    schedulePersist()
    broadcastMux(String(sid), { type: 'session/status', sessionId: String(sid), running: false })
    broadcastHost({ type: 'host/session-status', sessionId: String(sid), running: false })
    sessionLog(String(sid), 'info', 'lifecycle', '所有分身/成员 run 已收尾，会话置 idle')
  } catch (e) { console.warn('[subagent] 会话置 idle 失败:', e) }
})

// A4 会话数据启动滚动备份（0911 #16 起备份拆分后的目录）：data/sessions/ 一次损坏即多会话受损。
// 启动时若存在且当天尚未备份，递归复制到 data/backups/sessions.<date>/，保留最近 7 份。
// （迁移前的单文件 sessions.<date>.json 同目录共存，一并按保留策略回收；presplit 快照不参与淘汰）
function backupSessionsOnStartup(): void {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return
    // 空目录不备份（否则占掉当天名额、真数据反而没备份到）
    if (!fs.readdirSync(SESSIONS_DIR).some(f => f.endsWith('.json'))) return
    const dir = path.join(DATA_ROOT, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const dst = path.join(dir, `sessions.${stamp}`)
    if (fs.existsSync(dst)) return // 当天已备份
    fs.cpSync(SESSIONS_DIR, dst, { recursive: true })
    const all = fs.readdirSync(dir)
      .filter(f => f.startsWith('sessions.') && f !== 'sessions.presplit.json')
      .sort()
    while (all.length > 7) {
      const old = all.shift()!
      try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }) } catch { /* ignore */ }
    }
    console.log(`[backup] sessions/ → backups/sessions.${stamp}/ (keep last 7)`)
  } catch (e) {
    console.error('[backup] failed:', e)
  }
}
backupSessionsOnStartup()

/**
 * 群聊「插嘴」（0912 二十四批）—— 没人 @ 它，它也可能主动搭一句。
 *
 * 触发条件（**全部满足**才插）：
 *   ① 该机器人的「群聊插嘴」开关开着（默认关）；
 *   ② 消息不是机器人自己发的（qqBot 层已过滤其他机器人）、不是空/纯占位；
 *   ③ 内容门槛：interjectScope='question'（默认）时，消息得**像提问**
 *      （问号 / 吗呢吧 / 怎么为什么什么哪里谁求帮…）；'any' 则任何消息都可能接；
 *      **'keyword'（0914 新增：仅插嘴词触发）—— 没命中插嘴词一律不接，全天候只有喊词才出声**；
 *      另外任何 scope 下命中插嘴词都直接越过门槛（question 模式亦然）；
 *   ④ 节流：距上次机器人发言 ≥ 8 分钟，且近 1 小时插嘴次数 < 上限（默认 3）。
 *
 * 插嘴走**正常回复链路**（resolveChannelSession + runPromptCore），用该群会话的模型/人格；
 * 结果通过 QQ 群消息发出（窗口内被动回复，不占主动额度）。
 */
async function maybeInterjectInGroup(botId: string, ev: any, speakerLabel: string): Promise<void> {
  const groupId = String(ev?.target || '')
  if (!groupId) return
  // ① 开关
  const bot = getChannel('qq')?.bots?.find(b => b.id === botId)
  if (!bot?.interject) return
  // ② 内容门槛
  const text = String(ev?.content || '').trim()
  if (!text || /^\[(图片|文件|视频|语音)[^\]]*\]$/.test(text)) return
  const scope = bot.interjectScope === 'any' ? 'any' : bot.interjectScope === 'keyword' ? 'keyword' : 'question'
  /** 0912 反馈：插嘴词 —— 命中即**越过内容门槛**（群里喊它 / 喊关键词时，不算提问也接一句） */
  const kws = Array.isArray(bot.interjectKeywords)
    ? bot.interjectKeywords.map((k: any) => String(k || '').trim()).filter(Boolean)
    : []
  const hitWord = kws.find((k: string) => text.includes(k))
  // 0913 防串台：这条消息在喊「别的机器人」（命中同群其它 bot 的插嘴词/名字）而没喊我 → 不接。
  // 背景：两个 bot 都开 scope=any 时，「牢大说话」会被 Nis 当普通闲聊接走（用户报的串台）。
  const otherWakeWords = ((getChannel('qq') as any)?.bots || [])
    .filter((b: any) => b && b.id !== botId)
    .flatMap((b: any) => [b.nickname, ...(Array.isArray(b.interjectKeywords) ? b.interjectKeywords : [])])
    .map((s: any) => String(s || '').trim())
    .filter(Boolean)
  const otherHit = (otherWakeWords as string[]).find((k: string) => k && text.includes(k))
  /** 0914 修订：只在**对方被直接召唤**时让位（"顺手提到"仍可搭腔——用户拍板过"提到它搭腔挺有意思"）；
   *  消息里有我的名字或命中我的词时一定接（如"牢大说话，nis 也来"）。 */
  const myName = String((bot as any)?.nickname || '').trim()
  const myNameHit = !!myName && text.includes(myName)
  const summonOther = !!otherHit && /(说话|说两?句|出来|在吗|在不在|上线|冒泡|吱声|回(个)?话|来一下|过来|叫|喊)|呢[？?]?$/.test(text)
  if (summonOther && !hitWord && !myNameHit) {
    console.log(`[interject] 群 ${groupId.slice(0, 8)} 跳过：消息在喊别的机器人（命中「${otherHit}」）`)
    return
  }
  // 0914：'keyword'（仅插嘴词触发）—— 没命中插嘴词一律不接（其他 scope 命中词照样直接过，上面的 !hitWord 判断不变）
  if (scope === 'keyword' && !hitWord) return
  if (!hitWord && scope === 'question' && !looksLikeQuestion(text)) return
  // ③ 节流（冷却时间可配：0 = 不设冷却，仍受每小时上限约束）
  const perHour = typeof bot.interjectPerHour === 'number' ? bot.interjectPerHour : 3
  const cooldownSec = typeof bot.interjectCooldownSec === 'number' ? Math.max(0, bot.interjectCooldownSec) : 480
  const gate = canInterject('qq', groupId, cooldownSec * 1000, perHour)
  if (!gate.ok) {
    console.log(`[interject] 群 ${groupId.slice(0, 8)} 跳过：${gate.reason}`)
    return
  }
  // ④ 执行：拿到该群会话 → 跑一轮 → 把结果发回群里
  const peerLabel = (() => {
    try { return labelFor('qq', botId, groupId, 'group') || `QQ 群 · ${groupId.slice(0, 6)}` } catch { return `QQ 群 · ${groupId.slice(0, 6)}` }
  })()
  const sid = resolveChannelSession('qq', botId, groupId, peerLabel, { kind: 'group' })
  if (!sid) return
  /**
   * 插嘴提示词：明确告诉它在"主动搭话"（不是被问），并要求简短 ——
   * 群里主动说话太长会显得很吵。
   * 0912 反馈：原版结尾「如果这句其实没什么好接的，只回一个（跳过）」太容易让模型偷懒跳过
   * （用户实测「不 @ 它问一句它也不出来」）→ 改成"能接就接"，只有完全接不上才跳过；
   * 命中插嘴词时更明确要求必须开口。
   */
  /** 0914 防身份互串：插嘴补一句"身份锚"——只代表自己，不冒充/不代群里其他人发言。
   *  由来：用户实测两个 bot 同群时，A 回了"喊 B 的话"且口吻疑似 B（串台观感）。 */
  const selfNick = String((bot as any)?.nickname || '').trim()
  const identNote = selfNick
    ? `\n（身份提醒：你在本群的昵称是「${selfNick}」，你只代表你自己说话；不要冒充、也不要替群里的其他发言者说话。）`
    : ''
  const hint = (hitWord
    ? `【群聊插嘴·有人点名】群里 ${speakerLabel} 说：「${text}」（提到了「${hitWord}」）\n` +
      `你主动接一句，很简短（一两句话以内），像群里朋友随口搭腔的自然口吻。\n` +
      `这次是有人提到你，务必开口回应，不要回「（跳过）」。`
    : `【群聊插嘴】群里 ${speakerLabel} 刚说：「${text}」\n` +
      `你（这个机器人）主动接一句，很简短（一两句话以内），像群里朋友随口搭腔的自然口吻。\n` +
      `只要能自然接上一句就接（附和、调侃、给个看法都行），只有完全接不上时才回「（跳过）」。`) + identNote
  console.log(`[interject] 群 ${groupId.slice(0, 8)} 生效${hitWord ? `（命中插嘴词「${hitWord}」）` : ''}：${speakerLabel}「${text.slice(0, 30)}」`)
  /* ★0927 P0-1：插嘴随后要读本轮回复发回群里 → 忙时必须等（blocking 语义不变），不能排队后立刻读。
     等不到（超 10 分钟）自动转队列，消息不丢。 */
  /* ★1014c：插嘴也要能看见"群里刚发的图" —— 只接 @ 那条路的话，它自己插嘴时照样是瞎子（产品要求）。
     ⚠️ 模型不支持看图时**不塞图**：塞了 runPromptCore 会直接抛错，整条插嘴就哑火（宁可这次没图）。 */
  const ijImages = await claimGroupMedia('qq', botId, groupId)
  const ijSession = sessions.get(sid)
  const ijGate = ijSession ? channelVisionGate(ijSession) : { blocked: false, model: '' }
  const ijAttachments = ijImages.length && !ijGate.blocked
    ? ijImages.map(i => ({ name: path.basename(i.path), dataUrl: i.dataUrl }))
    : []
  if (ijImages.length && ijGate.blocked) {
    console.log(`[interject] 群 ${groupId.slice(0, 8)}：有 ${ijImages.length} 张图待认领，但模型「${ijGate.model}」不支持看图 → 本次不带图`)
  }
  await runPromptCore(sid, {
    message: hint,
    __busyPolicy: 'wait',
    ...(ijAttachments.length ? { attachments: ijAttachments } : {}),
  })
  // 出站 @ 同群聊口径：剥掉误留的 `<@id>` 字面量（插嘴不走 deliverToChannel，这里单独过一道；不自动补 @）
  const out = toMentionText(extractFinalAssistantText(sid).trim(), undefined)
  if (!out || /^（跳过）$|^\(跳过\)$/.test(out)) {
    console.log(`[interject] 群 ${groupId.slice(0, 8)} AI 判定无需接话，跳过`)
    return
  }
  // 被动回复（用这条消息的 id，窗口内不占主动额度）
  await sendQqMessage(botId, { kind: 'group', target: groupId, messageId: String(ev.messageId || '') }, out)
    .then(() => { markInterject('qq', groupId) })
    .catch(async (e: any) => {
      console.warn(`[interject] 群发失败，尝试主动消息: ${String(e?.message || e).slice(0, 120)}`)
      try {
        await sendQqMessage(botId, { kind: 'group', target: groupId, messageId: '' }, out)
        markInterject('qq', groupId)
      } catch (e2: any) {
        console.warn(`[interject] 群发彻底失败: ${String(e2?.message || e2).slice(0, 120)}`)
      }
    })
}

/** 消息像不像提问（插嘴默认只接这类；纯灌水不接） */
function looksLikeQuestion(text: string): boolean {
  const s = String(text || '').trim()
  if (!s) return false
  if (/[?？]/.test(s)) return true
  if (/(吗|呢|吧)[？?]?$/.test(s)) return true
  return /(怎么|怎样|如何|为什么|为啥|什么|哪个|哪种|哪里|哪儿|谁|求|帮个忙|帮忙|有没有|能不能|可不可以|是不是|对不对|教我|解释一下)/.test(s)
}

// 0910 缓存优化：启动即预热技能缓存——agent 创建路径的 skillsSnapshotSync() 依赖它同步拼 system；
// 冷缓存=首请求没有技能清单、异步补写=前缀断一次。预热后再 listen，首建 agent 必命中热缓存。
getSkills().catch(() => { /* 目录缺失/加载失败=无技能，不拦启动 */ }).finally(() => {
  /* 0920：监听地址从 127.0.0.1 改成 **0.0.0.0** —— 「接入 → 远程访问」要能让手机/另一台电脑
  /* 0920：监听地址从 127.0.0.1 改成 **0.0.0.0** —— 「接入 → 远程访问」要能让手机/另一台电脑
     用 http://<本机局域网IP>:<port>/ 打开本界面（打包版窗口仍走 127.0.0.1，不受影响）。
     ⚠️ 没有这道"总闸"就等于整台机器在内网裸奔，所以 createServer 里同步加了守卫：
     **非本机来源 + 远程访问开关未打开 → 直接 403**（开关在「接入 → 远程访问」，落 channels.json）。 */
  server.listen(PORT, '0.0.0.0', () => {
    /* ★1012d：若上次隧道是开启状态，启动后自动接回来 —— 用户不必每次重启后端都手点一次 */
    void tryRestoreTunnel()
    const cfg = currentLlmConfig()
    console.log(`[pi-bridge] listening on http://127.0.0.1:${PORT}`)
    for (const u of lanUrls(PORT)) console.log(`[pi-bridge] LAN: ${u}`)
    console.log(`[pi-bridge] LLM: ${cfg.model} via ${cfg.providerName} (${cfg.base})`)
    /* ★1014f：PC 会话接管配对码 —— 手机（QQ/微信）私聊发「/pc <码>」即放行（仅私聊可配对，见 channels/pcAccess.ts） */
    try { getPairCode() } catch { /* 取码失败不挡启动 */ }
    console.log(`[pi-bridge] Ready for DSH frontend to connect`)
    /* ★ 0925e（需求要求"打开 NIS 自动获取 zen 的 free 模型"）：启动 8s 后静默同步
     * OpenCode Zen 公共档免费模型（拉列表 + 逐个探活，只放活的进模型表；6h 冷却）。
     * 延迟是让 providers 状态/网络栈先稳；失败静默，不挡任何功能。 */
    setTimeout(() => { void autoSyncZenFreeModels() }, 8000)
  })

  /* ── 0912 接入批：QQ 通道随服务启动 ──
   * 注册消息处理器（收到 QQ 消息 → 桥接到 NIS 会话）并按配置拉起所有已启用的机器人。
   * 配置变更时（channel.bot.* / channel.config.set）会再次 sync 重连。 */
  setQqBotHandlers({
    onMessage: (botId, ev) => {
      /**
       * 二十三批：**被回复的群消息也记一份流水**。
       * 之前只有「旁听」（全量事件里不回复的那批）进流水，@ 它并被回复的消息反而不在 ——
       * 下一轮被问「刚才聊了啥」时看不到「你刚问我什么」。同 messageId 自动去重。
       */
      if (ev.kind === 'group') {
        try {
          const lab = identifyMember('qq', ev.target, ev.senderId || ev.senderName || 'unknown', {
            name: ev.senderName,
            role: ev.senderRole,
          })
          const lineText = ev.content || (ev.images?.length ? '[图片]' : '') || (ev.files?.length ? '[文件]' : '')
          if (lineText) {
            recordGroupLine('qq', ev.target, {
              at: Date.now(),
              speakerId: ev.senderId || '',
              label: lab.label,
              role: lab.role,
              text: lineText,
              messageId: ev.messageId,
            })
          }
        } catch { /* ignore */ }
        // 插嘴冷静期：被 @ 正常回复也算「机器人刚说过话」（刚回完不该马上又插一句）
        try { markBotSpoke('qq', ev.target) } catch { /* ignore */ }
      }
      void handleChannelIncoming('qq', botId, ev.target, ev.content, {
        messageId: ev.messageId,
        kind: ev.kind,
        // 0912 十四批：发送者 + @列表（群聊场景让 AI 知道「谁在说话 / 在 @ 谁」）
        senderId: ev.senderId,
        senderName: ev.senderName,
        senderRole: ev.senderRole,
        mentions: ev.mentions,
        // 0912 二十一批：图片（已下载落盘）→ 附件喂给 agent（AI 能看图）
        images: ev.images,
        imageError: ev.imageError,
        // 0912 二十二批：非图片附件（文件）→ 挪进会话工作区，正文里给出路径（AI 用 fs_read 能读）
        files: ev.files,
      })
    },
    /**
     * 旁听到的群内全量消息（0912 十五批）—— **只记流水、不回复**。
     * 需群主在群设置里把「机器人可获取的群聊消息范围」改成「获取群内全部消息」。
     * 记下来的流水会在有人 @ 它时作为背景注入 → 于是「A 问 B 刚才说了什么」有答案。
     */
    onGroupMessage: (botId, ev) => {
      /* ★1014c：登记"该群最近的图"（只存地址、不下载）—— 紧接着有人 @ 它/它要插嘴时按需取用 */
      rememberGroupMedia('qq', botId, ev.target, ev)
      const label = identifyMember('qq', ev.target, ev.senderId || ev.senderName || 'unknown', {
        name: ev.senderName,
        role: ev.senderRole,
      })
      recordGroupLine('qq', ev.target, {
        at: Date.now(),
        speakerId: ev.senderId || '',
        label: label.label,
        role: label.role,
        text: ev.content,
        messageId: ev.messageId,
      })
      // 0912 二十四批：插嘴开关（默认关）—— 开着且过闸 → 主动搭一句
      void maybeInterjectInGroup(botId, ev, label.label).catch((e: any) => {
        console.warn(`[interject] 群 ${ev.target.slice(0, 8)} 插嘴失败: ${String(e?.message || e).slice(0, 160)}`)
      })
    },
    /**
     * 机器人被拉进群（0912 十六批）：立刻为这个群建好会话 + 打个招呼。
     *
     * 为什么必须建会话：被拉进群**不会**自动产生会话（要等有人 @ 它），
     * 于是 PC 端看不到这个群，用户容易误以为「几个群合并了 / 我加了他但没生效」。
     * 招呼走 `event_id` 事件被动回复，**不消耗**主动消息额度。
     */
    onGroupAdded: (botId, ev) => {
      if (!ev.groupOpenid) return
      // 真实群名（接口需白名单，失败就继续用 群A/群B）
      void syncGroupName('qq', botId, ev.groupOpenid)
      try {
        const sid = resolveChannelSession('qq', botId, ev.groupOpenid, `QQ 群 · ${ev.groupOpenid.slice(0, 6)}`, { kind: 'group' })
        if (sid) console.log(`[channel] 入群事件：已为该群准备会话 ${sid.slice(0, 8)}`)
      } catch (e: any) {
        console.warn(`[channel] 入群建会话失败: ${String(e?.message || e).slice(0, 150)}`)
      }
      const botName = qqBotStatus()[botId]?.nickname || ''
      const greet = `大家好，我是「${botName || '本群机器人'}」。需要我时 @ 我一下就行 —— 我能查资料、回答问题，也能把文件或图片发到群里。`
      void sendQqMessage(botId, { kind: 'group', target: ev.groupOpenid, messageId: '', eventId: ev.eventId }, greet)
        .catch((err: any) => console.warn(`[channel] 入群打招呼失败: ${String(err?.message || err).slice(0, 150)}`))
    },
    onStatus: (botId, st) => {
      console.log(`[channel] QQ bot ${botId} 状态: ${st.connected ? '已上线' : '离线'}${st.error ? ' · ' + st.error : ''}`)
      // 推给前端（通道弹窗展示在线状态）
      broadcastHost({ type: 'host/settings-updated', settings: { __channelStatus: { qq: qqBotStatus() } } } as any)
    },
  })
  syncQqBotsFromConfig().catch((e: any) => {
    console.warn(`[channel] 启动 QQ 机器人失败（不拦启动）: ${String(e?.message || e).slice(0, 200)}`)
  })

  /* ── 微信（官方 ClawBot / iLink）：长轮询收 + sendmessage 发 ── */
  setWechatBotHandlers({
    onMessage: (botId, ev) => {
      void handleChannelIncoming('wechat', botId, ev.target, ev.content, {
        messageId: ev.messageId,
        kind: ev.kind,
        contextToken: ev.contextToken,
        // 0912 二十一批：图片（CDN 解密后落盘）→ 附件喂给 agent（AI 能看图）
        images: ev.images,
        imageError: ev.imageError,
      })
    },
    onStatus: (botId, st) => {
      console.log(`[channel] 微信 bot ${botId} 状态: ${st.connected ? '已连接' : '断开'}${st.error ? ' · ' + st.error : ''}`)
      broadcastHost({ type: 'host/settings-updated', settings: { __channelStatus: { wechat: wechatBotStatus() } } } as any)
    },
  })
  try { syncWechatBotsFromConfig() } catch (e: any) {
    console.warn(`[channel] 启动微信连接失败（不拦启动）: ${String(e?.message || e).slice(0, 200)}`)
  }

  /* ── 定时任务（0912 十二批）+ 通道推送 / 专属会话（十三批）── */
  /**
   * 定时任务 × 模型选择（0912 用户拍板）。
   *   · task.modelMode='global'（默认）→ 跟随「设置 → 人格 → 全局模型」；
   *       **全局模型未选 → 直接报错**（不静默兜底用别的模型）。
   *   · task.modelMode='custom' → 用 task.modelId / modelProviderId 指定的模型；
   *       该模型/供应商已失效 → 也直接报错（绝不悄悄换成全局模型）。
   *
   * 为什么在 runner 里切而不是建会话时切：专属会话是跨次复用的，用户可能中途改了任务模型，
   * 每次执行都按**当前**任务配置重新钉一遍，保证"任务卡片上写的模型 = 实际用的模型"。
   */
  function applyTaskModel(task: any, sessionId: string): void {
    const s = sessions.get(sessionId)
    if (!s) return
    const name = String(task?.name || '定时任务')
    const mode = task?.modelMode === 'custom' ? 'custom' : 'global'
    if (mode === 'global') {
      /* ★1013（已定案："以前可以选用全局模型的，都要换成后台模型"）：定时任务的「全局」档改读
         **后台模型**（不再用聊天全局值）。未配置 / 供应商不可用 ⇒ 直接报错，不做任何兜底。 */
      const cfg = backgroundLlmConfig()
      if (!cfg.configured || !cfg.base || !cfg.model) {
        throw new Error(`定时任务「${name}」执行中止：${cfg.reason || '未配置「后台模型」'}。请到「设置 → 人格 → 后台模型」选一个。`)
      }
      const prov = getState().providers.find(x => x.id === cfg.providerId)
      if (!prov?.base) {
        throw new Error(`定时任务「${name}」执行中止：后台模型「${cfg.model}」的供应商已失效，请重新选择。`)
      }
      s.model = cfg.model
      s.modelProviderId = cfg.providerId
      /* ★1003 安全批 4.78 核实结论：明文 apiKey 只进**内存**的 llmOverride（1001 请求期设计）——
         出口已全封：①buildSessionPayload 白名单不含 llmOverride 值（0929 起只落 llmOverrideBy 标记）；
         ②session.list / session.history 均为显式字段表，不带 llmOverride；③运行时无整对象序列化会话。
         审计说的"schedulePersist 落盘泄密"前提已过时。2.0 内嵌模式应改为"请求期按 providerId 现解"，
         彻底不落明文；在那之前别把 llmOverride 加回任何持久化/响应字段表。 */
      s.llmOverride = {
        providerId: prov.id,
        providerName: prov.name || prov.id,
        base: (prov.base || '').replace(/\/+$/, ''),
        apiKey: plainKeyById(prov.id),          // ★ 1001：取明文（定时任务发请求同样不能带密文）
        model: cfg.model,
        protocol: prov.protocol || 'openai-completions',
        // F轮：全局模型任务同时带上全局推理强度（cfgs.effort 已按模型钳过）
        effort: cfg.effort ?? null,
      }
      s.llmOverrideBy = 'user'
      schedulePersist()
      return
    }
    // custom：必须指定到具体模型，且供应商必须还在
    const mid = String(task?.modelId || '').trim()
    const pid = String(task?.modelProviderId || '').trim() || resolveModelProviderId(mid) || ''
    if (!mid || !pid) {
      throw new Error(`定时任务「${name}」执行中止：任务选了「自选模型」但没指定具体模型，请重新编辑任务。`)
    }
    const prov = getState().providers.find(x => x.id === pid)
    if (!prov?.base) {
      throw new Error(`定时任务「${name}」执行中止：自选模型的供应商「${pid}」已不存在，请重新选择。`)
    }
    const has = (getState().providers.find(x => x.id === pid)?.models || []).some(m => m.id === mid && m.enabled !== false)
    if (!has) {
      // 模型表可能为空（新供应商未拉取）→ 仍允许，交给后端调用时报错，但给出明确日志
      console.warn(`[scheduledTasks] 「${name}」自选模型 ${pid}/${mid} 不在已启用模型表中，按字面使用`)
    }
    s.model = mid
    s.modelProviderId = pid
    s.llmOverride = {
      providerId: prov.id,
      providerName: prov.name || prov.id,
      base: (prov.base || '').replace(/\/+$/, ''),
      apiKey: plainKeyById(prov.id),          // ★ 1001：取明文
      model: mid,
      protocol: prov.protocol || 'openai-completions',
      // F轮：自选模型也可带推理强度（任务级 effort，按该模型钳位；空 = 跟随模型默认）
      effort: clampEffort(pid, mid, task?.modelEffort ?? null),
    }
    s.llmOverrideBy = 'user'
    schedulePersist()
  }

  /* ── 0920：后台任务接线 ──
     ① emitter：任务进度/状态变化 → 广播 host 帧（前端胶囊 tab + 任务视图）
     ② notifier：任务结束 → ① 会话内联提示（用户看得见）② 通知"派它的那轮 AI"：
        agent 正在跑就 steer 进去（注入点=当前轮工具批次跑完），没跑就记 pending、下轮开跑时补。 */
  setBgEmitter((t) => {
    try {
      const payload: any = { type: 'bg/updated', task: JSON.parse(JSON.stringify(t)) }
      const _bgConv = String(t.conversationId || '')
      /* ★ 0922c 修（实测：计划卡正常、后台任务要切对话才出现）：
         原来发 broadcastHost → /api/events.host 的 hostClients，而**前端从未连过该端点**
         （只连 /api/events.mux）⇒ 帧全丢，只能靠切会话时 bg.list 拉取补上。
         改走 mux（与计划卡同一条路）：有归属会话发该会话订阅者，否则发全量桶。 */
      if (_bgConv) broadcastMux(_bgConv, payload)
      else broadcastMux('', payload)
    } catch { /* ignore */ }
  })
  /* ★ 0922e：进程监控 —— 注册表变更 → mux 广播（前端「进程」面板实时增删；
   设计口径：只显示正在运行的，结束就消失）。有归属会话就发该会话订阅者，否则发全量桶。 */
setProcEmitter((p) => {
  try {
    const payload: any = { type: 'proc/updated', proc: JSON.parse(JSON.stringify(p)) }
    const _procConv = String((p.origin && p.origin.conversationId) || '')
    if (_procConv) broadcastMux(_procConv, payload)
    else broadcastMux('', payload)
  } catch { /* ignore */ }
})
setProcRemover((p) => {
  try {
    const payload: any = { type: 'proc/removed', id: p.id, pid: p.pid }
    const _procConv = String((p.origin && p.origin.conversationId) || '')
    if (_procConv) broadcastMux(_procConv, payload)
    else broadcastMux('', payload)
  } catch { /* ignore */ }
})
setBgNotifier((t) => {
    const convId = String(t.conversationId || '')
    if (!convId) return
    const head = t.status === 'completed' ? '后台任务完成' : t.status === 'cancelled' ? '后台任务已取消' : '后台任务失败'
    const body = String(t.result || t.error || '').slice(0, 600)
    const note = `${head}：「${t.title}」\n${body}`
    /* ★ 0923（实测反馈：『内联通知一下一大串』）：**用户可见**的会话提示只给一句话摘要
       —— 任务完整输出在后台任务胶囊/详情弹窗里点开就看得到，别把 600 字结果铺在时间线上。
       给 AI 的 note 仍保持完整（模型需要细节，且前端对注入类消息已默认折叠成一行）。 */
    const brief = String(t.result || t.error || '').replace(/\s+/g, ' ').trim()
    const userLine = `${head}：「${t.title}」` + (brief ? ` · ${brief.slice(0, 60)}${brief.length > 60 ? '…' : ''}` : '')
    const pushUserLine = () => {
      try {
        broadcastMux(convId, { type: 'session/projection', sessionId: convId, key: 'session-notice', seq: Date.now(), value: { text: userLine } } as any)
      } catch { /* ignore */ }
    }
    /* ★0930（需求要求"通知别打断正在干活的 AI"）：**不再 steer 插话** —— 忙时事件挂起，
       本轮结束自动处理（与续跑链同款让路规则：不打断、按序）；空闲才立刻开一轮。
       ★0930b（反馈"同一任务出现两条通知"）：给 AI 的投递消息本身会渲染成一条提示，
       与 userLine 并排就是重复 ⇒ 空闲即时投递时不再另发 userLine；忙时排队才发 userLine
       （事件即时可见，AI 的处理消息本轮结束才出现，两条隔开且内容侧重不同）。 */
    const agent = agents.get(convId)
    const busy = !!agent && !!(agent as any).state?.isStreaming
    if (scheduleBgResume(convId, note, String(t.status))) {
      t.notified = true
      if (busy) pushUserLine()
      sessionLog(convId, 'info', 'lifecycle', `${head}：${t.title}（已交给自动续跑链${busy ? '，挂起等本轮结束' : '，立即处理'}）`)
      return
    }
    pushUserLine()
    const q = pendingBgNotices.get(convId) || []
    q.push(note)
    pendingBgNotices.set(convId, q.slice(-10))
    sessionLog(convId, 'info', 'lifecycle', `${head}：${t.title}（已记为待办提示）`)
  })

  /* ★ 0922：AI 自约定的「后台回访」——到点把任务现状推回给 AI。
     正在跑 → steer 插话（不打断）；空闲 → 按设置自动拉起一轮（bgWatchAutoWake，默认开）；
     设置关掉 → 只记待办，等下次开跑时补送（省 token 的保守档）。 */
  setBgWatcher(async (w) => {
    const convId = w.conversationId
    const list: any[] = w.taskId
      ? [bgGet(w.taskId)].filter(Boolean)
      : bgList(convId).filter((t) => t.status === 'background' || t.status === 'paused')
    const body = list.length
      ? list.map((t: any) => {
        const prog = t.progress?.percent >= 0 ? `${Number(t.progress.percent).toFixed(0)}%` : (t.progress?.note || '')
        const tail = (t.output || []).slice(-4).join('\n')
        return `「${t.title}」${t.status}｜${prog}${tail ? '\n' + tail : ''}`
      }).join('\n---\n')
      : '（没有在跑的后台任务了 —— 可能已结束，用 bg_list 看结果）'
    /* ★ 0922c-7：带上"第几次 + 建议下次多久"，并把"结束会自动通知"讲明白（防 AI 反复自唤醒） */
    const nextHint = w.taskId ? `；若还要盯，建议下次 ${bgSuggestWatchSec(w.taskId)} 秒` : ''
    const text = `【后台任务回访${w.seq ? ` · 第 ${w.seq} 次` : ''}】${w.note ? `你约的回访（备忘：${w.note}）\n` : ''}${body}\n（要看完整输出用 bg_read${nextHint}。任务结束会自动通知你，别反复轮询。）\n（若这次看到**失败**：能自愈就重试一次并说明；需要用户拍板、或同一任务已失败两次 → 停下来用 ask_user 问用户。）`
    /* ★0930（需求要求"回访别百分百打扰，让 LLM 根据情况决定"）：叫醒前先过轻量 LLM 裁决 ——
       任务失败/卡住/报错/要决策才叫醒 AI；一切正常就不打扰（任务结束会自动通知，信息不丢）。
       裁决失败/超时 → 保守放行。 */
    const verdict = await judgeBgWorthWaking(convId, text)
    if (!verdict.need) {
      sessionLog(convId, 'info', 'lifecycle', `后台回访（LLM 裁决跳过，不打扰）：${w.note || '看进度'} —— ${verdict.reason}`)
      return
    }
    sessionLog(convId, 'info', 'lifecycle', `后台回访（LLM 裁决放行）：${verdict.reason}`)
    /* ★0930（需求要求"别打断正在干活的 AI"）：回访不再 steer 插话 —— 优先交续跑链
       （忙时挂起等本轮结束、空闲立即处理）；链关了/到限时忙则记待办、空闲才唤醒。 */
    if (scheduleBgResume(convId, text, 'watch')) return
    const agent = agents.get(convId)
    const streaming = !!agent && !!(agent as any).state?.isStreaming
    if (streaming) {
      const q = pendingBgNotices.get(convId) || []
      q.push(text)
      pendingBgNotices.set(convId, q.slice(-10))
      sessionLog(convId, 'info', 'lifecycle', `后台回访（AI 正忙，挂起记待办不打断）：${w.note || '看进度'}`)
      return
    }
    if (globalSettings.bgWatchAutoWake === false) {
      const q = pendingBgNotices.get(convId) || []
      q.push(text)
      pendingBgNotices.set(convId, q.slice(-10))
      sessionLog(convId, 'info', 'lifecycle', `后台回访（设置关了自动唤醒 → 记为待办）：${w.note || '看进度'}`)
      return
    }
    /* 空闲 → 主动把 AI 叫起来跑一轮（走与手打消息同一条路，输出自然落进会话） */
    sessionLog(convId, 'info', 'lifecycle', `后台回访（自动唤醒 AI 跑一轮）：${w.note || '看进度'}`)
    void runPromptCore(convId, { message: text }).catch((e: any) => {
      console.warn('[bg] 回访自动唤醒失败:', e)
      const q = pendingBgNotices.get(convId) || []
      q.push(text)
      pendingBgNotices.set(convId, q.slice(-10))
      sessionLog(convId, 'warn', 'lifecycle', `回访自动唤醒失败（转待办）：${String(e?.message || e).slice(0, 120)}`)
    })
  })

  setTaskRunner(async (task: any, sessionId: string) => {
    // 模型口径（0912）：按任务配置钉死；配置有问题就抛错，任务会被标 error 并把原因写进会话
    applyTaskModel(task, sessionId)
    // 与手打消息同一条路径 —— 结果自然落进会话，打开对话就能看到
    const prefix = `[定时任务「${task.name}」· ${describeSchedule(task.schedule)}] `
    /* ★0927 P0-1：定时任务**要本轮结果**才敢往下走（后面还要推通知）→ 忙时等空闲再发（blocking 语义不变）；
       等不到（超 10 分钟）自动转队列，消息不丢。 */
    await runPromptCore(sessionId, { message: prefix + task.prompt, __busyPolicy: 'wait' })
    /**
     * 执行完 → 按配置推结果到微信 / QQ 机器人。
     * 推送失败只记日志（在 notifyTaskResult 内部 catch），**不影响任务状态** ——
     * 否则 IM 掉线会把任务标成 error，用户以为任务本身跑挂了。
     */
    const targets = normalizeNotifyTargets(task.notifyTargets)
    if (targets.length) await notifyTaskResult(task, sessionId, targets)
    return { sessionId }
  })
  setTaskSessionResolver((task: any) => {
    const mode = String(task.targetSessionId || '').trim()
    const targets = normalizeNotifyTargets(task.notifyTargets)
    // ① 用户显式指定了某条会话，且它还在 → 就用它
    if (mode && mode !== 'own' && mode !== 'new' && sessions.has(mode)) return mode
    /**
     * ② 默认：任务专属会话。
     * 有通知目标时，**执行落点 = 首个目标的专属会话**；其余目标各自另有一条
     * （推送时建，见 notifyTaskResult）→ 各通道历史互不可见（0912 十七批）。
     */
    if (mode !== 'new') {
      const sid = ensureTaskOwnSession(task, targets[0])
      try { setExecSession(String(task?.id || ''), sid) } catch { /* ignore */ }
      return sid
    }
    // ③ 每次新建（用户显式选了这个模式）
    const s = createSession(`定时任务 · ${task.name}`)
    console.log(`[scheduledTasks] 为「${task.name}」新建会话 ${s.id.slice(0, 8)}`)
    return s.id
  })
  try { startScheduler() } catch (e: any) {
    console.warn(`[scheduledTasks] 启动失败（不拦启动）: ${String(e?.message || e).slice(0, 150)}`)
  }

  /**
   * 启动后把已知群的真实群名同步一遍（0912 十八批）。
   * 延后 25s：等各通道机器人连上（拿不到 token 就调不了接口）。
   * 拿到真群名 → 「群A」自动变成群名；拿不到（无白名单权限）就维持 群A/群B，不影响功能。
   */
  setTimeout(() => {
    try {
      const seen = new Set<string>()
      for (const [_k, v] of Object.entries(listLinks())) {
        if (v?.channel !== 'qq' || !v.peerId || (v.kind || '') !== 'group') continue
        const key = `${v.botId}:${v.peerId}`
        if (seen.has(key)) continue
        seen.add(key)
        void syncGroupName('qq', v.botId, v.peerId)
      }
      if (seen.size) console.log(`[channel] 启动群名同步：${seen.size} 个群`)
    } catch { /* ignore */ }
  }, 25_000)
})

// A1.3 进程信号处理：退出前尽量把会话落盘（防"退出即丢最后 500ms"）。
// 只 graceful 持久化后退出；unhandledRejection 记日志不退出（与"局部 catch 不中断服务"哲学一致）
let exiting = false
function gracefulExit(sig: string): void {
  if (exiting) return
  exiting = true
  console.log(`[pi-bridge] ${sig} received, flushing sessions…`)
  try { stopAllQqBots() } catch { /* 关闭通道不阻塞退出 */ }
  // 微信：发下线通知（手机端立刻显示离线）+ 停轮询
  try { stopAllWechatBots({ notify: true }) } catch { /* ignore */ }
  try { persistSessionsSync() } catch { /* ignore */ }
  /* ★0927 R16：退出时把持外部资源的服务一并收干净——原来只停 bot+落盘，
     MCP 子进程 / Chromium 实例 / 记忆桥会变孤儿（孤儿进程占端口、锁 sqlite、吃内存）。
     顺序：先断外部连接（bot 已停）→ 关浏览器 → 断 MCP → 停记忆桥 → 退出。 */
  /* ★1003 修复 4.79：收尾都是异步 fire-and-forget，原来固定 700ms 就 process.exit(0)——
     大概率把它们拦腰砍断，孤儿 MCP/Chromium 照样留下（R16 白干）。现在收集收尾 Promise，
     全部落地（或 5s 硬上限兜底，防个别 close 永挂卡住退出）再退出。 */
  const closers: Array<Promise<unknown>> = []
  try {
    const insts = browserEngine.allInstances()
    for (const inst of insts) closers.push(Promise.resolve(inst.close()).catch(() => { /* ignore */ }))
    console.log(`[pi-bridge] 退出清理：关闭 ${insts.length} 个浏览器实例`)
  } catch { /* ignore */ }
  try {
    for (const srv of getMcpStatus()) {
      if (srv?.name) closers.push(mcpHubDisconnect(String(srv.name), true).catch(() => { /* ignore */ }))   // keepConfig：关机不改配置
    }
  } catch { /* ignore */ }
  try { memoryBridge.stop() } catch { /* ignore */ }
  // 等收尾真正落地再退出；5s 硬上限兜底（绝不无限等）。落地后再留一点时间给下线通知
  const exitTimer = setTimeout(() => process.exit(0), 5000)
  void Promise.allSettled(closers).then(() => {
    clearTimeout(exitTimer)
    setTimeout(() => process.exit(0), 500)
  })
}
/* ★ 0924 诊断：抓「无痕猝死」。
 *   现象：后端起来 30 秒~几分钟后消失，日志戛然而止、.err 全空，
 *   而 gracefulExit / EADDRINUSE / orphan-guard **一条都没打**。
 *   被强杀（TerminateProcess）时这些钩子都不会触发；若是**事件循环空了**
 *   （所有 handle 都被 unref、或 server 被关掉），才会走 beforeExit —— 这两种是完全不同的病。
 *   定位到根因后可删。 */
process.on('beforeExit', (code) => {
  console.log(`[exit-trace] beforeExit code=${code} —— 事件循环已空（不是被强杀，是没有 handle 撑着进程了）`)
  try {
    console.log('[exit-trace] activeHandles=' + (process as any)._getActiveHandles?.().length
      + ' activeRequests=' + (process as any)._getActiveRequests?.().length)
  } catch { /* ignore */ }
})
process.on('exit', (code) => {
  console.log(`[exit-trace] exit code=${code} —— 进程正在退出（正常路径）`)
})
process.on('SIGINT', () => gracefulExit('SIGINT'))
process.on('SIGTERM', () => gracefulExit('SIGTERM'))
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', reason) })
process.on('uncaughtException', (err: any) => {
  console.error('[uncaughtException]', err)
  // 0913：端口被占必须退出——此前被吞掉后进程继续活着变僵尸：
  // 多个僵尸后端会重复连 QQ 网关（重复回复风险）、抢记忆库 DB（桥 exited code=1）、让"重启看起来没用"极难排查
  if (err?.code === 'EADDRINUSE') {
    console.error('[pi-bridge] 端口被占用（旧实例未清理？）→ 本进程退出')
    process.exit(1)
  }
})

// 启动记忆/知识库 Python 桥（后台，不阻塞；失败不影响主服务）
/** 记忆/知识库目录：**一律住在本应用自己的目录里**（用户 0919 口径）。
 *  打包版由壳注入 `NIS_MEMORY_DIR=%APPDATA%\nis\memory`；dev/命令行没壳注入 → `<数据根>/memory`。
 *  ⚠️ 以前这里写的是 `storagePath || defaultStorageRoot()`（= 设置→通用→存储目录）—— 于是：
 *     · 导入数据包时，包内 settings.json 把 storagePath 指到包里的 `niscs` → 应用直接读那个包的历史记忆
 *       （用户看到的"新装怎么还有历史记忆"就是这个）；
 *     · 换存储目录 → 记忆库跟着漂移。存储目录是给**对话工作区**用的、用户可换的位置，不该管记忆库。 */
const _injectedMemoryDir = String(process.env.NIS_MEMORY_DIR || '').trim()
process.env.NIS_MEMORY_DIR = _injectedMemoryDir || defaultMemoryDir()
/* 一次性搬家（只为**不丢老用户已有的记忆**）：目标目录还是空的、而"旧位置"（存储目录）里有库 → 拷过来。
 *   · 只拷不删，且只在目标为空时做 → 新装（旧位置也没库）什么都不做，记忆就是空的；
 *   · **只在"没壳注入"的场景做**（dev/命令行）。打包版按新口径"干净起步"：要历史就用「导入数据」，
 *     否则老安装那套（storagePath 被导入包指到 niscs）会把 1.63MB 历史又搬进新目录 —— 那正是要修的毛病。 */
function migrateLegacyMemoryDb(target: string): void {
  try {
    const has = (d: string, f: string) => !!d && fs.existsSync(path.join(d, f))
    if (has(target, 'memory_system.db') || has(target, 'knowledge.db')) return
    const legacy: string[] = [storageRootNow()]
    const docs = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents', 'NisData') : ''
    if (docs) legacy.push(docs)
    for (const src of legacy) {
      if (!src || path.resolve(src) === path.resolve(target)) continue
      const hits = ['memory_system.db', 'knowledge.db'].filter((f) => has(src, f))
      if (!hits.length) continue
      fs.mkdirSync(target, { recursive: true })
      for (const f of hits) fs.copyFileSync(path.join(src, f), path.join(target, f))
      console.log(`[memory-dir] 旧位置的记忆/知识库已搬入本应用目录：${src} → ${target}（只拷不删）`)
      return
    }
  } catch (e: any) {
    console.warn('[memory-dir] 旧库搬家跳过：', e?.message || e)
  }
}
  // 0924（库锁死安装目录）：禁用 storagePath 老库播种 —— 它会把「存储目录」下的废弃老库当种子灌进新家，
  // 0924 搬家时被它抢跑污染过一次；真库由 memoryBridge.seedFromLegacyMemoryDir 从 <DATA_ROOT>/memory 搬。
  // if (!_injectedMemoryDir) migrateLegacyMemoryDb(process.env.NIS_MEMORY_DIR)
// 0917：把「环境安装目录」透给记忆桥 —— 它会优先用这里的 memory-venv（设置→软件环境→记忆检索模型 装的）
process.env.NIS_ENV_DIR = envInstallDir()
/* ★ 0924：把自己标进环境变量 —— 让「由本后端拉起的子进程」能认出「我的宿主后端就是 8766 上的那一个」。
 *   AI 的 run_command / project_run_command 都是 execFile 且**不指定 env**（默认继承），
 *   所以从后端树里跑出来的脚本一定能读到它。用途见 _stop_backend.mjs / _restart_backend.mjs
 *   的「拒绝自杀」守卫：否则 AI 跑 `node _restart_backend.mjs` 会杀掉**正在承载这条命令的后端自身**
 *   —— 工具调用永远不返回、会话直接中断，而且不留任何退出痕迹（不是崩、不是优雅退出、不是端口占用），
 *   用户看到的就是「后端起来一会儿又断 + AI 突然不回话」。 */
process.env.NIS_BACKEND_PID = String(process.pid)
/* 打一行出来 —— 排查「后端为什么自己断了」时，先看这条就能确认「拒绝自杀」守卫是否已武装。 */
console.log(`[self-guard] NIS_BACKEND_PID=${process.pid} —— AI 若用 run_command 跑到 _stop/_restart_backend.mjs，会被它拒绝（防止把宿主后端杀掉）`)
memoryBridge.start()

/* ── 孤儿守卫（0919）────────────────────────────────────────────
 * 桌面壳把自己的 pid 通过 NIS_PARENT_PID 传进来。壳被**强杀**时（卸载器 `taskkill /F`、
 * 任务管理器结束进程、蓝屏前强退），本进程会变成孤儿并继续锁着 `pack\node.exe` / `pack\backend\`
 * → 卸载删不掉，最后剩一个残缺的 `pack\`（实测）。
 * 所以：父进程一旦不在，自己安静退出。只在壳拉起的场景生效（dev 手跑时没有这个变量，不受影响）。 */
const parentPid = Number(process.env.NIS_PARENT_PID || 0)
if (Number.isInteger(parentPid) && parentPid > 0) {
  const guard = setInterval(() => {
    try {
      process.kill(parentPid, 0) // 信号 0 = 只探测存在性，不发信号
    } catch {
      console.log(`[orphan-guard] 桌面壳（pid=${parentPid}）已退出 → 后端自行结束，放掉 pack 的句柄`)
      clearInterval(guard)
      process.exit(0)
    }
  }, 2000)
}
// 0913：冷启动（嵌入模型加载 + 磁盘缓存冷）实测可达 1-2 分钟 → 等待窗口 30s→90s，文案同步
void memoryBridge.waitReady(90000).then((ok) => {
  if (ok) {
    console.log('[memory-bridge] ready (memory_system.db + knowledge.db)')
  } else {
    // 0917：不再只留一句 "not ready" —— 说清楚为什么、怎么修，省得用户只能看到「导出失败」
    console.warn('[memory-bridge] not ready — 记忆/知识库功能不可用。'
      + '原因通常是本机没有可用的 Python；请到 设置→软件环境 安装「Python」与「记忆检索模型」后重启应用。')
  }
})

// ── 记忆维护定时器：启动后 5 分钟首跑，之后每 24h 一次 ──
// 清理软删/过期/旧事件 + Cold 层归档（遗忘机制）
async function runMemoryMaintenance(): Promise<void> {
  try {
    const r = await memoryBridge.call('memory_maintenance', {})
    console.log('[memory-maintenance]', JSON.stringify(r))
  } catch (e: any) {
    console.error('[memory-maintenance] failed:', e?.message || e)
  }
}
setTimeout(() => void runMemoryMaintenance(), 5 * 60 * 1000)
setInterval(() => void runMemoryMaintenance(), 24 * 60 * 60 * 1000)

// ── 文件历史 GC 定时器（0910 磁盘治理）：启动 2 分钟后首跑，之后每 24h（内部限流每小时最多一次）。
//    引用安全回收孤儿对象 + 超 500MB 预算时按最旧 tree 快照整链淘汰（tree 快照只写不读，零功能损失）。
//    workDirs=活跃会话工作区 + NIS 仓库根（cordis 会话可能拿仓库当工作区，在 NisData 之外）；
//    滞留处/孤儿工作区由 fileHistory 侧的 NisData 两层兜底扫描覆盖。──
/** 历史相关操作的工作区集合：活跃会话 + NIS 仓库根（cordis 会话可能拿仓库当工作区，在 NisData 之外） */
function historyWorkDirs(): string[] {
  const dirs = Array.from(sessions.values()).map(s => s.workDir?.trim()).filter(Boolean) as string[]
  dirs.push('E:/nis0812')
  return dirs
}
function runFileHistoryGc(): void {
  try {
    const r = enforceBudget(historyWorkDirs())
    if (r.deletedOrphans || r.freedBytes) console.log(`[file-history-gc] 孤儿 ${r.deletedOrphans} 个，回收 ${(r.freedBytes / 1048576).toFixed(0)}MB`)
  } catch (e: any) {
    console.error('[file-history-gc] failed:', e?.message || e)
  }
}
setTimeout(() => void runFileHistoryGc(), 2 * 60 * 1000)
setInterval(() => void runFileHistoryGc(), 24 * 60 * 60 * 1000)

// ── 文件历史自动清理定时器（0911 反馈）：启动 3 分钟后首跑，之后每 10 分钟巡检一次。
//    开关/阈值/比例来自设置页（historyAutoCleanEnabled / ThresholdMb / Pct；默认开 500MB/20%）。
//    未超阈值时只是一次轻量目录统计，不做任何删除；超阈值则裁掉最旧 pct% 记录并物理回收对象。──
function runHistoryAutoClean(): void {
  try {
    const gs = globalSettings as any
    if (gs.historyAutoCleanEnabled === false) return
    const tMb = Number(gs.historyAutoCleanThresholdMb)
    if (!Number.isFinite(tMb) || tMb <= 0) return
    const pct = Number(gs.historyAutoCleanPct)
    const r = autoCleanHistory(historyWorkDirs(), Math.floor(tMb * 1048576), Number.isFinite(pct) && pct > 0 ? pct : 20)
    if (r.triggered) console.log(`[file-history-autoclean] 清理最旧 ${r.removedChanges} 条记录（${r.removedWorkspaces} 个工作区），释放 ${(r.freedBytes / 1048576).toFixed(1)}MB，当前占用 ${(r.totalBytes / 1048576).toFixed(0)}MB`)
  } catch (e: any) {
    console.error('[file-history-autoclean] failed:', e?.message || e)
  }
}
setTimeout(() => void runHistoryAutoClean(), 3 * 60 * 1000)
setInterval(() => void runHistoryAutoClean(), 10 * 60 * 1000)
