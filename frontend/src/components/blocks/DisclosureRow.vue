<script setup lang="ts">
/**
 * DisclosureRow —— dsh ui-primitives/DisclosureRow 的 Vue 移植
 * 统一 24px 折叠行 chrome：leading(16px) + title(14/24) + collapsed 内容
 *
 * previewChevron（默认开）：未展开时 leading 显示「图标 + chevron 双元素」，
 * 悬停行时图标淡出、chevron 淡入（dsh 的悬停切换交互）。
 * state='running' 时标题/图标扫光（background-clip:text 光只落在字形上，深浅色通用）。
 */
import { computed, ref, watch, nextTick } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  open: boolean
  expandable?: boolean
  expandOnRowClick?: boolean
  previewChevron?: boolean
  keepContentWhenOpen?: boolean
  state?: 'ok' | 'running' | 'error' | 'pending'
  rowClass?: string
  /** 对话过程块用（0903）：行出现淡入 + 展开/折叠高度动画（标题 chevron 旋转）。
   *  默认关——设置页等其它 DisclosureRow 消费点行为零变化 */
  animate?: boolean
}>(), {
  expandable: true,
  expandOnRowClick: true,
  previewChevron: undefined,
  keepContentWhenOpen: false,
  state: 'ok',  rowClass: '',
  animate: false,
})

const emit = defineEmits<{ (e: 'toggle'): void }>()

const showChevron = computed(() => props.previewChevron ?? props.expandable)
const rowExpands = computed(() => props.expandable && props.expandOnRowClick)

/* 展开/折叠高度动画（grid-rows 0fr↔1fr）：
   展开体 v-show 常驻后首帧是 0fr（is-open 未挂上），下一帧再置 1fr 才能过渡出动画；
   折叠后不卸载（overflow:hidden 已收起），再展开走常规 class 切换。 */
const contentMounted = ref(props.open)
const openAnim = ref(props.open)
watch(() => props.open, async (v) => {
  if (v) {
    if (props.animate && !contentMounted.value) {
      contentMounted.value = true
      await nextTick()
      requestAnimationFrame(() => requestAnimationFrame(() => { openAnim.value = true }))
    } else {
      contentMounted.value = true
      openAnim.value = true
    }
  } else if (props.animate) {
    openAnim.value = false
  } else {
    contentMounted.value = false
  }
})

function onToggle() {
  if (props.expandable) emit('toggle')
}
</script>

<template>
  <div class="disclosure-root" :class="{ 'disclosure-animate': animate }" :data-open="open || undefined" :data-state="animate ? state : undefined">
    <div
      class="disclosure-row"
      :class="rowClass"
      :data-expandable="rowExpands || undefined"
      :data-state="state"
      role="button"
      :tabindex="rowExpands ? 0 : undefined"
      :aria-expanded="rowExpands ? open : undefined"
      @click="rowExpands ? onToggle() : undefined"
      @keydown.enter.prevent="rowExpands ? onToggle() : undefined"
      @keydown.space.prevent="rowExpands ? onToggle() : undefined"
    >
      <span class="disclosure-leading">
        <template v-if="open">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z" fill="currentColor"/>
          </svg>
        </template>
        <template v-else-if="showChevron">
          <span class="icon-idle"><slot name="icon"></slot></span>
          <svg class="chevron-icon chevron-hover" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z" fill="currentColor"/>
          </svg>
        </template>
        <span v-else class="icon-idle"><slot name="icon"></slot></span>
      </span>
      <span class="disclosure-title" :class="{ 'title-error': state === 'error' }"><slot name="title">{{ title }}</slot></span>
      <!-- collapsed 摘要包进扫光容器（运行中高光同样掠过摘要文字；display:contents 不破坏行布局） -->
      <span v-if="keepContentWhenOpen || !open" class="disclosure-collapsed-sweep"><slot name="collapsed"></slot></span>
    </div>
    <!-- animate：折叠体常驻 + grid-rows 高度动画（首开双 rAF 触发过渡）；
         非 animate 消费点（设置页等）：保持原 v-if 挂载/卸载语义零变化 -->
    <div v-if="animate" class="disclosure-content" :class="{ 'is-open': openAnim }" v-show="contentMounted">
      <div class="disclosure-content-inner">
        <slot />
      </div>
    </div>
    <template v-else>
      <slot v-if="open" />
    </template>
  </div>
</template>

<style scoped>
/* dsh DisclosureRow.module.css 移植 */
.disclosure-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}
/* animate（对话过程块）：出现=淡入+轻位移（仅组件挂载播一次）；
   running→ok/error 状态色做过渡（消掉 icon/标题/摘要的硬切闪变） */
.disclosure-root.disclosure-animate {
  /* ★ 0922z2d4：去掉 `both` —— 原来动画跑完后元素仍长期处于"动画生效"状态（长会话里 517 个块），
     实测禁动画可省 ~28% 主线程；去掉 fill 后视觉终态不变（from=透明/下移，to=自然态），动画照旧播一次。 */
  animation: dsh-disclosure-in 0.3s ease-out;
  transition: color 0.4s ease;
}
@keyframes dsh-disclosure-in {
  from { opacity: 0; translate: 0 4px; }
  to { opacity: 1; translate: 0 0; }
}
/* 折叠体高度动画（grid 0fr↔1fr 通用技巧，内容高度未知也能平滑过渡） */
.disclosure-content {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.28s ease;
}
.disclosure-content.is-open {
  grid-template-rows: 1fr;
}
.disclosure-content-inner {
  overflow: hidden;
  min-height: 0;
}
.disclosure-row {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  height: 24px;
  min-width: 0;
}
.disclosure-row[data-expandable] {
  cursor: pointer;
}
.disclosure-leading {
  position: relative;
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-label-tertiary);
}
.icon-idle {
  display: inline-flex;
  opacity: 1;
  transition: opacity 100ms ease;
}
/* 过程块状态色过渡：running 灰 → done 绿/红 不硬切 */
.disclosure-leading,
.disclosure-title {
  transition: color 0.4s ease;
}
/* chevron 始终绝对定位于 16px leading 容器中央（不参与布局，展开/悬停不跳动）。
   折叠态指向右侧（-90°），展开旋转到位朝下——animate 模式带 0.24s 旋转过渡 */
