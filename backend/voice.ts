/**
 * 语音模块（语音输入 ASR / 朗读 TTS）—— 0920 新增
 *
 * 既定的口径：
 *  · **模型是增量包**：装到 `<envDir>/voice/`，**不进安装包**（否则刚瘦到 ~55MB 的安装包又变大）；
 *  · **多模型预设**：像供应商那样可多装，**各自独立配置**（音色/语速互不牵扯），**朗读只启用一个**；
 *  · **关掉开关就释放**：卸载 native 引擎 + 丢引用（不常驻内存）；
 *  · 底层 = `sherpa-onnx-node`（k2-fsa 官方 Node 绑定）。
 *    本机实测：运行时 23MB（含 onnxruntime.dll），Windows **免编译、零 Python、零显卡**。
 *
 * ⚠️ 与「供应商 / 环境」两套体系的区别：语音模型**只落 `<envDir>/voice/`**，
 *    既不跟"存储目录"（storagePath）走，也不进 `%APPDATA%`——它是本机能力，换机器要重装。
 *
 * 为什么不用 npm 装运行时：NIS 打包版里没有 npm/pnpm，也不该为用户机器装 Node 工具链。
 * 直接把 npm registry 上那两个包（纯 js 包 + 平台 .node/.dll 包）下下来解到本地即可，
 * 目录结构正好命中 sherpa 自己的 `addon-static-import.js` 查找表（`./node_modules/sherpa-onnx-<平台>/sherpa-onnx.node`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

/* ────────────────────────── 常量与模型清单 ────────────────────────── */

/** 运行时版本（必须与 npm 上两个包一致） */
const SHERPA_VERSION = '1.13.8'
/** npm 注册表镜像（按顺序试；npmmirror 国内快） */
const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
/** HuggingFace 镜像（国内可直连；实测 17MB/s） */
const HF_ENDPOINTS = ['https://hf-mirror.com']

/** 平台包名（sherpa 的命名：win32 → win） */
function platformPkg(): string {
  const plat = process.platform === 'win32' ? 'win' : process.platform
  const arch = process.arch
  return `sherpa-onnx-${plat}-${arch}`
}

interface VoiceModelDef {
  id: string
  kind: 'asr' | 'tts'
  name: string
  desc: string
  tags: string[]
  /** HF 仓库（csukuangfj 官方镜像，模型与 GitHub release 完全一致） */
  repo: string
  /** 只下这些（精确路径，或以 `/` 结尾表示整个目录） */
  include: string[]
  /** 运行时必需文件（相对 <modelDir>/）；存在即视为「已安装」 */
  marker: string
  /** 体积口径（MB，官方压缩包大小，UI 展示用） */
  approxMB: number
  /** 采样率（TTS 输出 / ASR 输入） */
  sampleRate?: number
  /** TTS：可选音色（不列 = 按 numSpeakers 自动生成） */
  voices?: { id: number; label: string }[]
  /** TTS：默认音色 */
  defaultSid?: number
  /** 备注（UI 上角的灰色小字） */
  note?: string
}

/**
 * 语音模型清单（**只放"实测跑过 + 确认可用"的**，不凑数）。
 *
 * 选型依据（本机实测，2026-09-20）：
 *  · fanchen-C：16kHz / 187 音色 / **RTF 0.32**（33 字 2.4s）→ 推荐默认
 *  · aishell3 int8：40MB 模型 / 174 音色 / RTF 0.86 / 但只有 8kHz（听感偏闷）→ 省体积
 *  · kokoro int8：24kHz 音质最好，但 **RTF 1.96**（慢 6 倍）→ 只给不着急的人
 *  · SenseVoice int8：识别 **RTF 0.04**（7s 音频 0.28s 出字）→ 语音输入
 *  · Audio8 0.1B：44.1kHz 音质最好，但实测 RTF 6.6~8.5（44 字要 90 秒）且官方锁死 CPU → 不纳入
 */
