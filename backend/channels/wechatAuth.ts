/**
 * 微信扫码登录 —— 移植腾讯官方 `@tencent-weixin/openclaw-weixin`（MIT）的扫码流程
 *
 * 参考源码：`backend/_research_wx/package/src/auth/login-qr.ts`（官方，459 行）
 * 官方协议（README 已公开）：
 *   ① POST {base}/ilink/bot/get_bot_qrcode?bot_type=3  body { local_token_list: [] }
 *      → { qrcode, qrcode_img_content }     ← img_content 是给用户扫的二维码 URL
 *   ② GET  {base}/ilink/bot/get_qrcode_status?qrcode=<qrcode>   （35s 长轮询）
 *      → { status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id?, redirect_host? }
 *      status 状态机：
 *        wait / scaned / need_verifycode / verify_code_blocked / expired
 *        / scaned_but_redirect / confirmed / binded_redirect
 *
 * 与原版的差异（适配 NIS 场景）：
 *   - 原版是终端 CLI（二维码画在终端、验证码用 stdin 读）→ 这里改成**返回给前端**，
 *     二维码用 `<img src={qrcodeUrl}>` 展示，验证码由前端输入回传
 *   - 登录态由 NIS 自己保存到 channelsStore 的 wechat.bots[0]
 */
import crypto from 'node:crypto'
import QRCode from 'qrcode'

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** ilink bot_type：本通道固定 3（与官方 DEFAULT_ILINK_BOT_TYPE 一致） */
const DEFAULT_BOT_TYPE = '3'
/** 长轮询客户端超时（服务端会 hold 到这个时间） */
const QR_POLL_TIMEOUT_MS = 35_000
/** 登录会话有效期（官方 5 分钟） */
const LOGIN_TTL_MS = 5 * 60_000
/** 二维码最多刷新次数（官方 3 次） */
const MAX_REFRESH = 3

type QrStatus =
  | 'wait' | 'scaned' | 'confirmed' | 'expired'
  | 'scaned_but_redirect' | 'need_verifycode'
  | 'verify_code_blocked' | 'binded_redirect'

interface ActiveLogin {
  qrcode: string
  /** 官方落地页 URL（展示为可点链接的兜底） */
  qrcodeUrl: string
  /** 自绘二维码图片 dataURL（前端 <img src> 直接用） */
  qrImage: string
  startedAt: number
  status: QrStatus
  /** 待提交的验证码（用户输入后暂存，下次轮询带上） */
  pendingVerifyCode?: string
  /** 当前轮询用的 base（IDC 重定向会改） */
  currentBase: string
  refreshCount: number
  /** 已确认的登录结果 */
  result?: { botToken: string; accountId: string; baseUrl: string; userId: string }
  error?: string
}

/** 会话表（按 sessionKey 索引；一次性登录流程，登录完成即删） */
const logins = new Map<string, ActiveLogin>()

/** ILINK app id —— 官方用 package.json 的 ilink_appid 字段，值为 "bot" */
const ILINK_APP_ID = 'bot'

function log(...a: any[]) { console.log('[wechatAuth]', ...a) }

/** X-WECHAT-UIN：随机 uint32 → 十进制串 → base64（照官方实现） */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': '0',
  }
  if (token?.trim()) h.Authorization = `Bearer ${token.trim()}`
  return h
}

function purgeExpired() {
  const now = Date.now()
  for (const [k, v] of logins) {
    if (now - v.startedAt > LOGIN_TTL_MS) logins.delete(k)
  }
}

/* ── 二维码获取 ────────────────────────────────────────── */

/**
 * 官方返回的 `qrcode_img_content` 是**微信的落地页 URL**（一个 SPA，用 JS 渲染二维码），
 * 不是图片本身 —— 直接塞 `<img src>` 会加载失败（实测：content-type 是 text/html）。
 * 所以这里**自己把它生成二维码图片**（dataURL，前端 `<img>` 直接能用）。
 *
 * 用户扫这个码 → 打开微信的授权页面 → 确认 → 后端轮询到 confirmed。
 */
