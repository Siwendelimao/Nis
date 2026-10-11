/**
 * 模型价格数据源 —— 前端打包的 LiteLLM / 后端 ModelRegistry 子集。
 *
 * 字段与后端 core/model_registry.py 的 ModelPricing 对齐：
 *   id/model_id、name、inputPrice/outputPrice（美元 / 每 1M tokens）、
 *   maxContext、capabilities。
 *
 * 「同步价格」= 用本表重置/补齐各供应商模型价格；后端接上后改为从
 * 后端 ModelRegistry 或 LiteLLM model_prices_and_context_window.json 拉取。
 */

export interface ProviderModel {
  id: string
  name: string
  /** 输入价格：美元 / 每 1M tokens */
  inputPrice: number
  /** 输出价格：美元 / 每 1M tokens */
  outputPrice: number
  /** 最大上下文（tokens） */
  maxContext: number
  /** 0921：单次输出上限（max_tokens / maxOutputTokens，即"输出预留"）。留空 = 走 models.dev 的
   *  limit.output（缺省 16384）；填了 = 权威。它和 maxContext、maxInput 三个数一起决定"这次塞不塞得下"。 */
  maxOutput?: number
  /** 0921：单次输入上限（发给模型的 messages + tools 的 token 上限）。留空 = 不设限
   *  （发送侧按"窗口 − 输出预留 − 安全垫"动态算）。填了就按它更早触发压缩。 */
  maxInput?: number
  capabilities: string[]
  enabled: boolean
  /**
   * 输出上限参数名：默认 max_tokens；
   * 'max_completion_tokens' = o 系思考模型网关（如 agnes pro alpha，只认该参数，忽略 max_tokens → 会"只思考不回复"）；
   * 'max_tokens' = 显式长输出（如 deepseek-reasoner，思考长，上限给 16384）
   */
  completionParam?: 'max_tokens' | 'max_completion_tokens'
  /** 0907 供应商C段（与后端 ProviderModel 对齐，可选）：输入模态（能"读"什么），用户在获取弹窗勾选后写入=权威 */
  inputModalities?: string[]
  /** 输出模态（能"生"什么）；不含 text = 纯生图/视频，不可作聊天模型 */
  outputModalities?: string[]
  /** 特性开关（与模态正交）；vision/reasoning 由弹窗勾选落库 */
  supports?: { reasoning?: boolean; vision?: boolean }
  /** 0910 推理挡位按模型声明（与后端 ProviderModel.efforts 对齐）：该模型接受的思考强度挡位
   *  （fast/deep/heavy/burning）。缺省=未声明走兜底推导（非推理=[]；zai 系去 deep；其余全四挡）；
   *  ✎ 编辑面板勾选落库=权威。发送钳位在后端 clampEffort，展示过滤在前端 modelEfforts。 */
  efforts?: string[]
}

function m(
  id: string,
  name: string,
  inputPrice: number,
  outputPrice: number,
  maxContext: number,
  capabilities: string[] = ['text'],
  completionParam?: 'max_tokens' | 'max_completion_tokens',
): ProviderModel {
  return { id, name, inputPrice, outputPrice, maxContext, capabilities, enabled: true, ...(completionParam ? { completionParam } : {}) }
}

/** 0917：Agnes 国际版 / 国内版共用同一份模型表（同网关不同入口，模型名一致） */
const AGNES_MODELS: ProviderModel[] = [
  // agnes 网关为 o 系：输出上限必须用 max_completion_tokens（传 max_tokens 会被忽略 →
  // 思考占满默认小上限，出现"只思考不回复"）
  m('agnes-3.0-flash', 'Agnes 3.0 Flash', 0, 0, 1048576, ['text', 'image', 'reasoning'], 'max_completion_tokens'),
  m('agnes-2.5-flash', 'Agnes 2.5 Flash', 0, 0, 1048576, ['text', 'image', 'reasoning'], 'max_completion_tokens'),
  m('agnes-2.0-flash', 'Agnes 2.0 Flash', 0, 0, 262144, ['text', 'image', 'reasoning'], 'max_completion_tokens'),
  m('agnes-2.5-pro-alpha', 'Agnes 2.5 Pro Alpha', 0, 0, 1048576, ['text', 'image', 'reasoning'], 'max_completion_tokens'),
  m('agnes-image-2.1-flash', 'Agnes Image 2.1 Flash', 0, 0, 0, ['image']),
]