const VOICE_MODELS: VoiceModelDef[] = [
  {
    id: 'sensevoice-small-int8',
    kind: 'asr',
    name: 'SenseVoice Small',
    desc: '语音输入识别（中英日韩粤，带标点）',
    tags: ['int8', '离线', '5 语种'],
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    include: ['model.int8.onnx', 'tokens.txt'],
    marker: 'model.int8.onnx',
    approxMB: 229,
    sampleRate: 16000,
    note: '实测 7 秒音频 0.28 秒出字（RTF 0.04）',
  },
  {
    id: 'vits-zh-hf-fanchen-C',
    kind: 'tts',
    name: 'VITS 中文（推荐）',
    desc: '朗读默认模型：187 个音色，速度快',
    tags: ['16kHz', '187 音色', '推荐'],
    repo: 'csukuangfj/vits-zh-hf-fanchen-C',
    include: [
      'vits-zh-hf-fanchen-C.onnx',
      'tokens.txt',
      'lexicon.txt',
      'number.fst',
      'date.fst',
      'phone.fst',
      'new_heteronym.fst',
      'dict/',
    ],
    marker: 'vits-zh-hf-fanchen-C.onnx',
    approxMB: 132,
    sampleRate: 16000,
    note: '实测 RTF 0.32 —— 33 字约 2.4 秒合成完',
  },
  {
    id: 'vits-zh-aishell3',
    kind: 'tts',
    name: 'VITS 中文（最小）',
    desc: '体积最小，174 个音色，音质一般',
    tags: ['40MB', '174 音色', '8kHz'],
    repo: 'csukuangfj/vits-zh-aishell3',
    include: [
      'vits-aishell3.int8.onnx',
      'tokens.txt',
      'lexicon.txt',
      'number.fst',
      'date.fst',
      'phone.fst',
      'new_heteronym.fst',
    ],
    marker: 'vits-aishell3.int8.onnx',
    approxMB: 45,
    sampleRate: 8000,
    note: '8kHz 采样率，听感偏闷，胜在只占 45MB',
  },
  {
    id: 'kokoro-int8-multi-lang-v1_1',
    kind: 'tts',
    name: 'Kokoro（最高音质）',
    desc: '24kHz 音质最好，但速度慢约 6 倍',
    tags: ['24kHz', '8 个中文音色', '偏慢'],
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    include: [
      'model.int8.onnx',
      'voices.bin',
      'tokens.txt',
      'lexicon-zh.txt',
      'lexicon-us-en.txt',
      'lexicon-gb-en.txt',
      'number-zh.fst',
      'date-zh.fst',
      'phone-zh.fst',
      'dict/',
      'espeak-ng-data/',
    ],
    marker: 'model.int8.onnx',
    approxMB: 210,
    sampleRate: 24000,
    /* v1.1 的中文音色：45~48 女声、49~52 男声（其余是英/日/韩音色，不列出来免得挑花眼） */
    voices: [
      { id: 45, label: '中文女声 1' },
      { id: 46, label: '中文女声 2' },
      { id: 47, label: '中文女声 3' },
      { id: 48, label: '中文女声 4' },
      { id: 49, label: '中文男声 1' },
      { id: 50, label: '中文男声 2' },
      { id: 51, label: '中文男声 3' },
      { id: 52, label: '中文男声 4' },
    ],
    defaultSid: 45,
    note: '实测 RTF 1.96，长句等待明显（胜在 24kHz 音质）',
  },
]

export function findModel(id: string): VoiceModelDef | undefined {
  return VOICE_MODELS.find((m) => m.id === id)
}

/* ────────────────────────── 目录 ────────────────────────── */

/** 语音根目录（envDir 由调用方给：dev = <数据根>/env，打包版 = <安装目录>/data/env） */
function voiceRoot(envDir: string): string {
  return path.join(envDir, 'voice')
}
function runtimeDir(envDir: string): string {
  return path.join(voiceRoot(envDir), 'runtime')
}
function modelsDir(envDir: string): string {
  return path.join(voiceRoot(envDir), 'models')
}
function modelDir(envDir: string, id: string): string {
  return path.join(modelsDir(envDir), id)
}
function configFile(envDir: string): string {
  return path.join(voiceRoot(envDir), 'config.json')
}

/** 运行时「装好了」的判据：主 js + 平台 .node 都在 */
export function runtimeInstalled(envDir: string): boolean {
  const rt = runtimeDir(envDir)
  const js = path.join(rt, 'sherpa-onnx-node', 'sherpa-onnx.js')
  const node = path.join(rt, 'sherpa-onnx-node', 'node_modules', platformPkg(), 'sherpa-onnx.node')
  return fs.existsSync(js) && fs.existsSync(node)
}

function modelInstalled(envDir: string, def: VoiceModelDef): boolean {
  try {
    return fs.statSync(path.join(modelDir(envDir, def.id), def.marker)).size > 0
  } catch {
    return false
  }
}

/** 已装模型占的磁盘空间（字节） */
function dirSize(p: string): number {
  let total = 0
  const walk = (d: string): void => {
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const f = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(f)
        else total += fs.statSync(f).size
      } catch {
        /* ignore */
      }
    }
  }
  walk(p)
  return total
}

/* ────────────────────────── 配置（voice/config.json） ────────────────────────── */

interface VoiceModelCfg {
  /** 该模型自己的音色与语速（切模型各自恢复，互不牵扯） */
  sid: number
  speed: number
}
interface VoiceConfig {
  /** 语音输入开关 */
  asrEnabled: boolean
  /** 朗读开关 */
  ttsEnabled: boolean
  /** 语音输入用哪个模型 */
  asrModel: string
  /** 朗读启用哪个模型（**只能一个**） */
  ttsModel: string
  /** 每个模型自己的配置 */
  models: Record<string, VoiceModelCfg>
  /** 推理线程数（实测 4 是甜点：小模型线程越多反而越慢） */
  numThreads: number
}

