<script setup lang="ts">
/**
 * 语音输入按钮（0920）—— 发送按钮左侧
 *
 * 只在「设置 → 语音 → 语音输入」开着、且模型已装好时出现（`voice.asrReady`）；
 * 关掉开关 → 后端释放引擎、这里自动消失（设计口径：开关联动按钮）。
 *
 * 录音用 AudioContext + ScriptProcessor 直采 PCM（不经过 MediaRecorder 的 webm/opus，
 * 省掉解码那一步；sherpa 的识别接口本来就要 Float32 采样）。
 */
import { computed, onMounted, ref } from 'vue'
import { useVoiceStore } from '@/stores/voice'
import { t } from '@/utils/i18n'

const emit = defineEmits<{ text: [value: string] }>()

const voice = useVoiceStore()
const transcribing = ref(false)

/* 首次挂载拉一次语音状态（决定这个按钮显不显示） */
onMounted(() => { void voice.ensureLoaded() })

const tip = computed(() =>
  transcribing.value
    ? t('chat.voiceInputTranscribing')
    : voice.recording
      ? t('chat.voiceInputStop')
      : t('chat.voiceInput'),
)

/** 音量驱动的呼吸环：录音中才动 */
const ringScale = computed(() => 1 + Math.min(voice.micLevel, 1) * 0.35)

async function onClick() {
  if (transcribing.value) return
  if (!voice.recording) {
    const ok = await voice.startRecording()
    if (!ok) return
    return
  }
  transcribing.value = true
  try {
    const txt = await voice.stopRecording()
    if (txt) emit('text', txt)
  } finally {
    transcribing.value = false
  }
}
</script>

<template>
  <button
    v-if="voice.asrReady"
    type="button"
    class="voice-in-btn"
    :class="{ 'is-rec': voice.recording, 'is-busy': transcribing }"
    :title="tip"
    @click="onClick"
  >
    <!-- 录音中：随音量呼吸的环 -->
    <span v-if="voice.recording" class="vi-ring" :style="{ transform: `scale(${ringScale})` }"></span>
    <span v-if="voice.recording" class="vi-pulse"></span>
    <!-- ★ 0923（用户定）：识别中的缓冲动画 = 一个发光的点带尾巴绕圈（替掉原来的 fa-spinner） -->
    <span v-if="transcribing" class="vi-orbit" aria-hidden="true"><span class="vi-orbit-dot"></span></span>
    <i v-else class="fas vi-icon" :class="voice.recording ? 'fa-stop' : 'fa-microphone'"></i>
  </button>
</template>

<style scoped>
/* ★ 0921（反馈"语音输入按钮有点丑，参照发送按钮做质感一些"）：
   直接对齐 `.send-btn`（fox-61）那套配方 ——
   ① 深色渐变实心底（不是原来的"轻描边空芯"）
   ② 多层投影压出体积（近距硬影 + 远距柔影）
   ③ `::after` 描边盒（padding-box 深色 + border-box 暗边）
   ④ `::before` 内层 4px 模糊高光
   ⑤ hover/active **只改光效不改几何**（发送按钮那条铁律：位移会被读成"按钮在动"）
   录音中 = 同一套配方只把色系换成红，保持"正在录"的信号强度。 */
