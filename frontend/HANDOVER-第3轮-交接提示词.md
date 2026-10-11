# NIS 聊天/记忆/工具 — 第 3 轮交接提示词（新窗口直接开始）

> 给下一个 AI 会话的完整交接。读完即可无缝接替，无需重新调研。
> 第 2 轮（#1-#33）已全部完成并验证。第 3 轮目标是：**把「未完成清单」按优先级做完**，继续完善工具集 / 插件 / 意图路由 / 记忆体验。

---

## 〇、当前基线（接手前必须确认绿）

| 项 | 值 |
|---|---|
| 后端测试 | `cd E:\nis+gork\nis内核\src-python && python -m pytest -q` → **844 passed** |
| 前端 build | `cd E:\nis+gork\nIs ui 4.0\nis-ui && npm run build` → 通过 |
| 后端运行 | `[NisEngine] READY (persistent)` on 127.0.0.1:8765 |
| 存量数据 | `memory_system.db`：active records **37** 条、enabled nodes **28** 个（已去重，无重复） |
| 已注册工具 | clarify(内置) + code_search / diff_edit / git_* / shell_exec / knowledge_query / knowledge_delete / knowledge_update / memory_add / memory_search / memory_delete / memory_update（14 个 schema） |

---

## 一、环境与重启（必须遵守）

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
日志出现 `[NisEngine] READY (persistent)` = 成功。前端改完 Ctrl+F5 硬刷。

---

## 二、已完成进度全清单（防回退，改新东西时不要破坏这些）

### 聊天交互核心（#1-#20 已全部完成）
- **交互卡进气泡**：权限/询问卡渲染在 AI 回复气泡内（`pushCardToBubble`），交互挂起期间输入框+发送按钮禁用（`hasPendingInteractive`）。
- **交互只用工具**：`INTERACTIVE_FALLBACK_GUIDE` 只讲 clarify 工具提问 + 工具自动弹权限卡，**不再诱导 `> [!ask]`/`> [!permission]`**；后端/前端保留 legacy 标记解析作兜底（含不带 `!` 的 `> [permission]` 变体）。
- **每会话流式任务互斥**：`_chat_stream_tasks` 新消息取消旧任务。
- **停止/进行态**：`settleRunningTools` 遍历所有消息标 stopped；`hasActiveTools`/`refreshReplying` 同步列表"正在回复"；停止后作答卡 → 后端 `_stop_event.clear()` + 前端恢复 generating。
- **`> [card] 权限` 变体**：`message_types._card_title_suggests_permission` 映射为 permission_prompt。
- **MessageBlocks 流式分支**排除 permission_prompt/ask_user/partner_recommend（否则卡被隐形渲染）。
- **气泡按钮 hover**：命名 group `group/bubble` + `group-hover/bubble:opacity-100`；用户气泡同样隐藏按钮。
- **询问卡可翻回重做**：AskUserBlock `editable`+编辑按钮；AskUserGroupBlock `submit-all` 一次性提交。
- **记忆提炼时机**：`watch(isGenerating)` 生成结束才 60s 计时（TDZ：watch 紧跟 isGenerating 声明之后）；关窗提炼 10min 冷却（`closePromptCooldownUntil`）；memory 通知 1s 折叠。
- **MAX_TOOL_ROUNDS=20**；**FTS5 查询转义**（`_normalize_query`/`_escape_fts` 每词双引号）；**clarify 回执不进历史**（extractMessageText 跳过 `tool==='clarify'`）。

