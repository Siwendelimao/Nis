/**
 * 自定义工具 —— 用户/AI 完全自定义的 agent 工具（高风险）。
 *
 * 存储：backend/data/custom-tools/<name>/tool.json
 *   { name, description, parameters(JSON Schema), code, createdAt }
 * 执行：code 为 async 函数体，参数名 args；可 await fetch / await sleep(ms)（注入白名单能力）。
 * 隔离：跑在 node:vm 独立 realm（见 toolSandbox.ts）——无 process / require / eval，
 *       注入函数经沙箱内包装，宿主构造器不可攀。vm 非硬安全边界，审批卡仍是主防线。
 * 安全：执行一律视为高风险（每次必弹权限卡，"当前会话允许"不适用）；
 *       管理工具（save/delete/list）锁死给 toolsets 含 custom-tools 的预设（创造模式）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic, loadJsonOrBackup } from './jsonStore.ts'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type as TbType } from 'typebox'
import { DATA_ROOT } from './paths.ts'
import { checkToolCodeSyntax, runSandboxedToolCode, ToolSandboxError } from './toolSandbox.ts'

const CUSTOM_TOOLS_DIR = path.join(DATA_ROOT, 'custom-tools')

export interface CustomToolDef {
  name: string
  description: string
  /** JSON Schema（OpenAI function parameters 格式） */
  parameters: any
  /** async 函数体：return 结果；可用 fetch / console */
  code: string
  createdAt?: number
}

const NAME_RE = /^[a-z0-9_]{2,40}$/

function toolPath(name: string): string {
  return path.join(CUSTOM_TOOLS_DIR, name, 'tool.json')
}

/** 校验定义（含代码语法试编译） */
function validateCustomTool(t: any): string | null {
  if (!t || typeof t !== 'object') return 'tool 必须是对象'
  if (typeof t.name !== 'string' || !NAME_RE.test(t.name)) return 'name 必须是 2-40 位小写字母/数字/下划线'
  if (typeof t.description !== 'string' || !t.description.trim()) return 'description 不能为空'
  if (t.description.length > 500) return 'description 过长（>500）'
  if (typeof t.code !== 'string' || !t.code.trim()) return 'code 不能为空'
  if (t.code.length > 20000) return 'code 过长（>20000 字符）'
  if (t.parameters !== undefined) {
    try {
      const p = typeof t.parameters === 'string' ? JSON.parse(t.parameters) : t.parameters
      if (!p || typeof p !== 'object' || p.type !== 'object') return 'parameters 必须是 {"type":"object",...} 形式的 JSON Schema'
    } catch {
      return 'parameters 不是合法 JSON'
    }
  }
  // 代码语法试编译（vm.Script 仅 parse，不执行、不进任何全局作用域）
  const synErr = checkToolCodeSyntax(t.code)
  if (synErr) return `代码语法错误：${synErr}`
  return null
}

function readCustomTool(name: string): CustomToolDef | null {
  if (!NAME_RE.test(name)) return null
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 回落 null（正常：工具未安装）；
     内容损坏先备份 .corrupt-* 再回落 null + 明确日志（旧逻辑：损坏也静默 return null，
     自定义工具从列表无声消失，用户以为被删了）。 */
  const r = loadJsonOrBackup<any>(toolPath(name), () => null)
  return (r.data && typeof r.data === 'object') ? (r.data as CustomToolDef) : null
}

