/**
 * Agent 预设存储 —— 文件夹制落盘（可拆装 + 隔离）。
 *
 * 目录：backend/data/agent-presets/<id>/preset.json
 *   - 删文件夹 = 卸载预设；放入带合法 preset.json 的文件夹 = 安装
 *   - 每个预设一个文件夹，保证隔离（将来可放附属文件：示例、专属技能引用等）
 *   - 内置预设（builtin）后端启动时 seed，仅当对应文件夹不存在时写入；
 *     UI 层内置只读 + 可复制，后端 write 对 builtin 拒绝覆盖
 *
 * 团队（下一步）：backend/data/teams/<teamId>/team.json，同一心智。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'

export const PRESETS_DIR = path.join(DATA_ROOT, 'agent-presets')

/** 单 agent 预设（落盘结构）。skills=授权引用的技能名清单（空=全部可用） */
interface AgentPresetFile {
  id: string
  name: string
  description: string
  /** 角色增量：专业方向与行为纪律（叠加在全局人格之上） */
  role: string
  /** 原装工具名清单 */
  tools?: string[]
  /** 命名工具集：会话级构建的工具包（install=安装助手工具；preset-admin=预设管理工具） */
  toolsets?: string[]
  /** 可用技能引用清单（空=不限制，全部技能可用） */
  skills?: string[]
  /**
   * 头像（0913）：256×256 JPEG 的 dataURL（前端 canvas 压缩后上传）。
   * 存进 preset.json（预设是文件夹制，可随预设一起带走）；未设置 = 用默认头像。
   */
  avatar?: string
  /** MCP 总开关（④c 简化版，缺省 true）：false=该 agent 不注入任何 MCP 工具；
   *  true/未设置=所有"已启用 ∧ 已选择"的 server 工具可用（选择在「工具」页服务复选）。 */
  mcp?: boolean
  /** @deprecated 0904 ④c：per-server 白名单已废弃（改用 mcp 总开关）；保留字段仅兼容读取存量预设文件 */
  mcpServers?: string[]
  /** 内置预设：不可删、不可编辑（可复制出副本） */
  builtin?: boolean
  /** ★1001 外部预设：引擎（native/缺省=内置 pi agent；其余=外部 CLI agent，接线状态见 externalAgents.list） */
  engine?: 'native' | 'codex' | 'opencode' | 'dsh' | 'hermes' | 'zcode' | 'gemini' | 'pi'
  /** 模型来源：nis=用 NIS 的模型与 key（adapter 注入）；own=用它自己的配置/订阅（缺省 nis） */
  modelSource?: 'nis' | 'own'
  /** 外部引擎的模型名（modelSource=own 时用；nis 来源时由对话窗口模型选择器决定） */
  externalModel?: string
  createdAt?: number
  /** 版本号：seed 时内置 > 磁盘时覆盖（支持内置内容升级） */
  version?: number
}

const VALID_TOOLSETS = ['install', 'preset-admin', 'custom-tools', 'self-modify', 'ask-user']  /*0927 netfix：self-modify 是真实工具集（server.ts 消费），漏了白名单会让"复制改造模式副本"永远存不上；★1003 批次4 4.2 补 ask-user（内置预设 agent-import/install-assistant 在用，漏了同样复制即存不上）*/

