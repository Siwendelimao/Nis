# NIS 聊天功能 — 第 2 轮交接提示词（新窗口直接开始）

> 给下一个 AI 会话的完整交接。读完即可无缝接替，无需重新调研。
> 目标：把**第 2 轮用户反馈的 7 个问题**全部修完，聊天彻底稳定，然后更新本文档。

> 🔧 **第 2.5 轮（真机回归补丁）**：7 个问题修完后真机又暴露 3 个（权限卡被流式分支吞掉不显示 / 气泡按钮 group 类放错位置 / 用户气泡按钮没隐藏），已修复，见「三之补充 #8 #9 #10」。
> 🔧 **第 2.6 轮（真机回归补丁 2）**：再暴露 5 个（权限卡选项变白 / 继续中残留 / 模型写 `> [permission]` 不带 ! 不识别 / 用户气泡时间位置 / 停止后作答卡不续流 + 卡挂起时按钮可点停止），已修复，见「三之补充 #11-#15」。
> 🔧 **第 2.7 轮（交互收敛 + 兜底）**：用户要求去掉 legacy 标记兜底（只用 clarify/工具）；卡挂起时按钮应显示灰色"停止"；拒绝后不再"已中断"（MAX_TOOL_ROUNDS 6→20）；clarify 回执不再当历史复读。见「三之补充 3 #16-#20」。
> 🔧 **第 2.8 轮（记忆优化 + 检索工具）**：询问卡可翻回重做；记忆提炼时机/关窗冷却/通知 1s 折叠；新增 knowledge_query / memory_search 工具 + 拟人化。见「三之补充 4 #21-#24」。未做清单见「九、第 3 轮候选（未做）」。
> 🔧 **第 2.9 轮（检索修复 + 记忆管理工具 + 去演示数据）**：FTS5 特殊字符转义（c++/c#/a+b 等不再报错）；新增 memory_delete/memory_update/knowledge_delete/knowledge_update；前端知识库移除演示数据。见「三之补充 5 #25-#27」。
> 🔧 **第 2.10 轮（记忆写入查重 + 来源标记 + memory_add）**：`MemorySourceType` 枚举；提炼落库前查重合并（自动/手动同链路）；新增 `memory_add` 工具（AI 主动写，user_explicit 优先）。见「三之补充 6 #28-#30」。
> 🔧 **第 2.11 轮（memory_add 同步记忆星系）**：`memory_add`/`memory_delete` 同步写 `memory_nodes`（记忆星系读这张表），AI 记住的喜好能在星系看到。见「三之补充 7 #31」。
> 🔧 **第 2.12 轮（记忆标题/查重/FTS 修复 + 星系去重）**：短标题生成；LCS 相似度查重（不同窗口同内容也合并）；FTS5 外部内容表 UPDATE 触发器改"先删后插"（trigram 分词器 UPDATE 内容会损坏索引→database locked/malformed）；`get_graph` 只显示启用节点 + 存量数据去重。见「三之补充 8 #32」。
> 🔧 **第 2.13 轮（关窗提炼重复 + 关键词查重增强）**：`project_memory.append_section` 补查重；`text_similarity` 增加"显著英文/数字词共享 → 强信号"（emoji/typescript 等措辞差异大也命中）；存量库再清 35 重复 records + 6 节点。见「三之补充 9 #33」。

---

## 〇、唯一目标（本轮）

第 1 轮已把 opencode 架构移植 + 交互卡进气泡 + 权限授予等核心跑通。当前残留 7 个问题（见第三节），全部是体验/正确性问题。修完 + 全量回归 + 更新本文档。

> ✅ **第 2 轮已完成**：7 个问题全部修复 + 后端 836 个测试全绿 + 前端 build 通过 + 后端重启验证 READY。见第三节各条的「已修复」说明。

---

## 一、环境与重启（与第 1 轮一致，必须遵守）

| 项 | 值 |
|---|---|
| 后端 | `E:\nis+gork\nis内核\src-python`（main.py / run_server.py） |
| 前端 | `E:\nis+gork\nIs ui 4.0\nis-ui`（Vue3+Vite，dev :5173 HMR） |
| 后端解释器 | `C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`（**必须用这个**，uv 基础缺 filelock） |
| 运行日志 | `C:\Users\Administrator\AppData\Local\Temp\opencode\nis_server.log`（stdout）+ `.log.err`（**stderr，chat-stream 诊断在这**） |
| 后端备份 | `E:\nis+gork\nIs ui 4.0\后端源码备份`（194 .py 全量，改坏可回退） |

**重启后端**（每次改后端必走）：
```powershell
$p = Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$log = "C:\Users\Administrator\AppData\Local\Temp\opencode\nis_server.log"
$logErr = "C:\Users\Administrator\AppData\Local\Temp\opencode\nis_server.log.err"
Remove-Item -LiteralPath $log,$logErr -Force -ErrorAction SilentlyContinue
Start-Process -FilePath "C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe" -ArgumentList "run_server.py" -WorkingDirectory "E:\nis+gork\nis内核\src-python" -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $logErr
Start-Sleep -Seconds 16
Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
```
日志出现 `[NisEngine] READY (persistent)` = 成功。前端 `npm run build` 验证编译；真机改完 Ctrl+F5。

---

## 二、已完成进度全清单（防止回退，逐条核对）

> 以下全部已实现并通过第 1 轮真机验证/测试。**改新东西时不要动这些。**

### 架构（已完成）
- **#1 统一事件通道**：`_stream_chat_background` 只广播 `part` 通道（text/reasoning/tool/step）；`text final` 保留收尾。前端 `text` 非 final 保留（**nis_brain 仍用它回包**，别删）；`PARTNER_REASONING` 前端分支已删（后端无调用方）。
- **#2 交互卡进气泡**：权限/询问卡渲染在 **AI 回复气泡里**（方便溯源），不再有输入框上方面板；交互挂起期间输入框+发送按钮禁用（`hasPendingInteractive`）。后端**不把卡写进 body_parts**；`gateway.execute` 不传 on_card；`ws_bridge.hitl_request` 带 `card_meta`（tool/risk 随 HITL_REQUEST 广播）。
- **#3 工具优先提示词**：`INTERACTIVE_FALLBACK_GUIDE`（main.py）工具优先 + `> [!ask]`/`> [!permission]` 兜底；`stream_chat` 带 tools 时 `tool_choice="auto"`；工具参数 JSON 宽松解析（`_lenient_parse_tool_args`）+ dict/pydantic 兼容（`_field`）。
- **#4 extractMessageText 排除 reasoning**：默认不含思考；新增 `opts.includeThinking`。
- **#5 列表预览补字**：`finalizeAiReply` 用 `extractMessageText(msg)` 更新预览。
- **#6 工具专属渲染**：`blocks/ToolPartBlock.vue`（shell 显示拟人化文案+`$ 命令`、搜索匹配数、文件路径、可折叠输出）。
- **#7 时间戳**：工具 part 带 `created/ran/completed/duration_sec`；`rich_message final` 带 `completed/duration_sec`；前端显示真实耗时。
- **#8 step 事件**：**已全部移除**（多工具也不发 step 行，工具卡自身呈现状态）——后端无 step-start/finish 广播，前端 `step-start/step-finish` 渲染分支仍在但永不触发。
- **#9 清理**：删了 `PARTNER_REASONING` 前端分支、`ensureExtraSegment`/extraProcess、`scrollToCard`(已重加)/`cardPartWithConv`(已重加)/`isAskGroupStart`/`askGroupBlocks`(已重加)、`formatToolInput`/`toolIcon`。
- **#10 推荐卡**：`blocks/PartnerRecommendBlock.vue` 接入 MessageBlocks；`/test 伙伴` 注入 `partner_recommend` 块。

### 交互卡协议（已完成）
- `HITL_REQUEST` → 权限卡进气泡；`QUESTION` → 询问卡进气泡（批量一次 request_id，`batchQuestionMap` 收集，全部答完一次性 `QUESTION_ANSWER`）。
- 答案写回卡 part（`markPartAnswered` → `part.answered/answeredValue`），返回列表再进**不重置**为可点。
- **询问卡忽略**：`onPanelQuestionIgnore` 立即回传 `QUESTION_ANSWER {answers:[]}`，后端马上续流；后端 `_pause_for_question` **无超时**（用户没点就一直等，不再伪造"超时未作答"）；全部未作答时返回"用户跳过了这些问题，请基于上下文继续，不要重复提问"。
- **权限授予**：`_store_grant_for` 按工具存授权（高风险/中风险**各自独立**确认；`find_valid_grant` 按 tool_name/window/agent/scope 精确匹配，`grant_store.py`）；同窗口同工具不再弹。
- **每窗口模型隔离**：`providersStore.getConvModel/setConvModel`；发消息带 `model_provider/model_id/model_base`；后端 `_ws_handle_chat` 优先用消息自带模型。

