/**
 * 预设管理员工具集 —— 供「创造模式」（toolsets 含 preset-admin）使用。
 *
 * 能力：让 AI 按预设落盘规范创建/修改/删除 Agent 预设，并在写入前用
 * 当前全局模型（默认 longcat）跑一次 smoke 运行时检查。
 *
 * 落盘：backend/data/agent-presets/<id>/preset.json（每预设一个文件夹，可拆装）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type as TbType } from 'typebox'
import { currentLlmConfig } from './providers.ts'
import { validateAgentPreset, readAgentPreset, writeAgentPreset, deleteAgentPreset, PRESETS_DIR } from './agentPresetsStore.ts'
import { TOOL_CATALOG, type ToolRegistryEntry } from './toolCatalog.ts'

/** 系统提示词组装：与前端 composeSystem 三层结构对齐的精简版（smoke 测试用） */
function smokeSystem(role: string): string {
  return `你是 NIS 的一个 Agent。你的角色与专长：${role.trim() || '（未设定）'}`
}

/** smoke 运行时检查：用当前全局模型真实调用一次 LLM，验证 role 自洽且可产出 */
async function smokeTest(preset: { name: string; role: string }): Promise<{ pass: boolean; reply: string; detail: string }> {
  const cfg = currentLlmConfig()
  if (!cfg?.base || !cfg?.model) return { pass: false, reply: '', detail: '未配置全局模型（providers）' }
  const isLocalBase = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(cfg.base)
  if (!cfg.apiKey && !isLocalBase) return { pass: false, reply: '', detail: `供应商「${cfg.providerName}」未配置 API Key` }

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: smokeSystem(preset.role) },
      {
        role: 'user',
        content: '运行时自检：请用两三句话复述你对自己角色的理解，并列出你认为自己需要哪些工具（只报工具名称，逗号分隔）。不要做任何其他事情。',
      },
    ],
    stream: false,
    max_tokens: 500,
  }
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : '' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { pass: false, reply: '', detail: `HTTP ${res.status}` }
    const data: any = await res.json()
    const reply: string = data?.choices?.[0]?.message?.content || ''
    if (!reply.trim()) return { pass: false, reply: '', detail: '模型返回空回复' }
    return { pass: true, reply: reply.trim(), detail: `模型 ${cfg.model} 自检通过` }
  } catch (e: any) {
    return { pass: false, reply: '', detail: `调用失败：${e?.message || e}` }
  }
}

export function buildPresetAdminTools(getRegistry?: () => ToolRegistryEntry[]): AgentTool<any>[] {
  // 工具唯一源（0904）：优先用 server 注入的实时 registry（含 MCP/自定义），
  // 兜底静态目录（registry 拉取异常时 list_tools 仍可用内置部分）
  const listCatalog = (): ToolRegistryEntry[] => { try { return getRegistry?.() ?? TOOL_CATALOG } catch { return TOOL_CATALOG } }

  // 1) list_tools：系统全部可用工具目录（预设 tools 字段从这里选）
  const listToolsTool: AgentTool<any> = {
    name: 'list_tools',
    label: '列出可用工具',
    description: '列出 NIS 系统中全部可用工具（名称+说明）。创建/修改预设时，预设的 tools 字段只能从这里选择。',
    parameters: TbType.Object({}),
    async execute() {
      const cat = listCatalog()
      return {
        content: [{ type: 'text', text: cat.map(t => `- ${t.name}: ${t.description}（分组：${t.group}${t.gating ? `，需 ${t.gating}` : ''}）`).join('\n') || '（无工具）' }],
        details: { count: cat.length },
      }
    },
  }

  // 2) read_preset：读现有预设（改进前先读）
  const readPresetTool: AgentTool<any> = {
    name: 'read_preset',
    label: '读取预设',
    description: '读取一个已存在的 Agent 预设完整内容（改进/参考时用）。',
    parameters: TbType.Object({
      id: TbType.String({ description: '预设 id' }),
    }),
    async execute(_c, params: any) {
      const p = readAgentPreset(String(params.id || ''))
      if (!p) throw new Error(`预设不存在：${params.id}`)
      return {
        content: [{ type: 'text', text: JSON.stringify(p, null, 2) }],
        details: { id: p.id },
      }
    },
  }

  // 3) save_preset：校验 → smoke 测试 → 落盘（创建/更新一体）
  const savePresetTool: AgentTool<any> = {
    name: 'save_preset',
    label: '保存预设',
    description: '保存 Agent 预设到 backend/data/agent-presets/<id>/preset.json。流程：先静态校验，再用当前全局模型做 smoke 运行时检查，PASS 才落盘。内置预设（builtin）不可覆盖。创建新预设时 description 要说明角色定位与适用场景。',
    parameters: TbType.Object({
      id: TbType.String({ description: '预设 id（2-48 位小写字母/数字/连字符）' }),
      name: TbType.String({ description: '显示名称' }),
      description: TbType.String({ description: '一句话描述角色定位与适用场景' }),
      role: TbType.String({ description: '角色增量提示词（叠加在全局人格之上的行为纪律）' }),
      tools: TbType.Optional(TbType.Array(TbType.String(), { description: '工具名清单（用 list_tools 查可选范围）' })),
    }),
    async execute(_c, params: any) {
      const preset = {
        id: String(params.id || '').trim(),
        name: String(params.name || ''),
        description: String(params.description || ''),
        role: String(params.role || ''),
        tools: Array.isArray(params.tools) ? params.tools.map((x: any) => String(x)) : undefined,
      }
      const err = validateAgentPreset(preset)
      if (err) throw new Error(`校验失败：${err}`)
      const existing = readAgentPreset(preset.id)
      if (existing?.builtin) throw new Error('内置预设不可覆盖，请换一个 id（可基于它复制修改）')

      const smoke = await smokeTest({ name: preset.name, role: preset.role })
      if (!smoke.pass) throw new Error(`运行时检查未通过（${smoke.detail}），不落盘。请调整 role 后重试。`)

      const r = writeAgentPreset({ ...preset, builtin: false })
      if (!r.ok) throw new Error(r.error)
      return {
        content: [{
          type: 'text',
          text: [
            `已保存预设「${r.preset.name}」（id=${r.preset.id}）到 ${PRESETS_DIR}/${r.preset.id}/preset.json`,
            `运行时检查：PASS（${smoke.detail}）`,
            `模型自检回复：${smoke.reply}`,
            existing ? '说明：这是对已有自定义预设的更新。' : '说明：新预设已可用——新会话的预设选择器里会出现。',
          ].join('\n'),
        }],
        details: { id: r.preset.id, smokePass: true },
      }
    },
  }

  // 4) delete_preset：删除自定义预设文件夹（builtin 由底层拒绝）
  const deletePresetTool: AgentTool<any> = {
    name: 'delete_preset',
    label: '删除预设',
    description: '删除一个自定义 Agent 预设（删除其文件夹）。内置预设不可删除。',
    parameters: TbType.Object({
      id: TbType.String({ description: '预设 id' }),
    }),
    async execute(_c, params: any) {
      const err = deleteAgentPreset(String(params.id || ''))
      if (err) throw new Error(err)
      return {
        content: [{ type: 'text', text: `已删除预设 ${params.id}（文件夹已移除，预设已卸载）。` }],
        details: { id: params.id },
      }
    },
  }

  return [listToolsTool, readPresetTool, savePresetTool, deletePresetTool]
}