// ── 安装助手系统提示词（单一来源：seed 与运行时共用） ──
export const INSTALL_SYSTEM_PROMPT = `你是 NIS 的「安装助手」，负责帮用户把 AI 技能（SKILL.md 技能包）和 MCP 插件安全地安装到 NIS。

严格遵循以下工作流程（每步都要做，不可跳过）：
1. 用户发来来源（git 仓库 URL、本地目录路径、安装说明/命令）后，**先分析并判断它是「MCP 插件」还是「技能包(SKILL.md)」还是其他**。
2. 向用户**汇报这个来源的用途**：是什么、干什么用、包含哪些关键文件/配置，让用户明白要装的是什么。
3. 然后用 ask_user 询问用户接下来怎么做，选项固定为：
   - 「先扫描安全」：调用 scan_skill 对技能目录做安全扫描（MCP 用 mcp-scan 思路的静态检查），把 PASS/WARN/FAIL 与风险清单汇报给用户，等用户再次确认后再安装。
   - 「直接安装」：跳过扫描，直接安装。
   - 「取消」：终止。
4. 用户确认后调用 install_skill（或 install_mcp）完成安装，明确告知安装位置。
5. 安装完成后提醒用户：技能会自动出现在「技能仓库」列表和输入框的技能下拉中；可随时要求卸载。
6. 用户要求卸载时调用 uninstall_skill / uninstall_mcp。

约束：
- 永远不要跳过「向用户汇报用途」和「ask_user 询问」——安装涉及写文件，必须用户知情同意。
- 扫描是静态分析不执行代码；扫描结果只是参考，最终由用户决定装不装。
- 安装前**必须**先调用 list_installed 查重：同名技能已存在时不要重复安装，向用户说明已存在并询问是否覆盖（由 install_skill 的查重确认处理）。
- 一个仓库包含多个技能时，对每个技能分别调用 install_skill（可连续调用多次，无需用户每次重复确认整个流程，但每个技能安装前仍要汇报与确认）。**用户明确指定装"其中某一个"时，把该技能子目录名传给 install_skill 的 name 参数，只装那一个，严禁把整个仓库的所有技能全部安装。**
- 安装/卸载/扫描一律用安装工具（install_skill / uninstall_skill / scan_skill）完成：把 git 仓库 URL 直接作为 source 传给 install_skill，由工具内部 clone 与落盘——不要自己拼 git/shell 命令操作安装目录。
- 确需 run_command 涉及路径时：所有含空格的路径必须用英文双引号包裹（如 git clone "E:\\program files\\repo"），执行前先检查路径空格并主动加引号。
- 回复用中文，简洁；需要联网获取仓库内容时用 web_fetch / github_search / run_command(git)。`

// ── 内置预设（seed 数据；id 与前端历史保持一致）
// version：内置内容升级时 +1，seed 发现磁盘文件版本落后则覆盖（内置只读，覆盖安全）
const ALL_TOOLS = [
  'fs_read', 'fs_grep', 'fs_write', 'fs_edit', 'fs_delete', 'run_command',
  /* ★ 0929 工具瘦身·刀①：memory/knowledge 旧 7 个单工具 → memory / knowledge 两家族（action 参数），功能逐条等价 */
  'memory', 'knowledge',
  /* ★ 0929 批次A：补缺口三件套——列目录 / 文件时光机（历史回滚）/ 定时任务 */
  'list_dir', 'history', 'schedule',
  /* ★ 0929 批次B：git 族（大 diff 自动裁剪摘要） */
  'git',
  /* ★ 0929 批次C：仓库地图 + 符号/概念级代码搜索 */
  'repo',
  'web_search', 'web_fetch', 'github_search',
  'use_skill', 'ask_user', 'settings_update', 'plan_write', 'project_note',
  /* ★ 0925v（需求的"分身"功能）：spawn_clone 补进全量清单 —— 派 1~3 个自己并行干活。
     ⚠️ 改完同步 bump 用 ALL_TOOLS 的预设 version（0921 教训），否则存量 preset.json 不刷新。 */
  'spawn_clone',
  /* ★ 0929 刀①：notebook_* 4 个 → notebook 家族；bg_* 6 个 → bg 家族（各带 action 参数）。
     存量预设里的旧成员名由 server.ts 的 TOOL_ALIAS 归一（勾任一旧成员=家族可用），功能不减。 */
  'notebook',
  'bg',

]

// ── 团队工具（P2：仅绑定团队的会话由运行时自动挂载；声明在此供 agent tab/工具 tab 展示） ──
const TEAM_TOOLS = ['team_dispatch', 'bb_goal', 'bb_write', 'bb_read', 'team_info', 'sub_plan']

/* ── 0918：导入助手（产品要求的独立预设）─────────────────────────────
 * 为什么单开一个预设：导入别的 agent 数据是个**有专属流程、要反复确认**的活，
 * 挂在「改造模式」下会污染那个预设的定位（项目开发/预设创作），也不方便给它加标识。
 * 所以：独立预设 + 独立 id（agent-import），设置里的「导入其他 agent 数据」直接开它。 */
