/**
 * QQ 单聊「自定义菜单」（★1019）
 *
 * 官方口径（`bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html`）：
 *   · `PUT /v2/menu`（**5 QPM**）；**仅 C2C 单聊**场景，设置后**对所有用户生效**（不支持按用户区分）
 *   · body = `{ menu: { items: [MenuItem] } }`，`items` **最多 10 个**，按顺序从左到右
 *   · `MenuItem.type` ∈ `switch`(开关) / `send_message`(发送消息) / `link`(跳转) / `menu`(折叠子菜单)
 *   · `name` **≤10 字符**（⚠️ 一个汉字算 **2** 个字符 ⇒ 最多 5 个汉字）
 *   · `sub_menu_items` 仅 `type=menu` 有效、**最多 5 个**、只支持 `send_message` / `link`（不能再嵌套）
 *   · ⚠️ **`send_message` 的语义是「点击后文本自动填入聊天输入框」** —— 用户还得自己按发送！
 *     与消息按钮（回调式、点了就执行）不同 ⇒ 菜单定位 = **常驻快捷入口**，一键执行交给消息按钮。
 *
 * 复用：`fetchQqAccessToken` 直接 import 自 `qqPanel.ts`（同一套 AppID/Secret 换 token 的逻辑，不重写）。
 */
import { fetchQqAccessToken } from './qqPanel.ts'

const API_BASE = 'https://api.sgroup.qq.com'

interface QqSubMenuItem {
  name: string
  type: 'send_message' | 'link'
  send_message?: string
  link?: string
}

interface QqMenuItem {
  name: string
  type: 'switch' | 'send_message' | 'link' | 'menu'
  send_message?: string
  link?: string
  sub_menu_items?: QqSubMenuItem[]
  switch?: { switch_id: string; default: boolean }
}

/**
 * 我们的菜单：一级 4 项 + 「更多」折叠里 4 项。
 * 名字都控制在 5 个汉字内（官方汉字按 2 字符计 ⇒ ≤10）。
 * ⚠️ 维护须知：`send_message` 里写的命令必须与命令解析层支持的一致（`/new /list /pc /status /perm /通知 /help`）。
 */
function buildMenuItems(): QqMenuItem[] {
  return [
    { name: '新会话', type: 'send_message', send_message: '/new' },
    { name: '会话列表', type: 'send_message', send_message: '/list' },
    { name: '接管电脑', type: 'send_message', send_message: '/pc' },
    {
      name: '更多', type: 'menu',
      sub_menu_items: [
        { name: '当前状态', type: 'send_message', send_message: '/status' },
        { name: '权限档位', type: 'send_message', send_message: '/perm' },
        { name: '通知', type: 'send_message', send_message: '/通知' },
        { name: '帮助', type: 'send_message', send_message: '/help' },
      ],
    },
  ]
}

/** 组装成官方要的 body（PUT 是**整份覆盖**：传什么就是什么） */
function buildMenuBody(): { menu: { items: QqMenuItem[] } } {
  return { menu: { items: buildMenuItems() } }
}

/** 统一的 API 调用：平台报错**如实抛**（不吞真因）—— 与 qqPanel.ts 同款 */
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

/** 查当前的全局菜单（用于"同步前后对比"，也方便判断到底改没改） */
export async function fetchQqMenu(appId: string, secret: string): Promise<any> {
  const token = await fetchQqAccessToken(appId, secret)
  return await qqApi('GET', '/v2/menu', token)
}

/**
 * 把我们的菜单同步到 QQ（整份覆盖）。
 * 返回 `{ version }`（平台给的菜单版本号，可用来判断配置是否真的变了）。
 */
export async function syncQqMenu(appId: string, secret: string): Promise<{ version?: number; raw: any }> {
  const token = await fetchQqAccessToken(appId, secret)
  const raw = await qqApi('PUT', '/v2/menu', token, buildMenuBody())
  return { version: Number(raw?.version) || undefined, raw }
}

/* ── 自检：菜单是纯数据，规则能全部在这里验完（不用真调接口）── */
export function selfCheck(): { pass: number; fail: number; detail: string[] } {
  const out: string[] = []
  let pass = 0, fail = 0
  const ok = (c: boolean, m: string) => { if (c) { pass++; out.push('  ✓ ' + m) } else { fail++; out.push('  ✗ ' + m) } }
  /** 官方口径：name ≤10 字符，**一个汉字算 2 个字符** */
  const weight = (s: string) => [...String(s || '')].reduce((n, ch) => n + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0)

  const items = buildMenuItems()
  ok(items.length <= 10, `一级菜单 ${items.length} 项（官方 ≤10）`)
  ok(items.every(i => weight(i.name) <= 10), '每个一级项名字 ≤10 字符（汉字按 2 计）')
  ok(items.every(i => ['switch', 'send_message', 'link', 'menu'].includes(i.type)), 'type 都在官方允许值内')
  const sm = items.filter(i => i.type === 'send_message')
  ok(sm.length > 0 && sm.every(i => String(i.send_message || '').startsWith('/')), 'send_message 都是我们的斜杠命令')
  ok(items.every(i => i.type !== 'link' || String(i.link || '').startsWith('https://')), '若用 link 类型必须 https://')
  const subs = items.filter(i => i.type === 'menu').flatMap(i => i.sub_menu_items || [])
  ok(subs.length > 0 && subs.length <= 5, `子菜单 ${subs.length} 项（官方 ≤5）`)
  ok(subs.every(s => weight(s.name) <= 14), '子菜单名字 ≤14 字符')
  ok(subs.every(s => s.type === 'send_message' || s.type === 'link'), '子菜单不用 menu 类型（官方禁止再嵌套）')
  ok(JSON.stringify(buildMenuBody()).includes('"/new"'), 'body 结构正确（menu.items[].send_message）')
  ok(items.some(i => i.type === 'menu'), '保留了「更多」折叠项（一级不堆太多）')

  return { pass, fail, detail: out }
}

// 允许直接跑：node --experimental-strip-types qqMenu.ts
if (process.argv[1] && /qqMenu\.ts$/.test(process.argv[1])) {
  const r = selfCheck()
  console.log(r.detail.join('\n'))
  console.log(`\n=== ${r.pass} 项通过 / ${r.fail} 项失败 ===`)
  process.exit(r.fail ? 1 : 0)
}
