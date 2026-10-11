import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { MODEL_PRICING } from '@/utils/modelPricing'
import type { ProviderModel } from '@/utils/modelPricing'
import { useChatStore } from '@/stores/chat'

import { useNotificationsStore } from '@/stores/notifications'
import { t } from '@/utils/i18n'
import { swallowed } from '@/utils/swallowed'

export interface ProviderItem {
  id: string
  name: string
  base: string
  enabled: boolean
  /** 供应商 logo（public/providers-logo/{id}.svg，真实 logo 可替换） */
  logo: string
  /** D2 供应商级网络代理（http/https）；空=直连。后端权威 */
  proxyUrl?: string
  /** 0910 协议：openai-completions（默认）/ anthropic-messages / google-generative-ai。后端权威 */
  protocol?: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
}

const LOGO = (id: string, ext: 'svg' | 'png' = 'svg') => `/providers-logo/${id}.${ext}`

export const DEFAULT_PROVIDERS: ProviderItem[] = [
  { id: 'deepseek', name: 'DeepSeek', base: 'api.deepseek.com', enabled: false, logo: LOGO('deepseek') },
  { id: 'openai', name: 'OpenAI', base: 'api.openai.com', enabled: false, logo: LOGO('openai') },
  { id: 'anthropic', name: 'Anthropic', base: 'api.anthropic.com', enabled: false, logo: LOGO('anthropic'), protocol: 'anthropic-messages' },
  { id: 'zhipu', name: '智谱 (GLM)', base: 'open.bigmodel.cn/api/paas/v4', enabled: false, logo: LOGO('zhipu', 'png') },
  { id: 'tongyi', name: '通义千问', base: 'dashscope.aliyuncs.com/compatible-mode/v1', enabled: false, logo: LOGO('tongyi') },
  { id: 'moonshot', name: '月之暗面', base: 'api.moonshot.cn/v1', enabled: false, logo: LOGO('moonshot') },
  { id: 'stepfun', name: '阶跃星辰', base: 'api.stepfun.com/v1', enabled: false, logo: LOGO('stepfun', 'png') },
  { id: 'minimax', name: 'MiniMax', base: 'api.minimax.chat/v1', enabled: false, logo: LOGO('minimax') },
  { id: 'deepbricks', name: '魔搭 (ModelScope)', base: 'dashscope.aliyuncs.com/compatible-mode/v1', enabled: false, logo: LOGO('deepbricks') },
  { id: 'together', name: 'Together AI', base: 'api.together.xyz/v1', enabled: false, logo: LOGO('together', 'png') },
  { id: 'grok', name: 'xAI (Grok)', base: 'api.x.ai/v1', enabled: false, logo: LOGO('grok', 'png') },
  { id: 'perplexity', name: 'Perplexity', base: 'api.perplexity.ai', enabled: false, logo: LOGO('perplexity') },
  { id: 'ollama', name: 'Ollama (本地)', base: '127.0.0.1:11434', enabled: false, logo: LOGO('ollama') },
  { id: 'openrouter', name: 'OpenRouter', base: 'openrouter.ai/api/v1', enabled: false, logo: LOGO('openrouter') },
  { id: 'google', name: 'Google (Gemini)', base: 'generativelanguage.googleapis.com/v1beta', enabled: false, logo: LOGO('google'), protocol: 'google-generative-ai' },
  { id: 'groq', name: 'Groq', base: 'api.groq.com/openai/v1', enabled: false, logo: LOGO('groq', 'png') },
  { id: 'mistral', name: 'Mistral AI', base: 'api.mistral.ai/v1', enabled: false, logo: LOGO('mistral', 'png') },
  { id: 'doubao', name: '豆包 (火山引擎)', base: 'ark.cn-beijing.volces.com/api/v3', enabled: false, logo: LOGO('doubao', 'png') },
  { id: 'hunyuan', name: '腾讯混元', base: 'hunyuan.tencentcloudapi.com', enabled: false, logo: LOGO('hunyuan', 'png') },
  { id: 'ernie', name: '百度文心', base: 'aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat', enabled: false, logo: LOGO('ernie', 'png') },
  { id: 'siliconflow', name: '硅基流动', base: 'api.siliconflow.cn/v1', enabled: false, logo: LOGO('siliconflow', 'png') },
  // 0917：Agnes 拆国际版 / 国内版（国际版沿用 id 'agnes'，老配置平滑继承）
  { id: 'agnes', name: 'Agnes AI (国际版)', base: 'apihub.agnes-ai.com/v1', enabled: false, logo: LOGO('agnes', 'png') },
  { id: 'agnes-cn', name: 'Agnes AI (国内版)', base: 'api.agnes-ai.cn/v1', enabled: false, logo: LOGO('agnes', 'png') },
  { id: 'longcat', name: 'LongCat', base: 'api.longcat.chat/openai', enabled: false, logo: LOGO('longcat', 'svg') },
  // 0925：OpenCode Zen 网关（opencode.ai/zen/v1，OpenAI 兼容）—— 精选模型网关，
  // 新用户有免费试用额度、免费模型（-free 后缀）按周轮换每日 20万~100万 token
  { id: 'opencode-zen', name: 'OpenCode Zen', base: 'opencode.ai/zen/v1', enabled: false, logo: LOGO('opencode-zen') },
  // ★1010（需求）：把这几家"用户自配"的收录为**出厂默认**（+ 配套出厂图标，见 public/providers-logo）：
  //   商汤日日新 / commandcode.ai / 阶跃星辰plan / xiaomi / AMD。
  //   ⚠️ id 一律**沿用用户现有配置的写法**（含中文 id '阶跃星辰plan'、大写 'AMD'）—— 改 id 会让已配的
  //   Key / 模型表对不上号、凭空"丢供应商"。logo 文件名则用 ASCII（stepfun-plan / commandcode-ai / amd），
  //   避开中文与点号在静态路径上的坑。
  //   ⚠️ 收录后它们算"内置"⇒ 头像不再显示「获取 logo」入口（出厂图标已随包）。
  { id: 'sensenova', name: '商汤日日新', base: 'token.sensenova.cn/v1', enabled: false, logo: LOGO('sensenova', 'png') },
  { id: 'commandcode.ai', name: 'commandcode.ai', base: 'api.commandcode.ai/provider/v1', enabled: false, logo: LOGO('commandcode-ai', 'png') },
  { id: '阶跃星辰plan', name: '阶跃星辰plan', base: 'api.stepfun.com/step_plan/v1', enabled: false, logo: LOGO('stepfun-plan', 'svg') },
  { id: 'xiaomi', name: 'xiaomi', base: 'api.xiaomimimo.com/v1', enabled: false, logo: LOGO('xiaomi', 'png') },
  { id: 'AMD', name: 'AMD', base: 'developer.amd.com.cn/radeon/api/v1', enabled: false, logo: LOGO('amd', 'png') },
]

/** 0918：判断是不是「内置供应商」（内置 = 出厂自带 public/providers-logo/<id>.* 图标）。
 *  为什么需要：以前用「logo 是否以 /providers-logo/ 开头」反推"内置"，
 *  但自定义供应商也被赋了同样的路径 → 被误判成内置，「获取 logo」按钮不出现、后端也拒绝抓。 */
const BUILTIN_IDS = new Set(DEFAULT_PROVIDERS.map((p) => p.id))
export function isBuiltinProvider(id: string): boolean {
  return BUILTIN_IDS.has(String(id || ''))
}
/** 内置供应商的默认图标路径；自定义供应商返回空串（交给 VendorLogo 走首字母兜底） */
function defaultLogoFor(id: string): string {
  return isBuiltinProvider(id) ? LOGO(id) : ''
}



/**
 * 供应商共享 store —— 设置弹窗与伙伴编辑页共用同一份数据。
 *
 * 每个供应商：logo + 基本信息 + 结构化模型表（价格/上下文/能力）。
 * 持久化到 localStorage（含 API Key，桌面本地应用）；
 * 后端接入后由 api_router/model_registry 读取同一配置。
 */
