<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{
  content?: string
  alt?: string
  label?: string
  duration?: string
  /** 生成任务序号（用于停止） */
  seq?: number
}>()

const emit = defineEmits<{
  stop: []
}>()

const progress = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

// 假图片动画：旋转渐变光晕 + 中央"正在生成"文字/百分比/进度条
onMounted(() => {
  timer = setInterval(() => {
    if (progress.value < 96) {
      progress.value += 1 + Math.random() * 2
    } else {
      progress.value = 96
    }
  }, 150)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="my-3 select-none">
    <!-- 假图片：柔和粉蓝渐变背景 + 旋转彩虹光晕（动画过渡感），固定宽度与真图一致 -->
    <div
      class="relative overflow-hidden rounded-xl w-[360px] max-w-full"
      style="aspect-ratio: 1 / 1; background: linear-gradient(135deg, #ffe8f3, #d9f3ff);"
    >
      <!-- 旋转渐变光晕层（conic-gradient，双层反向旋转，blur 柔光） -->
      <div class="placeholder-glow"></div>
      <div class="placeholder-glow placeholder-glow--reverse"></div>

      <!-- 中央内容：正在生成文字 + 百分比 + 进度条 -->
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5">
        <div class="text-[14px] font-semibold text-gray-700">{{ label || t('image.genPlaceholder') }}</div>
        <div v-if="alt" class="text-[11px] text-gray-500 text-center line-clamp-2 max-w-[80%]">{{ alt }}</div>
        <div class="w-full max-w-[260px] flex flex-col items-center gap-1.5 mt-1">
          <div class="flex-1 w-full h-1.5 rounded-full bg-white/70 overflow-hidden">
            <div
              class="h-full rounded-full bg-gradient-to-r from-pink-400 to-sky-400 transition-all duration-200"
              :style="{ width: progress + '%' }"
            ></div>
          </div>
          <span class="text-[12px] text-gray-500 tabular-nums">{{ Math.round(progress) }}%</span>
        </div>
        <!-- 停止生成 -->
        <button
          v-if="seq != null"
          @click="emit('stop')"
          class="flex items-center gap-1.5 text-[11px] font-medium text-gray-600 bg-white/80 hover:bg-white border border-gray-200 rounded-lg px-3 py-1.5 transition-colors"
        >
          <i class="fas fa-stop text-[9px]"></i>{{ t('image.stopGen') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 旋转彩虹光晕 */
.placeholder-glow {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 200%;
  height: 200%;
  background: conic-gradient(
    from 0deg,
    #ff9aa2,
    #ffb7b2,
    #ffdac1,
    #e2f0cb,
    #a2e4ff,
    #c9afff,
    #ffb7b2,
    #ff9aa2
  );
  transform: translate(-50%, -50%);
  animation: placeholder-rotate 8s linear infinite;
  filter: blur(50px);
  opacity: 0.8;
  pointer-events: none;
}
.placeholder-glow--reverse {
  width: 180%;
  height: 180%;
  animation: placeholder-rotate-reverse 10s linear infinite;
  opacity: 0.6;
}

@keyframes placeholder-rotate {
  0% { transform: translate(-50%, -50%) rotate(0deg); }
  100% { transform: translate(-50%, -50%) rotate(360deg); }
}
@keyframes placeholder-rotate-reverse {
  0% { transform: translate(-50%, -50%) rotate(0deg); }
  100% { transform: translate(-50%, -50%) rotate(-360deg); }
}
</style>