### 后端并发/上下文（本轮新增，重要）
- **每会话流式任务互斥**：`self._chat_stream_tasks: dict[conv_id, Task]`，新消息到达**取消旧任务**再开新任务（`_ws_handle_chat`）——修"上一轮残留流与新一轮混在一起"。
- **历史上下文清洗**：`extractMessageText` 现在剔除 `> [!ask]`/`> [!permission]` 原文（`stripInteractiveMarkdown`）+ 工具输出截断 200 字——模型不再被上一轮权限原文带偏。
- **交互标记不广播原文**：`on_chunk` 缓冲检测，文本以 `> [!ask` / `> [!permission` 开头则整段不广播（只弹卡）；`_append_round_text` 每轮重置缓冲。
- **前端渲染兜底**：text/content part 渲染前 `stripInteractiveMarkdown`；纯交互标记 text part 不渲染（`isInteractiveMarkdown`）；`groupBlockGroups` 跳过纯交互 markdown 块。
- **标题提炼**：`AUTO_TITLE` 后端用模型提炼 ≤12 字标题（`_ws_handle_auto_title`，无模型回退截断），前端 `applyTitle` 替换临时标题。
- **reasoning 完成态即时**：正文开始流式时前端立即把进行中 reasoning part 标 done（不等整轮吐完）。
- **停止/截断收尾**：`stopGeneration` 标记所有 reasoning done + pending/running 工具 `stopped`（停表）；`finalizeAiReply`/`chat_error` 也调 `settleRunningTools`；"已停止"提示对 parts 消息也显示。
- **交互标记原文防泄漏**：后端 on_chunk 缓冲 + 前端 stripInteractiveMarkdown + groupBlockGroups 过滤（三保险）。
- **删除旧会话气泡**：`deleteMessage` 等保留。

### 测试
- 全量 pytest 通过（含 `test_chat_agent_loop.py`、`test_stream_tool_calls.py`、`test_gate_keeper.py`、`test_grant_store.py`、`test_ws_project_handlers.py` 的 auto_title 测试、`test_legacy_interactive_markdown_not_broadcast_as_text`）。测试命令：
  `cd E:\nis+gork\nis内核\src-python && python -m pytest -q -k "chat_agent_loop or stream_tool_calls or message_types or ws or grant or gate or auto_title"`
- 前端 `npm run build` 通过。

### 第 2 轮修复（已完成，防回退）
- **#5 交互状态**：`_choice_means_deny()`（main.py）+ legacy perm 拒绝/同意文案明确区分；legacy 交互优先时 `pending_tool_calls.clear()` + 补发取消态（拒绝后不执行未同意命令）；`round_calls` 缺 call_id 统一 `call_<i>` 保证 `assistant.tool_calls.id` ↔ `role:tool.tool_call_id` 一致；`INTERACTIVE_FALLBACK_GUIDE` 强化"被拒绝操作绝对不执行、不得绕过"。
- **#2 停止态**：`settleRunningTools(convId)` 遍历会话所有消息；`hasActiveTools()` + `isReplyingNow` 含运行中工具；`refreshReplying()` 统一列表"正在回复"；`stopGeneration` 停止后列表保持"正在回复"直到 finalize。
- **#3 已停止残留**：`clearStoppedState(convId)` 在回答/忽略交互卡、`pushCardToBubble`、新 part 到达时清除 `processStates.stopped`。
- **#1 card 权限**：`message_types._card_title_suggests_permission()` + `> [card]` 权限标题映射 `permission_prompt`；后端 `_is_interactive_marker_prefix` 含 `> [card`；前端 strip/isInteractive 识别权限类 card。
- **#6 计时格式化**：新增 `src/utils/formatDuration.ts`（`Xh Ym Zs` / `Xm Ys` / `Xs`），LiveTimer/ToolPartBlock 真实耗时/消息耗时/RightPanel 日志统一使用。
- **#7 按钮悬停**：AI 气泡容器 `group` + 按钮行 `opacity-0 group-hover:opacity-100`。
- **#4 延迟反馈**：PermissionPromptBlock/AskUserBlock 已作答且 streaming 时显示"继续中…"；MessageBlocks/ChatInterface 透传 `:streaming`。
- 新增测试：`test_legacy_permission_deny_injects_clear_rejection`、`test_role_tool_call_id_consistency`（test_chat_agent_loop.py）、`test_card_permission_title_maps_to_permission_prompt`、`test_card_normal_title_stays_card`（test_parts_model.py）。

### 第 2.5 轮真机补丁（已完成，防回退）
- **#8 交互卡被流式分支吞掉**：`MessageBlocks.vue` 流式 raw 分支排除 `permission_prompt`/`ask_user`/`partner_recommend`（pushCardToBubble 会置 msgStreaming → 之前卡被 StreamingTail 隐形渲染，60s 超时自动拒绝）。**这是权限卡不显示、'用户拒绝'延迟出现、卡后来'又出现' 的同一根因。**
- **#9 AI 气泡按钮 hover 不显示**：`group` 类上轮误加到任务记录气泡，已移到正确的 AI 消息容器 `<div class="flex-1 min-w-0 group">`；任务记录气泡的误加 group 已移除。
- **#10 用户气泡按钮未隐藏**：用户消息容器加 `group`，按钮行（时间戳常显、仅按钮）加 `opacity-0 group-hover:opacity-100`。

### 第 2.6 轮真机补丁 2（已完成，防回退）
- **#11 权限卡选项悬停变白**：气泡容器改命名 group `group/bubble`（`group-hover/bubble:opacity-100`），与权限卡按钮内部未命名 `group`/`group-hover` 隔离。
- **#12 已作答卡残留"继续中"**：删除 PermissionPromptBlock/AskUserBlock 的"继续中…"spinner。
- **#13 `> [permission]` 不带 ! 不识别**：`message_types.py` 交互正则 `\[!?(ask|permission)\]`；`main.py` 前缀含 `> [ask`/`> [permission`；前端 strip/isInteractiveMarkdown 加 `!?`。
- **#14 用户气泡时间位置**：用户消息 meta 行 `justify-end` → `justify-start`。
- **#15 卡挂起可点停止 + 停止后作答不续流**：前端 legacy rich_message 分支补 `pushInteractiveCard`；发送按钮 `hasPendingInteractive` 时不进 `is-sending`；后端 `_await_legacy_permission` 与 gateway 工具执行后 `_stop_event.clear()`；前端 part 分支 `!isGenerating` 时恢复 generating/replying。

### 第 2.7 轮（交互收敛 + 兜底，已完成，防回退）
- **#16 去 legacy 标记兜底提示**：`INTERACTIVE_FALLBACK_GUIDE` 只讲 clarify 工具 + 工具弹权限，不再提 `> [!ask]`/`> [!permission]`；后端/前端解析保留兜底。
- **#17 卡挂起按钮灰"停止"**：发送按钮 `hasPendingInteractive` 仍进 `is-sending`（停止态）+ `opacity-40 cursor-not-allowed`。
- **#18 MAX_TOOL_ROUNDS 6→20**：拒绝后模型继续调工具不再被轮数上限误杀（"已中断"）。
- **#19 clarify 回执不进历史**：`extractMessageText` 跳过 `tool==='clarify'` 的 part，避免下轮复读 `[clarify] 用户已回答：…`。
- **#20 聊天不持久化**：内存 store，刷新即清，保持现状。

### 第 2.8 轮（记忆优化 + 检索工具，已完成，防回退）
- **#21 询问卡可翻回重做**：AskUserBlock `editable` + 编辑按钮；AskUserGroupBlock `submit-all` 一次性提交完整答案；ChatInterface `handleGroupSubmitAll`。
- **#22 记忆提炼时机**：`resetIdleTimer()` 只取消；`scheduleIdleExtract()` 仅在 `!isGenerating` 时 60s 调度；`watch(isGenerating)` 生成开始取消/结束计时。
- **#23 关窗提炼弹窗 10min 冷却**：`suppressedClosePrompt`（永久）→ `closePromptCooldownUntil`（10min）；提炼/跳过都记冷却；模板移除"不再提示"勾选。
- **#24 检索工具 + 通知 1s 折叠**：后端 `knowledge_query`/`memory_search` 工具（schema+NON_INTERACTIVE+risk low+executor）；`NotificationStack` memory 类 1s 折叠；前端 `toolPhrases` 拟人化文案。

### 第 2.9 轮（检索修复 + 记忆管理工具 + 去演示数据，已完成，防回退）
- **#25 FTS5 特殊字符转义**：`memory/_normalize_query` 与 `knowledge/_escape_fts` 每词双引号包裹 → `c++`/`c#`/`a+b` 不再语法报错/反复重试。
- **#26 记忆/知识库管理工具**：`memory_delete`/`memory_update`/`knowledge_delete`/`knowledge_update`（risk medium 弹权限卡）；搜索结果带 `[id=…]`。
- **#27 前端知识库去演示数据**：`knowledge.ts` 空启动 + STORAGE_VERSION 5→6 清旧缓存。

