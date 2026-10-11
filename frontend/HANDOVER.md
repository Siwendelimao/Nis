# NIS 开发日志与交接 — 开新窗口直接粘贴

> 项目双端：前端 Vue3（`E:\nis+gork\nIs ui 4.0\nis-ui`）+ 后端 Python（`E:\nis+gork\nis内核\src-python`）。
> 本文件既是**交接提示词**（复制给新会话）也是**开发日志**（按会话记录改动，便于回溯）。
> 状态日期：2026-08-09 · 后端 **772 passed** · 前端 build 通过 · 办公室 iframe 已更新（ai-office-react 重新构建）

---

## 一、项目位置与环境

- 前端：`E:\nis+gork\nIs ui 4.0\nis-ui`（Vue 3.5 + Vite 6 + Pinia 3 + Tailwind 4，Tauri 2 壳，**Rust 工具链损坏不跑，纯前端为主**）
- 后端：`E:\nis+gork\nis内核\src-python`（Python，可跑 pytest；WS `ws://127.0.0.1:8765`，**当前未启动**，前端靠 mock/演示数据）
- dev server：`npm run dev` → **localhost:5173**（IPv6）；改完 `npm run build` 验证
- 无头验证：Edge CDP（`msedge.exe --headless=new --remote-debugging-port=9223`）+ Node 22 内置 WebSocket；**验证脚本写文件跑**（PowerShell 管道传中文乱码）；交互用 `Input.dispatchMouseEvent` 或页面内 `.click()`
- ⚠️ 聊天输入框是 contenteditable div 不是 textarea；聊天消息操作栏只在消息完成态渲染，headless 模拟回复下常不显示 → **验证聊天按钮接线靠代码审阅 + build**
- 后端测试：`cd E:\nis+gork\nis内核\src-python && python -m pytest -q`（**772 passed**）

## 二、铁律（用户特别叮嘱 + 事故教训）

1. **绝不用 PowerShell Set-Content/Get-Content 重写含中文的 .vue/.ts**（GBK 双重乱码曾毁文件）。读文件用 Read 工具、写用 Edit/Write 工具。必须用脚本改文件时：`[System.IO.File]::ReadAllText/WriteAllText` + `[System.Text.Encoding]::UTF8`，先读后写再验证。
2. **WS 处理收在统一入口**：全局消息 `App.vue handleGlobalMessage`；聊天消息 `ChatInterface.handleWebSocketMessage`；各 store 用 `applyWsMessage/applySnapshot` 承接。新功能别散落 WS handler。
3. **演示数据结构贴着后端消息形状**：字段名用后端的（`task_id/status/project_id/partner_id`...）。协议对齐只核对字段名，不重构。
4. **i18n 规范**：新文案必须加 `utils/i18n.ts` 的 zh+en 字典（key 语义化，`t('xxx')` 渲染）。**不要改** BwSeg/select 的 options 数组值（v-model 绑定值）、viewOptions 等逻辑值——改了破坏逻辑。
5. **快捷键**：默认在 `stores/settings.ts`，`utils/shortcuts.ts` 提供 `matchesShortcut/shortcutFromEvent`。⚠️ 关闭弹窗默认 `'Escape'`（KeyboardEvent.key 是 'Escape'，不是 'Esc'）。
6. **Vue setup 时序（TDZ）**：ChatInterface 里 `conversationMessages`（const）声明在文件后部，任何 setup 期立即执行的 watch/computed getter 访问 `getMessages` 会触发 TDZ 崩溃。**RightPanel 同样有此坑**（`browserStore`/`chatStore` 声明在文件后部，但 `viewOptions` computed / `watch(wsConnected)` 在 setup 前部用到它们会崩）——新功能涉及 store，watch/computed 一律放在对应 store 声明**之后**，或用函数/事件里调用。
7. **WS 全局消息归 App.vue，不依赖组件挂载**：内置浏览器状态（BROWSER_*）在 App.vue `handleGlobalMessage` 处理（App 级始终挂载）。若放 ChatInterface，聊天窗口不打开时状态不同步（本会话踩过）。新功能按"是否依赖当前窗口"决定放 App 还是 ChatInterface。

## 三、架构约定（已建成，勿推翻）

- **右键菜单 = 全局捕获**：`composables/useGlobalContextMenu.ts`（document 捕获阶段监听 mousedown button2 + contextmenu → preventDefault → `closest('[data-ctx]')` → 注册表 Map<key,builder> 委托）；全局唯一 `<ContextMenu>` 挂 App.vue。新右键目标：元素加 `data-ctx="xxx"` + 组件 `onMounted register(key, builder)` / `onUnmounted unregister`。
- **知识库 = 树 + 星系**：`KnowledgeFolderTree.vue` 递归（folder 用 `entry_type='folder'` + `parent_id`）+ GalaxyCanvas 星系（`stores/knowledge.ts` 扁平 entries + parent_id 成树）。
- **记忆库 = 星系 + 列表**：`MemoryGraphModal.vue` 视图切换 + 类型筛选；`stores/memoryGraph.ts` 节点含 `node_type`/scope/enabled。
- **AI 提炼 / 记忆提炼**：`utils/aiExtract.ts`（WS `AI_EXTRACT`）+ `utils/memoryExtract.ts`（WS `MEMORY_EXTRACT`）；气泡「存入知识库」走 direct-save。
- **主动记忆开关**：`stores/settings.ts` `autoMem` 持久化；开=空闲 60s 自动提炼（节流 5min）+ 侧边栏通知中心静默记录 + Windows 通知；关=手动提炼 + 关窗弹提醒。
- **系统通知中心**：侧边栏铃铛常驻（`SystemNotificationCenter.vue`），localStorage 持久化，不随关窗消失；`utils/systemNotify.ts` 统一 Windows 通知入口。
- **设置偏好全部走 `stores/settings.ts`**：`storagePath/shortcuts/autoMem/notify/persona/general/appearance` 均持久化 `nis-settings`。