.voice-in-btn {
  --vi-1: #1e1e2e;
  --vi-2: #0a0a12;
  --vi-accent: 99, 102, 241;
  --radius: 9999px;

  position: relative;
  /* ★ 0923（用户定）：再缩一号（32 → 28）—— 发送按钮同步降到 32，两个圆保持层次 */
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #ffffff;
  background: var(--vi-1);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
  box-shadow: 0 0.5px 0.5px 1px rgba(0, 0, 0, 0.2),
    0 10px 20px rgba(0, 0, 0, 0.2), 0 4px 5px 0px rgba(0, 0, 0, 0.05);
  transition: box-shadow 0.3s ease, background 0.3s ease;
}
.voice-in-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: linear-gradient(var(--vi-1), var(--vi-2)) padding-box,
    linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.45)) border-box;
  z-index: 0;
  transition: box-shadow 0.4s ease;
}
.voice-in-btn::before {
  content: '';
  position: absolute;
  /* ★ 0923：按钮缩到 28px 后，内圈留白同步收一点（4 → 2.5） */
  inset: 2.5px;
  border-radius: 30px;
  background: linear-gradient(to top, var(--vi-1), var(--vi-2));
  filter: blur(0.5px);
  z-index: 2;
  pointer-events: none;
}
.voice-in-btn:hover {
  box-shadow: 0 0 1px 2px rgba(var(--vi-accent), 0.35),
    0 15px 30px rgba(0, 0, 0, 0.28), 0 10px 3px -3px rgba(0, 0, 0, 0.04);
}
.voice-in-btn:hover::after { box-shadow: inset 0 -1px 3px 0 rgba(var(--vi-accent), 0.3); }
.voice-in-btn:active {
  box-shadow: 0 0 1px 2px rgba(var(--vi-accent), 0.32),
    0 10px 3px -3px rgba(0, 0, 0, 0.2);
}
.vi-icon {
  font-size: 12px;
  position: relative;
  z-index: 3;
}

/* ★ 0923：「一个发光的点带尾巴在旋转」—— conic-gradient 渐隐弧当尾巴 + 头部一颗发光点，
   整体绕圆心匀速转（亮度用 scale 微微呼吸，不至于死板）。
   颜色跟随按钮的 --vi-accent（默认靛蓝 / 录音时红），和按钮光效同一套色系。 */
.vi-orbit {
  position: relative;
  z-index: 3;
  width: 16px;
  height: 16px;
  display: inline-block;
  animation: viOrbitSpin 0.9s linear infinite;
}
.vi-orbit::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  background: conic-gradient(
    from 0deg,
    rgba(var(--vi-accent), 0) 0deg,
    rgba(var(--vi-accent), 0.12) 110deg,
    rgba(var(--vi-accent), 0.55) 240deg,
    rgba(var(--vi-accent), 0.95) 330deg,
    rgba(var(--vi-accent), 1) 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
}
.vi-orbit-dot {
  position: absolute;
  top: -1px;
  left: 50%;
  width: 5px;
  height: 5px;
  margin-left: -2.5px;
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 0 6px 2px rgba(var(--vi-accent), 0.95), 0 0 12px 5px rgba(var(--vi-accent), 0.45);
  animation: viOrbitGlow 0.9s ease-in-out infinite;
}
@keyframes viOrbitSpin {
  to { transform: rotate(360deg); }
}
@keyframes viOrbitGlow {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.78); opacity: 0.82; }
}
/* 录音中：同一套配方换红色系 + 中间那颗变停止方块 */
.voice-in-btn.is-rec {
  --vi-1: #ef4444;
  --vi-2: #b91c1c;
  --vi-accent: 239, 68, 68;
}
.voice-in-btn.is-rec .vi-icon { font-size: 11px; }
/* ★ 0923（反馈）：识别中**不再降透明度** —— 原来 opacity 0.72 会让按钮发灰、
   底色跟常态（深色 #1e1e2e→#0a0a12）对不上；现在保持同一底色，只把光标改成默认。 */
.voice-in-btn.is-busy { cursor: default; }

/* 随音量呼吸的实心环（贴在按钮内侧） */
.vi-ring {
  position: absolute;
  inset: -2px;
  border-radius: 9999px;
  border: 2px solid rgba(239, 68, 68, 0.45);
  transition: transform 0.08s linear;
  pointer-events: none;
  z-index: 4;
}
/* 慢速扩散环（表达"在录"） */
.vi-pulse {
  position: absolute;
  inset: -2px;
  border-radius: 9999px;
  border: 1.5px solid rgba(239, 68, 68, 0.5);
  animation: viPulse 1.6s ease-out infinite;
  pointer-events: none;
  z-index: 4;
}
@keyframes viPulse {
  0% { transform: scale(1); opacity: 0.7; }
  100% { transform: scale(1.55); opacity: 0; }
}
</style>