function defaultCfg(): VoiceConfig {
  const firstTts = VOICE_MODELS.find((m) => m.kind === 'tts')
  const firstAsr = VOICE_MODELS.find((m) => m.kind === 'asr')
  return {
    asrEnabled: false,
    ttsEnabled: false,
    asrModel: firstAsr?.id || '',
    ttsModel: firstTts?.id || '',
    models: {},
    numThreads: 4,
  }
}

export function loadCfg(envDir: string): VoiceConfig {
  const base = defaultCfg()
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(envDir), 'utf8'))
    if (raw && typeof raw === 'object') {
      return {
        asrEnabled: !!raw.asrEnabled,
        ttsEnabled: !!raw.ttsEnabled,
        asrModel: typeof raw.asrModel === 'string' && raw.asrModel ? raw.asrModel : base.asrModel,
        ttsModel: typeof raw.ttsModel === 'string' && raw.ttsModel ? raw.ttsModel : base.ttsModel,
        models: raw.models && typeof raw.models === 'object' ? raw.models : {},
        numThreads: clampThreads(raw.numThreads),
      }
    }
  } catch {
    /* 首次运行：没有配置文件 */
  }
  return base
}

export function saveCfg(envDir: string, cfg: VoiceConfig): void {
  try {
    fs.mkdirSync(voiceRoot(envDir), { recursive: true })
    fs.writeFileSync(configFile(envDir), JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    console.error('[voice] 保存配置失败：', e)
  }
}

function clampThreads(n: unknown): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v < 1) return 4
  return Math.min(Math.max(v, 1), 8)
}

/** 取某模型自己的配置（缺省 = 该模型默认值） */
export function modelCfg(cfg: VoiceConfig, def: VoiceModelDef): VoiceModelCfg {
  const c = cfg.models[def.id]
  const sid = Number.isFinite(Number(c?.sid)) ? Number(c.sid) : (def.defaultSid ?? 0)
  const speed = Number.isFinite(Number(c?.speed)) ? Number(c.speed) : 1
  return { sid, speed: Math.min(Math.max(speed, 0.5), 2) }
}

/* ────────────────────────── 语音状态（给前端） ────────────────────────── */

export interface VoiceModelState {
  id: string
  kind: 'asr' | 'tts'
  name: string
  desc: string
  tags: string[]
  note: string
  approxMB: number
  installed: boolean
  /** 运行时是否就绪（未就绪时"安装模型"会连带装运行时） */
  ready: boolean
  sizeBytes: number
  sampleRate: number
  /** TTS：可选音色；`total` 是模型真实音色总数（未命名时只给序号） */
  voices?: { id: number; label: string }[]
  voiceTotal?: number
  /** 该模型自己的配置 */
  sid?: number
  speed?: number
  /** 是否当前启用（TTS 单选 / ASR 单选） */
  active: boolean
}

export interface VoiceState {
  runtimeInstalled: boolean
  runtimeVersion: string
  root: string
  asrEnabled: boolean
  ttsEnabled: boolean
  asrModel: string
  ttsModel: string
  numThreads: number
  /** 引擎当前是否已加载在内存里（前端显示"已就绪/待首次使用"） */
  asrLoaded: boolean
  ttsLoaded: boolean
  models: VoiceModelState[]
}

function buildVoices(def: VoiceModelDef, total: number): { voices: { id: number; label: string }[]; total: number } {
  if (def.voices && def.voices.length) return { voices: def.voices, total }
  // 没有命名表 → 用序号（fanchen 187 / aishell3 174 都没给名字）
  const cap = Math.min(total || 0, 200)
  const voices: { id: number; label: string }[] = []
  for (let i = 0; i < cap; i++) voices.push({ id: i, label: `音色 ${String(i + 1).padStart(3, '0')}` })
  return { voices, total }
}

export function voiceState(envDir: string): VoiceState {
  const cfg = loadCfg(envDir)
  const rt = runtimeInstalled(envDir)
  const models: VoiceModelState[] = VOICE_MODELS.map((def) => {
    const installed = modelInstalled(envDir, def)
    const mc = modelCfg(cfg, def)
    const st: VoiceModelState = {
      id: def.id,
      kind: def.kind,
      name: def.name,
      desc: def.desc,
      tags: def.tags,
      note: def.note || '',
      approxMB: def.approxMB,
      installed,
      ready: installed && rt,
      sizeBytes: installed ? dirSize(modelDir(envDir, def.id)) : 0,
      sampleRate: def.sampleRate || 0,
      active: def.kind === 'tts' ? cfg.ttsModel === def.id : cfg.asrModel === def.id,
    }
    if (def.kind === 'tts') {
      st.sid = mc.sid
      st.speed = mc.speed
      const v = buildVoices(def, def.voices?.length ? def.voices.length : guessedSpeakers(def.id))
      st.voices = v.voices
      st.voiceTotal = v.total
    }
    return st
  })
  return {
    runtimeInstalled: rt,
    runtimeVersion: SHERPA_VERSION,
    root: voiceRoot(envDir),
    asrEnabled: cfg.asrEnabled,
    ttsEnabled: cfg.ttsEnabled,
    asrModel: cfg.asrModel,
    ttsModel: cfg.ttsModel,
    numThreads: cfg.numThreads,
    asrLoaded: !!asrEngine,
    ttsLoaded: !!ttsEngine,
    models,
  }
}

