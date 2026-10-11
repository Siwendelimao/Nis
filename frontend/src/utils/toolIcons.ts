/**
 * 工具图标/过程态共享源（0904 反馈①）——对话过程块（ToolPartBlock）与「工具」页仓库卡片
 * 同源的单一出处：lucide 线性图标按工具名映射；有"过程态+完成态"两态的工具
 * （非瞬时类）在过程态用同款动画组件（终端打字/风车/四色条纹）。
 *
 * ToolPartBlock 改为 import 本模块（行为不变）；PluginsModal 卡片渲染
 * 过程态动画（running icon）或完成态线性图标，与对话所见一致。
 */
import { Circle, Terminal, FileText, FileEdit, Trash2, MessageCircle, Search, Brain, BookOpen, BookPlus, NotebookPen, Globe, Settings, MousePointer2, Image as ImageIcon, Github, AppWindow, WandSparkles, Wrench, PackagePlus, PackageMinus, ShieldCheck, ListChecks, Plug, Unplug, Save, List, Users, UsersRound, Target, Crosshair, Timer, Square, History, RotateCcw, AlarmClock, GitBranch } from 'lucide-vue-next'

import type { Component } from 'vue'
import { familyActionTool } from './toolClassifier'
import Pinwheel from '../components/blocks/Pinwheel.vue'
import TerminalLoader from '../components/blocks/TerminalLoader.vue'
import StripeLoader from '../components/blocks/StripeLoader.vue'
import CrosshairLoader from '../components/blocks/CrosshairLoader.vue'
import SearchScanLoader from '../components/blocks/SearchScanLoader.vue'

/** 工具名 → 完成态线性图标（mcp__ 前缀统一 Plug；未知回退圆点） */
export const TOOL_ICONS: Record<string, Component> = {
  run_command: Terminal,
  python_run: Terminal,
  fs_read: FileText,
  fs_grep: Search,
  file_search: FileText,
  fs_write: FileEdit,
  fs_edit: Crosshair,
  project_note: FileEdit,
  fs_delete: Trash2,
  ask_user: MessageCircle,
  load_tools: PackagePlus,
  // ★ 0929 批次A：列目录 / 文件时光机 / 定时任务（含按动作分流图标）
  list_dir: List,
  history: History,
  history_list: History,
  history_restore: RotateCcw,
  history_stat: ListChecks,
  schedule: AlarmClock,
  schedule_create: AlarmClock,
  schedule_list: ListChecks,
  schedule_update: Settings,
  schedule_remove: Trash2,
  schedule_run_now: Timer,
  // ★ 0929 批次B：git 族（过程态=终端打字，故不进 INSTANT）
  git: GitBranch,
  git_status: ListChecks,
  git_diff: Crosshair,
  git_log: History,
  git_commit: Save,
  // ★ 0929 批次C：仓库地图/语义搜索
  repo: Search,
  repo_map: List,
  repo_search: Search,
  repo_build: Save,
  memory_search: Search,
  web_search: Globe,
  browser_navigate: Search,
  web_fetch: AppWindow,
  github_search: Github,
  browser_click: MousePointer2,
  memory_store: Brain,
  memory_distill: Brain,
  memory_delete: Trash2,
  knowledge_query: BookOpen,
  knowledge_add: BookPlus,
  knowledge_delete: Trash2,
  // 用户记事本（0920）
  notebook_list: NotebookPen,
  notebook_add: NotebookPen,
  notebook_update: NotebookPen,
  notebook_delete: Trash2,
  // 后台任务（0921 接线：bg_start/bg_list/bg_read/bg_stop）
  bg_start: Timer,
  bg_list: List,
  bg_read: FileText,
  bg_stop: Square,
  bg_watch: Timer,
  bg_note: NotebookPen,
  // ★ 0929 刀①：家族级兜底图标（有 action 时归一到上面的旧名图标）
  bg: Timer,
  notebook: NotebookPen,
  memory: Brain,
  knowledge: BookOpen,

  generate_image: ImageIcon,
  settings_update: Settings,
  plugin_run: Wrench,
  skill_run: Wrench,
  use_skill: WandSparkles,
  // 特殊工具：安装/预设
  install_skill: PackagePlus,
  uninstall_skill: PackageMinus,
  scan_skill: ShieldCheck,
  list_installed: ListChecks,
  install_mcp: Plug,
  uninstall_mcp: Unplug,
  save_preset: Save,
  delete_preset: Trash2,
  list_tools: List,
  read_preset: FileText,
  run_code: Terminal,
  // 自定义工具管理（创造模式专属）
  list_custom_tools: List,
  save_custom_tool: Save,
  delete_custom_tool: Trash2,
  // 计划本
  plan_write: List,
  // 团队运行时
  team_dispatch: Users,
  /* ★ 0925w（产品要求"分身小人 icon"）：spawn_clone=多个自己 → lucide UsersRound（圆头双人） */
  spawn_clone: UsersRound,
  bb_goal: Target,
  bb_write: Save,
  bb_read: BookOpen,
  team_info: Users,
  sub_plan: ListChecks,
  // 项目自我修改（升级模式专属：project_fs_* 绑定 NIS 源码根）
  project_fs_read: FileText,
  project_fs_grep: Search,
  project_fs_write: FileEdit,
  project_fs_edit: Crosshair,
  project_fs_delete: Trash2,
  project_run_command: Terminal,
}

