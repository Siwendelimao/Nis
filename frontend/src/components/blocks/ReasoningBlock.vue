<script setup lang="ts">
/**
 * ReasoningBlock —— dsh ReasoningRow 的 Vue 移植
 * Think 折叠行：DisclosureRow + Think 图标 + 摘要（运行中显示最新行，完成后显示首行）
 * 流式期间自动展开 + 行内扫光动画
 */
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import DisclosureRow from './DisclosureRow.vue'
import PurpleRibbon from './PurpleRibbon.vue'
import { t } from '@/utils/i18n'

const props = defineProps<{
  content: string
  streaming?: boolean
  /** 0906 五批：thinking 静默起始时刻（piChat.thinkIdleUntil，0=无静默）；右侧显示"还在进行 · Ns" */
  idleUntil?: number
  /** ★ 0923：父级带下来的**已记录思考耗时**（毫秒）——刷新/回看历史时本行不是"从流式开始"
   *  渲染的，内部计时器拿不到起点，就用它兜底显示「我想到了 Ns」。
   *  （0924 恢复：这条实现曾被一次回退误删，导致刷新/回看历史的思考行没有计时。） */
  elapsedMs?: number
  /** ★ 0925j（实测"刷新页面思考计时会刷新"）：思考真实开始时刻（节点消息时间戳）——
   *  组件重建（刷新/切会话/HMR）后计时从这里续算，不再从挂载时刻归零重来。 */
  startTime?: number
}>()

/* ★★ 0924（截图：完成态的 Think 行右侧空白、计时整条消失）——
   修：思考结束时把**实测耗时**上报父级（父级写进节点），父级再通过 elapsedMs 传回来。
   背景：elapsedMs 这条链原来**全项目无人传值**（死链）⇒ 只要本行不是"从流式那一刻开始渲染"的
   （刷新 / 回看 / 切会话回来 / 组件被重建），两个显示分支都不成立 → 计时空空如也。
   而 deepseek 系网关常把 thinking 缓冲成一次性下发，本行几乎永远是这种"非流式"渲染。 */
const emit = defineEmits<{ (e: 'elapsed', ms: number): void }>()

// 静默计时：idleUntil 生效后每秒 +1（不放假想动，秒数本身就是"还活着"的诚实信号；
// thinking 恢复/进入工具阶段后 piChat 清零 idleUntil，本行自动隐藏）
const idleNow = ref(Date.now())
let idleTicker: ReturnType<typeof setInterval> | null = null
const idleSec = computed(() => {
  const u = props.idleUntil || 0
  if (!u || !props.streaming) return 0
  return Math.max(0, Math.floor((idleNow.value - u) / 1000))
})
/* ★ 0921（反馈："think 这里没有显示时间，感觉时间是随机触发一样"）：
   上面那个 `idleSec` 是**静默计时**（`idleSec >= 5` 才出现，语义是"上游卡住了"），
   所以看起来"时有时无"。这里补一个**思考耗时**计时：本行从开始思考一直走到结束，
   稳定常驻在行尾右侧（设计口径："计时靠右"）。 */