### 记忆系统（#28-#33 已全部完成）
- **`MemorySourceType` 枚举**（user_explicit/user_implicit/system_infer/system_observed/imported）：提炼→system_infer，memory_add→user_explicit。
- **提炼查重合并**：`DistillEngine._find_duplicate`（LCS+关键词），命中更新旧记忆（dup_merged）；`global_memory.append_entry` / `project_memory.append_section` 写前查重。
- **记忆工具**：`memory_add`（AI 主动写，写前查重，同步星系）/ `memory_search` / `memory_delete`（同步停用星系节点）/ `memory_update` / `knowledge_query` / `knowledge_delete` / `knowledge_update`。
- **FTS 触发器修复**：`schema.py` 的 `memory_fts_update`/`mnode_fts_update`/`delete` 改为"先删后插"（trigram 分词器直接 UPDATE 内容会损坏索引 → database locked/malformed）；`_rebuild_fts_triggers` 在 init_db 里 DROP 重建旧触发器。
- **`get_graph` 只显示启用节点**（enabled_only=True），停用/重复合并节点不展示。
- **`text_utils.py`**：`short_title`（≤20 字去口语前缀）、`normalize_text`、`text_similarity`（LCS + 显著英文/数字词共享强信号）、`is_duplicate`（≥0.45）、`_search_hint`（英文词/中文 4 字预筛）。
- **前端知识库空启动**（`knowledge.ts` 移除演示数据，STORAGE_VERSION=6）。

---

## 三、未完成清单（第 3 轮候选，按优先级）

> 用户明确要求"记录还没做的，确保新窗口接上进度"。以下均**未实现**。

### P0 — 记忆/知识库体验
1. **记忆检索"可信度"显示**：`MemorySourceType` 枚举已建，但 `memory_search`/`knowledge_query` 结果未带"可信:高/中/低"；冲突排序（user_explicit 优先于 system_infer）未实现。
2. ~~其余写入入口未统一查重~~：**已完成**（见下方"新增：upsert_memory 统一写入"）。
3. ~~`user_implicit`/`system_observed`/`imported` 未接线~~：**部分完成**——`upsert_memory` 已按 `SOURCE_PRIORITY`（user_explicit>user_implicit>system_observed>system_infer>imported）做冲突顶替决策；但 `user_implicit`/`system_observed`/`imported` 这三个 tag 仍无入口打上（只用了 user_explicit + system_infer）。
4. **记忆星系 UI 增强**（可选）：节点可信度/来源展示（`memory_nodes.source_type` 列已加，可展示）、同源记忆折叠、标题过长截断。

### P1 — 基础工具集扩充
5. **文件工具**：read_file / write_file / list_dir / search_file / fs_delete / move_rename / file_grep。
6. **网页工具**：web_search / web_fetch。
7. **代码质量**：run_tests / lint。
8. **浏览器**：browser_open / browser_screenshot / browser_click / browser_read_dom（后端 browser_engine 已有，未暴露给聊天）。
9. **系统**：screenshot / clipboard_read / clipboard_write / notify（risk_map 已定义规则，未注册）。
10. **网络**：http_get / http_post（走权限卡）。
11. **办公/计划**：read_calendar / create_event / open_app / task_plan / todo_update。
    - 每个都要：`tool_schemas.py` schema + `policy_engine.py` risk + `main.py` 注册 executor + 前端 `toolPhrases` 拟人化文案（气泡显示同款 ToolPartBlock）。

### P2 — 插件系统
12. **声明式插件注册**：`plugins/` 目录扫描（name/description/params/risk/executor）启动自动注册，免改 main.py。当前加工具要手写 4 处。
13. **PluginPartBlock.vue**：复刻 ToolPartBlock，仅进行中动画换一种（如绿色/different icon）；前端按 `part.plugin` 或工具名前缀路由。

### P3 — 意图路由 + 参数提取层
14. **架构级改造**：当前"模型直接调工具名 → ToolGateway.execute → secure_call"，**无意图路由、无参数提取**。opencode 式"自然语言意图 → 框架决定工具"未做。改动大，先讨论方案再动。

### 备注（已知保持现状）
- 聊天窗口消息存内存 store，刷新即清（测试演示用，用户同意保持）。

---

## 二·新增：upsert_memory 统一记忆写入（第 3 轮已完成）

> 解决"命中已有记忆怎么告知 / 更新怎么告知 / 有出入怎么判定 / 是否顶替旧的"。对应未完成清单 P0 #2（统一查重）+ #3（来源优先级）。