async function qrcodeToDataUrl(content: string): Promise<string> {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

async function fetchQrCode(botType: string): Promise<{ qrcode: string; qrcodeUrl: string; qrImage: string }> {
  const url = `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ local_token_list: [] }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`get_bot_qrcode ${res.status}: ${text.slice(0, 200)}`)
  const j = JSON.parse(text)
  if (!j?.qrcode || !j?.qrcode_img_content) {
    throw new Error(`get_bot_qrcode 返回异常: ${text.slice(0, 200)}`)
  }
  // 自己生成二维码图片（官方给的是落地页 URL，不能直接当图片用）
  let qrImage = ''
  try {
    qrImage = await qrcodeToDataUrl(String(j.qrcode_img_content))
  } catch (e: any) {
    log(`生成二维码图片失败（前端将退化为展示链接）: ${String(e?.message || e).slice(0, 120)}`)
  }
  return { qrcode: j.qrcode, qrcodeUrl: String(j.qrcode_img_content), qrImage }
}

/* ── 状态轮询（35s 长轮询）──────────────────────────────── */

async function pollStatus(
  base: string,
  qrcode: string,
  verifyCode?: string,
): Promise<{ status: QrStatus; raw: any }> {
  let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), QR_POLL_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/${ep}`, { method: 'GET', headers: headers(), signal: ctrl.signal })
    const text = await res.text()
    clearTimeout(timer)
    if (!res.ok) {
      // 网关超时（如 Cloudflare 524）等：按「等待」继续轮询（照官方处理）
      log(`pollStatus HTTP ${res.status}，按 wait 继续`)
      return { status: 'wait', raw: {} }
    }
    const j = JSON.parse(text)
    return { status: (j?.status || 'wait') as QrStatus, raw: j }
  } catch (e: any) {
    clearTimeout(timer)
    // 客户端超时 / 网络错误 → 当 wait（官方同款处理：不中断登录流程）
    log(`pollStatus 异常（按 wait 继续）: ${String(e?.message || e).slice(0, 120)}`)
    return { status: 'wait', raw: {} }
  }
}

/* ── 对外 API ──────────────────────────────────────────── */

interface QrStartResult {
  ok: boolean
  sessionKey: string
  /** 二维码图片 dataURL（前端 <img src> 直接展示） */
  qrImage?: string
  /** 官方落地页链接（兜底/复制用） */
  qrcodeUrl?: string
  /** 状态：wait=待扫码 … */
  status: QrStatus
  message: string
}

/** 发起扫码登录：拿二维码返回给前端 */
export async function startQrLogin(botType = DEFAULT_BOT_TYPE): Promise<QrStartResult> {
  purgeExpired()
  const sessionKey = crypto.randomUUID()
  try {
    const { qrcode, qrcodeUrl, qrImage } = await fetchQrCode(botType)
    log(`二维码已获取（sessionKey=${sessionKey.slice(0, 8)}，图片 ${qrImage ? '已生成' : '生成失败'}）`)
    logins.set(sessionKey, {
      qrcode, qrcodeUrl, qrImage,
      startedAt: Date.now(),
      status: 'wait',
      currentBase: FIXED_BASE_URL,
      refreshCount: 1,
    })
    return { ok: true, sessionKey, qrImage, qrcodeUrl, status: 'wait', message: '请用手机微信扫码' }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300)
    log(`发起扫码失败: ${msg}`)
    return { ok: false, sessionKey, status: 'expired', message: `获取二维码失败：${msg}` }
  }
}

interface QrWaitResult {
  ok: boolean
  status: QrStatus
  connected: boolean
  /** 已连接过（binded_redirect）—— 也算成功，无需重复连 */
  alreadyConnected?: boolean
  /** need_verifycode 时提示前端弹出校验码输入框 */
  needVerifyCode?: boolean
  accountId?: string
  nickname?: string
  /** ⚠️ 扫码成功后拿到的 bot 凭据 —— 必须落盘（secret），后续 getupdates/sendmessage 全靠它 */
  botToken?: string
  /** 服务端指定的接入点（默认 ilinkai.weixin.qq.com） */
  baseUrl?: string
  /** 绑定此 bot 的微信用户 id */
  userId?: string
  /** 二维码图片 dataURL（刷新后前端要换图） */
  qrImage?: string
  /** 官方落地页链接（兜底/复制用） */
  qrcodeUrl?: string
  message: string
}

/**
 * 轮询扫码结果（前端每 ~1s 调一次；内部是 35s 长轮询，所以不会打爆）。
 * @param verifyCode 用户在手机微信上看到的数字（need_verifycode 时传）
 */