### 第 2.10 轮（记忆写入查重 + 来源标记 + memory_add，已完成，防回退）
- **#28 MemorySourceType 枚举**：`core/memory/models.py`；提炼→system_infer，memory_add→user_explicit。
- **#29 提炼查重合并**：`DistillEngine._find_duplicate` + 命中更新旧记忆（dup_merged），memory_nodes 同标题更新；自动/手动提炼同链路。
- **#30 memory_add 工具**：AI 主动写记忆，写前查重（同内容返回已存在/相似更新），user_explicit；risk medium 弹权限卡；前端拟人化。

### 第 2.11 轮（memory_add 同步记忆星系，已完成，防回退）
- **#31 memory_add/delete 同步 memory_nodes**：`_sync_memory_node` 把 AI 主动写的记忆写进星系表（md_section 绑定 memory_id）；删除时停用星系节点。AI 记住的喜好星系可见。

### 第 2.12 轮（记忆标题/查重/FTS 修复 + 星系去重，已完成，防回退）
- **#32**：`text_utils.py`（short_title / LCS is_duplicate / _search_hint）；distill/memory_add 查重改 LCS + title 简短；append_entry 查重；FTS5 外部内容表 UPDATE 触发器改先删后插（修 database locked/malformed）+ `_rebuild_fts_triggers`；`get_graph` enabled_only；存量库去重 342 records + 4 nodes。

### 第 2.13 轮（关窗提炼重复 + 关键词查重增强，已完成，防回退）
- **#33**：`project_memory.append_section` 补查重；`text_similarity` 增加显著英文/数字词共享强信号（emoji/typescript 措辞差异大也命中）；存量库再清 35 records + 6 nodes。

---

## 三、第 2 轮问题清单（**全部必须修**，逐项验收）

> ✅ 本轮已全部修复（见各条「已修复」说明）。以下保留原诊断 + 改法记录，供回归对照。

### #1 `> [card] 权限请求` 原文偶发显示（概率性）
- **用户原文**：不再显示 `> [!ask]/> [!permission]`，但偶发显示：
  > [card] 权限请求 > 是否允许我执行 npm install 下载前端依赖包？ > - 这将下载约 150MB 的 node_modules > - 包含 React 18、Vite、路由和 HTTP 客户端
- **诊断**：模型把权限请求写成了 `> [card] 权限请求`（card 块格式），不是 `> [!permission]`。`markdown_to_blocks` 把它解析成 `card` 块（`message_types.py` line ~346 `> [card] 标题` 分支），前端渲染成 CardBlock → 原文显示。`stripInteractiveMarkdown` 只识别 `> [!ask]`/`> [!permission]`，不识别 `> [card] 权限`。
- **改法**：把 `> [card] 权限请求` / `> [card] 需要授权` 等 card 头含"权限/授权/允许"的块，也识别为 `permission_prompt`（local: True），走权限卡路径；或至少前端 strip 时把这类 card 原文也去掉。**重点**：这是模型把它当权限用的变体，最好在 `markdown_to_blocks` 里把"card 标题含权限/授权"映射为 permission_prompt。
- **验收**：让模型申请权限，用 `> [card] 权限请求` 写时 → 弹权限卡，不显示 card 原文。
- ✅ **已修复**：
  1. 后端 `core/message_types.py`：新增 `_card_title_suggests_permission()`（权限/授权/允许我/是否允许/请求执行/申请执行），`markdown_to_blocks` 的 `> [card]` 分支命中时映射为 `permission_prompt`（standard 4 选项，local:True）→ 走 legacy 权限卡路径，不再是 card 原文。
  2. 后端 `main.py` `_is_interactive_marker_prefix` 增加 `> [card` 前缀 → 流式缓冲不广播 card 原文。
  3. 前端 `stripInteractiveMarkdown` / `isInteractiveMarkdown` 增加权限类 `> [card]` 变体剥离/判定（三保险）。
  4. 测试：`tests/test_parts_model.py` 新增 `test_card_permission_title_maps_to_permission_prompt` + `test_card_normal_title_stays_card`。

### #2 停止后：按钮变"发送"、模拟 shell_exec 计时器还在跑、返回列表不显示"正在回复"
- **用户原文**：ai 还没回复完成，停止按钮变成了发送；模拟的 shell_exec"开始跑「mkdir -p ... yarn init...」"的计时仍在跑；返回列表，显示的也不是正在回复状态。
- **诊断**：
  - 停止按钮变发送 = `isReplyingNow` 判断为 false。`isReplyingNow = isGenerating || streamingByConv[convId]`。若停止时 `finalizeAiReply` 已跑（删除 streamingByConv）→ 判断 false。但工具卡还在 running → 说明 `settleRunningTools` 没把该 tool part 标 stopped（可能该消息不是当前流式消息，或停止发生在 finalize 之后）。
  - "模拟的 shell_exec" 计时在跑 = 工具 part `status` 仍是 running 且没标 `stopped`（`ToolPartBlock.isActive` 只看 `!stopped && (pending||running)`）。
  - 返回列表不显示"正在回复" = `replying` 在停止时被 `setConvGenerating(false)` 清掉；但用户期望：**工具还在跑/未收尾时，列表仍显示"正在回复"**。
- **改法**：
  1. 停止/收尾时对所有**历史消息**里 pending/running 的工具 part 标 stopped（`settleRunningTools` 遍历 getMessages 的所有消息，不只当前流式消息）。
  2. `isReplyingNow` 增强：只要当前窗口最后一条 ai 消息里有 running/未 stopped 工具 part，也算"回复中"（按钮显示停止）。
  3. 列表 replying：停止时不立即清，等真正收尾（工具 done）再清；或工具 running 期间 `setReplying(true)`。
- **验收**：回复中（含工具执行）停止 → 按钮恢复发送、工具计时停、返回列表该项仍显示"正在回复"直到收尾。
- ✅ **已修复**（`ChatInterface.vue`）：
  1. `settleRunningTools(convId)` 改为遍历该会话**所有**消息的工具 part（签名由 parts 数组改为 convId），`stopGeneration`/`finalizeAiReply`/`chat_error` 全用新签名。
  2. 新增 `hasActiveTools(convId)` + `isReplyingNow` 包含"还有未 stopped 的 pending/running 工具 part" → 按钮在工具未收尾前保持"停止"。
  3. 新增 `refreshReplying(convId)`（= 有流式气泡 || 有 active 工具）；`finalizeAiReply`/`pushAiRichReply`/`pushAiReply`/`chat_error`/rich_message 空分支改用它同步列表状态；`stopGeneration` 停止时保持 `setReplying(true)`（未连后端本地模拟则直接清）。

### #3 停止后询问卡仍可回复，但"已停止"残留
- **用户原文**：回复中点了停止，期间恰好发了询问卡，卡下面显示"已停止"；选择询问卡后他又继续回复了，即便底下还显示"已停止"字样。
- **诊断**：停止设置 `msg.processStates.stopped = 'done'`（消息级）；之后收到 QUESTION 卡（后端 stop 只中断流，`_pause_for_question` 可能仍广播/等待），用户回答 → 续流 → 但 `processStates.stopped` 没清除 → "已停止"还显示。
- **改法**：回答交互卡（`onPanelHitlResponse`/`onPanelQuestionSubmit`/`onPanelQuestionIgnore`）或续流开始时清除该消息的 `processStates.stopped`（以及新 part 到达时清除）；或停止与交互卡互斥。
- **验收**：停止后回答询问卡 → 正常续流，无"已停止"残留。
- ✅ **已修复**（`ChatInterface.vue`）：新增 `clearStoppedState(convId)`（清掉会话内所有消息的 `processStates.stopped`），在 `onPanelHitlResponse`/`onPanelQuestionSubmit`/`onPanelQuestionIgnore`、`handleHitlResponse`（chat_interact_ 分支）、`handleQuestionSubmit`（batch/chat_interact_ 分支）、`pushCardToBubble`、part 增量到达时调用。

### #4 权限选择后有延迟才回复
- **用户原文**：权限选择后有延迟过会儿才回复。
- **诊断**：可能是模型推理时间（长思考模型），也可能是 HITL 响应 → 续流链路有额外等待。先看 `log.err` 里 HITL_RESPONSE 到 tool 完成的耗时；若正常只是模型慢，可在前端选完卡后显示"正在继续…"缓冲（如 tool part running 动画），不必改后端。
- **验收**：选择后有明确"继续中"反馈，无死等。
- ✅ **已修复**（前端）：`MessageBlocks.vue` 给 `PermissionPromptBlock`/`AskUserBlock` 透传 `:streaming`；两卡在「已选择/已提交」状态下若 `streaming` 为真显示"继续中…"（spinner）。`ChatInterface.vue` part 渲染权限卡时传 `:streaming="!!msgStreaming[msg.id]"`。链路本身无额外等待（HITL_RESPONSE → future.set_result → 工具执行），延迟主要是模型/工具执行，现已有明确反馈。