### 后端新增
- **`core/memory/upsert.py`**：`UpsertVerdict`（outcome=created/already_exists/merged/conflict，含 old_content/new_content/reason/hit_id）+ `upsert_memory()`。
  - 查重（同 scope+同类型，复用 `is_duplicate`）→ `semantic_relation` 判定 equivalent/extends/contradicts/unrelated → 决策。
  - **冲突顶替**：`SOURCE_PRIORITY`（user_explicit=5>user_implicit=4>system_observed=3>system_infer=2>imported=1）。新来源优先级更高 → 自动顶替（merged）；同级矛盾 → conflict（等用户确认，`force_replace=True` 强制顶替）；`conflict_mode="ask"` 一律返回 conflict。
  - `memory_nodes` 同步按 `md_section=memory_id` 复用节点（避免改标题后星系重复）。
- **`text_utils.py`** 新增 `detect_contradiction`（数值变化/否定翻转/方向词翻转，如"我不喜欢 emoji"vs"我喜欢 emoji"、"7 天"vs"30 天"、"深色"vs"浅色"）+ `semantic_relation`。
  - 注意：否定词只匹配稳定组合（`不喜欢/不要/不用/不再/没` 等），**不含单字"不/别/非/无"**（会误伤"特别是/非常/无论"）。
- **`store.update`** `allowed_fields` 加 `source_type/last_confirmed_at/user_override/supersedes/superseded_by`（修 bug：distill 合并时 source_type 被静默丢弃）。
- **`memory_nodes` 加 `source_type` 列**（schema + 迁移 `_migrate_memory_nodes_table`；`memory_graph.add_node/update_node/_row_to_node` 支持）。
- **`distill()`** 改走 `upsert_memory`（返回新增 outcome/reason/old_content/hit_id，dup_merged 语义保留兼容旧测试）。
- **`_memory_add_tool`** 改走 `upsert_memory`（user_explicit，自动顶替低来源冲突）。
- **`MEMORY_NODE_ADD`**（WS）改走 `upsert_memory`（user_explicit），响应带 outcome/reason/hit_id。
- **新增 WS `MEMORY_CONFLICT_RESOLVE`** → `force_replace=True` 强制顶替（前端"顶替旧记忆"按钮用）。路由在 `ws_bridge.py` 的记忆图类型元组里。
- **`extract_and_persist`** 每条 item 透传 outcome/hit_id/old_content/reason；`MEMORY_EXTRACT_RESULT` 新增 `counts{created,merged,already_exists,conflict}`。

### 前端新增
- `memoryExtract.ts`：`MemoryOutcome` 类型 + item.outcome/counts + `resolveMemoryConflict()`。
- `MemoryExtractModal.vue`：每条状态徽标（新增/已更新/已存在/有冲突）；conflict 条目展示旧→新 diff + "顶替旧记忆/保留旧的" 按钮。
- `ChatInterface.runAutoExtract`：通知文案 "新增 N · 更新 M · 跳过 K"。
- `i18n.ts`：`t()` 支持 `{var}` 参数插值（新键 memoryExtract.outcome.* / conflict.* / counts、memoryAuto.counts）。

### 测试记录
- `pytest -q` **844 passed**；`npm run build` 通过；真机 WS 验证：相同内容→already_exists、相似→merged、矛盾+user_explicit→merged 顶替、矛盾同级→conflict。
- 已清理测试写入的节点（`created_by='ws_graph'`），存量库恢复 28 节点基线。

---

## 二·二、记忆矛盾清理 + 提炼可多选（第 3 轮已完成）

### A. 系统提示词注入矛盾记忆修复
- **现象**：用户改口后，旧矛盾记忆（如"不喜欢 emoji"→"改用 emoji"）残留在 `~/.nis/*.md`，
  每次聊天经 `_stream_chat_background`（main.py `SYSTEM_PROMPT += [全局记忆]`）注入，
  AI 会"看到"自相矛盾的偏好。DB 里的 `memory_records` 已由 upsert 顶替，但 md 文件未同步。
