/**
 * 工具分类器（对齐 dsh ToolRow 设计）
 * 工具名 → variant（search/read/bash/write/edit/code/others）
 * 每个 variant 有中文标题、摘要提取规则、图标
 *
 * 0911 多语言：标题/变体名改为「字典优先」——toolTitle() / variantLabel() 先查 i18n 字典
 * （tool.name.* / tool.variant.*），缺键回退本文件的中文常量（零风险：漏加键 = 保持原中文）。
 */
import { t } from '@/utils/i18n'

export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'ask' | 'delete' | 'others'
type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

const VARIANT_LABELS: Record<ToolRowVariant, string> = {
  search: '搜索',
  read: '读取',
  bash: '命令',
  write: '写入',
  edit: '编辑',
  code: '代码',
  ask: '提问',
  delete: '删除',
  others: '工具',
}


/** 工具名 → variant 映射 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  // 文件/Shell
  fs_read: 'read',
  fs_grep: 'search',
  fs_write: 'write',
  fs_edit: 'edit',
  project_note: 'write',
  fs_delete: 'delete',
  run_command: 'bash',
  ask_user: 'ask',
  // 联网 / 技能 / 团队（0913 接线自检补：此前只在 backend/toolCatalog 声明了 variant，
  // 前端分类表漏注册 → 过程块会归类成 others。跑 `backend/_toolwiring_check.mjs` 能一键发现这类疏漏）
  web_search: 'search',
  web_fetch: 'read',
  github_search: 'search',
  use_skill: 'others',
  sub_plan: 'write',
  // 记忆/知识库
  memory_search: 'search',
  memory_store: 'others',
  memory_distill: 'others',
  memory_delete: 'others',
  knowledge_query: 'search',
  knowledge_add: 'write',
  knowledge_delete: 'others',
  // 用户记事本（0920）
  notebook_list: 'read',
  notebook_add: 'write',
  notebook_update: 'edit',
  notebook_delete: 'delete',
  // 后台任务（0921 接线）
  // ★ 0929 刀②：按需加载器（瞬时返回说明书）
  load_tools: 'others',
  bg_start: 'bash',
  // ★ 0929 刀①：家族级兜底（有 action 时 familyActionTool 会归一到上面的旧名，观感逐工具一致）
  bg: 'bash',
  notebook: 'write',
  memory: 'search',
  knowledge: 'search',
  // ★ 0929 批次A：列目录 / 文件时光机 / 定时任务（含按动作分流）
  list_dir: 'read',
  history: 'others',
  history_list: 'read',
  history_restore: 'edit',
  history_stat: 'read',
  schedule: 'others',
  schedule_create: 'write',
  schedule_list: 'read',
  schedule_update: 'edit',
  schedule_remove: 'delete',
  schedule_run_now: 'bash',
  // ★ 0929 批次B：git 族
  git: 'bash',
  git_status: 'read',
  git_diff: 'search',
  git_log: 'read',
  git_commit: 'bash',
  // ★ 0929 批次C：repo 族
  repo: 'search',
  repo_map: 'read',
  repo_search: 'search',
  repo_build: 'others',
  bg_list: 'read',
  bg_read: 'read',
  bg_stop: 'others',
  bg_watch: 'others',
  bg_note: 'others',

  memory_node_add: 'others',
  memory_node_update: 'edit',
  memory_node_delete: 'others',
  memory_edge_add: 'others',
  memory_edge_delete: 'others',
  // 特殊工具：安装/预设
  install_skill: 'bash',
  uninstall_skill: 'delete',
  scan_skill: 'search',
  list_installed: 'read',
  install_mcp: 'bash',
  uninstall_mcp: 'delete',
  list_tools: 'read',
  read_preset: 'read',
  save_preset: 'write',
  delete_preset: 'delete',
  run_code: 'code',
  settings_update: 'edit',
  // 自定义工具管理（创造模式专属）
  list_custom_tools: 'read',
  save_custom_tool: 'write',
  delete_custom_tool: 'delete',
  // 计划本
  plan_write: 'write',
  // 团队运行时（P2：派发/黑板/团队信息）
  team_dispatch: 'others',
  /* ★0926（_toolwiring_check 揪出的漏账）：spawn_clone 补进 TOOL_VARIANTS——缺了会归到隐式 others，
     现显式注册与 team_dispatch 同类（派发类）。 */
  spawn_clone: 'others',
  bb_goal: 'write',
  bb_write: 'write',
  bb_read: 'read',
  team_info: 'read',
  // 项目自我修改（创造模式专属：project_fs_* 绑定 NIS 源码根）
  project_fs_read: 'read',
  project_fs_grep: 'search',
  project_fs_write: 'write',
  project_fs_edit: 'edit',
  project_fs_delete: 'delete',
  project_run_command: 'bash',
}

