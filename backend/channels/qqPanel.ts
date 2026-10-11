/**
 * QQ 指令面板同步 —— 把 NIS 机器人已有的命令注册到 QQ 开放平台，
 * 让用户在 QQ 里「看得见、点得到」，不用背命令。
 *
 * 官方接口（bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/）：
 *   POST /v2/panels               创建指令面板  → { panel_id }
 *   GET  /v2/panels?scope=c2c     查询已有面板
 *   PUT  /v2/panels/{panel_id}    修改面板
 *   PUT  /v2/panels/{panel_id}/target  改关联对象
 *   限制：10 QPM；最多 20 个面板；每个面板最多 20 个元素
 *   错误码：40030009 并发冲突 / 40030011 scope 非法 / 40030013 超数量 /
 *           40030015 元素类型非法（仅 command/link）/ 40030020 内容安全风险
 *
 * ★★ 边界声明（务必保持）★★
 *   本模块**只做"请求-响应"**：给腾讯发 HTTP、把结果回给调用方。
 *   · **不发帧、不广播、不注册事件监听、不碰任何会话/窗口路由** ——
 *     所以它不产生任何"串台"的可能（串台的载体是广播帧，这里根本没有）。
 *   · **只用异步 fetch，零同步阻塞调用** —— server.ts 是单进程单事件循环，
 *     同步阻塞会卡住整个后端（所有对话一起变慢）。
 *   · **不改任何现有文件的行为**；它是被 RPC 显式调用的叶子模块。
 */

/** QQ 开放平台接口基址（与 qqBot.ts 的 API_BASE 一致；这里独立定义，避免互相 import） */
const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 面板元素：官方限制 name ≤ 14 字、desc ≤ 30 字、type 仅 command | link */
interface QqPanelItem {
  name: string
  desc: string
  type: 'command' | 'link'
  only_admin?: boolean
  link?: string
}

/**
 * 要注册到 QQ 的指令列表。
 *
 * ⚠️ 维护须知：这里的每一项必须与 `backend/channels/qqBot.ts` 里命令解析层
 *    实际支持的命令**对应**（/new /list /switch /pc /home /status /stop /help）。
 *    之所以在本文件独立写一份展示文案，而不是从 qqBot.ts 导出：
 *    为了做到"一行都不碰现有文件"（不破坏基底）。
 *    ⇒ **以后命令有增减，两边各改一处**（qqBot.ts 的解析层 + 这里的展示项）。
 */
export const QQ_PANEL_ITEMS: QqPanelItem[] = [
  { name: '新会话', desc: '开一个新对话，从头开始', type: 'command' },
  { name: '会话列表', desc: '看看你有哪些会话', type: 'command' },
  { name: '切换会话', desc: '换到指定编号的会话继续聊', type: 'command' },
  /* ★1014f：PC 会话接管（点一下列出电脑上的会话；具体切哪条要在聊天里发 /pc <编号>） */
  { name: '接管电脑', desc: '看电脑上的会话，可按序号或关键词接管', type: 'command' },
  { name: '回到本对话', desc: '从电脑会话退回本对话（/home）', type: 'command' },
  { name: '当前状态', desc: '看正在跑什么、用了多少', type: 'command' },
  { name: '停止', desc: '中断当前正在进行的回复', type: 'command' },
  { name: '帮助', desc: '看看都会些什么', type: 'command' },
]

interface QqPanelEntry {
  panel_id?: string
  scope?: string
  target_type?: string
  panel?: { items?: QqPanelItem[]; remark?: string; version?: number }
}

/** 取 Access Token（官方 oauth：AppID + AppSecret → access_token） */
export async function fetchQqAccessToken(appId: string, secret: string): Promise<string> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error(`取 access_token 失败 HTTP ${r.status}：${raw.slice(0, 300)}`)
  let j: any
  try { j = JSON.parse(raw) } catch { throw new Error(`取 access_token 返回非 JSON：${raw.slice(0, 300)}`) }
  if (!j?.access_token) throw new Error(`取 access_token 未拿到值：${raw.slice(0, 300)}`)
  return String(j.access_token)
}

/** 统一的 API 调用：把平台返回的原始错误**如实抛出**（不兜底、不吞掉真因） */
async function qqApi(method: string, path: string, token: string, body?: unknown): Promise<any> {
  const r = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await r.text()
  let j: any = null
  try { j = raw ? JSON.parse(raw) : null } catch { /* 非 JSON 时保留原文 */ }
  if (!r.ok) {
    const detail = j ? `${j.code ?? ''} ${j.message ?? ''}`.trim() : raw.slice(0, 300)
    throw new Error(`QQ ${method} ${path} 失败 HTTP ${r.status}：${detail || '(无响应体)'}`)
  }
  return j
}

/** 查询已存在的指令面板（按 scope；channel/dm 场景 target_type 只能 all） */
export async function listQqPanels(token: string, scope: string): Promise<QqPanelEntry[]> {
  const j = await qqApi('GET', `/v2/panels?scope=${encodeURIComponent(scope)}`, token)
  /* 官方返回可能是数组或 { data: [] } / { records: [] }，这里如实兼容三种，
     都不匹配就抛（不静默返回空数组，避免"看起来同步成功其实什么都没拿到"） */
  if (Array.isArray(j)) return j
  if (Array.isArray(j?.data)) return j.data
  if (Array.isArray(j?.records)) return j.records
  /* ★1013b【实测修正】：官方在"当前没有任何面板"时，只返回 {"is_end":true} ——
     空列表字段被整个省略。这是**正常的空**，不是结构异常（实测第一次同步就撞上）。
     真结构异常（既没有列表字段、也没有 is_end 标记）仍然抛，不兜底。 */
  if (j && typeof j === 'object' && 'is_end' in j) return []
  throw new Error(`查询面板返回结构不认识：${JSON.stringify(j).slice(0, 300)}`)
}

/**
 * 同步指令面板：
 *   查已有 → 有就 PUT 更新、没有就 POST 创建。
 * 返回 step（created / updated）与 platform 原样返回，便于界面如实展示。
 */
export async function syncQqPanel(
  appId: string,
  secret: string,
  opts: { scope?: string; items?: QqPanelItem[]; remark?: string } = {},
): Promise<{ step: 'created' | 'updated'; scope: string; panelId?: string; platform: any }> {
  const scope = String(opts.scope || 'c2c')
  const items = opts.items?.length ? opts.items : QQ_PANEL_ITEMS
  if (items.length > 20) throw new Error(`面板元素 ${items.length} 个，超过官方上限 20`)
  for (const it of items) {
    if (!it.name || it.name.length > 14) throw new Error(`指令名「${it.name}」为空或超过 14 字（官方限制）`)
    if (!it.desc || it.desc.length > 30) throw new Error(`指令说明「${it.desc}」为空或超过 30 字（官方限制）`)
  }

  const token = await fetchQqAccessToken(appId, secret)
  const panel = { items, remark: opts.remark || 'NIS 指令面板', version: 1 }

  const existing = await listQqPanels(token, scope)
  const hit = existing.find((p) => String(p?.scope || scope) === scope && p?.panel_id)
  if (hit?.panel_id) {
    const platform = await qqApi('PUT', `/v2/panels/${encodeURIComponent(String(hit.panel_id))}`, token, {
      panel, target_type: 'all',
    })
    return { step: 'updated', scope, panelId: String(hit.panel_id), platform }
  }

  const platform = await qqApi('POST', '/v2/panels', token, {
    scope, target_type: 'all', panel,
  })
  return { step: 'created', scope, panelId: platform?.panel_id ? String(platform.panel_id) : undefined, platform }
}