- **修复**：`global_memory.append_entry` / `project_memory.append_section` 写前
  先查矛盾（`detect_contradiction`，**优先级高于 is_duplicate**）→ 命中则用新条目**顶替旧条目**（保留文件其余部分）。
  - 铁律：`is_duplicate` 阈值 0.45 对矛盾文本也会命中（相似度高），所以**必须先查矛盾再查重**，否则矛盾被当重复跳过。
- **存量清理**：已清理 `~/.nis/preferences.md` 里两条"不喜欢 emoji"残留（备份在 `~/.nis/_backup_preferences_*.md`）。

### B. 提炼预览 → 用户勾选 → 提交（手动提炼 / 关窗提炼）
- **后端**：
  - `upsert_memory` 加 `dry_run`（只判定 outcome 不落库）。
  - `DistillEngine.preview()`：预览判定 created/already_exists/merged/conflict。
  - `memory_extractor` 拆 `preview_items` + `persist_items`；`extract_and_persist(content, dry_run=True)` 走预览。
  - `_ws_handle_memory_extract` 支持 `dry_run` 参数；新增 `MEMORY_EXTRACT_COMMIT` 消息（只落库用户勾选的条目），
    路由在 `ws_bridge.py`（`set_memory_extract_commit_handler`）。
- **前端**：
  - `memoryExtract.ts`：`memoryExtract(content, root, {dryRun:true})` 预览 + `memoryExtractCommit(items)` 提交。
  - `MemoryExtractModal.vue`：预览候选 → 每条 checkbox（默认全选）+ 顶部"全选/全不选" +
    "保存所选（N）"按钮 → commit 后显示最终 outcome + counts。
  - `ChatInterface.vue`：手动提炼（右键）/ 关窗提炼均走预览→勾选→提交；`@done` 后系统通知。
  - 自动提炼（60s 空闲）**不走勾选**，保持直接落盘（`memoryExtract` 默认 dryRun=false）。
- i18n 新增：`memoryExtract.selectAll/selected/commit/saving/finish`（zh+en）。

### 遗留已知问题
- `main.py:305-306` `initialize_identity/persona` **每次重启新增一条** identity/persona 记录（无去重）——
  导致 active records 随重启次数增长（预存 bug，与本次改动无关，待修）。

## 二·三、真机反馈修复（第 3 轮已完成）

### A. emoji 假记忆清理（用户真实偏好=不喜欢 emoji）
- **背景**：用户为测试"冲突检测"故意说喜欢 emoji，Nis 把测试内容当成了真记忆写入（DB active + decisions.md + lessons.md + 星系节点）。
- **已清理**：
  - 软删 4 条"喜欢 emoji"假记忆：`mem_f637895fa6a7` / `mem_113efef6b6d2` / `mem_fd756b11659f` / `mem_bb60e30ba7ad`
  - 恢复 3 条真实"不喜欢 emoji"：`mem_2e638740db6b` / `mem_46798b6fc5c4` / `mem_b1d1ac7fd877`
  - 星系节点：停用 4 个假节点、启用 3 个真节点
  - md 文件：decisions.md 删"各类场景自然使用 emoji"、lessons.md 删"曾误记用户不喜欢 emoji"、
    preferences.md 从备份恢复两条真实偏好 + 删除测试残留"验证用临时偏好/验证矛盾"
- **备份**：`C:\Users\Administrator\AppData\Local\Temp\opencode\memory_system_backup_20260813_001048.db`
  + `~/.nis/_backup_preferences_20260812_230214.md`

### B. 提炼记忆超时修复
- 根因：`memory_extractor.extract()` 调 LLM **无超时保护**，LLM 慢时无限等；前端 40s 就放弃。
- 修复：后端加 `asyncio.wait_for(..., timeout=25)`（`EXTRACT_LLM_TIMEOUT`）；前端 `memoryExtractCommit`/冲突用 30s、提炼 40s，超时文案区分"提炼超时/提交超时"。

