/**
 * QQ 消息按钮（keyboard）—— 一期：命令按钮 + 状态感知
 *
 * 官方口径（bot.q.qq.com/wiki/develop/api-v2/ → 消息交互 → 消息交互概述，2026-07 版）：
 *   · **发**：消息体上加 `keyboard` 字段（模板按钮 / 自定义按钮两种模式）
 *   · **点**：平台推 `INTERACTION_CREATE` 事件 → 机器人必须**3 秒内**调
 *            `PUT /interactions/{interaction_id}` 响应（超时用户侧就没反馈）
 *   · 按钮三层：`render_data`（长什么样）/ `action`（点了干什么）/ `permission`（谁能点）
 *
 * 本文件只做**纯数据构建**（好自检、不碰网络）：按钮 → 命令文本的映射在 `action.data` 里，
 * 点击后由 qqBot 的 INTERACTION_CREATE 分支取出 `data` 当**一条普通命令**处理 ——
 * 复用现有 channelCommands 链路，不另建一套（ponytail：别造平行机制）。
 */

interface QqButton {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  /**
   * ★1016c 按官方 schema 校准（`v2_users_user_openid_messages.post.html#schema-keyboard`）：
   *   · `type`：0=跳转 / **1=回调（data 传后台 → 平台推 INTERACTION_CREATE）** / 2=指令（只在输入框插 `@bot data`）
   *     ⇒ 我们要"点了就执行"，用 **1**（2 只是把命令填进输入框，用户还得自己回车）。
   *   · `permission`：0=指定用户 / 1=管理员 / 2=所有人；**`specify_role_ids` 仅频道可用** ⇒ 单聊不传。
   *   · `click_limit` 已废弃；`at_bot_show_channel_list` 在单聊 schema 里**根本没有**；`reply`/`enter` 只对 type=2 有效
   *     ⇒ 一律不传（传了官方就 400）。
   */
  action: {
    type: number
    permission: { type: number; specify_user_ids: string[] }
    /** ★ 点击后平台回传的 data —— 我们这里直接放命令文本，如 '/new' */
    data: string
  }
}

interface QqKeyboard {
  /** 平台预设模板 id（与 content **互斥**，我们走自定义布局 ⇒ 不传它） */
  id?: string
  content: { rows: Array<{ buttons: QqButton[] }> }
}

/** 当前会话状态（决定给哪一排按钮） */
export interface ButtonScene {
  /** 正在跑回复？ */
  running?: boolean
  /** 正接管着 PC 会话？ */
  takingOver?: boolean
  /** 接管目标的标题（用于文案，如「在项目里新建」） */
  targetTitle?: string
}

/** 一个按钮怎么长：label 显示（≤10 字符，官方限制）、data 是点击后回传的命令 */
function btn(label: string, cmd: string, id: string, style = 1): QqButton {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: {
      type: 1,                                        // 1=回调按钮：data 传后台，平台推 INTERACTION_CREATE
      permission: { type: 2, specify_user_ids: [] },  // 2=所有人
      data: cmd,
    },
  }
}

/** 按钮文字上限（官方：label ≤10 字符） */
const LABEL_MAX = 10

/**
 * ★1016f：**把"列表"变成二级按钮菜单** —— 每条一个按钮，点一下直接执行对应命令。
 * 用途：`/list` 的会话列表（点 = `/switch N`）、`/pc` 的 PC 会话列表（点 = `/pc N`）。
 * ⚠️ 官方限制按钮文字 **≤10 字符** ⇒ 标题必须截断；太多行手机上也乱 ⇒ 调用方控制条数（建议 ≤6 条、每行 2 个）。
 */
export function buildItemKeyboard(
  keyboardId: string,
  items: Array<{ label: string; cmd: string }>,
  perRow = 2,
): QqKeyboard {
  const cut = (s: string) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 1) + '…' : t
  }
  const flat: QqButton[] = items.map((it, i) => btn(cut(it.label), it.cmd, `${keyboardId}_b${i + 1}`, 1))
  const rows: Array<{ buttons: QqButton[] }> = []
  for (let i = 0; i < flat.length; i += perRow) rows.push({ buttons: flat.slice(i, i + perRow) })
  return { content: { rows } }
}

