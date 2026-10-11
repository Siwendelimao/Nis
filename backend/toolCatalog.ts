/**
 * 工具唯一事实源（0904 工具系统捋顺）
 *
 * 背景：此前"仓库"(PluginsModal SYSTEM_TOOL_GROUPS)、"预设可选"(本文件旧版 39 条)、
 * "真实挂载"(server.ts 组装) 是三份各写各的清单，加新工具要人肉同步三处；且旧版
 * project_read/write/delete/run 四条名字全错（真实为 project_fs_read/project_fs_write/
 * project_fs_delete/project_run_command），list_tools 把假名喂给 AI 导致照名调用必失败。
 *
 * 现在：本文件是**唯一源**——静态定义全部内置工具（与 server.ts 真实挂载一一对应），
 * buildToolRegistry() 运行时合并 MCP/自定义工具；agentPreset.tools RPC 与 list_tools 都读它；
 * 前端仓库/预设编辑器都从 RPC 投射。加新工具只改本文件 + 真实实现，两处。
 *
 * variant 字段与前端 utils/toolClassifier.ts 的 ToolRowVariant 对齐（对话过程块同款图标），
 * 仓库卡片借此体现"这个工具的过程块长什么样"。
 */

export interface ToolRegistryEntry {
  name: string
  /** 中文名（仓库卡片标题 / 预设勾选显示） */
  label: string
  /** 简短描述（与各工具真实说明对齐） */
  description: string
  /** 仓库内分组标题 */
  group: string
  /** 过程块外观（toolClassifier variant：read/write/edit/delete/bash/search/code/ask/others） */
  variant: string
  /** 仓库 tab 归类：system=系统工具 / special=特殊工具（MCP 工具在插件 tab 按 server 展示，tab 仅作兜底归类） */
  tab: 'system' | 'special'
  /** 来源（registry 合并 MCP/自定义时写入） */
  source?: 'builtin' | 'mcp' | 'custom'
  /** 挂载门槛：不满足则勾选也不会出现在该会话（预设编辑器显示徽标，勾选仅表达"允许"） */
  gating?: 'toolset:install' | 'toolset:preset-admin' | 'toolset:custom-tools' | 'toolset:self-modify' | 'team'
  /** 高危标记（执行弹权限卡）：仓库卡片显示警示 */
  risky?: boolean
  /** MCP 专属：所属 server 名 */
  server?: string
}

/** 兼容旧命名（server.ts 启动自检等） */
export type ToolCatalogEntry = ToolRegistryEntry

