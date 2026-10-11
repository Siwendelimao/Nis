# 提示词：实现「创建项目 → NIS 推荐伙伴」完整流程（前端演示版）

> ### ✅ 已完成（本会话实现 + CDP 全链路验证通过）
> - 创建弹窗加**项目描述（必填）**（ConversationList.vue）
> - `stores/projects.ts`：`Project.description`、`recommendPartnersMock(name, desc)`（⚠️ 演示实现，Luna 仅编码信号才推荐、非兜底）、`pendingRecommendations`/`recommendationShown` 持久化、接线检查单注释
> - `ChatInterface.vue`：进入项目窗口 → **全屏加载遮罩**（fixed inset-0 半透明 + 居中卡片「正在创建项目 / NIS 正在根据你的需求为你挑选合适的伙伴」，约 1.2s）→ **顶部通知弹推荐**（`pushRecommendNotice`：text 列伙伴名，action「确认加入」，忽略=留存 pending）
> - 通知确认/忽略处理在 `NotificationStack.vue`（actionToast 'confirm'→addMember；closeToast→setPendingRecommendation）
> - **兜底提问改为 `/test 伙伴` 手动触发**（`triggerRecommendAsk`，注入 ask_user：是否使用 NIS 之前推荐的伙伴开始项目？是/让 NIS 自己上）
> - 推荐卡消息/`PartnerRecommendBlock.vue` 已移除（不再注入聊天消息）
> - 已验证：全屏遮罩、推荐通知、确认加入成员、忽略留存、`/test 伙伴` 兜底提问、确认后成员加入
> - **后端接线用另一份提示词**：`E:\nis+gork\nis内核\src-python\HANDOVER-推荐伙伴接线.md`

> 复制整段给 AI，它会知道项目位置、现状、该改哪些文件、怎么做、怎么验证。
> 本次范围：**只改前端**。后端 description 透传 / PARTNER_RECOMMEND / _create_plan 编码判断 **全部不做**，只列入接线检查单（见文末）。理由：后端未启动无法真机验证，且 AI 选人最终要接 LLM，现在写规则版是返工。

---

## 一、项目位置与环境

- 项目：`E:\nis+gork\nIs ui 4.0\nis-ui`（Vue 3.5 + Vite 6 + Pinia + Tailwind 4，Tauri 壳损坏不跑，纯前端）
- dev server：`http://localhost:5173`（IPv6，127.0.0.1 连不上）；改动后 `npm run build` 验证
- 无头验证：Edge CDP（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，`--headless=new --remote-debugging-port=9223`）+ Node 22 内置 WebSocket；**验证脚本写文件再跑**（PowerShell 管道传中文乱码）；交互用 `Input.dispatchMouseEvent` 或 `.click()`；找元素用 className 分词判断（Tailwind 类名含点不能直接当选择器）
- 后端：`E:\nis+gork\nis内核\src-python`（未启动，WS `ws://127.0.0.1:8765`；前端靠 mock/演示数据）

## 二、必须遵守的约定

1. **读文件用 Read 工具、写用 Edit/Write 工具**。绝不用 PowerShell `Set-Content`/`Get-Content` 重写含中文的 .vue/.ts（会 GBK 双重乱码，曾毁文件）。脚本改文件须 `[System.IO.File]::ReadAllBytes/WriteAllBytes` + UTF8 且先测试。
2. **WS 处理收统一入口**：全局消息在 `App.vue` 的 `handleGlobalMessage`；聊天消息在 `ChatInterface.handleWebSocketMessage`；各 store 用 `applyWsMessage`/`applySnapshot` 承接。新功能别散落 WS handler。
3. **演示数据结构贴后端消息形状**：字段名用后端的（`project_id`/`partner_id`/`reason`/`added_by`...）。协议对齐只核对字段名，不重构。
4. **防忘机制（本功能必须落地，防止将来接后端时忘记对齐）**：
   - mock 推荐抽成单一可替换函数 `recommendPartnersMock(name, desc)`，函数上方注释：`⚠️ 演示实现：后端 PARTNER_RECOMMEND 接入后此函数不再被调用（applyRecommendation 接管）`
   - `stores/projects.ts` 顶部协议注释里加「── 接线检查单 ──」（内容见第六节），grep `接线检查单` 即可逐条核对
   - 前端永远「优先用后端数据，缺了才 fallback mock」：已有 `PARTNER_RECOMMEND` → `applyRecommendation` 覆盖逻辑，不要改成 mock 优先

---

## 三、现状（已核实，勿重复探索）

