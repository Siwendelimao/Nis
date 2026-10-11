# NIS 前端聊天流式优化 — 交接提示词（开新窗口直接粘贴）

> 状态日期：2026-08-10 · 后端相关子集 71 passed · 前端 build 通过 · 后端 WS 已起（`python run_server.py`）
> 核心已全部完成并通过 WS/CDP 验证。当前无阻塞 bug，多为「供应商临时故障」类外部问题。

---

## 〇、当前状态一句话

聊天主链路已完整可用：**真流式 + thinking 过程块 + markdown→blocks 组件化 + 多轮上下文 + 多窗口隔离 + 报错/停止处理 + 交互询问/权限**。用户最近在**实际使用中验证**，反馈集中在供应商连通性和个别细节，无架构级改动需求。

---

## 一、项目位置与环境

- 前端：`E:\nis+gork\nIs ui 4.0\nis-ui`（Vue 3.5 + Vite 6 + Pinia 3 + Tailwind 4，Tauri 2 壳，纯前端为主）
- 后端：`E:\nis+gork\nis内核\src-python`（Python；测试跑 `python -m pytest -q -k "message_types or router or stream or chat or llm"` = 71 passed；WS `ws://127.0.0.1:8765`）
- **后端常驻启动**：`cd E:\nis+gork\nis内核\src-python && python run_server.py`（输出 `[NisEngine] READY (persistent)` 后**别关窗口**）
- 前端 dev server：`npm run dev` → localhost:5173；改完 `npm run build` 验证
- 无头验证：Edge CDP（`msedge --headless=new --remote-debugging-port=9223`）+ Node 22 内置 WebSocket；脚本写文件跑（`C:\Users\Administrator\AppData\Local\Temp\opencode\`）；`Runtime.evaluate` 驱动 DOM
- 测试注入钩子：`chat.ts` 的 `dispatchTest(msg)`（生产无副作用，可保留）

## 二、铁律（别破）

1. **绝不用 PowerShell Set-Content/Get-Content 重写含中文 .vue/.ts**（GBK 双重乱码）。读用 Read、写用 Edit/Write。必须脚本改：`[System.IO.File]::ReadAllText/WriteAllText` + UTF8
2. **WS 收统一入口**：全局 `App.vue handleGlobalMessage`；聊天 `ChatInterface.handleWebSocketMessage`；store 用 `applyWsMessage/applySnapshot`
3. **i18n**：新文案加 `utils/i18n.ts` zh+en；不改 BwSeg/select options 数组值
4. **TDZ 陷阱**：watch/computed 访问的 store 必须声明在文件前部
5. `RightPanel.viewOptions` 是 computed（按 `browserStore.connected` 动态生成）——不要改回写死
6. postMessage 到 office iframe 必须 `toPlain()`（JSON 深拷贝）
7. **`_create_plan` 改动影响核心派发+测试，改前先读**；`_recommend_partners` 规则与前端 `recommendPartnersMock` 语义同步

## 三、聊天流式架构（已实现，别推翻）

**后端**（`main.py` + `core/api_router.py` + `core/message_types.py`）：
- `_ws_handle_chat`（main.py:1286）：收到 `chat_message` → 若 `_current_llm` 已配置 → `asyncio.create_task(self._stream_chat_background(...))` 后台流式，立即返回 None（**不阻塞 ws 消息循环，stop_generation 能随时到达**）；未配置 → 返回友好提示「尚未配置可用的大模型」
- `_stream_chat_background`（main.py:1314）：litellm 流式，`on_chunk` 逐段广播 `text final:false`，`on_reasoning` 广播 `PARTNER_REASONING`；推理结束 → `PARTNER_REASONING done:true` → `rich_message {blocks: markdown_to_blocks(full_text)}` → `text final:true`（content 恒空）
- **所有广播都带 `conversation_id`**（来自 chat_message），前端据此路由到正确窗口（多窗口防串线）
- **失败只回一轮**：流式异常 → 只广播 `chat_error {error, conversation_id}`（`_friendly_llm_error` 转成中文一句话），**提前 return 不再发 done/final**
- `_ws_handle_stop_generation`（main.py:1475）：置位 `self._stop_event`（asyncio.Event）→ `stream_chat` 循环检测即中断，保留已输出内容
- `stream_chat`（api_router.py）：推理结束（首个只含 content 的 chunk）立即 flush pending 并转直通 live_stream，之后每 chunk 到达即回调（**不再攒到结尾**）；`on_finish(reason)` 检测 `finish_reason=length`（截断提示）
- `markdown_to_blocks`（message_types.py）：markdown → blocks。识别 code/tree→filetree/diff/html→htmlpreview/dag/filepreview/table/quote/tasklist/math/image/link/card/`> [card]`/`> [!ask]`→ask_user/`> [!permission]`→permission_prompt
- `_normalize_api_base`（main.py:144）：**按文档填 URL 原则**——用户填完整路径原样使用；填纯域名补默认路径（已知厂商 longcat→/openai、tongyi→/compatible-mode/v1、zhipu→/api/paas/v4，未知补 /v1）；本地走 http

**前端**（`ChatInterface.vue`）：
- `msgConvId(msg)`（:162）：优先消息自带 conversation_id，回退当前窗口——**多窗口防串线核心**
- `handleWebSocketMessage`（:168）：PARTNER_REASONING / text 增量 / rich_message / chat_error / HITL_REQUEST / QUESTION
- `pushPendingAiReply`（:1557）：发消息创建待回复气泡 + thinking 立即 active/展开/计时
- `appendStreamingChunk`（:1601）：text 增量实时写入 markdown block（**无定时器限速，到达即渲染**）
- `finalizeAiReply`（:1628）：text final 收尾，折叠 thinking，清 msgStreaming
- `pushAiRichReply`（:1661）：rich_message → 真组件 blocks 替换，给 local 交互块打 conversation_id
- `buildChatHistory`（:1787）/`sendMessage`（:1801）：多轮上下文（history 最多 20 条）+ conversation_id
- `stopGeneration`（:1846）：置 `processStates.stopped='done'` → 模板显示灰色「已停止」（区别于 error）

**流式渲染**：`MarkdownBlock` streaming 分支用 `StreamingTail`（已收文本实时显示 + 新尾部彩色动画）；`PlainTextBlock`/`MessageBlocks` 同理。完成后 `rich_message` 换成真组件块。

**thinking 展示（终版）**：思考过程**完整显示**推理内容（不限高、不滚动），结束后 `isMsgProcessOpen` 折叠为一行 "Thinking"（带真实耗时），点击可展开。已放弃滚动方案（用户确认）。

## 四、已解决的坑（复现/回归时参考）

1. **供应商选择**：`syncModelToBackend` 优先 active 供应商（不再自动选第一个有 key 的）——修复"UI 选 longcat 实际用 agnes"
2. **多轮上下文**：前后端都带 history
3. **失败只回一轮**：异常提前 return + 前端 done 无气泡不创建
4. **thinking 12s/persona 文案**：chat_error 不再设 error 过程态，直接渲染真实错误文本；`getProcessDuration` thinking 无真实计时返回 `-`
5. **多窗口串线**：conversation_id 全程透传
6. **交互询问/权限**：`> [!ask]`/`> [!permission]` → 可交互卡片（local:true 无 request_id → 选择作为新消息回传 AI 继续对话）；permission 始终合并标准 4 种授权范围
7. **Base URL**：按文档填完整 URL 原样用；填域名自动补路径；设置里问号悬停有说明

## 五、验证方法

- 后端：`cd E:\nis+gork\nis内核\src-python && python -m pytest -q -k "message_types or router or stream or chat or llm"`
- 前端：`npm run build`
- 端到端（CDP）：启动后端 + dev server + CDP headless → 页面里 `chat.dispatchTest` 注入 `PARTNER_REASONING`（推理）/`text final:false`（流式）/`rich_message`（blocks）→ 检查渲染
- 真实 LongCat：发「请介绍一下你自己，并用代码块和表格示例」→ 看流式逐段 + thinking 完整显示 + blocks 真组件
- 真实供应商测试：`TEST_CONNECTION`（后端会 `_normalize_api_base` 规范化 base）

## 六、注意/已知外部因素

- **LongCat/agnes 上游偶发 Cloudflare 5xx**（`<!DOCTYPE html>`）——供应商临时故障，非代码 bug。重启后端 + 前端刷新重试即可。已加 `_friendly_llm_error` 友好提示
- **agnes 测试连接**：必须用 agnes 自己 fetch 到的模型名（`agnes-2.0-flash` 等），不是 longcat 的 LongCat-2.0
- 后端 `_current_llm` 是**内存态**：改完 main.py 重启后端才生效；前端刷新后 wsConnected watch 自动 SET_MODEL
- 前端 localStorage `apiKeys` 曾为空：用户需在设置→供应商重新填 key 并保存（会同步到后端 vault `api_keys.enc`）
- Ollama 本地走 `http://127.0.0.1:11434`（已处理不强制 https）

## 七、用户近期反馈中仍待观察的（非阻塞）

1. thinking 滚动已放弃（完整显示 + 结束折叠），若用户再提滚动需求需重新设计方案
2. 流式"最后加速"感知已实测为官方节奏（每 0.5s 16~46 字，无加速规律）
3. filepreview/dag/htmlpreview/filetree 等**工具块**需后端工具调用后广播（AI 纯文本无法生成）——若用户坚持让 AI 输出这些，需设计结构化标记协议
