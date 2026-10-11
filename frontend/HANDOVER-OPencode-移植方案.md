# NIS 对话机制全面移植 opencode — 完整交接方案

> 状态日期：2026-08-11 · 后端备份已存 `E:\nis+gork\nIs ui 4.0\后端源码备份`
> 目标：后端对话机制按 opencode 架构完整移植（框架层确定性触发 + Part 消息模型 + 同轮续流），前端配合对齐，不破坏对话以外功能。

---

## 〇、一句话目标

把"权限申请/询问靠 LLM 输出 markdown 标记"改成 **opencode/hermes 式框架层确定性触发**，并把消息结构统一为 **Part 数组模型**（text/reasoning/tool/step/交互卡按序混排），复用已实现的同轮续流。前端保持现有组件能力，仅需适配新消息协议。

---

## 〇.5 参考源码（已下载到本地，新窗口直接查阅）

**目录**：`E:\nis+gork\nIs ui 4.0\opencode-ref`

| 文件 | 用途 | 关键内容 |
|---|---|---|
| `schema/session-event.ts` | **消息事件协议（最重要）** | message.updated / message.part.updated / message.part.delta 事件定义 |
| `schema/session-message.ts` | **消息/Part 结构（最重要）** | Message(parts[]) + 12 类型 Part 判别联合 + ToolPart 状态机 |
| `schema/session.ts` | 消息/Part 顶层 schema | Info/WithParts/Part 定义 |
| `schema/question.ts` | 询问协议 | Question/Prompt/Answer/Reply 类型 |
| `schema/permission.ts` | 权限协议 | AskInput/ReplyInput/Request/Rule |
| `schema/event.ts` | 事件总线 | Event 分发 |
| `question/index.ts` | 询问服务 | ask(questions[]) 批量 + Deferred 挂起 + reply 唤醒 |
| `permission/index.ts` | 权限服务 | 规则引擎 evaluate + once/always/reject + 级联批准 |
| `permission/arity.ts` | 权限工具参数 | 权限声明辅助 |
| `question_tool.ts` | question 工具定义 | LLM 调用参数 `{questions[]}` |
| `tui/session-index.tsx` | **Part 渲染（前端参考）** | PART_MAPPING + ReasoningPart/ToolPart/TextPart |
| `tui/question.tsx` | **询问卡渲染** | Tab 翻页 + 批量提交 |
| `tui/permission.tsx` | **权限卡渲染** | 3 阶段状态机 + diff 预览 |
| `tui/footer.tsx` | 卡片挂载点 | 有 pending 时禁用输入框 |

**注意**：这些是 TS/Effect 源码，**只能参考机制和 schema，不能直接抄代码**（我们后端是 Python asyncio，前端是 Vue 3）。

---

## 一、现状与差距（已调研确认）

### 我们 vs opencode/hermes 对比结论

| 维度 | 我们现状 | opencode/hermes | 动作 |
|---|---|---|---|
| 权限触发 | LLM 输出 `> [!permission]` markdown | 工具执行前框架拦截（gate_keeper/规则引擎） | **改** |
| 询问触发 | LLM 输出 `> [!ask]` markdown | `clarify`/`question` 结构化工具 | **改** |
| 同轮续流 | `_pause_for_interaction` future ✅ | `Deferred` 挂起 | 复用 |
| 多问题批量 | AskUserGroup 分页（部分） | `ask(questions[])` 一次 requestID 批量 | **改协议** |
| thinking | 独立块 + 折叠 ✅ | ReasoningPart + 标题/耗时 | 小改 |
| 消息结构 | blocks + processStates + extraProcess 三套 | 12 类型 Part 数组 | **大改** |
| 规则记忆 | grant store（会话级） | config/内存持久化 | 小改 |

### 关键代码现状（改造基点）

- **后端聊天主链路**：`main.py` `_ws_handle_chat`（~1327）→ `_stream_chat_background`（~1422，纯文本流式，不解析 tool_calls）
- **LLM 流式**：`core/api_router.py` `stream_chat`（~111）——**只处理 `delta.content` 和 `delta.reasoning_content`，未解析 `delta.tool_calls`**（Part 模型必须加）
- **权限体系（已有，未接 chat 链路）**：
  - `permission/gate_keeper.py` `secure_call`（~39）：`_request_user_decision`（~158）→ `ws_bridge.hitl_request` → `HITL_REQUEST` 广播 → 前端权限卡 → `HITL_RESPONSE` 回传 → `future.set_result` 继续
  - `core/tool_gateway.py` `execute`（~33）：统一工具入口，经 `gate_keeper.secure_call`
