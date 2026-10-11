import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 全局 UI 状态 —— 跨组件跳转（如输入框「未设置常用模型」→ 打开设置供应商页）。
 */
export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false)
  const settingsTab = ref('general')

  /** 记忆提炼请求：对话右键「提炼本窗口记忆」→ 当前聊天窗口弹出提炼结果 */
  const memoryExtractRequest = ref<{ seq: number }>({ seq: 0 })

  function requestMemoryExtract() {
    memoryExtractRequest.value = { seq: memoryExtractRequest.value.seq + 1 }
  }

  function openSettings(tab = 'general') {
    settingsTab.value = tab
    settingsOpen.value = true
  }

  function closeSettings() {
    settingsOpen.value = false
  }

  return {
    settingsOpen,
    settingsTab,
    memoryExtractRequest,
    requestMemoryExtract,
    openSettings,
    closeSettings,
  }
})
