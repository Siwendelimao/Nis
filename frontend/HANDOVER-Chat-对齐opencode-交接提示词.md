# NIS 聊天功能对齐 opencode — 交接提示词（新窗口直接开始）

> 本文件是给**下一个 AI 会话**的完整交接。读完即可无缝接替，无需重新调研。
> 目标：**把所有"严重等级高"和"体验差"的项全部修复，保证聊天功能一切正常、不再出 bug**，然后才能继续推伙伴/后台任务。

---

## 〇、你现在的任务（唯一目标）

当前 NIS 聊天功能已按 opencode 架构完成大部分移植，但仍残留**过渡性兜底和架构差异**，导致权限/询问卡反复出"重复/乱序/续写位置"bug。你的任务：

1. **按第七节清单把所有待办全部修完**（严重高 → 体验差，逐项验收）
2. 修复后**完整回归**（后端 pytest 全量 + 前端 build + 真机日志确认）
3. 保证聊天功能稳定，再考虑推进别的

---

## 一、项目路径与环境（必须记住）

| 项 | 值 |
|---|---|
| 后端源码 | `E:\nis+gork\nis内核\src-python`（main.py 主入口，run_server.py 常驻启动） |
| 前端源码 | `E:\nis+gork\nIs ui 4.0\nis-ui`（Vue 3 + Vite，dev server :5173 HMR） |
| opencode 参考源码 | `E:\nis+gork\nIs ui 4.0\opencode-ref`（TS/Effect，**只参考机制与 schema，别抄代码**） |
| 原移植方案 | `E:\nis+gork\nIs ui 4.0\nis-ui\HANDOVER-OPencode-移植方案.md` |
| 后端备份 | `E:\nis+gork\nIs ui 4.0\后端源码备份`（194 .py 全量，改坏可回退） |
| 运行日志 | `C:\Users\Administrator\AppData\Local\Temp\opencode\nis_server.log`（stdout）+ `nis_server.log.err`（**stderr，chat-stream 诊断日志在这**） |
| 临时脚本目录 | `C:\Users\Administrator\AppData\Local\Temp\opencode\` |

**后端必须用这个解释器启动**（uv 基础 python 缺 filelock）：
```
C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe
```

---

## 二、启动/重启后端流程（每次改后端都走这套）

```powershell
# 1) 停旧进程
$p = Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
# 2) 删旧日志（保证干净；进程停掉后才能删）
$log = "C:\Users\Administrator\AppData\Local\Temp\opencode\nis_server.log"
$logErr = "C:\Users\Administrator\AppData\Local\Temp\opencode\nis_server.log.err"
Remove-Item -LiteralPath $log,$logErr -Force -ErrorAction SilentlyContinue
# 3) 启动
Start-Process -FilePath "C:\Users\Administrator\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe" `
  -ArgumentList "run_server.py" -WorkingDirectory "E:\nis+gork\nis内核\src-python" `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $logErr