### C. 教训（防回退）
- **测试内容 = 假记忆风险**：让 AI 测试"冲突检测/记忆"时，会污染记忆库。测试前后必须清理。
- 用户判断标准："**不在记忆库（星系）里的 md 记忆 = 假记忆**"。但注意：早期历史条目只在 md 没写 DB，是真实记忆，勿误删。

### D. 新增记忆自动理顺关联（星系自动建边）
- **问题**：新增记忆只建节点不建边，星系图谱是散的（`add_edge` 仅在手动 MEMORY_EDGE_ADD 调用）。
- **实现**：`upsert_memory` 落库后调 `_auto_link()`（upsert.py）——
  - 与同 scope 其它启用节点做 `text_similarity`（阈值 0.35，低于查重 0.45 = "相关"而非"重复"）
  - 或共享标签、或共享显著英文/数字关键词（如都提 emoji/vue）→ 连 `related` 边
  - 去重：已有边不重复连；最多连 5 条；dry_run 不连
- **验证**：187 测试通过 + build 通过 + 真机脚本确认（Vue 两条自动连、紫色不误连、已存在不重复连）。
- **前端无需改**：星系 `get_graph` 已返回 edges，新增边自动显示。

### E. 移除"关窗提醒提炼"（用户要求）
- **背景**：用户确认——不自动记忆时也不想要"返回窗口提醒提炼"弹窗，提炼只走**右键主动提炼** 或 **用户明确说记住**。
- **改动**（ChatInterface.vue + i18n.ts）：
  - `requestBack()` 直接 `emit('back')`，不再弹提炼提醒
  - 删除 `closePromptVisible` / `closePromptExtract` / `closePromptSkip` / `closePromptCooldownUntil` / `CLOSE_PROMPT_COOLDOWN_MS`
  - 删除模板中的"关闭窗口记忆提醒弹窗" + i18n `memoryPrompt.*`（zh/en）
- **保留**：右键「提炼本窗口记忆」（`uiStore.memoryExtractRequest` → MemoryExtractModal 预览勾选提交）、60s 空闲自动提炼（`settingsStore.autoMem`）、`memory_add` 工具（用户明确说记住）。
- 验证：`npm run build` 通过。

### F. 记忆升级第一步：主动回忆 + 新鲜度降权 + 注入预算（第 3 轮已完成）
- **U1 主动回忆**（main.py `_stream_chat_background`）：每轮自动检索 top-3 最相关记忆注入
  `[相关记忆（主动回忆）]`（不再依赖用户说"之前/上次"）。top-3 × ≤200 字 ≈ 600 token 内。
- **R1 新鲜度降权**（store.py）：
  - `_freshness_decay(updated_at, half_life_days=60)`：半衰期 60 天，越旧权重越低
  - `_rerank_by_importance_freshness`：FTS 命中后按 `bm25相关度×0.5 + importance×新鲜度×0.5` 重排
  - `search()` 的 fts 路径统一生效（memory_search 工具 + 主动回忆 + 历史检索都受益）
- **T1 注入预算**：全局记忆 md 全文注入截断到 1500 字（超预算加"…其余未注入可搜索"标注）。
  **跨窗口共享不破坏**——共享靠文件存在 + 历史对话，注入只带精华。
- **U4 降权**：旧记忆自动排后面（不删记忆，低权重仍可被检索到）。
- 验证：202 测试通过 + 真机检索确认（"权限"命中 4 条、"紫色/风格"正常召回；emoji 无 active 记录=假记忆已清，符合预期）。
- 日志新增字段：`[chat-stream] prompt 全局记忆=X字 主动回忆=Y字 历史检索=Z字 总长=N`。

### G. 记忆系统完整升级（第 3 轮已完成，2026-08-13）
> 备份：`E:\nis+gork\nIs ui 4.0\后端源码备份\升级前备份_20260813_074209`（全量 .py+DB+~/.nis）
> 测试清单：`E:\nis+gork\nis内核\记忆系统升级-验收测试清单-20260813.md`（明天验收用）