export const MODEL_PRICING: Record<string, ProviderModel[]> = {
  deepseek: [
    m('deepseek-chat', 'DeepSeek Chat', 0.28, 0.42, 131072),
    m('deepseek-reasoner', 'DeepSeek Reasoner', 0.55, 2.19, 131072, ['text', 'reasoning'], 'max_tokens'),
    m('deepseek-coder', 'DeepSeek Coder', 0.14, 0.28, 131072),
  ],
  openai: [
    m('gpt-4o', 'GPT-4o', 3.75, 15, 128000, ['text', 'image']),
    m('gpt-4o-mini', 'GPT-4o mini', 0.6, 2.4, 128000, ['text', 'image']),
    m('gpt-4.1', 'GPT-4.1', 2, 8, 1048576, ['text', 'image']),
    m('o3-mini', 'o3-mini', 1.1, 4.4, 200000, ['text', 'reasoning']),
  ],
  anthropic: [
    m('claude-3-5-sonnet', 'Claude 3.5 Sonnet', 3.75, 18.75, 200000, ['text', 'image']),
    m('claude-3-haiku', 'Claude 3 Haiku', 1.25, 6.25, 200000, ['text', 'image']),
    m('claude-sonnet-4', 'Claude Sonnet 4', 5, 25, 200000, ['text', 'image', 'reasoning']),
    m('claude-opus-4', 'Claude Opus 4', 15, 75, 200000, ['text', 'image', 'reasoning']),
  ],
  zhipu: [
    m('glm-4-plus', 'GLM-4 Plus', 2, 5, 128000, ['text', 'reasoning']),
    m('glm-4-flash', 'GLM-4 Flash', 0.1, 0.3, 128000),
    m('glm-4v', 'GLM-4V', 1, 3, 8192, ['text', 'image']),
    m('glm-4.5', 'GLM-4.5', 2, 5, 128000, ['text']),
    m('glm-4.5-air', 'GLM-4.5 Air', 0.5, 1.5, 128000, ['text']),
    m('glm-4.5v', 'GLM-4.5V', 2, 5, 128000, ['text', 'image']),
    m('glm-4.6', 'GLM-4.6', 2, 5, 128000, ['text']),
    m('glm-4.6v', 'GLM-4.6V', 2, 5, 128000, ['text', 'image']),
    m('glm-4.7', 'GLM-4.7', 2, 5, 128000, ['text', 'reasoning']),
    m('glm-4.7-flash', 'GLM-4.7 Flash', 0.5, 1.5, 128000, ['text', 'reasoning']),
    m('glm-5', 'GLM-5', 3, 8, 128000, ['text', 'reasoning']),
    m('glm-5-turbo', 'GLM-5 Turbo', 2, 5, 128000, ['text', 'reasoning']),
    m('glm-5.1', 'GLM-5.1', 3, 8, 128000, ['text', 'reasoning']),
    m('glm-5.2', 'GLM-5.2', 3, 8, 128000, ['text', 'reasoning']),
    m('glm-5.3', 'GLM-5.3', 3, 8, 128000, ['text', 'image', 'reasoning']),
    m('glm-5.3-flash', 'GLM-5.3 Flash', 0.5, 1.5, 128000, ['text', 'image', 'reasoning']),
    m('glm-5v-turbo', 'GLM-5V Turbo', 2, 5, 128000, ['text', 'image']),
  ],
  tongyi: [
    m('qwen-max', 'Qwen Max', 1.6, 6.4, 32768),
    m('qwen-plus', 'Qwen Plus', 0.4, 1.2, 131072),
    m('qwen-turbo', 'Qwen Turbo', 0.1, 0.3, 131072),
    m('qwen-vl-max', 'Qwen VL Max', 2, 6, 32768, ['text', 'image']),
  ],
  moonshot: [
    m('moonshot-v1-8k', 'Moonshot v1 8K', 1.7, 1.7, 8192),
    m('moonshot-v1-32k', 'Moonshot v1 32K', 1.7, 1.7, 32768),
    m('moonshot-v1-128k', 'Moonshot v1 128K', 1.7, 1.7, 131072),
    m('kimi-k2', 'Kimi K2', 1.4, 5.6, 262144, ['text', 'reasoning']),
  ],
  stepfun: [
    m('step-2-16k', 'Step 2 16K', 0.08, 0.28, 16384, ['text', 'reasoning']),
    m('step-1-8k', 'Step 1 8K', 0.05, 0.15, 8192),
  ],
  minimax: [
    m('abab6.5s-chat', 'MiniMax abab6.5s', 0.8, 2.2, 245760),
    m('MiniMax-M1', 'MiniMax M1', 1.2, 5, 200000, ['text', 'reasoning']),
  ],
  deepbricks: [
    m('deepseek-chat', 'DeepSeek Chat (proxy)', 0.28, 0.42, 131072),
    m('qwen-max', 'Qwen Max (proxy)', 1.6, 6.4, 32768),
  ],
  together: [
    m('meta-llama/Llama-3-70b', 'Llama 3 70B', 0.9, 0.9, 8192),
    m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3', 0.3, 0.9, 131072),
  ],
  grok: [
    m('grok-2', 'Grok 2', 2, 10, 131072, ['text', 'image']),
    m('grok-2-mini', 'Grok 2 mini', 0.4, 1, 131072, ['text', 'image']),
  ],
  perplexity: [
    m('sonar-pro', 'Sonar Pro', 1, 3, 200000, ['text', 'web-search']),
    m('sonar', 'Sonar', 0.6, 1.2, 200000, ['text', 'web-search']),
  ],
  ollama: [
    m('llama3.3', 'Llama 3.3', 0, 0, 131072),
    m('qwen2.5', 'Qwen 2.5', 0, 0, 131072),
    m('deepseek-coder', 'DeepSeek Coder', 0, 0, 131072),
  ],
  openrouter: [
    m('openai/gpt-4o', 'GPT-4o (OpenRouter)', 3.75, 15, 128000, ['text', 'image']),
    m('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet (OpenRouter)', 3.75, 18.75, 200000, ['text', 'image']),
    m('deepseek/deepseek-chat', 'DeepSeek Chat (OpenRouter)', 0.28, 0.42, 131072),
  ],
  google: [
    m('gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 10, 1048576, ['text', 'image', 'reasoning']),
    m('gemini-2.5-flash', 'Gemini 2.5 Flash', 0.3, 2.5, 1048576, ['text', 'image']),
    m('gemini-2.0-flash', 'Gemini 2.0 Flash', 1.5, 6, 1000000, ['text', 'image']),
  ],
  groq: [
    m('llama-3.3-70b-versatile', 'Llama 3.3 70B', 0.59, 0.79, 131072),
    m('deepseek-r1-distill-llama-70b', 'DeepSeek R1 Distill 70B', 0.75, 0.99, 131072, ['text', 'reasoning']),
  ],
  mistral: [
    m('mistral-large-latest', 'Mistral Large', 2, 6, 131072, ['text', 'reasoning']),
    m('mistral-small-latest', 'Mistral Small', 0.2, 0.6, 32768),
  ],
  doubao: [
    m('doubao-1.5-pro-32k', 'Doubao 1.5 Pro 32K', 0.4, 1.6, 32768),
    m('doubao-1.5-lite-32k', 'Doubao 1.5 Lite 32K', 0.05, 0.3, 32768),
  ],
  hunyuan: [
    m('hunyuan-turbos-latest', 'Hunyuan TurboS', 0.2, 0.6, 131072, ['text', 'image']),
    m('hunyuan-lite', 'Hunyuan Lite', 0.04, 0.12, 131072),
  ],
  ernie: [
    m('ernie-4.0-turbo-128k', 'ERNIE 4.0 Turbo 128K', 0.6, 1.8, 128000),
    m('ernie-3.5-8k', 'ERNIE 3.5 8K', 0.2, 0.6, 8192),
  ],
  siliconflow: [
    m('Qwen/Qwen2.5-72B-Instruct', 'Qwen 2.5 72B', 0.55, 0.55, 131072),
    m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3', 0.35, 0.9, 65536, ['text', 'reasoning']),
  ],
  agnes: AGNES_MODELS,
  // 0917：国内版（api.agnes-ai.cn）
  'agnes-cn': AGNES_MODELS,
  longcat: [
    m('LongCat-2.0', 'LongCat-2.0', 0.75, 2.95, 1048576, ['text', 'image', 'reasoning']),
  ],
}
