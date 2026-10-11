/**
 * 通道命令层（0912 接入批）—— 解析 IM 里发的 `/命令`
 *
 * 背景：微信/QQ 场景下用户手上没有侧栏，**命令是唯一的会话管理方式**
 * （切换对话、新开对话、看状态）。本模块只做「解析 + 命令表」，
 * 具体执行放 server.ts（需要访问真实 sessions），保持本模块可单测。
 *
 * 解析规则（对齐腾讯官方 openclaw-weixin 的 slash-commands.ts）：
 *   - 以 `/` 开头才算命令；否则返回 null（走正常 AI 管道）
 *   - 命令名取第一个空格前的部分并转小写；其余为参数
 *   - 支持 `: ` 分隔（如 `/think: high`）→ 归一化为空格（用户从其他工具带过来的习惯）
 */

interface ParsedCommand {
  /** 命令名（不含 `/`，已小写） */
  name: string
  /** 原始参数串（已 trim） */
  args: string
}

interface CommandSpec {
  name: string
  /** 参数占位（用于帮助文本），无参数为空串 */
  params: string
  /** 中文说明 */
  desc: string
  /** 同义命令（都指向同一实现） */
  aliases?: string[]
}

/**
 * 命令表 —— 最小可用集（会话管理 + 状态 + 停止）。
 *
 * 设计原则：**只收「手机上必须做、且没有替代入口」的操作**。
 * 比如「改人格」「改供应商」这类低频操作不放进来（去 PC 设置页更合适），
 * 避免命令表膨胀成第二个设置面板。
 */
const COMMANDS: CommandSpec[] = [
  /* ★1014d：**中文别名 = QQ 指令面板里点出来的名字**。
     面板项（channels/qqPanel.ts 的 QQ_PANEL_ITEMS）name 是中文，QQ 点击后发的是 `/新会话` 这类
     中文命令；此前解析层只认英文 → 用户点面板得到的回答是「未知命令：/会话列表」（实测截图）。
     ⇒ 加中文别名后：点面板能用，手打英文照旧能用。
     ⚠️ 面板项与这里必须对得上 —— 工作区回归 `_verify_qqpanel_cmd.mts` 会真跑一遍"每个面板项都能被
        findCommand 命中"，改面板/改命令表任一侧都会被它拦下。 */
  { name: 'new', params: '[标题]', desc: '新开一个对话（可选给个标题）', aliases: ['新会话', '新对话'] },
  { name: 'list', params: '', desc: '列出**本对话**的对话列表（序号 + 标题 + 私聊/群聊）', aliases: ['ls', '会话列表', '列表'] },
  { name: 'switch', params: '<序号>', desc: '切换到本对话列表里的第 N 个（序号见 /list）', aliases: ['sw', '切换会话', '切换'] },
  /* ★1014f：PC 会话接管 —— 手机切到「PC 上干活的项目会话」（带项目文件与上下文）。
     仅私聊 + 需配对（配对码见后端数据目录 channels/pc-access.json），群里一律拒绝。 */
  { name: 'pc', params: '[序号]', desc: '接管 PC 端会话：/pc 看列表，/pc <序号> 接管（仅私聊，首次需配对码）', aliases: ['电脑', '接管电脑', 'PC会话', '接管'] },
  { name: 'home', params: '', desc: '从接管的 PC 会话退回本对话自己的会话', aliases: ['回来', '退回', '回到本对话'] },
  { name: 'perm', params: '[档位]', desc: '查看/切换权限档位（1 审计 / 2 完全访问 / 3 每次确认）', aliases: ['permission', 'audit', '权限'] },
  { name: '通知', params: '', desc: '列出待回复的定时任务通知', aliases: ['notices', 'notice', '通知列表'] },
  { name: '回复通知', params: '[序号] 内容', desc: '就某条定时任务通知追问（默认最近一条；/回复通知2 内容 指定第 2 条）', aliases: ['replynotice', 'rn'] },
  { name: 'status', params: '', desc: '查看当前对话状态（模型/上下文/运行中）', aliases: ['当前状态', '状态'] },
  { name: 'stop', params: '', desc: '停止当前正在执行的回复', aliases: ['cancel', '停止'] },
  { name: 'help', params: '', desc: '显示本帮助', aliases: ['?', 'h', '帮助'] },
]

/** 按名称（含别名）查命令 */
export function findCommand(name: string): CommandSpec | null {
  const n = name.toLowerCase()
  for (const c of COMMANDS) {
    if (c.name === n) return c
    if (c.aliases?.includes(n)) return c
  }
  return null
}