/** 音色数（未装模型时给"官方标称值"，UI 能把音色列表先画出来） */
function guessedSpeakers(id: string): number {
  if (id === 'vits-zh-hf-fanchen-C') return 187
  if (id === 'vits-zh-aishell3') return 174
  if (id === 'kokoro-int8-multi-lang-v1_1') return 103
  return 0
}

/* ────────────────────────── 作业（安装 / 卸载） ────────────────────────── */

interface VoiceJobState {
  id: string
  targetId: string
  kind: 'install' | 'remove'
  status: 'running' | 'done' | 'error'
  percent: number
  phase: string
  stage: 'prep' | 'runtime' | 'download' | 'extract' | 'done'
  bytes: number
  totalBytes: number
  speedBps: number
  etaSec: number
  log: string[]
  error: string
  startedAt: number
  finishedAt?: number
  /** 内部用：作业绑定的环境目录 */
  _envDir?: string
}

const jobs = new Map<string, VoiceJobState>()
let jobSeq = 0

function newJob(envDir: string, targetId: string, kind: 'install' | 'remove'): VoiceJobState {
  const job: VoiceJobState = {
    id: `v${Date.now().toString(36)}${(++jobSeq).toString(36)}`,
    targetId,
    kind,
    status: 'running',
    percent: -1,
    phase: kind === 'install' ? '准备…' : '清理…',
    stage: 'prep',
    bytes: 0,
    totalBytes: 0,
    speedBps: 0,
    etaSec: 0,
    log: [],
    error: '',
    startedAt: Date.now(),
    _envDir: envDir,
  }
  jobs.set(job.id, job)
  // 只留最近 20 个作业
  if (jobs.size > 20) {
    const first = jobs.keys().next().value
    if (first !== undefined) jobs.delete(first)
  }
  return job
}

export function voiceJobGet(jobId: string): VoiceJobState | undefined {
  return jobs.get(jobId)
}

/** 正在跑的安装作业（同时只允许一个） */
function busyJob(): VoiceJobState | undefined {
  for (const j of jobs.values()) if (j.status === 'running') return j
  return undefined
}

export function voiceInstallStart(envDir: string, id: string): { ok: boolean; jobId?: string; error?: string } {
  const def = findModel(id)
  if (!def) return { ok: false, error: '未知语音模型' }
  const busy = busyJob()
  if (busy) return { ok: false, error: `已有语音任务进行中（${busy.targetId}）` }
  const job = newJob(envDir, id, 'install')
  void runInstall(envDir, job, def)
  return { ok: true, jobId: job.id }
}

