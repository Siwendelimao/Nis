<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'
import { useChatStore } from '@/stores/chat'
import { useModalLayer } from '@/utils/modalStack'

/**
 * SearchModal —— 全局搜索（0914 下午做真：此前是 4 条硬编码 demo，搜什么都出那几条）。
 * 数据源：
 *   对话 = 后端 session.search（标题 + 全量消息正文，含 QQ/微信通道会话）
 *   记忆 = 后端 memory.search（与 AI 检索同源：hybrid 语义 + 词面）
 *   知识 = knowledge.list 前端过滤（条目量级小，直拉全量）
 * 键盘：↑↓ 导航 / Enter 打开 / Esc 关闭；鼠标点击亦可（打开动作由父组件处理）。
 */
interface SearchResultItem {
  type: 'conversation' | 'memory' | 'knowledge'
  id: string
  icon: string
  title: string
  snippet: string
  time?: number
}

const props = defineProps<{
  open: boolean
  /** 0914：外部带词打开（选中文字 → 右键「搜索」） */
  seed?: string
  buttonRect?: DOMRect | null
}>()

const emit = defineEmits<{
  close: []
  openResult: [item: SearchResultItem]
}>()

const chatStore = useChatStore()
const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const isAnimating = ref(false)
const showModal = ref(false)
const backdropFadeOut = ref(false)

const searchResults = ref<SearchResultItem[]>([])
const searching = ref(false)
const activeIndex = ref(0)

let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0

watch(() => props.open, (val) => {
  if (val) {
    showModal.value = true
    backdropFadeOut.value = false
    isAnimating.value = true
      nextTick(() => {
        searchInput.value?.focus()
        setTimeout(() => { isAnimating.value = false }, 450)
      })
      // 0914：带词打开（选中文字 → 右键「搜索」）→ 预填并立即搜
      const q = String(props.seed || '').trim()
      if (q) {
        searchQuery.value = q
        searching.value = true
        void runSearch(q)
      }
    } else {
    backdropFadeOut.value = true
    isAnimating.value = true
    setTimeout(() => {
      showModal.value = false
      isAnimating.value = false
      backdropFadeOut.value = false
      searchQuery.value = ''
      searchResults.value = []
      activeIndex.value = 0
      searching.value = false
      }, 300)
    }
  })

// 0914：弹窗已开时 seed 变化（连续选中不同段落右键搜索）→ 立即更新
watch(() => props.seed, (q) => {
  if (props.open && String(q || '').trim()) {
    searchQuery.value = String(q).trim()
    searching.value = true
    void runSearch(searchQuery.value)
  }
})

function squash(s: unknown, n: number): string {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

/** 防抖 280ms → 三个数据源并行拉取，按「对话 → 记忆 → 知识」顺序合并 */
function onInput() {
  if (searchTimer) clearTimeout(searchTimer)
  const q = searchQuery.value.trim()
  if (!q) {
    searchResults.value = []
    searching.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(() => { void runSearch(q) }, 280)
}

async function runSearch(q: string) {
  const seq = ++searchSeq
  const lower = q.toLowerCase()
  const results: SearchResultItem[] = []
  // ① 对话（后端全文：标题 + 消息正文）
  try {
    const r: any = await chatStore.bridgeRpc('session.search', { query: q, limit: 12 }, 60000 /* ★0927 慢 RPC 大超时：全量搜索 */)
    for (const hit of r?.results || []) {
      results.push({
        type: 'conversation',
        id: String(hit?.sessionId || ''),
        icon: 'fas fa-comment',
        title: squash(hit?.title, 60) || t('search.typeConversation'),
        snippet: squash(hit?.snippet, 110) || t('search.typeConversation'),
        time: Number(hit?.updatedAt || 0),
      })
    }
  } catch { /* 后端未就绪：跳过该源 */ }
  // ② 记忆（与 AI 检索同源；后端未就绪/桥冷启动时会失败 → 静默跳过）
  try {
    const r: any = await chatStore.bridgeRpc('memory.search', { query: q, top_k: 6 })
    for (const m of r?.memories || []) {
      results.push({
        type: 'memory',
        id: String(m?.id || ''),
        icon: 'fas fa-brain',
        title: squash(m?.memory_type, 30) || t('search.typeMemory'),
        snippet: squash(m?.content, 120),
      })
    }
  } catch { /* ignore */ }
  // ③ 知识（条目级过滤，最多 6 条）
  try {
    const r: any = await chatStore.bridgeRpc('knowledge.list', {})
    let n = 0
    for (const e of r?.entries || []) {
      const hitTitle = String(e?.title || '')
      const hitSummary = String(e?.summary || '')
      const text = `${hitTitle} ${hitSummary} ${e?.content || ''}`.toLowerCase()
      if (!text.includes(lower)) continue
      results.push({
        type: 'knowledge',
        id: String(e?.id || ''),
        icon: 'fas fa-book-open',
        title: squash(hitTitle, 60) || squash(hitSummary, 60) || t('search.typeKnowledge'),
        snippet: squash(hitSummary || e?.content, 120),
      })
      if (++n >= 6) break
    }
  } catch { /* ignore */ }
  if (seq !== searchSeq) return // 过期响应丢弃（快速连续输入时）
  searchResults.value = results
  activeIndex.value = 0
  searching.value = false
}

function openItem(item: SearchResultItem) {
  emit('openResult', item)
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return
  /* Esc 不在这里处理 —— 交给全局层级栈（utils/modalStack.ts），
     保证"只关最上面那一层"。↑↓/Enter 这类导航键仍在本监听里。 */
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (searchResults.value.length) activeIndex.value = (activeIndex.value + 1) % searchResults.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (searchResults.value.length) activeIndex.value = (activeIndex.value - 1 + searchResults.value.length) % searchResults.value.length
  } else if (e.key === 'Enter') {
    const item = searchResults.value[activeIndex.value]
    if (item) { e.preventDefault(); openItem(item) }
  }
}

onMounted(() => { document.addEventListener('keydown', onKeydown) })
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  if (searchTimer) clearTimeout(searchTimer)
})