const thinkStart = ref(0)
const thinkEnd = ref(0)
const tickNow = ref(Date.now())
let thinkTicker: ReturnType<typeof setInterval> | null = null
const thinkSec = computed(() => {
  if (!thinkStart.value) {
    /* ★ 0923（0924 恢复）：本行不是"从流式开始"渲染的（刷新 / 回看历史）→ 用父级带下来的已记录耗时兜底 */
    const ms = Number(props.elapsedMs) || 0
    return ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0
  }
  const end = thinkEnd.value || tickNow.value
  return Math.max(0, Math.round((end - thinkStart.value) / 1000))
})
watch(() => props.streaming, (s) => {
  if (s) {
    if (!thinkStart.value) thinkStart.value = props.startTime || Date.now()
    thinkEnd.value = 0
    tickNow.value = Date.now()
    if (!thinkTicker) thinkTicker = setInterval(() => { tickNow.value = Date.now() }, 500)
  } else {
    if (thinkStart.value && !thinkEnd.value) thinkEnd.value = Date.now()
    /* ★★ 0924（截图：完成态的 Think 行右侧空白、计时整条消失）——
       思考**结束**时把实测耗时上报父级（父级写进节点 n.reasoningMs），再由 elapsedMs 传回来。
       这条链是"非流式渲染"场景的唯一计时来源：刷新 / 回看 / 切会话回来 / 组件被重建
       （deepseek 系网关常把 thinking 缓冲成一次性下发，本行几乎永远是这种渲染路径）。 */
    if (thinkStart.value && thinkEnd.value) emit('elapsed', thinkEnd.value - thinkStart.value)
    if (thinkTicker) { clearInterval(thinkTicker); thinkTicker = null }
  }
}, { immediate: true })
onUnmounted(() => { if (thinkTicker) { clearInterval(thinkTicker); thinkTicker = null } })
watch(() => [props.streaming, props.idleUntil] as const, ([s, u]) => {
  const need = !!(s && (u || 0))
  if (need && !idleTicker) {
    idleNow.value = Date.now()
    idleTicker = setInterval(() => { idleNow.value = Date.now() }, 1000)
  } else if (!need && idleTicker) {
    clearInterval(idleTicker); idleTicker = null
  }
}, { immediate: true })
onUnmounted(() => { if (idleTicker) { clearInterval(idleTicker); idleTicker = null } })

const open = ref(false)
const bodyRef = ref<HTMLElement | null>(null)

// 流式期间自动展开（实时可见思考过程），结束后可手动折叠
watch(() => props.streaming, (v) => {
  if (v) open.value = true
})

// 内容更新时滚动到底部：展开后默认显示最新的，旧内容往上顶
watch(() => props.content, () => {
  nextTick(() => {
    if (open.value && bodyRef.value) {
      bodyRef.value.scrollTop = bodyRef.value.scrollHeight
    }
  })
})

// dsh：running 时折叠行摘要跟随最新一行（follow-end），完成后固定首行
/* ★ 0923（反馈：摘要有时候长得盖住右边的"我想到了 Ns"计时；0924 恢复）：
   折叠行只有一行高，而摘要取自思考正文的**整行**、长度完全不可控（一行可能几百字）。
   这里先做**字符级硬截断**（60 字），再由 CSS 的 ellipsis + 右侧渐隐收尾 —— 双保险后计时必有位置。 */
const SUMMARY_MAX_CHARS = 60
const summary = computed(() => {
  const text = props.content || ''
  let s = ''
  if (props.streaming) {
    const visible = text.trimEnd()
    const nl = visible.lastIndexOf('\n')
    s = nl === -1 ? visible : visible.slice(nl + 1)
  } else {
    const nl = text.indexOf('\n')
    s = nl === -1 ? text : text.slice(0, nl)
  }
  s = s.trim()
  /* ★ 0923（截图：Think 行摘要位空白，而节点确实有思考内容）：
     不少网关的思考增量**先吐纯空白/换行**（"\n\n" 之类）→ 上面按行取片段时正好取到空白，
     trim 成空 ⇒ 折叠行只剩「Think .」。这里兜底：整段压成单行取前 60 字，
     仍为空才真的显示空。 */
  if (!s) s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > SUMMARY_MAX_CHARS ? s.slice(0, SUMMARY_MAX_CHARS) + '…' : s
})
</script>