/** 全部内置工具（与后端真实挂载点一一对应；server.ts getOrCreateAgent 装配） */
export const TOOL_CATALOG: ToolRegistryEntry[] = [
  // ── 文件（tools.ts buildSessionTools，cwd=会话工作区）──
  { name: 'fs_read', label: '读取文件', description: '读取工作区文件内容（可截断；支持 startLine/endLine 分段读）', group: '文件', variant: 'read', tab: 'system' },
  { name: 'list_dir', label: '列目录', description: '列出目录内容（文件/子目录+大小，毫秒级）——看结构用它，别 run_command dir', group: '文件', variant: 'read', tab: 'system' },
  { name: 'history', label: '文件时光机', description: '改动历史/回滚/统计：list 查历史（拿 change_id）· restore 回滚（只认本会话，可 dry_run）· stat 摸底', group: '文件', variant: 'others', tab: 'system' },
  { name: 'schedule', label: '定时任务', description: '定时任务：create 建（once/hourly/daily/weekly/monthly）· list 查 · update 改/停启用 · remove 删 · run_now 立跑', group: '定时任务', variant: 'others', tab: 'system', risky: true },
  { name: 'git', label: 'git', description: '版本管理：status 状态 · diff 对比（大 diff 自动裁剪成摘要）· log 历史 · commit 提交（弹确认）', group: '命令', variant: 'bash', tab: 'system', risky: true },
  { name: 'repo', label: '仓库地图', description: '仓库导航：map 结构概览 · search 按符号/概念找代码位置 · build 重建索引（与 fs_grep 互补）', group: '文件', variant: 'search', tab: 'system' },
  { name: 'fs_grep', label: '搜索文件内容', description: '按关键词/正则搜索工作区文件内容（返回 文件:行号 + 上下文），查代码引用/配置项时用它，别再拼 findstr', group: '文件', variant: 'search', tab: 'system' },
  { name: 'fs_write', label: '写入文件', description: '写入/新建文件（含多模态图片写入）', group: '文件', variant: 'write', tab: 'system', risky: true },
  { name: 'fs_edit', label: '精确替换', description: '按锚点精确替换文件片段（old_string 必须原样且默认唯一；改大文件比 fs_write 整文件覆盖安全，会回报命中行号）', group: '文件', variant: 'edit', tab: 'system', risky: true },
  { name: 'fs_delete', label: '删除文件', description: '删除文件或目录', group: '文件', variant: 'delete', tab: 'system', risky: true },
  // ── 命令（tools.ts buildCmdTool）──
  { name: 'run_command', label: '执行命令', description: '在会话工作目录执行命令', group: '命令', variant: 'bash', tab: 'system', risky: true },
  // ── 后台任务（tools.ts buildBgTools）—— ★ 0929 刀①：6 个 bg_* 合并成 bg(action=…) ──
  // 0921 接线补：此前只在 tools.ts 里实现，目录/预设白名单都漏登记 → 预设编辑器勾不到、AI 会话里也调不到
  //（server.ts 的严格白名单过滤会把未声明的工具全部裁掉）。本文件是「工具唯一事实源」，必须登记在这里，
  //  并同步前端 toolIcons.ts / toolClassifier.ts（跑 backend/_toolwiring_check.mjs 可一键核对）。
  { name: 'bg', label: '后台任务', description: '后台任务工具箱：action=start 挂后台执行（command 或 url 下载）/ list 列任务 / read 读输出 / stop 停止 / note 报进度 / watch 约回访', group: '后台任务', variant: 'bash', tab: 'system', risky: true },

  // ── 交互 ──
  { name: 'ask_user', label: '询问用户', description: '向用户提问并等待回答（确认/澄清）', group: '交互', variant: 'ask', tab: 'system' },
  { name: 'load_tools', label: '加载能力包', description: '低频能力包按需加载（浏览器等）：说明书不常驻省上下文，要用时展开后照调', group: '交互', variant: 'others', tab: 'system' },
  { name: 'plan_write', label: '任务计划', description: '写/更新任务计划（输入框上方计划卡展示，完成划勾）', group: '交互', variant: 'write', tab: 'system' },
  { name: 'settings_update', label: '更新设置', description: '更新全局设置（名字/性格提示词等）', group: '交互', variant: 'edit', tab: 'system', risky: true },
  // ── 记忆 + 知识库 + 便签（★ 0929 刀①：memory_*/knowledge_* 7 个 → memory+knowledge 两个家族；notebook_* 4 个 → notebook ──
  { name: 'memory', label: '记忆', description: '记忆工具箱：action=search 检索 / store 写入（归 category）/ delete 删除 / distill 蒸馏整理', group: '记忆', variant: 'search', tab: 'special' },
  { name: 'knowledge', label: '知识库', description: '知识库工具箱：action=query 查询（附现有分类）/ add 添加（先判断 entry_type 与分类）/ delete 删除', group: '知识库', variant: 'search', tab: 'special' },
  { name: 'notebook', label: '便签', description: '便签工具箱：action=list 读（接活前先看）/ add 记一条（先查重）/ update 改状态详情 / delete 删条目', group: '便签', variant: 'write', tab: 'special' },
  // ── 联网（webTools.ts）──
  { name: 'web_search', label: '网页搜索', description: '联网搜索', group: '联网', variant: 'search', tab: 'system' },
  { name: 'web_fetch', label: '网页抓取', description: '抓取网页内容', group: '联网', variant: 'read', tab: 'system' },
  { name: 'github_search', label: 'GitHub 搜索', description: 'GitHub 代码/仓库搜索', group: '联网', variant: 'search', tab: 'system' },
  // ── 技能 ──
  { name: 'use_skill', label: '使用技能', description: '加载已安装技能（SKILL.md）的完整指令', group: '技能', variant: 'others', tab: 'system' },
  // ── 团队（绑团队会话且主预设=团队指挥官时自动挂载；预设勾选不生效）──
  { name: 'team_dispatch', label: '派发任务', description: '派发任务单给团队成员（数组+deps 依赖硬校验，同步等成员完成返回产出；打回≤2）', group: '团队', variant: 'others', tab: 'system', gating: 'team' },
  /* ★ 0925v（需求的"分身"功能）：非团队模式派 1~3 个自己并行干活（气泡/过程回放与团队成员同款）
   * ★ 0925x（用户定）：派分身必弹权限申请 —— 批准后分身内部免审畅通（分身工具箱已圈安全区） */
  { name: 'spawn_clone', label: '派出分身', description: '派出 1~3 个自己的分身并行执行子任务（同步等待完成后返回产出摘要）', group: '团队', variant: 'others', tab: 'system', risky: true },
  { name: 'bb_goal', label: '写黑板目标', description: '写黑板：目标+计划步骤（owner/deps），同步用户计划卡', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'bb_write', label: '写黑板', description: '写黑板：审核 done/打回 rejected（带 feedback）、发现、最终汇总', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'bb_read', label: '读黑板', description: '读黑板快照（目标/计划进度/发现/汇总）', group: '团队', variant: 'read', tab: 'system', gating: 'team' },
  { name: 'team_info', label: '读团队信息', description: '读团队成员清单（id/职责/工具/模型）与运行模式', group: '团队', variant: 'read', tab: 'system', gating: 'team' },
  { name: 'project_note', label: '写项目档案', description: '维护工作区根的项目档案（NIS-notes.md）：项目约定/当前进度/决策记录/产物清单——让同项目的其他窗口了解项目背景与进度', group: '交互', variant: 'write', tab: 'system' },  // ★1010-E（已定案）：从「记忆」组挪到「交互」——"记忆"留给记忆库（memory），消除系统/特殊两个 tab 都出现"记忆"分组的疑惑
  { name: 'sub_plan', label: '成员自列执行计划', description: '团队成员自列子任务清单（3~12 条），逐条推进并更新完成状态（只进自己的执行气泡，不动会话计划卡）', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  // ── 安装助手（toolsets: install 会话才有）──
  { name: 'install_skill', label: '安装技能', description: '安装技能包（git URL/本地目录 → backend/skills，含查重）', group: '特殊工具', variant: 'bash', tab: 'special', gating: 'toolset:install' },
  { name: 'uninstall_skill', label: '卸载技能', description: '卸载已安装的技能', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:install' },
  { name: 'scan_skill', label: '扫描技能', description: '对技能目录做安全扫描（PASS/WARN/FAIL）', group: '特殊工具', variant: 'search', tab: 'special', gating: 'toolset:install' },
  { name: 'list_installed', label: '已安装清单', description: '列出已安装技能与安装记录', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:install' },
  { name: 'install_mcp', label: '安装 MCP', description: '安装并连接 MCP 服务（写配置+启动，工具即刻对 agent 生效）', group: '特殊工具', variant: 'bash', tab: 'special', gating: 'toolset:install' },
  { name: 'uninstall_mcp', label: '卸载 MCP', description: '卸载 MCP 服务（断开连接并删除配置）', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:install' },
  // ── 预设管理（toolsets: preset-admin，创造模式专属）──
  { name: 'list_tools', label: '列出工具', description: '列出系统全部可用工具（预设创作用）', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:preset-admin' },
  { name: 'read_preset', label: '读预设', description: '读取 Agent 预设完整内容', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:preset-admin' },
  { name: 'save_preset', label: '保存预设', description: '保存 Agent 预设（校验+运行时自检+落盘）', group: '特殊工具', variant: 'write', tab: 'special', gating: 'toolset:preset-admin' },
  { name: 'delete_preset', label: '删除预设', description: '删除自定义 Agent 预设', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:preset-admin' },
  // ── 自定义工具管理（toolsets: custom-tools，创造模式专属）──
  { name: 'list_custom_tools', label: '列自定义工具', description: '列出全部自定义工具（高风险工具清单）', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:custom-tools' },
  { name: 'save_custom_tool', label: '建自定义工具', description: '创建/更新自定义工具（高风险：执行必弹权限卡）', group: '特殊工具', variant: 'write', tab: 'special', gating: 'toolset:custom-tools' },
  { name: 'delete_custom_tool', label: '删自定义工具', description: '删除自定义工具', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:custom-tools' },
  // ── 项目自我修改（toolsets: self-modify，创造模式专属）──
  // 0904 修正：旧目录里 project_read/project_write/project_delete/project_run 四条是假名（AI 照之调用必失败），
  // 真实挂载名如下（server.ts 'project_' + buildSessionTools 派生，run_command→project_run_command）。
  { name: 'project_fs_read', label: '项目·读文件', description: '读取 NIS 项目源码文件（前后端）', group: '项目自我修改', variant: 'read', tab: 'special', gating: 'toolset:self-modify' },
  // 0913 二次审计补：buildSessionTools 的每个工具都会自动生成 project_ 孪生（server.ts 'project_' + name 映射），
  // 此前漏了 grep/edit 两个孪生 → 升级模式用到它们时图标/分类/审批都不对（详见 docs/工具开发接入清单.md §七）
  { name: 'project_fs_grep', label: '项目·搜索内容', description: '在 NIS 项目源码里搜索文件内容（只读）', group: '项目自我修改', variant: 'search', tab: 'special', gating: 'toolset:self-modify' },
  { name: 'project_fs_write', label: '项目·写文件', description: '写入/修改 NIS 项目源码（后端 .ts 需重启生效）', group: '项目自我修改', variant: 'write', tab: 'special', gating: 'toolset:self-modify', risky: true },
  { name: 'project_fs_edit', label: '项目·精确替换', description: '对 NIS 项目源码做精确片段替换（old_string → new_string，含唯一性校验）', group: '项目自我修改', variant: 'edit', tab: 'special', gating: 'toolset:self-modify', risky: true },
  { name: 'project_fs_delete', label: '项目·删文件', description: '删除 NIS 项目源码文件', group: '项目自我修改', variant: 'delete', tab: 'special', gating: 'toolset:self-modify', risky: true },
  // ★ 0924：旧描述写的是「如重启后端/装依赖」—— 等于在教 AI 自杀。AI 照做时链路是
  // 后端(node) → cmd.exe → 脚本，那条"重启"命令杀掉的正是承载它的宿主后端：工具调用永不返回、
  // 会话直接中断，脚本作为孤儿跑完再拉起新后端 ⇒ 用户看到的就是「后端起来一会儿又断 + AI 突然不回话」。
  { name: 'project_run_command', label: '项目·执行命令', description: '在项目根目录执行命令（装依赖/跑测试/构建等）。⚠️ 禁止用它重启或停止后端：那会杀掉正在承载本条命令的后端自身，命令永远不返回、会话直接中断；后端代码改完请让用户到「NIS 后端控制台」点「重启后端」。', group: '项目自我修改', variant: 'bash', tab: 'special', gating: 'toolset:self-modify', risky: true },
]

/**
 * 唯一源出口：静态内置 + MCP 实时 + 自定义工具实时。
 * mcp/custom 条目由 server.ts 传入（本文件不 import mcpRuntime/customTools，避免依赖环）。
 */
export function buildToolRegistry(opts: {
  mcpTools: Array<{ name: string; label: string; description: string; server: string }>
  customTools: Array<{ name: string; label: string; description: string }>
}): ToolRegistryEntry[] {
  const builtin: ToolRegistryEntry[] = TOOL_CATALOG.map(t => ({ ...t, source: 'builtin' as const }))
  const mcp: ToolRegistryEntry[] = opts.mcpTools.map(t => ({
    name: t.name,
    label: t.label || t.name,
    description: t.description,
    // 0904 反馈②：MCP 工具归组「MCP 工具」，前端仓库从 MCP tab 投射分组，不进系统/特殊清单
    group: 'MCP 工具',
    // variant 与前端 classifyTool(mcp__) 对齐=线性搜索图标同款族
    variant: 'search',
    tab: 'system' as const,
    source: 'mcp' as const,
    server: t.server,
  }))
  const custom: ToolRegistryEntry[] = opts.customTools.map(t => ({
    name: t.name,
    label: t.label || t.name,
    description: t.description,
    group: '自定义工具',
    variant: 'others',
    tab: 'special' as const,
    source: 'custom' as const,
    risky: true, // 自定义工具每次执行必弹权限卡（既有行为）
  }))
  return [...builtin, ...mcp, ...custom]
}