### #5 多交互状态错乱（拒绝/忽略/同意混在一起，且执行了用户没同意的长命令）
- **用户原文**：前面权限申请我拒绝，后面询问我忽略，再后面权限请求我同意，但 reasoning 写"用户跳过了问题""之前拒绝了 npm install 的权限，我尝试用 diff_edit 创建 package.json 但失败了"；并且实际执行了 `cat > vite.config.ts << 'EOF' ...`（146s 长命令）。
- **诊断**：多轮交互的**注入顺序/上下文**错乱。可能原因：
  1. `chat_messages` 里 assistant 消息带 `tool_calls` + 多个 `role:tool` 结果，与下一轮的 user 选择注入混在一起，模型误解"跳过/拒绝/同意"的状态。
  2. legacy 交互（拒绝权限 → `_await_legacy_permission` 返回 choice 注入 user；忽略 → "用户跳过"注入）与 clarify/HITL 工具路径的状态互相污染。
  3. 上一轮残留任务（#2 的并发问题）可能已由 `_chat_stream_tasks` 缓解，但交互上下文的组装仍需核对。
- **改法**：核对 `_stream_chat_background` 里每条交互路径（clarify / gateway 工具 / legacy ask / legacy perm）把结果注入 `chat_messages` 的顺序与格式，确保每条 `role:tool` 有对应 `tool_call_id`、assistant 消息的 tool_calls 与之一致；拒绝/忽略/同意各自的结果字符串**明确区分**（拒绝→"用户拒绝，请换方案或停止"；忽略→"用户跳过，基于上下文继续"；同意→"用户已同意执行"）。重点检查：legacy perm 拒绝后模型又执行长命令的场景（拒绝应阻止执行，且模型不应继续执行未同意命令——这是提示词 + 注入顺序问题）。
- **验收**：连续 拒绝→忽略→同意 三轮后，模型准确知道每轮结果，不再执行未同意命令，reasoning 不出现"跳过/拒绝"错位。
- ✅ **已修复**（`main.py`）：
  1. **legacy perm 结果明确区分**：新增 `_choice_means_deny()`（拒绝/不同意/不执行/不允许/取消/不要）；`_stream_chat_background` legacy perm 分支按选择注入不同文案：拒绝→"用户拒绝了该操作的授权请求。该操作未执行，请不要再次请求同一个操作，也不要尝试用其它命令或方式绕过用户来完成同一个目的；请换一个可行的方案继续，或直接结束回复并说明原因。"；同意→"用户已同意执行该操作（choice）。可以继续执行用户同意的操作。"（与网关 PermissionError 文案一致）。
  2. **同轮工具调用作废**：legacy 交互块（ask/perm）优先 → 交互作答前 `pending_tool_calls.clear()` 并补发 `status=error`（"该操作因用户交互未获执行，已取消"）→ 拒绝后绝不执行未同意命令。
  3. **tool_call_id 一致性**：`round_calls` 缺 call_id 时统一生成 `call_<i>`，保证 `assistant_msg.tool_calls[].id` 与 `role:tool.tool_call_id` 一一对应。
  4. **提示词强化**：`INTERACTIVE_FALLBACK_GUIDE` 明确"被拒绝的操作绝对不要执行，不得改用其它命令绕过用户达成同一目的；只能执行工具结果里明确标注已同意的操作"。
  5. 测试：`tests/test_chat_agent_loop.py` 新增 `test_legacy_permission_deny_injects_clear_rejection`（含 `_choice_means_deny` 断言 + 拒绝后同轮工具不执行）+ `test_role_tool_call_id_consistency`。

### #6 计时器格式化（分钟/小时）
- **用户原文**：计时器到分钟就按分钟显示，到小时就按小时显示，如 `1h 1m 1s`。
- **诊断**：`blocks/LiveTimer.vue` 现在只 `sec.toFixed(1)s`。
- **改法**：`LiveTimer.vue` 增加格式化：≥1h → `Xh Ym Zs`；≥1m → `Xm Ys`；否则 `Xs`（保留 1 位小数）。真实耗时（ToolPartBlock 的 `realDuration`、消息级耗时）同样格式化。
- **验收**：工具卡/消息耗时超过 1 分钟显示 `1m 30s`，超过 1 小时显示 `1h 2m 3s`。
- ✅ **已修复**：新增 `src/utils/formatDuration.ts`（≥1h → `Xh Ym Zs`；≥1m → `Xm Ys`；否则 `Xs` 1 位小数）；`LiveTimer.vue`、`ToolPartBlock.vue` 的 `realDuration`、`ChatInterface.vue` 消息级 `duration`、`RightPanel.vue` 的 `formatLogDuration` 统一走该函数。

### #7 气泡下按钮隐藏，悬停显示
- **用户原文**：气泡下的按钮隐藏，悬停到气泡上或按钮附近显示。
- **诊断**：AI 消息气泡下方的操作按钮（复制/存知识库/锚点，见 ChatInterface 模板 `mb-3 space-y-3` 后的按钮行）目前常显。
- **改法**：给按钮行加 `opacity-0 group-hover:opacity-100`（气泡容器加 `group`），悬停气泡才显示；hover 到按钮附近时保持显示（按钮自身 hover 也触发）。
- **验收**：不悬停时按钮隐藏，悬停气泡显示。
- ✅ **已修复**（`ChatInterface.vue`）：AI 消息内容容器 `<div class="flex-1 min-w-0 group">`；按钮行加 `opacity-0 group-hover:opacity-100 transition-opacity duration-200`（hover 到按钮附近=气泡容器仍处于 hover，保持显示）。

---

## 三之补充：第 2.5 轮真机回归补丁（#8 #9 #10）

> 7 个问题修完后真机测试暴露的 3 个新问题，均已修复。

### #8 权限/询问卡被"流式"分支吞掉，聊天里不显示卡（真机最严重）
- **用户原文**：Windows 系统级提示（notifySystem）显示申请权限了，但聊天窗口内卡在这一条 shell_exec「开始跑 ls -la / $ ls -la」一直是进行态，过一会儿直接显示"用户拒绝了"。询问卡和权限申请卡都没出来。
- **诊断**：权限卡通过 `pushCardToBubble` 进气泡 parts，同时 `pushCardToBubble` 置 `msgStreaming[msg.id]=true`。渲染时 `MessageBlocks.vue` 的**流式 raw 分支**（`streaming && type!=='plaintext' && type!=='markdown'`）把 `permission_prompt`/`ask_user` 卡当成纯文本用 `StreamingTail` 渲染（content 为空→**完全不可见**）→ 用户看不到卡 → 无法点击 → 后端 `HITL_TIMEOUT=60s` 超时 → 自动判拒绝 → 显示"用户拒绝了"。等流式结束（msgStreaming 清掉）卡才"又出现"（#3 的"前面的权限申请卡又出现了"就是同一个根因）。
- **改法**：`MessageBlocks.vue` 流式 raw 分支**排除交互卡类型**（`permission_prompt` / `ask_user` / `partner_recommend`）→ 这些卡立即渲染成可点击组件（PermissionPromptBlock / AskUserGroupBlock），不再进 raw 流式。
- **验收**：让模型申请权限 → 权限卡立即出现在气泡里可点击；询问卡同理。不再有"60s 后才显示用户拒绝"。
- **测试影响**：前端 build 通过；无后端改动，pytest 全绿。

### #9 AI 气泡底部按钮悬停不显示（上一轮 #7 的 group 类放错位置）
- **用户原文**：ai 回复气泡悬停没出现底部按钮。
- **诊断**：上一轮 #7 给 `flex-1 min-w-0` 加 `group` 时，edit 命中的是**任务记录气泡**（ChatInterface 后半段 `rec` 分支）而不是 AI 消息气泡（`msg.type==='ai'` 分支），且任务记录气泡本身也没按钮行 → 真机的 AI 气泡按钮行加了 `group-hover:opacity-100` 但没有祖先 `group` → 按钮一直 opacity-0。
- **改法**：把 `group` 加到**正确**的 AI 消息容器 `<div class="flex-1 min-w-0 group">`（msg.type==='ai' 分支）；移除任务记录气泡误加的 `group`。
- **验收**：悬停 AI 气泡 → 底部复制/存知识库/锚点按钮淡入；不悬停隐藏。

### #10 用户气泡按钮未隐藏（上一轮 #7 只做了 AI）
- **用户原文**：用户气泡的按钮没有做隐藏。
- **诊断**：上一轮 #7 只改了 AI 消息的按钮行，用户消息按钮行（复制/存知识库）仍常显。
- **改法**：用户消息气泡容器加 `group`，按钮行（时间戳保留常显，仅按钮）加 `opacity-0 group-hover:opacity-100 transition-all`。
- **验收**：不悬停时用户气泡只显示时间戳，悬停显示复制/存知识库按钮。

---