<template>
  <div class="reasoning-row" :data-state="streaming ? 'running' : 'ok'">
    <!-- ★ 0923（反馈：思考中的 Think 行，摘要与右侧计时都消失，只剩思考正文）：
         DisclosureRow 默认"展开时就不渲染折叠行"（keepContentWhenOpen=false），
         而思考中是自动展开的 ⇒ 摘要 +「让我想想 Ns」一起消失。
         这里思考中显式保留折叠行：正文照旧展开，摘要与计时也一直在。 -->
    <DisclosureRow
      title="Think"
      :open="open"
      :state="streaming ? 'running' : 'ok'"
      :animate="true"
      :keep-content-when-open="streaming"
      @toggle="open = !open"
    >
      <template #icon>
        <!-- 思考中：紫色飘带；完成：线性星星 -->
        <PurpleRibbon v-if="streaming" :size="16" />
        <Sparkles v-else :size="14" stroke-width="1.5" :style="{ color: 'var(--dsw-alias-label-tertiary)' }" />
      </template>
      <template #collapsed>
        <span class="reasoning-sep" aria-hidden></span>
        <!-- ★ 0923（反馈"思考中摘要不出现"）：思考内容还没吐出来的那一瞬摘要为空，
             给个占位文案，避免看着像"坏了"；有内容就照常显示摘要。 -->
        <span class="reasoning-summary">{{ summary || (streaming ? t('reasoning.waiting') : '') }}</span>
        <!-- 行尾右侧那一簇（★ 0921）：思考耗时**常驻** + 静默提示（仅上游卡住时）。
             整簇 margin-left:auto 钉在右侧，摘要再长也盖不到（设计口径："计时靠右"）。
             ★ 0925（反馈"思考中并排两条计时，'还在进行'那条不该在思考中出现"）：
             行尾只保留一条计时 —— thinkSec（思考耗时）优先；idleSec（静默计时）仅在没有
             thinkSec 可显时才顶替（思考至少 1s 就有 thinkSec ⇒ 思考中实际只显示"让我想想 Ns"）。 -->
        <span v-if="thinkSec >= 1 || idleSec >= 5 || streaming" class="reasoning-tail">
          <!-- 思考耗时：★ 0921 拟人化文案（设计口径）—— 思考中"让我想想 Ns"、完成后"我想到了 Ns"；
               ★ 0923：思考刚开始（<1s）也要有反馈（"让我想想…"），否则过程态看着像"没在动" -->
          <span v-if="thinkSec >= 1" class="reasoning-elapsed">{{ streaming ? t('reasoning.thinking', { n: thinkSec }) : t('reasoning.elapsed', { n: thinkSec }) }}</span>
          <span v-else-if="streaming" class="reasoning-elapsed">{{ t('reasoning.thinkingStart') }}</span>
          <!-- 静默计时（思考停止但流未结束=上游缓冲死区）：0925 起仅作顶替，不与思考耗时并列 -->
          <span v-else-if="idleSec >= 5" class="reasoning-idle">{{ t('reasoning.idle', { n: idleSec }) }}</span>
        </span>
      </template>
      <p ref="bodyRef" class="reasoning-body">{{ content }}</p>
    </DisclosureRow>
  </div>
</template>

<style scoped>
/* dsh ReasoningRow.module.css 移植 */
.reasoning-row {
  display: flex;
  flex-direction: column;
}
/* ★ 0924（需求要求"过程态摘要跟完成态一样限宽"）——
   ⚠️ 这里**绝不能**写百分比 max-width：摘要的父级 `.disclosure-collapsed-sweep` 是 `display:contents`，
   百分比基准在很多浏览器下解析为 0 → `calc(100% - 130px)` 直接算成负数、把摘要压成 0 宽，
   现象就是「Think . 后面一片空白」（实测就是这个）。
   限宽交给 flex 本身：摘要 `flex:1 1 0` + `min-width:0` 自适应，尾巴 `flex:none + margin-left:auto` 钉右
   —— 摘要最多占满剩余空间，天然给计时留位。 */
