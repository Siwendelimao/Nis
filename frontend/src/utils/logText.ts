import { t, useI18n } from './i18n'

/**
 * 运行日志本地化（0911 反馈：日志面板内容不随语言切换）。
 *
 * 背景：运行面板的日志文本由后端生成（backend/server.ts 的 sessionLog，
 * 中文模板串），历史记录已落盘为中文。后端不持有 UI 语言，故本地化放在前端。
 *
 * 策略：按"后端模板形态"做有序规则匹配（长/具体规则在前，通用在后），
 * 命中即用 i18n 字典渲染；未命中的消息原样输出（优雅降级 —— 宁可显示中文，
 * 也不显示 key 或空串）。
 *
 * ⚠️ 维护约定：改动 backend/server.ts 里 sessionLog 的文案后，需同步本表；
 * 新增日志若未覆盖，中文会原样透出，不会报错。
 */

type Params = Record<string, string | number>
type Rule = {
  re: RegExp
  key: string
  /** 从正则捕获组映射到字典参数（缺省时按位置自动映射 g1..gN） */
  map?: (m: RegExpMatchArray) => Params
}

/** 位置捕获组自动映射：g1 → { g1: m[1], ... } */
function g(m: RegExpMatchArray): Params {
  const o: Params = {}
  for (let i = 1; i < m.length; i++) o['g' + i] = m[i] ?? ''
  return o
}

/** 后端用 '未知' 兜底工具名，英文态需一并翻 */
const toolName = (s: string) => (s === '未知' ? t('runlog.unknownTool') : s)