export function toolIconComponent(toolName: string, input?: Record<string, any> | null): Component {
  const n = familyActionTool(toolName, input)   // ★ 0929 刀①：家族工具按动作分流图标（bg start=Timer…观感与合并前一致）
  if (n.startsWith('mcp__')) return Plug
  return TOOL_ICONS[n] || Circle
}

/** 瞬时完成工具（毫秒级返回）：直接完成态，无过程动画——与 ToolPartBlock 判定同源 */
const INSTANT_TOOLS = ['github_search', 'use_skill', 'fs_read', 'fs_delete', 'memory_search', 'memory_store', 'memory_delete', 'knowledge_query', 'knowledge_add', 'knowledge_delete', 'notebook_list', 'notebook_add', 'notebook_update', 'notebook_delete', 'settings_update', 'bb_goal', 'bb_write', 'bb_read', 'team_info', 'sub_plan', 'bg_start', 'bg_list', 'bg_read', 'bg_stop', 'bg_watch', 'bg_note', 'load_tools', 'list_dir', 'history', 'history_list', 'history_restore', 'history_stat', 'schedule', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_remove', 'schedule_run_now', 'git_status', 'git_commit', 'repo_map',
  // ★ 0929 刀①：家族名兜底（有 action 时先归一到旧名单——旧名单语义不变；家族名只兜"无 action"的目录展示）
  'bg', 'notebook', 'memory', 'knowledge']
// ↑ bg_* 全部"不阻塞"（bg_start 立刻返回 task_id）→ 走完成态，不套终端打字过程动画；
//   bg_start 的 variant 是 bash，若不登记会被 isShellVariant 截胡成假的"正在打字"

const WEB_LIKE_TOOLS = ['web_search', 'web_fetch', 'browser_navigate', 'browser_click']
export function isInstantTool(toolName: string, input?: Record<string, any> | null): boolean { return INSTANT_TOOLS.includes(familyActionTool(toolName, input)) }
function isWebLikeTool(toolName: string): boolean { return WEB_LIKE_TOOLS.includes(toolName) }
/** shell 类（bash/code/edit 变体）用终端打字动画；判定入参是 variant */
export function isShellVariant(variant: string): boolean { return variant === 'bash' || variant === 'code' || variant === 'edit' }

/** 该工具是否有"过程态≠完成态"的专用动画（终端打字/风车/条纹）——工具页卡片据此决定悬停是否切动画。 */
export function hasRunningAnim(toolName: string, variant: string, input?: Record<string, any> | null): boolean {
  return toolRunningLoader(toolName, variant, input) !== null
}

/** 过程态动画组件（非瞬时工具才有过程态）：shell→终端打字 / fs_write→风车 / 搜索类→四色条纹 / 浏览→条纹。
 *  返回 null = 该工具无专用动画（过程态是"线性图标+脉冲"）。带各动画的原尺寸。 */
export function toolRunningLoader(toolName: string, variant: string, input?: Record<string, any> | null): { comp: Component; size: number } | null {
  const n = familyActionTool(toolName, input)   // ★ 0929 刀①：家族工具按动作归一（bg start=瞬时、memory distill=有过程态，与合并前一致）
  if (isInstantTool(n)) return null
  // ⚠️ 必须排在 isShellVariant 之前：fs_edit 的 variant 是 'edit'，会被 shell 分支截胡成「终端打字」
  // （与 run_command 撞脸，用户明确要求区分）——给它专属的「瞄准镜」动画。
  if (n === 'fs_edit' || n === 'project_fs_edit') return { comp: CrosshairLoader, size: 16 }
  if (isShellVariant(variant)) return { comp: TerminalLoader, size: 16 }
  if (n === 'fs_write' || n === 'project_fs_write') return { comp: Pinwheel, size: 16 }
  // fs_grep：扫描整目录可能几秒，给真正的过程态 —— 0925 需求要求：条纹流动 → 放大镜循环扫视
  // （完成态是放大镜线性图标，过程态同一个放大镜左右扫视，两态同语言）
  if (n === 'fs_grep' || n === 'project_fs_grep') return { comp: SearchScanLoader, size: 14 }
  // ★ 0929 按设计表补课：扫描类=放大镜扫视（同 fs_grep 两态同语言）；建索引重活=条纹流动（"在扫"的实感）
  if (n === 'git_diff' || n === 'git_log' || n === 'repo_search') return { comp: SearchScanLoader, size: 14 }
  if (n === 'repo_build') return { comp: StripeLoader, size: 14 }
  if (isWebLikeTool(n)) return { comp: StripeLoader, size: 14 }
  return null
}