/**
 * 解析一条消息是否为命令。
 * @returns 是命令则返回解析结果；否则返回 null（调用方应把它当普通消息走 AI）
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('/')) return null

  // `: ` 归一化：/think: high → /think high（用户可能从别处带过来）
  let body = trimmed.slice(1)
  body = body.replace(/^(\S+?):\s+/, '$1 ')

  const spaceIdx = body.indexOf(' ')
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).trim().toLowerCase()
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
  if (!name) return null
  return { name, args }
}

/** 帮助文本（IM 里直接可读，纯文本 + 简单缩进，不依赖 Markdown 渲染） */
export function helpText(): string {
  const lines = ['可用命令：', '']
  for (const c of COMMANDS) {
    const left = `/${c.name}${c.params ? ' ' + c.params : ''}`
    // 对齐：命令列固定 18 字符宽（中文宽度差异用空格补足即可，不做精确排版）
    lines.push(`  ${left.padEnd(18, ' ')}${c.desc}`)
  }
  lines.push('', '提示：直接发消息就是和 AI 对话；发 / 开头的才会被当命令。')
  return lines.join('\n')
}

/** 命令表的结构化副本（供前端「命令帮助」展示，避免前端重复维护一份） */
export function commandList(): Array<{ name: string; params: string; desc: string; aliases: string[] }> {
  return COMMANDS.map(c => ({ name: c.name, params: c.params, desc: c.desc, aliases: c.aliases || [] }))
}

/* ═══════════════════════════════════════════════════════════════════════
   权限档位（0912 三批：IM 里用文字调节）
   ───────────────────────────────────────────────────────────────────────
   与 server.ts 的 PermissionMode 三档一一对应。用户能在 IM 里发 `/perm` 切换，
   不必回到 PC 设置页 —— 手机场景下这是唯一入口。
   ═══════════════════════════════════════════════════════════════════════ */

type ChannelPermMode = 'self_audit' | 'full_access' | 'confirm'

interface PermOption {
  value: ChannelPermMode
  /** 中文档位名（IM 里直接可读） */
  label: string
  desc: string
}

export const PERM_OPTIONS: PermOption[] = [
  { value: 'self_audit', label: '审计模式', desc: '放行所有操作，但全程留痕（推荐）' },
  { value: 'full_access', label: '完全访问', desc: '不再拦截任何操作，最快' },
  { value: 'confirm', label: '每次确认', desc: '高风险操作需你确认后才执行（手机上点按钮即可）' },
]

/** 档位 → 中文名（未知值原样返回） */
export function permLabel(mode: string): string {
  return PERM_OPTIONS.find(o => o.value === mode)?.label || mode || '未知'
}

/**
 * 解析用户输入 → 权限档位。
 * 支持三种写法：序号（1/2/3）、英文名（self_audit / full_access / confirm）、中文名（审计/完全访问/确认）。
 * @returns 无法识别返回 null
 */
export function parsePermMode(arg: string): ChannelPermMode | null {
  const a = String(arg || '').trim().toLowerCase()
  if (!a) return null

  // 序号：1 审计 / 2 完全访问 / 3 每次确认（与 PERM_OPTIONS 顺序一致）
  if (/^[123]$/.test(a)) return PERM_OPTIONS[Number(a) - 1].value

  if (a === 'self_audit' || a === 'audit' || a === 'selfaudit') return 'self_audit'
  if (a === 'full_access' || a === 'full' || a === 'fullaccess') return 'full_access'
  if (a === 'confirm' || a === 'ask') return 'confirm'

  // 中文（去掉空格便于匹配「完全 访问」这类输入）
  const zh = a.replace(/\s+/g, '')
  if (zh === '审计' || zh === '审计模式' || zh === '自审计') return 'self_audit'
  if (zh === '完全访问' || zh === '完全' || zh === '放行') return 'full_access'
  if (zh === '每次确认' || zh === '确认' || zh === '逐次确认') return 'confirm'

  return null
}

/** 权限档位说明文本（IM 里 `/perm` 无参数时展示） */
export function permText(current: string): string {
  const lines = [`当前权限档位：${permLabel(current)}`, '', '发 /perm <档位> 切换：']
  PERM_OPTIONS.forEach((o, i) => {
    lines.push(`  ${i + 1}. ${o.label} —— ${o.desc}`)
  })
  lines.push('', '也可以直接发档位名，如：/perm 完全访问')
  return lines.join('\n')
}