## 四、开发日志（按会话时间倒序）

### 2026-08-09 · 会话 4 — 伙伴形象库（形象卡/部件库）+ 子代理选形象 + 办公室联动 + 办公室场景编辑
> 修订 2（用户反馈后）：编辑器预览确认真实 Spine 角色渲染（CDP 像素采样 31% 覆盖、居中）；新增**办公室布局编辑**、**序列帧动图**、**大预览上下结构**、**新建按钮布局调整**、**角色自动居中**。

**① 形象卡系统（部件库架构，设置→伙伴形象 tab 重做）**
- 新 `stores/avatarCards.ts`：**部件库 + 形象卡**。6 分类：`body/skin/hair/eyes/outfit/accessory`（人物身体/肤色/发型/眼/服装/配饰）
  - 部件：`{ id, category, name, kind:'preset'|'custom', src?, preset:{shape,color}?, officeSkin?, builtIn? }`
  - 内置：body=9 张 chibi（`/partners/*.png`，officeSkin 同名）；skin=4 肤色；hair=5 发型；eyes=4 眼型；outfit=5 服装
  - 每类都有**上传新部件**入口（图片 dataURL，≤1MB），自定义部件可删；后续按部件需求逐类扩充即可
  - 形象卡 = `{ id, name, parts: {category→partId} }`，localStorage 持久化（`nis-avatar-parts` / `nis-avatar-cards`）
- **预览 = 真实办公室角色（Spine chibi-stickers）**，不是潦草 SVG：
  - 新 `ChibiStage.vue`：**动态 import pixi.js + @esotericsoftware/spine-pixi-v8**（独立分包，主包不膨胀），渲染与办公室同一套骨骼/贴图（`/office/assets/characters/chibi-stickers/`），按 `skin` 设置皮肤 + 按槽位改色（发型/肤色/眼/服装 slot：`hair-front/hair-side/back-hair`、`body/skirt/collar`、`head-base`、`eye-l/r`）
  - ⚠️ 槽位改色顺序：**先 `setToSetupPose()` 再 `slot.color.set()`**（反过来 setup pose 会清掉已上色）
  - `utils/avatarRender.ts` 加 `cardPreviewSrc`：卡缩略图/伙伴头像优先用 body 的真实 chibi PNG（`/partners/*.png`），无 body 才回退 SVG；`avatarCardDataURL` 保留为 fallback
  - 编辑器预览 = `ChibiStage`（实时角色 + 配色即时生效）；选身体/发型/服装时角色皮肤与颜色实时变化
- 新 `AvatarCardEditor.vue`：形象卡编辑弹窗（名字 + 各分类部件选择 + 上传新部件 + 实时 Spine 预览 + 保存）
- `SettingsModal.vue` partnerAssets tab：形象卡网格（新建/编辑/删除）+ 办公室场景编辑入口
- 命名避坑：SettingsModal 已有性格卡编辑器的 `cardEditorOpen/openEditCard/deleteCard`，形象卡状态改名 `avatarEditorOpen/openEditAvatarCard/deleteAvatarCard`
- 前端新增依赖：`pixi.js@8.19.0`、`@esotericsoftware/spine-pixi-v8@4.2.119`

**② 子代理选形象（PartnersModal）**
- `stores/partners.ts`：`avatarCardId/setAvatarCard/clearAvatarCard`（`nis-partner-avatar-cards`）；`avatar()` **优先返回形象卡预览**（body chibi PNG），未绑卡才用上传/生成头像
- `PartnersModal.vue`：伙伴卡右下角「选择形象」按钮（已绑卡显示预览图）+ 编辑弹窗新增形象卡行（预览/选择/解除）+ 形象卡选择器弹窗（网格多选 + 「去形象库创建」跳设置）
- **「选择形象」系列按钮配色 = 主题黑白灰**（`text-gray-500 hover:bg-gray-100` / 选中 `border-gray-800 bg-gray-100` / 勾 `bg-gray-800`），不用紫色（紫色仅保留 luna 伙伴角色标签 tagClass）
- `Sidebar.vue` 接 `open-settings` → `uiStore.openSettings('partnerAssets')`

**③ 办公室联动（项目成员 + 形象卡 → iframe）**
- `RightPanel.vue`：办公室视图打开/成员/形象卡/场景资产变化时，postMessage 下发 `office_set_roster`（主 agent + 启用成员前 8 位，含 `name/color/skin/colors`，skin=形象卡 body 的 officeSkin，colors=卡各部位配色）+ `office_set_assets`；**重试-直到-ack**（office 回 `office_roster_ack` 才停），绕开 iframe ref/加载时序
- `ai-office-react`（办公室独立 React 工程，改后重打包拷到 `public/office/`）：
  - 新 `src/scene/runtimeBridge.ts`：postMessage 桥（set_roster/set_assets），初始化前套用/初始化后原地重建（**不整页刷新**）；`window.__officeDebug` 调试钩子
  - `Agent` 加 `skin?/colors?`；`AgentEntity/SpineCharacter` 按显式 skin 设置 chibi 皮肤 + `applyCardColors` 槽位改色（与前端 ChibiStage 同 slot 映射）
  - `officeLayout.buildRosterAgents(roster)`：外部名册重建（第 0=主 agent，1..8=子 agent 依次坐右侧工位）
  - `OfficeScene.applyRoster/applyAssets`：原地重建 agent/重载纹理重挂桌椅重画背景
  - `loadOfficeAssets` 改按 URL 直接加载（自定义 dataURL 自动换缓存），force 重载换素材