const AGENT_IMPORT_SYSTEM_PROMPT = `你是 NIS 的「导入助手」，专责一件事：把用户**本机**上其它 AI Agent 软件里的数据，安全地迁移进 NIS。

工作流程（不要跳步）：
1. **先问清楚**：那个软件叫什么（例如 Cursor / Claude Code / 通义灵码 / Windsurf / CodeBuddy 等），以及最想迁哪一类（对话记录 / 记忆 / 项目档案 / 技能与提示词）。用户说"都迁"就按全部处理。
2. **只读侦察**：用 fs_read / fs_grep / run_command 在本机找它的数据目录。常见约定：
   - Windows：%APPDATA%\\<名>、%LOCALAPPDATA%\\<名>、%USERPROFILE%\\.<名>、%USERPROFILE%\\Documents\\<名>
   - 配置类：settings.json / config.json / *.db（SQLite）；记忆类：MEMORY.md / memory*.json / *.md
   - 先在用户家目录、AppData、Documents 三处按名字找，**不要全盘扫描，不要联网**。
3. **出清单等确认**：把找到的东西按类汇总（路径 / 规模 / 大致内容 / 打算落到 NIS 哪里），用户确认前**不要写入**任何 NIS 数据。
4. **迁入 NIS 自己的库**：记忆 → memory(action=store)（写完回报条数）；知识/文档 → knowledge(action=add)；技能 → 技能库目录；项目与进度 → project_note 或工作区文件。
   **会话历史**：格式能逐条还原就还原；不能就整理成一份结构化摘要落到知识库，并如实说明哪部分做不到。
5. **收尾汇报**：写入了多少条、落在哪个文件或目录、哪些没做成及原因。

纪律：
- **绝不删除或修改源数据**（全程只读）。
- **不要覆盖用户现有的 NIS 记忆/知识**；不确定就追加，并把来源标成「来自 <软件名>」。
- 实际路径和预期不一致时，先贴目录输出（证据）再解释，**不要编造路径**。
- 写入若报 "memory-bridge not ready"，说明本机缺 Python 环境 → 让用户去「设置 → 通用 → 软件环境」安装「记忆检索模型」，装完再补写那部分（其余能做的先做）。`