/* Esc 层级：全局搜索是独立的顶层浮层 —— 它开着时按 Esc 只关它。 */
useModalLayer(() => props.open, () => emit('close'))
</script>

<template>
  <Teleport to="body">
    <!-- Backdrop -->
    <div
      v-if="showModal"
      :class="['fixed inset-0 z-40 bg-black/30', backdropFadeOut ? 'backdrop-fade-out' : 'backdrop-fade-in']"
    ></div>

    <!-- Modal -->
    <div v-if="showModal" class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <!-- Modal + Close button wrapper -->
      <div class="relative flex flex-col items-center">
        <div
          :class="['dock-modal', isAnimating && props.open ? 'dock-in' : '', isAnimating && !props.open ? 'dock-out' : '']"
          class="relative w-[560px] max-w-[94vw] bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden"
        >
        <!-- Search Input -->
        <div class="px-6 pt-6 pb-5 border-b-[1.5px] border-gray-100">
          <div class="relative">
            <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input
              ref="searchInput"
              v-model="searchQuery"
              @input="onInput"
              type="text"
              :placeholder="t('search.placeholder')"
              class="w-full h-11 pl-11 pr-4 bg-white border-[1.5px] border-gray-200 rounded-lg text-[15px] text-gray-700 placeholder-gray-400 focus:outline-none focus:border-black transition-colors"
            />
          </div>
        </div>

        <!-- Content -->
        <div class="max-h-[360px] overflow-y-auto custom-scroll p-6 pt-5">
          <!-- Search Results -->
          <template v-if="searchResults.length > 0">
            <div class="text-[11px] font-semibold text-gray-500 mb-2">{{ t('search.results') }}</div>
            <div
              v-for="(result, index) in searchResults"
              :key="result.type + ':' + result.id + ':' + index"
              :class="['flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors mb-1', index === activeIndex ? 'bg-gray-100' : 'hover:bg-gray-50']"
              @click="openItem(result)"
              @mouseenter="activeIndex = index"
            >
              <div class="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                <i :class="[result.icon, 'text-xs text-gray-500']"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm text-gray-700 truncate">{{ result.title }}</div>
                <div v-if="result.snippet" class="text-xs text-gray-400 truncate">{{ result.snippet }}</div>
              </div>
              <i class="fas fa-chevron-right text-[10px] text-gray-300"></i>
            </div>
          </template>

          <!-- Searching -->
          <template v-else-if="searching">
            <!-- 0925（需求）：过程态从旋转 spinner 改成「放大镜循环扫视」 -->
            <div class="text-center py-8 text-gray-400">
              <div class="search-scan" aria-hidden="true">
                <span class="search-scan-track"></span>
                <i class="fas fa-search search-scan-icon"></i>
              </div>
              <div class="text-sm">{{ t('search.searching') }}</div>
            </div>
          </template>

          <!-- Empty State -->
          <template v-else-if="searchQuery.trim()">
            <div class="text-center py-8 text-gray-400">
              <i class="fas fa-search text-2xl mb-2"></i>
              <div class="text-sm">{{ t('search.noResults') }}</div>
            </div>
          </template>

          <!-- Hint -->
          <template v-else>
            <div class="text-center py-6 text-gray-400">
              <div class="text-xs">{{ t('search.hint') }}</div>
            </div>
          </template>
        </div>

        <!-- Footer -->
        <div class="px-6 py-3.5 border-t-[1.5px] border-gray-100 flex items-center gap-4 text-[10px] text-gray-400">
          <span><kbd class="bg-gray-100 border border-gray-200 px-1 rounded-md mr-1">↑↓</kbd> {{ t('search.nav') }}</span>
          <span><kbd class="bg-gray-100 border border-gray-200 px-1 rounded-md mr-1">↵</kbd> {{ t('search.select') }}</span>
          <span><kbd class="bg-gray-100 border border-gray-200 px-1 rounded-md mr-1">ESC</kbd> {{ t('search.close') }}</span>
        </div>
        </div>
        <!-- Close button: fixed distance below modal -->
        <button
          @click="emit('close')"
          :class="['close-btn', isAnimating && props.open ? 'close-in' : '', isAnimating && !props.open ? 'close-out' : '']"
          class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-6"
        >
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Close button: slides up from below after modal fully appears */
.close-in {
  animation: closeBtnIn 0.5s cubic-bezier(0.34, 1.6, 0.64, 1) 0.3s both;
}
.close-out {
  animation: closeBtnOut 0.2s cubic-bezier(0.4, 0, 1, 1) both;
}