const RULES: Rule[] = [
  // ── LLM ──
  {
    re: /^思考挡位「(.+?)」不在模型「(.+?)」可用清单，已钳到「(.+?)」$/,
    key: 'runlog.effortClamped',
    map: m => ({ want: m[1], model: m[2], got: m[3] }),
  },
  {
    re: /^出站消息消毒：剥离 (\d+) 个不支持内容块（(.*?)）——来源可能是旧 transcript 回填$/,
    key: 'runlog.sanitized',
    map: m => ({ n: m[1], list: m[2] }),
  },
  {
    re: /^(【.*?】)?模型调用失败，第 (\d+)\/(\d+) 次重试即将开始（等待 ([\d.]+) 秒）(?:：(.*))?$/,
    key: 'runlog.llmRetryBegin',
    map: m => ({ tag: m[1] || '', a: m[2], b: m[3], s: m[4], reason: m[5] ? `：${m[5]}` : '' }),
  },
  {
    re: /^(【.*?】)?模型连接已恢复（重试 (\d+) 次后成功，本轮继续）$/,
    key: 'runlog.llmRecovered',
    map: m => ({ tag: m[1] || '', a: m[2] }),
  },
  {
    re: /^(【.*?】)?模型调用重试 (\d+) 次仍失败，放弃本轮(?:：(.*))?$/,
    key: 'runlog.llmGiveUp',
    map: m => ({ tag: m[1] || '', b: m[2], reason: m[3] ? `：${m[3]}` : '' }),
  },
  {
    re: /^输出达到 max_tokens 上限被截断（stopReason=length）——回复可能不完整$/,
    key: 'runlog.truncated',
  },
  { re: /^LLM 流已被中止（stopReason=aborted）$/, key: 'runlog.llmAborted' },
  {
    re: /^(【.*?】)?LLM 流式错误: ([\s\S]*)$/,
    key: 'runlog.streamError',
    map: m => ({ actor: m[1] || '', err: m[2] }),
  },
  {
    re: /^LLM 调用异常，第 (\d+)\/(\d+) 次重试即将开始（等待 ([\d.]+) 秒）: ([\s\S]*)$/,
    key: 'runlog.llmRetryExc',
    map: m => ({ a: m[1], b: m[2], s: m[3], err: m[4] }),
  },
  {
    re: /^流式响应异常中断: ([\s\S]*)$/,
    key: 'runlog.streamInterrupted',
    map: m => ({ err: m[1] }),
  },
  {
    re: /^检测到模型重复输出同一段思考（疑似死循环），已自动停止本轮——请换个问法或降低任务复杂度重试$/,
    key: 'runlog.repeatThinking',
  },

  // ── 授权 / 审批 ──
  {
    re: /^\[团队\] 自审计：成员调用 (.*)$/,
    key: 'runlog.teamSelfAudit',
    map: m => ({ tool: m[1] }),
  },
  {
    re: /^已拦截无差别进程杀伤命令：([\s\S]*)$/,
    key: 'runlog.blockKill',
    map: m => ({ cmd: m[1] }),
  },
  {
    re: /^完全权限模式：(.*) 直接放行$/,
    key: 'runlog.fullAccess',
    map: m => ({ tool: m[1] }),
  },
  { re: /^自审计模式：(.*)$/, key: 'runlog.selfAudit', map: m => ({ tool: m[1] }) },
  {
    re: /^高风险自定义工具：(.*) 等待授权$/,
    key: 'runlog.highRiskCustom',
    map: m => ({ tool: m[1] }),
  },
  {
    re: /^自我修改写操作：(.*) 等待授权$/,
    key: 'runlog.selfModifyWrite',
    map: m => ({ tool: m[1] }),
  },
  {
    re: /^已拒绝：([\s\S]*)$/,
    key: 'runlog.denied',
    map: m => ({ reason: m[1] === '用户拒绝' ? t('runlog.userRejected') : m[1] }),
  },
  { re: /^已授权：(.*)$/, key: 'runlog.granted', map: m => ({ tool: m[1] }) },
  {
    re: /^(.*) 已被会话允许，自动放行$/,
    key: 'runlog.sessionAllowed',
    map: m => ({ tool: m[1] }),
  },
  { re: /^等待授权：([\s\S]*)$/, key: 'runlog.waitingApproval', map: m => ({ q: m[1] }) },

  // ── 队列 / 续跑护栏 ──
  {
    re: /^flush 跳过：status=(.*)$/,
    key: 'runlog.flushSkipStatus',
    map: m => ({ s: m[1] }),
  },
  { re: /^flush 跳过：in-flight$/, key: 'runlog.flushSkipInflight' },
  { re: /^flush 跳过：审批\/询问挂起$/, key: 'runlog.flushSkipPending' },
  { re: /^flush 跳过：上轮 error 收尾$/, key: 'runlog.flushSkipError' },
  { re: /^队列自动续发：([\s\S]*)$/, key: 'runlog.queueAuto', map: m => ({ text: m[1] }) },
  {
    re: /^队列续发失败（已放回队列）：([\s\S]*)$/,
    key: 'runlog.queueFail',
    map: m => ({ err: m[1] }),
  },
  {
    re: /^连续失败硬熔断：(.*) 连续失败已达 (\d+) 次，本轮强制停止$/,
    key: 'runlog.errHardStop',
    map: m => ({ tool: m[1], n: m[2] }),
  },
  {
    re: /^循环熔断：([\s\S]*)，连续第 (\d+) 次，已硬停止本轮执行$/,
    key: 'runlog.loopHardStop',
    map: m => ({ detail: m[1], n: m[2] }),
  },
  {
    re: /^循环预警：(.*) 参数和结果均未变化，已连续第 (\d+) 次；这是软提醒，下一次仍重复才会停止$/,
    key: 'runlog.loopSoftWarn',
    map: m => ({ tool: m[1], n: m[2] }),
  },
  {
    re: /^自动续跑达到段数上限（(\d+) 段），停止$/,
    key: 'runlog.roundCap',
    map: m => ({ n: m[1] }),
  },
  {
    re: /^token 预算 (\d+) 用满，注入收尾指令（grace call）$/,
    key: 'runlog.budgetGrace',
    map: m => ({ n: m[1] }),
  },
  { re: /^token 预算耗尽且收尾轮已过，停止$/, key: 'runlog.budgetStop' },
  {
    re: /^无进展检测：连续多轮只读工具无写入\/命令，停止自动续跑$/,
    key: 'runlog.noProgress',
  },
  {
    re: /^软段 (\d+) 轮到达，自动续跑进入第 (\d+) 段$/,
    key: 'runlog.autoContinue',
    map: m => ({ turns: m[1], seg: m[2] }),
  },

  // ── 生命周期 ──
  { re: /^开始处理消息$/, key: 'runlog.startMessage' },
  {
    re: /^回复完成（(\S+) out \/ (\S+) in tokens）$/,
    key: 'runlog.replyDone',
    map: m => ({ out: m[1], inp: m[2] }),
  },
  {
    re: /^用户插话（(.*?)）：([\s\S]*)$/,
    key: 'runlog.userInterject',
    map: m => ({ kind: m[1], text: m[2] }),
  },
  {
    re: /^删除轮次 #(\d+)（(含用户消息|仅 AI 回复)，移除 (\d+) 条）$/,
    key: 'runlog.deleteTurn',
    map: m => ({ n: m[1], scope: m[2] === '含用户消息' ? t('runlog.withUser') : t('runlog.aiOnly'), removed: m[3] }),
  },
  {
    re: /^\[清理\] 会话工作区已随会话删除：(.*)$/,
    key: 'runlog.workdirCleaned',
    map: m => ({ dir: m[1] }),
  },
  { re: /^用户中断：已保存当前进度上下文，可继续对话接上$/, key: 'runlog.userAbort' },
  {
    re: /^中断时保留未注入插话 (\d+) 条入上下文$/,
    key: 'runlog.leftoverInterject',
    map: m => ({ n: m[1] }),
  },
  {
    re: /^\[配置\] 检测到预设\/团队配置变更，已重建 agent（新配置自本次请求生效）$/,
    key: 'runlog.configRebuilt',
  },
  {
    re: /^\[单聊\] 用户 @(.*?)：([\s\S]*)$/,
    key: 'runlog.singleChat',
    map: m => ({ member: m[1], msg: m[2] }),
  },

  // ── 工具 ──
  {
    re: /^工具 (.*?) 执行失败（(\d+)ms）：([\s\S]*)$/,
    key: 'runlog.toolFail',
    map: m => ({ tool: toolName(m[1]), ms: m[2], err: m[3] }),
  },
  {
    re: /^工具 (.*?) 执行完成（(\d+)ms）$/,
    key: 'runlog.toolDone',
    map: m => ({ tool: toolName(m[1]), ms: m[2] }),
  },
  {
    re: /^工具 (.*?) 开始：([\s\S]*)$/,
    key: 'runlog.toolStart',
    map: m => ({ tool: toolName(m[1]), args: m[2] }),
  },

  // ── 工作区（用户操作）──
  {
    re: /^\[用户\] 删除工作区文件：([\s\S]*)$/,
    key: 'runlog.userDelete',
    map: m => ({ path: m[1] }),
  },
  {
    re: /^\[用户\] 重命名：([\s\S]*?) → ([\s\S]*)$/,
    key: 'runlog.userRename',
    map: m => ({ path: m[1], name: m[2] }),
  },
  {
    re: /^\[用户\] 撤销：(.*?) 已恢复到 (.*?) 的状态（来源：(.*?)）$/,
    key: 'runlog.userUndo',
    map: m => ({ path: m[1], ts: m[2], actor: m[3] }),
  },
  {
    re: /^\[用户\] 整轮撤销：第 (\d+) 轮 (\d+)\/(\d+) 条已恢复$/,
    key: 'runlog.userUndoTurn',
    map: m => ({ n: m[1], r: m[2], t: m[3] }),
  },
]

/** 把后端日志消息渲染为当前语言的文本；未命中规则时原样返回（优雅降级） */
export function translateLog(message: string): string {
  if (!message) return message
  // 中文态：后端串本身就是中文，直接透出（避免规则表未覆盖时出现 key）
  if (useI18n().lang.value !== 'en') return message
  for (const r of RULES) {
    const m = message.match(r.re)
    if (m) {
      const params = r.map ? r.map(m) : g(m)
      // 全部参数必须是字符串，避免 t() 里 {x} 占位符残留
      return t(r.key, params as Params)
    }
  }
  return message
}