.chevron-icon {
  position: absolute;
  inset: 0;
  margin: auto;
  transform: rotate(-90deg);
}
.disclosure-animate .chevron-icon {
  transition: opacity 100ms ease, transform 0.24s ease;
}
.disclosure-animate[data-open] .chevron-icon {
  transform: rotate(0deg);
}
.chevron-hover {
  opacity: 0;
  transition: opacity 100ms ease;
}
.disclosure-row:hover .icon-idle {
  opacity: 0;
}
.disclosure-row:hover .chevron-hover {
  opacity: 1;
}
.disclosure-title {
  /* 0907 图四修复：flex:none → 可收缩+省略。窄视口长工具名（"MCP nis-browser/wb_xxx"）
     原会把整行推出屏外无省略号；PC 宽行不触发收缩，行为零变化 */
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 13px/300：过程块家族（标题/摘要/状态/思考）统一细字重（0903 用户拍板试看；消费点仅思考/工具两块） */
  font-size: 13px;
  font-weight: 300;
  line-height: 22px;
  color: var(--dsw-alias-label-secondary);
}
/* collapsed 摘要容器：占满标题右侧剩余空间并截断（flex-basis 0=摘要再长也吃不到标题的份额，
   "Think"不再被挤成省略号；窄容器时标题按既有规则自行省略，0907 图四行为保留）。
   同时作为 running 扫光挂点（background-clip:text 光只落摘要字形上） */
.disclosure-collapsed-sweep {
  display: inline-flex;
  align-items: baseline;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
/* 子项（摘要/状态文本）参与收缩才有省略号，不被 clip */
.disclosure-collapsed-sweep > * {
  min-width: 0;
}
/* 工具/过程失败：标题与摘要同色（错误语义覆盖整行，不只正文） */
.disclosure-title.title-error {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
/* 运行中扫光：只从 icon 和文字上掠过（深/浅色通用）。
   旧实现是整行 ::after 光带 + 色取 color-mix(bg-base 60%)——浅色 bg-base 白→看不见(歪打正着"没问题")、
   深色 bg-base #0a0a0a→扫过一条不透明灰块(图二)。且整行宽度天然盖到文字右侧空白=「扫光条」。
   新实现：① 标题用 background-clip:text 让高光只落在字形像素上（文字以外全透明，绝不成条）；
   ② leading 图标做同步的提亮脉冲（16px 图标上空间扫光几不可见，脉冲更自然）。 */
.disclosure-row[data-state='running'] .disclosure-title {
  background-image: linear-gradient(
    100deg,
    var(--dsw-alias-label-secondary) 0%,
    var(--dsw-alias-label-secondary) 35%,
    #fff 50%,
    var(--dsw-alias-label-secondary) 65%,
    var(--dsw-alias-label-secondary) 100%
  );
  background-size: 250% 100%;
  background-position: 150% 0;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: var(--dsw-alias-label-secondary); /* 兜底：不支持 background-clip:text 时仍显灰字 */
  animation: dsh-disclosure-text-sweep 2.4s ease-in-out infinite;
}
/* 0908 二批条2：扫光扩到 collapsed 摘要（Think 后面的思考过程/工具等待行）。
   光从 icon+标题出发后 0.9s 掠过摘要（每段相对自身盒子动画，错峰衔接=一条光带整行流过的观感）。
   基色用 label-tertiary（各消费点摘要/collapsed 文字本就是此色，不写 inherit——渐变里非法） */
.disclosure-row[data-state='running'] .disclosure-collapsed-sweep {
  background-image: linear-gradient(
    100deg,
    var(--dsw-alias-label-tertiary) 0%,
    var(--dsw-alias-label-tertiary) 35%,
    #fff 50%,
    var(--dsw-alias-label-tertiary) 65%,
    var(--dsw-alias-label-tertiary) 100%
  );
  background-size: 250% 100%;
  background-position: 150% 0;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: dsh-disclosure-text-sweep 2.4s ease-in-out 0.9s infinite;
}
@keyframes dsh-disclosure-text-sweep {
  0% { background-position: 150% 0; }
  100% { background-position: -60% 0; }
}
.disclosure-row[data-state='running'] .disclosure-leading {
  animation: dsh-disclosure-icon-pulse 2.4s ease-in-out infinite;
}
@keyframes dsh-disclosure-icon-pulse {
  0%, 55%, 100% { filter: brightness(1); }
  25% { filter: brightness(1.9); }
}
@media (prefers-reduced-motion: reduce) {
  .disclosure-row[data-state='running'] .disclosure-title,
  .disclosure-row[data-state='running'] .disclosure-leading,
  .disclosure-row[data-state='running'] .disclosure-collapsed-sweep {
    animation: none;
  }
  .disclosure-row[data-state='running'] .disclosure-title,
  .disclosure-row[data-state='running'] .disclosure-collapsed-sweep {
    background-position: 50% 0;
  }
}
</style>
