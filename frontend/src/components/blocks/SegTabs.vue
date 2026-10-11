<script setup lang="ts">
/**
 * SegTabs —— 分段切换（0903 统一套件）：灰底胶囊轨道 + 黑胶囊滑块，
 * 滑块用左侧栏 glass-radio 同款弹性缓动（0.35s cubic-bezier 回弹）。
 * options: { id, label, icon? }；等宽分段（水平）/等高分段（垂直）。
 * 用法：<SegTabs v-model="activeTab" :options="[{ id: 'a', label: 'A' }]" />
 */
import { computed, ref, watch, nextTick, onMounted } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string
  options: Array<{ id: string; label: string; icon?: string }>
  /** 垂直布局（设置页左导航这类纵向列表） */
  vertical?: boolean
  /** plain：无轨道底色（设置页左导航贴白底用，只留黑胶囊滑块） */
  size?: 'xs' | 'xs2' | 'sm' | 'md'
  plain?: boolean
}>(), { vertical: false, size: 'sm', plain: false })

const emit = defineEmits<{ 'update:modelValue': [id: string] }>()

const index = computed(() => Math.max(0, props.options.findIndex(o => o.id === props.modelValue)))

/* 垂直 plain 模式：thumb 用选中项实测几何定位（CSS calc 无法计入 flex gap，会逐行累积错位）。
   其余模式沿用 CSS transform 动画。 */
const plainVThumbRef = ref<HTMLElement | null>(null)
const itemRefs = ref<HTMLElement[]>([])
const plainVThumbStyle = ref<Record<string, string>>({ opacity: '0' })

function measurePlainVThumb() {
  const el = itemRefs.value[index.value]
  if (!el) { plainVThumbStyle.value = { opacity: '0' }; return }
  plainVThumbStyle.value = {
    top: el.offsetTop + 'px',
    height: el.offsetHeight + 'px',
    left: el.offsetLeft + 'px',
    width: el.offsetWidth + 'px',
  }
}
watch(() => [props.modelValue, props.options.length], () => nextTick(measurePlainVThumb))
onMounted(() => nextTick(measurePlainVThumb))
</script>

<template>
  <div class="seg" :class="[vertical ? 'seg-v' : 'seg-h', 'seg-' + size, { 'seg-plain': plain, 'seg-plain-v': plain && vertical }]" :style="{ '--seg-n': options.length }">
    <!-- 垂直 plain：thumb 由 JS 按选中项实测几何定位（含 gap 的行距纯 CSS 算不精确，0904⑤ 选中态上下留白漂移根因） -->
    <div
      v-if="!(plain && vertical)"
      class="seg-thumb"
      :style="vertical ? { transform: `translateY(${index * 100}%)` } : { transform: `translateX(${index * 100}%)` }"
    ></div>
    <div v-else ref="plainVThumbRef" class="seg-thumb seg-thumb-measured" :style="plainVThumbStyle"></div>
    <button
      v-for="(o, i) in options"
      :key="o.id"
      ref="itemRefs"
      type="button"
      class="seg-item"
      :class="{ 'seg-item-active': o.id === modelValue }"
      @click="emit('update:modelValue', o.id)"
    >
      <i v-if="o.icon" :class="[o.icon, 'seg-icon']"></i>
      <span class="truncate">{{ o.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.seg {
  position: relative;
  display: flex;
  background: #f3f4f6; /* gray-100 轨道 */
  border-radius: 9999px;
  padding: 3px;
}
/* plain：去掉轨道灰底（贴白底的垂直导航用），只留黑胶囊滑块 */
.seg-plain { background: transparent; padding: 0; }
.seg-plain .seg-h, .seg-plain.seg-v { gap: 2px; }
.seg-plain.seg-h .seg-thumb { top: 0; bottom: 0; left: 0; width: calc(100% / var(--seg-n)); height: auto; }
.seg-h { flex-direction: row; }
.seg-v { flex-direction: column; }
.seg-thumb {
  position: absolute;
  background: #111827;
  border-radius: 9999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  /* 左侧栏 glass-glider 同款弹性缓动：滑到哪都带一点回弹 */
  transition: transform 0.35s cubic-bezier(0.37, 1.95, 0.66, 0.56);
  z-index: 1;
}
.seg-h .seg-thumb { top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / var(--seg-n)); }
.seg-v .seg-thumb { left: 3px; right: 3px; top: 3px; height: calc((100% - 6px) / var(--seg-n)); }
/* 垂直 plain 测量式 thumb：top/height 由 JS 按选中项几何写入，滑动动画同步改过渡属性 */
.seg-thumb-measured {
  left: 0; right: 0; top: 0; height: 0;
  transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
}
/* plain 模式：thumb 铺满每个 item 位（无 3px 轨道内边距） */
.seg-plain .seg-item { border-radius: 9999px; }
.seg-item {
  position: relative;
  z-index: 2;
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #6b7280;
  font-weight: 400;
  white-space: nowrap;
  /* 左右对称：text-align center + 等宽 padding，修选中项左右不等距观感 */
  padding: 6px 16px;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  border-radius: 9999px;
  transition: color 0.25s ease;
}
/* 垂直导航（0904 反馈⑤）：内容左对齐、左右 12px 紧收（修"按钮松散"），
   上下 padding 水平不变→每行胶囊上下留白一致 */
.seg-v .seg-item { justify-content: flex-start; text-align: left; padding-left: 12px; padding-right: 12px; }
.seg-v.seg-md .seg-item { padding-top: 8px; padding-bottom: 8px; }
.seg-v.seg-sm .seg-item { padding-top: 6px; padding-bottom: 6px; }
.seg-v.seg-xs .seg-item { padding-top: 4px; padding-bottom: 4px; }
.seg-v.seg-xs2 .seg-item { padding-top: 5px; padding-bottom: 5px; }
.seg-item:hover { color: #111827; }
.seg-item-active,
.seg-item-active:hover { color: #ffffff; }
.seg-md .seg-item { padding: 8px 18px; font-size: 13px; line-height: 20px; }
.seg-sm .seg-item { padding: 6px 16px; font-size: 12px; line-height: 18px; }
.seg-xs .seg-item { padding: 4px 12px; font-size: 11px; line-height: 16px; }
/* 1010（反馈：Agent 预设 / 侧栏聊天·项目 两处分段太高）：在 xs 与 sm 之间加一档，
   轨道约 33px（xs=30 / sm=36），横向留白同 sm —— 既不挤也不松，仍好点按。 */
.seg-xs2 .seg-item { padding: 5px 15px; font-size: 12px; line-height: 17px; }
.seg-icon { font-size: 12px; width: 16px; text-align: center; }
</style>