- **办公室场景编辑（支持动图）**：设置→伙伴形象→办公室场景（桌/椅/背景上传 **静态 PNG/JPG/WebP 或动态 GIF ≤8MB** + 恢复默认 + **点击缩略图放大预览**），存 `settings.officeAssets` → postMessage 传给办公室
- **办公室动图渲染**：office 新增依赖 `@pixi/gif@3.0.1`；`loadOfficeAssets` 识别 gif dataURL → `AnimatedGIF.fromBuffer` 解码（继承 Sprite 自动播放），`DeskEntity`/背景每实例 `clone()` 独立播放
- 新 i18n：`settings.partnerAssets.previewTitle/officeAnimatedHint` 等

**验证**：CDP 实测 13 项（形象卡建/选部件/保存/绑定）+ **Spine 预览 canvas 就绪 + 配色日志（hair→outfit 实时应用）+ 卡片缩略图 = misaki.png + 选择形象按钮灰色 + 新建按钮描边小号** + 办公室桥 standalone（roster 皮肤正确/assets 3 项）+ **GIF 动图走 AnimatedGIF 路径** + RightPanel→iframe 端到端（名册 `["Nis"]` 下发 + ack）
- 事故复盘：vite dev 对删除重建的 `public/` 目录缓存失效（返回 SPA fallback）→ **改 public/office 后必须重启 dev server**
- 办公室桥最初就绪后收到消息用 `location.reload()`，重载后父级重发竞态导致应用不上 → 改为**原地重建**（applyRoster/applyAssets/applyLayout）
- 前端 dev 运行时会报 `[WS] Error: Event`（后端未连接，预期噪音，非错误）

**修订 2 详情（用户反馈迭代）**
- **编辑器预览确认真实角色**：ChibiStage 加 `preserveDrawingBuffer`（让 CDP 像素采样可读）+ **`getLocalBounds()` 自动居中**（不受骨骼根坐标影响）；CDP 实测 bbox 居中、覆盖 31% 画布 → 与办公室小人一致
- **新建形象卡默认带 body（misaki）**：`createCard` 默认 `parts:{body:'body_misaki'}`，卡片/预览始终是真实角色，不再出现无身体时的 SVG 兜底
- **新建形象卡按钮**：与「形象卡」标题同一排、居左（`flex items-center gap-3`），小号描边按钮，不再右对齐/两排
- **办公室场景区块改上下结构**：每项（办公桌/椅子/背景）大预览在上（`h-44` 满宽）+ 操作行在下（上传图片/GIF / 上传序列帧 / 恢复默认 / 序列帧参数）
- **序列帧动图（高质量帧动画）**：上传横向帧条图 + 帧数/帧率；office `loadOfficeAssets` 支持 `frames>1` → 切片 `AnimatedSprite`（PNG 帧画质，比 GIF 清晰）；officeAssets 结构改为 `{ desk?: { src, frames?, fps? } }`（含旧字符串迁移）
- **办公室布局编辑**：新 `OfficeLayoutEditor.vue`（960×640 场景画布，拖拽工位、添加/删除子工位、保存/恢复默认，存 `settings.officeLayout`）；office `officeLayout.ts` 的 `DESKS` 改为 `export let`（ESM live binding）+ `setCustomOfficeLayout()` 重建；`OfficeScene.applyLayout` 原地重建工位并重新入座；`office_set_layout` 消息
- **动画格式说明**：GIF 256 色画质有限；序列帧（PNG 帧）画质高；两者都支持。Spine 角色动画仅用于人物（桌面小件建议用序列帧）

**修订 3 详情（用户反馈迭代 2）**
- **跨角色混搭（真正的 dress-up，不是整人换皮）**：
  - `stores/avatarCards.ts` 内置部件改为：**发型=9 个角色部件**（`sourceSkin`）、**服装=9 个角色部件**（`sourceSkin`）、**眼睛=眼型**（`attachment`=common/eye-*：默认/圆/半开/笑/星/爱心/X）、**肤色**保留色板；`AvatarPart` 加 `sourceSkin/attachment` 字段
  - **ChibiStage/office SpineCharacter 用 `Skin` 混搭合成**：base 皮肤 + 从其它角色覆盖发型槽（back-hair/hair-front/hair-side/hair-decoration/hat...）与服装槽（body/skirt/collar/belt/glove/leg-decoration...）+ 眼型 `setAttachment` + 肤色染 head-base
  - 编辑实时预览 = 身体换一套 + 发型/服装/眼/肤色各自换 → **各部位真实可见**；office 名册 `look` 字段（hair/outfit/eyeStyle/skinTone）同样混搭
  - ⚠️ spine API：`data.findSlot(name).index`（**无 `findSlotIndex`**）；`Skin.addSkin/setAttachment/getAttachment`（`@esotericsoftware/spine-pixi-v8` 导出，或经 spine-canvas→spine-core）
  - ⚠️ ChibiStage setup 动态 import 解构需含 `Skin`（漏了会 `ReferenceError: Skin is not defined`）
- **布局编辑器用真实素材**：`OfficeLayoutEditor.vue` 以真实办公室背景图（`officeAssets.background` 或默认 `/office/assets/office/office.png`）为底板，每个工位用真实办公桌/椅子图（`deskSrc/chairSrc`）显示并可拖拽；房间 div 加 `office-layout-room` class（CDP 可定位）
- 旧卡引用旧 hair/outfit id（如 hair_black_short）会悬空 → 忽略该部件（回退 base），新卡不受影响
- 其余 slot/色板约定、CDP 像素采样（preserveDrawingBuffer）、`[WS] Error: Event` 噪音等不变