## 三之补充 2：第 2.6 轮真机回归补丁（#11-#15）

> 第 2.5 轮修完后再测暴露的 5 个问题，均已修复。

### #11 权限卡选项在气泡悬停时变白
- **用户原文**：权限请求卡片出现，悬停出现气泡按钮的时候，权限请求的选项会变白。
- **诊断**：气泡容器用未命名 `group`，而 PermissionPromptBlock 选项按钮内部也用未命名 `group`/`group-hover:`（按钮悬停文字变白）。外层气泡 `group` hover 时，内层按钮的 `group-hover:text-white` 被外层的 group 触发 → 悬停气泡（不悬停按钮）选项文字也变白。
- **改法**：气泡容器改用**命名 group** `group/bubble`，按钮行用 `group-hover/bubble:opacity-100`；与权限卡按钮内部的未命名 `group`/`group-hover` 互不干扰（权限卡按钮自身悬停仍正常变白）。用户气泡同理。
- **验收**：悬停气泡只显示底部按钮；权限卡选项文字保持正常（黑字），只有真正悬停到选项按钮时才变白。

### #12 已作答权限卡残留"继续中"旋转
- **用户原文**：已完成的权限请求仍然有继续中在旋转，影响体验，这个继续中没什么必要。
- **改法**：删除 `PermissionPromptBlock` / `AskUserBlock` 已作答态里的"继续中…"spinner（只保留"已选择/已提交"）。
- **验收**：作答后卡显示"已选择：xxx"，无旋转"继续中"。

### #13 模型写 `> [permission]`（不带 !）→ 不弹卡，回复发完标记就停
- **用户原文**：ai 回复最后一句发了 `> [permission] 是否允许我下载上述资源并创建项目结构？...` 就停止回复了（按钮变回发送）；模型自述"确实尝试弹出权限询问卡，但卡片没成功弹出"。后来测试仍是 `> [permission]`，没有实际拉起来。疑问：之前不是调用工具做卡吗，怎么现在又用这个标记？
- **诊断**：`markdown_to_blocks` 交互正则只认 `> [!ask]`/`> [!permission]`（**必须带 `!`**），模型实际写的是 `> [permission]`（不带 `!`）→ 解析成普通 quote 块 → 不弹卡、正文只剩原文；该轮无工具调用 → 直接收尾 → 看起来"回复停了"。`_is_interactive_marker_prefix` / 前端 strip / isInteractiveMarkdown 也只认带 `!` 的。
- **改法**：四处置为兼容不带 `!` 的变体（`> [permission]` / `> [ask]`）：
  1. `core/message_types.py` 交互正则 `\[!(ask|permission)\]` → `\[!?(ask|permission)\]`（含块内分隔检测）。
  2. `main.py` `_is_interactive_marker_prefix` 增加 `> [ask` / `> [permission`。
  3. 前端 `stripInteractiveMarkdown` / `isInteractiveMarkdown` 正则加 `!?`。
  （工具调用→HITL 与 legacy 标记是两条路径：模型可能写标记而不调工具，框架必须两种都兜住；#15 已让 legacy 卡与工具卡行为一致。）
- **验收**：让模型用 `> [permission]` 写权限请求 → 弹权限卡可点击，不再"发完标记就停"。
- **测试**：`test_parts_model.py::test_interactive_marker_without_bang`。

### #14 用户气泡下方时间位置奇怪 → 与气泡左侧左对齐
- **用户原文**：用户气泡下的时间位置很奇怪，能不能让用户气泡下的时间始终与用户聊天气泡左侧左对齐？
- **改法**：用户消息 meta 行（时间+按钮）由 `justify-end` 改为 `justify-start`。
- **验收**：用户气泡下方时间与气泡左缘对齐。

### #15 交互卡挂起时按钮可点"停止"；停止后作答卡 AI 不续流
- **用户原文**：弹出权限申请的时候能点停止，正常弹出询问卡或权限卡的时候按钮是灰色的（这才对）。点了停止显示"已停止"，又点了拒绝，"已停止"消失了，但 AI 没有继续回复。第二次又没出现这问题；shell_exec 出现的卡片更稳定些，怀疑是 legacy 标记触发卡的问题。
- **诊断**：
  1. **按钮可点停止**：legacy 标记触发卡走 `rich_message interactive` 分支 → `pushCardToBubble` 但**没注册 `pushInteractiveCard`** → `hasPendingInteractive` 为 false → 按钮仍显示"停止"可点。
  2. **停止后作答卡不续流**：用户点停止 → `_stop_event.set()` → 作答卡后 `_stream_chat_background` 续流前 `_stop_event` 未清 → 下一轮 `_stream_once` 立即返回空 → 看起来"没继续"。`_pause_for_question` 有 `self._stop_event.clear()`，但 legacy 权限（`_await_legacy_permission`）和 gateway 工具路径没有。
  3. 前端：作答卡后 parts 到达但 `isGenerating` 仍 false → 按钮仍是"发送"。
- **改法**：
  1. 前端 `rich_message interactive` 分支：legacy 权限/询问卡也 `pushInteractiveCard`（按钮灰色禁用，禁止点停止）。
  2. 后端：`_await_legacy_permission` 拿到 choice 后 `self._stop_event.clear()`；gateway 工具执行完（权限已作答）也 `self._stop_event.clear()` → 续流继续。
  3. 前端 part 分支：收到新 part 且 `!isGenerating` 时恢复 `isGenerating=true` + `setReplying(true)`（停止后作答的续流恢复"回复中"态）。
  4. 发送按钮：`hasPendingInteractive` 时不再进入 `is-sending`（停止）态（`&& !hasPendingInteractive`），保持灰色禁用。
- **验收**：交互卡挂起时按钮灰禁用；停止→作答权限卡→AI 正常续流回复；legacy 标记卡与工具卡行为一致。

---

## 三之补充 3：第 2.7 轮（交互收敛 + 兜底）（#16-#20）

> 用户要求去掉 legacy 标记兜底（只用 clarify/工具），并对真机暴露的交互边界做了收敛。

### #16 不再向模型灌输 legacy 交互标记（> [!ask] / > [!permission]）
- **用户原文**：能不能直接不使用兜底标记了？`> [!ask]` `> [!permission]`，只使用 clarify 工具，或许不使用标记就真能解决问题。
- **诊断**：`INTERACTIVE_FALLBACK_GUIDE` 仍告诉模型"可以用 markdown 交互标记"，模型会偶尔写成 `> [!permission]` / `> [permission]`，触发 legacy 卡路径（比 clarify/工具卡更不稳定）。
- **改法**：`INTERACTIVE_FALLBACK_GUIDE` 改为只强调 clarify 工具提问 + 对应工具弹权限确认，**不再提及任何 markdown 交互标记**（`> [!ask]` / `> [!permission]` 等）。后端/前端的 legacy 标记解析**保留为兜底**（模型万一仍写也能弹卡，但提示词不再诱导）。
- **验收**：模型提问走 clarify 卡，授权走工具权限卡；不再出现 `> [!permission]` 原文卡。

### #17 卡挂起时发送按钮应显示灰色"停止"（而非灰色"发送"）
- **用户原文**：现在出现卡的时候按钮变成灰色的发送了，应该是灰色的停止。
- **诊断**：上轮给发送按钮加了 `&& !hasPendingInteractive` 从 `is-sending` 排除 → 卡挂起时按钮回退成"发送"态（灰的）。
- **改法**：`hasPendingInteractive` 时按钮仍进 `is-sending`（停止）态，但 `opacity-40 cursor-not-allowed` 保持（灰色不可点）。
- **验收**：权限/询问卡挂起 → 按钮显示灰色"停止"（不可点）；无卡且正在回复 → 正常彩色"停止"。

### #18 拒绝后模型继续调工具 → 不再"已中断"（MAX_TOOL_ROUNDS 6→20）
- **用户原文**：用户拒绝后直接中断吗？提示"用户拒绝了安装 Vite 的授权…让我检查一下当前环境是否有其他可用的构建工具"，然后 shell_exec「ls node_modules」显示"已中断"就停止回复了。
- **诊断**：拒绝后模型续流发出新工具调用（`ls node_modules`），但 `MAX_TOOL_ROUNDS=6` 被同轮 legacy 交互 + 多轮续流耗尽 → while 循环触顶退出 → 该 `pending_tool_calls` 未执行 → 前端 `settleRunningTools` 标 stopped → "已中断"，且没有续流文本。
- **改法**：`MAX_TOOL_ROUNDS` 6 → 20（防死循环上限仍在，但交互/工具多轮不再误触顶）。
- **验收**：拒绝后模型可继续尝试其它命令（弹对应权限卡），不再"已中断"直接停。

