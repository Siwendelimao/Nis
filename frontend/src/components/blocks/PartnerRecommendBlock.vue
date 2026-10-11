<script setup lang="ts">
import { ref } from 'vue'
import LogAvatar from '../LogAvatar.vue'
import { usePartnersStore } from '@/stores/partners'
import { t } from '@/utils/i18n'

const props = defineProps<{
  project_id: string
  partners: Array<{ id: string; reason: string }>
}>()

const emit = defineEmits<{
  (e: 'confirm', payload: { project_id: string; partners: Array<{ id: string; reason: string }> }): void
  (e: 'ignore', payload: { project_id: string }): void
}>()

const partnersStore = usePartnersStore()
const responded = ref(false)
const confirmed = ref(false)

function handleConfirm() {
  if (responded.value) return
  responded.value = true
  confirmed.value = true
  emit('confirm', { project_id: props.project_id, partners: props.partners })
}

function handleIgnore() {
  if (responded.value) return
  responded.value = true
  confirmed.value = false
  emit('ignore', { project_id: props.project_id })
}
</script>

<template>
  <div class="my-3 rounded-xl bg-white shadow-sm overflow-hidden">
    <!-- 头部 -->
    <div class="flex items-center gap-2.5 px-4 py-3">
      <div class="w-7 h-7 rounded-md bg-gray-900 flex items-center justify-center text-white">
        <i class="fas fa-users text-xs"></i>
      </div>
      <span class="text-sm font-medium text-gray-900">{{ t('chat.partnerRecommendTitle') }}</span>
    </div>

    <!-- 内容 -->
    <div class="px-4 pb-4 pt-1">
      <p class="text-sm text-gray-700 mb-3 leading-relaxed">{{ t('chat.partnerRecommendIntro') }}</p>

      <!-- 空名单：只显示忽略 -->
      <template v-if="!partners || !partners.length">
        <div class="text-xs text-gray-400 mb-3">{{ t('chat.partnerRecommendEmpty') }}</div>
        <div v-if="!responded">
          <button
            @click="handleIgnore"
            class="px-4 py-2 rounded-lg border border-gray-100 bg-white text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >{{ t('chat.partnerRecommendIgnore') }}</button>
        </div>
      </template>

      <!-- 伙伴列表 -->
      <div v-else class="space-y-2 mb-3">
        <div
          v-for="p in partners"
          :key="p.id"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-100 bg-white"
        >
          <LogAvatar :name="partnersStore.displayName(p.id) || 'P'" :image="partnersStore.avatar(p.id) || undefined" :size="32" class="flex-shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-gray-800">{{ partnersStore.displayName(p.id) || p.id }}</div>
            <div v-if="partnersStore.role(p.id)" class="text-[10px] text-indigo-500 font-medium">{{ partnersStore.role(p.id) }}</div>
            <div class="text-xs text-gray-500 truncate">{{ p.reason }}</div>
          </div>
        </div>
      </div>

      <!-- 按钮 -->
      <div v-if="!responded" class="flex gap-2">
        <button
          @click="handleConfirm"
          class="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-black transition-colors flex items-center gap-1.5"
        >
          <i class="fas fa-check text-xs"></i>{{ t('chat.partnerRecommendConfirm') }}
        </button>
        <button
          @click="handleIgnore"
          class="px-4 py-2 rounded-lg border border-gray-100 bg-white text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
        >{{ t('chat.partnerRecommendIgnore') }}</button>
      </div>

      <!-- 已响应 -->
      <div v-else class="flex items-center gap-2 py-1">
        <i :class="[confirmed ? 'fas fa-check text-emerald-400' : 'fas fa-minus text-gray-300', 'text-xs']"></i>
        <span class="text-sm text-gray-400">{{ confirmed ? t('chat.partnerRecommendConfirmed') : t('chat.partnerRecommendIgnored') }}</span>
      </div>
    </div>
  </div>
</template>
