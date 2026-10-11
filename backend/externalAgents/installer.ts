/* installer.ts —— ★1001 外部 agent 可拆装安装器（类似"软件环境"的安装/卸装）
 * 装：按配方渠道序尝试（GitHub Releases → PyPI/npm 备用；本机 GitHub CDN 间歇被墙会自动落备用渠道），
 *     解包到 NIS 根目录\external-agents\<id>\，扫描入口二进制 → install.json 记账 → 注册预设（可拆装）。
 * 拆：删安装目录 + 删注册的预设（一键还原干净）。
 * 进度：live 带 percent（下载按字节报真进度；pip 无总量走阶段文案）；UI 轮询 externalAgents.list。
 * 凭据（★1001二批）："用它的 API"档：① 登录（spawn 它自己的 login，浏览器 OAuth）② 直填 API Key
 *     → credentials.json（key 只存本地；list 只报"已设置/未设置"，绝不回显明文）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { spawn, execFile } from 'node:child_process'
import { EXT_AGENTS, EXT_AGENTS_DIR, findRecipe, type ExtAgentRecipe, type ExtChannel } from './registry.ts'
import { EXT_LOGOS } from './logos.ts'
import { writeAgentPreset, deleteAgentPreset, readAgentPreset } from '../agentPresetsStore.ts'

interface ExtAgentStatus {
  id: string
  name: string
  desc: string
  repo: string
  engine: string
  /** 应用 logo（数据 URL；卡片头像/预设头像同一数据源） */
  logo?: string
  installed: boolean
  version?: string
  channel?: string
  entry?: string
  installedAt?: number
  /** "用它的 API"档是否已配凭据（登录态或已填 key） */
  hasKey?: boolean
  /** 官方用量页直达（★1001 六批：额度=实时拉官方，不本地记账） */
  consoleUrl?: string
  /** 安装中/失败 的实时态（UI 轮询）：percent=真进度（无总量时不给，UI 走动效条） */
  live?: { phase: string; percent?: number; error?: string }
  pendingSource?: string
}

const live = new Map<string, { phase: string; percent?: number; error?: string }>()

/** ★1007（上线前检查·P0）：只有「进行中」的条目才拦重装/卸载。
 *  旧写法用 live.has(id) 当守卫，而失败分支只 live.set('失败') 不 delete
 *  ⇒ 一次安装失败后该 agent 永久卡死（既装不上也卸不掉，重启后端才解）。
 *  这里保留失败条目（前端要显示错误原因），只是不再拦操作。 */
function installInFlight(id: string): boolean {
  const cur = live.get(id)
  return !!cur && String(cur.phase || '') !== '失败'
}

/* ★1001 六批（已定案：不要本地记账，只做"实时显示官方套餐额度"）：官方用量页直达 + 尽力实时拉取。
   有查询接口的（codex 订阅=TUI 同源 codex/usage 接口）显示真数字；没接口的如实说 + 直达按钮。 */
const QUOTA_URLS: Record<string, string> = {
  codex: 'https://chatgpt.com/codex/settings/usage',
  opencode: 'https://opencode.ai/dashboard',
  hermes: 'https://hermes-agent.nousresearch.com',
  dsh: 'https://platform.deepseek.com/usage',
  zcode: 'https://z.ai',
}
/** 实时拉取官方额度（尽力而为；接口都调不动就如实报，UI 落直达按钮） */
export async function fetchQuota(id: string): Promise<{ ok: boolean; rows?: Array<{ label: string; value: string }>; error?: string; consoleUrl?: string }> {
  const consoleUrl = QUOTA_URLS[id]
  try {
    if (id === 'codex') {
      // 订阅登录态的 token（它的 TUI 显示限额就是调这个接口族；两个候选路径都试，谁通用谁）
      let token = ''
      try {
        const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))
        token = String(auth?.tokens?.access_token || auth?.access_token || auth?.OPENAI_API_KEY || '')
      } catch { /* 未登录 */ }
      if (!token) return { ok: false, error: '未登录：点「登录」后可实时看订阅额度（或用官方页面直查看）', consoleUrl }
      for (const url of ['https://chatgpt.com/backend-api/codex/usage', 'https://chatgpt.com/api/codex/usage']) {
        try {
          const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) })
          if (!r.ok) continue
          const j = await r.json()
          const rows = flattenNumbers(j).slice(0, 8)
          if (rows.length) return { ok: true, rows, consoleUrl }
        } catch { /* 换下一个候选 */ }
      }
      return { ok: false, error: '额度接口没调通（接口可能已变）——请用官方页面查看', consoleUrl }
    }
    // 其余各家：目前没有公开的额度查询接口（如实报，后续探到就补）
    return { ok: false, error: '官方暂无额度查询接口——点下方直达查看', consoleUrl }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), consoleUrl }
  }
}
/** 把未知 JSON 里成对的 数字/limit 类字段拍平成行（schema 不公开 → 通用渲染，不硬编字段名） */
function flattenNumbers(j: any, prefix = '', out: Array<{ label: string; value: string }> = []): Array<{ label: string; value: string }> {
  if (out.length >= 16 || j == null) return out
  if (typeof j === 'number') {
    out.push({ label: prefix || 'value', value: String(j) })
  } else if (typeof j === 'string' && /^\d+$/.test(j) && prefix) {
    out.push({ label: prefix, value: j })
  } else if (Array.isArray(j)) {
    j.slice(0, 4).forEach((v, i) => flattenNumbers(v, prefix ? `${prefix}[${i}]` : `[${i}]`, out))
  } else if (typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) flattenNumbers(v, prefix ? `${prefix}.${k}` : k, out)
  }
  return out
}

