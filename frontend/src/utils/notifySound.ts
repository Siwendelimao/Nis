import { useSettingsStore } from '@/stores/settings'
import type { NotifyCategory } from './systemNotify'

/**
 * 内置提示音注册表 —— 设置页「提示音」下拉选项与播放共用。
 * file 为 public/sounds 下的静态资源路径（Vite 构建后原样拷贝）。
 *
 * ★1010 提示音换新（Kenney CC0，可商用免署名；来源与对照见 public/sounds/SOURCES.md）：
 *   - 每类 7 个：`id === 类别名` 的是**默认**音（settings.ts 里
 *     agentSound:'agent' 等默认值按 id 直指同名文件，故换掉文件内容即生效，
 *     不必改 settings.ts，老用户本地已存设置也立刻听到新音）；
 *     `<类别>-alt1..6` 是 6 个备选，供设置页下拉挑选。
 *   - 挑选逻辑按「不吵」优先：用 crest（波峰因数，峰值/RMS）高、RMS 低的干净单音，
 *     避开 RMS 冲到 0.25~0.31 的 confirmation_00x / question_00x（虽饱满但糊、易疲劳）。
 *   - ★每条 file 带 `?v=SOUND_VER` 查询串破缓存：**文件名没变而内容换了**，
 *     浏览器/CDN 会按路径命中旧副本，导致"改了却还是旧音"。换素材时把版本号 +1。
 *
 * ★各场景默认音（用户 1010 指定）：
 *   agent=drop_002 / permission=confirmation_001 / error=error_003
 *   memory=pluck_002 / channel=glass_002
 */
interface SoundOption {
  id: string
  label: string
  file: string
  /** 分组标题：设置页按场景分组展示下拉项（未标注的归入 ''，任何类别都可见） */
  group?: string
}

/** 提示音素材版本号——**换任何 wav 内容都要 +1**，否则用户端继续播缓存里的旧音 */
const SOUND_VER = 1010

const V = (name: string) => `/sounds/${name}?v=${SOUND_VER}`

const G_AGENT = 'AI 回复'
const G_PERM = '权限请求'
const G_ERROR = '错误'
const G_MEM = '自动记忆'
const G_CHAN = '机器人回复'

export const BUILTIN_SOUNDS: SoundOption[] = [
  // ── AI 回复完成（agent）默认 drop_002
  { id: 'agent', label: '默认', file: V('agent.wav'), group: G_AGENT },
  { id: 'agent-alt1', label: '静谧单音 · 620ms', file: V('agent-alt1.wav'), group: G_AGENT },
  { id: 'agent-alt2', label: '清脆中性 · 385ms', file: V('agent-alt2.wav'), group: G_AGENT },
  { id: 'agent-alt3', label: '极干净低音量 · 315ms', file: V('agent-alt3.wav'), group: G_AGENT },
  { id: 'agent-alt4', label: '拨弦 · 181ms', file: V('agent-alt4.wav'), group: G_AGENT },
  { id: 'agent-alt5', label: '极干净更低 · 341ms', file: V('agent-alt5.wav'), group: G_AGENT },
  { id: 'agent-alt6', label: '沉稳落点 · 295ms', file: V('agent-alt6.wav'), group: G_AGENT },

  // ── 权限请求（permission）默认 confirmation_001
  { id: 'permission', label: '默认', file: V('permission.wav'), group: G_PERM },
  { id: 'permission-alt1', label: '提问感 · 501ms', file: V('permission-alt1.wav'), group: G_PERM },
  { id: 'permission-alt2', label: '轻快不吓人 · 385ms', file: V('permission-alt2.wav'), group: G_PERM },
  { id: 'permission-alt3', label: '极干净 · 315ms', file: V('permission-alt3.wav'), group: G_PERM },
  { id: 'permission-alt4', label: '温和中性 · 385ms', file: V('permission-alt4.wav'), group: G_PERM },
  { id: 'permission-alt5', label: '上扬有期待 · 316ms', file: V('permission-alt5.wav'), group: G_PERM },
  { id: 'permission-alt6', label: '极轻提示 · 62ms', file: V('permission-alt6.wav'), group: G_PERM },

  // ── 错误（error）默认 error_003
  { id: 'error', label: '默认', file: V('error.wav'), group: G_ERROR },
  { id: 'error-alt1', label: '短促最不吵 · 139ms', file: V('error-alt1.wav'), group: G_ERROR },
  { id: 'error-alt2', label: '中性错误 · 173ms', file: V('error-alt2.wav'), group: G_ERROR },
  { id: 'error-alt3', label: '极短高频触发 · 104ms', file: V('error-alt3.wav'), group: G_ERROR },
  { id: 'error-alt4', label: '中长警示 · 518ms', file: V('error-alt4.wav'), group: G_ERROR },
  { id: 'error-alt5', label: '短促锐利 · 165ms', file: V('error-alt5.wav'), group: G_ERROR },
  { id: 'error-alt6', label: '双击警示 · 60ms', file: V('error-alt6.wav'), group: G_ERROR },

  // ── 自动记忆（memory）默认 pluck_002
  { id: 'memory', label: '默认', file: V('memory.wav'), group: G_MEM },
  { id: 'memory-alt1', label: '短拨弦 · 112ms', file: V('memory-alt1.wav'), group: G_MEM },
  { id: 'memory-alt2', label: '落点感 · 132ms', file: V('memory-alt2.wav'), group: G_MEM },
  { id: 'memory-alt3', label: '极轻提示 · 62ms', file: V('memory-alt3.wav'), group: G_MEM },
  { id: 'memory-alt4', label: '玻璃通透 · 132ms', file: V('memory-alt4.wav'), group: G_MEM },
  { id: 'memory-alt5', label: '静谧单音 · 512ms', file: V('memory-alt5.wav'), group: G_MEM },
  { id: 'memory-alt6', label: '极干净 · 344ms', file: V('memory-alt6.wav'), group: G_MEM },

  // ── 机器人回复（channel）默认 glass_002
  { id: 'channel', label: '默认', file: V('channel.wav'), group: G_CHAN },
  { id: 'channel-alt1', label: '玻璃略亮 · 132ms', file: V('channel-alt1.wav'), group: G_CHAN },
  { id: 'channel-alt2', label: '落点感 · 295ms', file: V('channel-alt2.wav'), group: G_CHAN },
  { id: 'channel-alt3', label: '极轻提示 · 62ms', file: V('channel-alt3.wav'), group: G_CHAN },
  { id: 'channel-alt4', label: '玻璃饱满 · 292ms', file: V('channel-alt4.wav'), group: G_CHAN },
  { id: 'channel-alt5', label: '清脆中性 · 385ms', file: V('channel-alt5.wav'), group: G_CHAN },
  { id: 'channel-alt6', label: '玻璃清亮 · 132ms', file: V('channel-alt6.wav'), group: G_CHAN },

  // ── 系统提示音（Windows 官方通知音，随包一份拷贝）与演示和弦。
  //    ★保留是为向后兼容：老用户本地可能已选中这两个 id，
  //    一旦从注册表移除，builtinSound() 返回 undefined → categorySoundSrc() 返回 null
  //    → 该类别**直接静音**。要下线请先做设置值迁移，别直接删。
  { id: 'system', label: 'Windows 系统提示音', file: V('system.wav') },
  { id: 'demo', label: '演示和弦', file: V('demo.wav') },
]