**修订 4 详情（用户反馈迭代 3 —— 分类重构为「栏」+ 全身可编辑部件）**
- **部件库 12 分类**：`body/hair/hat/outfitTop/outfitBottom/skin/eyes/mouth/eyebrow/glasses/beard/accessory`；`AVATAR_UI_GROUPS` 定义编辑器「栏」= 身体/头发/帽子/衣服(上衣+下装)/皮肤/脸部细节(眼睛+嘴巴+眉毛+眼镜+胡子)/配饰
- 内置部件：帽子=erikari；上衣/下装=9 角色（`body`组 vs `leg/skirt`组，**可上衣取A、下装取B**）；眉毛=9 角色；眼镜=4 角色（misaki/nate/soeren/spineboy）；胡子=5 角色（harri/mario/nate/sinisa/soeren）；眼睛=8 样式（含豆豆眼）；**嘴巴=15 种嘴型**（mouth-neutral/smile/open/fangs/tongue/x/o-tall…）；肤色=4 色板
- 槽位分组（前端 ChibiStage + office SpineCharacter 一致）：HAIR(6)/HAT(4)/TOP(12: body+collar+belt+body-decoration+肩饰+手套+手镯+臂饰)/BOTTOM(5: leg-l/r+skirt+腿饰)/EYEBROW(2)/GLASSES(4)/BEARD(1)
- **`look` 载荷扩展**：`{ hair, hat, top, bottom, skinTone, eyeStyle, mouth, eyebrow, glasses, beard }`（替代旧 hair/outfit/eyeStyle/skinTone），RightPanel `cardLookFor` 同步
- 编辑器 UI：按 `AVATAR_UI_GROUPS` 渲染分栏，衣服栏内分「上衣/下装」两行、脸部细节栏内分 5 行；嘴巴/眼睛用 SVG 图标缩略；ChibiStage 改为单 `:look` prop（deep watch）
- 事实确认（供后续）：骨骼无独立「裤子」「鞋子」层——`leg`=腿+裤+鞋一体、`skirt`=独立裙层；想分纯裤子/单独鞋需要自建骨骼
- 验证：新栏分组 + 混搭日志（hair+hat+top+bottom+glasses+mouth 逐项叠加）+ 19945 像素渲染 + office 新 look 无错误；唯一测试文案差异（`身体` vs 实际 `人物身体`）

**修订 5 详情（用户反馈迭代 4）**
- **问题 3 修复：布局拖拽不能放置** —— `OfficeLayoutEditor` 漏了 `pointerup/pointercancel` 监听（`dragDeskId` 永不重置 → 工位一直跟随鼠标）；补上后松手即停；`setPointerCapture` 加 try/catch（合成事件会抛错）。CDP 实测：拖拽跟随（35.5%）、松手停住（afterUp===during）
- **问题 2：桌/椅/背景 = 资产库（用过的缩略图）** —— `settings.officeAssets`（当前使用，发办公室）+ 新增 `settings.officeAssetLibrary`（各类型用过的列表，`{id,src,frames,fps}`）；上传=入库+设为当前（每类型最多 6 条）；下方缩略图条点击快速切换、×删除、当前高亮；旧 officeAssets 首次迁移种子入库。CDP 实测 4 缩略图/切换/删除全过
- **问题 1：身体是完整预设，跨角色混搭会不协调（如实说明）** —— 这 9 套皮肤全是"完整人物"（自带头发+衣服），图集**无素体（裸体）贴图**，做不了"裸体再穿衣"；跨角色拼接不协调是这套美术固有代价。已做优化：**上衣组并入 `arm-l/r`**（换角色上衣时袖子一起换，减少接缝）。真·素体/自绘小人 = 干净长线方案（office 图片小人渲染可做）
- 注意事项：布局编辑器在设置弹窗底部，CDP 拖拽测试需先 `scrollIntoView`（真实用户滚动后可见）

**修订 6 详情（用户反馈迭代 5 —— 两个真 bug）**
- **布局保存无效（DataCloneError 根因）**：`settings.officeLayout/officeAssets` 是 Vue 响应式 Proxy，直接 `postMessage` 到 iframe 会抛 `DataCloneError: [object Array] could not be cloned` → 布局/资产永远发不出去（roster 是普通对象所以成员正常 → 正好对上"只有布局不生效"）。修复：RightPanel 加 `toPlain()`（JSON 深拷贝成普通对象）+ `officeFrameWindow()`（DOM 查 iframe 兜底 `officeFrameRef` 偶发未绑定）。CDP 实测：保存→office 收到布局→主工位坐标一致
- **添加成员弹窗不关闭（NotificationStack 全局点击报错）**：`NotificationStack.vue` onClickOutside 用 `panelRef.contains(el as Node)` 但 composedPath 含 `window`（非 Node）→ **每次点击都抛 TypeError**（SystemNotificationCenter 同款有 `el instanceof Node` 守卫，这里漏了）。已补守卫。另 `confirmAdd` 加 `try/finally` 保证任何异常下弹窗都关闭
- CDP 实测：添加成员（选未加入成员→确认可用→弹窗关闭→X 可用→无 JS 错误）；布局保存→office 应用 全通过
- **布局 ↔ agent 行为关联**：布局编辑器 → `settings.officeLayout` → RightPanel `office_set_layout` → office `applyLayout` 重建工位并重新入座 → 名册成员按序坐新工位、交接拜访/工作动画在新位置进行（desk-0=主 agent，desk-1..8=成员顺序）。后续可做：布局编辑器工位上显示成员名字/皮肤缩略