/** 工具名 → 中文标题覆写 */
const TOOL_TITLES: Record<string, string> = {
  fs_read: '读取文件',
  fs_grep: '搜索文件内容',
  fs_write: '写入文件',
  fs_edit: '精确替换',
  fs_delete: '删除文件',
  run_command: '执行命令',
  ask_user: '向用户提问',
  memory_search: '检索记忆',
  memory_store: '记录记忆',
  memory_delete: '删除记忆',
  knowledge_query: '知识库检索',
  knowledge_add: '知识库写入',
  knowledge_delete: '删除知识条目',
  // 便签（0920，原名"用户记事本"）
  notebook_list: '读便签',
  notebook_add: '记到便签',
  notebook_update: '更新便签',
  notebook_delete: '删便签条目',
  // 后台任务（0921 接线）
  // ★ 0929 刀②：按需加载器
  load_tools: '加载能力包',
  bg_start: '挂到后台',
  // ★ 0929 刀①：家族级兜底标题（有 action 时按动作分流到旧名标题）
  bg: '后台任务',
  notebook: '便签',
  memory: '记忆',
  knowledge: '知识库',
  // ★ 0929 批次A：列目录 / 文件时光机 / 定时任务（含按动作分流）
  list_dir: '列目录',
  history: '文件时光机',
  history_list: '改动历史',
  history_restore: '撤销改动',
  history_stat: '历史统计',
  schedule: '定时任务',
  schedule_create: '新建定时任务',
  schedule_list: '定时任务列表',
  schedule_update: '改定时任务',
  schedule_remove: '删定时任务',
  schedule_run_now: '立即跑一次',
  // ★ 0929 批次B：git 族
  git: 'git',
  git_status: 'git 状态',
  git_diff: 'git 改动对比',
  git_log: 'git 提交历史',
  git_commit: 'git 提交',
  // ★ 0929 批次C：repo 族
  repo: '仓库地图',
  repo_map: '仓库地图',
  repo_search: '代码语义搜索',
  repo_build: '重建代码索引',
  bg_list: '后台任务列表',
  bg_read: '读后台输出',
  bg_stop: '停止后台任务',
  bg_watch: '约个回访',
  bg_note: '报后台进度',

  memory_node_add: '新增记忆节点',
  memory_node_update: '更新记忆节点',
  memory_node_delete: '删除记忆节点',
  memory_edge_add: '新增关联',
  memory_edge_delete: '删除关联',
  // 联网
  web_search: '联网搜索',
  web_fetch: '读取网页',
  github_search: 'GitHub 搜索',
  // 技能
  use_skill: '使用技能',
  // 特殊工具：安装/预设
  install_skill: '安装技能',
  uninstall_skill: '卸载技能',
  scan_skill: '安全扫描',
  list_installed: '列出已安装',
  install_mcp: '安装 MCP',
  uninstall_mcp: '卸载 MCP',
  list_tools: '列出工具',
  read_preset: '读取预设',
  save_preset: '保存预设',
  delete_preset: '删除预设',
  run_code: '执行代码',
  settings_update: '更新设置',
  // 自定义工具管理（创造模式专属）
  list_custom_tools: '列出自定义工具',
  save_custom_tool: '保存自定义工具',
  delete_custom_tool: '删除自定义工具',
  plan_write: '写计划',
  // 团队运行时
  team_dispatch: '派发任务',
  /* ★ 0925x（产品要求"过程块名字跟工具面板对不上"）：标题=工具 label 同款「派出分身」 */
  spawn_clone: '派出分身',
  bb_goal: '写黑板目标',
  bb_write: '写黑板',
  bb_read: '读黑板',
  team_info: '读团队信息',
  sub_plan: '成员自列执行计划',
  project_note: '写项目档案',
}