const dirOf = (id: string) => path.join(EXT_AGENTS_DIR, id)
const pyExe = () => 'python'   // 系统 python（0924 环境实证在 PATH）
const credPath = () => path.join(EXT_AGENTS_DIR, 'credentials.json')

/* ★1001 三批（已定案"卸载后一同删掉"）：各家登录态的已知存放位置（尽力删，缺失无害）。
   登录态在它自己的配置目录（我们登录按钮 spawn 它的 OAuth 写进去的）——卸载=连登录一起登出。 */
const AUTH_PATHS: Record<string, string[]> = {
  codex: ['.codex/auth.json'],
  opencode: ['.local/share/opencode/auth.json', '.config/opencode/auth.json', 'AppData/Local/opencode/auth.json'],
  hermes: ['.hermes/credentials.json', '.config/hermes/credentials.json'],
  dsh: ['.dsh/credentials.json', '.deepseek-harness/credentials.json', '.config/dsh/credentials.json'],
  zcode: ['.zcode/auth.json', '.zcode/credentials.json'],
}

/* ── 凭据（"用它的 API"档） ── */
export function setExternalKey(id: string, key: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(EXT_AGENTS_DIR, { recursive: true })
    let all: Record<string, string> = {}
    try { all = JSON.parse(fs.readFileSync(credPath(), 'utf8')) } catch { /* 首次 */ }
    if (key.trim()) all[id] = key.trim(); else delete all[id]
    fs.writeFileSync(credPath(), JSON.stringify(all, null, 2), 'utf8')
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
export function getExternalKey(id: string): string {
  try { return String(JSON.parse(fs.readFileSync(credPath(), 'utf8'))[id] || '') } catch { return '' }
}
/** 登录（它自己的 OAuth：spawn 入口 login，浏览器自动弹出，登录态落它自己的配置目录） */
export function startLogin(id: string): { ok: boolean; error?: string } {
  const recipe = findRecipe(id)
  if (!recipe) return { ok: false, error: '未知的外部 agent' }
  const meta = readMeta(id)
  if (!meta?.entry || !fs.existsSync(String(meta.entry))) return { ok: false, error: '请先安装再登录' }
  try {
    const child = spawn(String(meta.entry), ['login'], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
    child.on('error', () => { /* 登录失败由它自己的界面/凭据状态体现 */ })
    child.unref()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/* ★1001 四批（已定案"先获取才显示清单"）：模型清单=真取，取不到如实报。
   · key 档：OpenAI /v1/models（公开真接口，可实测）
   · login 档：它登录态的 token 打订阅侧 catalog（尽力而为；codex CLI 无 models 命令，实测过） */
export async function listModels(id: string, mode: 'login' | 'key'): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  try {
    if (mode === 'key') {
      const key = getExternalKey(id)
      if (!key) return { ok: false, error: '先保存 API Key 才能获取模型清单' }
      const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) })
      if (!r.ok) return { ok: false, error: `模型清单获取失败（HTTP ${r.status}）` }
      const j = await r.json()
      const models = (j.data || []).map((m: any) => String(m.id)).filter((s: string) => /gpt|o\d|codex/i.test(s)).sort()
      return models.length ? { ok: true, models } : { ok: false, error: '清单为空' }
    }
    // login 档：读它自己的登录态 token（codex: ~/.codex/auth.json），尽力打订阅侧 catalog
    const home = os.homedir()
    let token = ''
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'))
      token = String(auth?.tokens?.access_token || auth?.access_token || auth?.OPENAI_API_KEY || '')
    } catch { /* 没登录 */ }
    if (!token) return { ok: false, error: '还没登录：点「登录」完成后再获取（订阅清单没登录拿不到）' }
    const r = await fetch('https://chatgpt.com/backend-api/ps/models', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })
    if (!r.ok) return { ok: false, error: `订阅清单获取失败（HTTP ${r.status}）——请手填模型名` }
    const j = await r.json()
    const arr = Array.isArray(j?.models) ? j.models : Array.isArray(j?.data) ? j.data : []
    const models = arr.map((m: any) => String(m?.id || m?.slug || m?.name || '')).filter(Boolean)
    return models.length ? { ok: true, models } : { ok: false, error: '清单为空——请手填模型名' }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