- 创建项目弹窗在 `ConversationList.vue`（`newProjectOpen`）：只有「项目名 input + 文件夹路径 input + 浏览按钮 + 黑色创建按钮」
- `confirmCreateProject`（ConversationList.vue 约 100-111 行）：`projectsStore.createProject({name, root_path})` → `projectsStore.recommendInitialMembers(project.id)`（按**项目名关键词**粗选，`stores/projects.ts:94`）→ `conversationsStore.createConversation(project.id)` → `emit('select', conv, plusOrigin())` 进入聊天窗口
- `stores/projects.ts`：`Project` 有 `id/name/root_path/status/created_at/members`，**没有 description 字段**；`recommendInitialMembers` 是「演示推荐」且**无脑兜底 Luna**；`addMember/applyRecommendation` 已存在
- 聊天消息存 **ChatInterface 本地** `conversationMessages = ref<Record<number, Message[]>>`，`getMessages(convId)` 惰性生成；`messages = computed(...)`
- 消息块分发在 `components/blocks/MessageBlocks.vue`：按 `block.type` 渲染对应块组件；`ask_user` → `AskUserBlock`（黑底 fa-comments 头部「想听听你的想法」+ options 单选 + 输入 + 提交 + 忽略），`permission_prompt` → `PermissionPromptBlock`
- 权限询问演示：`/test 权限询问` 往 `msg.blocks` 注入 `permission_prompt`/`ask_user` 块（ChatInterface 约 655-677 行）
- `ChatInterface` 已 import `useProjectsStore`
- App.vue 已处理 `PARTNER_RECOMMEND` → `projectsStore.applyRecommendation`（无需再写）

---

## 四、要实现的功能（分模块，按此做）

### 模块 1：创建项目弹窗加「项目描述」字段（必填）
`ConversationList.vue` 的新建项目弹窗，在「项目文件夹」输入框上方加：
- label「项目描述（必填）」+ textarea，`v-model="projectDescription"`，placeholder 示例「例如：做一个记账网站的登录和账单管理功能，前后端分离」
- 创建按钮 `:disabled` 增加 `!projectDescription.trim()`
- `confirmCreateProject` 把 `description` 传给 `projectsStore.createProject({ name, root_path, description })`

### 模块 2：Project 数据模型加 description
`stores/projects.ts`：
- `Project` 接口加 `description?: string`
- `createProject` 接收并存储 description
- 删除/改造 `recommendInitialMembers`（改为模块 3 的可替换推荐函数），`createProject` 不再自动调它
- 新增 `pendingRecommendations: Record<projectId, PartnerPick[]>`（被用户「忽略」后留存，供兜底提问用）+ 读写方法（如 `setPendingRecommendation/getPendingRecommendation/clearPendingRecommendation`，项目删除时一并清理）
- 顶部协议注释区追加「── 接线检查单 ──」（第六节内容）

### 模块 3：可替换推荐函数 `recommendPartnersMock`
放 `stores/projects.ts`（或 `utils/`）：
```ts
// ⚠️ 演示实现：后端 PARTNER_RECOMMEND 接入后此函数不再被调用（applyRecommendation 接管）
export interface PartnerPick { id: string; reason: string }
export function recommendPartnersMock(name: string, description: string): PartnerPick[] {
  // 用「项目名 + 描述」关键词匹配；返回 { id, reason }[]，可多个
}
```
规则（可扩充，至少覆盖）：
- 编码信号（开发|编码|实现|功能|页面|接口|修复|bug|前端|后端|网站|web|小程序|app）→ **优先**加 `Luna`（reason「核心代码实现」）
- 设计|图|logo|视觉 → `VisualPainter`；前|页面|ui|web|网站|网页 → `Frontend Expert`；测|验证|用例|test → `TestPilot`；搜索|调研|文档|资料 → `WebSurfer`；写|文档|readme|doc → `DocAuthor`；安全|审计|review → `Auditor`
- **Luna 不再兜底必选**；若一个都匹配不到 → 返回 `[]`（此时推荐卡显示「暂未识别到明确需求方向，可稍后在成员栏手动添加伙伴」，只有「忽略」按钮）

### 模块 4：加载动画（进入聊天窗口后、推荐卡出现前）
`ChatInterface.vue`：
- 新增本地状态 `projectAnalyzing = ref(false)`
- 判定：watch 当前会话，若是**项目窗口**（`props.conversation?.project_id` 存在）且该项目**从未处理过推荐**（推荐卡还没注入过）→ `projectAnalyzing = true`
- 消息列表顶部（`messages` 渲染区域前）`v-if="projectAnalyzing"` 渲染一张「分析中」卡片（样式对齐消息卡：spinner + 文案「NIS 正在创建项目结构、分析项目需求…」；可用现有 Loader 组件，如 `PlanLoader`/`SpinnerLoader`）
- 卡片文案分阶段（0.6s 内依次切换，简单计时器即可）：「正在创建项目结构…」→「正在分析项目需求…」→「正在为你推荐伙伴…」
- 总时长约 1~1.2s 后结束：`projectAnalyzing=false` → 注入推荐卡消息（模块 5）→ `scrollToBottom()`