# 4) 等 8-10s，验证监听
Get-NetTCPConnection -State Listen -LocalPort 8765
```

注意：`Start-Process` 有时会打印 `ChildProcess.kill` 之类的 PowerShell 噪音错误，**进程其实启动了**，别被吓到，看端口/日志为准。日志里出现 `[NisEngine] READY (persistent)` = 成功。

**前端不用重启**：Vite dev server（:5173）HMR，改完浏览器硬刷新（Ctrl+F5）即可；用 `npm run build` 验证编译。

---

## 三、当前已完成进度（防止回退，逐条核对）

> ✅ **2026-08-11 更新：第七节 #1~#10 已全部完成**，全量回归通过（后端 819 pytest / 前端 build）。详见第七节逐项记录。下方为既有进度汇总。

### 后端（已完成）
- **Part 消息模型**：`core/message_types.py` 新增 Part dataclass（text/reasoning/tool/step-start/step-finish/permission_prompt/ask_user/content）+ `blocks_to_parts`
- **stream_chat 工具调用解析**：`core/api_router.py` `stream_chat` 解析 `delta.tool_calls` → `on_tool_call(name, args, call_id)` 回调
- **工具 schema**：`core/tool_schemas.py`（`CLARIFY_TOOL` + gateway 工具映射 + `build_chat_tools` + `tool_args`）
- **agent loop**：`main.py` `_stream_chat_background` —— while 循环统一处理（工具调用 + legacy 交互），**同一轮续流、不递归**；每轮广播 `part` 增量；结束时广播 `rich_message{parts,blocks}` + `text final`
- **权限框架触发**：工具执行经 `gateway.execute` → `gate_keeper.secure_call` → 中/高风险 `hitl_request`（广播 HITL_REQUEST，带 `conversation_id` + `card_callback` 记录权限卡到 body_parts）→ 挂起 → 用户选择 → 执行/拒绝（拒绝返回错误给 LLM 绕道）
- **clarify 询问**：`_pause_for_question`（广播 QUESTION 批量 questions[] → `_pending_questions` future 挂起 → QUESTION_ANSWER 唤醒）；`_ws_handle_question_answer` 非 chat 链路转发 NisBrain
- **legacy markdown 交互**：`> [!ask]` / `> [!permission]` 解析，在 loop 内用 `round_interactive_blocks`（**只本轮**，避免历史卡重复广播）处理；`_await_legacy_permission` 只广播本轮权限块
- **reasoning part**：带 `done/title/duration` 字段
- **权限卡记录**：`_card_cb_async` / `_pending_cards_by_call` 把权限卡追加进最终 body_parts（跟在工具 part 后）
- **grant 持久化**：`permission/grant_store.py` SQLite（重启加载 always 授权）
- **ws_bridge**：`hitl_request` 支持 `conversation_id` + `card_callback`
- **日志**：`run_server.py` 加 `logging.basicConfig(level=INFO)`，chat-stream 诊断日志落 `log.err`
- **自定义 provider base 回退**：`_build_llm_fn` 和 `_ws_handle_test_connection` 在 base 缺失时回退当前已选模型（同 provider）的 base —— 修复了 longcat 报 `litellm Provider NOT provided`（longcat 必须走 `openai/{model}` 分支）

### 前端（已完成）
- `Message.parts` + `Part` 接口
- `handleWebSocketMessage` 处理 `part` 增量（text/reasoning/tool 累积），`usesParts` 守卫跳过旧通道
- `pushPendingAiReply` 初始 `Reasoning.` 占位（不让用户干等）
- **final 不再整体替换 parts**：前端流式累积的 parts 是唯一真相，`rich_message` 只标记完成
- reasoning done 遍历所有 reasoning part 标记完成
- 交互卡出现 `scrollToCard()`（scrollIntoView 到卡元素）
- `AskUserBlock`：多选（checkbox）、`answered/answeredValue` 保留已答、输入框带 `+` 标识
- `AskUserGroupBlock`：分页点移到卡片右上角、AskUserBlock `:key=page` 重建
- 权限/询问卡纯白去线
- 动画组件：`OrbLoader`（composing 思考飘带环 / working 细线地球）、`CheckCircleAnim`（check/ban 一次性动画）、`GlowText`（扫光）、`LiveTimer`（秒表）
- 工具拟人化文案库（`partToolDesc` + `toolPhrases` + `descCache`）
- `/test 回复` 演示重写（新动画 + 权限卡 + 多页询问卡 + 多选题）
- 旧聊天过程块渲染（thinking/search/tools/write/review/...）已从聊天模板删除（后台任务视图的独立渲染保留）
- `extractMessageText` parts 兼容

### 测试（基线）
- 新增：`tests/test_chat_agent_loop.py`、`tests/test_parts_model.py`、`tests/test_stream_tool_calls.py`、`tests/test_grant_store.py`
- 全量 pytest 通过（819，含 #3 新增 3 条 tool_choice / 系统提示词测试）

---

## 四、用户真机测试反馈（重要，验证标准）

- ✅ 权限申请、询问卡能弹、续写基本通
- ✅ `/test 后台任务`、`/test 权限询问` 正常（隔离验证通过）
- ✅ 创建项目模型测试报 `litellm Provider NOT provided` → **已修**（base 回退）
- ⚠️ `/test 伙伴` 需**项目窗口 + 曾忽略过推荐通知**才触发（前提正确）
- ⚠️ **推荐卡样式异常**：`partner_recommend` block 在 MessageBlocks **没有渲染分支**（展开态空、折叠态一行摘要）——历史缺陷，**已修**（见清单 #10）
- 模型是 **longcat / LongCat-2.0 / base=https://api.longcat.chat/openai**，**不产生 `delta.tool_calls`** → 走 legacy markdown 交互兜底。**#3 已改代码层**（提示词工具优先 + tool_choice=auto），但**真机验收需 API Key**：log 出现 `tool_call name=clarify` 即通；若仍不通则走 `_stream_once` 无 tools 降级 + markdown 兜底。

---

## 五、opencode 参考机制速览（对照用）

- **消息/Part**：`opencode-ref/schema/session-message.ts`（Message{role, content:Part[], time} + ToolPart 状态机 pending/running/completed/error + time.created/ran/completed）
- **事件**：`schema/session-event.ts`（message.updated / message.part.updated / message.part.delta）
- **权限**：`permission/index.ts`（evaluate 规则 deny/allow/ask → Deferred 挂起 → reply once/always/reject → reject 抛错 LLM 绕道；always 记入 approved 规则）
- **询问**：`question/index.ts`（ask 批量 questions[] → 挂起 → reply answers[] → 工具返回"用户已回答"给 LLM）；`question_tool.ts`（工具定义）
- **渲染**：`tui/session-index.tsx`（PART_MAPPING → TextPart/ToolPart/ReasoningPart；工具按类型分派 Shell/Read/Grep/Glob/WebSearch/Write/Edit/Task 专属组件；pending 显示 `~ 描述`、running Spinner、completed 摘要、error 红+可展开+拒绝删除线）
- **权限/询问卡**：`tui/permission.tsx` + `tui/question.tsx` —— **独立于消息流渲染**（footer 上方），pending 时禁用输入

**opencode 最关键的架构差异（我们 bug 的根源）**：权限/询问卡是**独立事件 + 独立 UI 层**，**不在消息 parts 里**。我们目前把卡塞进消息流 → 重复/乱序/续写位置 bug。见待办 #2。

---

## 六、铁律（必须遵守，否则文件乱码/踩坑）

1. **绝不用 PowerShell `Set-Content`/`Get-Content` 重写含中文的 .py/.vue/.ts**（GBK 双重乱码）。读用 `Read`、写用 `Edit`/`Write` 工具。必须脚本改时：用 `python -c "open(p,encoding='utf-8').read()/write()"`（UTF-8，已多次安全使用）。
2. WS 收统一入口：全局 `App.vue handleGlobalMessage`；聊天 `ChatInterface.handleWebSocketMessage`。别加第三入口。
3. i18n：新文案加 `utils/i18n.ts` zh+en（缺 key 时 `t()` 返回 key 本身，别依赖）。
4. TDZ：watch/computed 里访问的 store/ref 声明在文件前部；`immediate:true` watch 同步访问后部 ref 会抛错。
5. 后端改完必须走第二节重启流程；前端改完硬刷新 + `npm run build`。
6. 测试命令：`cd E:\nis+gork\nis内核\src-python && python -m pytest -q -k "chat_agent_loop or question or message_types or ws or task or parts_model or stream_tool_calls or grant_store"`
7. 行号会漂移，交接文档里的方法名/函数名为准，用 Grep 定位。
8. 别删 `opencode-ref`（参考用）；别动 `后端源码备份`。

---

## 七、待办清单（✅ 已全部完成，2026-08-11 回归通过）

### 严重等级：高（正确性/稳定性，bug 根源）

**#1 统一事件通道 —— 砍掉双通道广播 ✅**
- 改：`on_chunk` 只广播 `part kind=text`；`on_reasoning` 只广播 `part kind=reasoning`；`_broadcast_reasoning_done` 只广播 reasoning done。`text final` 保留作收尾完成事件。
- 前端 `text` 非 final 分支保留（**nis_brain 仍广播无 final 的 text**，别删）；`PARTNER_REASONING` 前端分支已删（后端 `on_partner_reasoning` 无任何调用方，纯死代码）。
- 验收：真实对话无重复文本/思考；测试全绿。

**#2 交互卡独立层 —— 权限/询问卡从消息 parts 剥离 ✅**
- 改：后端不再把权限卡/询问卡写进 `body_parts`（删 `_card_cb`/`_pending_cards_by_call`/`_ask_cards_from_clarify` 记录逻辑）；`gateway.execute` 不再传 `on_card`；`ws_bridge.hitl_request` 新增 `card_meta`（tool/risk 随 HITL_REQUEST 广播）。
- 前端：`HITL_REQUEST`/`QUESTION`/`rich_message interactive`（legacy 权限块）一律进「独立交互面板」（输入框上方 `data-interact-panel`，含权限 4 按钮 / 询问多卡翻页批量提交 / 遗留 chat_interact_ 选择），**不再 push 进 msg.parts/blocks**；面板 pending 时禁用输入框 + 发送按钮；消息流只含 reasoning/text/tool。
- 删了 `scrollToCard`/`data-ask-card`/`cardPartWithConv`/`isAskGroupStart`/`askGroupBlocks`。
- 协议不变：HITL_RESPONSE / QUESTION_ANSWER / CHAT_INTERACT_RESPONSE 照旧。
- 测试：`test_final_parts_include_permission_card_after_tool` → 改为 `test_final_parts_exclude_permission_card_after_tool`（断言卡不在 parts）；clarify 同理。

**#3 tool_calls 打通 longcat（或明确能力） ✅（代码级；真机需 API Key）**
- 根因：系统提示词把 `> [!ask]`/`> [!permission]` markdown 作为首选交互方式，推理模型（LongCat-2.0）倾向用 markdown 而非工具。
- 改：
  1. `BLOCKS_OUTPUT_GUIDE` 移除 `> [!ask]`/`> [!permission]` 两行；新增 `INTERACTIVE_FALLBACK_GUIDE`（**优先 clarify/权限工具，markdown 标记仅作兜底**），chat 系统提示词用两者拼接。
  2. `stream_chat` 带 tools 时显式 `tool_choice="auto"`（部分供应商/推理模型不显式传则不返回 tool_calls）。
- legacy 解析（`markdown_to_blocks` interactive 分支 / `_append_round_text` / `_await_legacy_permission`）**保留为纯保险**，不再进系统提示词。
- 注意：本机无 longcat API Key，**未能真机 A/B 抓请求体**；验收须用真实 key 在真机测（log 应出现 `tool_call name=clarify`）。若 longcat 仍不返回 tool_calls，`_stream_once` 的"去掉 tools 降级重试"会兜底。

**#4 `extractMessageText` 排除 reasoning ✅**
- 改：默认排除 reasoning，新增 `opts.includeThinking`（默认 false）。导出 Markdown/复制/记忆提炼/`buildChatHistory`/列表预览全部不再含思考内容。

**#5 对话列表预览补字 ✅**
- 改：`finalizeAiReply` 收尾用 `extractMessageText(msg)` 更新列表预览（排除 reasoning）；`pushAiRichReply` 在 blocks 为空时用 parts 文本兜底。避免空 `text final` 导致预览空白。

### 严重等级：中（体验层）

**#6 工具专属渲染组件 ✅**
- 新建 `blocks/ToolPartBlock.vue`：shell_exec 显示 `$ command` + 等宽可折叠输出块；code_search/grep 显示匹配数；read/diff_edit 显示文件路径；保留 OrbLoader Spinner / CheckCircleAnim 完成勾 / 出错红叉，细节按钮展开输入/输出/错误。替换 ChatInterface 内联工具行。

**#7 ToolPart 时间戳 + 消息级耗时/费用 ✅**
- 后端：工具 part 广播带 `created`（LLM 发调用）/`ran`（开始执行）/`completed`（结束）+ `duration_sec`；`rich_message` final 带 `completed` + `duration_sec`。
- 前端：`part` 累积时间戳；ToolPartBlock 完成态显示真实耗时（`(completed-ran)/1000`s）；`finalizeAiReply` 用 rich_message 的 `duration_sec` 显示消息级耗时。tokens/cost 未实现（stream_chat 未返回 usage，低优先）。

**#8 step-start / step-finish 启用 ✅**
- 后端：工具轮开始广播 `part kind=step-start`（"执行 N 个工具"），结束广播 `step-finish`（"工具执行完成"），同时写进 body_parts。
- 前端：`part` handler 累积 step-start/step-finish；模板已有渲染行。

**#9 清理 legacy 死代码 ✅**
- 删：`formatToolInput`/`toolIcon`；前端 `PARTNER_REASONING` 分支（后端无调用方）；`ensureExtraSegment` + 其调用；聊天模板 extraProcess 渲染块；`finalizeAiReply`/`appendStreamingChunk` 的 extraProcess 分支；`isExtraProcessOpen`/`toggleExtraProcess`/`getExtraProcessDuration`/`extraSegKey`；`Message.extraProcess` 类型字段。
- 保留：后台任务视图独立 processStates 渲染、伙伴消息 blocks 渲染、`text` 非 final 通道（nis_brain 用）、legacy markdown 交互解析（#3 保险）。

**#10 推荐卡 `partner_recommend` 渲染组件 ✅**
- 新建 `blocks/PartnerRecommendBlock.vue`（头像/名字/角色/推荐理由 + 确认加入/忽略，已响应置灰），接入 `MessageBlocks.vue` `partner_recommend` 分支（emit recommend-confirm/ignore）。
- `triggerRecommendAsk`（`/test 伙伴`）改为注入 `partner_recommend` 块；新增 `handleRecommendConfirm`（addMember + 清 pending）/`handleRecommendIgnore`（留存 pending）；ChatInterface 各处 MessageBlocks 接上 recommend-confirm/ignore。

### 收尾

- ✅ 全量回归：后端 `python -m pytest -q` **819 passed**；前端 `npm run build` 通过；后端已重启（端口 8765 正常）。
- ✅ 本交接文档已更新。

---

## 八、关键代码地图（用 Grep 按方法名定位，行号会漂移）

**后端 `main.py`**：
- `BLOCKS_OUTPUT_GUIDE`（含 `> [!ask]`/`> [!permission]` 提示语，相关 #1/#3/#9）
- `_stream_chat_background`（agent loop：on_chunk/on_reasoning/on_tool_call/_stream_once/_broadcast_reasoning_done/_append_round_text/工具与 legacy 循环/finalize）—— **#1 #2 #3 #7 #8** 的主战场
- `_pause_for_question`（QUESTION 批量 + 挂起）—— **#2**
- `_await_legacy_permission`（legacy 权限，只广播本轮 perm_blocks）—— **#2 #9**
- `_ws_handle_question_answer` / `_ws_handle_chat_interact`（唤醒挂起）
- `_build_llm_fn` / `_ws_handle_test_connection` / `_recommend_and_broadcast`（base 回退，已修）
- `_safe_tool_result` / `_ask_cards_from_clarify`

**后端 `core/api_router.py`**：`stream_chat`（tool_calls 解析）—— **#3**
**后端 `core/message_types.py`**：Part 模型 + `blocks_to_parts` —— **#2 #8**
**后端 `core/tool_schemas.py`**：`build_chat_tools` —— **#3**
**后端 `permission/gate_keeper.py`**：`secure_call`/`_request_user_decision` —— **#2**
**后端 `network/ws_bridge.py`**：`hitl_request`（card_callback）
**后端 `run_server.py`**：logging 配置

**前端 `ChatInterface.vue`**（~4200 行）：
- `handleWebSocketMessage`（`part`/`rich_message`/`HITL_REQUEST`/`QUESTION`/`text`/`PARTNER_REASONING` 处理）—— **#1 #2**
- `pushAiRichReply` / `finalizeAiReply` / `pushPendingAiReply` —— **#1 #2 #5**
- `partToolDesc` + `toolPhrases`（拟人化文案）—— **#6**
- `extractMessageText` —— **#4 #5**
- `scrollToCard` / `data-ask-card` —— **#2**
- parts 渲染模板（reasoning/tool/text/ask_user/permission 分支）—— **#2 #6**
- 后台任务记录渲染（`rec.processStates`，**独立，别动**）
- 伙伴消息渲染（`msg.type==='partner'` + PartnerBubble）—— **#10**

**前端组件**：
- `blocks/OrbLoader.vue`（composing/working）—— **#7**
- `blocks/CheckCircleAnim.vue`（check/ban）
- `blocks/GlowText.vue` / `blocks/LiveTimer.vue`
- `blocks/AskUserBlock.vue` / `blocks/AskUserGroupBlock.vue` / `blocks/PermissionPromptBlock.vue` —— **#2**
- `blocks/MessageBlocks.vue`（18 种块渲染，无 partner_recommend）—— **#10**
- `blocks/PartnerBubble.vue`（伙伴摘要+展开）—— **#10**

---

## 九、验证流程（每改一批就做一遍）

1. 后端：`cd E:\nis+gork\nis内核\src-python && python -m pytest -q -k "chat_agent_loop or question or message_types or ws or task"`（新增改动补测试）
2. 前端：`cd E:\nis+gork\nIs ui 4.0\nis-ui && npm run build`
3. 重启后端（第二节流程），浏览器硬刷新
4. 真机测：聊天（普通对话 / 权限申请 / 询问多题 / 停止生成）→ `/test 后台任务` → `/test 权限询问` → `/test 伙伴`（项目窗口）
5. 看日志：`nis_server.log.err` 里 `tool_call` / `legacy 交互块` / `question` / `执行工具` 广播顺序是否符合预期

---

## 十、给下一个窗口的第一句建议

先跑一遍 `python -m pytest -q` 和 `npm run build` 确认当前基线是绿的，再按第七节 **#1 → #2 → #3** 的顺序动手（这三项是 bug 根源，做完聊天就干净了），每项做完立即回归 + 真机确认。
