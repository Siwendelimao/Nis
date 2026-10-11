/**
 * 团队存储 —— 文件夹制落盘（可拆装 + 隔离），与 Agent 预设同心智。
 *
 * 目录：backend/data/teams/<id>/team.json
 * 结构：{ id, name, description, mainPreset, mode, blackboard, maxParallel, members[], createdAt }
 * 校验：成员 1-3；成员 preset 必须引用"自定义预设"（builtin 拒绝入队）；modelMode=independent 时 modelId 必填。
 * 首次启动：teams 目录为空时写入示例团队 software-dev-team（前端/后端/测试三人组）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { readAgentPreset } from './agentPresetsStore.ts'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'

export const TEAMS_DIR = path.join(DATA_ROOT, 'teams')

export interface TeamMember {
  id: string
  type: 'preset'
  preset: string
  role?: string
  modelMode: 'shared' | 'independent'
  modelId?: string
  /** 0910：成员独立模型的推理挡位（缺省 deep=原行为；后端 createStreamFn 按模型能力钳位） */
  effort?: string
  /** 0910 三批②：模型能力档位 fast/standard/strong/auto（auto=系统识别；供主 agent 匹配任务难度） */
  capability?: string
  /** 0910 三批③：该成员可同时派出的并行实例数（1-3，缺省 1=不并行） */
  maxInstances?: number
  skills?: string[]
  /** ★1005 补类型：成员自带显示名 —— 0925w 的修复（"分身显示成团队成员名/预设名"）就靠它显示
   *  「小螺丝 分身N」。运行时一直读得到，只是类型没声明（缺了就只能 `as any` 绕）。 */
  name?: string
}

export interface TeamDef {
  id: string
  name: string
  description: string
  mainPreset: string
  mode: 'auto' | 'serial' | 'parallel'
  blackboard: boolean
  maxParallel: number
  members: TeamMember[]
  createdAt?: number
}

const MODES = ['auto', 'serial', 'parallel']
/** 成员推理挡位白名单（与前端 ReasoningModeBtn/EffortSlider 的挡位值一致） */
const EFFORTS = ['fast', 'deep', 'heavy', 'burning']
/** 0910 三批②：成员模型能力档位（供主 agent 按任务难度匹配派活；auto=由系统按模型能力自动识别） */
const CAPABILITIES = ['fast', 'standard', 'strong', 'auto']
/** 0910 三批③：单成员同时派出实例数上限（用户拍板 1-3） */
const MAX_INSTANCES_LIMIT = 3
const MAX_MEMBERS = 8

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/

function teamPath(id: string): string {
  return path.join(TEAMS_DIR, id, 'team.json')
}

function sanitizeId(name: string): string {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return slug || 'team-' + Date.now().toString(36)
}

/** 校验（含成员预设白名单：必须引用自定义预设）。返回错误信息，null=合法 */
function validateTeam(t: any): string | null {
  if (!t || typeof t !== 'object') return 'team 必须是对象'
  if (typeof t.name !== 'string' || !t.name.trim()) return 'name 不能为空'
  if (t.mode !== undefined && !MODES.includes(t.mode)) return `mode 只能是 ${MODES.join('/')}`
  if (t.mainPreset !== undefined) {
    const mp = readAgentPreset(String(t.mainPreset))
    if (!mp) return `主 agent 预设不存在：${t.mainPreset}`
    if (!mp.builtin) return `主 agent 预设必须是内置预设（当前团队指挥官为内置 team-lead）`
  }
  if (!Array.isArray(t.members)) return 'members 必须是数组'
  if (t.members.length < 1) return '至少需要 1 名成员'
  if (t.members.length > MAX_MEMBERS) return `成员最多 ${MAX_MEMBERS} 名（防 token 爆炸）`
  const memberIds = new Set<string>()
  for (const m of t.members) {
    if (!m || typeof m !== 'object') return '成员必须是对象'
    if (m.id) {
      if (memberIds.has(m.id)) return '成员 id 重复'
      memberIds.add(m.id)
    }
    const preset = readAgentPreset(String(m.preset || ''))
    if (!preset) return `成员引用的预设不存在：${m.preset}`
    if (preset.builtin) return `内置预设「${preset.name}」不能作为团队成员——只能用自定义预设组队（可从内置复制）`
    if (m.modelMode === 'independent' && !String(m.modelId || '').trim()) {
      return `成员「${preset.name}」选择了独立模型，必须指定 modelId`
    }
    if (m.effort !== undefined && !EFFORTS.includes(String(m.effort))) {
      return `成员「${preset.name}」的推理挡位不合法：${m.effort}（可用 ${EFFORTS.join('/')}）`
    }
    if (m.capability !== undefined && !CAPABILITIES.includes(String(m.capability))) {
      return `成员「${preset.name}」的模型档位不合法：${m.capability}（可用 ${CAPABILITIES.join('/')}）`
    }
    if (m.maxInstances !== undefined && (!Number.isInteger(m.maxInstances) || m.maxInstances < 1 || m.maxInstances > MAX_INSTANCES_LIMIT)) {
      return `成员「${preset.name}」的同时派出上限必须是 1-${MAX_INSTANCES_LIMIT}`
    }
  }
  // 0910 三批③：并行总预算上限 6 → 8（用户拍板）；成员级 maxInstances 之和仍受这个总闸约束
  if (t.maxParallel !== undefined && (!Number.isInteger(t.maxParallel) || t.maxParallel < 1 || t.maxParallel > 8)) {
    return 'maxParallel 必须是 1-8'
  }
  return null
}