/**
 * ★1017：**审批按钮** —— 权限卡直接挂「允许一次 / 都允许 / 拒绝」三个按钮。
 * 关键：`action.data` 就是**用户本来要打的那三个词**（`允许`/`都允许`/`拒绝`）
 * ⇒ 点击后走现有**文字审批链路**（server.ts 已有 `^(允许|同意|批准|…)$` 的解析），**零新机制**。
 * 样式：允许一次=蓝框；都允许=蓝底白字（醒目）；拒绝=白底红字（警示）。
 */
export function buildApprovalKeyboard(): QqKeyboard {
  return {
    content: {
      rows: [{
        buttons: [
          btn('允许一次', '允许', 'ap_yes', 1),
          btn('都允许', '都允许', 'ap_always', 4),
          btn('拒绝', '拒绝', 'ap_no', 3),
        ],
      }],
    },
  }
}

/** 每行最多几个按钮（官方对行内数量有限制，先按 3 个排，稳妥） */
const PER_ROW = 3

/** 按状态给出按钮排布（★这就是"状态感知"：执行中优先给「停止」） */
function commandRows(scene: ButtonScene = {}): Array<{ buttons: QqButton[] }> {
  let flat: QqButton[]
  if (scene.running) {
    // 正在跑：最想让用户点的是「停止」
    flat = [
      btn('■ 停止', '/stop', 'b_stop', 0),
      btn('当前状态', '/status', 'b_status'),
      btn('帮助', '/help', 'b_help'),
    ]
  } else if (scene.takingOver) {
    // 接管着 PC 会话：给"在项目里新建 / 退回本对话"，并保留列表
    flat = [
      btn('在项目里新建', '/new', 'b_new_here'),
      btn('回到本对话', '/home', 'b_home'),
      btn('会话列表', '/list', 'b_list'),
      btn('接管电脑', '/pc', 'b_pc'),
      btn('当前状态', '/status', 'b_status'),
    ]
  } else {
    flat = [
      btn('新会话', '/new', 'b_new'),
      btn('会话列表', '/list', 'b_list'),
      btn('接管电脑', '/pc', 'b_pc'),
      btn('当前状态', '/status', 'b_status'),
      btn('帮助', '/help', 'b_help'),
    ]
  }
  const rows: Array<{ buttons: QqButton[] }> = []
  for (let i = 0; i < flat.length; i += PER_ROW) rows.push({ buttons: flat.slice(i, i + PER_ROW) })
  return rows
}

/** 组装成官方要的 keyboard 结构 */
export function buildCommandKeyboard(scene: ButtonScene = {}): QqKeyboard {
  /**
   * ★1016c：**只传 content（自定义布局），不传 id** —— 官方 schema 明写 `content` 与 `id` 互斥
   * （`id` 是"平台预设模板"用的）。之前两个都传 ⇒ 真机 400（报错文案说的是 markdown，实际指这个）。
   */
  return { content: { rows: commandRows(scene) } }
}

/** 状态 → 一句话提示（给消息正文用，让用户知道为什么按钮长这样） */
export function commandHint(scene: ButtonScene = {}): string {
  if (scene.running) return '正在执行 —— 点「■ 停止」可中断。'
  if (scene.takingOver) return `已接管：${scene.targetTitle || 'PC 会话'} —— 「在项目里新建」会在同一项目里开一条。`
  return '点下面的按钮即可，不用手打命令。'
}

/** 从 INTERACTION_CREATE 事件里取出"用户点了哪个按钮"（取 data 当命令） */
function commandFromInteraction(d: any): { data: string; buttonId: string; userId: string } {
  const data = String(d?.data?.resolved?.button_data ?? d?.data?.button_data ?? '').trim()
  const buttonId = String(d?.data?.resolved?.button_id ?? d?.data?.button_id ?? '').trim()
  const userId = String(d?.data?.resolved?.user_id ?? d?.user_id ?? d?.data?.user_id ?? '').trim()
  return { data, buttonId, userId }
}