### #19 clarify 回执被当历史复读（模型下次把"用户已回答"当自己的话复读/编造）
- **用户原文**：让 AI 问问题→回答→思考时停止→再让它问问题，它回复 `[clarify] 用户已回答："…"="React"…`（不是我回答的内容），并没有弹卡。
- **诊断**：`extractMessageText` 把 clarify 工具的 output（`用户已回答：…`）拼进 assistant 历史文本（`[clarify] 用户已回答：…`）→ 下一轮模型把这段当成自己说过的话复读/续写，而不是重新调 clarify 弹卡。
- **改法**：`extractMessageText` 对 `p.tool === 'clarify'` 的 tool part **跳过**（不拼进历史/复制/导出）。用户真实回答仍通过 handleBatchQuestionSubmit 提交给后端，不影响当轮续流。
- **验收**：回答完询问卡后再问 → 模型重新弹 clarify 卡，不复读 `[clarify] 用户已回答：…`。

### #20 聊天窗口不持久化（测试环境说明）
- **用户原文**：聊天窗口现在没有持久化，每次重新打开之前的就没了，如果是测试故意的，那就保持就好。
- **说明**：当前前端消息存内存 store（测试演示用），刷新即清空。**保持现状即可**，不引入本地持久化。

---

## 三之补充 4：第 2.8 轮（记忆优化 + 检索工具）（#21-#24）

> 用户确认：先完善「记忆提炼优化 + 知识库/记忆工具」两部分；插件过程块/基础工具集/意图路由见「九、第 3 轮候选（未做）」。

### #21 询问卡可翻回重做（编辑已答页）
- **用户原文**：多道题的时候不能翻回去重做？必须新增提示词？
- **改法**：
  1. `AskUserBlock.vue`：新增 `editable` prop + 已提交态「编辑」按钮；`startEdit()` 把 `responded` 置回 false 并恢复上次选择，可重新作答。
  2. `AskUserGroupBlock.vue`：新增 `submit-all` 事件，全部题答完**一次性** emit 完整 answers 数组（不再是逐题 emit）；编辑重答后也走 submit-all 重发完整集。
  3. `ChatInterface.vue`：`handleGroupSubmitAll` 直接回传 `QUESTION_ANSWER {answers: [[..]]}` + 逐题标注 answered + 清除"已停止"残留；两处 AskUserGroupBlock 渲染点接 `@submit-all`。
- **验收**：多题询问卡翻页回到已答题 → 点「编辑」解锁重选 → 全部答完一次性提交。

### #22 记忆提炼时机：回复结束后 60s 用户未回复未操作才自动提炼
- **用户原文**：改成回复完了 60s 若用户未回复未操作再自动提炼；答交互卡后故意拖时间影响效率。
- **改法**：`ChatInterface.vue` 重构空闲计时——`resetIdleTimer()` 只负责**取消**待提炼计时；新增 `scheduleIdleExtract()`（60s）仅当 `!isGenerating` 时调度；`watch(isGenerating)`：生成开始→取消，生成结束→开始 60s 计时。移除了 finalize/pushAiRichReply/pushAiReply 三处会取消计时的 `resetIdleTimer()`。
- **验收**：回复结束后若用户 60s 无操作才提炼；回复/生成进行中不提炼。

### #23 关窗弹「要不要提炼」：10min 冷却 + 提炼/跳过都记冷却
- **用户原文**：关闭窗口自动提炼不可取；改成关窗弹窗提示，不管提炼不提炼，10min 内怎么点都不再弹，10min 后再弹；只有右键列表该条主动提炼。
- **改法**：`ChatInterface.vue` 移除永久 `suppressedClosePrompt`，改为 `closePromptCooldownUntil[convId]`（10min）。`requestBack`：autoMem 关 + 转录≥20 字 + 冷却已过 → 弹窗；`closePromptExtract`/`closePromptSkip` 都记冷却（提取也重置冷却，避免"刚提炼又弹"）。模板移除"不再提示"复选框。
- **验收**：关窗弹一次 → 10min 内再关窗不再弹（右键列表主动提炼仍可用）→ 10min 后再弹。

### #24 记忆通知 1s 折叠回铃铛 + 新增检索工具
- **用户原文**：自动提炼记忆左侧通知滞留太久，约 1 秒折叠即可；知识库后端打通 + 检索知识库/记忆封装成工具 + 拟人化。
- **改法**：
  1. `NotificationStack.vue`：`hideDelay()` 全为 memory 类 → 1000ms，否则 5000ms。
  2. 后端新增工具 `knowledge_query`（KnowledgeStore.search，按当前项目检索）与 `memory_search`（MemoryStore NIS_CORE scope 检索），schema 进 `GATEWAY_TOOL_SCHEMAS` + `NON_INTERACTIVE_TOOLS` + risk=low；`main.py` 注册 executor（`_knowledge_query_tool`/`_memory_search_tool`）。
  3. 前端 `toolPhrases` 补 `knowledge_query`/`memory_search` 拟人化文案（气泡同款 ToolPartBlock 渲染，带匹配结果摘要）。
- **验收**：让 AI 查"知识库里的 xxx"或"你记得之前…" → 气泡出现对应检索工具块（拟人化文案 + 结果摘要），不弹权限卡。

---

## 三之补充 5：第 2.9 轮（检索修复 + 记忆管理工具 + 去演示数据）（#25-#27）

### #25 FTS5 特殊字符转义（c++/c#/a+b 检索不再报错、不再慢）
- **用户原文**：AI 搜 c++ 相关记忆定位了 5 轮才找到，很慢；分析原因：FTS5 语法太脆弱，查询含特殊字符（+ / * 等）就语法报错；去掉特殊字符后空格分词才能正常搜。记忆系统本身没问题。
- **诊断**：`MemoryStore._normalize_query` 直接把 `c++` 原样拼进 `memory_fts MATCH` → FTS5 把 `+` 当操作符 → 语法报错（被上层吞掉→空结果→AI 反复换词重试）。`KnowledgeStore.search` 的 MATCH 分支同样问题（有 LIKE 兜底，但会降级慢+低精度）。
- **改法**：
  1. `core/memory/store.py::_normalize_query`：每个词用双引号包裹（`"c++"`）+ 引号内双写 `"`，多词 `OR` 连接 → 特殊字符按字面量安全匹配。
  2. `core/knowledge/store.py`：新增 `_escape_fts()` 同策略，MATCH 分支用转义后的查询。
- **验收**：AI 搜 `c++`/`c#`/`a+b` → 直接命中，不再 5 轮重试。

### #26 记忆/知识库管理工具（编辑 + 删除）
- **用户原文**：需要给 AI 一个记忆和知识库的编辑、删除工具；让 AI 删 c++ 那条，它找到了但找不到合适工具删除。
- **改法**：后端新增 4 个工具并注册到 gateway：
  - `memory_delete(memory_id)`、`memory_update(memory_id, content)` → 调 `MemoryStore.change_state(SOFT_DELETED)` / `update`；
  - `knowledge_delete(entry_id)`、`knowledge_update(entry_id, content?, title?)` → 调 `KnowledgeStore.delete/update`；
  - schema 进 `GATEWAY_TOOL_SCHEMAS`，risk=medium（弹权限卡）；`memory_search`/`knowledge_query` 结果带 `[id=…]` 供 AI 拿到 id。
  - 前端 `toolPhrases` 补 4 个管理工具的拟人化文案。
- **验收**：AI 搜到记忆 → 调 memory_delete/memory_update（弹权限卡）→ 生效。

### #27 前端知识库移除演示数据
- **用户原文**：知识库是空的，把演示数据理掉吧。
- **改法**：`src/stores/knowledge.ts` `load()` 不再 fallback 到 `demoEntries()`（改为空数组）；`STORAGE_VERSION` 5→6 让旧 localStorage 演示数据下次加载被清掉。后端 `_knowledge_store` 本就无种子数据（仅测试写入）。
- **验收**：打开知识库面板 → 初始为空（无演示条目/分类）。

---

## 三之补充 6：第 2.10 轮（记忆写入查重 + 来源标记 + memory_add）（#28-#30）

> 用户确认"先这么改"：记忆提炼查重合并 + source_type 赋值 + AI 主动记忆工具。

### #28 MemorySourceType 来源枚举
- `core/memory/models.py` 新增 `MemorySourceType`：`user_explicit`（用户明说）/ `user_implicit`（行为推断）/ `system_infer`（系统提炼）/ `system_observed`（工具观察）/ `imported`。
- 提炼写记忆 → `system_infer`；`memory_add` → `user_explicit`（用户明说优先）。
- `Memory.source_type` 字段本就存在（`Optional[str]`），现在开始有值。

### #29 提炼落库前查重合并（自动/手动同链路）
- `DistillEngine.distill` 写 `memory_records` 前调 `_find_duplicate`：同作用域 + 同类型下，内容相同或"同标题 + 内容开头相似" → 命中。
- 命中 → `store.update` 更新旧记忆内容（不新增），返回 `dup_merged=True`，`memory_nodes` 同标题节点也更新而非重复插。
- 自动提炼（60s 空闲）与手动提炼（右键）都走 `extract_and_persist → distill.distill`，同链路生效。
- 测试：`tests/test_project_memory.py` 新增 `test_distill_dedup_merges_duplicate` / `test_distill_source_type_inferred`。