@keyframes closeBtnIn {
  0% {
    opacity: 0;
    transform: translateY(40px);
  }
  60% {
    opacity: 1;
    transform: translateY(-6px);
  }
  100% {
    transform: translateY(0);
  }
}
@keyframes closeBtnOut {
  0% {
    opacity: 1;
    transform: translateY(0);
  }
  100% {
    opacity: 0;
    transform: translateY(40px);
  }
}
.backdrop-fade-in {
  animation: backdropFadeIn 0.3s ease forwards;
}
.backdrop-fade-out {
  animation: backdropFadeOut 0.3s ease forwards;
}

@keyframes backdropFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes backdropFadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}

/* Dock expand animation */
.dock-in {
  animation: dockExpand 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards;
}
.dock-out {
  animation: dockCollapse 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

/* 0925（需求）：搜索过程态 = 放大镜沿轨迹循环扫视（替代原 fa-spinner 旋转）。
 * 只动 transform（WebView2 安全做法）；倾斜角随位移变化，像手持放大镜左右察看。 */
.search-scan {
  position: relative;
  height: 30px;
  margin-bottom: 6px;
}
.search-scan-track {
  position: absolute;
  left: 50%;
  bottom: 2px;
  width: 72px;
  height: 3px;
  margin-left: -36px;
  border-radius: 999px;
  background: rgba(156, 163, 175, 0.28);
}
.search-scan-icon {
  position: absolute;
  left: 50%;
  top: 1px;
  margin-left: -8px;
  font-size: 16px;
  color: #9ca3af;
  animation: search-scan-move 1.8s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes search-scan-move {
  0%, 100% { transform: translateX(-24px) rotate(-14deg); }
  50%      { transform: translateX(24px)  rotate(14deg); }
}

@keyframes dockExpand {
  0% {
    opacity: 0;
    transform: scale(0.05) rotateX(8deg) translateY(-20px);
    transform-origin: top left;
    filter: blur(4px);
  }
  50% {
    opacity: 1;
    filter: blur(0);
  }
  70% {
    transform: scale(1.02) rotateX(-1deg) translateY(0);
  }
  100% {
    opacity: 1;
    transform: scale(1) rotateX(0) translateY(0);
    filter: blur(0);
  }
}
@keyframes dockCollapse {
  0% {
    opacity: 1;
    transform: scale(1) rotateX(0) translateY(0);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: scale(0.05) rotateX(8deg) translateY(-20px);
    transform-origin: top left;
    filter: blur(4px);
  }
}
</style>
