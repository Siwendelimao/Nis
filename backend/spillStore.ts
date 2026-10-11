/**
 * ★1012h/1012i：工具输出的 **spill 存档**（共享模块，server.ts 与 tools.ts 都用）
 *
 * 干什么：把"被截断/被裁剪掉"的完整输出**落盘成文件**，上下文里只留头尾 + **确切路径**。
 *
 * 为什么（三条，都有实测支撑）：
 *  ① 模型能**精确取回**原文 —— 旧文案只说"存档里有"，模型不知确切位置 ⇒ 只能**重跑命令**，白烧时间和 token；
 *  ② 上下文体积可控 —— 少留头尾 ⇒ 少撞压缩线（少一次"压缩换血全价"），也让**供应商 TTL 过期的绝对损失变小**
 *     （实测：整轮第一跳命中 23.6%、丢 16.5 万 token，形态是"前 5.1 万命中、之后全失效"= 缓存块 TTL 过期，
 *     这类损失与输入体积成正比 ⇒ 输入减半则损失减半）；
 *  ③ 替换文本是**确定性纯函数**（文件名 = 内容 sha1 前 12 位，与轮次/次数/会话无关）⇒ 同一份输出不管在
 *     第几轮、被截几次，拼出来都逐字节相同 ⇒ 历史永不变、前缀缓存永不打散（与 1012g"去时机化"同一思路）。
 *
 * 放在哪：<DATA_ROOT>/tool-output/<sha1-12>.txt（全局去重：同内容只存一份）。
 *   超 30 天的文件在第一次真正落盘时**懒清理**（不在启动流程挂钩子）。
 *   超过 CTX_SPILL_MAX_BYTES 的不落盘（同步写会卡事件循环），退回"无路径"兜底文案。
 *
 * ⚠️ 幂等护栏：所有省略提示都由 omitNotice() 产出，前缀统一是"…（此处省略"——
 *   server.ts 的裁剪与 tools.ts 的截断都靠这个前缀识别"已经处理过的文本"，避免连环裁。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_ROOT } from './paths.ts'

const CTX_SPILL_DIR = path.join(DATA_ROOT, 'tool-output')
const CTX_SPILL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const CTX_SPILL_MAX_BYTES = 8 * 1024 * 1024
const _spillKnown = new Set<string>()   /* 进程内已确认落盘过的 hash —— 省掉每轮重复 stat */
let _spillCleaned = false

/** 全文落盘（已存在则跳过），返回**绝对路径**；失败/过大返回 null（调用方退回兜底文案）。
    懒清理：第一次真的要写文件时顺带清一次超期文件。 */
function spillFullText(text: string): string | null {
  try {
    if (!_spillCleaned) {
      _spillCleaned = true
      try {
        if (fs.existsSync(CTX_SPILL_DIR)) {
          const now = Date.now()
          let n = 0
          for (const f of fs.readdirSync(CTX_SPILL_DIR)) {
            const p2 = path.join(CTX_SPILL_DIR, f)
            try { if (now - fs.statSync(p2).mtimeMs > CTX_SPILL_MAX_AGE_MS) { fs.unlinkSync(p2); n++ } } catch { /* ignore */ }
          }
          if (n) console.log(`[spill] 已清理 ${n} 个超期工具输出文件（>${Math.round(CTX_SPILL_MAX_AGE_MS / 86400000)} 天）`)
        }
      } catch { /* 清理失败不影响落盘 */ }
    }
    if (text.length > CTX_SPILL_MAX_BYTES) return null
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 12)
    const file = path.join(CTX_SPILL_DIR, hash + '.txt')
    if (!_spillKnown.has(hash)) {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(CTX_SPILL_DIR, { recursive: true })
        fs.writeFileSync(file, text, 'utf8')
      }
      _spillKnown.add(hash)
    }
    return file
  } catch { return null }
}

/** 统一的"省略提示"片段（自带前后换行）：`desc` 说明省掉了什么，后面自动补上取回路径。
    所有裁剪/截断处都调它 ⇒ 文案统一、前缀统一（幂等护栏才能识别）、路径确定（缓存才稳定）。 */
export function omitNotice(text: string, desc: string): string {
  const p = spillFullText(text)
  const where = p
    ? `完整输出已存至 ${p}（可用 fs_read 分页读、或用 fs_grep 搜关键词）`
    : '原文见会话记录与工作区 transcripts/ 下的对话存档，需要时用 fs_read 查看'
  return `\n…（${desc}；${where}）…\n`
}