/** 0908 三批：内置浏览器（虚拟 MCP nis-browser）入参人话化——展开体 IN 区不露原始 JSON。
 *  0908 收尾（用户反馈）：过程块【标题】回退为通用 "MCP nis-browser/xxx"（不再"内置浏览器 · 中文名"）；
 *  友好名映射随之删除。入参人话保留（这是"展开显示的内容"，用户认可的方向）。 */
/** wb_* 入参 → 一行中文人话（展开体 IN 区用它替代原始 JSON；返回 '' 则不显示 IN）。
 *  0908 修复"不能展开"回归：有参数但原实现返回 '' 的工具（wb_close_tab/wb_evaluate/带 tabId 的快照类）
 *  会让 body=null → expandable 掉 → 块不可点。这些分支补一行中性人话，绝不返回空。 */
export function mcpFriendlyInput(toolName: string, input: Record<string, any>): string {
  const m = /^mcp__nis-browser__(\w+)$/.exec(toolName)
  if (!m) return ''
  const tool = m[1]
  const s = (v: any) => (typeof v === 'string' && v ? oneLine(v) : '')
  const tabOnly = () => s(input.tabId) ? `标签 ${s(input.tabId)}` : ''
  switch (tool) {
    case 'wb_navigate': return s(input.url) ? `网址：${s(input.url)}` : ''
    case 'wb_click': return s(input.text) ? `点击文字："${s(input.text)}"` : s(input.selector) ? `点击元素：${s(input.selector)}` : tabOnly()
    case 'wb_fill': return `填入${s(input.placeholder) ? `占位"${s(input.placeholder)}"` : s(input.selector) ? ` "${s(input.selector)}"` : ''}：${s(input.value) || '（空）'}`
    case 'wb_fill_form': return Array.isArray(input.fields) ? `一次填 ${input.fields.length} 个字段` : ''
    case 'wb_press_key': return `按键：${s(input.key) || 'Enter'}`
    case 'wb_scroll': return `向${s(input.direction) || '下'}滚动 ${s(String(input.amount)) || '600'}px`
    case 'wb_hover': return s(input.text) ? `悬停："${s(input.text)}"` : s(input.selector) ? `悬停：${s(input.selector)}` : tabOnly()
    case 'wb_get_text': return s(input.text) ? `取文字："${s(input.text)}" 处` : s(input.selector) ? `取文字：${s(input.selector)}` : tabOnly()
    case 'wb_snapshot': case 'wb_screenshot': case 'wb_status': case 'wb_list_tabs': case 'wb_console': return tabOnly()
    case 'wb_wait': return [s(input.selector) && `等待出现：${s(input.selector)}`, input.ms && `最长 ${input.ms}ms`].filter(Boolean).join('，')
    case 'wb_set_viewport': return `视口：${s(input.viewport) || ''}`
    case 'wb_close_tab': return tabOnly() || '关闭一个标签页'
    case 'wb_evaluate': return '执行一段页面脚本'   // 不露源码，但块保持可展开
    case 'wb_preview_file': return s(input.path) ? `文件：${s(input.path)}` : ''
    case 'wb_send_screenshot': return [s(input.url) && `网页：${s(input.url)}`, s(input.path) && `文件：${s(input.path)}`, s(input.tabId) && `标签 ${s(input.tabId)}`].filter(Boolean).join('，') || '当前页面'
    case 'wb_screen_capture': return '整块屏幕画面'
    default: return ''
  }
}

/** 0908 收尾（用户反馈"给我们的机制盖住"）：工具结果里追加的自动化防护指令段
 *  （【循环防护】/【不要重试】/【行为指令】——写给模型看的策略指令）在展示层剥除。
 *  模型侧收到的原文不变（piChat 存的是 raw toolResult，只有这里显示时过滤）。
 *  剥完为空时给一句中性说明，错误块不至于 OUT 区全空。 */