function readMeta(id: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'install.json'), 'utf8')) } catch { return {} }
}

function findBinary(dir: string, name: string, depth = 6): string | null {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p
    if (e.isDirectory() && depth > 0 && !/\.git/i.test(e.name)) {
      const hit = findBinary(p, name, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

/** 下载（按字节报进度0-85；无 Content-Length 时不报）。★停滞看门狗：60s 没字节=判死换渠道
 *  （本机 GitHub CDN 会限速到个位数 KB/s 干耗，总超时 10min 太钝——1001 冒烟实测）。 */
async function download(url: string, dest: string, onPct?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8 * 60 * 1000) })
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  const ws = fs.createWriteStream(dest)
  const reader = Readable.fromWeb(res.body as any)[Symbol.asyncIterator]()
  let got = 0
  try {
    for (;;) {
      let idleT: any = null
      const idle = new Promise<never>((_, rej) => { idleT = setTimeout(() => rej(new Error('下载停滞（60s 无数据）')), 60_000) })
      let nxt: IteratorResult<Buffer>
      try {
        nxt = await Promise.race([reader.next(), idle]) as IteratorResult<Buffer>
      } finally {
        clearTimeout(idleT)   // ★必须清：留着会变成未处理拒绝（炸进程）
      }
      if (nxt.done) break
      ws.write(nxt.value)
      got += nxt.value.length
      if (total > 0 && onPct) onPct(Math.min(85, Math.round(got / total * 85)))
    }
  } finally {
    await new Promise<void>((r) => ws.end(() => r()))
  }
}

function run(cmd: string, args: string[], timeoutMs = 10 * 60 * 1000, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, cwd }, (err) => err ? reject(err) : resolve())
  })
}

/* ★1001 七批：带依赖的 npm 包装法（pi/dsh 用）——pnpm 单文件自举（本机无 npm，npm registry 可达）。
   pnpm 装进 external-agents\_tools\（装一次全家共用）；启动器把 node 绝对路径写死（PATH 里没 node 的教训）。 */
