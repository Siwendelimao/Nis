/**
 * 便签的 AI 工具（0920）—— 让 AI 能读写用户的那本便签（原名"用户记事本"）。
 *
 * 与记忆/知识库的区别（AI 需要分得清）：
 *   记忆 = 我该记住的长期信息；知识库 = 资料收藏；
 *   **便签 = 用户要我办的事 / 用户自己的待办清单**，是要被"盯进度"的，
 *   所以状态（待办/搁置/已完成/取消）是它的一等公民。
 *
 * 工具清单：notebook_list / notebook_add / notebook_update / notebook_delete
 * （工具名沿用 notebook_* —— 预设里存的是名字，改了会让存量预设对不上；中文名走 label）
 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { buildFamilyTool } from './familyTool.ts'
import {
  notebookList, notebookAdd, notebookUpdate, notebookRemove, notebookCounts,
  formatNotebook, STATUS_LABEL,
} from './notebookStore.ts'

/* ★ 0923：状态新增 pending（待拍板）/ testing（待测），并把"AI 接活后怎么流转"写成硬约定 ——
   否则 AI 只会写 todo、改完也不会自己往 testing 推（反馈的核心诉求）。 */
/* ★ 0924（反馈"便签看着很懵"）：便签 = **用户的待办本**，不是 AI 的工作日志。
   把"何时才该写"写成硬门槛 —— 否则 AI 会把自己干的活（已修复 / 待验收 / 诊断结论 / 进度）
   一股脑记进去，用户点开一看全是"AI 的流水账"。 */
/* ★ 0925（用户再纠错"当前在做的任务也被你写进便签了"）：把写入时机细化成黑白两条单子 ——
   便签的本质是**人机互联**：记"用户自己的待办与推迟决策"，不复读"当场派的活"。 */
const WRITE_POLICY =
  '【什么情况必须主动记（用户没说"记一下"也要记）】' +
  '① 用户明确**推迟/暂缓**："这周不方便测，下周再试""先放放""等通知"——把用户的推迟决策落成待办；' +
  '② 用户明确**排序/分批**："先做 A，B 等 A 完再说""这个优先级低，往后排"；' +
  '③ 用户说的事情本身就是"以后要做的一件事"（"下周要 X""回头记得 Y"）；' +
  '④ 用户明确要求记录（"记一下""帮我记个待办""别忘了…"）。' +
  '【什么情况绝不主动记】' +
  '① **用户当场派的活**（"改一下这个 bug""把这个做了"）—— 直接干，干完在对话里汇报即可，不写便签；' +
  '② 你自己完成的工作 / 修复结果 / 诊断结论 / 进度汇报（用 project_note 记档或对话里说）；' +
  '③ 用户只是在问问题、聊需求（还没定要做什么）；纯查询的结果。' +
  '【当前任务与便签条目联动】用户当场派的活如果**本来就是便签里的条目**（用户在便签列过的），' +
  '不新建——推进时用 action=update 改那条的状态即可（如做完置 testing）。' +
  '【★ 动笔前必须先查重（强制，不可跳过）】调用 action=add（记一条）**之前**，必须先 action=list（读便签）' +
  '（可带 keyword 过滤）看一遍便签里有没有相关条目：**只要有相关条目（哪怕标题只有一半对得上、' +
  '状态是 done/cancelled 但事情又回来了），就用 action=update 改那条，绝对不准另起一条**；' +
  '确实没有任何相关条目，才允许 action=add。' +
  '条目越少越清晰，用户最怕"一堆 AI 自己加的条目"和重复条目。'

const STATUS_HINT =
  '状态取值：todo（待办，默认）/ pending（待拍板：等用户决策才能继续）/ testing（待测：已改完、等用户验证）' +
  '/ hold（搁置）/ done（已完成）/ cancelled（取消）。' +
  '【写入硬门槛】便签是**用户的待办本**，不是 AI 工作日志：只有"用户明确要求记"或"用户说的事本身就是以后要做的一件事"才写；' +
  '你自己干的活（修复 / 验收 / 诊断 / 进度）别写进来；已有相关条目时优先 action=update 改它，而不是新建。' +
  '【工作流约定·必须遵守】（**仅适用于便签里已存在的条目**，不是"见到一件事就先记一条"的许可）' +
  '① 从便签接活、动手之前，先把该条置 todo；' +
  '② 代码/方案改完但需要用户验证时，**自己主动**置 testing，并在 detail 里补一句"改了哪些文件、怎么验证"；' +
  '③ 卡在需要用户拍板的选择上时置 pending，并把待决策的问题写进 detail；' +
  '④ 用户确认通过后再置 done。'

/** notebook_list：读便签（AI 接手前先看一眼有没有相关待办） */
function buildNotebookListTool(): AgentTool<any> {
  return {
    name: 'notebook_list',
    label: '读便签',
    description:
      '读取用户的便签（用户与 AI 共用的一本待办/便签清单）。' +
      '用户问"我的便签里有什么/有几件事没做"、或你要接手一件事之前，先用它看一眼，' +
      '避免重复记、也能顺着已有条目继续办。' + STATUS_HINT,
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: '按状态过滤：todo / pending / testing / hold / done / cancelled / all（默认 all）' })),
      keyword: Type.Optional(Type.String({ description: '按关键词过滤标题/详情/标签（可选）' })),
    }),
    async execute(_callId, params: any) {
      const items = notebookList({ status: params?.status || 'all', keyword: params?.keyword || '' })
      const c = notebookCounts()
      const head = `便签共 ${c.todo + c.pending + c.testing + c.hold + c.done + c.cancelled} 条：`
        + `待办 ${c.todo}｜待拍板 ${c.pending}｜待测 ${c.testing}｜搁置 ${c.hold}｜已完成 ${c.done}｜取消 ${c.cancelled}`
      return {
        content: [{ type: 'text', text: `${head}\n\n${formatNotebook(items)}` }],
        details: { count: items.length, counts: c },
      }
    },
  }
}