export function listTeams(): TeamDef[] {
  const out: TeamDef[] = []
  try {
    if (!fs.existsSync(TEAMS_DIR)) return out
    for (const d of fs.readdirSync(TEAMS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      try {
        const r = loadJsonOrBackup<any>(teamPath(d.name), () => null)
        if (r.degraded) console.error(`[teams] ${d.name}/team.json 坏档已备份为 .corrupt-*，已跳过（原档可捞）`)
        const t = r.data
        if (t && t.id === d.name) out.push(t)
      } catch { /* skip */ }
    }
  } catch (e) {
    console.error('[teams] list failed:', e)
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export function readTeam(id: string): TeamDef | null {
  if (!ID_RE.test(id)) return null
  try {
    const r = loadJsonOrBackup<any>(teamPath(id), () => null)
    const t = r.data
    return t && t.id === id ? t : null
  } catch {
    return null
  }
}

/** 保存（创建/更新）。id 为空时从 name 生成（保证唯一） */
export function saveTeam(input: any): { ok: true; team: TeamDef } | { ok: false; error: string } {
  let id = String(input?.id || '').trim()
  if (!id) {
    const base = sanitizeId(input?.name)
    let n = 1
    id = base
    while (readTeam(id)) id = `${base}-${++n}`
  }
  if (!ID_RE.test(id)) return { ok: false, error: 'id 不合法（2-48 位小写字母/数字/连字符）' }
  const existing = readTeam(id)
  const team: TeamDef = {
    id,
    name: String(input?.name || '未命名团队').trim().slice(0, 40),
    description: String(input?.description || '').trim().slice(0, 200),
    mainPreset: String(input?.mainPreset || 'team-lead'),
    mode: MODES.includes(input?.mode) ? input.mode : 'auto',
    blackboard: input?.blackboard !== false,
    maxParallel: Number.isInteger(input?.maxParallel) ? input.maxParallel : 3,
    members: Array.isArray(input?.members) ? input.members : [],
    createdAt: existing?.createdAt || Date.now(),
  }
  // 成员补 id
  team.members = team.members.map((m, i) => ({ ...m, id: m.id || `m${i + 1}` }))
  const err = validateTeam(team)
  if (err) return { ok: false, error: err }
  try {
    fs.mkdirSync(path.dirname(teamPath(id)), { recursive: true })
    writeJsonAtomic(teamPath(id), team)
    return { ok: true, team }
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
}

export function deleteTeam(id: string): string | null {
  if (!ID_RE.test(id)) return 'id 不合法'
  const dir = path.join(TEAMS_DIR, id)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return null
  } catch (e: any) {
    return `删除失败：${e?.message || e}`
  }
}

/** 首次启动：teams 目录为空时写入示例团队（前端/后端/测试三人组，可编辑或删除） */
export function initTeams(): void {
  try {
    fs.mkdirSync(TEAMS_DIR, { recursive: true })
    if (listTeams().length > 0) return
    const sample = {
      id: 'software-dev-team',
      name: '软件开发小组',
      description: '示例团队：前端/后端/测试三人组，适合网站与软件产品开发。主指挥官拆解需求，前端与后端并行实现，测试工程师最后验收。',
      mainPreset: 'team-lead',
      mode: 'auto',
      blackboard: true,
      maxParallel: 3,
      members: [
        { id: 'm1', type: 'preset', preset: 'frontend-dev', role: '', modelMode: 'shared', modelId: '', skills: [] },
        { id: 'm2', type: 'preset', preset: 'backend-dev', role: '', modelMode: 'shared', modelId: '', skills: [] },
        { id: 'm3', type: 'preset', preset: 'qa-tester', role: '', modelMode: 'shared', modelId: '', skills: [] },
      ],
      createdAt: Date.now(),
    }
    fs.mkdirSync(path.dirname(teamPath(sample.id)), { recursive: true })
    fs.writeFileSync(teamPath(sample.id), JSON.stringify(sample, null, 2) + '\n', 'utf-8')
    console.log(`[teams] seeded sample team: ${sample.id}`)
  } catch (e) {
    console.error('[teams] init failed:', e)
  }
}
