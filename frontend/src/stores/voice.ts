import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useChatStore } from './chat'

/** 后端 voice.ts 的模型状态（字段与 backend/voice.ts 的 VoiceModelState 一致） */
export interface VoiceModelState {
  id: string
  kind: 'asr' | 'tts'
  name: string
  desc: string
  tags: string[]
  note: string
  approxMB: number
  installed: boolean
  ready: boolean
  sizeBytes: number
  sampleRate: number
  voices?: { id: number; label: string }[]
  voiceTotal?: number
  sid?: number
  speed?: number
  active: boolean
}

export interface VoiceState {
  runtimeInstalled: boolean
  runtimeVersion: string
  root: string
  asrEnabled: boolean
  ttsEnabled: boolean
  asrModel: string
  ttsModel: string
  numThreads: number
  asrLoaded: boolean
  ttsLoaded: boolean
  models: VoiceModelState[]
}

interface VoiceJob {
  id: string
  targetId: string
  kind: 'install' | 'remove'
  status: 'running' | 'done' | 'error'
  percent: number
  phase: string
  stage: string
  bytes: number
  totalBytes: number
  speedBps: number
  etaSec: number
  log: string[]
  error: string
}

/**
 * 语音 store（0920）
 *
 * 口径（既定的）：
 *  · 模型是**增量包**，装在后端 `<envDir>/voice` —— 这里只是它的镜像 + 播放/录音的编排；
 *  · **朗读只启用一个模型**，但每个模型各自记住自己的音色/语速（切回来还是原来那个）；
 *  · 关开关 → 后端立刻释放引擎（`voice.set` 里带释放），前端也把播放停掉。
 *
 * 朗读为什么"分句多次调"：sherpa 是**离线整段合成**（不是流式），一次给一大段话要等很久才有声音。
 * 按句切开逐句合成 → 第一句 ~1 秒就能开口，剩下边播边合成（实测 RTF 0.32，比播放快 3 倍，接得上）。
 */