- **同轮续流（已实现）**：`main.py` `_pause_for_interaction`（~1558）：检测交互块 → 广播 `rich_message interactive:true`（不回 final）→ future 挂起 → 用户选择 `CHAT_INTERACT_RESPONSE` → 续流 `_stream_chat_background`（`_prebuilt_messages` 复用）
- **消息解析**：`core/message_types.py` `markdown_to_blocks`（~262）：markdown → blocks 数组（code/table/image/quote/permission_prompt/ask_user…）
- **前端**：`ChatInterface.vue` `Message` 接口（blocks/processStates/thinkingContent/extraProcess 三套）；消息存 `conversationsStore.messagesByConv`；非对话功能经 `extractMessageText(msg)` 单一入口消费

---

## 二、改造总原则

1. **前端保持现有组件能力**（PermissionPromptBlock/AskUserBlock/MessageBlocks/ThinkingLoader…），只改消息协议适配层
2. **非对话功能零破坏**：所有外部消费走 `extractMessageText` 单一入口，改造时只加"遍历 parts 拼文本"兼容实现
3. **后端协议对齐 opencode**：Part 数组 = 有序消息元素，前端按序渲染
4. **一次性迁移**：先建备份（已建），改完统一验证，避免中间态不兼容

---

## 三、后端改造方案（分模块）

### 3.1 消息模型：Part 数组（核心，message_types.py + main.py）

**目标**：把 `rich_message {blocks:[]}` 的"一次性块数组"改为**流式增量 Part**，对齐 opencode `message.part.delta/updated`。

**Part 类型**（对齐 opencode，裁掉我们不需要的）：
```
text        {type, content}                          # 文本（流式增量）
reasoning   {type, title?, content}                  # 思考（可折叠，带标题/耗时）
tool        {type, tool, input, status, output?, error?}  # 工具调用（状态机）
step-start  {type, title}                            # 步骤开始
step-finish {type, title, result?}                   # 步骤结束
permission_prompt  {type, request_id, question, options}  # 权限卡
ask_user     {type, request_id, question, options}    # 询问卡
image_placeholder / image / code / table / quote / ...  # 现有内容块类型保持
```

**后端协议变更**：
1. `stream_chat` 增加 tool_calls 解析：litellm `delta.tool_calls`（`index` + `function.name/arguments` 增量）→ 累积成完整工具调用 → `on_tool_call` 回调
2. `_stream_chat_background` 改为：
   - `on_chunk` → 广播 `{type:"part", kind:"text", content:delta, conversation_id}` （或 `text final:false` 保持兼容）
   - `on_reasoning` → 广播 `{type:"part", kind:"reasoning", content:delta, conversation_id}`
   - `on_tool_call` → 广播 `{type:"part", kind:"tool", tool, input, status:"pending"}`
   - 结束 → 广播 `{type:"rich_message", parts:[...全量], final:true}`
3. `markdown_to_blocks` 保留（生成文本 Part 内容），但输出结构改为 parts 数组

**兼容策略**：前端新渲染器读 `parts`；旧 `blocks` 字段作为 parts 的文本子集保留（非对话功能 `extractMessageText` 读 parts 或 blocks 均可）

### 3.2 权限框架层触发（main.py + tool_gateway + gate_keeper）

**目标**：LLM 请求工具（shell/文件等）时，工具执行前由 gate_keeper 确定性发权限卡。

**改造点**：
1. `_stream_chat_background` 收到 `on_tool_call` 后：
   - 若该工具有风险（低/中/高）→ 调 `self.gateway.execute(window_id, agent_id, tool_name, kwargs)` → 内部 `secure_call` → 命中需确认 → `hitl_request` 发 `HITL_REQUEST` → 挂起等 `HITL_RESPONSE` → 继续执行 → 工具结果作为 Part 广播
   - 纯文本聊天工具（如 `web_search`）→ 直接执行，不触发权限
2. `gate_keeper._request_user_decision` 选项已统一为 `["本次允许","当前会话允许","当前项目允许","拒绝"]`（已改）
3. `secure_call` 挂起期间，LLM 流式任务暂停（复用 `_pause_for_interaction` 思路——但这里是 gate_keeper 内部 future，与聊天交互不冲突）