export function voiceRemove(envDir: string, id: string): { ok: boolean; error?: string } {
  const def = findModel(id)
  if (!def) return { ok: false, error: '未知语音模型' }
  const busy = busyJob()
  if (busy) return { ok: false, error: `已有语音任务进行中（${busy.targetId}）` }
  // 正在用这个模型 → 先把引擎卸了，不然删不掉 .onnx（句柄被占）
  if (ttsEngine?.id === id) releaseEngine('tts')
  if (asrEngine?.id === id) releaseEngine('asr')
  const dir = modelDir(envDir, id)
  try {
    // ⚠️ 本机删除有 I/O 税（~200ms/文件），模型动辄几十上百个文件 → 改名到回收站目录，别当场递归删
    const trashRoot = path.join(voiceRoot(envDir), '.trash')
    fs.mkdirSync(trashRoot, { recursive: true })
    const dest = path.join(trashRoot, `${id}-${Date.now()}`)
    if (fs.existsSync(dir)) fs.renameSync(dir, dest)
    // 配置里也把这个模型的条目清掉
    const cfg = loadCfg(envDir)
    delete cfg.models[id]
    saveCfg(envDir, cfg)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}

/* ────────────────────────── 下载 ────────────────────────── */

interface DlTarget { url: string; dest: string; size: number }

function httpGet(url: string, redirects = 0): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'NIS-Voice/1.0' }, timeout: 30000 }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        if (redirects >= 6) return reject(new Error('重定向过多'))
        const next = new URL(res.headers.location, url).toString()
        return resolve(httpGet(next, redirects + 1))
      }
      if (code !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${code}`))
      }
      resolve(res)
    })
    req.on('timeout', () => { req.destroy(new Error('连接超时')) })
    req.on('error', reject)
  })
}

/** 下单个文件到 dest（先写 .part 再改名）；返回实际字节数 */
async function downloadOne(t: DlTarget, onBytes: (delta: number) => void): Promise<number> {
  fs.mkdirSync(path.dirname(t.dest), { recursive: true })
  const part = t.dest + '.part'
  const res = await httpGet(t.url)
  const total = Number(res.headers['content-length'] || t.size || 0)
  let got = 0
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(part)
    res.on('data', (chunk: Buffer) => {
      got += chunk.length
      onBytes(chunk.length)
      if (!ws.write(chunk)) res.pause()
    })
    ws.on('drain', () => res.resume())
    res.on('end', () => ws.end())
    res.on('error', (e) => { ws.destroy(); reject(e) })
    ws.on('error', (e) => { res.destroy(); reject(e) })
    ws.on('finish', () => resolve())
  })
  if (total > 0 && got < total) throw new Error(`下载不完整（${got}/${total} 字节）`)
  fs.renameSync(part, t.dest)
  return got
}

/** 逐个文件下载（带镜像回退） */
async function downloadAll(job: VoiceJobState, targets: DlTarget[]): Promise<void> {
  const totalBytes = targets.reduce((n, t) => n + (t.size || 0), 0)
  job.totalBytes = totalBytes
  job.bytes = 0
  job.percent = totalBytes > 0 ? 0 : -1
  job.stage = 'download'
  const t0 = Date.now()
  let doneBytes = 0
  for (const t of targets) {
    job.phase = `下载 ${path.basename(t.dest)}（${fmtMB(t.size)}）`
    let lastErr: any = null
    let ok = false
    for (const url of mirrorUrls(t.url)) {
      try {
        await downloadOne({ ...t, url }, (d) => {
          job.bytes += d
          if (totalBytes > 0) job.percent = Math.min(99.5, (job.bytes / totalBytes) * 100)
          const el = (Date.now() - t0) / 1000
          if (el > 1) {
            job.speedBps = job.bytes / el
            const remain = Math.max(totalBytes - job.bytes, 0)
            job.etaSec = job.speedBps > 0 ? Math.round(remain / job.speedBps) : 0
          }
        })
        ok = true
        doneBytes += t.size
        break
      } catch (e: any) {
        lastErr = e
        // 回退时要扣掉这个文件已经累加的字节，重试才是对的
        job.bytes = doneBytes
        job.log.push(`镜像失败（${String(e?.message || e)}）：${url}`)
      }
    }
    if (!ok) throw new Error(`下载失败：${path.basename(t.dest)}（${String(lastErr?.message || lastErr)}）`)
  }
}

/** 给一个 URL 生成镜像候选（npm 注册表互换；HF 走 hf-mirror） */
function mirrorUrls(url: string): string[] {
  const out = [url]
  for (const reg of NPM_REGISTRIES) {
    if (url.includes('registry.npmjs.org')) out.push(url.replace('https://registry.npmjs.org', reg))
    else if (url.includes('registry.npmmirror.com') && reg !== 'https://registry.npmmirror.com') {
      out.push(url.replace('https://registry.npmmirror.com', reg))
    }
  }
  return [...new Set(out)]
}

function fmtMB(n: number): string {
  if (!n) return '未知大小'
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
}

/** 列 HF 仓库全部文件（带大小）；只筛 include 里点到的路径 */
async function listRepoFiles(repo: string, include: string[]): Promise<{ path: string; size: number }[]> {
  let lastErr: any = null
  for (const hf of HF_ENDPOINTS) {
    try {
      const body = await fetchText(`${hf}/api/models/${repo}/tree/main?recursive=true`)
      const arr = JSON.parse(body)
      if (!Array.isArray(arr)) throw new Error('返回不是文件列表')
      const files = arr
        .filter((x: any) => x && x.type === 'file' && typeof x.path === 'string')
        .map((x: any) => ({ path: x.path as string, size: Number(x.size) || 0 }))
      const picked = files.filter((f) => include.some((inc) => (inc.endsWith('/') ? f.path.startsWith(inc) : f.path === inc)))
      if (!picked.length) throw new Error('清单里没有任何文件命中（仓库结构可能变了）')
      return picked
    } catch (e: any) {
      lastErr = e
    }
  }
  throw new Error(`取模型清单失败：${String(lastErr?.message || lastErr)}`)
}

function fetchText(url: string, redirects = 0): Promise<string> {
  return httpGet(url, redirects).then(
    (res) =>
      new Promise<string>((resolve, reject) => {
        let s = ''
        res.setEncoding('utf8')
        res.on('data', (d: string) => { s += d })
        res.on('end', () => resolve(s))
        res.on('error', reject)
      }),
  )
}

/* ────────────────────────── 安装流程 ────────────────────────── */

async function runInstall(envDir: string, job: VoiceJobState, def: VoiceModelDef): Promise<void> {
  try {
    /* ① 运行时（sherpa-onnx-node + 平台包）—— 装过一次就跳过 */
    if (!runtimeInstalled(envDir)) {
      await installRuntime(job)
      job.log.push('语音运行时就绪')
    }
    /* ② 模型本体 */
    job.stage = 'prep'
    job.phase = '读取模型清单…'
    const files = await listRepoFiles(def.repo, def.include)
    const dir = modelDir(envDir, def.id)
    const hf = HF_ENDPOINTS[0]
    const targets: DlTarget[] = files.map((f) => ({
      url: `${hf}/${def.repo}/resolve/main/${f.path}`,
      dest: path.join(dir, f.path),
      size: f.size,
    }))
    const totalMB = (targets.reduce((n, t) => n + t.size, 0) / 1048576).toFixed(0)
    job.log.push(`待下载 ${targets.length} 个文件 / 共 ${totalMB}MB`)
    await downloadAll(job, targets)

    /* ③ 校验标记文件真的到位 */
    if (!modelInstalled(envDir, def)) throw new Error('下载完成但关键模型文件缺失（可能镜像返回了错误页）')
    job.status = 'done'
    job.percent = 100
    job.stage = 'done'
    job.phase = '完成'
    job.finishedAt = Date.now()
  } catch (e: any) {
    job.status = 'error'
    job.error = String(e?.message || e).slice(0, 400)
    job.finishedAt = Date.now()
  }
}

/** 装运行时：从 npm 镜像取两个 tgz（纯 js 包 + 平台 .node/.dll 包）解开即可 —— 不需要 npm、不需要编译 */
async function installRuntime(job: VoiceJobState): Promise<void> {
  job.stage = 'runtime'
  job.phase = '准备语音运行时…'
  const rt = runtimeDir(job._envDir!)
  const tmp = path.join(voiceRoot(job._envDir!), '.tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const pkgs = [
    { name: 'sherpa-onnx-node', url: `https://registry.npmmirror.com/sherpa-onnx-node/-/sherpa-onnx-node-${SHERPA_VERSION}.tgz` },
    { name: platformPkg(), url: `https://registry.npmmirror.com/${platformPkg()}/-/${platformPkg()}-${SHERPA_VERSION}.tgz` },
  ]
  // 先单独下载（进度条只算这两个包，几十 MB，很快）
  const dl: DlTarget[] = pkgs.map((p) => ({ url: p.url, dest: path.join(tmp, `${p.name}.tgz`), size: 0 }))
  await downloadAll(job, dl)
  job.stage = 'extract'
  job.percent = -1
  for (let i = 0; i < pkgs.length; i++) {
    const p = pkgs[i]
    job.phase = `解包 ${p.name}`
    const out = i === 0 ? rt : path.join(rt, 'sherpa-onnx-node', 'node_modules')
    fs.mkdirSync(out, { recursive: true })
    const r = await runTar(['-xzf', dl[i].dest, '-C', out])
    if (!r.ok) throw new Error(`解包 ${p.name} 失败：${r.output.slice(0, 200)}`)
    // tgz 里是 package/ → 挪成目标名字
    const pkgDir = path.join(out, 'package')
    const finalDir = path.join(out, p.name)
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true })
    fs.renameSync(pkgDir, finalDir)
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  if (!runtimeInstalled(job._envDir!)) throw new Error('运行时解包后仍找不到 sherpa-onnx.node')
}