- **P0-1 权重修正**（main.py 注入区）：项目窗口聊天先注入 `[项目记忆]`（≤1000 字，主层），全局记忆预算降到 800（背景层）；主动回忆**双 scope**（先项目后全局）。
- **P0-2 提炼铁律**（memory_extractor DEFAULT_PROMPT）：只提炼用户明确表达的事实；AI 陈述/测试对话/假设场景一律不提炼。
- **P1-1 用户档案卡**（新 `core/memory/profile.py` + upsert 接线）：user_explicit 偏好自动归类到 JSON 字段（budget/style/tech_stack/constraints...），读取精确、新值覆写旧值（单一事实来源）；注入 `[用户档案]` 在最前。**注意**：提炼提交（persist_items）传 user_explicit，自动提炼传 system_infer。
- **P1-2 图遍历检索**（`_memory_search_tool`）：命中后沿 memory_edges 带出 `[关联记忆（沿关系）]`。
- **P1-3 来源徽标**（MemoryGraphModal.vue）：节点详情显示来源色（绿=user_explicit/黄=system_infer/灰=其他）+ 创建/更新时间；i18n `memory.source.*`。
- **P2-1 自动提炼降权**：`distill(importance=0.5)` 自动提炼低权重；用户勾选提交=0.85+user_explicit。
- **P2-2 对话摘要注入**：memory_semantics 表按关键词注入 `[近期对话摘要]`（≤3 条）。
- **P2-3 遗忘策略**（start() 后台任务）：超 180 天未更新 + importance<0.3 → 转 INACTIVE（不删可恢复）。
- **P3 embedding 接线并已启用**（main.py MemoryStore 构造）：`SentenceTransformerEmbedder("all-MiniLM-L6-v2")` + `SqliteVectorIndex` + auto_index；模型已通过 **hf-mirror.com 镜像**下载到本地缓存（`embedding.py` 先查缓存→镜像→官方，失败降级 FTS）。启动日志 `[memory] 语义检索已启用: st_all-MiniLM-L6-v2 (384 维)`；存量 49 条已 `reindex_all` 补索引，新记忆自动索引；检索模式 hybrid。
- 回归：**844 passed + build 通过 + 后端重启 READY**。
- 遗留：存量星系旧节点连线待补（可写一次性补边脚本）；identity/persona 重启重复（预存 bug）。

### H. 真机反馈三个问题修复（第 3 轮，2026-08-13）
1. **提炼"提取失败"**：根因 `EXTRACT_LLM_TIMEOUT=25s` 太短，LongCat 提炼长对话常超时→返回空。
   修复：后端 25→**35s**，前端 TIMEOUT 40→**60s**（COMMIT 30→45s）。
2. **AI 思考完没正文就停止**：根因未传 `max_tokens`，API 默认输出上限小，思考占满后正文被截断（`finish_reason=length`）。
   修复：`_stream_once` 显式 `max_tokens=8192`（api_router `kwargs` 已透传）。
3. **星系有记忆但 AI 说没有**：根因 `memory_nodes`（星系）与 `memory_records`（AI 检索）两套表不同步——
   星系手动加/sync_from_md 的节点只写 nodes 不写 records，且 records 只搜 content 不搜标题。
   修复（main.py `_sync_galaxy_nodes_to_records`，启动时执行）：
   - 星系 enabled 节点无对应 records → 补齐（`created_by=galaxy_sync`）
   - 标题拼进 content 开头（`标题：内容`），解决"标题含关键词但 content 没有"搜不到
   - 已补 15+ 条（每窗口模型隔离 / 每会话流式任务互斥 / GBK 教训等）
   - 验证：FTS/hybrid 搜"隔离"命中「每窗口模型隔离」
- 回归：167 测试通过 + build 通过 + 后端重启（PID 70780）READY。
- 注意：hybrid 向量部分中文短查询排序仍可能把无关的排前面（MiniLM 中文能力边界，FTS 精确命中不受影响）。