export function listCustomTools(): CustomToolDef[] {
  const out: CustomToolDef[] = []
  try {
    if (!fs.existsSync(CUSTOM_TOOLS_DIR)) return out
    for (const d of fs.readdirSync(CUSTOM_TOOLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const t = readCustomTool(d.name)
      if (t && t.name === d.name) out.push(t)
    }
  } catch (e) {
    /* ★ 0927 第 0 批：目录扫描失败必须可见（旧逻辑静默 ignore——读失败时工具列表
       无声变空，用户以为工具被删了）。容错继续（返回已扫到的）但问题要暴露。 */
    console.error('[customTools] list failed:', e)
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export function saveCustomTool(input: CustomToolDef): { ok: true; tool: CustomToolDef } | { ok: false; error: string } {
  /* ★1003 批次4 4.8：parameters **归一化后再校验+落盘** —— 原来校验吃的是 parse 后的副本、
   * 落盘存的却是原始值：JSON 字符串形式（validate 明确允许）被原样存下，后续
   * getCustomAgentTools 把字符串当 OpenAI function schema 交给 agent（工具调用必炸）、
   * list_custom_tools 静默显示 [] 参数。校验与存储必须是同一个值。 */
  let parameters: any = input.parameters
  if (typeof parameters === 'string') {
    try { parameters = JSON.parse(parameters) } catch (e: any) {
      return { ok: false, error: `parameters 不是合法 JSON：${String(e?.message || e).slice(0, 120)}` }
    }
  }
  if (!parameters || typeof parameters !== 'object') parameters = { type: 'object', properties: {} }
  const normalized: CustomToolDef = { ...input, parameters }
  const err = validateCustomTool(normalized)
  if (err) return { ok: false, error: err }
  const tool: CustomToolDef = {
    name: normalized.name,
    description: normalized.description.trim(),
    parameters: normalized.parameters,
    code: normalized.code,
    createdAt: Date.now(),
  }
  try {
    fs.mkdirSync(path.dirname(toolPath(tool.name)), { recursive: true })
    /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）替换裸 writeFileSync */
  writeJsonAtomic(toolPath(tool.name), tool)
    return { ok: true, tool }
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
}

export function deleteCustomTool(name: string): string | null {
  if (!NAME_RE.test(name)) return 'name 不合法'
  try {
    const dir = path.join(CUSTOM_TOOLS_DIR, name)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return null
  } catch (e: any) {
    return `删除失败：${e?.message || e}`
  }
}

/** 全部自定义工具 → AgentTool（name=custom_<name>；高风险：执行由审批门禁强制拦截） */
export function getCustomAgentTools(): AgentTool<any>[] {
  return listCustomTools().map(def => ({
    name: `custom_${def.name}`,
    label: def.name,
    description: `【自定义·高风险】${def.description}`,
    parameters: def.parameters || { type: 'object', properties: {} },
    execute: async (_callId: string, args: any) => {
      try {
        // 0911：改走 node:vm 隔离沙箱（原 AsyncFunction 可直接摸到 process/环境变量）
        const result = await runSandboxedToolCode(def.code, args || {})
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2)
        return { content: [{ type: 'text', text: text.slice(0, 8000) }], details: { ok: true, tool: def.name, sandboxed: true } }
      } catch (e: any) {
        const kind = e instanceof ToolSandboxError ? '沙箱' : ''
        throw new Error(`自定义工具 ${def.name} 执行失败${kind ? `（${kind}）` : ''}：${String(e?.message || e).slice(0, 300)}`)
      }
    },
  }))
}

/** 管理工具集（锁死给创造模式：toolsets 含 custom-tools） */
export function buildCustomToolAdminTools(): AgentTool<any>[] {
  const listTool: AgentTool<any> = {
    name: 'list_custom_tools',
    label: '列出自定义工具',
    description: '列出全部用户自定义工具（名称/描述/参数）。',
    parameters: TbType.Object({}),
    async execute() {
      const all = listCustomTools()
      /* ★1005 修真 bug：原来空列表分支给的是**字符串**，下面却统一调 lines.join() ⇒
         `list_custom_tools` 在"用户还没有自定义工具"（最常见的情形）时**必抛 TypeError**。
         这个错一直躺在 tsc"历史噪音"里（TS2339: Property 'join' does not exist on type 'string[] | "…"'）。
         修法：让两条分支都返回数组。 */
      const lines = all.length
        ? all.map(t => `- ${t.name}: ${t.description}（参数：${JSON.stringify(t.parameters?.properties ? Object.keys(t.parameters.properties) : [])}）`)
        : ['（暂无自定义工具）']
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: all.length } }
    },
  }
  const saveTool: AgentTool<any> = {
    name: 'save_custom_tool',
    label: '保存自定义工具',
    description: '创建/更新一个自定义工具（高风险：执行时必弹权限卡）。code 为 async 函数体（参数名 args），可 await fetch 调外部接口，return 结果对象或字符串。parameters 为 JSON Schema 对象。',
    parameters: TbType.Object({
      name: TbType.String({ description: '工具名（2-40 位小写字母/数字/下划线）' }),
      description: TbType.String({ description: '工具用途描述（agent 据此判断何时调用）' }),
      parameters: TbType.Optional(TbType.String({ description: 'JSON Schema 字符串，如 {"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}' })),
      code: TbType.String({ description: 'async 函数体代码，如：const r = await fetch(args.url); return await r.text()' }),
    }),
    async execute(_c, params: any) {
      const input: any = {
        name: String(params.name || ''),
        description: String(params.description || ''),
        code: String(params.code || ''),
      }
      if (params.parameters) {
        try { input.parameters = typeof params.parameters === 'string' ? JSON.parse(params.parameters) : params.parameters } catch {
          throw new Error('parameters 不是合法 JSON')
        }
      }
      const err = validateCustomTool(input)
      if (err) throw new Error(`校验失败：${err}`)
      const r = saveCustomTool(input)
      if (!r.ok) throw new Error(r.error)
      return { content: [{ type: 'text', text: `自定义工具「${r.tool.name}」已保存（高风险：所有 agent 调用它时都会先弹权限卡）。` }], details: { ok: true, name: r.tool.name } }
    },
  }
  const deleteTool: AgentTool<any> = {
    name: 'delete_custom_tool',
    label: '删除自定义工具',
    description: '删除一个自定义工具（文件夹移除，立即对所有 agent 失效）。',
    parameters: TbType.Object({
      name: TbType.String({ description: '工具名' }),
    }),
    async execute(_c, params: any) {
      const err = deleteCustomTool(String(params.name || ''))
      if (err) throw new Error(err)
      return { content: [{ type: 'text', text: `自定义工具「${params.name}」已删除。` }], details: { ok: true } }
    },
  }
  return [listTool, saveTool, deleteTool]
}