function tarExe(): string {
  const p = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'tar.exe')
  return fs.existsSync(p) ? p : 'tar'
}

function runTar(args: string[], timeoutMs = 600000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(tarExe(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err: any, stdout: string, stderr: string) => {
      resolve({ ok: !err, output: [stdout, stderr].filter(Boolean).join('\n').trim() })
    })
  })
}

/* ────────────────────────── 引擎（加载 / 释放） ────────────────────────── */

let ttsEngine: { id: string; inst: any } | null = null
let asrEngine: { id: string; inst: any } | null = null

function requireSherpa(envDir: string): any {
  const entry = path.join(runtimeDir(envDir), 'sherpa-onnx-node', 'sherpa-onnx.js')
  if (!fs.existsSync(entry)) throw new Error('语音运行时未安装（请先在 设置 → 语音 里安装一个模型）')
  const req = createRequire(entry)
  return req(entry)
}

function releaseEngine(kind: 'tts' | 'asr'): void {
  if (kind === 'tts') {
    const e = ttsEngine
    ttsEngine = null
    try { e?.inst?.free?.() } catch { /* 老版本没有 free()：丢引用让 GC 收 */ }
  } else {
    const e = asrEngine
    asrEngine = null
    try { e?.inst?.free?.() } catch { /* ignore */ }
  }
}

/* ★ 0921v（批次 B 第⑥项）：**语音引擎闲置自动释放** ——
   背景：语音运行时 + 模型加载后常驻约 380MB 内存（实测），而语音是"偶尔用一下"的功能。
   做法：每次识别/合成就刷新时间戳并重置定时器；闲置超过 VOICE_IDLE_RELEASE_MS 自动 voiceRelease()。
   取舍：释放后下次识别要重新加载（首次多几百 ms），换长期不占内存。
   定时器 unref：不会拖住进程退出。 */
const VOICE_IDLE_RELEASE_MS = 10 * 60 * 1000   // 闲置 10 分钟自动释放
let voiceLastUsedAt = 0
let voiceLastEnvDir = ''
let voiceIdleTimer: ReturnType<typeof setTimeout> | null = null