export const CUSTOM_SOUND_ID = 'custom'

function builtinSound(id: string): SoundOption | undefined {
  return BUILTIN_SOUNDS.find(s => s.id === id)
}



/**
 * 某类别的当前声音来源：
 *   - 内置 id → public 音频 URL
 *   - CUSTOM_SOUND_ID → 用户上传的 dataURL（settings.notify.customSounds）
 */
function categorySoundSrc(category: NotifyCategory): string | null {
  const settings = useSettingsStore()
  const key = `${category}Sound` as const
  const id = settings.notify[key]
  if (id === CUSTOM_SOUND_ID) {
    return settings.notify.customSounds?.[category] || null
  }
  const opt = builtinSound(id)
  return opt ? opt.file : null
}

/** 试听某个声音（直接播放，不受任何开关门控） */
export function previewSound(id: string | null): void {
  if (!id) return
  let src: string | null = null
  if (id === CUSTOM_SOUND_ID) {
    const settings = useSettingsStore()
    // 试听自定义声音：优先当前选中类别的自定义，其次任一已上传的自定义
    src = settings.notify.customSounds?.agent
      || settings.notify.customSounds?.permission
      || settings.notify.customSounds?.error
      || settings.notify.customSounds?.memory
      || settings.notify.customSounds?.channel
      || null
  } else {
    src = builtinSound(id)?.file || null
  }
  if (src) playAudio(src)
}

/**
 * 播放某类别事件对应的提示音（受设置「系统提示」对应类别开关门控）。
 * 返回是否真正播放（门控关闭 / 无声音源 / 被浏览器拦截时返回 false）。
 */
export function playNotifySound(category: NotifyCategory): boolean {
  const settings = useSettingsStore()
  const gate = settings.notify[category]
  if (!gate) return false
  const src = categorySoundSrc(category)
  if (!src) return false
  playAudio(src)
  return true
}

function playAudio(src: string): void {
  try {
    // 0914c：音量走设置（设置→提示 滑杆；默认 0.8），试听与实播同口径
    const v = Number(useSettingsStore().notify.volume)
    const audio = new Audio(src)
    audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8
    audio.play().catch(() => {
      /* 浏览器自动播放策略拦截（需用户交互后）→ 静默 */
    })
  } catch {
    /* ignore */
  }
}
