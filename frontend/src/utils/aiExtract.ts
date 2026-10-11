import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { t } from '@/utils/i18n'

/**
 * AI 提炼客户端 —— 后端 ai.extract。
 * 把文字/URL 内容交给后端 LLM，抽取成知识库固定字段（title/summary/content/entry_type/tags/source_label）；
 * 提炼模型取「设置 → 人格 → 全局模型」（优先级：手选的提炼模型 > 当前全局模型；
 * 两者都没有时**直接报错**并引导去选择，不再静默兜底 —— 2026-09-12 用户拍板）。
 *
 * 0911 接通：原走 WS AI_EXTRACT / AI_EXTRACT_RESULT 死通道（等一个后端永不发送的消息 → 转 15s 失败），
 * 现改为 bridgeRpc 实链路。后端未连接时返回 null（调用方提示需连接后端）。
 */

export interface AIExtractFields {
  title: string
  summary: string
  content: string
  /** doc / manual / note / reference */
  entry_type: string
  tags: string[]
  source_label: string
}

interface AIExtractResult {
  ok: boolean
  fields: AIExtractFields
  llm_used?: boolean
  msg?: string
  /** 没有可用的全局模型（未选/不可用）→ UI 应引导去「设置 → 人格 → 全局模型」选择 */
  needModel?: boolean
}

/**
 * 提炼内容 → 结构化字段。
 * @returns AIExtractResult；后端未连接返回 null
 */
export async function aiExtract(
  sourceType: string,
  content: string,
): Promise<AIExtractResult | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null
  const model = useProvidersStore().extractModel()
  /** 2026-09-12 用户拍板：全局模型未选/不可用时**不再静默兜底**——直接报错，
   *  UI 侧拿 needModel 渲染「去选择模型」一键跳转（设置 → 人格）。 */
  if (!model) return { ok: false, needModel: true, fields: emptyFields(), msg: t('extract.noGlobalModel') }

  try {
    const r = await chatStore.bridgeRpc('ai.extract', { sourceType, content, model }, 90000 /* ★0927 慢 RPC 大超时：走模型 */)
    if (r?.ok && r.fields) {
      return { ok: true, fields: normalizeFields(r.fields), llm_used: !!r.llm_used }
    }
    return { ok: false, fields: emptyFields(), msg: r?.msg || '提炼失败' }
  } catch (e: any) {
    return { ok: false, fields: emptyFields(), msg: String(e?.message || e).slice(0, 200) }
  }
}

function emptyFields(): AIExtractFields {
  return { title: '', summary: '', content: '', entry_type: 'doc', tags: [], source_label: '' }
}

function normalizeFields(f: any): AIExtractFields {
  return {
    title: String(f.title || '').slice(0, 60),
    summary: String(f.summary || '').slice(0, 120),
    content: String(f.content || ''),
    entry_type: ['doc', 'manual', 'note', 'reference'].includes(f.entry_type) ? f.entry_type : 'doc',
    tags: Array.isArray(f.tags) ? f.tags.map(String).slice(0, 6) : [],
    source_label: String(f.source_label || '').slice(0, 60),
  }
}