**修订 7 详情（用户反馈迭代 6 —— office 实时行为驱动：谁干活/什么状态/什么表情/谁派任务）**
- **office 动作桥**：新增 postMessage `office_action`（set_state / play_animation / desk_visit / desk_visit_tour）→ office `OfficeScene.setAgentState/playAgentAnimation/requestDeskVisit/requestDeskVisitTour`（复用办公室既有动作 API）；`__officeDebug.actionCount` 计数可验证
- **RightPanel 活动驱动**：
  - `partnerAgentId/partnerRosterNo`：成员按序 → `sub-N`（名册序号 2 起），Nis=main-agent=1
  - **logs 驱动**：watch `logsStore.logs` 新增 → sender 是成员时翻译：running→working(带任务)、success→emotes/hooray、fail→emotes/confused + thinking（后端 LOG_EVENT 接入即自动驱动）
  - **demo 活动循环**：办公室视图打开 + 项目窗口有成员时，每 9s 循环：**Nis desk_visit 到成员工位递话派任务 → 成员 working → 随机 success/fail 表情 → 回 idle**（后端接入后由 LOG_EVENT/任务消息驱动，demo 只是可见演示）
- ⚠️ **又踩 TDZ**：`logsStore` 声明在文件 546 行，我加的块在 348 行直接 `logsStore.logs.length` → `Cannot access before initialization`，整个 App 挂载失败（bodyLen 767 空页面）。**新功能用到的 store 一律先提到顶部 store 块**（HANDOVER 铁律 6 再验证）
- 验证：CDP 实测 office `actionCount=6`（desk_visit+working+表情+idle 循环），roster 3 名（Nis+2成员），无 JS 错误

**修订 8 详情（用户反馈迭代 7 —— 行为编排时序修正 + /test 办公室 命令）**
- **编排时序修正**（用户指出"沟通前就显示任务、沟通完直接欢呼"不对）：
  - office desk_visit 对话默认 **3.5s** + 往返，因此按 5600ms 后才 `set_state working`（任务上头顶）、再 5200ms 后 `play_animation hooray`、回工位待命
  - 流水线 `runOfficePipelineDemo()`：**Nis 沟通派活 → A 开始工作 → A 欢呼 → A 走到 B 交接下一步 → B 工作/欢呼 → … → 末位把结果交回 Nis → Nis wave 收尾**（每阶段间隔 16.5s）
  - 修复双流水线并发：`/test` 触发时 `suppressAutoDemo` 标记跳过自动 demo，只跑一条
- **`/test 办公室` 命令**：ChatInterface 新处理器 → `useOfficeActivityStore`（新 `stores/officeActivity.ts`：demoSeq/officeViewSeq）→ RightPanel 切办公室视图 + 跑一条流水线；聊天回提示"已触发办公室行为演示：Nis 正依次给 XXX 派任务…"
- office `__officeDebug.actionLog`（带时间戳，验证时序用）
- CDP 验证：desk_visit→working 间隔 5584ms（≥5s，沟通后才工作）、working→hooray 间隔 5196ms（≥4s，做完才欢呼）、actionCount=6 单流水线、无 JS 错误
- ⚠️ CDP 触发 /test 命令要点：contenteditable 需先 `focus()` + `innerHTML` + 派发合成 `KeyboardEvent('keydown',{key:'Enter'})`（Input.dispatchKeyEvent 不可靠）







### 2026-08-09 · 会话 3（本会话）— 提示音 + 技能系统 + 插件管理 + 内置浏览器引擎 + 砍假 tab
**① 提示 tab（设置→提示）补全真实提示音**
- 内置提示音 WAV → `public/sounds/`（agent/permission/error/memory/demo 五个，Node 合成）
- 新 `utils/notifySound.ts`：`playNotifySound(category)` 受开关门控；`previewSound(id)` 试听；`categorySoundSrc` 支持自定义 dataURL
- `utils/systemNotify.ts`：`notifySystem` 接入声音播放 + 新增 `soundOnly`（只播声音不弹通知，agent 完成用）
- `stores/settings.ts`：`notify.customSounds`（自定义 dataURL）+ 旧文本声音值迁移（`LEGACY_SOUND_MAP`：'斯泰普普斯斯 01'→agent 等）
- 设置页：声音下拉换 `SoundSelect.vue`（仿 ChatMenu 自定义弹出下拉，**向上弹出**）+ 试听/上传自定义（限 2MB wav/mp3/ogg/m4a）/恢复内置
- 补四类触发源：`AI_REPLY_DONE/CHAT_RESPONSE/模拟回复/DAG_COMPLETE`→agent(soundOnly)、`HITL_REQUEST`→permission、`LOG_EVENT(error)/PROJECT_ERROR`→error、自动记忆→memory(原有)

**② 技能系统（真实）**
- 新 `stores/skills.ts`：技能仓库（localStorage 持久化，预置 文档编写/测试验证/代码生成；增删/导入入库）
- 新 `utils/skillImport.ts`：zip 解析（fflate）+ **文件夹拖拽递归解析**（`webkitGetAsEntry` 找 SKILL.md frontmatter 的 name/description）
- `SkillsModal.vue` 改造：读真实 store、zip/文件夹拖拽导入、删除、按来源筛选（zip/内置）
- `stores/projects.ts`：`ProjectMember.skills`（`{skill_id, enabled}[]`）+ `setMemberSkill/toggleMemberSkill/memberEnabledSkills`
- `ProjectMemberBar.vue`：成员行删行内开关/移除，改为「配置」按钮 → 编辑弹窗（启停/删除/技能勾选）；技能经新 `SkillPickerModal.vue` 从仓库多选
- 后端：`SkillManager`（原孤岛模块）接线 WS `PROJECT_MEMBER_SKILLS_UPDATE` → `set_skill` + 回包 SYNCED（main.py `_ws_handle_member_skills`）