### #30 memory_add 工具（AI 主动写记忆）
- 后端新增 `memory_add(content, memory_type?)`：写前查重（同内容直接返回"已存在"；相似则更新旧记忆并标 user_explicit），否则新建（user_explicit，置信 0.95）。
- schema 进 `GATEWAY_TOOL_SCHEMAS`，risk=medium（弹权限卡）；注册到 gateway。
- 前端 `toolPhrases` 补 `memory_add` 拟人化文案。
- 用户说"记住我喜欢 X / 以后都…" → AI 调 memory_add → 弹权限卡 → 落库。

---

## 三之补充 7：第 2.11 轮（memory_add 同步记忆星系）（#31）

- **用户原文**：让 AI 记住的东西，在前端记忆星系中找不到，或许是记录没做格式限制？
- **诊断**：`memory_add` 只写 `memory_records`（结构化记忆），**没写 `memory_nodes`**；而前端记忆星系（MemoryGraphModal → MEMORY_GRAPH_REQUEST → `MemoryGraph.get_graph`）读的是 `memory_nodes` 表 → records 有、星系看不到。
- **改法**（`main.py`）：
  1. 新增 `_sync_memory_node(title, content, node_type, memory_id)`：写入/更新 `memory_nodes`（scope=global，`md_section` 绑定 memory_id 溯源；同标题已有节点则更新）。
  2. `_memory_add_tool`：新建和查重更新两条路径都调用它。
  3. `_memory_delete_tool`：删除时按 `md_section`/标题停用（`toggle_node enabled=False`）关联星系节点。
- **测试**：`tests/test_ws_project_handlers.py::test_memory_add_tool_syncs_graph_node`。
- **验收**：让 AI 记住某喜好 → 打开记忆星系 → 能看到该节点；删除后星系中该节点停用。

---

## 三之补充 8：第 2.12 轮（记忆标题/查重/FTS 修复 + 星系去重）（#32）

- **用户原文**：①记忆标题很长且跟正文一样，应简短利于检索；②两个窗口记同内容（措辞略不同）→ 记忆库两条；③关窗提炼出现 3 条同内容。
- **诊断**：
  1. 标题长：`_sync_memory_node`/`distill` 用 `content[:60]` 或原始 title，标题≈正文。
  2. 查重弱：`memory_add`/`distill` 用前缀匹配（`content[:30] in ...`），不同措辞同内容漏检。
  3. 重复来源：`global_memory.append_entry` 无条件追加 .md（无查重）；`extract_and_persist` 同时写 records（查重）+ .md（不查重）→ 双份；星系 `get_graph` 用 `enabled_only=False` 把停用节点也显示 → 3 条。
  4. **深坑**：`store.update` 更新含内容时，FTS5 外部内容表（trigram 分词器）的 UPDATE 触发器直接 `UPDATE memory_fts SET content=...` → 索引损坏 → `database locked / malformed`。合并查重路径触发该 bug。
- **改法**：
  1. 新增 `core/memory/text_utils.py`：`short_title()`（去口语废话前缀，≤20 字）+ `normalize_text()` + `text_similarity()`（LCS 占比）+ `is_duplicate()`（≥0.45）+ `_search_hint()`（英文词/中文 4 字预筛）。
  2. `distill._find_duplicate`：改用 `is_duplicate`（LCS）查重，预筛词用 `_search_hint`；存储 content 不再拼 `[title]` 前缀（title 由 memory_nodes 承担）。
  3. `distill.distill` / `_memory_add_tool` / `_sync_memory_node`：title 走 `short_title`。
  4. `global_memory.append_entry`：写前对文件内条目 `is_duplicate` 查重，重复跳过。
  5. **FTS 触发器修复**（`schema.py`）：`memory_fts_update`/`mnode_fts_update`/`delete` 改为"先删后插"（`INSERT INTO fts(fts, rowid, ...) VALUES ('delete', ...)`），避免 trigram UPDATE 损坏索引；`init_db` 里 `_rebuild_fts_triggers` 先 DROP 旧触发器再按新 SCHEMA 重建（存量库生效）。
  6. `MemoryGraph.get_graph`：`enabled_only=True`，停用/重复合并节点不再展示。
  7. 存量库去重：对 `.nis_data/memory_system.db` 按同类型+同作用域+`is_duplicate` 软删除 342 条重复 records、停用 4 个重复 nodes；长标题 backfill 为 short_title。
- **测试**：`test_project_memory.py` 新增 `test_distill_dedup_similar_wording`（不同措辞同内容合并）+ `test_global_memory_append_dedup`（.md 不重复追加）。
- **验收**：①AI 记住喜好 → 星系标题简短；②两个窗口记同内容 → 只 1 条；③多次提炼 → 同一条更新不新增。

---

## 三之补充 9：第 2.13 轮（关窗提炼重复 + 关键词查重增强）（#33）

- **用户原文**：AI memory_add 好了；但关闭窗口的提炼仍会产生重复记忆。
- **诊断**：`extract_and_persist` 里 `project_memory.append_section`（pitfall/pattern/progress 类）**无查重**，无条件追加；且提炼 LLM 每次措辞/详略不同（如"前端开发中不喜欢emoji图标" vs "用户不喜欢在网页使用 emoji 表情符号…"），纯 LCS 相似度（0.18）低于阈值漏检。
- **改法**：
  1. `project_memory.append_section`：写前对文件内条目 `is_duplicate` 查重（与 global_memory.append_entry 一致）。
  2. `text_similarity` 增强：除 LCS 外，若两文本**共享显著英文/数字词**（≥3 字符，如 emoji/typescript/vue）且 LCS≥0.15 → 计 0.82 强信号（措辞差异大但核心词相同也命中）。dedup 调用处均按 memory_type 过滤，跨类型"Vue是框架"vs"用Vue开发"不会误合并。
  3. 存量库再清 35 重复 records + 6 个重复节点；全库 active 记录现 33 条、0 重复。
- **验收**：关闭窗口提炼同一段对话两次 → 记忆库里同一条更新不新增（含不同措辞）。

---

## 九、第 3 轮候选（未做）

> 用户明确"帮我记住未做的地方"。以下均**未实现**，留给后续轮次，改动前先讨论方案。

- ~~**记忆来源/可信度语义化**~~ → **已做 #28**（枚举已建、提炼/memory_add 已打 tag）。剩余：检索结果显示"可信:高/中/低"、冲突排序用 source_type（user_explicit 优先）、`user_implicit`/`system_observed`/`imported` 等入口尚未接线。
- ~~**记忆写入工具（AI 主动记忆）**~~ → **已做 #30**（memory_add）。
- ~~**重复提炼/重复写入处理**~~ → **已做 #29**（distill 查重合并）。剩余：`memory_add` 与提炼之外其它写入入口（如 `_ws_handle_memory_graph` 直接 add）未统一走查重；可考虑抽公共 `upsert_memory` 函数统一。
- **基础工具集扩充**：read_file / write_file / list_dir / search_file / fs_delete / move_rename / file_grep / web_search / web_fetch / run_tests / lint / browser_open/screenshot/click/read_dom / screenshot / clipboard_read/write / notify / http_get / http_post / read_calendar / create_event / open_app / task_plan / todo_update。均需：tool_schemas schema + risk 分级 + main.py 注册 + 前端 toolPhrases 拟人化文案（气泡显示同款 ToolPartBlock）。
- **插件单独过程块 + 声明式注册**：`PluginPartBlock.vue`（复刻 ToolPartBlock，仅进行中动画换一种，如绿色/不同 icon）；`plugins/` 目录声明式注册（name/description/params/risk/executor）启动扫描，免改 main.py。前端按 `part.plugin` 或工具名前缀路由到 PluginPartBlock。
- **意图路由 + 参数提取层**（nis 自述"无独立工具路由，完全靠模型判断"）：架构级改动，opencode 式"自然语言意图 → 框架决定工具"，与本轮体验问题不同维度，未做。
- **记忆读取更多**：除已做的 memory_search/knowledge_query 外，可考虑 memory_add / note_take（主动存记忆）等。
- **工具路由当前实现**：模型直接调工具名 → ToolGateway.execute → GateKeeper.secure_call（权限检查+执行）。无意图/参数提取层。

---

## 四、关键代码地图（用 Grep 按方法名定位，行号会漂移）