export function stripMechanism(text: string): string {
  if (!text) return text
  const cut = text.split(/\n*\s*【(?:循环防护|不要重试|行为指令)】/)
  const head = cut[0].trimEnd()
  if (head) return head
  return cut.length > 1 ? '（该操作被系统自动化防护拦截，模型已按策略调整——详情见运行日志）' : text
}

/* ★ 0929 工具瘦身·刀①：家族工具 (name, action) → 合并前旧工具名 —— 图标/标题/变体/摘要按动作分流，
   显示效果与合并前逐工具完全一致（功能不减、观感不减）。无 action 时原样返回（家族级兜底）。 */
const FAMILY_ACTION_TOOL: Record<string, string> = {
  'bg:start': 'bg_start', 'bg:list': 'bg_list', 'bg:read': 'bg_read', 'bg:stop': 'bg_stop', 'bg:note': 'bg_note', 'bg:watch': 'bg_watch',
  'notebook:list': 'notebook_list', 'notebook:add': 'notebook_add', 'notebook:update': 'notebook_update', 'notebook:delete': 'notebook_delete',
  'memory:search': 'memory_search', 'memory:store': 'memory_store', 'memory:delete': 'memory_delete', 'memory:distill': 'memory_distill',
  'knowledge:query': 'knowledge_query', 'knowledge:add': 'knowledge_add', 'knowledge:delete': 'knowledge_delete',
  // ★ 0929 批次A：新家族同样按动作分流显示
  'history:list': 'history_list', 'history:restore': 'history_restore', 'history:stat': 'history_stat',
  'schedule:create': 'schedule_create', 'schedule:list': 'schedule_list', 'schedule:update': 'schedule_update', 'schedule:remove': 'schedule_remove', 'schedule:run_now': 'schedule_run_now',
  // ★ 0929 批次B：git 族
  'git:status': 'git_status', 'git:diff': 'git_diff', 'git:log': 'git_log', 'git:commit': 'git_commit',
  // ★ 0929 批次C：repo 族
  'repo:map': 'repo_map', 'repo:search': 'repo_search', 'repo:build': 'repo_build',
}
export function familyActionTool(toolName: string, input?: Record<string, any> | null): string {
  const a = String((input as any)?.action || '').trim()
  return (a && FAMILY_ACTION_TOOL[`${toolName}:${a}`]) || toolName
}

export function classifyTool(toolName: string, input?: Record<string, any> | null): ToolRowVariant {
  const n = familyActionTool(toolName, input)
  // MCP 动态工具（mcp__<server>__<tool>）：按联网类展示
  if (n.startsWith('mcp__')) return 'search'
  return TOOL_VARIANTS[n] ?? 'others'
}

/** 变体名（字典优先：tool.variant.*；缺键回退中文常量） */
function variantLabel(v: ToolRowVariant): string {
  const key = 'tool.variant.' + v
  const via = t(key)
  return via !== key ? via : VARIANT_LABELS[v]
}

/** 工具标题（字典优先：tool.name.*；缺键回退中文常量；都没有返回 null） */
function toolTitleBase(name: string): string | null {
  const key = 'tool.name.' + name
  const via = t(key)
  if (via !== key) return via
  return TOOL_TITLES[name] ?? null
}

export function toolTitle(toolName: string, input?: Record<string, any> | null): string {
  const name = familyActionTool(toolName, input)
  // MCP 动态工具：标题为 服务/工具名
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = parts[1] || ''
    const tool = parts[2] || ''
    // 0908 收尾（用户反馈）：内置浏览器标题回退通用形态（此前"内置浏览器 · 中文名"被点名撤回），
    // 与其它 MCP 服务统一为 "MCP <server>/<tool>"。人话化只保留在展开体的入参/结果里。
    return `MCP ${server}/${tool}`
  }
  // 项目自我修改（project_fs_*）：标题强调"项目·"
  if (name.startsWith('project_fs_') || name === 'project_run_command') {
    const base = toolTitleBase(name.replace('project_', '')) || name
    const pfx = t('tool.projectPrefix')
    return `${pfx !== 'tool.projectPrefix' ? pfx : '项目·'}${base}`
  }
  return toolTitleBase(name) ?? variantLabel(classifyTool(name))
}

