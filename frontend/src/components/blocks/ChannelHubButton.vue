<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'
import { useChannelsStore } from '@/stores/channels'
import ChannelHubModal from '../ChannelHubModal.vue'

/**
 * 接入入口按钮 —— 0912 接入批加入；**0920 与通知中心互换位置**：现挂在**侧边栏底部**（设置齿轮左侧）。
 *
 * 图标轮播（0913）：QQ / 微信 / 链接 三个图标每 2.6s 渐隐切换，一眼说明「这里能接 QQ / 微信 / 远程」。
 *
 * ★ 0920 改色（反馈「接入按钮的颜色和其他两个不一致」）：
 *   旁边两个按钮（设置 / 便签）都是**线性灰图标**，接入却总是彩色/实心，凑在一起就显脏。
 *   现在的规矩：
 *     · **已连接** → 显示该通道的**品牌色**（QQ 蓝 / 微信绿 / 远程橙）——颜色代表"真的通了"，有信息量；
 *     · **未连接** → 一律灰（跟设置/便签同色），不再靠彩色吸引视线；
 *   图标字号 17→16px：品牌字形是实心的，同字号看着比线性图标大一圈。
 */
const emit = defineEmits<{ openSession: [sessionId: string] }>()
const store = useChannelsStore()
const open = ref(false)

/** 品牌色（只给"已连接"用） */
const BRAND_COLOR: Record<string, string> = {
  qq: '#12b7f5',
  wechat: '#07c160',
  remote: '#f97316',
}

const qqOn = ref(false)
const wxOn = ref(false)
const remoteOn = ref(false)

/** 通道在线状态：QQ/微信走后端 `channel.status`（真连接状态），远程看配置开关 */
async function refresh() {
  const st = await store.loadStatus()
  qqOn.value = Object.values(st.qq || {}).some(v => !!(v as any)?.connected)
  wxOn.value = Object.values(st.wechat || {}).some(v => !!(v as any)?.connected)
  remoteOn.value = !!store.cfg('remote').enabled
}

/**
 * 轮播项：三个通道都留着（保留"这里能接什么"的发现性），
 * 只是**连上的**带品牌色、没连的走灰。
 */
const items = computed(() => [
  { key: 'qq', cls: 'fab fa-qq', color: qqOn.value ? BRAND_COLOR.qq : '' },
  { key: 'wechat', cls: 'fab fa-weixin', color: wxOn.value ? BRAND_COLOR.wechat : '' },
  { key: 'remote', cls: 'fas fa-link', color: remoteOn.value ? BRAND_COLOR.remote : '' },
])

const ICON_INTERVAL_MS = 2600
const iconIdx = ref(0)
let iconTimer: ReturnType<typeof setInterval> | undefined
let statusTimer: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  // 配置先拉一次（远程开关在配置里）；在线状态随后/定期刷
  await store.loadConfigs()
  await refresh()
  iconTimer = setInterval(() => {
    iconIdx.value = (iconIdx.value + 1) % items.value.length
  }, ICON_INTERVAL_MS)
  // 20s 一次：channel.status 是纯内存查询，开销小（别去碰 remote.info —— 它每次都要重算二维码）
  statusTimer = setInterval(() => { void refresh() }, 20000)
})
onUnmounted(() => {
  if (iconTimer) clearInterval(iconTimer)
  if (statusTimer) clearInterval(statusTimer)
})

/** 弹窗关掉后立刻刷一次（用户刚在里面连/断，别等 20s） */
async function onModalClose() {
  open.value = false
  await refresh()
}

const current = computed(() => items.value[iconIdx.value % items.value.length])
</script>

<template>
  <button
    type="button"
    class="ch-hub-btn"
    :title="t('channel.title')"
    :aria-label="t('channel.title')"
    @click="open = true"
  >
    <!-- mode="out-in"：旧图标先淡出、新图标再淡入（不会两个叠在一起闪） -->
    <Transition name="hub-icon" mode="out-in">
      <i
        :key="current.key"
        :class="[current.cls, 'ch-hub-glyph', current.color ? 'is-on' : '']"
        :style="current.color ? { color: current.color } : undefined"
        aria-hidden="true"
      ></i>
    </Transition>
  </button>

  <ChannelHubModal
    :open="open"
    @close="onModalClose"
    @open-session="emit('openSession', $event)"
  />
</template>

<style scoped>
.ch-hub-btn {
  /* 0920：从标题栏右上角换到**侧边栏底部**（与通知中心互换位置）——尺寸对齐旁边的设置齿轮（w-9 h-9 = 36px） */
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 0.15s ease, color 0.15s ease;
}
.ch-hub-btn:hover { background: rgba(0, 0, 0, 0.07); color: #374151; }
/* 16px：品牌字形是实心的，同字号看着比旁边的线性图标大一圈 */
.ch-hub-glyph { font-size: 16px; line-height: 1; }
/* 已连接的品牌色走行内 style（优先级高于样式表），hover 的灰不会盖掉它 —— 颜色是状态信息，不是装饰 */

/* 图标轮播的渐隐切换 */
.hub-icon-enter-active { transition: opacity 0.4s ease, transform 0.4s ease; }
.hub-icon-leave-active { transition: opacity 0.26s ease, transform 0.26s ease; }
.hub-icon-enter-from { opacity: 0; transform: scale(0.7); }
.hub-icon-leave-to { opacity: 0; transform: scale(0.7); }
</style>

<style>
html.dark .ch-hub-btn { color: #6f6f78; }
html.dark .ch-hub-btn:hover { background: rgba(255, 255, 255, 0.1); color: #e9e9ef; }
/* 深色下已连接的品牌色同样走行内 style，不受上面两条影响 */
</style>