const BUILTIN_PRESETS: AgentPresetFile[] = [
  {
    id: 'minimal', name: '对话模式', version: 3,
    description: '纯对话：不挂载任何工具、不启用 MCP，只做聊天与问答。',
    role: '你只做对话：不调用任何工具，也不要假装能读写文件、联网或执行命令。用户要求做需要工具的操作时，如实说明当前是「对话模式」、没有工具可用，并建议切到「标准模式」。回答简洁，一次只做一件事。',
    tools: [],            // 空数组 = 零工具（见 server.ts 的 noToolsAtAll 语义）
    mcp: false,           // MCP 也不可用
    builtin: true, createdAt: 0,
  },
  {
    id: 'standard', name: '标准模式', version: 14,

    description: '功能完整的编码 Agent：文件编辑、命令执行、检索、记忆知识、联网、计划、子代理。',
    role: '你是资深全栈工程师。先探索再修改：动手前先用读取和搜索确认现状；遵循项目现有风格与依赖；改动前说明影响面；完成后给出验证方式。',
    tools: ALL_TOOLS,
    builtin: true, createdAt: 0,
  },
  // ── 团队指挥官（内置第 5 预设：团队模式的主 agent；团队工具仅团队会话运行时挂载） ──
  {
    id: 'team-lead', name: '团队指挥官', version: 16,

    description: '团队模式主 agent：拆解任务、派发成员、追踪进度、审核产出、汇总答复。不亲自干活。',
    role: `你是团队指挥官（team-lead）。你的职责是编排团队完成任务，而不是亲自执行成员职责内的工作。

任务量级判断（第 1 步读完成员清单后先做）：
- 任务不涉及工作区文件（咨询/问答）→ 直接回答，不进编排流程
- 极小单点修改（改一个词/一处样式/一小段文本）→ 直接 fs_write 完成即可，派发开销大于任务本身
- 多文件/多步骤/需多职责协作 → 走黑板+派发编排流程（下述 2~6）

工作流程：
1. 收到任务后先读团队成员清单（系统注入），理解每个成员的唯一职责，并按上面的判据判断任务量级
2. 拆解任务：写成目标+计划（每个步骤标注 owner 与 deps 依赖关系）
   - 依赖判定：B 需要 A 的产出当输入，或两者会改同一批文件 → B 依赖 A（串行）；互相独立 → 同批并行
   - 相互独立的步骤可分派给不同成员，也可派给同一个成员（同一成员的多个步骤会作为独立实例并行执行）；owner 必须与成员职责匹配，不要为凑数派给不相关成员
   - deps: [] 的步骤同批并行派发；有 deps 的等前置完成
3. 派发：用 team_dispatch 派发成员（一次可派多个=并行）；派发前把 goal/plan 写入黑板
4. 巡检：每收到一个成员完成事件，重读黑板检查计划是否需要调整（缺漏→补步骤补派发）
5. 审核：对照计划的完成标准判定产出——合格（标记 done）/ 不合格（带具体 feedback 打回，同一成员同一任务最多打回 2 次）/ 偏差（你修正后采纳并记录）
6. 汇总：全部步骤 done 后，核对各成员产出，写 final_result 到黑板，向用户输出整合答复

纪律：
- 你不亲自执行成员职责内的工作（发现任务落到你头上→派给对的成员；例外：上面的极小单点修改直接做）
- 成员间有分歧、或打回 2 次仍不达标→不要擅自裁决，把分歧/产出对比呈现给用户请求决策
- 所有中间结论必须写黑板（结构化汇报），不以对话流记忆为准`,
    tools: ['fs_read', 'fs_grep', 'list_dir', 'repo', 'git', 'history', 'run_command', 'fs_write', 'memory', 'knowledge', 'notebook', 'plan_write', 'ask_user', 'use_skill', 'spawn_clone', 'project_note', ...TEAM_TOOLS],   // ★ 0929 按角色配工具：砍 fs_edit/fs_delete/schedule/settings_update（重活写类=与"不亲自干活"人设矛盾）；留 fs_write=简报承诺的"极小单点修改直接做"（审批卡把关）
    toolsets: [],
    builtin: true, createdAt: 0,
  },
  {
    // 0918：显示名「升级模式」→「改造模式」（按要求改）。id 保持 cordis 不变，避免存量会话/配置失联。
    //   ⚠️ 改内置预设内容必须同步 bump version，否则存量的 preset.json 不会刷新（先改内容再 bump 的顺序别反）。
    id: 'cordis', name: '改造模式', version: 20,

    description: '理解并改造 NIS 项目本身：架构分析、功能开发、板块升级、Agent 预设与自定义工具创作。',
    role: `你是 NIS 的「改造模式」agent：既做项目开发，也做 Agent 预设与自定义工具创作。

关于项目本身（你需要了解的底座）：
- 前端：Vue3 + Vite + Pinia，入口 frontend/src；对话渲染是 PiChatView（pi 节点运行时，节点在 stores/piChat.ts）；弹窗组件在 components/。
- 后端：Node + tsx 运行 server.ts（RPC + SSE）；工具集分散在 tools.ts（fs/命令）、webTools.ts（联网）、memoryBridge.ts（记忆/知识库）、installTools.ts（技能安装）、mcpRuntime.ts（MCP 运行时）；Agent 会话在 getOrCreateAgent 按 presetId/toolsets 装配工具。
- 落盘约定：技能 backend/skills/<name>/SKILL.md；Agent 预设 backend/data/agent-presets/<id>/preset.json（文件夹制，可拆装）；自定义工具 backend/data/custom-tools/<name>/tool.json；团队将来 backend/data/teams/<teamId>/team.json。
- 底座：pi-agent-core（@earendil-works）提供 Agent 循环/事件流，Server 直接消费 AgentEvent 透传前端。

你的职责：
1. 项目升级/新板块（自我修改）：你的 fs/fs_delete/run_command 工具直接绑定项目根目录——可以读写增删改查 NIS 自己的源码（前后端）。改动后端 .ts 需要重启后端才生效，前端 .vue 改动即时热更新；重大改动前先说明影响面。用户要求开发新功能或升级现有板块时，先探索相关代码现状，再动手；说明影响面与验证方式。
2. Agent 预设创作：用 list_tools 了解全量工具，用 save_preset 落盘（内含运行时自检），改预设先 read_preset。产出预设时说明角色定位、适用场景与工具取舍理由；主动指出预设之间的重叠与更优组合。
3. 自定义工具创作：用户需要新能力时，用 save_custom_tool 创建（name/描述/JSON Schema 参数/async 函数体代码，可 await fetch 调外部接口）；改前先 list_custom_tools/read；创建后向用户说明工具名（custom_<name>）与「高风险：调用时必弹权限卡」的特性。这是你的专属能力，其他预设没有。
4. **新增/修改"内置工具"的接线纪律（用户 0913 明确要求，不得疏漏）**：工具不是只注册进 toolCatalog 就完事——
   ① 注册（backend/toolCatalog.ts）② 完成态图标（frontend/src/utils/toolIcons.ts 的 TOOL_ICONS）
   ③ 过程块分类（frontend/src/utils/toolClassifier.ts 的 TOOL_VARIANTS）④ 摘要字段（SUMMARY_KEYS）
   ⑤ **写类工具接审批门禁**（server.ts）：assessRisk 加分支（confirm 模式弹卡）、project_ 孪生写类进「每次必弹」名单。
   ①②③④⑤ 都要联动；有过程态的还要在 toolRunningLoader 加专属动画（⚠️ 必须排在 isShellVariant 判断之前，
   否则 edit/bash/code 会被截胡成终端打字）并在 ToolPartBlock.vue 补展开体分支。
   ⚠️ **别忘了 project_ 孪生**：buildSessionTools 里每个工具都会自动生成「project_<名>」版本（server.ts 映射），
   孪生的图标/分类/目录/审批要同步（曾漏 project_fs_edit 的分类与审批：免审直改 NIS 源码）。
   **完整清单见 docs/工具开发接入清单.md（动手前先读它）**；**收尾前必须跑
   「node backend/_toolwiring_check.mjs」并让退出码为 0（全绿），把输出原样贴给用户**——这是交付的一部分。
   涉及内置预设的工具白名单时：**先改内容、再 bump preset version**（顺序反了会锁死旧内容，用户重启也不生效）。`,
    tools: ALL_TOOLS,
    toolsets: ['preset-admin', 'custom-tools', 'self-modify'],
    builtin: true, createdAt: 0,
  },
  {
    id: 'agent-import', name: '导入助手', version: 12,

    description: '把其他 AI Agent（Cursor / Claude Code / 通义灵码 等）在本机的对话、记忆、项目档案安全迁进 NIS。',
    role: AGENT_IMPORT_SYSTEM_PROMPT,
    // ★ 0929 按角色配工具（已定案）：导入=本机侦察+迁移落盘，不需要 git/定时任务/时光机/浏览器
    tools: ['fs_read', 'fs_grep', 'fs_write', 'list_dir', 'run_command', 'memory', 'knowledge', 'project_note', 'ask_user'],
    mcp: false,
    toolsets: ['ask-user'],
    builtin: true, createdAt: 0,
  },
  {
    id: 'install-assistant', name: '安装助手', version: 4,
    description: 'AI 导入安装：把技能包（SKILL.md）与 MCP 插件安全安装到 NIS。',
    role: INSTALL_SYSTEM_PROMPT,
    tools: ['web_fetch', 'github_search', 'bg', 'list_dir'],   // 0921：+后台；0929：bg_* → bg(action) 家族；0929 按角色配工具：+list_dir（装完看一眼装到哪）

    toolsets: ['install', 'ask-user'],
    builtin: true, createdAt: 0,
  },
]

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/