export async function waitQrLogin(sessionKey: string, verifyCode?: string): Promise<QrWaitResult> {
  const lg = logins.get(sessionKey)
  if (!lg) return { ok: false, status: 'expired', connected: false, message: '登录会话不存在或已过期，请重新获取二维码' }
  if (Date.now() - lg.startedAt > LOGIN_TTL_MS) {
    logins.delete(sessionKey)
    return { ok: false, status: 'expired', connected: false, message: '二维码已过期，请重新获取' }
  }
  if (verifyCode) lg.pendingVerifyCode = verifyCode

  const { status, raw } = await pollStatus(lg.currentBase, lg.qrcode, lg.pendingVerifyCode)
  lg.status = status

  switch (status) {
    case 'wait':
      return { ok: true, status, connected: false, message: '等待扫码…', qrcodeUrl: lg.qrcodeUrl, qrImage: lg.qrImage }

    case 'scaned':
      // 验证码被接受 → 清暂存
      if (lg.pendingVerifyCode) lg.pendingVerifyCode = undefined
      return { ok: true, status, connected: false, message: '已扫码，请在手机上确认', qrcodeUrl: lg.qrcodeUrl, qrImage: lg.qrImage }

    case 'need_verifycode':
      return {
        ok: true, status, connected: false, needVerifyCode: true,
        message: lg.pendingVerifyCode ? '数字不匹配，请重新输入' : '请输入手机微信上显示的数字',
        qrcodeUrl: lg.qrcodeUrl,
      }

    case 'verify_code_blocked': {
      lg.pendingVerifyCode = undefined
      lg.refreshCount += 1
      if (lg.refreshCount > MAX_REFRESH) {
        logins.delete(sessionKey)
        return { ok: false, status, connected: false, message: '多次输入错误，请稍后再试' }
      }
      try {
        const { qrcode, qrcodeUrl, qrImage } = await fetchQrCode(DEFAULT_BOT_TYPE)
        lg.qrcode = qrcode; lg.qrcodeUrl = qrcodeUrl; lg.qrImage = qrImage; lg.startedAt = Date.now()
        return { ok: true, status, connected: false, message: '多次输错，二维码已刷新，请重新扫描', qrcodeUrl, qrImage }
      } catch {
        logins.delete(sessionKey)
        return { ok: false, status, connected: false, message: '刷新二维码失败' }
      }
    }

    case 'expired': {
      lg.refreshCount += 1
      if (lg.refreshCount > MAX_REFRESH) {
        logins.delete(sessionKey)
        return { ok: false, status, connected: false, message: '二维码多次失效，请重新获取' }
      }
      try {
        const { qrcode, qrcodeUrl, qrImage } = await fetchQrCode(DEFAULT_BOT_TYPE)
        lg.qrcode = qrcode; lg.qrcodeUrl = qrcodeUrl; lg.qrImage = qrImage; lg.startedAt = Date.now()
        return { ok: true, status, connected: false, message: '二维码已过期，已自动刷新', qrcodeUrl, qrImage }
      } catch {
        logins.delete(sessionKey)
        return { ok: false, status, connected: false, message: '刷新二维码失败' }
      }
    }

    case 'scaned_but_redirect': {
      const host = raw?.redirect_host
      if (host) {
        lg.currentBase = `https://${host}`
        log(`IDC 重定向 → ${host}`)
      }
      return { ok: true, status, connected: false, message: '正在切换接入点…', qrcodeUrl: lg.qrcodeUrl, qrImage: lg.qrImage }
    }

    case 'binded_redirect':
      logins.delete(sessionKey)
      return {
        ok: true, status, connected: false, alreadyConnected: true,
        message: '该微信已连接过本机，无需重复连接',
      }

    case 'confirmed': {
      if (!raw?.ilink_bot_id) {
        logins.delete(sessionKey)
        return { ok: false, status, connected: false, message: '登录失败：服务器未返回账号标识' }
      }
      const result = {
        botToken: String(raw.bot_token || ''),
        accountId: String(raw.ilink_bot_id),
        baseUrl: String(raw.baseurl || FIXED_BASE_URL),
        userId: String(raw.ilink_user_id || ''),
      }
      lg.result = result
      log(`✅ 扫码确认：accountId=${result.accountId}`)
      logins.delete(sessionKey)
      return {
        ok: true, status, connected: true,
        accountId: result.accountId,
        // 凭据必须回传并落盘 —— 之前只回 accountId，导致「显示已连接但服务端认为掉线」
        botToken: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId,
        nickname: result.userId ? result.userId.slice(0, 12) : '',
        message: '已连接微信',
      }
    }

    default:
      return { ok: true, status: 'wait', connected: false, message: '等待扫码…', qrcodeUrl: lg.qrcodeUrl, qrImage: lg.qrImage }
  }
}

/** 主动取消登录（关弹窗时调） */
export function cancelQrLogin(sessionKey: string): void {
  logins.delete(sessionKey)
}