/** 每次真正用引擎时调用：刷新闲置计时（调用点 = voiceSpeak / voiceTranscribe） */
function voiceTouch(envDir: string): void {
  voiceLastEnvDir = envDir || voiceLastEnvDir
  voiceLastUsedAt = Date.now()
  if (voiceIdleTimer) clearTimeout(voiceIdleTimer)
  voiceIdleTimer = setTimeout(voiceIdleSweep, VOICE_IDLE_RELEASE_MS)
  try { (voiceIdleTimer as any)?.unref?.() } catch { /* ignore */ }
}

/** 到点检查：仍闲置就释放，否则重排（导出，便于测试手动触发） */
function voiceIdleSweepNow(): { released: boolean; idleMs: number } {
  if (voiceIdleTimer) { clearTimeout(voiceIdleTimer); voiceIdleTimer = null }
  if (!voiceLastUsedAt) return { released: false, idleMs: 0 }
  const idle = Date.now() - voiceLastUsedAt
  if (idle < VOICE_IDLE_RELEASE_MS) { voiceTouch(voiceLastEnvDir); return { released: false, idleMs: idle } }
  const r = voiceRelease(voiceLastEnvDir)
  voiceLastUsedAt = 0
  if (r.released) console.log('[voice] 闲置 ' + Math.round(idle / 60000) + ' 分钟，已自动释放语音引擎（省内存）')
  return { released: r.released, idleMs: idle }
}
function voiceIdleSweep(): void {
  voiceIdleTimer = null
  voiceIdleSweepNow()
}



/** 释放全部引擎（关开关时调；这是"关闭后可释放性能"的落点） */
export function voiceRelease(_envDir: string): { ok: boolean; released: boolean } {
  /* ★ 0921v：手动释放（关开关/卸载）后清掉闲置定时器并把计时归零 */
  if (voiceIdleTimer) { clearTimeout(voiceIdleTimer); voiceIdleTimer = null }
  voiceLastUsedAt = 0
  const had = !!(ttsEngine || asrEngine)
  releaseEngine('tts')
  releaseEngine('asr')
  return { ok: true, released: had }
}

function ensureTts(envDir: string, def: VoiceModelDef, numThreads: number): any {
  if (ttsEngine && ttsEngine.id === def.id) return ttsEngine.inst
  releaseEngine('tts')
  const sherpa = requireSherpa(envDir)
  const M = modelDir(envDir, def.id)
  const j = (f: string) => path.join(M, f)
  const numThreadsClamped = clampThreads(numThreads)
  let cfg: any
  if (def.id === 'kokoro-int8-multi-lang-v1_1') {
    cfg = {
      model: {
        kokoro: {
          model: j('model.int8.onnx'),
          voices: j('voices.bin'),
          tokens: j('tokens.txt'),
          dataDir: j('espeak-ng-data'),
          dictDir: j('dict'),
          lexicon: [j('lexicon-us-en.txt'), j('lexicon-zh.txt')].join(','),
        },
        numThreads: numThreadsClamped,
        provider: 'cpu',
        debug: false,
      },
      maxNumSentences: 1,
      ruleFsts: [j('number-zh.fst'), j('date-zh.fst')].join(','),
    }
  } else if (def.id === 'vits-zh-aishell3') {
    cfg = {
      model: {
        vits: { model: j('vits-aishell3.int8.onnx'), lexicon: j('lexicon.txt'), tokens: j('tokens.txt') },
        numThreads: numThreadsClamped,
        provider: 'cpu',
        debug: false,
      },
      maxNumSentences: 1,
      ruleFsts: [j('number.fst'), j('date.fst'), j('phone.fst')].join(','),
    }
  } else {
    // vits-zh-hf-fanchen-C（默认）
    cfg = {
      model: {
        vits: {
          model: j('vits-zh-hf-fanchen-C.onnx'),
          lexicon: j('lexicon.txt'),
          tokens: j('tokens.txt'),
          dictDir: j('dict'),
        },
        numThreads: numThreadsClamped,
        provider: 'cpu',
        debug: false,
      },
      maxNumSentences: 1,
      ruleFsts: [j('number.fst'), j('date.fst'), j('phone.fst')].join(','),
    }
  }
  const inst = new sherpa.OfflineTts(cfg)
  ttsEngine = { id: def.id, inst }
  return inst
}

function ensureAsr(envDir: string, def: VoiceModelDef, numThreads: number): any {
  if (asrEngine && asrEngine.id === def.id) return asrEngine.inst
  releaseEngine('asr')
  const sherpa = requireSherpa(envDir)
  const M = modelDir(envDir, def.id)
  const inst = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(M, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 1 },
      tokens: path.join(M, 'tokens.txt'),
      numThreads: clampThreads(numThreads),
      provider: 'cpu',
      debug: false,
    },
  })
  asrEngine = { id: def.id, inst }
  return inst
}

/* ────────────────────────── 合成 / 识别 ────────────────────────── */

/** Float32 单声道 → 16bit PCM WAV（内存里拼，不落盘） */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(n * 2, 40)
  let o = 44
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, o)
    o += 2
  }
  return buf
}