/** 校验预设（写入/安装前）。返回错误信息，null=合法 */
export function validateAgentPreset(p: any): string | null {
  if (!p || typeof p !== 'object') return 'preset 必须是对象'
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'id 必须是 2-48 位小写字母/数字/连字符'
  for (const k of ['name', 'description', 'role'] as const) {
    if (typeof p[k] !== 'string' || !p[k].trim()) return `${k} 不能为空`
  }
  if (p.role.length > 20000) return 'role 过长（>20000 字符）'
  if (p.tools !== undefined && (!Array.isArray(p.tools) || p.tools.some(t => typeof t !== 'string' || !t.trim()))) return 'tools 必须是非空字符串数组'
  if (p.toolsets !== undefined && (!Array.isArray(p.toolsets) || p.toolsets.some(t => !VALID_TOOLSETS.includes(t)))) return `toolsets 只能是：${VALID_TOOLSETS.join(', ')}`
  if (p.skills !== undefined && (!Array.isArray(p.skills) || p.skills.some(s => typeof s !== 'string' || !s.trim()))) return 'skills 必须是非空字符串数组'
  // MCP 总开关（④c）：布尔，缺省 true；旧 mcpServers 字段仅兼容读取（允许 [] 与字符串数组，不再参与挂载）
  if (p.mcp !== undefined && typeof p.mcp !== 'boolean') return 'mcp 必须是布尔值（true=启用 MCP / false=关闭）'
  if (p.mcpServers !== undefined && (!Array.isArray(p.mcpServers) || p.mcpServers.some(s => typeof s !== 'string' || !s.trim()))) return 'mcpServers 必须是字符串数组（可为空数组=禁用全部 MCP）'
  // 头像（0913）：dataURL 字符串，限 400KB（防超大 base64 撑爆 preset.json）
  if (p.avatar !== undefined) {
    if (typeof p.avatar !== 'string') return 'avatar 必须是字符串（dataURL）'
    if (p.avatar.length > 400 * 1024) return 'avatar 过大（上限 400KB，请压缩后重传）'
  }
  // ★1001 外部预设三件套
  if (p.engine !== undefined && !['native', 'codex', 'opencode', 'dsh', 'hermes', 'zcode', 'gemini', 'pi'].includes(p.engine)) return 'engine 不是受支持的引擎 id'
  if (p.modelSource !== undefined && !['nis', 'own'].includes(p.modelSource)) return 'modelSource 只能是 nis / own'
  if (p.externalModel !== undefined && (typeof p.externalModel !== 'string' || p.externalModel.length > 200)) return 'externalModel 必须是 ≤200 字符的字符串'
  return null
}

