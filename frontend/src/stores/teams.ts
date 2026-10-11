import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useChatStore } from './chat'

/**
 * 团队 store —— 多 Agent 协作的配置层（P1）。
 * 数据源：后端 teams.* RPC（文件夹化存储 backend/data/teams/<id>/team.json，可拆装）。
 * 编排运行时为 P2；P1 阶段选团队对话 = 主预设（team-lead）单 agent 正常聊天。
 */

export interface TeamMember {
  id: string
  type: 'preset'
  preset: string
  /** 职责覆盖（默认继承预设 description） */
  role?: string
  /** shared=跟随对话模型；independent=独立模型（modelId 必填） */
  modelMode: 'shared' | 'independent'
  modelId?: string
  skills?: string[]
}

export interface Team {
  id: string
  name: string
  description?: string
  /** 主 agent 预设 id（默认 team-lead，内置指挥官） */
  mainPreset: string
  /** auto（默认，按依赖图混合编排）| serial | parallel */
  mode: 'auto' | 'serial' | 'parallel'
  blackboard: boolean
  maxParallel: number
  members: TeamMember[]
  createdAt?: number
}

export const useTeamsStore = defineStore('teams', () => {
  const teams = ref<Team[]>([])
  const ready = ref(false)

  async function load() {
    try {
      const chatStore = useChatStore()
      const v = await chatStore.bridgeRpc('teams.list')
      if (Array.isArray(v?.teams)) teams.value = v.teams
      ready.value = true
    } catch {
      teams.value = []
    }
  }

  /** 新建/保存团队（id 为空=从 name 生成）；失败抛错（UI 显示） */
  async function saveTeam(team: Partial<Team>): Promise<Team> {
    const chatStore = useChatStore()
    const v = await chatStore.bridgeRpc('teams.save', { team })
    await load()
    return v.team as Team
  }

  async function removeTeam(id: string): Promise<void> {
    const chatStore = useChatStore()
    await chatStore.bridgeRpc('teams.delete', { id })
    await load()
  }

  return { teams, ready, load, saveTeam, removeTeam }
})