.reasoning-row[data-state='running'] .reasoning-summary {
  text-overflow: ellipsis;
}
.reasoning-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}
.reasoning-summary {
  min-width: 0;
  overflow: hidden;
  /* ★ 0921 三次修正（实测"摘要文字还是会跟计时重叠"）：
     前两版 `max-width: 70%` / `calc(100% - 160px)` 都不牢 —— 摘要的父级
     `.disclosure-collapsed-sweep` 是 `display: contents`，百分比在很多情况下解析不出基准宽度，
     `max-width` 直接失效 ⇒ 摘要一路顶到计时上、两者叠在一起。
     改用**纯 flex 分配**：摘要 `flex: 1 1 0`（basis 0 = 完全按剩余空间算，不用百分比），
     行尾那簇 `.reasoning-tail` 是 `flex: none` + `margin-left: auto` —— 先给尾巴留位，
     剩下多少才是摘要的宽度，物理上不可能重叠。 */
  flex: 0 1 auto;
  /* ★★ 0924 补刀（用户两张截图定案）：上面那套 flex 分配**还不够** ——
     思考刚起（摘要空/占位）时右侧计时正常显示；**一旦思考内容到达、摘要变长（≈60 字）**，
     计时就被顶出 `.disclosure-row` 的 `overflow: hidden` 可视区整条裁掉，
     表现就是"内容一来计时就没了"（截图 2 = 还没内容 → 有「让我想想 2s」；截图 1 = 内容到了 → 右侧空白）。
     这里补一道**不依赖任何父级宽度**的硬限宽：`ch` 是字体相关单位，
     在 `display: contents` 父级下依然可靠（只有百分比 / calc(100%) 不可靠）。
     摘要最多 42 字符宽，行尾那簇 `flex:none + margin-left:auto` 必然钉在右侧、挤不掉。 */
  max-width: 42ch;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 300;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 12px;
  /* ⚠️ 0924 教训（实测"只要做限宽就不显示摘要"）：这里**绝不能**再加 `mask-image` 渐隐 ——
     `linear-gradient(to right, #000 calc(100% - 18px), transparent 100%)` 同样依赖百分比，
     在 `display:contents` 的父级下 100% 解析为 0 ⇒ calc 出负数 ⇒ **渐变整段全透明** ⇒ 摘要看不见。
     结论：在这个位置（父级 display:contents）**一切百分比/calc(100%) 都不安全**，
     限宽只能靠 flex（摘要 flex:1 1 0 + min-width:0，尾巴 flex:none + margin-left:auto）。 */
}
/* 行尾右侧那一簇（思考耗时 + 静默提示）★ 0921：
   整簇 `margin-left: auto` 钉在行尾右侧，摘要无论多长都盖不到它 */
.reasoning-tail {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  /* ★★★ 0924 定案（用户红框实验一锤定音）：计时"看不见"的**真凶**就在这 ——
     DisclosureRow 的流式扫光为了让"光只落在字形上"，给摘要容器（.disclosure-collapsed-sweep）
     设了 `-webkit-text-fill-color: transparent`，而**这个属性会继承给所有子元素** ⇒
     容器里没有自己渐变背景的文字（= 这簇计时）被一起变成全透明，屏幕上只剩一个"空心位置"
     （用户红框实验铁证：红框在、位置正确、里面一个字都没有）。
     摘要文字（"思考中…"）之所以看得见，是因为它自己就吃父级 background-clip:text 的渐变。
     这里把字色要回来：扫光只该作用于摘要本身，不该吞掉右侧计时。
     currentColor 是动态值，子元素继承后仍各自用自己的 color（caption 灰）。 */
  -webkit-text-fill-color: currentColor;
  /* ★ 0923（0924 恢复 · 反馈"计时被摘要覆盖遮挡"）：
     摘要父级 .disclosure-collapsed-sweep 是 display:contents ⇒ 百分比/flex 基准常失效，
     光靠 flex 分配挡不住长摘要。这里给尾巴加**不透明底 + 左侧留白**——
     背景继承气泡底色，物理上盖住压在下面的摘要文字，计时永远清晰可读。 */
  /* ⚠️ 0924：这里**去掉 background: inherit** —— 它在 display:contents 父级组合下不可靠，
     实测会把摘要那片区域一起"糊住"（不透明底 + padding 形成整块遮盖）。
     留白只保留左侧 padding 就够，不需要靠"盖"来遮长摘要（限宽已交给 flex）。 */
  padding-left: 16px;
  position: relative;
  z-index: 1;
}
/* 思考耗时（常驻）—— tabular-nums 让秒数跳动时宽度不抖 */
.reasoning-elapsed {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  font-weight: 300;
  line-height: 22px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* 静默计时小字（靠右由外层 .reasoning-tail 统一负责） */
.reasoning-idle {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  font-weight: 300;
  line-height: 22px;
  white-space: nowrap;
}
.reasoning-body {
  margin: 0;
  padding: 4px 8px 4px 22px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 300;
  line-height: 22px;
  white-space: pre-wrap;
  word-break: break-word;
  /* 展开后限高 + 滚动查看（超长思考过程不撑爆页面） */
  max-height: 320px;
  overflow-y: auto;
}
</style>