interface SpeakResult {
  ok: boolean
  error?: string
  /** base64 WAV */
  audio?: string
  sampleRate?: number
  durationMs?: number
  elapsedMs?: number
  /** 真正被合成的文本（超长会截断） */
  spoken?: string
  truncated?: boolean
}

/** 单次合成的字数上限 —— RTF≈0.32 时 240 字约 5 秒；再长交给前端分句多次调 */
const MAX_SPEAK_CHARS = 600

export async function voiceSpeak(envDir: string, text: string, opts?: { model?: string; sid?: number; speed?: number }): Promise<SpeakResult> {
  voiceTouch(envDir)   // ★ 0921v：刷新闲置计时（闲置到点自动释放引擎）
  const cfg = loadCfg(envDir)
  const modelId = opts?.model || cfg.ttsModel
  const def = findModel(modelId)
  if (!def || def.kind !== 'tts') return { ok: false, error: '朗读模型未启用或不存在' }
  if (!modelInstalled(envDir, def)) return { ok: false, error: `模型「${def.name}」还没安装` }
  let raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return { ok: false, error: '没有可朗读的文本' }
  let truncated = false
  if (raw.length > MAX_SPEAK_CHARS) { raw = raw.slice(0, MAX_SPEAK_CHARS); truncated = true }
  const mc = modelCfg(cfg, def)
  const sid = Number.isFinite(Number(opts?.sid)) ? Number(opts!.sid) : mc.sid
  const speed = Number.isFinite(Number(opts?.speed)) ? Math.min(Math.max(Number(opts!.speed), 0.5), 2) : mc.speed
  try {
    const tts = ensureTts(envDir, def, cfg.numThreads)
    const t0 = Date.now()
    /* 0927 netfix tts-yield-0927：分段合成 + 每段让出事件循环 —— 原整段同步推理，长文本一次
       卡死后端 20s+（所有请求一起冻结）。分段拼接 samples，语义无损（仅断句处韵律有界）。 */
    const segs0927: string[] = []
    for (const piece of raw.split(/(?<=[。！？!?；;.!])/)) {
      const last = segs0927[segs0927.length - 1]
      if (last && (last.length + piece.length) < 220) segs0927[segs0927.length - 1] = last + piece
      else segs0927.push(piece)
    }
    let audio: any = null
    for (const seg of segs0927) {
      if (!seg.trim()) continue
      const a: any = tts.generate({ text: seg, sid, speed })
      if (!audio) audio = a
      else {
        const merged = new Float32Array(audio.samples.length + a.samples.length)
        merged.set(audio.samples, 0)
        merged.set(a.samples, audio.samples.length)
        audio = { samples: merged, sampleRate: a.sampleRate || audio.sampleRate }
      }
      await new Promise((r) => setImmediate(r))
    }
    if (!audio) return { ok: false, error: '没有可朗读的文本' }
    const elapsedMs = Date.now() - t0
    const wav = encodeWav(audio.samples as Float32Array, audio.sampleRate as number)
    return {
      ok: true,
      audio: wav.toString('base64'),
      sampleRate: audio.sampleRate,
      durationMs: Math.round(((audio.samples as Float32Array).length / (audio.sampleRate as number)) * 1000),
      elapsedMs,
      spoken: raw,
      truncated,
    }
  } catch (e: any) {
    releaseEngine('tts') // 构造/推理炸了就丢掉，免得坏实例卡住后续
    return { ok: false, error: String(e?.message || e).slice(0, 300) }
  }
}

interface TranscribeResult {
  ok: boolean
  error?: string
  text?: string
  elapsedMs?: number
}

/** 识别：前端给 16k 单声道 Int16 PCM（base64）—— 不走文件，省一次落盘 */
export function voiceTranscribe(envDir: string, pcmBase64: string, sampleRate: number): TranscribeResult {
  voiceTouch(envDir)   // ★ 0921v：刷新闲置计时（闲置到点自动释放引擎）
  const cfg = loadCfg(envDir)
  const def = findModel(cfg.asrModel)
  if (!def || def.kind !== 'asr') return { ok: false, error: '语音输入模型未启用或不存在' }
  if (!modelInstalled(envDir, def)) return { ok: false, error: `模型「${def.name}」还没安装` }
  let buf: Buffer
  try {
    buf = Buffer.from(String(pcmBase64 || ''), 'base64')
  } catch {
    return { ok: false, error: '音频数据解码失败' }
  }
  if (buf.length < 3200) return { ok: false, error: '录音太短（不到 0.1 秒）' }
  const n = Math.floor(buf.length / 2)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 32768
  const sr = Number(sampleRate) || 16000
  try {
    const rec = ensureAsr(envDir, def, cfg.numThreads)
    const t0 = Date.now()
    const st = rec.createStream()
    st.acceptWaveform({ sampleRate: sr, samples })
    rec.decode(st)
    const text = String(rec.getResult(st).text || '').trim()
    return { ok: true, text, elapsedMs: Date.now() - t0 }
  } catch (e: any) {
    releaseEngine('asr')
    return { ok: false, error: String(e?.message || e).slice(0, 300) }
  }
}