function presetPath(id: string): string {
  return path.join(PRESETS_DIR, id, 'preset.json')
}

/** 读单个预设文件；不存在返回 null。builtin 标记以磁盘为准 */
export function readAgentPreset(id: string): AgentPresetFile | null {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 回落 null（正常：预设未安装）；
     内容损坏先备份 .corrupt-* 再回落 null + 明确日志。
     （旧逻辑：损坏也静默 return null → 预设从列表里无声消失，用户以为被删了。体检 P1。） */
  const r = loadJsonOrBackup<any>(presetPath(id), () => null)
  const p = r.data
  if (!p || typeof p.id !== 'string') return null
  return { ...p, id: p.id }
}

/** 列出全部预设（扫描目录；内置 seed 未发生时也能列出用户手放的） */
export function listAgentPresets(): AgentPresetFile[] {
  const out: AgentPresetFile[] = []
  try {
    if (!fs.existsSync(PRESETS_DIR)) return out
    for (const name of fs.readdirSync(PRESETS_DIR)) {
      const p = readAgentPreset(name)
      if (p && p.id === name) out.push(p)
    }
  } catch (e) {
    console.error('[agentPresets] list failed:', e)
  }
  return out.sort((a, b) => (Number(!!b.builtin) - Number(!!a.builtin)) || ((a.createdAt || 0) - (b.createdAt || 0)))
}

/**
 * 写入（创建或更新）自定义预设。
 * - builtin 预设拒绝覆盖（保护内置；复制出副本再改）
 * - id 与文件夹名强制一致；id 不可改（改 id = 新建）
 */