### I. 真机反馈二轮三个问题修复（第 3 轮，2026-08-13）
1. **查询工具重试上限**：`_stream_chat_background` 加 `_EMPTY_RETRY_LIMIT=3`——
   查询类工具（memory_search/knowledge_query/code_search/git_log）连续 3 次"无结果"
   → 注入"停止检索，直接回答或询问用户"指令，防死循环。
2. **md 文件 vs 记忆库不一致**：`_memory_search_tool` 无结果时兜底：
   ① 补搜 project scope 空 project_id（全局模式/教训）→ ② 查全局 md 文件（preferences/decisions/lessons），
   返回 `[md:xxx]` 标注。AI 注入能看到 md 但 records 没有 → 现在搜得到。
3. **模式/教训检索不到**：
   - 根因：模式节点在 project scope（project_id 空），AI 检索只查 nis_core。
   - 修复：`_sync_galaxy_nodes_to_records` 把"project scope + 空 project_id"节点归入 nis_core（全局通用模式），
     已补 3 条（结构化需求澄清法/权限申请四要素/权限申请交互）。
   - **FTS 索引重建**（关键）：手动 DELETE/UPDATE records 后 FTS 触发器与 rowid 对齐问题导致索引损坏
     （`"权限申请"` MATCH 0 条）。已 drop 重建 memory_fts + 全量重灌（470 行），验证 `权限申请`3/`需求澄清`2/`emoji`3。
   - **trigram 2 字词限制**：`_search_fts` use_like_fallback 从 `<3` 改 `<=3`——纯中文 2-3 字词（如"隔离"）
     走 LIKE 而非 FTS MATCH（trigram 分词 2 字词无法 MATCH），验证 `隔离` 命中 2 条。
- 回归：142 测试通过 + 后端重启（PID 64208）READY。

---

## 四、关键代码地图（用 Grep 按方法名定位，行号会漂移）

**后端 `main.py`**：
- `_stream_chat_background`（agent loop 主战场：#1-#5 #13 #15 #16 全部在这）
- `_knowledge_query_tool`/`_memory_search_tool`/`_memory_add_tool`/`_memory_delete_tool`/`_memory_update_tool`/`_knowledge_delete_tool`/`_knowledge_update_tool` + `_sync_memory_node`（记忆/知识库工具）
- `_ws_handle_memory_extract` / `_ws_handle_memory_graph`（提炼/星系）
- `INTERACTIVE_FALLBACK_GUIDE` / `MAX_TOOL_ROUNDS` / `_choice_means_deny`

**后端 `core/`**：
- `memory/upsert.py`（**新**：UpsertVerdict / upsert_memory / SOURCE_PRIORITY — 统一写入入口）
- `memory/text_utils.py`（short_title / is_duplicate / text_similarity / _search_hint / **detect_contradiction / semantic_relation**）— 新工具查重都复用这里
- `memory/distill.py`（distill 改走 upsert_memory）
- `memory/schema.py`（FTS 触发器先删后插；`_rebuild_fts_triggers`；**memory_nodes.source_type 迁移**）
- `memory/store.py`（_normalize_query FTS 转义；search/update/add；**update allowed_fields 含 source_type 等**）
- `memory/memory_graph.py`（get_graph enabled_only；add_node/update_node 支持 source_type）
- `memory/models.py`（MemorySourceType）
- `tool_schemas.py`（GATEWAY_TOOL_SCHEMAS / NON_INTERACTIVE_TOOLS / build_chat_tools）
- `permission/policy_engine.py`（RISK_MAP）
- `knowledge/store.py`（_escape_fts）

**前端 `ChatInterface.vue`**（~4500 行）：
- `handleWebSocketMessage` / `pushCardToBubble` / `clearStoppedState` / `handleGroupSubmitAll`
- `isReplyingNow` / `stopGeneration` / `settleRunningTools` / `hasActiveTools` / `refreshReplying`
- `extractMessageText`（跳过 clarify tool part）/ `stripInteractiveMarkdown` / `isInteractiveMarkdown`
- `toolPhrases`（拟人化文案库，新工具加这里）+ `partToolDesc`
- 发送按钮模板（`hasPendingInteractive` 灰"停止"）
- 记忆提炼：`watch(isGenerating)` 紧随 `const isGenerating` 声明之后（TDZ 铁律）

