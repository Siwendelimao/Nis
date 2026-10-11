/**
 * 自定义工具沙箱（0911 安全整改）
 *
 * ── 问题 ──
 * 原实现：`new AsyncFunction('args','fetch','console', 用户代码)`。
 * 形参只是障眼法 —— 函数体实际跑在 Node 主 realm 的全局作用域里，
 * 于是 `process`（含全部环境变量 / API Key）、`require('node:child_process')`、
 * `fs` 等全部可直达。防线只剩"每次执行弹权限卡"，而完全访问/自审计模式下直通。
 *
 * ── 本模块做什么 ──
 * 1. 用 `node:vm` 建独立 realm：没有 process / require / module / Buffer / global 等 Node 全局；
 * 2. `codeGeneration: { strings: false, wasm: false }` —— 禁止沙箱内 `eval` / `new Function`，
 *    堵死经典的 `x.constructor.constructor('return process')()` 逃逸；
 * 3. 注入的 fetch / console / sleep 全部"在沙箱内包一层再暴露"，
 *    并立刻删除宿主原始桥（`delete globalThis.__rawX`），使宿主 Function 构造器不可攀；
 * 4. args 经 JSON 往返，避免把宿主对象（其 .constructor 指向宿主）递进沙箱；
 * 5. fetch 仅放行 http(s) / data 协议；执行有同步超时 + 整体超时。
 *
 * ── 边界（必须诚实）──
 * Node 官方明确：vm **不是安全边界**（"not a security mechanism"）。本模块是"显著抬高门槛"，
 * 不是绝对隔离 —— 零日逃逸理论上仍可能存在。因此：
 *   · 自定义工具的执行审批卡（高风险，必弹）仍是主防线，不要关；
 *   · 需要硬隔离时，后续可升级为 worker_threads / 子进程 + 独立 `--permission` 权限模型。
 */
import vm from 'node:vm'

/** 同步段（不含 await）最长执行时间：挡住死循环 */
const MAX_SYNC_MS = 10_000
/** 整体（含异步）最长执行时间 */
const DEFAULT_TIMEOUT_MS = 30_000

export class ToolSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolSandboxError'
  }
}

/** 语法试编译（不执行）：把代码按"async 函数体"解析，返回错误信息或 null */
export function checkToolCodeSyntax(code: string): string | null {
  try {
    // 只做 parse：包成 async IIFE 与运行期完全同形
    new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'custom-tool.js' })
    return null
  } catch (e: any) {
    return String(e?.message || e).slice(0, 200)
  }
}

interface SandboxRunOptions {
  /** 整体超时（毫秒），默认 30000 */
  timeoutMs?: number
}

