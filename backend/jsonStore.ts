/**
 * 共享 JSON 存储基础设施（0927 第 0 批·存储收口）
 *
 * 背景（体检报告《NIS全栈体检总报告-v2-0927.md》家族①/②）：
 *   全项目 10+ 个存储模块同一个病：load() 失败不区分 ENOENT/损坏 → 静默回落空表或默认表
 *   → 下一次 persist() 把"空/默认"当权威写回盘 → 用户数据被永久替换（3 个 P0：
 *   notebook/providers/scheduledTasks 各一次文件损坏=全量丢失）。tmp 名固定（FILE+'.tmp'）
 *   并发写互相截断（7 处同型）。本文件一次性收口这两族。
 *
 * 设计原则（对齐 Codex fail-closed / ZCode 显式数据目录 / 用户纪律"问题要直接暴露"）：
 *   ① ENOENT（正常首启）才回落 fallback；
 *   ② 内容损坏 → 先备份 `.corrupt-<ts>` 再回落，且本次会话标记 degraded；
 *   ③ degraded 期间 persistJson 拒绝把"空/默认"特征的数据写回盘（防默认覆盖用户数据）；
 *   ④ 写盘一律原子：tmp 带 pid+随机 → write → rename → 目录 fsync；
 *   ⑤ 失败必须可见：console.error 明说，degradedFiles() 供状态接口/UI 查询。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

interface LoadResult<T> {
  data: T
  /** true = 文件损坏（已备份）或读取失败，本次会话内该文件不可信 */
  degraded: boolean
  degradedReason?: string
}

/** 进程内降级登记表：file -> 原因。重启后重新探测（坏文件已在磁盘备份，回落逻辑会再次登记）。 */
const degradedRegistry = new Map<string, string>()

/** 供状态接口/host.describe 查询：当前有哪些存储文件处于降级状态 */
export function degradedFiles(): Array<{ file: string; reason: string }> {
  return [...degradedRegistry.entries()].map(([file, reason]) => ({ file, reason }))
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 读 JSON：ENOENT → fallback()（正常首启）；损坏/读取失败 → 备份坏档 + 登记 degraded + fallback()。
 * 注意：parse 成功但结构不符合预期（如 items 不是数组）由调用方处理——调用方应自行把这种
 * "schema 级损坏"也标记为 degraded（见 persistJson 的 isEmpty 保护联动）。
 */
export function loadJsonOrBackup<T>(file: string, fallback: () => T): LoadResult<T> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e: any) {
    /* ★1003 并发批 4.10：只认 **ENOENT** 为"干净的首次启动"；其余失败（EACCES/EPERM/ELOOP…）
     * 一律按"不可信"登记 degraded —— 原实现先 existsSync 而它对**任何** stat 失败都回 false
     * （从不抛错，catch 是死代码）⇒ "存在但读不了"的文件被误判成"不存在"→ 静默回落空表 +
     * degraded:false → 下次 persist 的 rename 直接把真数据盖掉（rename 只需目录写权限）——
     * 正是本模块要消灭的 P0 默认值覆盖用户数据。 */
    if ((e as any)?.code === 'ENOENT') return { data: fallback(), degraded: false }
    const reason = `read failed: ${String(e?.message || e)}`
    degradedRegistry.set(file, reason)
    console.error(`[jsonStore] ${file} ${reason}`)
    return { data: fallback(), degraded: true, degradedReason: reason }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    /* 内容损坏：先备份坏档（best-effort），再回落。绝不用默认值直接覆盖原文件。 */
    const reason = `JSON parse failed: ${String(e?.message || e)}`
    degradedRegistry.set(file, reason)
    /* ★1003 审计复核 #3：备份路径**只算一次** —— 原来 copy 与日志各调一次 stamp()，两次
     * 时间戳/随机串可能不同 ⇒ 日志报的备份名与真实文件对不上，排障时满世界找不到"备份"、
     * 以为没备份（误导应急排查）。先定名 → 拷 → 按同一个名字报。 */
    const bak = `${file}.corrupt-${stamp()}`
    try {
      fs.copyFileSync(file, bak)
      console.error(`[jsonStore] ${file} ${reason}；坏档已备份为 ${bak}`)
    } catch (be: any) {
      console.error(`[jsonStore] ${file} ${reason}；坏档备份失败（${String(be?.message || be)}），原文件保持不动`)
    }
    return { data: fallback(), degraded: true, degradedReason: reason }
  }
  return { data: parsed as T, degraded: false }
}

/**
 * 原子写 JSON：tmp 带 pid+随机后缀（多进程/多实例并发不互截）→ write → rename → 目录 fsync。
 * 失败抛给调用方（persistJson 会接住并记日志）；tmp 残留 best-effort 清理。
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try {
    /* ★1003 并发批 4.11：tmp 内容必须 **fsync 落盘后**才 rename —— 原来 writeFileSync 完直接
     * rename，断电/崩溃时 rename 可能先入日志、数据块还是空/半截 = 换进一个"名字对、内容空"的
     * 库（正是本模块要防的丢数据类）；后面的目录 fsync 补不回没刷的文件内容。 */
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    /* ★1003 修复 4.12：rename 只需目录写权限，tmp 的默认权限（0666&umask≈0644）会把原文件的
     * 严格权限（如 providers 库的 0600）顶成全员可读——写前记下原 mode 贴回 tmp；新文件默认 0600 */
    try {
      const st = fs.statSync(file, { throwIfNoEntry: false })
      fs.chmodSync(tmp, st ? (st.mode & 0o777) : 0o600)
    } catch (ce: any) {
      /* ★1003 审计复核 #4：chmod 失败不许静默 —— 权限没贴回去 = 密钥文件可能被悄悄放宽
       *（4.12 同主题；Windows 无 POSIX mode 位属平台局限，已记任务单新发现区）。只告警不阻断写入。 */
      console.warn(`[jsonStore] 权限贴回失败（${String(ce?.message || ce).slice(0, 100)}）：${file} 可能未保留原权限`)
    }
    fs.renameSync(tmp, file)
    /* 目录 fsync：rename 后掉电可能丢目录项（ext4 常见），尽力而为 */
    try {
      const fd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } catch { /* 目录 fsync 失败不阻断（部分平台/FS 不支持） */ }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
}

interface PersistOpts {
  /** 该文件当前是否 degraded（load 时损坏回落）。为 true 时启用空表保护。 */
  degraded?: boolean
  /** 判定"当前数据是空/默认特征"（返回 true = 没有真实内容）。degraded 且空 → 拒绝写回。 */
  isEmpty?: () => boolean
}

/**
 * 带保护的落盘：原子写 + degraded 空表拒绝回写 + 失败只记日志不抛（保持各模块现有行为）。
 * @returns true=已写入磁盘；false=被拒绝或写失败（调用方应把 false 上报到状态接口/UI）
 */
export function persistJson(file: string, data: unknown, opts: PersistOpts = {}): boolean {
  const { degraded = false, isEmpty } = opts
  if (degraded && isEmpty && isEmpty()) {
    const msg = `[jsonStore] 拒绝回写 ${file}：文件已损坏降级，当前数据为空/默认特征——` +
      `保护用户数据不被默认值覆盖（坏档已在盘上 .corrupt-*，请人工检查）`
    console.error(msg)
    return false
  }
  try {
    writeJsonAtomic(file, data)
    return true
  } catch (e) {
    console.error(`[jsonStore] 写盘失败 ${file}:`, e)
    return false
  }
}