/** 团队派发：摘要取任务单首条（数量 + 任务文本），无 tasks 时返回空走兜底 */
function teamDispatchSummary(input: Record<string, any>): string {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : []
  if (tasks.length === 0) return ''
  const first = tasks[0] || {}
  const text = String(first.task || first.stepId || '').trim()
  const full = (tasks.length > 1 ? `${tasks.length} 项任务｜首个：` : '') + text
  return full.length > 120 ? full.slice(0, 120) + '…' : full
}


/** 摘要提取：从工具输入参数中提取关键字段用于折叠行显示 */
const SUMMARY_KEYS: Record<ToolRowVariant, string[]> = {
  bash: ['command', 'description'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  ask: ['question', 'content', 'title'],
  delete: ['path', 'file_path'],
  others: ['content', 'title', 'id'],
}

/** 记事本状态 → 中文（摘要里显示"待办/搁置…"，而不是照搬 todo/hold 这种机器码） */
const NOTEBOOK_STATUS_TEXT: Record<string, string> = { todo: '待办', hold: '搁置', done: '已完成', cancelled: '取消' }

function deriveSummary(toolName: string, input: Record<string, any>): string {
  const tool = familyActionTool(toolName, input)   // ★ 0929 刀①：家族工具按动作归一（notebook_* 特判等照常生效）
  // 团队派发：tasks 数组结构特殊，专用摘要
  if (tool === 'team_dispatch') {
    const s = teamDispatchSummary(input)
    if (s) return s
  }
  // 记事本（0920）：主参数是 title / keyword / status，不在通用摘要键表里
  // （不特判会退化成拿 id 或 "all" 当摘要）
  if (tool.startsWith('notebook_')) {
    const parts = tool === 'notebook_list'
      ? [input.keyword, (input.status && input.status !== 'all') ? NOTEBOOK_STATUS_TEXT[String(input.status)] : '']
      : [input.title, input.id]
    const s = parts.map(x => oneLine(String(x || ''))).filter(Boolean).join(' ')
    if (s) return s.length > 120 ? s.slice(0, 120) + '…' : s
  }
  // 流式中间态防护：provider 参数未成型时 input 可能是 parseStreamingJson 的半成品
  // （path 缺失、content 含真实换行）或字符串解析失败的 {raw:'整段JSON'}。
  // 两者都会把多行内容灌进单行摘要区（大间距/JSON 乱码）。此时返回工具友好短文案。
  if (input && Object.keys(input).length === 1 && typeof (input as any).raw === 'string') return ''
  const keys = SUMMARY_KEYS[classifyTool(tool)]
  for (const key of keys) {
    const v = input[key]
    if (typeof v === 'string' && v) { const s = oneLine(v); return s.length > 120 ? s.slice(0, 120) + '…' : s }
  }
  // fallback: 取第一个非空 string 值（同样压平换行，防模型参数带多行文本撑爆行距）
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) { const s = oneLine(v); return s.length > 120 ? s.slice(0, 120) + '…' : s }
  }
  return ''
}

/** 压平换行：\n 转空格合并连续空白——过程块摘要是单行 UI，多行内容必须拍平 */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim()
}

/* ── 拟人化摘要（方案 A）：按工具类型配口语化文案池，随机选取，活人感 ── */