export const useProvidersStore = defineStore('providers', () => {
  const providers = ref<ProviderItem[]>(JSON.parse(JSON.stringify(DEFAULT_PROVIDERS)))
  // 模型表：默认空，只保留用户主动「获取模型→勾选保存」或手动添加的模型（不再自动填充价格表预设，
  // 避免硬刷新/填 key 后冒出未选择的一堆模型）
  const models = ref<Record<string, ProviderModel[]>>({})
  // 0917：不再默认 'longcat'（后端 providerActive 缺省也为空，避免 LongCat 接管未配置的请求）
  const providerActive = ref('')
  const apiKeys = ref<Record<string, string>>({})
  /** 用户显式关闭过的供应商 id 集合（localStorage 持久化）：
   *  syncFromBackend 不再救回这些供应商的 enabled——"前端权威"与"seeded false 救回"的分界 */
  const explicitlyDisabled = ref<Set<string>>(new Set())
  const modelDropdownOpen = ref(false)
  // 当前全局选中的模型 id（聊天输入框与创建项目弹窗共用，切换持久化）
  const activeModelId = ref('')
  /** 全局推理强度（2026-09-12 F轮）：**非对话**场景统一口径 —— 提炼/知识库/记忆/定时任务默认都用它。
   *  对话场景不读这个（聊天按会话各自选强度）；空串 = 未指定，由后端按模型默认挡位兜。 */
  const activeEffort = ref('')
  // 最多同时启用 12 个供应商（模型选择器只显示启用的，两排）
  const ENABLED_MAX = 12

  /* 0925（实测修复）：**本地显式选择的时间戳** —— syncFromBackend 在 WS 重连时
   * 会用后端值无条件覆盖 providerActive/activeModelId，而用户刚选的模型是**异步推送**
   * （syncModelToBackend）的 → 300ms 竞态窗内旧值盖掉新值，表现为：
   * "选了模型 b，发出去却用模型 a，选择器也显示回 a"。
   * 保护窗内（10s）syncFromBackend 不覆盖这两个字段，以用户本地显式选择为准。 */
  let lastLocalModelPickAt = 0
  const LOCAL_PICK_FRESH_MS = 10_000

  /* 0917（产品要求确认）：**前端不做任何兜底** —— 后端 providerActive 是唯一权威。
   * 后端自己在 providerActive 为空时会回落到「第一个已启用且有 key」的供应商（providers.ts 的
   * activeProvider()），前端再造一条「未启用→第一个 enabled→按 id→providers[0]」的回落链，
   * 只会让界面显示的供应商和后端真正调用的不一致（这正是之前「显示 agnes、实际走 LongCat」的成因）。
   * 所以：前端只做精确匹配，匹配不到就是 undefined，由调用处显式处理。 */
  const activeProvider = computed(() => providers.value.find(p => p.id === providerActive.value))

  // 已启用供应商（模型选择器显示用）
  const enabledProviders = computed(() => providers.value.filter(p => p.enabled))

  /** 供应商是否「可用」：有 API Key，或本地服务（ollama 等）——模型选择器据此过滤，避免选了发不出去 */
  function isProviderReady(id: string): boolean {
    const p = providers.value.find(x => x.id === id)
    if (!p || !p.enabled) return false
    if (apiKeys.value[id]) return true
    /* ★1003 批次4 4.55：原来强制 `https?://` 前缀 —— Ollama 等本地供应商默认 base 是
     * `127.0.0.1:11434`（无协议头）⇒ 永远不就绪、模型被选择器过滤（与注释意图相反）。
     * 协议头可选。 */
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(String(p.base || '').trim())
  }

  // 排序列表：已启用的排前面（各自保持原相对顺序），未启用的在后
  const sortedProviders = computed(() => {
    const on = providers.value.filter(p => p.enabled)
    const off = providers.value.filter(p => !p.enabled)
    return [...on, ...off]
  })

  // 当前供应商的 API Key（v-model 兼容，按供应商分开存）
  const apiKey = computed<string>({
    get: () => apiKeys.value[providerActive.value] || '',
    set: (v: string) => {
      apiKeys.value[providerActive.value] = v
      persist()
      // 填/改 key → 立即同步到后端（后端 has_key 才能正常调模型）
      const chatStore = useChatStore()
      chatStore.bridgeRpc('providers.setKey', { providerId: providerActive.value, apiKey: v })
        .catch((e: any) => console.error('[Providers] setKey failed:', e))
    },
  })

  /** ★1010：按 id 写 Key —— 设置弹窗的编辑目标由"你展开的那家"决定，不再借用 providerActive。
      与上面 apiKey setter 同口径（本地镜像 + push 后端），避免"A 卡片里填的 Key 落进 B 家"。 */
  function setApiKeyFor(providerId: string, value: string) {
    if (!providerId) return
    apiKeys.value[providerId] = value
    persist()
    const chatStore = useChatStore()
    chatStore.bridgeRpc('providers.setKey', { providerId, apiKey: value })
      .catch((e) => swallowed('API Key 未同步到后端（本地已填、后端未落盘）', e))
  }

  /** 某供应商下的模型 id 列表（伙伴编辑页下拉用） */
  function modelIds(providerId: string): string[] {
    return (models.value[providerId] || []).filter(m => m.enabled).map(m => m.id)
  }

  /** 某模型的类型：text / image / video / audio（0907：显式三轴 outputModalities 优先，其次 capabilities + 模型名关键词） */
  function modelType(providerId: string, modelId: string): 'text' | 'image' | 'video' | 'audio' {
    const mm = models.value[providerId]?.find(m => m.id === modelId)
    // 用户在获取弹窗勾过输出 → 权威判定（不含 text 即非聊天模型）
    if (mm?.outputModalities?.length && !mm.outputModalities.includes('text')) {
      if (mm.outputModalities.includes('video')) return 'video'
      if (mm.outputModalities.includes('audio')) return 'audio'
      return 'image'
    }
    const caps = mm?.capabilities || []
    if (caps.includes('audio') || /tts|whisper|audio|voice|speech|cosyvoice|suno|elevenlabs/i.test(modelId)) return 'audio'
    if (caps.includes('video') || /video|kling|runway|sora|veo|pika|luma/i.test(modelId)) return 'video'
    // 纯生图模型：capabilities 含 image 但无 text；或模型名带生图关键词
    if (mm) {
      const isImageOnly = caps.includes('image') && !caps.includes('text')
      if (isImageOnly) return 'image'
    }
    if (/^(gpt-image|dall-e|dall|flux|stable-diffusion|sdxl|midjourney|agnes-image|imagen)/i.test(modelId)) return 'image'
    return 'text'
  }

  /** 是否多模态模型（text + image）：用于模型列表徽标与能力展示
   *  0907 供应商C段：显式三轴字段（用户在获取弹窗勾选落库）优先于 capabilities 推断 */
  function isMultimodal(providerId: string, modelId: string): boolean {
    const mm = models.value[providerId]?.find(m => m.id === modelId)
    if (mm?.inputModalities) return mm.inputModalities.includes('image')
    if (mm?.supports && typeof mm.supports.vision === 'boolean') return mm.supports.vision
    const caps = mm?.capabilities || []
    return caps.includes('text') && caps.includes('image')
  }

  /* ── 0910 推理挡位按模型声明（与后端 resolveModelEfforts/clampEffort 同一份语义）──
   * 优先级：显式 efforts（✎ 面板勾过=权威）> 非推理模型=[]（强度入口整个隐藏）>
   * zai 系（bigmodel.cn/api.z.ai 探针实锤 medium 400，但支持 max）> 其余**三挡**。
   * 后端发送时还会再钳一次（clampEffort），两处永远一致。
   * ⚠️ 0920 修正：以前默认给四挡（含 burning），但 OpenAI 兼容协议只有 low/medium/high
   *    三个值 → burning 与 heavy 在发送侧被映射成同一个 high，**看起来能选、实际无差别**
   *    （反馈"思考强度不精准"）。现在默认三挡，只有明确支持 `max` 的 zai 系才出 burning。 */
  const EFFORT_ALL = ['fast', 'deep', 'heavy', 'burning']
  const EFFORT_STD = ['fast', 'deep', 'heavy']
  function modelEfforts(providerId: string, modelId: string): string[] {
    const mm = models.value[providerId]?.find(m => m.id === modelId)
    if (mm?.efforts?.length) return EFFORT_ALL.filter(e => mm.efforts!.includes(e))
    const caps = mm?.capabilities || []
    const isReasoning = mm?.supports && typeof mm.supports.reasoning === 'boolean'
      ? mm.supports.reasoning
      : caps.includes('reasoning') || /(reasoner|o3|o4|r1|k2|think|thinking|z1|glm-z1|deepseek-reasoner|glm-5|glm-4\.7|glm-4-plus|step-2|kimi-k|qwq|moonshot-reasoner|claude-sonnet-4|claude-opus-4)/i.test(modelId || '')
    if (!isReasoning) return []
    const base = providers.value.find(p => p.id === providerId)?.base || ''
    if (/bigmodel\.cn|api\.z\.ai/i.test(base)) return ['fast', 'heavy', 'burning']
    return [...EFFORT_STD]
  }
  /** 把挡位钳到该模型可用清单：不在表内→索引距离最近（平距取更重挡）；清单空→null */
  function clampEffortFor(providerId: string, modelId: string, effort: string | null | undefined): string | null {
    const allowed = modelEfforts(providerId, modelId)
    if (!allowed.length) return null
    const want = EFFORT_ALL.includes(effort || '') ? (effort as string) : 'deep'
    if (allowed.includes(want)) return want
    const wi = EFFORT_ALL.indexOf(want)
    let best = allowed[0], bestD = 99
    for (const a of allowed) {
      const d = Math.abs(EFFORT_ALL.indexOf(a) - wi)
      if (d < bestD || (d === bestD && EFFORT_ALL.indexOf(a) > EFFORT_ALL.indexOf(best))) { best = a; bestD = d }
    }
    return best
  }

  /** #6 能力自动识别：按模型名 + OpenRouter 架构信息推断（不用每个模型手动配置） */
  function autoDetectCaps(modelId: string, modality?: string): string[] {
    const low = (modelId || '').toLowerCase()
    const m = (modality || '').toLowerCase()
    // 纯生图
    if (/^(gpt-image|dall-e|dall|flux|stable-diffusion|sdxl|midjourney|imagen|agnes-image)/.test(low)) return ['image']
    // 纯视频
    if (/(kling|runway|sora|veo|pika|luma|hailuo|seedance|wan-|video|vidu|gen-3|ray2|minimax-video)/.test(low)) return ['video']
    // 纯音频/语音
    if (/(tts|whisper|audio|voice|speech|cosyvoice|fish-|suno|elevenlabs|talk|sound|paraformer|speech-)/.test(low)) return ['audio']
    // 文本起步
    const caps: string[] = ['text']
    if (m.includes('image') || /(mimo|vl|vision|omni|multimodal|gpt-4o|gpt-4\.1|gpt-5|grok|gemini|claude-3|claude-sonnet|claude-opus|glm-4v|glm-4\.\d+v|glm-5v|qwen-vl|qwen2?-vl|hunyuan-turbo|hunyuan-vision|ernie-4|step-1v|step-2v|kimi-vl|deepseek-vl|mini-cpm-v|llava|yi-vl|internvl|phi-4-multimodal|molmo|paligemma|qwen2-vl|seed-vl)/.test(low)) caps.push('image')
    if (m.includes('reasoning') || /(reasoner|o3|o4|r1|k2|think|thinking|z1|glm-z1|deepseek-reasoner|glm-5|glm-4\.7|glm-4-plus|step-2|kimi-k|qwq|moonshot-reasoner|claude-sonnet-4|claude-opus-4)/.test(low)) caps.push('reasoning')
    return caps
  }

  function modelName(providerId: string, modelId: string): string {
    return models.value[providerId]?.find(m => m.id === modelId)?.name || modelId
  }

  /** 当前全局模型 id（**唯一口径**：属于当前供应商且启用才有效；否则空 = 未选择）。
   *  2026-09-12 用户拍板：**去掉「回退当前供应商第一个启用模型」的静默兜底** ——
   *  未选择就返回空，由调用方按「未选全局模型」明确报错 + 引导去设置里选。 */
  const currentModelId = computed<string>({
    get: () => {
      // 当前供应商未就绪（无 key 且非本地）时不返回模型，避免选中后发不出去
      if (!isProviderReady(providerActive.value)) return ''
      const activeModels = (models.value[providerActive.value] || []).filter(m => m.enabled)
      if (activeModelId.value && activeModels.some(m => m.id === activeModelId.value)) {
        return activeModelId.value
      }
      return ''
    },
    set: (v: string) => {
      lastLocalModelPickAt = Date.now() // 0925：用户显式选择 → 保护窗起点
      activeModelId.value = v
      persist()
      syncModelToBackend()
    },
  })

  /** 从后端拉取供应商真实状态（providers.list：base/启用/有无key/后端模型表/真实key），
   *  与本地 localStorage 合并——后端权威覆盖基本信息，前端保留模型/Key 本地数据。
   *  后端返回真实 apiKey 用于回填（本地 localStorage 丢失/清空后仍能恢复显示，修复"重开页面 key 显示空"） */
  async function syncFromBackend() {
    const chatStore = useChatStore()
    try {
      const st = await chatStore.bridgeRpc('providers.list')
      if (!st?.providers || !Array.isArray(st.providers)) return
      for (const rp of st.providers) {
        const local = providers.value.find(p => p.id === rp.id)
        if (local) {
          if (rp.base) local.base = rp.base
          // 启用状态：后端为权威，无条件镜像（0902-2 用户拍板：去掉 localStorage 兜底/救回逻辑——
          // 兜底会遮盖问题）。用户显式开关走 toggleProviderEnabled → providers.toggle 同步后端，
          // 后端持久化；刷新/重启后 providers.list 就是唯一事实源。
          // explicitlyDisabled 集合退役（仍读旧数据兼容，不再参与判定）
          local.enabled = rp.enabled !== false
          if (rp.logo) local.logo = rp.logo
          // 0918 修正历史脏值：自定义供应商曾被写成 /providers-logo/<id>.svg（文件并不存在），
          // 会被"已内置"的旧判定命中 → 清掉，让它回到首字母兜底、并恢复「获取 logo」
          if (!isBuiltinProvider(rp.id) && String(local.logo || '').startsWith('/providers-logo/')) local.logo = ''
          local.proxyUrl = rp.proxyUrl || ''
          // 0910：协议镜像（后端权威，默认 openai-completions）
          local.protocol = rp.protocol || 'openai-completions'
        } else {
          providers.value.push({
            id: rp.id,
            name: rp.name || rp.id,
            base: rp.base || '',
            enabled: rp.enabled !== false,
            logo: rp.logo || defaultLogoFor(rp.id),
            proxyUrl: rp.proxyUrl || '',
            protocol: rp.protocol || 'openai-completions',
          })
        }
        // 后端真实 key 回填（后端权威；本地为空时才覆盖，避免覆盖用户本地新输入）
        if (rp.apiKey && !apiKeys.value[rp.id]) {
          apiKeys.value[rp.id] = rp.apiKey
        }
        // 后端模型表：后端 providers.json 是权威持久化源。
        // ① 本地为空（换浏览器/清缓存/首次启动）→ 整表回填（0909③：以前只合并"本地已有"，
        //    导致新浏览器里获取过的模型列表全丢，必须重新获取）。
        // ② 本地非空 → 只更新已有模型的能力/价格，不新增（避免把后端镜像的旧预设灌回）。
        if (Array.isArray(rp.models) && rp.models.length > 0) {
          const localModels = models.value[rp.id] || []
          if (localModels.length === 0) {
            models.value[rp.id] = rp.models.map((bm: ProviderModel) => ({ ...bm }))
          } else {
          for (const bm of rp.models) {
            const local = localModels.find(x => x.id === bm.id)
            if (local) {
              if (bm.inputPrice) local.inputPrice = bm.inputPrice
              if (bm.outputPrice) local.outputPrice = bm.outputPrice
              if (bm.maxContext) local.maxContext = bm.maxContext
              if (Array.isArray(bm.capabilities) && bm.capabilities.length) {
                local.capabilities = [...new Set([...(local.capabilities || []), ...bm.capabilities])]
              }
            }
          }
          }
        }
      }
      /* 0925：保护窗内（用户 10s 内刚显式选过模型/供应商）不覆盖这两个字段 ——
       * 用户刚选的模型是异步推送的，WS 重连的 syncFromBackend 若在此窗口内用后端旧值
       * 覆盖，就会出现"选了 b 却发 a / 显示也回退 a"（实测）。其余字段照常镜像。 */
      const localPickFresh = Date.now() - lastLocalModelPickAt < LOCAL_PICK_FRESH_MS
      if (st.providerActive && !localPickFresh) providerActive.value = st.providerActive
      if (st.activeModelId && !localPickFresh) activeModelId.value = st.activeModelId
      /* 0925 自愈兜底：即使覆盖了（保护窗外），若 activeModelId 不属于拉回的 providerActive
       * （两字段跨窗口不同步的脏态）→ 按 activeModelId 反查归属供应商修正，
       * 保证 currentModelId getter 不会因"模型不在当前供应商表里"而静默返回空。 */
      if (!localPickFresh && activeModelId.value) {
        const owner = providers.value.find(p =>
          p.enabled && (models.value[p.id] || []).some(m => m.id === activeModelId.value && m.enabled))
        if (owner && owner.id !== providerActive.value) providerActive.value = owner.id
      }
      // F轮：全局推理强度镜像（后端权威，空串=未指定）
      if (typeof st.activeEffort === 'string') activeEffort.value = st.activeEffort
      /* ★1012t：后台模型镜像（后端权威；空串=未配置 —— 后端不再回落，会明确报错+提醒）。不走保护窗 ——
         它是**独立字段**，跟"用户刚选的聊天模型"不冲突，直接镜像即可。 */
      if (typeof (st as any).backgroundProviderId === 'string') backgroundProviderId.value = (st as any).backgroundProviderId
      if (typeof (st as any).backgroundModelId === 'string') backgroundModelId.value = (st as any).backgroundModelId
      if (typeof (st as any).backgroundEffort === 'string') backgroundEffort.value = (st as any).backgroundEffort
      persist()
      // ★1013e：后台模型没配 → 挂一条常驻通知（配好后自动消失）
      syncBackgroundModelNotice()
    } catch (e: any) {
      console.error('[Providers] syncFromBackend failed:', e)
    }
  }

  /** ★1013e（已定案："后台模型为空的时候，系统通知常驻一个不可以关的通知"）：
   *  后台模型没配 → 铃铛面板挂一条**常驻**通知（没有关闭按钮、"清空"也清不掉）；配好了自动移除。
   *  为什么较真：后台模型是必配项（知识/记忆提炼 + QQ/微信渠道 + 定时任务都靠它），留空 =
   *  那些"对话之外"的活全会失败 —— 与其等用户自己想起来，不如给一条抹不掉的提醒。
   *  去重靠 key（同一件事只留一条，重复评估只刷新内容）；跨刷新靠 system 通知自身的 localStorage 持久化。 */
  function syncBackgroundModelNotice(): void {
    void import('@/stores/notifications').then((m) => {
      const ns = m.useNotificationsStore()
      const missing = !backgroundProviderId.value || !backgroundModelId.value
      if (missing) {
        ns.pushSystem({
          key: 'background-model-missing',
          sticky: true,
          title: t('notice.bgModelMissingTitle'),
          message: t('notice.bgModelMissingMsg'),
          level: 'warning',
          category: 'error',
          silent: true,
        })
      } else {
        ns.removeSystemByKey('background-model-missing')
      }
    }).catch(() => { /* 通知失败不影响设置读写 */ })
  }

  /** 选模型 → 同步后端（providers.setModel：让后端用真实 LLM 调这个模型） */
  async function syncModelToBackend() {
    const chatStore = useChatStore()
    // 0917：**不再前端挑供应商**（旧行为：当前项被停用时回退「第一个启用且有 key」的）。
    // 就用用户明确选的那一个；它不可用时后端自己会按同一规则裁决 —— 前端替它做决定
    // 只会造成「界面显示 A、实际调用 B」。不匹配就跳过同步（下面会 return）。
    const pid = providerActive.value
    // 模型必须属于当前供应商；否则**不再静默回退第一个模型**（2026-09-12）——
    // 直接放弃同步，由调用方按「未选全局模型」报错。避免"显示 A、实际发 B"。
    const pidModels = (models.value[pid] || []).filter(m => m.enabled)
    const modelId = currentModelId.value
    if (!modelId) {
      // 全局模型确实没选（不是"还没就绪"）→ 后端会走它自己的全局值，这里无需推。
      return
    }
    if (!pidModels.some(m => m.id === modelId)) {
      console.warn(`[providers] 全局模型「${modelId}」不属于供应商 ${pid}（可能模型表尚未拉回），本次跳过 SET_MODEL`)
      return
    }
    const provider = providers.value.find(p => p.id === pid)
    const key = apiKeys.value[pid]
    if (!modelId || !provider) return
    // 纯图像/视频模型不能当聊天模型（会调错端点）；聊天模型必须是含 text 能力的
    const t = modelType(pid, modelId)
    if (t !== 'text') {
      console.warn(`[providers] ${modelId} 是${t === 'image' ? '图像' : '视频'}模型，不能作为聊天模型，跳过 SET_MODEL`)
      return
    }
    try {
      // 先确保后端有该供应商（含 base）与模型表——后端默认表可能没有（如 moonshot/kimi），
      // 否则 setActiveModel 找不到供应商而静默失败，回复永远用默认模型（longcat）
      const base = provider.base.includes('://') ? provider.base : `https://${provider.base}`
      await chatStore.bridgeRpc('providers.add', { id: pid, name: provider.name, base, protocol: provider.protocol })
      await chatStore.bridgeRpc('providers.setModels', { providerId: pid, models: models.value[pid] || [] })
      if (key) {
        await chatStore.bridgeRpc('providers.setKey', { providerId: pid, apiKey: key })
      }
      await chatStore.bridgeRpc('providers.setModel', { providerId: pid, modelId, effort: clampedGlobalEffort() })
    } catch (e: any) {
      console.error('[Providers] setModel failed:', e)
    }
  }

  /** F轮：全局推理强度同步到后端（providers.setEffort）。与模型分开推 —— 强度独立于模型切换，
   *  改强度不该触发 SET_MODEL 副作用（切模型会重置后端会话绑定）。 */
  async function syncEffortToBackend() {
    const chatStore = useChatStore()
    try {
      await chatStore.bridgeRpc('providers.setEffort', { effort: clampedGlobalEffort() })
    } catch (e: any) {
      console.error('[Providers] setEffort failed:', e)
    }
  }

  /** 全局强度钳到当前全局模型可用挡位：模型不支持思考 → 空串（后端视为未指定） */
  function clampedGlobalEffort(): string {
    const mid = currentModelId.value
    if (!mid) return ''
    return clampEffortFor(providerActive.value, mid, activeEffort.value) || ''
  }

  /** 设置全局推理强度（非对话场景统一口径）；传 null/'' 表示清空（跟随模型默认） */
  function setActiveEffort(v: string | null) {
    activeEffort.value = v ? String(v) : ''
    persist()
    void syncEffortToBackend()
  }

  /** 0908 二批条1：发送口径=模型选择器显示口径（主界面 ChatInterface 与悬浮窗 dock 共用）。
   *  ① 会话有显式覆盖（用户点选）→ 用它；
   *  ② 无覆盖但选择器因 currentModelId getter 兜底显示了某模型 → 发送前先把该供应商 add/models/key
   *    推到后端（幂等 ensure），再随 payload 带上——旧实现此时 payload=undefined → 后端静默用全局
   *    旧模型，就是"显示 b、实际回 a"的脱节本体。
   *  后端配套（0908）：供应商未注册自动注册、缺 Key 明确报错，不存在"悄悄用旧模型"。 */
  async function modelForSend(convId: string): Promise<{ provider: string; model_id: string; base: string } | undefined> {
    const cm = getConvModel(convId)
    if (cm?.model_id) return { provider: cm.provider, model_id: cm.model_id, base: cm.base }
    const mid = currentModelId.value
    if (!mid) return undefined
    /* ★1012n：**这里原来会 `await syncModelToBackend()`** —— 即"发一条消息"就顺手把**本窗口**的全局模型
       推给后端。这就是全局模型"自己变回去"的真凶：多窗口 / 长期开着的标签页里 store 还是旧值（例如
       deepseek），它一发消息就把旧值推上去，覆盖掉用户刚在设置里选的模型（后端 providers.json 被改写
       ⇒ 设置页那栏显示回旧值、还会启动时 setModel 回去）。实测：用户切到 agnes 后，另一窗口一发消息
       就把它顶回 deepseek。
       ⇒ 全局模型是**设置**，只应由"用户主动切换"（selectModel/selectProvider → syncModelToBackend）改写，
       不该由"发消息"这种高频动作触发。
       0908 原本的诉求（供应商/模型未注册时 ensure 一下）后端已兜底：未注册自动注册、缺 Key 明确报错，
       发送路径不需要前端推。 */
    const pid = providerActive.value
    const p = providers.value.find(x => x.id === pid)
    if (!p) return undefined
    const raw = p.base || ''
    return { provider: pid, model_id: mid, base: raw.includes('://') ? raw : `https://${raw}` }
  }

  function selectProvider(id: string) {
    lastLocalModelPickAt = Date.now() // 0925：用户显式选择 → 保护窗起点
    providerActive.value = id
    modelDropdownOpen.value = false
    persist()
  }

  /** 切换启用状态；最多同时启用 12 个，超限时返回 false。
   *  显式开关即时同步后端（providers.toggle 持久化）——后端是权威（0902-2），
   *  刷新后 syncFromBackend 直接镜像，无需本地 explicitlyDisabled 救回逻辑 */
  function toggleProviderEnabled(id: string): boolean {
    const p = providers.value.find(x => x.id === id)
    if (!p) return false
    if (p.enabled) {
      const wasActive = providerActive.value === id
      p.enabled = false
      explicitlyDisabled.value.add(id)
      persist()
      useChatStore().bridgeRpc('providers.toggle', { providerId: id, enabled: false })
        .then(async () => {
          // 0913：禁用「当前激活供应商」时后端会自愈换供应商 + 全局模型（否则调用必失败）——
          // 这里主动拉回后端权威值并提示，避免「我切了 A 怎么自己变成 B」的黑箱观感
          if (wasActive) {
            await syncFromBackend()
            useNotificationsStore().push({
              level: 'warning',
              content: t('providers.disabledActiveSwitched', {
                p: providerActive.value || '—',
                m: currentModelId.value || '—',
              }),
            })
          }
        })
        .catch((e) => swallowed('停用供应商未同步到后端（本地已停用、后端仍启用）', e))
      return true
    }
    if (providers.value.filter(x => x.enabled).length >= ENABLED_MAX) return false
    p.enabled = true
    explicitlyDisabled.value.delete(id)
    persist()
    useChatStore().bridgeRpc('providers.toggle', { providerId: id, enabled: true })
      .catch((e) => swallowed('启用供应商未同步到后端（本地已启用、后端仍禁用：发消息会用不了）', e))
    return true
  }

  /** 修改供应商 Base URL（按文档填写完整 URL，保留协议与路径；仅去掉末尾斜杠）。
   *  0910 修复：输入期只改本地镜像，失焦由 saveProviderBase 落后端——旧版从不发
   *  providers.setBase RPC，后端 providers.json 永远停在旧 base，测试连接/发消息
   *  读的都是后端那份 =「前端改了 URL 不生效、必须重启也没用」的真根因。 */
  function setProviderBase(id: string, base: string) {
    const p = providers.value.find(x => x.id === id)
    if (p) {
      p.base = base.trim().replace(/\/+$/, '')
      persist()
    }
  }

  /** 保存 Base URL 到后端（providers.setBase，后端权威持久化） */
  async function saveProviderBase(id: string) {
    const p = providers.value.find(x => x.id === id)
    if (!p) return
    try { await useChatStore().bridgeRpc('providers.setBase', { providerId: id, base: p.base || '' }) }
    catch (e: any) { console.error('[providers] saveProviderBase failed:', id, e?.message || e) }
  }

  /** 0910 协议选择：改本地镜像 + 落后端 providers.setProtocol（后端权威；影响请求走哪套适配器） */
  function setProviderProtocol(id: string, protocol: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai') {
    const p = providers.value.find(x => x.id === id)
    if (!p) return
    p.protocol = protocol
    persist()
    useChatStore().bridgeRpc('providers.setProtocol', { providerId: id, protocol })
      .catch((e: any) => console.error('[providers] setProtocol failed:', id, e?.message || e))
  }

  /** D2 供应商级代理：输入期只更新本地镜像，失焦再 saveProviderProxy 落后端（避免逐字符 RPC） */
  function setProviderProxyLocal(id: string, url: string) {
    const p = providers.value.find(x => x.id === id)
    if (p) p.proxyUrl = url
  }

  /** 0917 供应商头像：后端抓取后已落库（providers.setLogo 由 fetchLogo 内部完成），
   *  这里只做本地镜像。传空串 = 恢复自带图标。 */
  function setProviderLogo(id: string, logo: string) {
    const p = providers.value.find(x => x.id === id)
    if (p) p.logo = logo || defaultLogoFor(id)
  }

  /** D2 供应商级代理：保存到后端（providers.setProxy，后端权威），本地同步镜像 */
  async function saveProviderProxy(id: string, url: string) {
    const p = providers.value.find(x => x.id === id)
    const v = (url || '').trim()
    if (p) p.proxyUrl = v
    try { await useChatStore().bridgeRpc('providers.setProxy', { providerId: id, proxyUrl: v }) }
    catch (e) { swallowed('供应商代理未同步到后端（本地已改、后端未生效：重启后回落旧值）', e) }
  }

  function toggleModelEnabled(providerId: string, modelId: string) {
    const list = models.value[providerId]
    const mm = list?.find(x => x.id === modelId)
    if (mm) {
      mm.enabled = !mm.enabled
      persist()
      pushProviderModels(providerId)
    }
  }

  function removeModel(providerId: string, modelId: string) {
    models.value[providerId] = (models.value[providerId] || []).filter(x => x.id !== modelId)
    persist()
    pushProviderModels(providerId)
  }

  /** 0910：把该供应商模型表整表推到后端 providers.json（启用/挡位/删除等本地变更的持久化通道，
   *  与 updateModel 同步口径一致；base 缺失时跳过，新浏览器 syncFromBackend 整表回填依赖这份落库）。 */
  async function pushProviderModels(providerId: string) {
    const p = providers.value.find(x => x.id === providerId)
    const raw = p?.base || ''
    const base = raw.includes('://') ? raw : raw ? `https://${raw}` : ''
    if (!p || !base) return
    const chatStore = useChatStore()
    try {
      await chatStore.bridgeRpc('providers.add', { id: providerId, name: p.name, base, protocol: p.protocol })
      await chatStore.bridgeRpc('providers.setModels', { providerId, models: models.value[providerId] || [] })
    } catch (e: any) {
      console.error('[providers] pushProviderModels failed:', providerId, e?.message || e)
    }
  }

  /** 添加自定义模型 */
  function addModel(providerId: string, model: ProviderModel) {
    const list = models.value[providerId] || []
    if (!list.some(x => x.id === model.id)) {
      list.push(model)
      persist()
      pushProviderModels(providerId)
    }
  }

  /** 0909 ③：编辑已入库模型（上下文裸数字/模态勾选）。改完同步后端 providers.setModels
   *  （压缩阈值 resolveContextWindow 与能力闸门读的都是后端 providers.json，只改前端=不生效） */
  function updateModel(providerId: string, modelId: string, patch: Partial<ProviderModel>) {
    const list = models.value[providerId]
    const mm = list?.find(x => x.id === modelId)
    if (!mm) return
    Object.assign(mm, patch)
    persist()
    try {
      const chatStore = useChatStore()
      const provider = providers.value.find(p => p.id === providerId)
      const base = provider?.base?.includes('://') ? provider.base : provider?.base ? `https://${provider.base}` : ''
      if (base) {
        // ★1005：与紧邻的 setModels 保持一致 —— 原来这里静默、那条有日志，属于"兄弟写法不一致"的典型兜底
        chatStore.bridgeRpc('providers.add', { id: providerId, name: provider?.name || providerId, base })
          .catch((e) => swallowed('模型编辑后新增供应商未同步到后端（本地有、后端无）', e))
        chatStore.bridgeRpc('providers.setModels', { providerId, models: list || [] }).catch((e: any) => console.error('[providers] 模型编辑同步后端失败:', e?.message || e))
      }
    } catch (e) { swallowed('模型编辑同步后端失败（本地已生效、后端未落盘）', e) }
  }

  /** 同步价格：用内置价格表重置当前供应商模型（缺的补回，已有的更新价格） */
  function syncPrices(providerId?: string) {
    const targets = providerId ? [providerId] : providers.value.map(p => p.id)
    for (const pid of targets) {
      const defs = MODEL_PRICING[pid]
      if (!defs) continue
      const cur = models.value[pid] || []
      const merged = defs.map(def => {
        const existing = cur.find(c => c.id === def.id)
        return existing
          ? { ...def, enabled: existing.enabled, id: def.id }
          : { ...def }
      })
      // 保留用户自定义的额外模型（不在内置表里的）
      for (const c of cur) {
        if (!defs.some(d => d.id === c.id)) merged.push(c)
      }
      models.value[pid] = merged
    }
    persist()
  }

  /**
   * 拉取真实模型 + 价格（异步）：
   *   1. bridge 后端代理 /v1/models（需 API Key，绕浏览器 CORS）
   *   2. OpenRouter /api/v1/models（公开）→ 价格/上下文
   *   3. 本地内置表兜底
   * 返回结果信息供 UI 反馈。
   */
  async function fetchModels(providerId: string): Promise<{ ok: boolean; added: number; updated: number; msg: string }> {
    const pid = providerId
    const apiKey = apiKeys.value[pid]
    const provider = providers.value.find(x => x.id === pid)

    // 后端已连接：走 bridge 代理拉取（绕开浏览器 CORS）
    const chatStore = useChatStore()
    if (chatStore.wsConnected && provider?.base) {
      try {
        if (apiKey) {
          await chatStore.bridgeRpc('providers.setKey', { providerId: pid, apiKey })
        }
        const result = await chatStore.bridgeRpc('providers.fetchModels', { providerId: pid })
        const modelIds: string[] = Array.isArray(result.models) ? result.models : []
        if (result.ok && modelIds.length) {
          mergeFetchedModels(pid, modelIds)
          return { ok: true, added: modelIds.length, updated: 0, msg: String(result.msg || '') }
        }
        return { ok: false, added: 0, updated: 0, msg: String(result.msg || '获取失败') }
      } catch (e: any) {
        return { ok: false, added: 0, updated: 0, msg: `后端代理失败：${e?.message || e}` }
      }
    }

    let providerIds: string[] | null = null
    let providerErr = ''

    // 1) 供应商 /v1/models
    if (apiKey && provider?.base) {
      try {
        const base = provider.base.includes('://') ? provider.base : `https://${provider.base}`
        const baseRoot = base.replace(/\/+$/, '')
        const modelsUrl = baseRoot.endsWith('/v1') ? `${baseRoot}/models` : `${baseRoot}/v1/models`
        const res = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (res.ok) {
          const j = await res.json()
          providerIds = (j.data || []).map((m: any) => String(m.id || '')).filter(Boolean)
        } else {
          providerErr = `供应商 ${res.status}`
        }
      } catch {
        providerErr = '供应商不可达'
      }
    } else if (!apiKey) {
      providerErr = '未填 API Key'
    }

    // 2) OpenRouter 价格表（公开）：按供应商 id 或厂商别名匹配
    const OR_PREFIX_ALIAS: Record<string, string> = {
      longcat: 'meituan',
      deepseek: 'deepseek',
      openai: 'openai',
      anthropic: 'anthropic',
      google: 'google',
      mistral: 'mistral',
      groq: 'groq',
      zhipu: 'zhipu',
      qwen: 'qwen',
      moonshot: 'moonshot',
      minimax: 'minimax',
    }
    const orPrefix = OR_PREFIX_ALIAS[pid] || pid
    const orMap: Record<string, { input: number; output: number; ctx: number; modality?: string }> = {}
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models')
      if (res.ok) {
        const j = await res.json()
        for (const m of (j.data || []) as any[]) {
          const slug = String(m.id || '')
          if (slug.startsWith(orPrefix + '/')) {
            const localId = slug.slice(orPrefix.length + 1)
            orMap[localId.toLowerCase().replace(/[_\s]+/g, '-')] = {
              input: (Number(m.pricing?.prompt) || 0) * 1e6,
              output: (Number(m.pricing?.completion) || 0) * 1e6,
              ctx: Number(m.context_length || 0),
              modality: String(m.architecture?.modality || ''),
            }
          }
        }
      }
    } catch {
      /* ignore */
    }

    const cur = models.value[pid] || []
    const defs = MODEL_PRICING[pid] || []
    const merged: ProviderModel[] = []
    const seen = new Set<string>()
    // 归一化键（小写连字符化）匹配 OpenRouter / 本地 id 的大小写差异
    const normKey = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '-')

    const push = (id: string, name?: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const existing = cur.find(c => c.id === id)
      const def = defs.find(d => d.id === id)
      const or = orMap[id] || orMap[normKey(id)]
      // #6 能力：已有配置优先；无配置 → 源码表；再无 → 按模型名/OpenRouter 架构自动识别
      const autoCaps = autoDetectCaps(id, or?.modality)
      const caps = existing?.capabilities
        || def?.capabilities
        || autoCaps
      // #6 旧缓存只有 ['text'] 且自动识别出 image → 升级（该是什么模型就发挥什么能力）
      /* ★1003 批次4 4.56：原来 upgradedCaps 只是**捕获旧数组引用的死变量** —— Object.assign 改的是
       * existing，push 用的仍是旧引用，且 existing 又被 `models.value[pid] = merged` 整表丢弃
       * ⇒ 宣称的"能力升级"在落库结果里根本不体现。升级后重取，push 落真实生效值。 */
      let upgradedCaps = caps
      if (existing && existing.capabilities && existing.capabilities.length === 1
        && existing.capabilities[0] === 'text' && autoCaps.includes('image') && !def) {
        // 用户自定义且没配能力的：自动补 image
        upgradedCaps = autoCaps
        Object.assign(existing, { capabilities: autoCaps })
      }
      merged.push({
        id,
        name: name || existing?.name || def?.name || id,
        inputPrice: or?.input ?? existing?.inputPrice ?? def?.inputPrice ?? 0,
        outputPrice: or?.output ?? existing?.outputPrice ?? def?.outputPrice ?? 0,
        maxContext: existing?.maxContext || or?.ctx || def?.maxContext || 0,
        capabilities: upgradedCaps,
        enabled: existing?.enabled ?? true,
      })
    }

    if (providerIds?.length) for (const id of providerIds) push(id)
    for (const c of cur) push(c.id, c.name)
    for (const d of defs) push(d.id, d.name)

    models.value[pid] = merged
    persist()

    const added = merged.filter(m => !cur.some(c => c.id === m.id)).length
    const updated = merged.filter(m => {
      const old = cur.find(c => c.id === m.id)
      return old && (old.inputPrice !== m.inputPrice || old.outputPrice !== m.outputPrice)
    }).length
    const msg = providerIds?.length
      ? `已同步 ${merged.length} 个模型`
      : providerErr
        ? `仅本地表（${providerErr}）`
        : '已同步本地默认'
    return { ok: true, added, updated, msg }
  }

  /** 拉取模型 id 完整列表（只探测不合并，供「获取模型」弹窗预览 + 用户勾选保存用）。
   *  0910 反馈12（用户拍板）：**只走网络、不拿本地表**——官方接口拿到什么就是什么；
   *  拉不到就报错（附协议/地址排查提示），绝不用 OpenRouter/本地价格表凑一份"看起来有"的列表。
   *  去重键归一化（小写+去非字母数字）：官方列表里别名与点划写法不再各占一行。 */
  async function probeModelIds(providerId: string): Promise<{ ok: boolean; ids: string[]; msg: string; sugMap?: Record<string, { vision: boolean; reasoning: boolean; genImage: boolean; context?: number; source: 'manual' | 'dev' | 'inferred' }> }> {
    const pid = providerId
    const apiKey = apiKeys.value[pid]
    const provider = providers.value.find(x => x.id === pid)
    const chatStore = useChatStore()
    const sugMap: Record<string, { vision: boolean; reasoning: boolean; genImage: boolean; context?: number; source: 'manual' | 'dev' | 'inferred' }> = {}

    let providerIds: string[] | null = null
    let providerErr = ''

    // 1) 后端代理（绕 CORS）：先 setKey 再 fetchModels（后端按协议选端点/鉴权头）
    if (chatStore.wsConnected && provider?.base) {
      try {
        /* ★ 0930 修「获取失败：供应商不存在」（实测反馈 tokenrhythm）：
           前端本地新增的供应商，**后端 providers.json 里根本没有这家** →
           setKey 静默无操作、fetchModels 报"供应商不存在"，于是永远取不到模型
           （浏览器直连兜底也必然被 CORS 拦，两头都不通）。
           取模型前先把 base/protocol 推给后端：providers.add 后端已有则是幂等 no-op，
           再 setBase 保证前端改过地址时也同步。与 setActiveModel 里"先确保后端有该供应商"
           是同一条既有先例（那条注释写得很清楚：不先 add，setActiveModel 会静默失败）。*/
        await chatStore.bridgeRpc('providers.add', { id: pid, name: (provider as any).name || pid, base: provider.base, protocol: (provider as any).protocol, enabled: (provider as any).enabled !== false })
        await chatStore.bridgeRpc('providers.setBase', { providerId: pid, base: provider.base })
        if (apiKey) await chatStore.bridgeRpc('providers.setKey', { providerId: pid, apiKey })
        const result = await chatStore.bridgeRpc('providers.fetchModels', { providerId: pid })
        const ids: string[] = Array.isArray(result.models) ? result.models : []
        for (const c of (Array.isArray(result.caps) ? result.caps : [])) {
          if (c?.id) sugMap[c.id] = { vision: !!c.vision, reasoning: !!c.reasoning, genImage: Array.isArray(c.output) && c.output.includes('image'), context: typeof c.context === 'number' ? c.context : undefined, source: c.source }
        }
        if (result.ok && ids.length) providerIds = ids
        else if (result.msg) providerErr = String(result.msg)
      } catch (e: any) {
        providerErr = `后端代理失败：${e?.message || e}`
      }
    }

    // 2) 前端直连（同属网络获取；后端代理不可用时才走）。协议不同端点/鉴权头不同，别混用。
    if (!providerIds && apiKey && provider?.base) {
      try {
        const proto = (provider as any).protocol || 'openai-completions'
        let base = provider.base.includes('://') ? provider.base : `https://${provider.base}`
        base = base.replace(/\/+$/, '')
        let headers: Record<string, string>
        if (proto === 'anthropic-messages') {
          base = /\/v\d/.test(base) ? base : `${base}/v1`
          headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        } else {
          headers = { Authorization: `Bearer ${apiKey}` }
        }
        const res = await fetch(`${base}/models`, { headers })
        if (res.ok) {
          const j = await res.json()
          providerIds = (j.data || j.models || []).map((m: any) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean)
        } else {
          providerErr = `供应商 ${res.status}（请求 ${base}/models）`
        }
      } catch {
        /* ★ 0930（实测反馈）：这里是**无条件赋值**，把上面后端已如实回传的真实原因整个盖掉。
           实测（tokenrhythm.studio，key 失效）：后端回的是 `401 · 鉴权失败…｜供应商原话：未认证或登录已过期`，
           到这一行被改写成"被 CORS 拦截"——中转网关基本不开 CORS 放行，后端一失败就必显示这句假话，
           把排查带偏。现改为：**后端给过原因就以它为准**，CORS 只当补充说明，不作结论。*/
        providerErr = providerErr
          ? `${providerErr}（浏览器直连复核同样被 CORS/网络拦截；以上为后端真实原因）`
          : '浏览器直连也被 CORS/网络拦截（当时后端未参与，请检查后端是否在运行）'
      }
    }

    // 3) 归一化去重（同一模型的不同书写只留第一条）
    const seen = new Set<string>()
    const ids: string[] = []
    for (const id of (providerIds || [])) {
      const k = String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!id || !k || seen.has(k)) continue
      seen.add(k)
      ids.push(id)
    }
    if (ids.length) return { ok: true, ids, sugMap, msg: `官方接口拉取到 ${ids.length} 个模型` }

    // 4) 失败=报错（含协议/地址排查提示），不兜底：用户明确要求"直连获取，不从本地拿"
    const proto = (provider as any)?.protocol || 'openai-completions'
    const baseShown = String(provider?.base || '(未填)')
    const why = providerErr || (!provider?.base ? '未配置 Base URL' : !apiKey ? '请先填写 API Key' : '未连上后端')
    const hint = proto === 'anthropic-messages'
      ? `当前协议 anthropic-messages（地址应指向 Anthropic 原生 API，如 https://api.anthropic.com；若这是 OpenAI 兼容网关请把协议切成 openai-completions）`
      : proto === 'google-generative-ai'
        ? `当前协议 google-generative-ai（地址应指向 Gemini 原生 API，如 https://generativelanguage.googleapis.com/v1beta）`
        : `当前协议 openai-completions（地址应指向 OpenAI 兼容 API 根，如 https://xxx/v1 或 https://xxx/v4；Anthropic 官方地址请把协议切成 anthropic-messages）`
    return { ok: false, ids: [], sugMap, msg: `获取失败：${why}
地址 ${baseShown}
${hint}` }
  }

  /** 把后端代理拉到的模型 id 合并进当前供应商模型表（保留已有的启用/价格状态） */
  function mergeFetchedModels(pid: string, modelIds: string[], picks?: Record<string, { vision: boolean; reasoning: boolean; genImage: boolean; contextTokens?: number; maxInput?: number; maxOutput?: number }>) {
    const cur = models.value[pid] || []
    // 用户弹窗勾选 → 权威 capabilities + 三轴字段（勾了就是真的，后端 resolveModelCaps 显式字段最高优先）
      const fromPick = (id: string): Partial<ProviderModel> | null => {
      const p = picks?.[id]
      if (!p) return null
      const caps = ['text', ...(p.vision ? ['image'] : []), ...(p.reasoning ? ['reasoning'] : [])]
      return {
        capabilities: caps,
        inputModalities: ['text', ...(p.vision ? ['image'] : [])],
        outputModalities: ['text', ...(p.genImage ? ['image'] : [])],
        supports: { vision: p.vision, reasoning: p.reasoning },
        // 0908/0909③：弹窗填的上下文=裸 token 数（不再按 K 换算），直接决定压缩阈值 resolveContextWindow
        ...(p.contextTokens && p.contextTokens > 0 ? { maxContext: Math.round(p.contextTokens) } : {}),
        // 0923：获取弹窗也能直接填输入/输出上限（留空=不覆盖；写上即成为后端 resolveMaxOutput/resolveMaxInput 的权威值）
        ...(p.maxOutput && p.maxOutput > 0 ? { maxOutput: Math.round(p.maxOutput) } : {}),
        ...(p.maxInput && p.maxInput > 0 ? { maxInput: Math.round(p.maxInput) } : {}),
      }
    }
    const merged: ProviderModel[] = modelIds.map(id => {
      const existing = cur.find(c => c.id === id)
      const def = MODEL_PRICING[pid]?.find(d => d.id === id)
      const pick = fromPick(id)
      // #6 能力自动识别：只有 ['text'] 且模型名疑似多模态 → 自动补 image
      const autoCaps = autoDetectCaps(id)
      const caps = pick?.capabilities || existing?.capabilities || def?.capabilities || autoCaps
      if (existing) {
        // 用户勾了 → 直接覆盖已有（手动权威）
        if (pick) return { ...existing, ...pick }
        // 已有模型但价格/上下文为 0 时，用本地价格表补齐
        if (def && (existing.inputPrice === 0 || existing.outputPrice === 0 || existing.maxContext === 0)) {
          return { ...existing, inputPrice: existing.inputPrice || def.inputPrice, outputPrice: existing.outputPrice || def.outputPrice, maxContext: existing.maxContext || def.maxContext }
        }
        // 能力升级：已有只有 ['text']，而本地表/自动识别带 reasoning/image → 补全（只增不减，不降级）
        const betterCaps = def?.capabilities || autoCaps
        if (betterCaps && betterCaps.some(c => c !== 'text' && !(existing.capabilities || []).includes(c))) {
          return { ...existing, capabilities: [...new Set([...(existing.capabilities || ['text']), ...betterCaps])] }
        }
        return existing
      }
      return {
        id,
        name: def?.name || id,
        inputPrice: def?.inputPrice ?? 0,
        outputPrice: def?.outputPrice ?? 0,
        maxContext: def?.maxContext ?? 0,
        capabilities: caps,
        enabled: true,
        ...(pick?.inputModalities ? { inputModalities: pick.inputModalities, outputModalities: pick.outputModalities, supports: pick.supports } : {}),
      }
    })
    // 保留未在拉取列表里的已启用自定义模型
    for (const c of cur) {
      if (!modelIds.includes(c.id)) merged.push(c)
    }
    // 大小写不敏感去重（同一模型不同大小写/重复添加只保留一个）
    const seen = new Map<string, ProviderModel>()
    for (const m of merged) {
      const key = m.id.toLowerCase()
      if (!seen.has(key)) seen.set(key, m)
    }
    models.value[pid] = Array.from(seen.values())
    persist()
    // 0907：同步到后端（三轴字段随 setModels 落 providers.json，后端闸门/解析立即生效）；
    //  轻量 fire-and-forget，不进 syncModelToBackend（它会 setModel 切当前模型，保存列表不应有副作用）
    //  0910 二批④：不再要求 picks 非空——「获取模型」路径此前只写前端 localStorage、永远不落
    //  providers.json，成员独立模型解析按 providers.json 找 → "下拉里选得到的模型后端不认"，两份数据源脱节
    {
      const chatStore = useChatStore()
      const provider = providers.value.find(p => p.id === pid)
      const base = provider?.base?.includes('://') ? provider.base : provider?.base ? `https://${provider.base}` : ''
      if (base) {
        chatStore.bridgeRpc('providers.add', { id: pid, name: provider?.name || pid, base })
          .catch((e) => swallowed('能力同步新增供应商未同步到后端（本地有、后端无）', e))
        chatStore.bridgeRpc('providers.setModels', { providerId: pid, models: models.value[pid] || [] }).catch((e: any) => console.error('[providers] 能力同步后端失败:', e?.message || e))
      }
    }
  }

  /** 添加自定义供应商 */
  function addProvider(provider: { id: string; name: string; base: string }) {
    const id = provider.id.trim()
    if (!id) return
    if (providers.value.some(p => p.id === id)) return
    const name = provider.name.trim() || id
    const rawBase = provider.base.trim()
    const base = rawBase.includes('://') ? rawBase : rawBase ? `https://${rawBase}` : ''
    const enabled = providers.value.filter(p => p.enabled).length < ENABLED_MAX
    providers.value.push({
      id,
      name,
      base: rawBase,
      // 已启用满 ENABLED_MAX（12）个时新供应商默认停用
      enabled,
      // 0918：自定义供应商**不要**赋 /providers-logo/<id> 这个不存在的路径 ——
      // 否则会被当成"已内置"藏起「获取 logo」按钮，头像也会变裂图。留空走首字母兜底。
      logo: '',
    })
    if (!models.value[id]) models.value[id] = []
    persist()
    /* ★1010 修「刚添加的供应商重开就没了」：以前这里**只 push 内存**（persist 早已是 no-op），
       后端要等到"获取模型 / 保存模型 / 改模型"时才被顺带补上（providers.add）——
       期间只要刷新页面或用另一个窗口重开，这家供应商就凭空消失（后端 providers.json 里没有）。
       现在**添加即落后端**（后端已有 = 幂等 no-op；base 空则不推，等用户填完 URL 由
       saveProviderBase 那条路推）。 */
    if (base) {
      useChatStore().bridgeRpc('providers.add', { id, name, base, enabled })
        .catch((e) => swallowed('新增供应商未同步到后端（本地已添加、后端未落盘，刷新会丢）', e))
    }
  }

  /** 删除供应商 */
  function removeProvider(id: string) {
    providers.value = providers.value.filter(p => p.id !== id)
    delete models.value[id]
    delete apiKeys.value[id]
    if (providerActive.value === id) {
      // 0917：删掉当前激活项后**不自作主张选一个新的**（旧行为回落 providers[0]）——
      // 置空即可，后端会在下次鉴权时按「第一个已启用且有 key」裁决，前端不再抢这个决定权。
      providerActive.value = ''
    }
    persist()
    // 0910：删除要落后端 providers.remove——后端 providers.json 是权威、启动时镜像回来，
    // 之前只删前端 localStorage → 刷新/重启该供应商"复活"（用户以为没删掉）。失败不阻断本地删除。
    useChatStore().bridgeRpc('providers.remove', { providerId: id })
      .catch((e: any) => console.error('[Providers] remove failed:', id, e?.message || e))
  }

  /** 退役字段（2026-09-12：概念统一为「全局模型」）—— 仅用于**读旧数据后清理**，
   *  不再参与任何业务判定。load() 时若发现旧值，直接丢弃并落盘，避免老 localStorage 残留。 */
  const extractModelId = ref('')
  const extractModelProviderId = ref('')

  /* ★1012t：**后台模型**（"对话之外"的场景专用）—— 知识库/记忆库自动提炼、QQ/微信渠道（未单独配模型时）。
     后端 `providers.json` 是唯一事实源（`providers.list` 回传 / `providers.setBackgroundModel` 写回）。
     ★1013（已定案）：空串 = **未配置** —— 后端**不再回落聊天模型**（"想用免费模型做后台活，
     回落却跑到贵模型上 = 偷钱"），后台任务会明确失败 + 弹通知，提醒用户去设置里选。*/
  const backgroundProviderId = ref('')
  const backgroundModelId = ref('')
  /** ★1013：后台模型的推理强度（'' = 不指定，按模型默认挡；需求要求"后台模型也能自由选强度"） */
  const backgroundEffort = ref('')

  // ── 持久化（0914 修订 · 用户拍板「把 local 都去掉」）──
  // 前端**不再**用 localStorage 存供应商/模型/Key 状态：后端 providers.json 是唯一事实源。
  // 动机：曾出现"各窗口在 WS 重连时把 localStorage 旧值推回后端" → 全局模型反复横跳（2.5↔3.0）。
  // 现在：启动/重连仅 syncFromBackend 拉取；用户显式操作（选模型/开关/改 Key）才经 RPC 推送后端。
  function load() { /* no-op：不再读 localStorage */ }

  function persist() { /* no-op：不再写 localStorage（后端为唯一事实源） */ }

  load()

  // v2/v3 localStorage 迁移段已移除（0914：不再使用 localStorage）。

  // WS 连接后 → **只拉不推**（0914 修订 · 防全局模型"跳变"）：
  // 旧实现在 400ms 后还会 syncModelToBackend()，把「本窗口 localStorage 里的旧值」推给后端——
  // 后端重启 / 多窗口重连时，各窗口把各自的旧值轮番推上去 → 全局模型反复横跳
  // （审计日志曾出现 2.5↔3.0 数十次抖动）。后端 providers.json 持久化且启动自恢复
  // （activeModelId 从磁盘载入），前端连上后仅 syncFromBackend 采纳后端权威值；
  // 只有用户显式选择模型/强度时（setter）才推送。
  /* ★1012u：跨客户端同步（实测：手机把全局模型切到 Agnes 2.5，电脑上仍是 deepseek v4.1）。
     根因：providers 只在 **WS 连接/重连**时 syncFromBackend 一次，而后端 `providers.setModel`
     只写盘、**不广播** ⇒ 另一台设备（一直开着、WS 从未断）永远收不到这次变更。
     处置（低代价、无需后端配合）：**定时采纳后端权威值 + 回到前台立即同步** ——
     后端 providers.json 本来就是唯一事实源；`lastLocalModelPickAt` 保护窗仍然生效，
     本窗口刚手选的模型不会被旧值弹回。 */
  let syncTimer: ReturnType<typeof setInterval> | undefined
  const onFocusSync = () => { void syncFromBackend() }
  const onVisSync = () => { if (document.visibilityState === 'visible') void syncFromBackend() }
  function startCrossClientSync() {
    stopCrossClientSync()
    syncTimer = setInterval(() => { void syncFromBackend() }, 20000)
    try {
      window.addEventListener('focus', onFocusSync)
      document.addEventListener('visibilitychange', onVisSync)
    } catch { /* 非浏览器环境 */ }
  }
  function stopCrossClientSync() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = undefined }
    try {
      window.removeEventListener('focus', onFocusSync)
      document.removeEventListener('visibilitychange', onVisSync)
    } catch { /* ignore */ }
  }
  watch(() => useChatStore().wsConnected, (connected) => {
    if (connected) {
      setTimeout(() => syncFromBackend(), 300)
      startCrossClientSync()
    } else {
      stopCrossClientSync()
    }
  })

  /** #1 每窗口模型隔离：conversation_id → {provider, model_id, base}（会话级，不持久化） */
  const convModel = ref<Record<number, { provider: string; model_id: string; base: string }>>({})
  function getConvModel(convId: number | null | undefined): { provider: string; model_id: string; base: string } | null {
    if (convId == null) return null
    return convModel.value[convId] || null
  }
  function setConvModel(convId: number | null | undefined, m: { provider: string; model_id: string; base: string }) {
    if (convId == null) return
    convModel.value[convId] = m
  }

  /** ★1012t：写「后台模型」到后端（后端权威、会广播给所有窗口）。传空串 = 清除（= 未配置；后端不再回落）。
   *  ★1013：effort 一并写（undefined = 不改强度；'' / null = 清空 → 按模型默认挡）。 */
  async function setBackgroundModel(providerId: string, modelId: string, effort?: string | null) {
    const chatStore = useChatStore()
    backgroundProviderId.value = providerId || ''
    backgroundModelId.value = modelId || ''
    if (effort !== undefined) backgroundEffort.value = effort === null ? '' : String(effort || '')
    try {
      await chatStore.bridgeRpc('providers.setBackgroundModel', {
        providerId: providerId || '',
        modelId: modelId || '',
        ...(effort !== undefined ? { effort: effort === null ? '' : String(effort || '') } : {}),
      })
      syncBackgroundModelNotice()   // ★1013e：改完立即评估常驻通知（配好了就撤掉那条提醒）
    } catch (e) { console.warn('[model] 后台模型写后端失败（本地已显示，下次连接会以后端为准）:', e) }
  }

  /** 兼容旧调用点：语义**已统一为全局模型**。
   *  2026-09-12 用户拍板：不再有独立的「提炼模型」概念 —— 全局模型就是唯一口径。
   *  保留此函数只为旧引用（若还有）能拿到同一份结果，等价于 extractModel()。 */
  function savedExtractModel(): { provider: string; model_id: string } | null {
    return extractModel()
  }

  /** 兼容旧调用：2026-09-12 起「提炼模型」概念已并入全局模型，无脏值可清 —— 恒 false。 */
  function pruneStaleExtractModel(): boolean {
    return false
  }



  /** 解析「系统级用模型」（AI 提炼 / 知识库提炼 / 记忆提炼 / 定时任务默认等）→ {provider, model_id}。
   *
   *  ★1013b（已定案："以前可以选用全局模型的，都要换成后台模型"）：**唯一口径 = 「后台模型」**
   *  （设置 → 人格 → 后台模型）。以前这里读"当前全局模型"—— 那个概念已经从 UI 拿掉（全局值改为
   *  跟着用户在对话里选的模型走），后台活再读它 = 读聊天模型，且与后端不一致
   *  （后端的提炼/渠道/定时任务都走 `backgroundLlmConfig`）。
   *  - 后台模型未配 / 不可用 → 返回 null：调用方必须**直接报错 + 引导去「设置 → 人格 → 后台模型」**，
   *    **不做任何静默兜底**（不回退聊天模型 —— 用户："想用免费模型做后台任务，回落却回到贵的模型上 = 偷钱"）。 */
  function extractModel(): { provider: string; model_id: string } | null {
    const am = backgroundModelId.value
    if (!am) return null
    const pid = backgroundProviderId.value
    const p = providers.value.find(x => x.id === pid)
    if (!p || !p.enabled) return null
    const mm = (models.value[pid] || []).find(m => m.id === am && m.enabled)
    if (!mm || modelType(pid, mm.id) !== 'text') return null
    return { provider: pid, model_id: am }
  }

  /** 兼容旧调用点：设置模型 = **设置全局模型**（2026-09-12 概念统一后）。 */
  function setExtractModel(modelId: string, providerId: string) {
    selectProvider(providerId)
    currentModelId.value = modelId
  }

  return {
    providers,
    models,
    providerActive,
    apiKeys,
    apiKey,
    explicitlyDisabled,
    activeModelId,
    activeEffort,
    currentModelId,
    modelDropdownOpen,
    ENABLED_MAX,
    enabledProviders,
    sortedProviders,
    activeProvider,
    modelIds,
    modelName,
    modelType,
    isMultimodal,
    modelEfforts,
    clampEffortFor,
    setActiveEffort,
    syncEffortToBackend,
    clampedGlobalEffort,
    isProviderReady,
    autoDetectCaps,
    getConvModel,
    setConvModel,
    modelForSend,
    extractModelId,
    backgroundProviderId,
    backgroundModelId,
    backgroundEffort,
    setBackgroundModel,
    extractModelProviderId,
    extractModel,
    savedExtractModel,
    pruneStaleExtractModel,
    setExtractModel,
    selectProvider,
    toggleProviderEnabled,
    setProviderBase,
    setProviderProxyLocal,
    saveProviderProxy,
    setProviderLogo,
    toggleModelEnabled,
    removeModel,
    addModel,
    updateModel,
    syncPrices,
    fetchModels,
    probeModelIds,
    mergeFetchedModels,
    syncFromBackend,
    addProvider,
    removeProvider,
    saveProviderBase,
    setApiKeyFor,
    setProviderProtocol,
  }
})