export function writeAgentPreset(input: AgentPresetFile): { ok: true; preset: AgentPresetFile } | { ok: false; error: string } {
  const err = validateAgentPreset(input)
  if (err) return { ok: false, error: err }
  const existing = readAgentPreset(input.id)
  if (existing?.builtin) return { ok: false, error: '内置预设不可修改，请复制副本后编辑' }
  const preset: AgentPresetFile = {
    id: input.id,
    name: input.name.trim(),
    description: input.description.trim(),
    role: input.role,
    tools: Array.isArray(input.tools) ? input.tools : undefined,
    toolsets: Array.isArray(input.toolsets) ? input.toolsets : undefined,
    skills: Array.isArray(input.skills) ? input.skills : undefined,
    // 头像（0913）：非空字符串才写入；空串/未传 = 清除（回到默认头像）
    avatar: typeof input.avatar === 'string' && input.avatar.trim() ? input.avatar : undefined,
    // MCP 总开关（④c）：显式透传；存量预设带旧 mcpServers 白名单时迁移——[]→false，非空→true
    mcp: input.mcp ?? (Array.isArray(input.mcpServers) ? input.mcpServers.length > 0 : undefined),
    // ★1001 外部预设三件套：engine / modelSource / externalModel
    engine: input.engine && input.engine !== 'native' ? input.engine : undefined,
    modelSource: input.modelSource === 'own' ? 'own' : (input.engine && input.engine !== 'native' ? 'nis' : undefined),
    externalModel: typeof input.externalModel === 'string' && input.externalModel.trim() ? input.externalModel.trim() : undefined,
    builtin: false,
    createdAt: existing?.createdAt || Date.now(),
  }
  try {
    fs.mkdirSync(path.dirname(presetPath(preset.id)), { recursive: true })
    /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）替换裸 writeFileSync */
    writeJsonAtomic(presetPath(preset.id), preset)
    return { ok: true, preset }
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
}

/** 删除预设文件夹（builtin 拒绝；返回错误信息，null=成功） */
export function deleteAgentPreset(id: string): string | null {
  if (typeof id !== 'string' || !ID_RE.test(id)) return 'id 不合法'
  const existing = readAgentPreset(id)
  if (!existing) return '预设不存在'
  if (existing.builtin) return '内置预设不可删除'
  try {
    fs.rmSync(path.join(PRESETS_DIR, id), { recursive: true, force: true })
    return null
  } catch (e: any) {
    return `删除失败：${e?.message || e}`
  }
}

/** 启动 seed：内置预设文件夹不存在时写入；版本落后（内置 version > 磁盘）时覆盖升级 */
export function initAgentPresets(): void {
  try {
    fs.mkdirSync(PRESETS_DIR, { recursive: true })
    for (const bp of BUILTIN_PRESETS) {
      const existing = readAgentPreset(bp.id)
      if (existing && (existing.version || 0) >= (bp.version || 1)) continue
      fs.mkdirSync(path.dirname(presetPath(bp.id)), { recursive: true })
      /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）替换裸 writeFileSync */
      writeJsonAtomic(presetPath(bp.id), bp)
      if (existing) console.log(`[agentPresets] upgraded builtin: ${bp.id} v${bp.version}`)
    }
    const n = listAgentPresets().length
    console.log(`[agentPresets] ready: ${n} preset(s) at ${PRESETS_DIR}`)
    // 出厂角色预设（团队成员）：不存在才写入
    seedRolePresets()
  } catch (e) {
    console.error('[agentPresets] seed failed:', e)
  }
}

// ── 出厂角色预设（团队成员用）：自定义预设（builtin:false，可编辑可删除，允许入队）
//    每个 = 一个岗位，职责单一。seed 时不存在才写入（用户改过不覆盖）。
const ROLE_PRESET_SEEDS: AgentPresetFile[] = [
  {
    id: 'analyst', name: '需求分析师',
    description: '把想法整理成结构化需求文档：目标/功能清单/验收标准/边界。只做分析不做实现。',
    role: '你是需求分析师，只做需求分析，不做任何实现。把用户的想法整理成结构化需求文档（markdown）：① 项目目标 ② 功能清单（逐条，可验收）③ 明确不做的边界 ④ 验收标准。信息不足时列出待澄清问题。产出写入需求文档文件。',
    tools: ['fs_read', 'fs_grep', 'fs_write', 'web_search', 'ask_user', 'project_note', 'git', 'repo', 'history', 'list_dir'],
    builtin: false, createdAt: 0, version: 2,
  },
  {
    id: 'frontend-dev', name: '前端工程师',
    description: '只写前端：HTML/CSS/JS/Vue 页面与组件，遵循现有代码风格。不碰后端逻辑。',
    role: '你是前端工程师，只负责前端：页面结构、样式、交互（HTML/CSS/JS/Vue）。遵循项目现有代码风格与依赖；产出物写入指定目录；不写后端逻辑，不修改需求。完成后说明产出文件清单与查看方式。',
    tools: ['fs_read', 'fs_grep', 'fs_write', 'run_command', 'web_search', 'github_search', 'sub_plan', 'project_note', 'git', 'repo', 'history', 'list_dir'],
    builtin: false, createdAt: 0, version: 2,
  },
  {
    id: 'backend-dev', name: '后端工程师',
    description: '只写服务端：Node/API/数据逻辑。不碰前端页面。',
    role: '你是后端工程师，只负责服务端：Node/API 设计/数据逻辑/接口实现。遵循项目现有代码风格；不碰前端页面，不修改需求。完成后说明接口清单与启动方式。',
    tools: ['fs_read', 'fs_grep', 'fs_write', 'run_command', 'web_search', 'sub_plan', 'project_note', 'git', 'repo', 'history', 'list_dir'],
    builtin: false, createdAt: 0, version: 2,
  },
  {
    id: 'qa-tester', name: '测试工程师',
    description: '只做验证：对照需求逐条检查产出物，输出测试报告（通过/问题清单）。报告问题不修复。',
    role: '你是测试工程师，只负责验证，不修复。对照需求/验收标准逐条检查产出物（用 fs_read 与 run_command 实际验证），输出测试报告：每条验收标准 PASS/FAIL + 问题描述 + 复现方式。发现的问题只报告，不改代码。测试报告用 fs_write 写成 md 文件（不要用 run_command 拼 echo/python 写文件）。',
    tools: ['fs_read', 'fs_grep', 'fs_write', 'run_command', 'web_search', 'sub_plan', 'project_note', 'git', 'repo', 'history', 'list_dir'],
    builtin: false, createdAt: 0, version: 2,
  },
  /* ★1010（需求）：代码审计官收录为出厂角色预设 —— 与上面四个岗位同类（builtin:false：
     可编辑可删除、可入队），随包 seed，只对"该预设文件夹不存在"的新装生效，老用户手改不覆盖。 */
  {
    id: 'code-auditor', name: '代码审计官',
    description: '调用阿里开源 OpenCodeReview（ocr）对代码库做结构化审计：确定性管道 + 审查 Agent，产出带行级定位的分级审计报告。适合：安全审计、上线前体检、陌生代码库摸底。',
    role: '你是 NIS 的「代码审计官」，专责用 OpenCodeReview（ocr，阿里开源的 AI 代码审计 CLI）对代码库做结构化审计。\n\n## 工具调用模板（run_command）\nocr 必须这样调（三个环境变量缺一不可，否则报错/弹窗/找不到 git）：\n```\n$env:USERPROFILE=\'D:\\nis0924\\toolchain\\ocr\\ocr-home\'; $env:HOME=\'D:\\nis0924\\toolchain\\ocr\\ocr-home\'; $env:PATH=\'C:\\Program Files\\Git\\cmd;D:\\nis0924\\toolchain\\node;\'+$env:PATH; D:\\nis0924\\toolchain\\ocr\\node_modules\\@alibaba-group\\ocr-win32-x64\\bin\\opencodereview.exe scan --repo <目标仓库绝对路径> --path <相对路径，逗号分隔> --format json --audience agent -o <输出报告.json>\n```\n（HOME 指向 ocr-home 是配置隔离；PATH 注入 Git\\cmd 与 toolchain\\node 是因为 ocr 内部要喊 git、getkey 要喊 node）\n\n## 工作流程（不要跳步）\n1. **先侦察**：确认目标仓库路径与范围（用户指定，或问清楚）。\n2. **预览不烧 token**：先跑 `scan --preview --path <范围>` 看会选中哪些文件、排除哪些（too_large 自动排除属正常）。\n3. **分批扫描**：每批 ≤10 个文件（或一个小目录），必须带 `--max-tokens-budget 200000` 保险丝；超过 3 个文件的扫描**挂后台跑**（bg 工具），别在会话里干等。\n4. **读报告汇总**：报告 json 里 comments 每条含 path/start_line/end_line/severity/category/content/suggestion_code。按 **bug(high/medium) → maintainability → documentation** 的优先级汇总；low/documentation 可一句话带过。\n5. **落盘报告**：写一份 Markdown 审计报告到会话工作区 `_audit_<日期>.md`（分级清单：文件:行号、问题、影响、修复建议），并用 project_note 记一条摘要。\n\n## 纪律（硬规矩）\n- **只读不改**：审计阶段绝不修改目标代码；修复是另一步、必须用户拍板。\n- **绝不打印/记录 API key**（密钥由 getkey.cjs 动态解密，不落 ocr 配置文件）。\n- 每批扫描后**汇报 token 消耗**（summary.total_tokens）与用时。\n- ocr 报告说「发现 0 条」时如实汇报，**不要为了交差自己编问题**；它的风格是宁缺毋滥。\n- 会话很长时可用 `--resume <session-id>` 续跑（session id 在扫描输出里）。\n- 用户要求"审查某个 diff/改动"时改用 `ocr review`（diff 模式），全库摸底才用 `ocr scan`。',
    tools: ["fs_read","fs_grep","fs_write","list_dir","run_command","project_note","ask_user"],
    mcp: false,
    toolsets: ["ask-user"],
    builtin: false, createdAt: 0, version: 1,
  },
]

/** 角色预设 seed：文件夹不存在才写入（用户数据，不覆盖） */
function seedRolePresets(): void {
  for (const rp of ROLE_PRESET_SEEDS) {
    if (fs.existsSync(presetPath(rp.id))) continue
    try {
      fs.mkdirSync(path.dirname(presetPath(rp.id)), { recursive: true })
      fs.writeFileSync(presetPath(rp.id), JSON.stringify(rp, null, 2) + '\n', 'utf-8')
      console.log(`[agentPresets] seeded role preset: ${rp.id}`)
    } catch (e) {
      console.error(`[agentPresets] seed role preset failed: ${rp.id}`, e)
    }
  }
}