/* ── 自检：命令按钮是"纯数据 + 映射"，能在这里全部验完（不用真发消息）── */
export function selfCheck(): { pass: number; fail: number; detail: string[] } {
  const out: string[] = []
  let pass = 0, fail = 0
  const ok = (c: boolean, m: string) => { if (c) { pass++; out.push('  ✓ ' + m) } else { fail++; out.push('  ✗ ' + m) } }

  const idle = buildCommandKeyboard({})
  ok(!!idle.content?.rows?.length && !idle.id, 'keyboard 只传 content、不传 id（官方：两者互斥）')
  const labels = (k: QqKeyboard) => k.content.rows.flatMap(r => r.buttons).map(b => b.render_data.label)
  ok(labels(idle).includes('新会话') && labels(idle).includes('接管电脑'), '空闲给：新会话 / 接管电脑等')
  ok(!labels(idle).some(l => l.includes('停止')), '空闲时**不给**「停止」（没事可停）')

  const run = buildCommandKeyboard({ running: true })
  ok(JSON.stringify(run) !== JSON.stringify(idle), '执行中的按钮与空闲不同')
  ok(labels(run)[0].includes('停止'), '执行中**第一个**按钮是「停止」（最想点的排最前）')
  ok(run.content.rows[0].buttons[0].action.data === '/stop', '「停止」点击回传 /stop（走现有命令链路）')

  const take = buildCommandKeyboard({ takingOver: true, targetTitle: 'nis0924' })
  ok(labels(take).includes('在项目里新建') && labels(take).includes('回到本对话'), '接管中给：在项目里新建 / 回到本对话')
  ok(take.content.rows.flatMap(r => r.buttons).find(b => b.render_data.label === '在项目里新建')?.action.data === '/new', '「在项目里新建」回传 /new（后端已支持跟随上下文）')

  ok(idle.content.rows.every(r => r.buttons.length <= PER_ROW), '每行不超过 ' + PER_ROW + ' 个（防官方限流）')
  ok(idle.content.rows.flatMap(r => r.buttons).every(b => b.action.type === 1), '按钮 type=1（回调：点击推 INTERACTION_CREATE，点了就执行）')
  ok(idle.content.rows.flatMap(r => r.buttons).every(b => b.action.permission.type === 2), '权限 type=2（所有人）')
  {
    const j = JSON.stringify(idle)
    ok(!j.includes('at_bot_show_channel_list'), '不带单聊 schema 里没有的 at_bot_show_channel_list（传了 400）')
    ok(!j.includes('specify_role_ids'), '不带仅频道可用的 specify_role_ids')
    ok(!j.includes('click_limit'), '不带已废弃的 click_limit')
    ok(idle.content.rows.flatMap(r => r.buttons).every(b => (b.render_data.label || '').length <= 10), '按钮文字 ≤10 字符（官方限制）')
  }
  ok(commandHint({ running: true }).includes('停止'), '执行中的提示文案说明可点停止')
  ok(commandHint({ takingOver: true, targetTitle: 'nis0924' }).includes('nis0924'), '接管提示带上目标标题')

  ok(commandFromInteraction({ data: { resolved: { button_data: '/list', button_id: 'b_list', user_id: 'u1' } } }).data === '/list', '从事件里能取出按钮命令')
  ok(commandFromInteraction({ data: { button_data: '/stop' } }).data === '/stop', '兼容未 resolve 的形态')
  ok(commandFromInteraction({}).data === '', '没有 data 时返回空（调用方据此忽略）')

  // ★1016f：二级"列表按钮"
  const ik = buildItemKeyboard('nis_list', [
    { label: '1.QQ单聊初次问候', cmd: '/switch 1' },
    { label: '2.' + '很长的会话标题'.repeat(4), cmd: '/switch 2' },
    { label: '3.第三条', cmd: '/switch 3' },
  ])
  const ikb = ik.content.rows.flatMap(r => r.buttons)
  ok(ikb.length === 3, '列表按钮：3 条会话 → 3 个按钮')
  ok(ikb[0].action.data === '/switch 1', '第一个按钮点击 = /switch 1（复用命令链路）')
  ok(ikb.every(b => (b.render_data.label || '').length <= 10), '按钮文字都 ≤10 字符（官方限制）')
  ok(ikb[1].render_data.label.endsWith('…'), '超长标题被截断成 …')
  ok(ik.content.rows.length === 2 && ik.content.rows[0].buttons.length === 2, '每行 2 个（3 条 → 2 行）')

  return { pass, fail, detail: out }
}

// 允许直接跑：node --experimental-strip-types qqButtons.ts
if (process.argv[1] && /qqButtons\.ts$/.test(process.argv[1])) {
  const r = selfCheck()
  console.log(r.detail.join('\n'))
  console.log(`\n=== ${r.pass} 项通过 / ${r.fail} 项失败 ===`)
  process.exit(r.fail ? 1 : 0)
}