/** 工具名 → 拟人化文案模板池（{p}=主参数占位符） */
const PERSONA_TEMPLATES: Record<string, string[]> = {
  run_command: [
    '来，我帮你跑一下这条命令～',
    '执行看看效果：{p}',
    '好的，我来运行一下：{p}',
    '敲个命令试试：{p}',
    '这就去执行：{p}',
  ],
  python_run: [
    '跑一下这段代码～',
    '我来执行看看：{p}',
  ],
  fs_read: [
    '让我看看这个文件里写了什么～',
    '打开 {p} 瞅瞅内容',
    '我来读一下：{p}',
    '看看 {p} 里面是啥',
  ],
  fs_write: [
    '好的，我帮你写进去！',
    '来，写入 {p}',
    '记下来，写进 {p}',
    '搞定，内容写到 {p} 了',
  ],
  fs_delete: [
    '这个没用了，我帮你删掉～',
    '删掉 {p}，干净利落！',
    '好的，清理掉 {p}',
  ],
  memory_search: [
    '让我回忆一下关于「{p}」的事…',
    '翻翻记忆，找找「{p}」相关的',
    '我记得好像有「{p}」的东西，找找看',
    '想想之前关于「{p}」说过啥',
  ],
  memory_store: [
    '好的，我记住了！',
    '记下来了，以后需要再找我～',
    '嗯，我存好了',
  ],
  memory_delete: [
    '这条记忆没用了，帮你忘掉～',
    '好的，删掉这条记忆',
  ],
  memory_node_add: [
    '在记忆图里加个节点～',
    '好的，新增一个记忆节点',
  ],
  memory_node_update: [
    '更新一下这个记忆节点～',
    '好的，改好了',
  ],
  memory_node_delete: [
    '这个节点删掉吧～',
    '好的，移除这个节点',
  ],
  memory_edge_add: [
    '把这两个节点连起来～',
    '好的，加一条关系',
  ],
  memory_edge_delete: [
    '这条关系不要了，删掉～',
  ],
  knowledge_query: [
    '查一下知识库，找找「{p}」相关的内容',
    '翻翻文档，搜「{p}」相关的',
    '我去知识库里翻翻「{p}」',
  ],
  knowledge_add: [
    '好的，我加到知识库里了！',
    '知识库已更新，存好了～',
  ],
  knowledge_delete: [
    '从知识库里删掉这条',
    '好的，清理掉了',
  ],
  // 便签（0920，原名"用户记事本"）
  notebook_list: [
    '翻翻便签，看看还有哪些事没办～',
    '我看下便签里的待办',
    '查一下便签：{p}',
  ],
  notebook_add: [
    '好的，帮你记到便签了：{p}',
    '记下了～{p}',
    '这条我写进便签了：{p}',
  ],
  notebook_update: [
    '便签这条更新一下：{p}',
    '好的，状态改好了～',
    '把这条改一下：{p}',
  ],
  notebook_delete: [
    '这条从便签里删掉了',
    '好的，清理掉这条',
  ],
  // 后台任务（0921 接线）
  bg_start: [
    '这事有点耗时，我先挂后台跑着～',
    '挂到后台去做，不用在这儿等：{p}',
    '后台开跑：{p}',
  ],
  bg_list: [
    '看看后台都在忙啥～',
    '查一下后台任务列表',
  ],
  bg_read: [
    '看看后台跑到哪儿了：{p}',
    '读一下后台输出',
  ],
  bg_stop: [
    '这个后台任务停掉～',
    '好的，把 {p} 停了',
  ],
  bg_watch: [
    '记下了，到点我回来看看～',
    '好，约个回访：{p}',
  ],
  bg_note: [
    '收到，进度记下了～',
    '好，报一下进度：{p}',
  ],

  ask_user: [
    '想问你一个问题～',
    '有个事想问问你：',
    '来，问你个问题：',
    '先问一下你的想法：',
  ],
  settings_update: [
    '好的，我帮你改一下设置～',
    '设置已更新！',
  ],
  browser_navigate: [
    '我打开网页看看～',
    '去 {p} 逛逛',
  ],
  web_search: [
    '我去网上搜一下「{p}」',
    '帮你查查「{p}」相关的信息',
  ],
  web_fetch: [
    '我打开「{p}」看看内容',
    '读一下这个网页：{p}',
    '这就去看看～',
  ],
  github_search: [
    '上 GitHub 找找「{p}」相关的开源项目',
    '搜搜 GitHub 上有没有现成的轮子：{p}',
    '看看GitHub 上「{p}」的实现',
  ],
  use_skill: [
    '好的，我按「{p}」的技能流程来',
    '调用技能「{p}」，按它的步骤执行～',
    '收到，加载技能「{p}」的指令',
  ],
  // 团队运行时
  team_dispatch: [
    '把活儿分给团队成员～',
    '派发任务单：{p}',
    '成员就位，开工！',
  ],
  bb_goal: [
    '先定目标和计划～',
    '把计划写上黑板',
    '拆解任务，立个总目标：{p}',
  ],
  bb_write: ['黑板记录一下～', '记到黑板上', '更新黑板进度'],
  bb_read: ['翻翻黑板看看进度～', '读一下黑板', '看看黑板上的记录'],
  team_info: ['看看团队成员都有谁～', '读一下团队清单'],
  /* ★ 0925x（产品要求"过程块名称不对"）：spawn_clone 专属拟人文案（原走兜底"收到，正在弄…"） */
  spawn_clone: [
    '分身出动～',
    '派出我的分身，开干！',
    '复制几个我，并行搞～',
  ],
  generate_image: [
    '这就给你画～',
    '稍等，我在创作中…',
  ],
}

