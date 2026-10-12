import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useChatStore } from './chat'
import { localStore, onHydrated } from '@/utils/localStore'
import { swallowed } from '@/utils/swallowed'

interface ShortcutMap {
  send: string
  newline: string
  close: string
}

interface NotifySettings {
  agent: boolean
  permission: boolean
  error: boolean
  memory: boolean
  /** 0914 下午：QQ/微信机器人回复消息（后端 host/channel-reply 帧触发） */
  channel: boolean
  /** 声音 id：BUILTIN_SOUNDS 中的 id 或 'custom'（自定义） */
  agentSound: string
  permissionSound: string
  errorSound: string
  memorySound: string
  channelSound: string
  /** 自定义声音 dataURL，按类别存（settings.notify.agentSound 为 'custom' 时使用） */
  customSounds: Partial<Record<'agent' | 'permission' | 'error' | 'memory' | 'channel', string>>
  /** 0914c：提示音统一音量（0~1；设置页滑杆调节，试听与实播共用） */
  volume: number
}

interface GeneralSettings {
  /** 用户名字（后端 USER_PROFILE，Nis 记住用户） */
  userName: string
  /** 自动修复（后端 Critic 自愈引擎；硬编码参数，预留开关） */
  autoRepair: boolean
  /** 日志级别（后端 logging level；预留） */
  logLevel: string
  /** 会话自动生成标题（前端 ensureAutoTitle 真实生效） */
  sessionTitle: boolean
  /** 0914：命令终端——AI run_command 用哪个 Shell；0918 增加 auto=按命令语法自动挑 */
  cmdShell: 'cmd' | 'powershell' | 'pwsh' | 'auto'
  /** 环境安装目录（PowerShell / Chromium / Node / Git 等运行时的默认安装位置） */
  envDir: string
  /** ★1012m：**工作纪律（判断与纠错）** —— 开启后在 system 里注入"工作原则"段，且该段**优先于人格设定**
      （人格只决定语气/风格，行为要求以工作原则为准）。默认开；关闭则完全不注入
      （给本地小模型短板、恋爱文字游戏、角色扮演等场景留后路）。旧数据没有这个键 = 按开处理。 */
  criticDiscipline: boolean
  /** C3 上下文自动压缩：长会话达到窗口阈值时把早期轮次摘要化（默认开；仅 >80% 窗口才触发） */
  contextCompaction: boolean
  /** 压缩触发阈值（占上下文窗口百分比，默认 80；0910 新增可调，30~95） */
  contextCompactThresholdPct: number
  /** 压缩后保留近期上下文的占比（默认 35；0910 新增可调，10~90，余下折进摘要） */
  contextKeepPct: number
  /** 0910 三批⑤：文件变更历史配额（按对话计；缺省 200） */
  historyMaxPerSession: number
  /** 0911 反馈：历史占用自动清理（默认开；对象库占用 ≥ 阈值 MB 时裁掉最旧 pct% 记录） */
  historyAutoCleanEnabled: boolean
  historyAutoCleanThresholdMb: number
  historyAutoCleanPct: number
  /** 0911：自动续跑护栏（0=不设限）：总轮数上限 30-150；单轮 token 预算 50万-1000万 */
  autoContinueRounds: number
  turnTokenBudget: number
  /** 0911：成员单次运行上限（分钟；0=不设限）——单个成员一次派发的最长连续工作时长（默认 30） */
  memberRunLimitMinutes: number
  /** 0911 三批：成员巡检官——运行中检测偏离主线/陷入循环，先纠偏再犯中止（默认开） */
  memberInspector: boolean
  /** ★ 0923（用户定）：询问卡（ask_user）超时秒数；0 = 不超时（默认 180 = 3 分钟）。
   *  超时后：挂通知中心 + 系统通知 → 自动关掉卡片 → 按「用户跳过」提交给 AI。 */
  questionTimeoutSec: number
  /** 压缩时把全量对话导出到工作区 transcript.md，供模型按需回读长线细节（默认开） */
  archiveTranscriptMd: boolean
  /** 0909⑦ AI 回复中发消息的默认通道：steer=插话（当前轮工具跑完即注入）/ queue=排队（整轮结束后自动发出）。
   *  反向通道固定绑 Ctrl+Enter（与默认互换）。 */
  busySendMode: 'steer' | 'queue'
  /** ★0927 N1：按「停止」时排队消息怎么处理 —— continue=只停当前轮、队列按序继续发（默认）；
   *  pause=连队一起按住（队列条出现「继续发送」）。另：队里恰好 1 条时无条件退回输入框（丙）。 */
  cancelQueueMode: 'continue' | 'pause'
  /** 0915：开发者模式（关于页开关；打包版=从源码目录加载前后端，免重新构建） */
  devMode: boolean
  /** ★ 0921z：技能开关（从设置页搬到「技能仓库」SkillsModal）
   *  · skillAutoSelect：主开关——是否允许 AI 自己选用技能（关掉则技能清单不注入、use_skill 一律拒绝）
   *  · disabledSkills：**存"被关掉的"技能名**（新装技能默认可用，比存白名单安全） */
  skillAutoSelect?: boolean
  disabledSkills?: string[]
  /** ★ 0922z：长对话分批加载 —— 打开会话时只拉最后 20 轮，上滑自动补更早（关掉 = 一次拉全量） */
  /** ★ 0923（用户定案）：后台任务
   *  · bgAutoResume：开关（默认开）—— 任务结束且 AI 空闲时自动替它开一轮接着干
   *    （成功做下一步、失败查原因；用户在对话时不打断，先答完用户再续）
   *  · bgAutoResumeMax：一条续跑链最多自动跑几轮（默认 3，夹 1~10）
   *    —— 防无人看管时反复试错烧 token 的护栏；到上限会停下来提示用户
   *  · bgWatchAutoWake：AI 自约的定时回访到点、会话空闲时是否自动把它叫起来（默认开）
   *    关掉 = 只记一条待办，等用户下次发话时一并告诉它（省 token 保守档） */
  bgAutoResume?: boolean
  bgAutoResumeMax?: number
  bgWatchAutoWake?: boolean
  /** ★1010h：外部预设（codex/ACP）是否随消息附带 NIS 记忆/知识库召回背景段（默认开） */
  extPresetContext?: boolean
  /** ★ 0923（用户定案）：AI 读文件的默认上限 —— 0=自动（小文件整份读完、超 24000 封顶），>0=锁死字符数；模型显式传 maxChars 始终优先 */
  fsReadMaxChars?: number
}

