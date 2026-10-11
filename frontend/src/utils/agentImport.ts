/* 「导入其他 agent 数据」的引导词 + 专属预设 id
 *
 * 为什么要单独一个文件：这段文案有两个消费者 ——
 *   ① 设置页「数据备份 → 导入其他 agent 数据」的开始导入流程（自动预填进新会话输入框）；
 *   ② 聊天页「导入助手」会话里的快捷输入按钮（自动预填万一没落地时的手动兜底）。
 * 两处必须字字一致，所以只能有一份真身。
 *
 * 0919 升级：快捷输入改成**先弹窗问软件名**，再由 buildAgentImportPrompt(name) 生成带名字的引导词
 * —— 用户不用再去提示词里找那个「？」改它。
 */

/** 弹窗里给的一键候选（都是常见 coding agent，可点了直接确定） */
export const AGENT_IMPORT_SUGGESTIONS = [
  'Cursor',
  'Claude Code',
  'Codex',
  'WorkBuddy',
  'ZCode',
  'OpenCode',
  'Hermes',
  'Windsurf',
  '通义灵码',
  'Trae',
]

/**
 * 生成导入引导词。
 * @param agentName 目标软件名；给了就把「要导入的 Agent：xxx」填好并去掉"请把？替换成…"那行提示；
 *                  没给则保留 `？` + 提示行（给"我没想好软件名"的情况兜底）。
 */
export function buildAgentImportPrompt(agentName = ''): string {
  const name = String(agentName || '').trim()
  const head = ['【导入其他 Agent 软件的数据】', '']
  if (name) {
    head.push(`要导入的 Agent：${name}`)
  } else {
    head.push(
      '（请把下面这行的「？」替换成你要导入的 Agent 名字，例如 Cursor / Claude Code / 通义灵码 / Windsurf）',
      '要导入的 Agent：？',
    )
  }
  return [
    ...head,
    '',
    '请你按这个流程帮我：',
    '1. 先在本机找到这个 Agent 的数据目录，摸清里面都有什么，例如（以你实际找到的为准）：',
    '   · 对话记录 / 会话历史',
    '   · 记忆文件（memory、MEMORY.md、用户画像等）',
    '   · 项目档案、进度文件、任务清单',
    '   · 技能 / 提示词 / 预设',
    '   · 各类 .md / .json / .db 配置与知识库',
    '   常见位置示意：%APPDATA%\\<软件名>、%LOCALAPPDATA%\\<软件名>、%USERPROFILE%\\Documents\\<软件名>、',
    '   以及它自己的工作目录。',
    '2. 把找到的东西整理成一份【清单】给我：每一类有多少条、大概是什么内容、你打算怎么放进',
    '   NIS 的对应位置（会话 → 对话记录；记忆 → 记忆/知识库；技能 → 技能库；项目档案 → 项目/工作区）。',
    '3. 等我确认后再动手；我说「都迁」就全迁，也可以只挑其中几类。',
    '4. 迁移时不要覆盖我现有的 NIS 数据；新迁入的东西单独归档，最后告诉我落在了哪里。',
  ].join('\n')
}


