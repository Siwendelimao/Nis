<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Terminal } from 'lucide-vue-next'
import { t } from '@/utils/i18n'
import { useConversationsStore, bridgeRpc } from '@/stores/conversations'
import { useNotificationsStore } from '@/stores/notifications'

const isOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

interface Command {
  icon: string
  label: string
  desc: string
  value: string
  /** ★ 0925i：带 action 的命令点击**直接执行**（不置入输入框） */
  action?: string
}

interface Category {
  name: string
  commands: Command[]
}

const categories: Category[] = [
  {
    name: 'search.typeMemory',
    commands: [
      { icon: 'fas fa-brain', label: '/memo', desc: 'quick.memoDesc', value: '/memo ' },
      { icon: 'fas fa-database', label: '/memory', desc: 'quick.memoryDesc', value: '/memory' },
      { icon: 'fas fa-save', label: '/remember', desc: 'quick.rememberDesc', value: '/remember ' },
      { icon: 'fas fa-moon', label: '/dream', desc: 'quick.dreamDesc', value: '/dream' },
      { icon: 'fas fa-compress-alt', label: '/flush', desc: 'quick.flushDesc', value: '/flush' },
    ]
  },
  {
    name: 'quick.catMedia',
    commands: [
      { icon: 'fas fa-image', label: '/imagine', desc: 'quick.imagineDesc', value: '/imagine ' },
      { icon: 'fas fa-video', label: '/imagine-video', desc: 'quick.imagineVideoDesc', value: '/imagine-video ' },
    ]
  },
  {
    name: 'quick.catSession',
    commands: [
      { icon: 'fas fa-compress-arrows-alt', label: '/compact', desc: 'quick.compactDesc', value: '/compact', action: 'compact' },
      { icon: 'fas fa-file-export', label: '/save-chat', desc: 'quick.saveChatDesc', value: '/save-chat', action: 'save' },
    ]
  },
  {
    name: 'quick.catOther',
    commands: [
      { icon: 'fas fa-question-circle', label: '/help', desc: 'quick.helpDesc', value: '/help' },
      { icon: 'fas fa-robot', label: '/partner', desc: 'quick.partnerDesc', value: '/partner' },
      { icon: 'fas fa-vial', label: '/test', desc: 'quick.testDesc', value: '/test' },
      { icon: 'fas fa-comment-dots', label: '/feedback', desc: 'quick.feedbackDesc', value: '/feedback' },
      { icon: 'fas fa-wand-magic-sparkles', label: '/demo', desc: 'quick.demoDesc', value: '/demo' },
      { icon: 'fas fa-cubes', label: '/demo-blocks', desc: 'quick.demoBlocksDesc', value: '/demo-blocks' },
      { icon: 'fas fa-list-check', label: '/plan-demo', desc: 'quick.planDemoDesc', value: '/plan-demo' },
      { icon: 'fas fa-bolt', label: '/bg-demo', desc: 'quick.bgDemoDesc', value: '/bg-demo' },
    ]
  },
]

async function selectCommand(cmd: Command) {
  isOpen.value = false
  /* ★ 0925i：带 action 的命令点击直接执行（需求的"点一下就压缩/保存"），不置入输入框 */
  if (cmd.action) { await runAction(cmd.action); return }
  const event = new CustomEvent('command-selected', { detail: cmd.value })
  window.dispatchEvent(event)
}

/** 直接执行型命令：调后端 RPC + toast 反馈（复用 conversations 的 bridgeRpc：client-request 包装/解包同一套） */
async function runAction(action: string) {
  const convs = useConversationsStore()
  const notice = useNotificationsStore()
  const sid = convs.activeConversationId
  if (!sid) { notice.push({ title: t('quick.title'), message: '请先打开一个会话', level: 'warning' }); return }
  try {
    const method = action === 'compact' ? 'session.compactNow' : 'session.exportTranscript'
    /* ★0927：压缩要走一次摘要模型调用，给 150s 大超时（默认 30s 会误杀）；
       超时只是 RPC 层放弃等待——后端压缩仍在继续，收尾通知/广播帧照发，界面不会卡死 */
    const data = await bridgeRpc(method, { sessionId: sid }, 150000)
    if (action === 'compact') {
      notice.push({ title: t('quick.title'), level: 'success', message: `压缩完成：折叠 ${data?.folded} 条早期消息（摘要 ${data?.summaryLen} 字）${data?.archiveRel ? '，全量存档 ' + data.archiveRel : ''}` })
    } else {
      notice.push({ title: t('quick.title'), level: 'success', message: `对话已全量保存到工作区：${data?.rel}` })
    }
  } catch (e: any) {
    notice.push({ title: t('quick.title'), level: 'error', message: `${action === 'compact' ? '压缩' : '保存'}失败：${String(e?.message || e).slice(0, 120)}` })
  }
}

function toggle() {
  isOpen.value = !isOpen.value
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div ref="menuRef" class="relative flex-shrink-0 flex items-center" style="height: 32px;">
    <button
      @click="toggle"
      class="p-2 hover:bg-gray-100 rounded-full transition-colors flex items-center justify-center"
      :title="t('quick.title')"

    >
      <Terminal :size="16" stroke-width="1.75" class="text-gray-600" />
    </button>

    <Transition name="cmd-pop">
      <div
        v-if="isOpen"
        class="tool-popover absolute bottom-full left-0 mb-2 w-60 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-[9999] max-h-[360px] overflow-y-auto custom-scroll"
      >
        <template v-for="(cat, ci) in categories" :key="ci">
          <div class="px-3 py-1.5">
            <span class="text-[10px] font-[530] text-gray-400 uppercase tracking-wider">{{ t(cat.name) }}</span>
          </div>
          <button
            v-for="(cmd, i) in cat.commands"
            :key="cmd.value"
            @click="selectCommand(cmd)"
            class="cmd-item w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-900 hover:text-white transition-colors group"
            :style="{ animationDelay: isOpen ? (ci * 50 + i * 40) + 'ms' : '0ms' }"
          >
            <div class="flex-1 min-w-0">
              <div class="text-xs font-[530]">{{ cmd.label }}</div>
              <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ t(cmd.desc) }}</div>
            </div>
          </button>
          <div v-if="ci < categories.length - 1" class="my-1 mx-3 border-t border-gray-100"></div>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.cmd-pop-enter-active {
  animation: popIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.cmd-pop-leave-active {
  animation: popOut 0.15s ease-in both;
}

@keyframes popIn {
  from { opacity: 0; transform: translateY(8px) scale(0.92); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes popOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(8px) scale(0.92); }
}

.cmd-pop-enter-active .cmd-item {
  animation: itemSlide 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes itemSlide {
  from { opacity: 0; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}
</style>
