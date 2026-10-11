/**
 * secretbox.ts —— NIS 供应商密钥保险箱（★ 0930）
 *
 * 为什么需要（实测反馈）：原来 API Key 是**明文**躺在 data/providers.json 里。
 * 这个文件只要被复制走（备份 / 网盘同步 / 打包发人），所有 key 一起走。
 *
 * 存成什么样：
 *   enc:v1:dpapi:<base64>                                ← 本机副本（Windows 用户级加密，换机器必解不开，属预期）
 *   enc:v1:pwd:<saltB64>:<ivB64>:<tagB64>:<cipherB64>   ← 口令副本（跨机器用）
 *
 * 设计取舍（三条硬规矩，改动时别破）：
 *  ① **解不开就明说**，绝不悄悄返回空串——静默空 key 会让调用变成 401 谜案（0925 已吃过一次亏）。
 *  ② 明文只在内存活到"用完"，不入日志、不进导出包正文以外的任何地方。
 *  ③ 口令**永不落盘**：只用来派生密钥，用完即弃。导出包里只有密文。
 *
 * 为什么用「导出时才生成口令副本」而不是平时就存两份（既定的口径）：
 * 平时零记忆负担（本机那份够用），真要迁移时导出那一刻才输一句口令 →
 * 包自带解密所需的全部信息（salt/iv/tag/密文）→ 换电脑输同一句即可恢复。
 *
 * 无新依赖：口令层用 node 内置 scrypt + aes-256-gcm；本机层调 Windows DPAPI（PowerShell）。
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

export const DPAPI_PREFIX = 'enc:v1:dpapi:'
const PWD_PREFIX = 'enc:v1:pwd:'

type DecryptResult =
  | { ok: true; key: string; via: 'plain' | 'dpapi' | 'pwd' }
  | { ok: false; via: 'dpapi' | 'pwd' | 'plain'; reason: string }

/** 这个值是不是密文（决定要不要解密路径） */
export function isEncrypted(v: unknown): boolean {
  const s = String(v || '')
  return s.startsWith(DPAPI_PREFIX) || s.startsWith(PWD_PREFIX)
}

/* ────────────────────── 口令层：scrypt + aes-256-gcm ────────────────────── */

/**
 * 用口令加密。口令强度不足时**直接拒绝**（不给人"我用 123456 也行"的机会）：
 * 短口令 + 强加密 = 自欺欺人（包一丢就等于裸奔）。
 */