/** 环境安装状态（演示用，真实安装待桌面端打包时接线） */
type EnvInstallState = 'not-installed' | 'installing' | 'uninstalling' | 'installed'

type ThemeMode = '浅色' | '深色' | '跟随系统' | '按时间'
type FontSize = '小' | '标准' | '大'
type BubbleRadius = '小' | '中' | '大'

/** ★1010 用户气泡预设色（设置页色板；空 string = 默认蓝紫渐变） */
export const BUBBLE_COLORS: { id: string; color: string }[] = [
  { id: 'blue', color: '#2563eb' },
  { id: 'indigo', color: '#4f46e5' },
  { id: 'violet', color: '#7c3aed' },
  { id: 'emerald', color: '#047857' },
  { id: 'rose', color: '#e11d48' },
  { id: 'amber', color: '#b45309' },
  { id: 'slate', color: '#334155' },
  { id: 'cyan', color: '#0e7490' },
]

/** ★1010 界面字体预设：value = font-family 值（'' = 默认）；check = 用 document.fonts.check 探测的名字（'' = 始终显示）。
 *  只列"本机装了的"——避免用户选了没反应。 */
export const FONT_PRESETS: { id: string; value: string; check: string }[] = [
  { id: 'default', value: '', check: '' },
  { id: 'yahei', value: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif', check: 'Microsoft YaHei' },
  { id: 'system', value: 'system-ui, -apple-system, "Segoe UI", sans-serif', check: '' },
  { id: 'dengxian', value: '"DengXian", "Microsoft YaHei", sans-serif', check: 'DengXian' },
  { id: 'simhei', value: '"SimHei", sans-serif', check: 'SimHei' },
  { id: 'segoe', value: '"Segoe UI", "Microsoft YaHei", sans-serif', check: 'Segoe UI' },
  { id: 'sourcehan', value: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif', check: 'Source Han Sans SC' },
  { id: 'lxgw', value: '"LXGW WenKai", "KaiTi", serif', check: 'LXGW WenKai' },
  { id: 'kaiti', value: '"KaiTi", "STKaiti", serif', check: 'KaiTi' },
  { id: 'simsun', value: '"SimSun", "Songti SC", serif', check: 'SimSun' },
  { id: 'consolas', value: 'Consolas, "Courier New", monospace', check: 'Consolas' },
]

interface AppearanceSettings {
  /** 主题模式：浅色 / 深色 / 跟随系统 / 按时间（0917 新增） */
  themeMode: ThemeMode
  /** 0917「按时间」模式：浅色时段起（HH:mm）。区间外为深色；start > end 视为跨零点（如 20:00→07:00） */
  themeLightStart?: string
  /** 「按时间」模式：浅色时段止（HH:mm） */
  themeLightEnd?: string
  /** 字体大小 */
  fontSize: FontSize
  /** 气泡显示头像 */
  bubbleAvatar: boolean
  /** 气泡圆角 */
  bubbleRadius: BubbleRadius
  /** ★1010 用户气泡配色：'' = 默认蓝紫渐变；否则为 '#rrggbb'（预设色与色盘自选都存具体色值） */
  bubbleColor?: string
  /** ★1010 界面字体：'' = 默认（Inter + 系统回退）；否则为 font-family 值 */
  fontFamily?: string
  /** 0906 背景图：dataURL（''=无图；前端限 2MB，settings.json 随之增大属可接受） */
  bgImage: string
  /** 背景图浓度 0.05~1（主区底图上叠底色的混合强度） */
  bgOpacity: number
  /** 0907 动效档位：full=全效（默认）/ balanced=关无限循环装饰动画 / eco=节能（磨砂全关+过渡归零） */
  fxLevel?: 'full' | 'balanced' | 'eco'
  /** ★ 0923：回复完成后把「过程态」（Think 行 + 工具行）折成一行，回看更干净；内联通知不参与折叠
   *  ★1010（需求）：升级为**三档**，`processFoldMode` 为权威字段：
   *    'full'  = 完全展示（什么都不折，等价旧的 foldProcessOnDone:false）
   *    'tools' = 折叠工具（默认；连续工具调用折成一行，思考不参与，等价旧的 true）
   *    'all'   = 全部折叠（除正文外，**连思考一起**折进那一行；展开仍可看）
   *  旧字段 `foldProcessOnDone` 保留并**与新字段双写**（任何只认布尔的地方行为也正确）。 */
  processFoldMode?: 'full' | 'tools' | 'all'
  foldProcessOnDone?: boolean
}

interface PersonaSettings {
  /** Nis 名字（气泡/问候语/标题展示） */
  nisName: string
  /** 头像（dataURL，聊天气泡 Nis 回复用） */
  avatar: string
  /** 性格提示词：一段话描述 AI 的性格与说话方式（发给模型的系统提示词人格层） */
  prompt: string
}

const STORAGE_KEY = 'nis-settings'
const DEFAULT_STORAGE_PATH = 'C:/Users/Administrator/Documents/NisData'

const DEFAULT_SHORTCUTS: ShortcutMap = {
  send: 'Enter',
  newline: 'Shift+Enter',
  close: 'Escape',
}

const DEFAULT_NOTIFY: NotifySettings = {
  agent: true,
  permission: true,
  error: true,
  memory: true,
  channel: true,
  agentSound: 'agent',
  permissionSound: 'permission',
  errorSound: 'error',
  memorySound: 'memory',
  channelSound: 'channel',
  customSounds: {},
  volume: 0.8,
}

/** 旧版提示音文本值（Windows 系统声音名）→ 内置声音 id 迁移映射 */
const LEGACY_SOUND_MAP: Record<string, string> = {
  '斯泰普普斯斯 01': 'agent',
  '斯泰普普斯斯 02': 'error',
  '费 03': 'memory',
}

const DEFAULT_PERSONA: PersonaSettings = {
  nisName: 'Nis',
  avatar: '',
  prompt: '',
}

/**
 * 0920（需求）：NIS 的**默认头像就用 logo**。
 *
 * 语义是"未设置时的显示兜底"，不是写进配置 —— 所以：
 *   · `persona.avatar` 仍保持 '' 表示"用户没设过"（存量安装同样受益，无需迁移数据）；
 *   · 渲染处一律用 `nisAvatar`（= 自定义 || 默认 logo），见 PiChatView / ChatInterface / 设置页；
 *   · 用户点「移除头像」= 回到默认 logo 显示。
 * 用的 `nis-app-icon.png`（圆角方形应用图标，2133²），直接当头像不用再裁。
 */
export const DEFAULT_NIS_AVATAR = '/nis-app-icon.png'

export const DEFAULT_GENERAL: GeneralSettings = {
  userName: '用户',
  autoRepair: true,
  logLevel: '信息',
  sessionTitle: true,
  cmdShell: 'cmd',
  envDir: '',
  /* ★1012m：工作纪律默认开（用户定稿：开关就是唯一裁决，不在提示词里做场景例外 —— 忘了就自己关） */
  criticDiscipline: true,
  contextCompaction: true,
  contextCompactThresholdPct: 80,
  contextKeepPct: 35,
  historyMaxPerSession: 200,
  historyAutoCleanEnabled: true,
  historyAutoCleanThresholdMb: 500,
  historyAutoCleanPct: 20,
  autoContinueRounds: 150,
  turnTokenBudget: 2_000_000,
  memberRunLimitMinutes: 30,
  memberInspector: true,
  archiveTranscriptMd: true,
  busySendMode: 'queue',
  /* ★0927 N1：停止时队列默认继续按序发（甲）；改成 'pause' 则按住队列（乙） */
  cancelQueueMode: 'continue',
  devMode: false,
  // ★ 0921z：技能开关默认值 —— AI 可自主选用技能；没有任何技能被停用
  skillAutoSelect: true,
  disabledSkills: [],
  // ★ 0922z：分批加载默认开（长对话首屏秒开；短对话体感无差别）
  // ★ 0923：后台任务 —— 自动续跑默认开、最多 3 轮；回访自动唤醒默认开（与后端缺省一致）
  bgAutoResume: true,
  bgAutoResumeMax: 3,
  bgWatchAutoWake: true,
  extPresetContext: true,
  // ★ 0923：AI 读文件默认上限 —— 0 = 自动（≤24000 整读），与后端缺省一致
  fsReadMaxChars: 0,
  // ★ 0923：询问卡超时（秒）—— 默认 3 分钟；0 = 不超时
  questionTimeoutSec: 180,
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
  themeMode: '浅色',
  themeLightStart: '07:00',
  themeLightEnd: '19:00',
  fontSize: '标准',
  bubbleAvatar: true,
  bubbleRadius: '中',
  // ★1010 外观新增：气泡配色 / 界面字体（'' = 各自默认）
  bubbleColor: '',
  fontFamily: '',
  bgImage: '',
  bgOpacity: 0.5,
  fxLevel: 'full',
  // ★ 0923：默认开 —— 回复完成后自动折起过程态（外观页可关）
  foldProcessOnDone: true,
}

/**
 * 通用设置 —— 存储目录 / 快捷键 / 主动记忆（localStorage 持久化，桌面本地）。
 * 语言走 utils/i18n.ts 的 lang。
 */
export const useSettingsStore = defineStore('settings', () => {
  const storagePath = ref(DEFAULT_STORAGE_PATH)
  const shortcuts = ref<ShortcutMap>({ ...DEFAULT_SHORTCUTS })
  /** 主动记忆：开=对话空闲/关窗自动提炼；关=仅手动（关窗弹窗询问） */
  const autoMem = ref(false)
  /** 系统通知偏好：哪些事件弹系统通知 + 对应提示音 */
  const notify = ref<NotifySettings>({ ...DEFAULT_NOTIFY })
  /** 人格：名字 / 头像 / 性格 / 说话风格（气泡与问候语共用） */
  const persona = ref<PersonaSettings>({ ...DEFAULT_PERSONA })
  /** 通用：用户名字 / 自动修复 / 日志级别 / 会话标题 */
  const general = ref<GeneralSettings>({ ...DEFAULT_GENERAL })
  /** 环境安装状态（演示：envId → 状态），真实安装待桌面端接线 */
  const envStates = ref<Record<string, EnvInstallState>>({})
  /** 外观：主题 / 字体大小 / 气泡头像 / 气泡圆角 */
  const appearance = ref<AppearanceSettings>({ ...DEFAULT_APPEARANCE })

  function load() {
    try {
      const raw = localStore.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw)
      if (typeof data.storagePath === 'string' && data.storagePath) {
        storagePath.value = data.storagePath
      }
      if (data.shortcuts && typeof data.shortcuts === 'object') {
        shortcuts.value = { ...DEFAULT_SHORTCUTS, ...data.shortcuts }
      }
      if (typeof data.autoMem === 'boolean') autoMem.value = data.autoMem
      if (data.notify && typeof data.notify === 'object') {
        const n: any = { ...DEFAULT_NOTIFY, ...data.notify }
        // 迁移旧版提示音（Windows 系统声音名文本）→ 内置声音 id
        // ★1010 补 channelSound：原先漏了它，老配置里 channel 档的脏值不会被兜底到默认值
        for (const key of ['agentSound', 'permissionSound', 'errorSound', 'memorySound', 'channelSound'] as const) {
          const v = n[key]
          if (typeof v === 'string' && LEGACY_SOUND_MAP[v]) {
            n[key] = LEGACY_SOUND_MAP[v]
          } else if (typeof v !== 'string') {
            n[key] = DEFAULT_NOTIFY[key]
          }
        }
        if (!n.customSounds || typeof n.customSounds !== 'object') {
          n.customSounds = {}
        }
        // 0914c：音量兜底（旧数据无该字段 → 默认 0.8；钳制 0~1 防脏值）
        if (typeof n.volume !== 'number' || !Number.isFinite(n.volume)) n.volume = DEFAULT_NOTIFY.volume
        n.volume = Math.min(1, Math.max(0, n.volume))
        notify.value = n
      }
      if (data.general && typeof data.general === 'object') {
        general.value = { ...DEFAULT_GENERAL, ...data.general }
      }
      if (data.envStates && typeof data.envStates === 'object') {
        envStates.value = { ...data.envStates }
      }
      if (data.appearance && typeof data.appearance === 'object') {
        appearance.value = { ...appearance.value, ...data.appearance }
      }
      if (data.persona && typeof data.persona === 'object') {
        const p = data.persona as any
        // 迁移：旧版性格卡（cards/activeCardId）或更早的内联性格 → 合成一段性格提示词
        let migratedPrompt = typeof p.prompt === 'string' ? p.prompt : ''
        if (!migratedPrompt) {
          const active = Array.isArray(p.cards)
            ? p.cards.find((c: any) => c.id === p.activeCardId) || p.cards[0]
            : null
          if (active) {
            migratedPrompt = [active.personality, active.speakingStyle].filter(Boolean).join('；')
          } else if (typeof p.personality === 'string' || typeof p.speakingStyle === 'string') {
            migratedPrompt = [p.personality, p.speakingStyle].filter(Boolean).join('；')
          }
        }
        persona.value = {
          nisName: p.nisName || DEFAULT_PERSONA.nisName,
          avatar: p.avatar || '',
          prompt: migratedPrompt,
        }
      }
    } catch {
      /* ignore */
    }
  }

  function persist() {
    try {
      localStore.setItem(STORAGE_KEY, JSON.stringify({
        storagePath: storagePath.value,
        shortcuts: shortcuts.value,
        autoMem: autoMem.value,
        notify: notify.value,
        persona: persona.value,
        general: general.value,
        appearance: appearance.value,
        envStates: envStates.value,
      }))
    } catch {
      /* ignore */
    }
    pushToBackend()
  }

  /** ★1012ah：**写基线** —— 上一次"已成功写到后端"的设置快照（键值对，仅用于 diff）。
   *  背景（用户远程实测）：写后端原先是**整份 20+ 字段**一起发 ⇒ **任何一端**的任意设置变化，
   *  都会把它那一份全量值写回后端，从而**盖掉另一端刚改的字段**（"设置改完总变成其他的"）。
   *  修法：写之前跟基线 diff，**只发变化过的字段**；后端回读后把基线对齐到后端值。 */
  let lastSynced: Record<string, any> = {}
  /** ★1012aj：**是否已经跟后端对齐过一次**。实测：「手机端每次进页面就重置一次设置；
   *  改一个字段点保存后 PC 和手机都还原；**点进设置点取消**仍然会重置 PC 的设置」。
   *  机制：进页面时 `load()` 从 localStorage 拿到的是**默认值/旧值**（手机首次访问、或缓存被清），
   *  而任何一次 `persist()`（打开设置面板就会触发 appearanceDraft 的 deep watch）都会 `pushToBackend()`，
   *  此时基线还是空的 ⇒ **整份默认值被写回后端** ⇒ 覆盖 PC 的设置；随后 `syncFromBackend()` 再拉回
   *  这份"被写坏的后端" ⇒ 全端都变默认。
   *  ⇒ 守卫：**与后端对齐过之前，绝不写后端**（该由后端权威值来决定初始状态，而不是本地默认值）。 */
  let syncedOnce = false
  /** ★1012aj：对齐完成之前发生过的本地改动 —— 需在对齐后补发一次（否则"一进页面就改"会丢）。 */
  let pendingLocalChange = false
  function diffAgainstBaseline(full: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {}
    for (const k of Object.keys(full)) {
      if (JSON.stringify(full[k]) !== JSON.stringify(lastSynced[k])) out[k] = full[k]
    }
    return out
  }

  let pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 防抖推送到后端（AI 与前端共享同一份设置，AI 改名工具也能改） */
  function pushToBackend() {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      /* ★1012aj：还没跟后端对齐过 ⇒ **绝不写** —— 否则会把本地默认值/旧缓存整份写回后端，
         等于"进一次页面就把 PC 的设置重置一遍"（实测："点进设置点取消也会重置 PC"）。 */
      if (!syncedOnce) {
        /* ★1012aj：把这次改动**记下来**，等对齐完成后自动补发（否则"一进页面就改设置"会丢，只留在本机）。 */
        pendingLocalChange = true
        return
      }
      const chatStore = useChatStore()
      const fullPatch: Record<string, any> = {
        /* ★1012ai：**先铺 general 全量** —— 这份 patch 是**手工白名单**，历史上反复漏字段
           （文件里已两处注释写着"不进这份白名单＝设置页怎么拨都不生效"）。
           实测回退的三个字段里，`questionTimeoutSec`（超时无应答）**压根不在这份白名单里**
           ⇒ 改完永远写不到后端 ⇒ 60s 后回读被旧值覆盖＝"改完总会自己变回去"。
           铺全量后：① 新增字段自动带上、不会再漏；② 下面的 diff 只发"变化过的字段"，零多余流量；
           ③ 后端对其白名单外的字段会忽略，无副作用。 */
        ...general.value,
        userName: general.value.userName,
        nisName: persona.value.nisName,
        avatar: persona.value.avatar,
        prompt: persona.value.prompt,
        storagePath: storagePath.value,
        autoRepair: general.value.autoRepair,
        logLevel: general.value.logLevel,
        sessionTitle: general.value.sessionTitle,
        envDir: general.value.envDir,
        cmdShell: general.value.cmdShell,
        contextCompaction: general.value.contextCompaction,
        contextCompactThresholdPct: general.value.contextCompactThresholdPct,
        contextKeepPct: general.value.contextKeepPct,
        historyMaxPerSession: general.value.historyMaxPerSession,
        historyAutoCleanEnabled: general.value.historyAutoCleanEnabled,
        historyAutoCleanThresholdMb: general.value.historyAutoCleanThresholdMb,
        historyAutoCleanPct: general.value.historyAutoCleanPct,
        autoContinueRounds: general.value.autoContinueRounds,
        turnTokenBudget: general.value.turnTokenBudget,
        memberRunLimitMinutes: general.value.memberRunLimitMinutes,
        memberInspector: general.value.memberInspector,
        devMode: general.value.devMode,
        archiveTranscriptMd: general.value.archiveTranscriptMd,
        /* ★ 0921z（修真 bug）：这两个技能开关**此前没进推送白名单** —— 设置页里怎么拨都只落到
         *   localStorage，后端 globalSettings 从来没收到过；而 AI 侧判定（清单注入 / use_skill）
         *   读的正是后端那份 ⇒ 表现为"关了还能调"。搬到技能仓库时一并补上。 */
        skillAutoSelect: general.value.skillAutoSelect !== false,
        disabledSkills: Array.isArray(general.value.disabledSkills)
          ? general.value.disabledSkills.map((x: any) => String(x)).filter(Boolean)
          : [],
        /* ★ 0922z：分批加载开关（前端读；后端仅持久化） */
        /* ★ 0923：后台任务（后端才是消费方：前两个决定续跑、第三个决定回访是否自动唤醒）
           ⚠️ 不加进来的话，设置页怎么拨都只落 localStorage，后端永远收不到（技能开关踩过同样的坑）。 */
        bgAutoResume: general.value.bgAutoResume !== false,
        bgAutoResumeMax: Math.min(Math.max(Math.round(Number(general.value.bgAutoResumeMax) || 3), 1), 10),
        bgWatchAutoWake: general.value.bgWatchAutoWake !== false,
        extPresetContext: general.value.extPresetContext !== false,
        fsReadMaxChars: Math.min(Math.max(Math.round(Number(general.value.fsReadMaxChars) || 0), 0), 200000),
        /* ★0927 N1：按「停止」时队列的处置（甲 continue=继续按序发 / 乙 pause=按住队列）
           ⚠️ 同样的坑：不进这份 patch 白名单（+ 后端 settings.update 白名单）＝设置页怎么拨都不生效。 */
        cancelQueueMode: general.value.cancelQueueMode === 'pause' ? 'pause' : 'continue',
        /* ★1012（老大实测：选「完全展示」→ 新装/导入数据后又变回「折叠工具」）：
           外观这一整块此前**既不在前端这份 patch、后端 settings.get 又是扁平口径**（没有嵌套 appearance）
           ⇒ 折叠档位/主题/字号这些**只写进了 localStorage**，换安装版或导入数据必丢（回落默认 'tools'）。
           ⚠️ 口径：后端白名单是**扁平字段**（processFoldMode / themeMode / fontSize …）⇒ 必须逐字段发；
           发 `appearance: {...}` 整块会被后端按白名单**忽略**。 */
        themeMode: appearance.value.themeMode,
        themeLightStart: appearance.value.themeLightStart,
        themeLightEnd: appearance.value.themeLightEnd,
        fontSize: appearance.value.fontSize,
        bubbleAvatar: appearance.value.bubbleAvatar,
        bubbleRadius: appearance.value.bubbleRadius,
        processFoldMode: appearance.value.processFoldMode,
        foldProcessOnDone: appearance.value.foldProcessOnDone,
      }
      // ★1012ah：**只发与基线不同的字段**；无变化就不发请求（少一次跨端互相覆盖的机会）
      const patch = diffAgainstBaseline(fullPatch)
      if (Object.keys(patch).length === 0) { pendingWrite = false; return }
      lastLocalWriteAt = Date.now()
      pendingWrite = true   // ★1012ag：写入期间禁止回读
      chatStore.bridgeRpc('settings.update', { settings: patch })
        .then(() => {
          /* ★1012ah：写成功 → 把这些字段记入基线（它们已是后端值，下次不再重复发）。 */
          lastSynced = { ...lastSynced, ...patch }
          pendingWrite = false
        })
        .catch((e) => {
          /* ★1012ag：**写入失败就保持 pendingWrite=true** —— 后续 syncFromBackend 一律跳过，
             不再拿后端旧值把用户刚改的覆盖掉。用户："设置绝对不只这三个字段有这问题"⇒
             这里是**全局守卫**（一处覆盖所有字段），不按字段打补丁。
             证据照规矩暴露出来（不做静默兜底）： */
          console.warn('[settings] 写后端失败 → 本地改动已保留、暂停回读后端（避免覆盖你的设置）：', patch, e)
          swallowed('设置同步后端失败（本地已改、后端未生效：重启后会回落到旧值）', e)
        })
    }, 400)
  }

  /** ★1012ae：最近一次**向后端写入**的时间戳 —— 防止"定期同步把用户刚改的值拉回旧值"。
   *  实测：「设置里 超时无应答 / 压缩触发阈值 / 命令终端，改完总会自己变成其他的」。
   *  根因：写后端是 400ms 防抖 + 异步，**失败只 swallowed**（后端没落库）；
   *  而 1012y 加的 60s 定期 / 回前台同步会**逐字段用后端值覆盖本地** ⇒ 刚改的值被拉回旧值。 */
  let lastLocalWriteAt = 0
  /** ★1012ag：是否有"已改本地、但还没成功写到后端"的改动 —— 有则**禁止回读后端**
   *  （回读＝用后端旧值覆盖用户刚改的值，这正是"设置改完自己变回去"的元凶）。
   *  这是**全局守卫**：一处生效、覆盖全部设置字段，不按字段打补丁。 */
  let pendingWrite = false

  /** 从后端拉取设置（启动时/后端重启后；后端是权威，AI 改名字后前端能同步到） */
  async function syncFromBackend() {
    // ★1012ae 守卫①：刚写过后端（15s 内，含防抖 + RPC 往返 + 落库）→ **不拉**，
    // 此刻后端可能还没落库/写入失败，拉回来就是旧值，会把用户刚改的覆盖掉。
    if (Date.now() - lastLocalWriteAt < 15000) return
    if (pendingWrite) return   // ★1012ag：本地改动尚未落到后端 → 绝不回读（否则覆盖用户刚改的设置）
    try {
      const chatStore = useChatStore()
      const r = await chatStore.bridgeRpc('settings.get')
      const s = r?.settings
      console.log('[settings] syncFromBackend got:', JSON.stringify(s))
      if (!s || typeof s !== 'object') return
      let changed = false
      if (typeof s.userName === 'string' && s.userName && s.userName !== general.value.userName) { general.value.userName = s.userName; changed = true }
      if (typeof s.nisName === 'string' && s.nisName && s.nisName !== persona.value.nisName) { persona.value.nisName = s.nisName; changed = true }
      if (typeof s.avatar === 'string' && s.avatar && s.avatar !== persona.value.avatar) { persona.value.avatar = s.avatar; changed = true }
      if (typeof s.prompt === 'string' && s.prompt && s.prompt !== persona.value.prompt) { persona.value.prompt = s.prompt; changed = true }
      if (typeof s.storagePath === 'string' && s.storagePath) storagePath.value = s.storagePath
      if (s.cmdShell === 'cmd' || s.cmdShell === 'powershell' || s.cmdShell === 'pwsh' || s.cmdShell === 'auto') general.value.cmdShell = s.cmdShell
      /* ★1012ak：忙时通道（busySendMode）也回读 —— 此前后端白名单没有它、前端这里也没读回，
         两边都缺 ⇒ 改了既不落库也不同步。现后端已补，前端补上读取。 */
      if (s.busySendMode === 'steer' || s.busySendMode === 'queue') general.value.busySendMode = s.busySendMode
      // C3 压缩/存档开关：后端权威回读（未定义=默认开）
      general.value.contextCompaction = s.contextCompaction !== false
      general.value.archiveTranscriptMd = s.archiveTranscriptMd !== false
      // 0910 压缩阈值/留存比例：后端有值才覆盖（缺省沿用本地默认 80/35）
      if (typeof s.contextCompactThresholdPct === 'number') general.value.contextCompactThresholdPct = s.contextCompactThresholdPct
      if (typeof s.contextKeepPct === 'number') general.value.contextKeepPct = s.contextKeepPct
      if (typeof s.historyMaxPerSession === 'number') general.value.historyMaxPerSession = s.historyMaxPerSession
      if (typeof s.historyAutoCleanEnabled === 'boolean') general.value.historyAutoCleanEnabled = s.historyAutoCleanEnabled
      if (typeof s.historyAutoCleanThresholdMb === 'number') general.value.historyAutoCleanThresholdMb = s.historyAutoCleanThresholdMb
      if (typeof s.historyAutoCleanPct === 'number') general.value.historyAutoCleanPct = s.historyAutoCleanPct
      if (typeof s.autoContinueRounds === 'number') general.value.autoContinueRounds = s.autoContinueRounds
      if (typeof s.turnTokenBudget === 'number') general.value.turnTokenBudget = s.turnTokenBudget
      if (typeof s.memberRunLimitMinutes === 'number') general.value.memberRunLimitMinutes = s.memberRunLimitMinutes
      if (typeof s.memberInspector === 'boolean') general.value.memberInspector = s.memberInspector
      if (typeof s.devMode === 'boolean') general.value.devMode = s.devMode
      // ★ 0921z：技能开关回读（后端权威；未定义=沿用默认：主开关开、无停用技能）
      if (typeof s.skillAutoSelect === 'boolean') general.value.skillAutoSelect = s.skillAutoSelect
      if (Array.isArray(s.disabledSkills)) general.value.disabledSkills = s.disabledSkills.map((x: any) => String(x))
      // ★ 0922z：分批加载开关回读（后端权威；未定义=沿用默认：开）
      // ★ 0923：后台任务三项回读（后端权威；未定义=沿用默认：续跑开、3 轮、回访自动唤醒开）
      if (typeof s.bgAutoResume === 'boolean') general.value.bgAutoResume = s.bgAutoResume
      if (typeof s.bgAutoResumeMax === 'number') general.value.bgAutoResumeMax = s.bgAutoResumeMax
      if (typeof s.bgWatchAutoWake === 'boolean') general.value.bgWatchAutoWake = s.bgWatchAutoWake
      if (typeof s.extPresetContext === 'boolean') general.value.extPresetContext = s.extPresetContext
      if (typeof s.fsReadMaxChars === 'number') general.value.fsReadMaxChars = s.fsReadMaxChars
      /* ★1012（老大实测：选「完全展示」→ 新装/导入数据后又变回「折叠工具」）：
         外观这一整块此前**两端都缺** —— 前端 pushToBackend 不发、这里也不回读，它只活在 localStorage
         ⇒ 换安装版/导入数据必丢。现在按**后端扁平口径**回读；未定义就保留本地值，绝不用 undefined 抹掉。 */
      {
        const a: any = appearance.value
        if (typeof s.themeMode === 'string' && s.themeMode) a.themeMode = s.themeMode
        if (typeof s.themeLightStart === 'string') a.themeLightStart = s.themeLightStart
        if (typeof s.themeLightEnd === 'string') a.themeLightEnd = s.themeLightEnd
        if (s.fontSize) a.fontSize = s.fontSize
        if (typeof s.bubbleAvatar === 'boolean') a.bubbleAvatar = s.bubbleAvatar
        if (s.bubbleRadius) a.bubbleRadius = s.bubbleRadius
        if (s.processFoldMode === 'full' || s.processFoldMode === 'tools' || s.processFoldMode === 'all') {
          a.processFoldMode = s.processFoldMode
          /* 旧布尔字段**双写**（只认布尔的老逻辑/老客户端行为也正确）：'full' ⇔ false，其余 ⇔ true */
          a.foldProcessOnDone = s.processFoldMode !== 'full'
        } else if (typeof s.foldProcessOnDone === 'boolean') {
          a.foldProcessOnDone = s.foldProcessOnDone
        }
      }
      // 后端是权威：同步写回 localStorage 缓存，避免刷新后 load() 用旧值覆盖
      /* 0927 netfix A: the old if-changed gate only covered the first 4 fields; the 20+ fields below
         never marked changed => after refresh load() overwrote them with the stale localStorage cache
         (part of the settings-restore bug). Sync is authoritative -> always write back. */
      {
        try {
          /* ★1010d：以已持久化值为底合并——整键覆盖式写入在水合竞态下会抹掉用户值
             （1010c 只是不写 appearance，反而把已持久化的 appearance 整块抹掉=开关自开残余病灶）。
             appearance 跟随已持久化原值；后端权威字段照常刷新。 */
          const _prev = JSON.parse(String(localStore.getItem(STORAGE_KEY) || '{}') || '{}')
          localStore.setItem(STORAGE_KEY, JSON.stringify({
            ..._prev,
            storagePath: storagePath.value,
            shortcuts: shortcuts.value,
            autoMem: autoMem.value,
            notify: notify.value,
            persona: persona.value,
            general: general.value,
            /* ★1012：改成**合并**写 —— appearance.value 现在含刚从后端回读的权威字段（见上），
               只取 _prev 会让"后端权威值"落不进本地缓存（刷新又被旧缓存盖回去）；
               以 _prev 为底则同时保住 1010d 关心的"键别丢、旧值别被水合竞态抹掉"。 */
            appearance: { ...(_prev.appearance || {}), ...appearance.value },
            envStates: envStates.value,
          }))
        } catch (e) { swallowed('设置同步后端失败（内层：本地已改、后端未生效）', e) }
      }
      /* ★1012ah：回读并应用完成后，把**基线对齐到后端值** —— 否则下次写会把"刚从后端取回的值"
         当成"本地改动"又发回去，等于回到"整份覆盖"。 */
      lastSynced = { ...(s as Record<string, any>) }
      syncedOnce = true   // ★1012aj：已与后端对齐 ⇒ 此后才允许写后端
      // ★1012aj：对齐前攒下的改动，现在补发一次（走正常的 diff 通道）
      if (pendingLocalChange) { pendingLocalChange = false; pushToBackend() }
    } catch (e) {
      /* ★1012aj：同步失败也解禁写入 —— 否则后端不可达时用户改的设置会被永久挡住
         （此时写请求本身也到不了后端，无覆盖风险）。 */
      syncedOnce = true
      swallowed('设置同步后端失败（本地已改、后端未生效：重启后会回落到旧值）', e)
    }
  }

  function setStoragePath(p: string) {
    storagePath.value = p
    persist()
  }

  function setShortcut(name: keyof ShortcutMap, value: string) {
    shortcuts.value[name] = value
    persist()
  }

  function setAutoMem(v: boolean) {
    autoMem.value = v
    persist()
  }

  function setNotify(key: keyof NotifySettings, value: string | boolean | number) {
    notify.value[key] = value as never
    persist()
  }

  /** 上传自定义声音：dataURL 按类别保存，并把该类别声音切到自定义 */
  function setCustomSound(category: 'agent' | 'permission' | 'error' | 'memory', dataUrl: string) {
    notify.value.customSounds = { ...notify.value.customSounds, [category]: dataUrl }
    notify.value[`${category}Sound` as keyof NotifySettings] = 'custom' as never
    persist()
  }

  /** 移除某类别的自定义声音，回到默认内置 */
  function clearCustomSound(category: 'agent' | 'permission' | 'error' | 'memory') {
    const cs = { ...notify.value.customSounds }
    delete cs[category]
    notify.value.customSounds = cs
    notify.value[`${category}Sound` as keyof NotifySettings] = DEFAULT_NOTIFY[`${category}Sound` as keyof NotifySettings] as never
    persist()
  }

  function setPersona(key: keyof PersonaSettings, value: string) {
    persona.value[key] = value
    persist()
  }

  function setGeneral(key: keyof GeneralSettings, value: string | boolean | number) {
    general.value[key] = value as never
    persist()
  }

  /* ── ★ 0921z：技能开关（技能仓库 SkillsModal 专用入口）──
   * 主开关 + 单技能启停；后端判定读的也是这两个字段（settings.update 白名单已含），
   * 所以这里 persist() 一发，AI 侧的技能清单/use_skill 立即跟着变。 */
  function setSkillAutoSelect(v: boolean) {
    general.value.skillAutoSelect = !!v
    persist()
  }
  function isSkillEnabled(name: string): boolean {
    const off = general.value.disabledSkills
    return !(Array.isArray(off) && off.includes(String(name)))
  }
  function setSkillEnabled(name: string, on: boolean) {
    const n = String(name || '').trim()
    if (!n) return
    const cur = new Set<string>(Array.isArray(general.value.disabledSkills) ? general.value.disabledSkills : [])
    if (on) cur.delete(n); else cur.add(n)
    general.value.disabledSkills = [...cur]
    persist()
  }

  /** 设置环境安装目录 */
  function setEnvDir(dir: string) {
    general.value.envDir = dir
    persist()
  }

  /** 设置单个环境安装状态（演示） */
  /** 0914：命令终端（设置→通用）：AI 命令工具使用的 Shell，选了哪个就只用哪个 */
  function setCmdShell(v: string) {
    if (v === 'cmd' || v === 'powershell' || v === 'pwsh' || v === 'auto') {
      general.value.cmdShell = v
      persist()
    }
  }

  function setEnvState(id: string, state: EnvInstallState) {
    envStates.value = { ...envStates.value, [id]: state }
    persist()
  }

  function setAppearance(key: keyof AppearanceSettings, value: string | boolean | number) {
    appearance.value[key] = value as never
    persist()
  }

  load()
  /* ★0927（实测"重启后端后折叠/外观设置被重置回默认"）：**晚到水合的重载**。
     localStore 是后端 ui-state.json 的内存镜像，靠 main.ts 挂载前的 hydrate() 灌；
     后端刚重启/首启竞态时那次 hydrate 会失败（3s 超时）→ 镜像为空 → 上面的 load()
     什么都没读到 → 整个会话期间全部设置停在默认值（数据没丢，是没读到）。
     App.vue 有 hydrate 重试定时器，但成功后只回调了引导页，没人重载 store。
     这里挂 onHydrated：晚成功的镜像一到，立刻按持久化值重载（load 是幂等合并，安全）。 */
  onHydrated(() => { load() })

  /**
   * NIS 的**显示用头像**：用户设过就用用户的，没设（''）就用默认 logo。
   * 渲染处一律用它，不要再直接读 `persona.avatar`（否则没设头像时会退回首字母占位）。
   */
  const nisAvatar = computed(() => String(persona.value.avatar || '').trim() || DEFAULT_NIS_AVATAR)

  return {
    storagePath, shortcuts, autoMem, notify, persona, general, appearance,
    envStates, nisAvatar,
    setStoragePath, setShortcut, setAutoMem, setNotify, setPersona,
    setCustomSound, clearCustomSound,
    setGeneral, setAppearance,
    setEnvDir, setEnvState, setCmdShell,
    // ★ 0921z：技能开关（技能仓库入口）
    setSkillAutoSelect, setSkillEnabled, isSkillEnabled,
    syncFromBackend,
  }
})