**③ 插件管理（真实，PluginManager 接线）**
- 后端 WS：`PLUGIN_LIST/TOGGLE/CATALOG/INSTALL/REMOVE/UPDATE_META`（读 `PluginManager.to_dict` / `toggle` / 内置候选 / 安装启动 / 卸载 / 改备注）
- 后端：`PluginRegistry` 实例化 + 内置 MCP 候选（Playwright/GitHub/Database，来自 `get_builtin_mcp_servers`）
- **插件状态持久化**：`work_dir/plugins_state.json`（备注/启停/MCP 启动配置），重启自动恢复（`_restore_plugin_state`）
- 修复：`main.py` 缺 `import json`（状态保存静默失败）；`ContextDistiller` 局部 import 遮蔽顶层 → 启动崩溃（`UnboundLocalError`），已用别名 `_ContextDistiller` 修复，`main.py` 可正常启动
- `PluginsModal.vue`：删 4 个假插件卡 → 读后端真实数据（system + MCP 插件卡、工具列表、启停、MCP 卸载）+ 导入候选弹窗 + 编辑备注（铅笔在插件名下方）；**未连后端时演示数据**（`buildDemoPlugins/buildDemoCatalog`，本地启停/导入/备注仅本地生效）

**④ 内置浏览器引擎（新，Playwright）**
- 环境：`pip install playwright` + `python -m playwright install chromium`（已装好，本机 `ms-playwright`）
- 新 `core/browser_engine.py`：Chromium 封装（有头/无头、userDataDir 持久化登录态、多标签、导航、截图 base64、cookies 列表/清除）
- **cookies/登录态持久化**：`launch_persistent_context(user_data_dir)` + 显式 `storage_state.json` 保存/恢复（重启保持，避免依赖 chromium flush 时序）
- 后端 WS：`BROWSER_START/CLOSE/MODE/NEW_TAB/CLOSE_TAB/SWITCH_TAB/NAVIGATE/GO_BACK/FORWARD/REFRESH/STOP/SCREENSHOT/COOKIES_LIST/CLEAR` + 广播 TABS/READY/STATUS
- `stores/browser.ts`：加持久化配置（mode/engine/defaultUrl 存 localStorage）
- 设置页浏览器 tab → **内置浏览器管理**：状态+启停按钮、启动模式（有头/无头）、引擎（Chromium）、默认首页、cookies 持久化说明+列表+清除；砍掉假 cookies 接受/打开行为/自动确认
- 右栏「浏览器」入口**按引擎状态显示**：`browserStore.connected` 为 true 才在下拉出现；关闭自动回退预览；删右栏启动按钮（启停走设置页）；有头/无头右栏与设置页共用 store 自动同步
- **BROWSER_* 状态处理移到 App.vue** `handleGlobalMessage`（全局挂载，不依赖 ChatInterface）；WS 连接后主动查一次 `BROWSER_STATUS`（防冷启动错过广播）；修 RightPanel `browserStore`/`chatStore` TDZ 崩溃

**⑤ 砍掉假 tab（设置页从 11 → 6 个）**
- 砍：连接（多平台/微信/远程/Bridge权限）、技能（假"8个技能"）、原生增强（图像/语音/Office/搜索全死）、安全（沙箱/目录/代理/命令/数据/MCP 全假）
- 设置页现有 6 tab：通用/供应商/人格/外观/提示/关于 + 桌宠/浏览器/伙伴形象 = 实际 9 个（桌宠/浏览器/伙伴形象非假）

**后端（772 passed，+18 测试）**
- `tests/test_browser_engine.py`（6：生命周期/导航截图/标签/cookies 重启持久化/清除）
- `tests/test_plugin_handler.py`（update_meta、state round-trip ×2、MCP config 持久化）+ `test_ws_project_handlers.py`（member skills、plugin catalog/install/remove/update_meta 分发）

