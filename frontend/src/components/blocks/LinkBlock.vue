<script setup lang="ts">
import { ref, computed } from 'vue'
import { useNotificationsStore } from '@/stores/notifications'
import { t } from '@/utils/i18n'

const props = defineProps<{ content: string }>()

const showModal = ref(false)
const currentLink = ref('')

interface LinkItem {
  text: string
  url: string
}

const links = computed<LinkItem[]>(() => {
  const items: LinkItem[] = []
  const mdRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let match
  while ((match = mdRegex.exec(props.content)) !== null) {
    items.push({ text: match[1], url: match[2] })
  }
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g
  const usedUrls = new Set(items.map(i => i.url))
  while ((match = urlRegex.exec(props.content)) !== null) {
    if (!usedUrls.has(match[1])) {
      items.push({ text: match[1], url: match[1] })
    }
  }
  return items
})

function openLink(url: string) {
  currentLink.value = url
  showModal.value = true
}

function copyLink() {
  navigator.clipboard.writeText(currentLink.value)
}

function openInBrowser() {
  window.open(currentLink.value, '_blank')
}

function previewLink() {
  showModal.value = false
  useNotificationsStore().push({ level: 'message', title: t('link.previewTitle'), content: currentLink.value, type: 'system' })
}
</script>

<template>
  <div class="text-[15px] leading-relaxed text-gray-700">
    <span v-for="(link, i) in links" :key="i">
      <a @click.prevent="openLink(link.url)" class="text-blue-500 hover:text-blue-600 underline decoration-blue-300 cursor-pointer">{{ link.text }}</a><span v-if="i < links.length - 1">, </span>
    </span>

    <!-- 链接弹窗 -->
    <Teleport to="body">
      <div v-if="showModal" class="fixed inset-0 z-[9999] flex items-center justify-center" @click.self="showModal = false">
        <div class="absolute inset-0 bg-black/50"></div>
        <div class="relative z-10 bg-white rounded-2xl shadow-2xl p-6 w-[420px] max-w-[90vw]">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <i class="fas fa-link text-blue-500"></i>
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-medium text-gray-800">{{ t('link.external') }}</h3>
              <p class="text-xs text-gray-400 truncate mt-0.5">{{ currentLink }}</p>
            </div>
          </div>
          <div class="bg-gray-50 rounded-lg p-3 mb-4">
            <p class="text-sm text-gray-600 break-all font-mono">{{ currentLink }}</p>
          </div>
          <div class="flex items-center gap-2">
            <button @click="copyLink" class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm text-gray-700 transition-colors">
              <i class="far fa-copy text-xs"></i>
              {{ t('chat.copy') }}
            </button>
            <button @click="openInBrowser" class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm text-gray-700 transition-colors">
              <i class="far fa-eye text-xs"></i>
              {{ t('panel.go') }}
            </button>
            <button @click="previewLink" class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-50 hover:bg-indigo-100 rounded-xl text-sm text-indigo-600 transition-colors">
              <i class="fas fa-columns text-xs"></i>
              {{ t('panel.viewPreview') }}
            </button>
          </div>
          <button @click="showModal = false" class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