/** 在隔离 realm 中执行自定义工具代码，返回其 return 值 */
export async function runSandboxedToolCode(
  code: string,
  args: unknown,
  opts: SandboxRunOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // ── 宿主侧原始桥（引导脚本执行后立即从沙箱全局删除）──
  const rawFetch = (input: any, init?: any) => {
    const url = String(input ?? '')
    let proto = ''
    try {
      proto = new URL(url).protocol
    } catch {
      throw new Error(`fetch 仅支持 http(s)/data URL，收到：${url.slice(0, 80)}`)
    }
    if (proto !== 'http:' && proto !== 'https:' && proto !== 'data:') {
      throw new Error(`fetch 协议不被允许：${proto}`)
    }
    return fetch(url, init)
  }
  const rawConsole = {
    log: (...a: any[]) => console.log('[custom-tool]', ...a),
    info: (...a: any[]) => console.info('[custom-tool]', ...a),
    warn: (...a: any[]) => console.warn('[custom-tool]', ...a),
    error: (...a: any[]) => console.error('[custom-tool]', ...a),
  }
  const rawSleep = (ms: number) =>
    new Promise<void>(resolve => {
      const n = Math.min(Math.max(Number(ms) || 0, 0), 10_000)
      setTimeout(resolve, n)
    })

  // args 经 JSON 字符串传入、**在沙箱内 JSON.parse** → 得到 realm 原生对象。
  // （若在宿主侧 parse，对象属宿主 realm，其 .constructor 可攀到宿主 Function → 逃逸）
  let argsJson = '{}'
  try {
    argsJson = JSON.stringify(args ?? {})
  } catch {
    argsJson = '{}'
  }

  const context: Record<string, unknown> = {
    __rawArgsJson: argsJson,
    __rawFetch: rawFetch,
    __rawConsole: rawConsole,
    __rawSleep: rawSleep,
  }

  // DONT_CONTEXTIFY：让 globalThis 是"该 realm 自己的普通对象"，
  // 而不是宿主对象的代理 —— 否则 `globalThis.constructor.constructor('return process')()` 可逃逸。
  const sandbox = vm.createContext(vm.constants.DONT_CONTEXTIFY as any, {
    name: 'custom-tool-sandbox',
    // 关键：禁止沙箱内字符串代码生成（eval / new Function）
    codeGeneration: { strings: false, wasm: false },
  }) as Record<string, unknown>
  // 把桥接到沙箱全局（仅引导期存在，引导脚本末尾即删除）
  for (const [k, v] of Object.entries(context)) sandbox[k] = v

  // 引导：在沙箱 realm 内定义包装函数（其 .constructor 属沙箱 Function，
  // 且已被 codeGeneration 限制），随后删除宿主原始桥。
  // 用 IIFE 形参把宿主函数"捕获进闭包"，避免依赖已被删除的全局标识符。
  vm.runInContext(
    `
    globalThis.args = JSON.parse(__rawArgsJson);
    /* ★0927 netfix（P0-2）：桥的**返回值**也在沙箱内构造 —— 原样递出宿主 Promise/Response 时，
       sleep(1).constructor.constructor('return process')() 可攀回宿主 Function 逃逸（实测拿到 process）。
       现：fetch 返回沙箱内构造的纯数据对象（ok/status/statusText/url/headers/body/text()/json()），
       sleep 返回沙箱 Promise（Promise.resolve 采纳宿主 thenable 后是 realm 原生 Promise）。 */
    globalThis.fetch = ((raw) => async (url, init) => {
      const r = await raw(url, init);
      let body = '';
      try { body = await r.text(); } catch (e) { body = ''; }
      const hdr = {};
      try { for (const [k, v] of r.headers.entries()) hdr[k] = String(v); } catch (e) { /* ignore */ }
      return {
        ok: !!r.ok, status: Number(r.status) || 0, statusText: String(r.statusText || ''),
        url: String(r.url || ''), headers: hdr, body: body,
        text: () => body,
        json: () => JSON.parse(body),
      };
    })(__rawFetch);
    globalThis.console = ((rc) => ({
      log:   (...a) => rc.log(...a),
      info:  (...a) => rc.info(...a),
      warn:  (...a) => rc.warn(...a),
      error: (...a) => rc.error(...a),
    }))(__rawConsole);
    globalThis.sleep = ((raw) => (ms) => Promise.resolve(raw(ms)))(__rawSleep);
    delete globalThis.__rawArgsJson;
    delete globalThis.__rawFetch;
    delete globalThis.__rawConsole;
    delete globalThis.__rawSleep;
    `,
    sandbox,
  )

  let promise: unknown
  try {
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'custom-tool.js' })
    promise = script.runInContext(sandbox, { timeout: MAX_SYNC_MS })
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (/Script execution timed out/i.test(msg)) {
      throw new ToolSandboxError(`执行超时（同步段超过 ${MAX_SYNC_MS}ms，疑似死循环）`)
    }
    throw new ToolSandboxError(msg.slice(0, 300))
  }

  // 整体超时（异步段无法强杀，只能让调用方及时拿到失败）
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolSandboxError(`执行超时（超过 ${timeoutMs}ms）`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([Promise.resolve(promise), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