/** notebook_add：往便签里记一条 */
function buildNotebookAddTool(): AgentTool<any> {
  return {
    name: 'notebook_add',
    label: '记到便签',
    description:
      '往用户的便签里记一条。**先过写入硬门槛**（见下），不是张口就记。' +
      WRITE_POLICY +
      'title 写一句能一眼看懂的事，detail 放背景/来源/具体要求（用户点开条目才看得到）。' +
      '记完回报条目 id，后续可以 notebook_update 改状态。' + STATUS_HINT,
    parameters: Type.Object({
      title: Type.String({ description: '标题：一句话说清要办什么事' }),
      detail: Type.Optional(Type.String({ description: '详情：背景、来源、具体要求（用户展开条目时显示）' })),
      status: Type.Optional(Type.String({ description: '初始状态，默认 todo（"要用户拍板的计划"记 pending，"改完待验的"记 testing）' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: '标签（可选）' })),
    }),
    async execute(_callId, params: any) {
      const item = notebookAdd({
        title: params?.title,
        detail: params?.detail || '',
        status: params?.status,
        source: 'ai',
        tags: params?.tags,
      })
      return {
        content: [{ type: 'text', text: `已记到便签【${STATUS_LABEL[item.status]}】【id=${item.id}】${item.title}` }],
        details: { item },
      }
    },
  }
}

/** notebook_update：改状态 / 改内容 */
function buildNotebookUpdateTool(): AgentTool<any> {
  return {
    name: 'notebook_update',
    label: '更新便签',
    description:
      '修改便签里的条目（改状态、补详情、改标题）。用户说"这个办完了""先搁置""取消掉"时用。' +
      '需要 id（notebook_list 返回值里带）。只传要改的字段，其余保持不变。' + STATUS_HINT,
    parameters: Type.Object({
      id: Type.String({ description: '条目 id（notebook_list 返回的 id）' }),
      status: Type.Optional(Type.String({ description: '新状态：todo / pending / testing / hold / done / cancelled（改完等验证 → testing；等用户拍板 → pending）' })),
      title: Type.Optional(Type.String({ description: '新标题（可选）' })),
      detail: Type.Optional(Type.String({ description: '新详情（可选，整体替换）' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: '新标签（可选，整体替换）' })),
    }),
    async execute(_callId, params: any) {
      const id = String(params?.id || '')
      const item = notebookUpdate(id, {
        title: params?.title,
        detail: params?.detail,
        status: params?.status,
        tags: params?.tags,
      })
      if (!item) throw new Error(`便签里没有 id=${id} 的条目（先用 notebook_list 查一下）`)
      return {
        content: [{ type: 'text', text: `已更新【${STATUS_LABEL[item.status]}】【id=${item.id}】${item.title}` }],
        details: { item },
      }
    },
  }
}

/** notebook_delete：删条目 */
function buildNotebookDeleteTool(): AgentTool<any> {
  return {
    name: 'notebook_delete',
    label: '删便签条目',
    description:
      '从便签里删掉一条（彻底删除）。用户说"这条删了""不用记着了"时用。' +
      '如果只是不想做了，**优先用 notebook_update 置为 cancelled 或 hold**（留痕，用户还能翻到）；' +
      '只有用户明确要删才用本工具。',
    parameters: Type.Object({
      id: Type.String({ description: '条目 id（notebook_list 返回的 id）' }),
    }),
    async execute(_callId, params: any) {
      const id = String(params?.id || '')
      const ok = notebookRemove(id)
      if (!ok) throw new Error(`便签里没有 id=${id} 的条目`)
      return {
        content: [{ type: 'text', text: `已从便签删除 [id=${id}]` }],
        details: { id },
      }
    },
  }
}

/** 便签工具集（随 Agent 会话挂载）—— ★ 0929 刀①：4 个 notebook_* 合并成 1 个 notebook(action=…) */
export function buildNotebookTools(): AgentTool<any>[] {
  const subs = [
    buildNotebookListTool(),
    buildNotebookAddTool(),
    buildNotebookUpdateTool(),
    buildNotebookDeleteTool(),
  ] as any[]
  return [buildFamilyTool({
    name: 'notebook',
    label: '便签',
    group: '便签',
    variant: 'write',
    tab: 'special',
    fullMemberDescriptions: false,   // 共享纪律（WRITE_POLICY/STATUS_HINT）只放一份，防 4 倍重复
    description:
      '便签工具箱（一个工具四个动作）：读/记/改/删用户的那本便签。'
      + '【分清】记忆 = 我该记住的长期信息；知识库 = 资料收藏；**便签 = 用户要我办的事 / 用户自己的待办清单**，'
      + '是要被"盯进度"的，状态（待办/搁置/已完成/取消）是一等公民。'
      + WRITE_POLICY + STATUS_HINT,
    members: [
      { action: 'list', tool: subs[0], summary: '读便签（可按状态/关键词过滤），接活前先看' },
      { action: 'add', tool: subs[1], required: ['title'], summary: '记一条（动笔前必须先 list 查重）' },
      { action: 'update', tool: subs[2], required: ['id'], summary: '改条目状态/标题/详情' },
      { action: 'delete', tool: subs[3], required: ['id'], summary: '彻底删一条（不做了优先置 cancelled/hold）' },
    ],
  })]
}