export function encryptWithPassphrase(plain: string, passphrase: string): string {
  const pw = String(passphrase || '')
  /* ★1011（老大要求："哪怕口令弱也可以使用"）：原来 <8 位直接拒绝，现在**只要非空就放行**。
     弱口令的风险交由**前端明确提示**（强度条 + 警告），而不是替用户做决定、更不是
     默默不带密钥（那才是真的坑：填了口令却什么也没带，用户还不知道为什么）。 */
  if (!pw) throw new Error('口令不能为空（留空 = 不带密钥，不会走到这里）')
  if (!plain) throw new Error('待加密内容为空')
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 })   // 内存 16MB，见 fine-tune：够慢才抗暴力破解
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  key.fill(0)                                                                  // 派生出的密钥用完即擦
  return `${PWD_PREFIX}${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/** 用口令解密。**口令错 / 数据被改**都抛同一个明确错，绝不返回半截明文。 */
export function decryptWithPassphrase(blob: string, passphrase: string): string {
  try {
    const parts = String(blob || '').slice(PWD_PREFIX.length).split(':')
    if (parts.length !== 4) throw new Error('密文结构损坏')
    const [saltB64, ivB64, tagB64, ctB64] = parts
    const salt = Buffer.from(saltB64, 'base64')
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ct = Buffer.from(ctB64, 'base64')
    const key = crypto.scryptSync(String(passphrase || ''), salt, 32, { N: 16384, r: 8, p: 1 })
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const out = Buffer.concat([decipher.update(ct), decipher.final()])    // final() 校验 GCM tag：错口令在此抛错
      return out.toString('utf8')
    } finally { key.fill(0) }
  } catch (e: any) {
    // AES-GCM 的 auth 校验失败统一对外说"口令不对"，不泄露"数据被篡改"的细节
    throw new Error('口令不对，或数据已损坏')
  }
}

/* ────────────────────── 本机层：Windows DPAPI ────────────────────── */

function runPs(script: string, inputB64?: string): string {
  // 数据走 env 而不是命令行：命令行参数在进程列表里对同机其他进程可见，key 不能进那儿
  const encoded = Buffer.from(script, 'utf16le').toString('base64')            // -EncodedCommand：绕开中文/引号转义地狱
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      windowsHide: true,                                                       // 0930 弹窗根因就是这个 flag
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],                                       // ★ 不继承 stderr：见下方"为什么要吞掉 PS 的错误输出"
      env: inputB64 ? { ...process.env, NIS_SEC_IN: inputB64 } : process.env,
    })
  const s = String(out || '').trim()
  /* ★ 自测实测：PowerShell 失败时会把错误写到 stderr，且经 -EncodedCommand 出来是**中文乱码**
   * （`ʹ�á�3���` 之类，编码是 GBK 而 Node 按 utf8 读）；成功时 Add-Type 还会吐一段 CLIXML 进度流。
   * 两者都会污染 NIS 日志、且乱码会误导排查。所以：脚本内自己 try/catch，只回 ASCII 错误码，
   * 中文解释由 Node 侧拼接 —— 日志里从此只有我们自己写的中文。 */
  if (s.startsWith('ERR:')) throw new Error(s.slice(4))
  if (!s) throw new Error('PowerShell 无输出（DPAPI 调用异常）')
  return s
}

/** DPAPI 脚本模板：ErrorActionPreference=Stop 保证异常被 catch；ProgressPreference 消掉进度流；
 *  用 [Console]::Out.Write 而非 Write-Output（后者会包成 CLIXML 重新制造乱码）。 */
function dpapiScript(op: 'Protect' | 'Unprotect'): string {
  return [
    `$ErrorActionPreference='Stop'`,
    `$ProgressPreference='SilentlyContinue'`,
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`,
    `try{`,
    `Add-Type -AssemblyName System.Security -ErrorAction Stop;`,
    `$b=[Convert]::FromBase64String($env:NIS_SEC_IN)`,
    `$r=[System.Security.Cryptography.ProtectedData]::${op}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `[Console]::Out.Write([Convert]::ToBase64String($r))`,
    // 注意 catch 分支**不能 exit 非 0**：execFileSync 一见非 0 退出码就先抛异常、stdout 里的
    // ERR: 标记会随之丢失，我们自己写的明确原因就拿不回来了。这里只回标记，交给 Node 侧判。
    `}catch{ [Console]::Out.Write('ERR:'+$_.Exception.GetType().Name) }`,
  ].join(';')
}

/** DPAPI 加密（CurrentUser 作用域：只有**当前 Windows 账户在这台机器**能解开） */
export function encryptDpapi(plain: string): string {
  if (!plain) throw new Error('待加密内容为空')
  const b64 = Buffer.from(String(plain), 'utf8').toString('base64')
  try {
    return DPAPI_PREFIX + runPs(dpapiScript('Protect'), b64)
  } catch (e: any) {
    throw new Error(`本机加密失败（DPAPI 不可用）：${e?.message || e}`)
  }
}

/** DPAPI 解密。解不开的典型原因就一个：**这不是加密它的那台机器/账户**（这是预期行为，不是故障）。 */
export function decryptDpapi(blob: string): string {
  const b64 = String(blob || '').slice(DPAPI_PREFIX.length)
  let out: string
  try { out = runPs(dpapiScript('Unprotect'), b64) }
  catch (e: any) {
    // CryptographicException = DPAPI 自己拒绝（换机器/换账户）；其他 = 调用层面出问题
    const why = /Cryptographic/.test(String(e?.message || ''))
      ? '它是用另一台机器或另一个 Windows 账户加密的（本机密钥出不了本机，属预期）'
      : String(e?.message || e)
    throw new Error(why)
  }
  return decodeDpapiB64(out)
}

/* ★1003 批次4 4.39：解码**显式校验** —— Buffer.from(b64,'base64') 对非法 base64 从不抛错
 *（静默跳过非字母表字符），toString('utf8') 也不抛（非法序列变 U+FFFD）⇒ 损坏/截断的
 * DPAPI 结果会静默产出垃圾/空串当"解好的 key"（违反本模块铁律①"解不开就明说"）。
 * 严格 base64 形状 + 回编码比对，坏了/空了都如实抛错。
 * ★1004：从 decryptDpapi 里抽出来，供批量解密复用（同一套校验，两条路径不可能漂移）。 */
function decodeDpapiB64(out: string): string {
  try {
    const trimmed = String(out || '').trim()
    if (!trimmed || !/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) throw new Error('解密结果不是合法 base64（疑似损坏/截断）')
    const buf = Buffer.from(trimmed, 'base64')
    const canon = (s: string) => s.replace(/\s/g, '').replace(/=+$/, '')
    if (canon(buf.toString('base64')) !== canon(trimmed)) throw new Error('解密结果 base64 回编码不一致（疑似损坏/截断）')
    return buf.toString('utf8')
  } catch (e: any) {
    if (/解密结果/.test(String(e?.message || ''))) throw e
    throw new Error('解密结果不是合法文本')
  }
}

/** 批量 DPAPI 脚本模板：一次进程内解 N 把，逐行回 `K:<b64>`（成功）/ `E:<异常类型>`（该条失败）。
 *  行标记刻意不用 `ERR:` —— runPs 见到 `ERR:` 开头会整体抛错，而这里"单项失败"是正常返回。
 *  ⚠️ 组装纪律一：`}` 与 `catch` 之间**绝不能落进 `;`** —— PS 要求 catch 紧跟 try 块，
 *   `try{...};catch{...}` 直接 ParserError（MissingCatchOrFinally）。所以单个 try/catch
 *   必须整体作为**一个数组元素**，不能拆成两行再 join。
 *  ⚠️ 组装纪律二：**不要用 ConvertFrom-Json 传数组** —— 实测 PS 5.1 会把 JSON 数组当成
 *   单个对象返回，`@(... | ConvertFrom-Json)` 只有 1 个元素 ⇒ 循环只跑一次、后 N-1 条全"缺项"。
 *   改用换行分隔纯文本（base64 blob 本身不含换行，天然安全），PS 侧按 char 10 切分还原
 *  （用 `.Split([char]10)` 而不是 `-split "`n"`：后者要在 JS 模板字面量里转义反引号，极易写坏）。 */
function dpapiBatchScript(): string {
  const inner = [
    `$b=[Convert]::FromBase64String([string]$s)`,
    `$r=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `[void]$o.Add('K:'+[Convert]::ToBase64String($r))`,
  ].join(';')
  return [
    `$ErrorActionPreference='Stop'`,
    `$ProgressPreference='SilentlyContinue'`,
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`,
    `try{`,
    `Add-Type -AssemblyName System.Security -ErrorAction Stop`,
    `$a=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NIS_SEC_IN))).Split([char]10)`,
    `$o=New-Object System.Collections.ArrayList`,
    `foreach($s in $a){ $s=$s.Trim(); if(-not $s){continue}; try{ ${inner} }catch{ [void]$o.Add('E:'+$_.Exception.GetType().Name) } }`,
    `[Console]::Out.Write(($o -join [char]10))`,
    `}catch{ [Console]::Out.Write('ERR:'+$_.Exception.GetType().Name) }`,
  ].join(';')
}

/** ★1004 批量 DPAPI 解密 —— **把 N 次 powershell.exe 压成 1 次**。
 *
 *  这是 1004 实测出来的病根修法：单次 DPAPI 要 spawn 一个 powershell.exe（本机实测 **~565ms**），
 *  而 `providers.list` 会对每个供应商逐把 `revealKey` ⇒ 16 把带 key 的 = **16 次 spawn ≈ 9 秒**；
 *  更致命的是 `execFileSync` 是**同步**的 —— 这 9 秒里整个 Node 事件循环冻死，
 *  前端并发的 3 秒 `ping` 必然超时 ⇒ 判"后端没连上" ⇒ 界面按未连接渲染
 *  （**表现就是"我的供应商全没了"**，其实盘上一把没少）。
 *  批量化后：16 把 = 1 次 spawn ≈ 0.6 秒。
 *
 *  ⚠️ 契约：只吃 `enc:v1:dpapi:` 前缀的输入（调用方按前缀筛过）；返回值与输入**等长同序**，
 *  逐项给成败；**绝不因单项失败而整体抛错**（换机包就该逐把 locked，不是全盘炸）。 */
export function decryptDpapiBatch(blobs: string[]): Array<{ ok: boolean; value?: string; reason?: string; transient?: boolean }> {
  const raw = blobs.map(b => String(b || ''))
  if (!raw.length) return []
  // 换行分隔纯文本（不用 JSON：PS 5.1 的 ConvertFrom-Json 会把数组当单对象，见脚本模板头注）
  const payloadB64 = Buffer.from(
    raw.map(s => s.slice(DPAPI_PREFIX.length)).join('\n'), 'utf8',
  ).toString('base64')
  // 环境变量有长度上限：超了就退回逐个（结果一样，只是慢），避免"批量"反而把请求撑爆
  if (payloadB64.length > 200_000) {
    /* 逐条解：单项失败 = DPAPI 真拒绝（稳定属性）⇒ transient:false，允许上层缓存「这把解不开」。 */
    return raw.map(b => { try { return { ok: true, value: decryptDpapi(b) } } catch (e: any) { return { ok: false, reason: String(e?.message || e), transient: false } } })
  }
  let out: string
  try {
    out = runPs(dpapiBatchScript(), payloadB64)
  } catch (e: any) {
    /* 整批调用层面失败（PowerShell 起不来 / Add-Type 挂了）：如实体现在每一项上，并标 transient:true ——
       ★1005：这类是**瞬时**故障（进程抖动 / 被拦），**不许让上层把它当成「这些 key 永久解不开」缓存起来**
       （否则一次抖动 ⇒ 全进程所有 key 显示"解不开"，看起来跟"密钥全丢"一模一样）。 */
    const reason = String(e?.message || e)
    return raw.map(() => ({ ok: false, reason, transient: true }))
  }
  const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  /* ★1005 诚实性修复：**结果行数必须与输入等长**，否则一律拒绝采信。
     原实现纯按行号 `lines[i]` 对齐 —— PowerShell 只要多吐一行（profile / Add-Type 噪声），
     全体就**错位一格** ⇒ 供应商 N 拿到 N-1 的明文 key（静默错发别家的 key，且无任何报错）。
     宁可如实判失败，也绝不错配。 */
  if (lines.length !== raw.length) {
    const reason = `批量解密结果行数不符（期望 ${raw.length} 实得 ${lines.length}）—— 拒绝采信以避免错位`
    console.warn('[secretbox] ' + reason)
    return raw.map(() => ({ ok: false, reason, transient: true }))
  }
  return raw.map((_, i) => {
    const L = lines[i] || ''
    if (L.startsWith('K:')) {
      try { return { ok: true, value: decodeDpapiB64(L.slice(2)) } }
      catch (e: any) { return { ok: false, reason: String(e?.message || e), transient: false } }
    }
    if (L.startsWith('E:')) return { ok: false, reason: L.slice(2) || 'DPAPI 拒绝解密', transient: false }
    return { ok: false, reason: '批量解密结果缺项', transient: true }
  })
}

/* ────────────────────── 统一入口 ────────────────────── */

/**
 * 统一解密：明文直通；dpapi 走本机层；pwd 必须给口令。
 * **任何失败都带明确 reason**，绝不 return '' —— 调用方必须能把 reason 原样显示给用户。
 */
export function decryptKey(stored: string, passphrase?: string): DecryptResult {
  const s = String(stored || '')
  if (!s) return { ok: false, via: 'plain', reason: '未配置密钥' }
  if (!isEncrypted(s)) return { ok: true, key: s, via: 'plain' }             // 老数据仍是明文：直通（迁移会把它加密掉）
  if (s.startsWith(DPAPI_PREFIX)) {
    try { return { ok: true, key: decryptDpapi(s), via: 'dpapi' } }
    catch (e: any) {
      return { ok: false, via: 'dpapi', reason: `本机密钥解不开（多半是加密它的机器/账户不是当前这台）：${e?.message || e}` }
    }
  }
  if (!passphrase) return { ok: false, via: 'pwd', reason: '该密钥需口令解锁' }
  try { return { ok: true, key: decryptWithPassphrase(s, passphrase), via: 'pwd' } }
  catch (e: any) { return { ok: false, via: 'pwd', reason: String(e?.message || e) } }
}

/** 只留尾巴的提示串（界面上显示"这是哪把 key"，不泄露全文） */
export function keyHint(plain: string): string {
  const s = String(plain || '')
  if (!s) return ''
  return s.length <= 8 ? '***' : `${s.slice(0, 3)}***${s.slice(-2)}`
}

/** 粗略口令强度：≥8 且不是纯重复/纯数字序列。
 *  ⚠️ 1011 更正：注释原写"只提示，不拦截"，但实际**是拦截的** ——
 *  providers.sealPortableKeys / webTools.sealPortableSearchKeys 都在口令弱时直接 throw，
 *  导出侧则把这两份密钥整个**跳过不进包**（宁可不带也不塞原文）。前端已同步做即时提示。 */
export function passphraseWeak(pw: string): boolean {
  const s = String(pw || '')
  if (s.length < 8) return true
  if (/^(.)\1+$/.test(s)) return true
  if (/^\d+$/.test(s)) return true
  return false
}