### 模块 5：推荐卡（复用「想听听你的想法」卡片形态）
- 新建 `components/blocks/PartnerRecommendBlock.vue`：
  - props：`{ project_id: string; partners: { id: string; reason: string }[] }`
  - emits：`confirm`（携带 project_id + partners）、`ignore`（携带 project_id）
  - 样式**对齐 AskUserBlock**：头部黑底圆角块 + `fa-comments` 图标 + 标题「想听听你的想法」；内容区标题「NIS 已根据项目描述为你推荐了伙伴」+ 伙伴列表（每个：`LogAvatar`（`partnersStore.avatar/displayName`）+ 名字 + reason 灰色小字）+ 底部【确认】【忽略】按钮（确认=黑色实心，忽略=白底描边）
  - 响应后（已确认/已忽略）卡片变灰提示「已确认加入项目」/「已忽略」
- `MessageBlocks.vue` 加分支：`block.type === 'partner_recommend'` → `PartnerRecommendBlock`，emit `recommend-confirm`/`recommend-ignore`
- `ChatInterface.vue`：
  - 注入：模块 4 结束时 `conversationMessages[convId].push({ id, type:'partner', sender:'Nis', time, blocks:[{ type:'partner_recommend', project_id, partners }] })`（partners 来自 `recommendPartnersMock(project.name, project.description)`）
  - 处理确认：对每个 partner 调 `projectsStore.addMember(projectId, id, { reason, added_by:'nis' })`；清除 pendingRecommendation
  - 处理忽略：`projectsStore.setPendingRecommendation(projectId, partners)` 留存；卡片转「已忽略」
  - 用一个本地 `recommendHandled: Record<number, boolean>`（key=conv id）防止重复注入（切走再切回不重弹）

### 模块 6：兜底提问（忽略推荐后开工时）
`ChatInterface.vue` 的本地回复流程（用户发送第一条消息、mock NIS 回复时）插入判断：
- 条件：项目窗口 + `projectsStore.getProject(projectId).members.length === 0` + `getPendingRecommendation(projectId)` 存在（即用户之前忽略了推荐）
- 注入一条 `ask_user` 块消息（复用 AskUserBlock，ChatInterface 已会处理 question-submit）：
  - question：「这个项目还没有伙伴成员。是否使用 NIS 之前推荐的伙伴开始项目？」
  - options：`['是，使用推荐的伙伴', '让 NIS 自己上']`
  - submit 时：若是「是…」→ 把 pendingRecommendation 全部 `addMember` 进项目；「让 NIS 自己上」→ 清空 pendingRecommendation
- 处理成功后 NIS 的 mock 回复照常进行

---

## 五、验证清单（做完必须过）

1. `npm run build` 通过
2. CDP 脚本（写文件跑）：
   - 打开 5173 → 项目 tab → 新建项目：描述为空时创建按钮 disabled
   - 填名称+路径+描述 → 创建 → 进入聊天窗口 → **加载动画出现**（断言「正在分析」文案元素存在）→ 约 1s 后消失 → **推荐卡出现**（断言 `partner_recommend` 块渲染、伙伴名在列）
   - 点【确认】→ 断言成员栏（`ProjectMemberBar` 或 store）里出现对应伙伴、卡片转已确认
   - 再建一个项目 → 点【忽略】→ 发一条消息 → 断言 **ask_user 兜底提问出现**（含「是否使用 NIS 推荐的伙伴」）→ 选「是」→ 断言成员加入
   - 回归：左键点聊天行/普通聊天窗口一切正常
3. 手测补充：描述含「设计」→ 推荐含 VisualPainter；含「开发」→ 含 Luna；无匹配描述 → 推荐卡空名单态只显示忽略

## 六、后端接线检查单（本次不做，写进 projects.ts 注释）

```
── 接线检查单 ──
1. PROJECT_CREATE：前端发 {name, root_path, description}；后端接收 description → create_project(goal=description)（README 背景随之填充）
2. PROJECT_CREATED 回包带 description（前端 syncFromBackend 可存）
3. 后端创建项目后分析描述 → 广播 PARTNER_RECOMMEND { project_id, partners[{id, reason}] } → 前端 applyRecommendation 自动接管（无需再写）
4. _create_plan（nis_brain.py）改为按需求判断编码才加 Luna（当前硬编码 Luna 必选，与前端「非必选」不一致，必须配套改）
5. 前端未命中任何推荐时，后端同样返回空推荐 → 前端推荐卡显示「暂无匹配，可手动添加」
```

---

## 七、关键文件清单

- `components/ConversationList.vue`：创建弹窗（描述字段）、confirmCreateProject 流程改造
- `stores/projects.ts`：description、pendingRecommendation、recommendPartnersMock、接线检查单注释
- `components/ChatInterface.vue`：加载动画、推荐卡注入/处理、兜底提问
- `components/blocks/PartnerRecommendBlock.vue`（新建）：推荐卡
- `components/blocks/MessageBlocks.vue`：partner_recommend 分支

## 八、做之前先确认

- 推荐关键词规则是否按第五节列出的即可，还是要更细（如按技术栈区分前端/后端编码 → Luna 之外还要 Frontend/Backend 伙伴）？
- 加载动画总时长 1~1.2s 是否合适？