async function ensurePnpm(set: (p: { phase: string; percent?: number }) => void): Promise<string> {
  const root = path.join(EXT_AGENTS_DIR, '_tools')
  const pjs = path.join(root, 'pnpm', 'package', 'bin', 'pnpm.cjs')
  if (fs.existsSync(pjs)) return pjs
  set({ phase: '准备 pnpm' })
  const r = await fetch('https://registry.npmjs.org/pnpm', { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`pnpm 元数据失败 ${r.status}`)
  const j = await r.json()
  /* ★1001 七批实测：新版 pnpm 是"原生二进制引导包"（无 bin/pnpm.cjs，install.js 还要再联网拉真身）——
     钉经典 JS 版（bin 字段是 pnpm.cjs 的最高版本），解包即用不再二次下载。 */
  const classic = Object.keys(j.versions || {})
    .filter(v => String((j.versions[v]?.bin || {})?.pnpm || '').endsWith('pnpm.cjs'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const ver = classic[classic.length - 1]
  const tarball = ver && j.versions?.[ver]?.dist?.tarball
  if (!tarball) throw new Error('pnpm 经典版 tarball 缺失')
  fs.mkdirSync(path.join(root, 'pnpm'), { recursive: true })
  const tmp = path.join(root, '_pnpm.tgz')
  await download(String(tarball), tmp)
  await run('tar', ['-xf', tmp, '-C', path.join(root, 'pnpm')])
  try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  if (!fs.existsSync(pjs)) throw new Error('pnpm 解包后没找到 bin/pnpm.cjs')
  return pjs
}

async function viaNpmDeps(recipe: ExtAgentRecipe, ch: Extract<ExtChannel, { kind: 'npm-deps' }>, dir: string, set: (p: { phase: string; percent?: number }) => void): Promise<void> {
  set({ phase: `查询 ${ch.pkg}`, percent: 0 })
  const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(ch.pkg)}`, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`npm registry 查询失败 ${r.status}`)
  const j = await r.json()
  const ver = j['dist-tags']?.latest
  const tarball = ver && j.versions?.[ver]?.dist?.tarball
  if (!tarball) throw new Error('npm 元数据里没有 tarball')
  const pkgDir = path.join(dir, 'package')
  const tmp = path.join(dir, '..', `_dl_${recipe.id}.tgz`)
  set({ phase: `下载 ${ch.pkg}@${ver}`, percent: 0 })
  await download(String(tarball), tmp, (pct) => set({ phase: `下载 ${ch.pkg}`, percent: pct }))
  set({ phase: '解包', percent: 88 })
  // ★tgz 自带 package/ 前缀——解到 dir 就正好是 dir/package（解到 pkgDir 会套娃成 package/package，1001 冒烟实测）
  await run('tar', ['-xf', tmp, '-C', dir])
  try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) throw new Error('解包后没找到 package/package.json')
  const pnpm = await ensurePnpm(set)
  set({ phase: '安装依赖', percent: 92 })
  await run(process.execPath, [pnpm, 'install', '--prod'], 15 * 60 * 1000, pkgDir)
  set({ phase: '写启动器', percent: 97 })
  // 启动器：node 绝对路径写死（本机 PATH 没 node——0924 教训）；.cmd 便于外部直接起
  const binPath = path.join(pkgDir, ...ch.bin.split('/')).replace(/\//g, '\\')
  fs.writeFileSync(path.join(dir, ch.shim), `@echo off\r\n"${process.execPath}" "${binPath}" %*\r\n`, 'utf8')
}

async function viaGithubRelease(recipe: ExtAgentRecipe, ch: Extract<ExtChannel, { kind: 'github-release' }>, dir: string, set: (p: { phase: string; percent?: number }) => void): Promise<void> {
  const repo = recipe.repo.replace('https://github.com/', '')
  set({ phase: '查询 GitHub 最新版' })
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'user-agent': 'nis-external-installer' }, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`GitHub releases 查询失败 ${r.status}`)
  const j = await r.json()
  const asset = (j.assets || []).find((a: any) => ch.asset.test(String(a.name)))
  if (!asset) throw new Error(`最新版 ${j.tag_name || ''} 里没找到匹配资产（${ch.asset}）`)
  set({ phase: `下载 ${asset.name}`, percent: 0 })
  const tmp = path.join(dir, '..', `_dl_${recipe.id}${path.extname(String(asset.name)) || '.bin'}`)
  await download(String(asset.browser_download_url), tmp, (pct) => set({ phase: `下载 ${asset.name}`, percent: pct }))
  set({ phase: '解包', percent: 90 })
  await run('tar', ['-xf', tmp, '-C', dir])
  try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
}

async function viaPypiPip(recipe: ExtAgentRecipe, ch: Extract<ExtChannel, { kind: 'pypi-pip' }>, dir: string, set: (p: { phase: string; percent?: number }) => void): Promise<void> {
  set({ phase: '从 PyPI 安装（解析依赖）' })   // pip 无总量 → 不给 percent，UI 走动效条
  await run(pyExe(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--upgrade', '--prefix', dir, ch.pkg])
}

async function viaNpmTarball(recipe: ExtAgentRecipe, ch: Extract<ExtChannel, { kind: 'npm-tarball' }>, dir: string, set: (p: { phase: string; percent?: number }) => void): Promise<void> {
  set({ phase: '查询 npm 最新版' })
  const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(ch.pkg)}`, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`npm registry 查询失败 ${r.status}`)
  const j = await r.json()
  const ver = j['dist-tags']?.latest
  const tarball = ver && j.versions?.[ver]?.dist?.tarball
  if (!tarball) throw new Error('npm 元数据里没有 tarball')
  set({ phase: `下载 ${ch.pkg}@${ver}`, percent: 0 })
  const tmp = path.join(dir, '..', `_dl_${recipe.id}.tgz`)
  await download(String(tarball), tmp, (pct) => set({ phase: `下载 ${ch.pkg}`, percent: pct }))
  set({ phase: '解包', percent: 90 })
  await run('tar', ['-xf', tmp, '-C', dir])
  try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
}

export function listExternalAgents(): ExtAgentStatus[] {
  return EXT_AGENTS.map((r) => {
    const meta = readMeta(r.id)
    const entry = meta.entry && fs.existsSync(meta.entry) ? String(meta.entry) : (findBinary(dirOf(r.id), r.binName) || undefined)
    const installed = !!entry
    return {
      id: r.id, name: r.name, desc: r.desc, repo: r.repo, engine: r.engine,
      logo: EXT_LOGOS[r.id],
      installed,
      version: installed ? (meta.version || '未知') : undefined,
      channel: installed ? (meta.channel || '未知') : undefined,
      entry,
      installedAt: meta.installedAt,
      hasKey: !!getExternalKey(r.id),
      consoleUrl: QUOTA_URLS[r.id],
      live: live.get(r.id),
      pendingSource: r.pendingSource,
    }
  })
}

/** 安装（异步跑渠道链；实时进度看 listExternalAgents 的 live）。返回已开跑/即时错误。 */
export function startInstall(id: string): { ok: boolean; error?: string } {
  const recipe = findRecipe(id)
  if (!recipe) return { ok: false, error: '未知的外部 agent' }
  if (installInFlight(id)) return { ok: false, error: '正在安装中' }
  /* ★1010：除 Codex 外一律不开放安装（前端按钮已置灰，这里再拒一次 —— 防止绕过界面直调 RPC）。
     口径：外部 agent 都不内置，用户自己选装；目前只放 Codex。 */
  if (recipe.pendingSource) return { ok: false, error: recipe.pendingSource }
  if (recipe.channels.length === 0) return { ok: false, error: recipe.pendingSource || '暂无可用安装渠道' }
  live.set(id, { phase: '准备中', percent: 0 })
  const set = (p: { phase: string; percent?: number }) => live.set(id, { ...p })
  void (async () => {
    const dir = dirOf(id)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      const errors: string[] = []
      for (const ch of recipe.channels) {
        try {
          if (ch.kind === 'github-release') await viaGithubRelease(recipe, ch, dir, set)
          else if (ch.kind === 'pypi-pip') await viaPypiPip(recipe, ch, dir, set)
          else if (ch.kind === 'npm-deps') await viaNpmDeps(recipe, ch, dir, set)
          else await viaNpmTarball(recipe, ch, dir, set)
          set({ phase: '收尾', percent: 95 })
          const entry = findBinary(dir, recipe.binName)
          if (!entry) throw new Error(`装完没找到入口 ${recipe.binName}`)
          const version = ch.kind === 'github-release' ? 'latest' : ch.kind === 'pypi-pip' ? 'PyPI 最新' : 'npm 最新'
          fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({
            id, version, channel: ch.kind, entry, installedAt: Date.now(),
            note: '由 NIS 外部 agent 安装器落盘；卸载=删本目录+删预设',
          }, null, 2), 'utf8')
          /* 以我们可用的格式接入：注册预设（可拆装——卸载一并删）。
             role 必填（后端校验"role 不能为空"）：外部 agent 的人设由它自己决定，这里如实备注。 */
          const reg = writeAgentPreset({
            id, name: recipe.name, description: recipe.desc,
            role: `（外部 agent「${recipe.name}」：能力与人设由它自己的配置决定，NIS 负责调度与显示。）`,
            avatar: EXT_LOGOS[id],   // ★1001：预设头像=它应用的 logo
            engine: recipe.engine as any, modelSource: 'nis', builtin: false,
          })
          if (!reg?.ok) console.warn('[externalAgents] 预设注册失败：', JSON.stringify(reg))
          live.delete(id)
          return
        } catch (e: any) {
          errors.push(`${ch.kind}: ${e?.message || e}`)
        }
      }
      live.set(id, { phase: '失败', error: errors.join(' ｜ ') })
    } catch (e: any) {
      live.set(id, { phase: '失败', error: String(e?.message || e) })
    }
  })()
  return { ok: true }
}

/** 卸载（可拆装的"拆"）：删安装目录 + 删注册的预设 + **删凭据**（key 与登录态，★1001 三批已定案） */
export function uninstallExternalAgent(id: string): { ok: boolean; error?: string } {
  const recipe = findRecipe(id)
  if (!recipe) return { ok: false, error: '未知的外部 agent' }
  if (installInFlight(id)) return { ok: false, error: '正在安装中，稍后再卸' }
  try {
    fs.rmSync(dirOf(id), { recursive: true, force: true })
    const p = readAgentPreset(id)
    if (p && p.engine && p.engine !== 'native') deleteAgentPreset(id)
    // 凭据一并清：① 我们存的 API Key ② 它自己的登录态（尽力删已知路径，缺失无害）
    setExternalKey(id, '')
    const home = os.homedir()
    for (const rel of AUTH_PATHS[id] || []) {
      try { fs.rmSync(path.join(home, rel), { force: true }) } catch { /* 没有=本来就没登录 */ }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