**关键**：`secure_call` 是 `async def`，`hitl_request` 内部 `await future` 会阻塞当前 task。在 `_stream_chat_background` 里调 `gateway.execute` 会**阻塞整个流式任务**——这正是我们要的（工具执行前暂停，等权限）。

**判定工具风险**：`policy_engine.classify_risk(tool_name, kwargs)`（已有）

### 3.3 询问结构化工具 clarify（api_router + main.py）

**目标**：对齐 opencode `question` 工具——LLM 结构化调用 `{questions:[{question, choices[], multiple, custom}]}`。

**改造点**：
1. `stream_chat` 传入 `tools=[{type:"function", function:{name:"clarify", parameters:{...}}}]`（litellm tool_use）
2. `_stream_chat_background` 收到 `on_tool_call` name=clarify → 解析参数 → 广播 `QUESTION` 消息（带 `request_id` + `questions[]` 数组）→ 复用 `_pause_for_interaction` 挂起 → 用户全部作答 → `QUESTION_ANSWER` 回传 → 把答案注入消息历史继续同一轮
3. `question` 工具 schema：`{questions: [{question: str, choices?: str[], multiple?: bool, custom?: bool}]}`

### 3.4 同轮续流（复用，微调）

`_pause_for_interaction` 已实现 Deferred 等价。**只改一处**：现在它检测 markdown 交互块（`> [!permission]`），改为也处理 `on_tool_call` 触发的权限/询问（见 3.2/3.3）。挂起恢复逻辑（clear stop_event + 注入选择）保持不变。

### 3.5 多问题批量（question.py + message_types.py）

**目标**：一次 `QUESTION` 带 `questions[]` 数组，一个 request_id，等全部答完一次回传。

**改造点**：
1. `core/question.py` `Question.to_dict()`：支持 `questions: [Question]`（数组），`request_id` 一个，`options` 每题一组
2. 广播 `QUESTION {request_id, questions:[{question, options, placeholder}], conversation_id}`
3. 回传 `QUESTION_ANSWER {request_id, answers:[...]}`
4. 前端 AskUserGroupBlock 已是翻页式（一页一卡 + 全部答完一次性提交），协议对齐后即可

### 3.6 thinking 标题/耗时（main.py）

- `PARTNER_REASONING` 广播带 `title`（提取首行 `**标题**`）
- 结束时带 `duration`（秒）
- 前端 ReasoningPart 显示 `Thought: 标题 · 耗时`

### 3.7 规则记忆持久化（permission/gate_keeper.py + grant_store.py）

**目标**：`always`（当前项目允许）写入持久化，重启生效。

**改造点**：
1. `GrantStore` 加 SQLite 持久化（或复用现有 memory_store 数据库）
2. `secure_call` 命中 `ALLOW_WINDOW` → 存 grant（已有），改为落盘
3. 启动时加载持久化 grants

---

## 四、前端适配方案（配合对齐）

### 4.1 Message 类型重写（ChatInterface.vue）

```ts
interface Message {
  id, type, time, ...
  parts?: Array<Part>          // 新：按序渲染
  // 兼容字段保留：blocks/processStates/thinkingContent/extraProcess
}
interface Part {
  type: 'text'|'reasoning'|'tool'|'step-start'|'step-finish'|'permission_prompt'|'ask_user'|'image'|'code'|'table'|'quote'|'image_placeholder'|...
  content?, title?, tool?, input?, status?, output?, error?, request_id?, options?, ...
}
```

### 4.2 渲染改造

- 新增 `PartRenderer`：按 `part.type` 分发到现有组件（TextPart→MarkdownBlock、ReasoningPart→Thinking 行、ToolPart→工具进度、permission/ask→现有卡片、其余→MessageBlocks）
- 模板：`v-for part in msg.parts` 替换现在的"过程块硬编码链 + blocks v-for + extraProcess"
- 过程块折叠/计时：从 `processStates` 改为 part 驱动（reasoning 自带 title/duration）

### 4.3 流式增量

- 处理 `{type:"part", kind, ...}` 增量：按 kind 追加到对应 part（text 累积、reasoning 累积、tool 更新状态）
- 兼容旧 `text final:false` / `PARTNER_REASONING` 广播（过渡期双通道）

### 4.4 非对话功能兼容（零破坏）

- `extractMessageText(msg)`：改为遍历 `parts`（text/reasoning 拼 content，tool 拼标题），无 parts 时回退 blocks——**唯一入口，改这一个函数即保住复制/知识库/导出/历史**