**后端 `main.py`**：
- `INTERACTIVE_FALLBACK_GUIDE` / `BLOCKS_OUTPUT_GUIDE`（提示词，#3/#5；#16 去 legacy 标记）—— **#3 #5 #16**
- `_choice_means_deny`（拒绝语义判定，#5）
- `MAX_TOOL_ROUNDS`（20，#18）
- `_knowledge_query_tool` / `_memory_search_tool`（检索工具 executor，#24）
- `_memory_add_tool` / `_memory_delete_tool` / `_memory_update_tool` / `_knowledge_delete_tool` / `_knowledge_update_tool`（记忆/知识库管理工具，#26 #30）+ `_sync_memory_node`（#31）
- `_ws_handle_chat`（每窗口模型 + `_chat_stream_tasks` 取消旧任务，#2/#5）
- `_stream_chat_background`（agent loop：on_chunk 交互标记缓冲含 `> [card`/`> [ask`/`> [permission` / `_append_round_text` / 工具+legacy 循环 / legacy 交互优先清空同轮 tool_call / 权限作答后 `_stop_event.clear()` / 注入 chat_messages / 收尾）—— **#1 #2 #3 #4 #5 #13 #15** 主战场
- `_pause_for_question`（无超时等待 + 忽略/未作答清晰消息）—— **#3 #5**
- `_await_legacy_permission` / `_ws_handle_chat_interact` / `_ws_handle_question_answer` —— **#5 #15**（`_await_legacy_permission` 作答后清 `_stop_event`）
- `_ws_handle_auto_title`（标题提炼）
- `_build_llm_fn` / `_ws_handle_test_connection`

**后端 `core/message_types.py`**：`markdown_to_blocks` 的 card / interactive 分支（含 `> [permission]` 不带 ! 兼容）+ `_card_title_suggests_permission` —— **#1 #13**
**后端 `core/tool_schemas.py`**：`build_chat_tools` / `GATEWAY_TOOL_SCHEMAS`（含 knowledge_query/memory_search 及 delete/update）/ `NON_INTERACTIVE_TOOLS` —— **#24 #26**
**后端 `permission/policy_engine.py`**：`RISK_MAP`（knowledge/memory 检索 low、管理 medium）—— **#24 #26**
**后端 `core/memory/store.py`**：`_normalize_query`（FTS5 转义，#25）
**后端 `core/memory/models.py`**：`MemorySourceType`（#28）
**后端 `core/memory/distill.py`**：`_find_duplicate` 查重合并（#29）
**后端 `core/knowledge/store.py`**：`_escape_fts`（FTS5 转义，#25）
**后端 `permission/gate_keeper.py`**：`secure_call` / `_store_grant_for`（按工具授权）—— **#5**
**后端 `permission/grant_store.py`**：`find_valid_grant`（按 tool/window/agent/scope）
**后端 `network/ws_bridge.py`**：`hitl_request`（card_meta）/ AUTO_TITLE 路由

**前端 `ChatInterface.vue`**（~4300 行）：
- `handleWebSocketMessage`（part/HITL_REQUEST/QUESTION/rich_message/chat_error/text）—— **#1 #3**
- `pushCardToBubble` / `markPartAnswered` / `onPanelHitlResponse` / `onPanelQuestionSubmit` / `onPanelQuestionIgnore` / `clearStoppedState` —— **#3 #5**
- `extractMessageText` / `stripInteractiveMarkdown` / `isInteractiveMarkdown` —— **#1 #5 #19**（clarify tool part 跳过历史）
- `isReplyingNow` / `stopGeneration` / `settleRunningTools` / `hasActiveTools` / `refreshReplying` / `finalizeAiReply` / `pushPendingAiReply` —— **#2 #3**
- `scrollToLatest` / `scrollToBottom` / `onActivated`（KeepAlive 滚动）
- 发送按钮模板（`send-btn` + `is-sending`）—— **#2**
- AI 气泡操作按钮行（复制/知识库/锚点）—— **#7**
- `blocks/ToolPartBlock.vue`（isActive 含 `!stopped`；realDuration）—— **#2 #6**
- `blocks/LiveTimer.vue`（格式化）—— **#6**
- `blocks/MessageBlocks.vue`（流式 raw 分支排除 permission_prompt/ask_user/partner_recommend，避免交互卡被隐形渲染）—— **#8**
- `utils/formatDuration.ts`（Xh Ym Zs 格式化）—— **#6**
- `blocks/PermissionPromptBlock.vue` / `blocks/AskUserBlock.vue`（已作答态显示"已选择"，无"继续中"；editable 编辑重做）—— **#4 #12 #21**
- `blocks/AskUserGroupBlock.vue`（分页 + submit-all 一次性提交）—— **#21**
- `stores/providers.ts`（getConvModel/setConvModel）
- `stores/conversations.ts`（ensureAutoTitle/applyTitle）
- `stores/notifications.ts` + `NotificationStack.vue`（推荐卡/任务通知按项目/会话过滤隔离；memory 通知 1s 折叠）—— **#24**
- `stores/knowledge.ts`（知识库 store；演示数据已移除，空启动）—— **#27**

---

## 五、验证流程（每改一批就做一遍）

1. 后端：`cd E:\nis+gork\nis内核\src-python && python -m pytest -q -k "chat_agent_loop or stream_tool_calls or message_types or ws or grant or gate or auto_title"`（改完相关再全量 `pytest -q`）
2. 前端：`cd E:\nis+gork\nIs ui 4.0\nis-ui && npm run build`
3. 重启后端（第一节流程），浏览器 Ctrl+F5
4. 真机按第三节逐项验收（重点 #1 #2 #3 #5）
5. 看日志：`nis_server.log.err` 里 `tool_call` / `question request=` / `静默轮` / `auto-title` / `HITL_RESPONSE` 顺序是否符合预期

---

## 六、铁律（必须遵守）

1. 绝不用 PowerShell `Set-Content`/`Get-Content` 重写含中文的 .py/.vue/.ts（GBK 双重乱码）。读用 Read、写用 Edit/Write；脚本改文件用 `python -c "open(p,encoding='utf-8')..."`。
2. WS 收统一入口：全局 `App.vue handleGlobalMessage`；聊天 `ChatInterface.handleWebSocketMessage`。别加第三入口。
3. i18n：新文案加 `utils/i18n.ts` zh+en。
4. TDZ：watch/computed 里访问的 store/ref 声明在文件前部。
5. 后端改完必须走第一节重启流程；前端硬刷新 + `npm run build`。
6. 行号会漂移，用 Grep 按方法名定位。
7. 别删 `opencode-ref`；别动 `后端源码备份`。
8. **交互卡在气泡里（不在输入框上方）**；**历史上下文已清洗（stripInteractiveMarkdown + 工具输出截断）**；**每会话流式任务互斥**——改这些相关逻辑时保持兼容。

---

## 七、给新窗口的第一句建议

第 2 轮的 7 个问题**已全部修完**（第三节逐条有「已修复」说明 + 新测试），第 2.5 轮补丁 #8 #9 #10、第 2.6 轮补丁 #11-#15、第 2.7 轮收敛 #16-#20、第 2.8 轮记忆优化+检索工具 #21-#24、第 2.9 轮检索修复+管理工具 #25-#27、第 2.10 轮记忆写入查重+来源标记 #28-#30、第 2.11 轮 memory_add 同步星系 #31、第 2.12 轮标题/查重/FTS/星系去重 #32、第 2.13 轮关窗提炼重复+关键词查重 #33 也已修复（见"三之补充"至"三之补充 9"）。新窗口接手前先跑
`cd E:\nis+gork\nis内核\src-python && python -m pytest -q`（844 通过）+ `cd E:\nis+gork\nIs ui 4.0\nis-ui && npm run build` 确认基线仍绿，再按第三节 + 三之补充的验收清单在真机上快速回归一遍（重点 #8 权限卡立即显示可点击、#11 卡选项不因气泡 hover 变白、#16 模型只用 clarify/工具不再写标记、#17 卡挂起按钮灰"停止"、#18 拒绝后工具调用不再"已中断"、#19 不复读 clarify 回执、#15 停止后作答能续流、#21 询问卡可翻回重做、#22/#23 记忆提炼时机与关窗冷却、#24 检索工具+1s 折叠、#25 c++ 检索直接命中、#26 记忆/知识管理工具、#27 知识库空启动、#28-#30 记忆写入查重+来源标记+memory_add、#31 AI 记住的喜好星系可见、#32 标题简短/同内容合并/星系无重复、#33 关窗提炼不再重复），确认无回退即可。**第 3 轮候选（未做）见「九」**：基础工具集扩充、插件单独过程块+声明式注册、意图路由+参数提取层、记忆检索可信度显示与冲突排序。敏感区：**交互状态注入（#5）、停止/进行态（#2/#3/#15）、交互标记识别（#1/#13 兜底保留但提示词不再诱导）、MessageBlocks 流式分支排除交互卡（#8）、气泡命名 group（#11）、MAX_TOOL_ROUNDS（#18）、记忆提炼计时（#22/#23）、FTS5 转义（#25）、记忆查重合并（#29）、FTS 触发器（#32 先删后插，勿改回直接 UPDATE）、查重相似度（#33 关键词强信号勿误伤）**，改动前先看诊断/改法，别破坏三保险（后端缓冲 + 前端 strip + groupBlockGroups 过滤）。