/** 未登记工具的兜底文案池 */
const PERSONA_FALLBACK: string[] = [
  '好的，我来处理～',
  '收到，正在弄…',
  '来了来了，马上就好～',
  '这个交给我吧！',
  '嗯，我在处理了…',
]

/** 拟人化状态文案（方案 B） */
const PERSONA_STATUS: Record<ToolRowState, string[]> = {
  running: ['正在搞…', '马上好～', '稍等一下哈～', '快了快了…', '进行中，别急～'],
  ok: ['搞定！', '完成～', '好了！', '搞定收工！', '妥妥的～'],
  error: ['诶，出错了…', '不好了，出错了！', '出错了，我看看…', '这有点翻车了…'],
  stopped: ['先不弄了，停在这～'],
}

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 拟人化摘要：随机文案模板 + 主参数（活人感；同一组件实例保持稳定） */
export function derivePersona(toolName: string, input: Record<string, any>): string {
  /* ★1003 批次4 4.57：模板查找先按家族工具归一（bg:start → bg_start）—— 原来用裸名查，
   * 而 PERSONA_TEMPLATES 按旧的按动作名收键 ⇒ 家族工具永远落 PERSONA_FALLBACK、拟人文案
   * 静默丢失（两行之外的 deriveSummary 却归一正确 = 同一行为两套口径）。 */
  const name = familyActionTool(toolName, input)
  const tpls = PERSONA_TEMPLATES[name] || PERSONA_TEMPLATES[toolName] || PERSONA_FALLBACK
  const p = deriveSummary(toolName, input)
  // 无主参数时只从"不带 {p} 占位符"的模板里选——否则 {p} 原样露出（"写入： {p}"事故，
  // 流式早期 args 未到时被 persona 缓存污染放大，显示后 args 补上也不会重算）
  const pool = p ? tpls : tpls.filter(t => !t.includes('{p}'))
  const tpl = pick(pool.length > 0 ? pool : PERSONA_FALLBACK)
  if (!p) return tpl
  // 0906 五批：路径类主参数不截断（截尾会让"…/x.html"不再是文件样式、chip 机制失效）；
  // 普通长文本仍 60 截断。
  const isPathish = /[\\/][^\\/]+\.\w{1,8}$/.test(p)
  const pv = isPathish || p.length <= 60 ? p : p.slice(0, 60) + '…'
  // 0906 五批：带 {p} 的模板直接替换；随机到"不带 {p}"的模板时把文件/参数值追加上去
  //（用户要求所有文件类过程块都露出文件名，chip 渲染依赖文本含 pathText 原文）
  return tpl.includes('{p}') ? tpl.replace('{p}', pv) : `${tpl} ${pv}`
}

/** 拟人化状态文案（随机一条） */
export function derivePersonaStatus(state: ToolRowState): string {
  return pick(PERSONA_STATUS[state] || PERSONA_STATUS.ok)
}

/** 展开体文本：输入参数格式化 */
export function formatInputBody(input: Record<string, any>): string {
  return JSON.stringify(input, null, 2)
}

/** 输出文本截断 */
export function formatOutput(output: string, maxLen = 800): string {
  if (!output) return ''
  return output.length > maxLen ? output.slice(0, maxLen) + '\n…(截断)' : output
}