export const useVoiceStore = defineStore('voice', () => {
  const chatStore = useChatStore()

  const state = ref<VoiceState | null>(null)
  const loaded = ref(false)
  /** 安装/卸载作业（前端轮询 voice.job 拿进度） */
  const job = ref<VoiceJob | null>(null)
  const busyId = ref('')
  /** 正在朗读的消息 key（同一 key 再点一次 = 停止） */
  const speakingKey = ref('')
  /** 正在录音 */
  const recording = ref(false)
  /** 录音过程中的实时音量（按钮动效用它） */
  const micLevel = ref(0)
  const lastError = ref('')

  const ttsModel = computed<VoiceModelState | undefined>(() => state.value?.models.find((m) => m.kind === 'tts' && m.id === state.value?.ttsModel))
  const ttsReady = computed(() => !!state.value?.ttsEnabled && !!ttsModel.value?.ready)
  const asrReady = computed(() => {
    const m = state.value?.models.find((x) => x.kind === 'asr' && x.id === state.value?.asrModel)
    return !!state.value?.asrEnabled && !!m?.ready
  })

  async function refresh(): Promise<VoiceState | null> {
    try {
      const r: any = await chatStore.bridgeRpc('voice.state', {})
      if (r && r.models) {
        state.value = r as VoiceState
        loaded.value = true
      }
      return state.value
    } catch (e) {
      console.error('[voice] 取状态失败:', e)
      return null
    }
  }

  /** 首屏懒加载：只在真的要用（打开设置语音页 / 显示按钮）时拉一次 */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return
    await refresh()
  }

  /* ── 配置修改（开关 / 选模型 / 音色语速） ── */
  async function set(patch: Record<string, any>): Promise<void> {
    try {
      const r: any = await chatStore.bridgeRpc('voice.set', { patch })
      if (r?.state) state.value = r.state as VoiceState
      if (patch.ttsEnabled === false) stopSpeak()
      if (patch.asrEnabled === false && recording.value) stopRecording()
    } catch (e: any) {
      lastError.value = String(e?.message || e)
      console.error('[voice] 保存配置失败:', e)
    }
  }

  /* ── 安装 / 卸载（轮询进度） ── */
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function install(id: string): Promise<void> {
    if (busyId.value) return
    lastError.value = ''
    try {
      const r: any = await chatStore.bridgeRpc('voice.install', { id })
      if (!r?.ok) { lastError.value = String(r?.error || '启动安装失败'); return }
      busyId.value = id
      startPoll(r.jobId)
    } catch (e: any) {
      lastError.value = String(e?.message || e)
    }
  }

  async function remove(id: string): Promise<void> {
    if (busyId.value) return
    lastError.value = ''
    try {
      const r: any = await chatStore.bridgeRpc('voice.remove', { id })
      if (!r?.ok) { lastError.value = String(r?.error || '删除失败'); return }
      await refresh()
    } catch (e: any) {
      lastError.value = String(e?.message || e)
    }
  }

  function startPoll(jobId: string): void {
    stopPoll()
    const tick = async () => {
      try {
        const r: any = await chatStore.bridgeRpc('voice.job', { jobId })
        const j = r?.job as VoiceJob | null
        if (!j) return
        job.value = j
        if (j.status !== 'running') {
          stopPoll()
          busyId.value = ''
          if (j.status === 'error') lastError.value = j.error || '安装失败'
          await refresh()
        }
      } catch {
        /* 轮询失败下次再来 */
      }
    }
    void tick()
    pollTimer = setInterval(tick, 800)
  }

  function stopPoll(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  /* ── 音频播放（单例，同时只播一条） ── */
  let audioEl: HTMLAudioElement | null = null
  let audioUrl = ''
  /** 世代号：停止/切目标时自增，让还在飞的异步链自己退出 */
  let gen = 0

  function playWavBase64(b64: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const bin = atob(b64)
        const buf = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
        const blob = new Blob([buf], { type: 'audio/wav' })
        if (audioUrl) { try { URL.revokeObjectURL(audioUrl) } catch { /* ignore */ } }
        audioUrl = URL.createObjectURL(blob)
        if (!audioEl) audioEl = new Audio()
        audioEl.src = audioUrl
        audioEl.onended = () => resolve()
        audioEl.onerror = () => resolve()
        void audioEl.play().catch(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  function stopAudio(): void {
    try { audioEl?.pause() } catch { /* ignore */ }
    if (audioEl) audioEl.onended = null
  }

  /* ── 试听（设置页）：短句直接合成播放 ── */
  const PREVIEW_TEXT = '你好，我是 NIS。这就是当前音色的效果，你觉得怎么样？'
  const previewingId = ref('')
  async function preview(modelId: string, sid: number, speed: number, text?: string): Promise<void> {
    gen++
    const my = gen
    stopAudio()
    previewingId.value = modelId
    try {
      const r: any = await chatStore.bridgeRpc('voice.speak', { text: text || PREVIEW_TEXT, model: modelId, sid, speed }, 90000 /* ★0927：TTS 合成可能慢（模型加载），大超时 */)
      if (my !== gen) return
      if (!r?.ok) { lastError.value = String(r?.error || '试听失败'); return }
      await playWavBase64(r.audio)
    } catch (e: any) {
      lastError.value = String(e?.message || e)
    } finally {
      if (my === gen) previewingId.value = ''
    }
  }

  /* ── 朗读 AI 回复 ── */

  /** 分句：优先句末标点，其次按长度硬切；每片目标 ≤ max 字
   *  0920 实测：140 字 ≈ 19 秒音频、合成要 15 秒（机器忙时 RTF 会到 0.7+）→ 首声等太久。
   *  收到 80 字（≈11 秒音频）后首声能压到 4~8 秒，且后续句在播上一句时就合成好了。 */
  function splitForSpeech(text: string, max = 80): string[] {
    const clean = stripForSpeech(text)
    if (!clean) return []
    const parts: string[] = []
    const rough = clean.split(/(?<=[。！？!?；;…\n])/)
    let buf = ''
    for (const seg of rough) {
      const s = seg.trim()
      if (!s) continue
      if (s.length >= max) {
        if (buf) { parts.push(buf); buf = '' }
        for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max))
        continue
      }
      if ((buf + s).length > max) { parts.push(buf); buf = s } else buf += s
    }
    if (buf.trim()) parts.push(buf)
    return parts.filter((p) => p.trim())
  }

  /**
   * 朗读一段文本（AI 回复）。
   * @param key 唯一标识（同一 key 再点 = 停止）
   */
  async function speakText(key: string, text: string): Promise<void> {
    // 再点同一个 → 停
    if (speakingKey.value === key) { stopSpeak(); return }
    stopSpeak()
    if (!ttsReady.value) { lastError.value = '朗读未启用或模型未安装'; return }
    const chunks = splitForSpeech(text)
    if (!chunks.length) return
    gen++
    const my = gen
    speakingKey.value = key
    for (const c of chunks) {
      if (my !== gen) return
      try {
        const r: any = await chatStore.bridgeRpc('voice.speak', { text: c }, 90000 /* ★0927：TTS 合成可能慢（模型加载），大超时 */)
        if (my !== gen) return
        if (!r?.ok) { lastError.value = String(r?.error || '朗读失败'); break }
        await playWavBase64(r.audio)
      } catch (e: any) {
        lastError.value = String(e?.message || e)
        break
      }
    }
    if (my === gen) speakingKey.value = ''
  }

  function stopSpeak(): void {
    gen++
    speakingKey.value = ''
    previewingId.value = ''
    stopAudio()
  }

  /** 剥掉不念的内容：代码块 / 行内代码 / 图片 / 链接地址 / markdown 记号 / 表格线 */
  function stripForSpeech(text: string): string {
    let s = String(text || '')
    s = s.replace(/```[\s\S]*?```/g, ' （代码略） ')     // 围栏代码块
    s = s.replace(/`[^`\n]*`/g, ' ')                     // 行内代码
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // 图片
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // 链接留文字
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')            // HTML 标签
    s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')               // 表格行
    s = s.replace(/^\s*[-*+]\s+/gm, '')                  // 列表记号
    s = s.replace(/^\s*#{1,6}\s+/gm, '')                 // 标题记号
    s = s.replace(/[*_~>{}\[\]#]+/g, ' ')                // 残留装饰符
    s = s.replace(/https?:\/\/\S+/g, ' 链接 ')           // 裸 URL
    s = s.replace(/\s+/g, ' ').trim()
    return s
  }

  /* ── 语音输入（麦克风录音 → 识别） ── */
  let mediaStream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let processor: ScriptProcessorNode | null = null
  let chunks: Float32Array[] = []
  let captureRate = 16000

  async function startRecording(): Promise<boolean> {
    if (recording.value) return true
    lastError.value = ''
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      // 直接跟浏览器要 16k —— SenseVoice 就是 16k，省一次重采样（拿不到就用真实采样率，sherpa 自己会重采样）
      try {
        audioCtx = new AudioContext({ sampleRate: 16000 })
      } catch {
        audioCtx = new AudioContext()
      }
      captureRate = audioCtx.sampleRate
      const src = audioCtx.createMediaStreamSource(mediaStream)
      processor = audioCtx.createScriptProcessor(4096, 1, 1)
      chunks = []
      processor.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0)
        chunks.push(new Float32Array(d))
        let peak = 0
        for (let i = 0; i < d.length; i += 16) peak = Math.max(peak, Math.abs(d[i]))
        micLevel.value = Math.min(1, peak * 3.2)
      }
      src.connect(processor)
      processor.connect(audioCtx.destination)
      recording.value = true
      return true
    } catch (e: any) {
      lastError.value = '打不开麦克风：' + String(e?.message || e)
      cleanupRecorder()
      return false
    }
  }

  function cleanupRecorder(): void {
    try { processor?.disconnect() } catch { /* ignore */ }
    try { mediaStream?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    try { void audioCtx?.close() } catch { /* ignore */ }
    processor = null
    mediaStream = null
    audioCtx = null
    recording.value = false
    micLevel.value = 0
  }

  /** 停止录音并识别；返回识别文本（失败返回空串） */
  async function stopRecording(): Promise<string> {
    if (!recording.value) return ''
    const rate = captureRate
    const bufs = chunks
    cleanupRecorder()
    let total = 0
    for (const c of bufs) total += c.length
    if (total < rate * 0.25) { lastError.value = '录音太短了'; return '' }
    const all = new Float32Array(total)
    let o = 0
    for (const c of bufs) { all.set(c, o); o += c.length }
    // Float32 → Int16（base64 送后端，比 JSON 数组小一半）
    const pcm = new Int16Array(total)
    for (let i = 0; i < total; i++) {
      const v = Math.max(-1, Math.min(1, all[i]))
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    const bytes = new Uint8Array(pcm.buffer)
    let bin = ''
    const STEP = 0x8000
    for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + STEP)) as any)
    const b64 = btoa(bin)
    try {
      const r: any = await chatStore.bridgeRpc('voice.transcribe', { pcm: b64, sampleRate: rate }, 90000 /* ★0927：ASR 识别可能慢（模型加载），大超时 */)
      if (!r?.ok) { lastError.value = String(r?.error || '识别失败'); return '' }
      return String(r.text || '').trim()
    } catch (e: any) {
      lastError.value = String(e?.message || e)
      return ''
    }
  }

  return {
    state, loaded, job, busyId, speakingKey, recording, micLevel, lastError,
    ttsModel, ttsReady, asrReady, previewingId,
    refresh, ensureLoaded, set, install, remove,
    preview, speakText, stopSpeak, splitForSpeech,
    startRecording, stopRecording, cleanupRecorder,
  }
})
