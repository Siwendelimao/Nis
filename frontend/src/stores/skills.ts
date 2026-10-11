import { defineStore } from 'pinia'
import { ref } from 'vue'
import { localStore } from '@/utils/localStore'

/** 仓库内一个 skill 包（从外部下载/上传的 zip 入库后的条目） */
export interface SkillItem {
  id: string
  /** 技能名（zip 内 SKILL.md 的 name，或用户填的名称） */
  name: string
  /** 描述（SKILL.md 的 description，或用户填的） */
  description: string
  /** 来源标签：zip 导入 / 手动创建 */
  source: 'zip' | 'manual'
  /** 导入/创建时间 */
  createdAt: number
}

const STORAGE_KEY = 'nis-skills'

/** 预置技能（0915 用户要求：清掉仓库里的假数据 —— 之前塞了三条演示卡，看着像真装过技能）。
 *  现在默认空仓库，一切以后端/真实导入为准。 */
const PRESET_SKILLS: SkillItem[] = []

let skillSeq = 0
function nextSkillId(): string {
  skillSeq += 1
  return `skill_${Date.now().toString(36)}_${skillSeq}`
}

function loadSkills(): SkillItem[] {
  try {
    const raw = localStore.getItem(STORAGE_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((x: any) => x && typeof x.id === 'string')
    }
  } catch {
    /* ignore */
  }
  return PRESET_SKILLS.map(s => ({ ...s }))
}

/**
 * 技能仓库 —— 独立技能包清单（localStorage 持久化）。
 * 与「伙伴自带技能」无关：仓库存的是从外部下载/上传的 skill 包，
 * 入库后可被项目成员配置勾选使用。
 */
export const useSkillsStore = defineStore('skills', () => {
  const skills = ref<SkillItem[]>(loadSkills())

  function persist() {
    try {
      localStore.setItem(STORAGE_KEY, JSON.stringify(skills.value))
    } catch {
      /* ignore */
    }
  }

  function getSkill(id: string): SkillItem | undefined {
    return skills.value.find(s => s.id === id)
  }

  /** 新增一个技能条目（zip 解析成功后调用） */
  function addSkill(item: { name: string; description: string; source?: SkillItem['source'] }): SkillItem {
    const skill: SkillItem = {
      id: nextSkillId(),
      name: item.name.trim() || '未命名技能',
      description: item.description?.trim() || '',
      source: item.source || 'zip',
      createdAt: Date.now(),
    }
    // 同名称去重：已存在则返回已有
    const dup = skills.value.find(s => s.name === skill.name)
    if (dup) return dup
    skills.value.push(skill)
    persist()
    return skill
  }

  function removeSkill(id: string) {
    skills.value = skills.value.filter(s => s.id !== id)
    persist()
  }

  return {
    skills,
    getSkill,
    addSkill,
    removeSkill,
  }
})