---

## 五、实施步骤（建议顺序）

| 步骤 | 内容 | 文件 | 验证 |
|---|---|---|---|
| 1 | 消息模型 Part：stream_chat 加 tool_calls 解析 + 广播 part 增量 | api_router.py, main.py | 单测 + WS 手测 |
| 2 | 权限框架层触发：_stream_chat_background 接 gateway.execute + secure_call 挂起 | main.py, tool_gateway.py | 发"模拟权限"消息，验证权限卡 + 选择后续流 |
| 3 | clarify 询问工具 | api_router.py, main.py | 验证询问卡 + 批量作答续流 |
| 4 | 多问题批量协议 | question.py | 验证一屏多卡 |
| 5 | thinking 标题/耗时 | main.py | 验证 ReasoningPart |
| 6 | 前端 Message/PartRenderer/模板重写 | ChatInterface.vue | build + CDP |
| 7 | extractMessageText 兼容 | ChatInterface.vue | 复制/知识库/导出 |
| 8 | 规则持久化 | gate_keeper.py, grant_store.py | 重启后 always 仍生效 |

---

## 六、铁律（沿用交接文档）

1. **绝不用 PowerShell Set-Content/Get-Content 重写含中文 .py/.vue/.ts**（GBK 双重乱码）。读用 Read、写用 Edit/Write。必须脚本改：`[System.IO.File]::ReadAllText/WriteAllText` + UTF8
2. WS 收统一入口：全局 `App.vue handleGlobalMessage`；聊天 `ChatInterface.handleWebSocketMessage`
3. i18n：新文案加 `utils/i18n.ts` zh+en
4. TDZ：watch/computed 访问的 store/ref 声明在文件前部；`immediate:true` watch 内同步访问后部 ref 会抛错（已踩坑）
5. `_create_plan`/`_recommend_partners` 改动影响核心派发+测试，改前先读
6. 后端改完重启：`cd E:\nis+gork\nis内核\src-python && python run_server.py`（8765）；改前端 `npm run build` 验证
7. 后端测试：`python -m pytest -q -k "message_types or router or stream or chat or llm or permission or ws"`

---

## 七、验证方法

- **后端单测**：`python -m pytest -q -k "message_types or router or stream or chat or ws"`（当前 107 passed 基线）
- **前端**：`npm run build`
- **端到端（CDP）**：Edge headless `--remote-debugging-port=9223` + Node 22 WebSocket；脚本写 `C:\Users\Administrator\AppData\Local\Temp\opencode\`
- **真实链路**：
  - 发"模拟：开发网站需要下载依赖，申请权限" → 权限卡出现（框架层，非 markdown）→ 选择 → 同一轮续流，无空 thinking
  - 发"模拟：项目进行中需要确认需求，问我 3 个问题" → 一屏多卡翻页 → 全部作答 → 续流
  - 切走再回 → AI 回复继续（KeepAlive 已保证 WS 持续）
  - 图像模型发消息 → 占位图动画 → 真图（已验证链路）

---

## 八、已完成的既有修复（不要回退）

- **权限卡固定 4 项**：`message_types.py` permission 分支强制 `["本次允许","当前会话允许","当前项目允许","拒绝"]`
- **gate_keeper 选项统一**：`_request_user_decision` 用标准 4 项 + 决策映射
- **同轮续流**：`_pause_for_interaction` + `_ws_handle_chat_interact`（CHAT_INTERACT_RESPONSE）
- **切走不丢消息**：`conversationsStore.messagesByConv` + App.vue KeepAlive
- **切走清流式状态**：watch(conversation.id) nextTick 里清空/恢复（TDZ 安全）
- **HITL/QUESTION 按 convId 路由**：`msgConvId` + `getMessages(convId)`（防串台）
- **图像生成**：`IMAGE_GENERATE` 后端 + `/imagine` 前端 + `ImagePlaceholderBlock` 占位动画
- **模型类型路由**：`providers.modelType()` + sendMessage 按 image/video/text 分发
- **FETCH_MODELS 修复**：base 含 /v1 时不再拼 /v1/v1/models
- **多询问卡**：`AskUserGroupBlock` 翻页 + 全部答完一次性提交
- **续流 clear stop_event**：`_pause_for_interaction` 续流前 `self._stop_event.clear()`（修复选完空 thinking）