**前端 blocks/**：`MessageBlocks.vue`（流式分支排除交互卡）、`PermissionPromptBlock.vue`/`AskUserBlock.vue`（editable）、`AskUserGroupBlock.vue`（submit-all）、`ToolPartBlock.vue`、`LiveTimer.vue`（formatDuration）、`NotificationStack.vue`（memory 1s 折叠）
**前端 stores/**：`knowledge.ts`（空启动）、`memoryGraph.ts`、`notifications.ts`、`conversations.ts`

---

## 五、验证流程（每改一批就做一遍）

1. 后端：`cd E:\nis+gork\nis内核\src-python && python -m pytest -q`（当前 844）
2. 前端：`cd E:\nis+gork\nIs ui 4.0\nis-ui && npm run build`
3. 重启后端（第一节流程），浏览器 Ctrl+F5
4. 真机验收（重点：#29 提炼不重复 / #30 AI 记住 / #31 星系可见 / #32 标题简短 / #33 关窗提炼不重复）
5. 看日志：`nis_server.log.err` 里 `tool_call` / `question request=` / `静默轮` / `auto-title` / `HITL_RESPONSE` / `[memory_add]` 顺序是否符合预期

---

## 六、铁律（必须遵守）

1. 绝不用 PowerShell `Set-Content`/`Get-Content` 重写含中文的 .py/.vue/.ts（GBK 双重乱码）。读用 Read、写用 Edit/Write；脚本改文件用 `python -c "open(p,encoding='utf-8')..."`。
2. WS 收统一入口：全局 `App.vue handleGlobalMessage`；聊天 `ChatInterface.handleWebSocketMessage`。别加第三入口。
3. i18n：新文案加 `utils/i18n.ts` zh+en。
4. **TDZ**：watch/computed 里访问的 store/ref 声明在文件前部；`watch(isGenerating)` 必须紧跟 `const isGenerating` 之后（曾因放前面导致聊天框打不开）。
5. 后端改完必须走第一节重启流程；前端硬刷新 + `npm run build`。
6. 行号会漂移，用 Grep 按方法名定位。
7. 别删 `opencode-ref`；别动 `后端源码备份`。
8. **交互卡在气泡里**；**历史上下文已清洗**；**每会话流式任务互斥**——改相关逻辑保持兼容。
9. **FTS 触发器**：`memory_fts_update`/`mnode_fts_update` 必须"先删后插"，**勿改回直接 `UPDATE memory_fts SET content=...`**（会损坏 trigram 索引 → database locked/malformed）。
10. **查重相似度**：`text_utils.is_duplicate` 阈值 0.45 + 显著英文/数字词共享强信号（0.82）；改动前先看 #33 诊断，避免误伤/漏检。
11. 存量记忆库 `.nis_data/memory_system.db` 已去重，勿手工重复清理造成数据丢失；要清用 `text_utils.is_duplicate` 按同类型+同作用域软删。

---

## 七、给新窗口的第一句建议

先跑 `python -m pytest -q`（844）+ `npm run build` 确认基线绿，再按**第三节 P0 → P1 → P2 → P3** 顺序做：
- **P0 记忆体验**（#1 可信度显示 / #2 统一 upsert_memory 查重 / #3 剩余 source tag）改动小、收益直接；
- **P1 基础工具集**（#5-#11）机械但量大，每个工具 = schema + risk + 注册 + 前端文案；
- **P2 插件系统**（#12-#13）和 **P3 意图路由**（#14）是架构级，先讨论方案再动。

每项改完立即回归 + 真机确认，最后更新本文档（把做完的移到"已完成"，未做的往下挪）。敏感区见第六节铁律 #4/#9/#10，改错会引发 TDZ 崩溃 / 记忆库损坏 / 查重误判。