### 2026-08-08 · 会话 2（本会话）— 设置页大改 + 通知中心 + 导出导入 + 聊天样式
**通知**
- 自动记忆保存不再弹顶部 toast → 写入常驻**侧边栏系统通知中心**（`SystemNotificationCenter.vue`，localStorage 持久化，不随关窗消失）
- `notifySystem()`（`utils/systemNotify.ts`）：Tauri 插件 → Web Notification → 静默；受设置「提示」四类开关门控
- 设置→提示 tab：agent/permission/error/**memory** 四类开关 + 各配提示音；仅控制 Windows 系统通知（文案注明桌面端生效）

**供应商**
- 模型选择器 = **启用的供应商**（非置顶），最多同时启用 **12 个**（超限弹窗）；dock 两排（6/6）、悬停 2D 距离最近放大、行距 52px
- 左栏卡片网格 → **供应商列表**（启用圆点 + logo + 名字 + 模型数）；右侧栏不变

**人格页（重做）**
- 基础设定：Nis 名字 / 头像（dataURL 上传）/ **性格卡体系**（预设 6 套 + 自定义；点选生效，右键或铅笔 → 编辑弹窗改/存/删；`settings.persona.cards + activeCardId` 持久化，含旧数据迁移）
- **记忆存储目录**（核心库 memory_system.db / ~/.nis / 项目 .nis + 打开文件夹）+ **记忆导出/导入**（后端 WS `MEMORY_EXPORT/IMPORT`）
- **知识库存储**（knowledge.db / knowledge_attachments + 打开文件夹）+ **知识库导出/导入**（后端 WS `KNOWLEDGE_EXPORT/IMPORT`；未连后端时导/导入 localStorage 演示数据）
- 主动记忆开关保留；**砍掉**：记忆衰减/周期、默认记忆模式、自动记忆提取、人格文件（hanako 残留）、角色卡、假统计

**通用页**
- 保留：用户信息（名字 → `settings.general.userName`，预留 USER_PROFILE）、界面语言（仅中英）、存储目录、自动修复（后端 Critic 自愈存在，预留）、日志级别（后端 logging 有，预留）、会话标题（前端 ensureAutoTitle 真生效）、快捷键
- **砍掉**：心跳监控、自动归档、会话历史

**外观页**
- 主题：**仅浅色，深色待开发**（PendingBadge；`@custom-variant dark` 定义保留、组件内 dark: 类惰性，后续加 `.dark` 可复用，避免改动面过大）
- 字体大小（13/15/17px，作用聊天区）+ 气泡头像开关 + 气泡圆角档位，真实生效
- **砍掉**：光晕/毛玻璃/动画速度/侧边栏设置（死设置）

**聊天窗口样式**
- 窗口边距 `mx-4 my-4` → `mx-1.5 my-1.5`（遮住底部聊天列表）；滚动区 `pt-8 pb-3 px-6`
- 输入框：外层去白底融入背景、去顶部横线（普通 + 后台任务视图）；输入框本身白底 + 灰边 + 阴影 **悬浮卡片**样式

**后端（754 passed，+9 测试）**
- `KnowledgeStore.export_data/import_data`；WS `MEMORY_EXPORT/IMPORT`、`KNOWLEDGE_EXPORT/IMPORT`（`tests/test_export_import.py`）
- `main.py` 新增 `_knowledge_store`（knowledge.db）+ `_ws_handle_memory_export_import` / `_ws_handle_knowledge_export_import`

### 2026-08-08 · 会话 1 — 知识库星系+树+附件+AI提炼、记忆星系+记忆提炼、主动记忆开关、气泡存入知识库
- 知识库：树 + 星系共存、类型筛选/搜索/增删改查/详情编辑、附件上传（压缩 dataURL）、AI 提炼（`AI_EXTRACT` WS + extractor.py 兜底）
- 记忆库：星系 + 列表双视图、记忆提炼（`MEMORY_EXTRACT` WS + memory_extractor.py → 项目 .nis 5 文件 + 全局 ~/.nis + DistillEngine）
- 主动记忆开关 + 关窗提醒 + 自动提炼定时器 + 系统通知（本会话改为静默记录 + Windows 通知）
- 后端 6 新模块/WS 协议：attachment_store、extractor、memory_extractor + `ATTACHMENT_UPLOAD/GET/DELETE`、`AI_EXTRACT`、`MEMORY_EXTRACT`
- 设置页删「自动更新」「用户头像」；修复聊天窗口打不开（TDZ）、星系拖拽/滑轮方向、语言切换初始化

## 五、待办（优先级排序）

1. **后端真实启动接线**：启动 `main.py` 连 WS + 配 API key → 记忆/知识库导出导入、AI/记忆提炼才能真正调用 LLM（当前提示「需连接后端」）
2. **后端 `PLAN_NOTES` 消息**（计划记事本数据源，`_create_plan` 后附加广播；低风险，不动 assignments）
3. **后端其他消息接线**：rich_message 富文本回复、`TASK_LIST/TASK_STATUS/BACKGROUND_TASK_COMPLETE` 填 tasks store、`PARTNER_CONFIG_UPDATE`、CORS 代理（LongCat 等）
4. **知识库/记忆 WS 全量接线**：`KNOWLEDGE_LIST/ADD/UPDATE/DELETE`、`MEMORY_GRAPH` → store `applySnapshot`（字段已对齐，可直接替换；当前读 localStorage 演示）
5. **USER_PROFILE 接线**：通用页用户名字 → 后端 USER_PROFILE 固定块（core_memory.set_block）
6. **i18n 剩余**：动态数据/选项值保留未抽（BwSeg/select options）；`/test` 演示命令注入的 blocks 内容仍中文
7. **深色主题**（若做）：根元素加 `.dark` + 复用现有 dark: 类
8. **素材版权**：office.png / chibi Spine 商用前替换
9. **浏览器引擎 Firefox/WebKit**（若做）：`python -m playwright install firefox webkit` + engine 下拉放开选项（当前只 Chromium）
10. **插件演示数据清理**：PluginsModal 的 `buildDemoPlugins/buildDemoCatalog`（未连后端时假数据），等后端接线完删
11. **技能执行链路**：SkillManager 已接线存配置，但技能"执行"仍是占位（`_skill_execute_wrapper` 返回假字符串）；前端 SkillsModal 无"执行/编辑技能内容"入口

## 六、关键文件

- 前端：`App.vue`（WS 全局 + BROWSER_* 状态 + 全局右键）、`ChatInterface.vue`（~3100 行）、`SettingsModal.vue`（~1900 行，9 tab）、`RightPanel.vue`（预览/浏览器/办公室，含办公室 postMessage 桥）、`Sidebar.vue`、`SystemNotificationCenter.vue`、`SkillsModal.vue`（技能仓库）、`SkillPickerModal.vue`（成员选技能）、`PluginsModal.vue`（插件管理）、`SoundSelect.vue`（仿 ChatMenu 弹出下拉）、`ProjectMemberBar.vue`（成员配置弹窗）、**`AvatarCardEditor.vue`（形象卡编辑）、`PartnersModal.vue`（子代理 + 选形象）、`ChibiStage.vue`（真实 Spine 角色预览，动态 import pixi+spine）、`OfficeLayoutEditor.vue`（办公室布局拖拽编辑）**
- store/工具：`stores/{settings,providers,notifications,knowledge,memoryGraph,ui,projects,skills,browser,chat,avatarCards}.ts`、`utils/{i18n,systemNotify,notifySound,skillImport,dataTransfer,aiExtract,memoryExtract,attachmentClient,testConnection,recommend,shortcuts,avatarRender}.ts`
- 后端：`nis内核/src-python/{main.py, network/ws_bridge.py, core/browser_engine.py, core/knowledge/{store,attachment_store,extractor,models,schema}.py, core/memory/{store,memory_extractor,distill,project_memory,global_memory,memory_graph,plugin_manager,external_mcp,mcp_plugin}.py, core/skill_manager.py, partners/base.py}`
- 办公室独立工程：`E:\nis+gork\ai-office-react`（React+Pixi+Spine；改后 `npm run build` → 清空重拷 `nis-ui/public/office/`；关键：`src/scene/runtimeBridge.ts` postMessage 桥、`OfficeScene.ts` applyRoster/applyAssets、`officeLayout.ts` buildRosterAgents、`characters/SpineCharacter.ts` 按显式 skin）
- 测试：`tests/{test_browser_engine,test_plugin_handler,test_export_import,test_knowledge,test_knowledge_attachments,test_ai_extract,test_memory_extractor,test_ws_model_handlers,test_ws_project_handlers,test_partner_recommend}.py`

## 七、验证方法

- 前端：`npm run build`；CDP 脚本写文件跑（提示音下拉/上传、技能仓库 zip 导入、插件面板、成员技能勾选、设置页 tab、右栏浏览器入口按引擎状态、**形象卡建/选部件/绑定、办公室桥 standalone + RightPanel→iframe 端到端**已实测）
- 办公室验证钩子：office 页 `window.__officeDebug`（roster/assets/ready）；父级发 `office_set_roster` → office 回 `office_roster_ack`
- ⚠️ **改 `public/office/`（删除重建）后必须重启 vite dev server**（vite 对 public 目录有缓存失效，会 404/SPA fallback）
- 后端：`python -m pytest -q`（全量 772）；新功能补测试（参考 test_browser_engine / test_plugin_handler / test_ws_project_handlers）
- 改含中文文件后用 Read 工具验证完整性（防乱码）
- 内置浏览器真实跑：后端 `main.py` 能启动后，WS 发 `BROWSER_START` → 设置页/右栏状态联动（本会话用临时 hold_browser.py 验证后已删，需时可重建）

## 八、注意

- 后端未启动时前端是演示模式（创建项目可跳过模型测试；推荐走本地规则；AI/记忆提炼、记忆/知识库导出导入提示需连接后端；插件面板显示演示数据）
- 后端 `_recommend_partners` 的规则兜底 `_recommend_by_rules` 与前端 `recommendPartnersMock` 语义一致，改规则要两边同步
- `_create_plan` 改动影响核心派发 + 测试（test_project_member_dispatch / test_mcp_system / test_background_task），改前先读
- 记忆提炼写的是项目 `.nis`（progress/pitfalls/patterns/decisions.md）和全局 `~/.nis`（preferences/decisions/lessons.md），前端 MemoryExtractModal 只展示结果（落盘由后端做）
- 项目记忆文件（.nis 下 5 个 .md）历史上有 append_section 但一直没接线，现在由记忆提炼自动写入
- 深色主题为预留状态：`@custom-variant dark` 已定义、主要组件已带 dark: 变体，但无 `.dark` 祖先故不生效；若实现仅需在 App.vue 根元素按设置加 `.dark`
- **前端新增依赖**（形象卡 Spine 预览）：`pixi.js@8.19.0`、`@esotericsoftware/spine-pixi-v8@4.2.119`（ChibiStage 动态 import 拆包，仅编辑器打开时加载）；**办公室新增** `@pixi/gif@3.0.1`（动图桌/椅/背景）
- 形象卡跨角色混搭槽位分组（前端 ChibiStage 与 office SpineCharacter 保持一致）：发型 HAIR(back-hair/back-hair-long/hair-front/hair-side/hair-decoration)、帽子 HAT(hat-top/hat-border/hat-border-back/strawberries)、上衣 TOP(body/collar/belt/body-decoration/肩饰/手套/手镯/臂饰)、下装 BOTTOM(leg-l/r/skirt/腿饰)、眉毛 EYEBROW(eyebrow-l/r)、眼镜 GLASSES(glasses/glasses-side/glasses-shadow)、胡子 BEARD(beard)；眼睛/嘴巴用 `setAttachment` 换 common/eye-*、common/mouth-*；肤色染 head-base。混搭用 `Skin`(spine-core) 合成：`mix.addSkin(base)` + 各来源皮肤 `getAttachment` 覆盖
- **officeAssets 结构已改**：`{ desk?: { src, frames?, fps? } }`（序列帧支持）；旧字符串值自动迁移。office `loadOfficeAssets` 支持 静态图/GIF(AnimatedGIF)/序列帧(AnimatedSprite)；`office_set_layout` 传 `settings.officeLayout`（工位摆放），office `DESKS` 为 `export let` live binding + `applyLayout` 原地重建
- **Playwright 已安装**：`pip install playwright` + `python -m playwright install chromium`（本机 `C:\Users\Administrator\AppData\Local\ms-playwright`）；浏览器引擎只在连上后端且启动后才可用
- **main.py 现已能启动**（修了 ContextDistiller bug），但 MCP 可选依赖缺失时 `_MCP_AVAILABLE=False` 降级，不影响 WS/浏览器
- RightPanel `viewOptions` 现在由 computed 按 `browserStore.connected` 动态生成（浏览器入口按引擎状态显示）——**不要改回写死数组**，否则会绕过"能用的才显示"约定
