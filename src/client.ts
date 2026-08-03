import crypto from "node:crypto"
import type { AccountData, GetUpdatesResponse } from "./types.js"
import { MSG_ITEM_TEXT, MSG_STATE_FINISH, MSG_TYPE_BOT } from "./types.js"
import type { IlinkTransport, SendTextInput } from "./wechat-gateway.js"
import { WeChatStore } from "./store.js"

const ILINK_BASE = "https://ilinkai.weixin.qq.com"
const BOT_TYPE = "3"
const LONG_POLL_TIMEOUT_MS = 35_000
const NETWORK_CODE_LIMIT = 32
const NETWORK_CODE_PATTERN = /^[A-Z0-9_]+$/

export enum IlinkErrorCode {
  SessionTimeout = -14,
}

export enum IlinkNetworkFailure {
  Dns = "dns",
  Connection = "connection",
  Timeout = "timeout",
  Tls = "tls",
  Unknown = "unknown",
}

enum NetworkErrorCode {
  DnsNotFound = "ENOTFOUND",
  DnsAgain = "EAI_AGAIN",
  ConnectionRefused = "ECONNREFUSED",
  ConnectionReset = "ECONNRESET",
  NetworkUnreachable = "ENETUNREACH",
  HostUnreachable = "EHOSTUNREACH",
  TimedOut = "ETIMEDOUT",
  CertificateExpired = "CERT_HAS_EXPIRED",
  CertificateInvalid = "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  SelfSignedCertificate = "DEPTH_ZERO_SELF_SIGNED_CERT",
}

export interface IlinkApiFailure {
  endpoint: string
  status?: number
  ret?: number
  errcode?: number
  errmsg?: string
}

export class IlinkApiError extends Error {
  readonly details: IlinkApiFailure

  constructor(details: IlinkApiFailure) {
    const safeDetails = { ...details, errmsg: sanitizeErrorMessage(details.errmsg) }
    // 保留协议错误字段，便于诊断而不输出请求凭据。
    super(
      `微信 API 失败: endpoint=${safeDetails.endpoint} ret=${formatCode(safeDetails.ret)} ` +
        `errcode=${formatCode(safeDetails.errcode)} errmsg=${safeDetails.errmsg || "unknown"}`,
    )
    this.name = "IlinkApiError"
    this.details = safeDetails
  }

  get code(): number | undefined {
    return failureCode(this.details)
  }
}

export class IlinkNetworkError extends Error {
  readonly endpoint: string
  readonly code: string | undefined
  readonly kind: IlinkNetworkFailure

  constructor(endpoint: string, error: unknown) {
    // 将底层 fetch cause 转成可操作、无凭据的网络诊断。
    const code = networkErrorCode(error)
    const kind = classifyNetworkFailure(error, code)
    super(`微信 API 网络错误: ${networkFailureAdvice(kind)} code=${code ?? "unknown"} endpoint=${endpoint}`, {
      cause: error,
    })
    this.name = "IlinkNetworkError"
    this.endpoint = endpoint
    this.code = code
    this.kind = kind
  }
}

interface NetworkRequest {
  endpoint: string
  url: string | URL
  init: RequestInit
}

export function isSessionTimeoutError(error: unknown): boolean {
  // ret 为 0 时仍需识别 errcode=-14，避免继续使用失效上下文。
  return (
    error instanceof IlinkApiError &&
    (error.details.ret === IlinkErrorCode.SessionTimeout ||
      error.details.errcode === IlinkErrorCode.SessionTimeout)
  )
}

export function requiresContextRefresh(error: unknown): boolean {
  // 只有有明确业务错误码且不是会话失效时，才等待新入站上下文。
  return error instanceof IlinkApiError && error.code !== undefined && !isSessionTimeoutError(error)
}

interface QRCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
}

interface QRCodeStatus {
  status?: "wait" | "scaned" | "confirmed" | "expired"
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export class IlinkClientTransport implements IlinkTransport {
  private pendingLoginAccount: AccountData | null = null

  constructor(
    private readonly store: WeChatStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async login(
    onQRCode?: (value: string) => void | Promise<void>,
    force = false,
    signal?: AbortSignal,
  ): Promise<AccountData> {
    // 二维码发布和状态轮询共享取消信号，插件退出后不残留登录任务。
    signal?.throwIfAborted()
    const storedAccount = this.store.loadAccount()
    if (storedAccount && !force) return storedAccount
    const qr = await this.requestQRCode(signal)
    await onQRCode?.(qr.qrcode_img_content)
    return this.waitForLogin(qr.qrcode, signal)
  }

  private async requestQRCode(signal?: AbortSignal): Promise<Required<QRCodeResponse>> {
    // 二维码标识和可渲染内容必须同时存在。
    const response = await this.fetchJSON(
      `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
      signal,
    ) as QRCodeResponse
    if (!response.qrcode || !response.qrcode_img_content) throw new Error("微信二维码响应无效")
    return { qrcode: response.qrcode, qrcode_img_content: response.qrcode_img_content }
  }

  private async waitForLogin(qrcode: string, signal?: AbortSignal): Promise<AccountData> {
    // 二维码有效期内轮询确认，超时后停止使用本次标识。
    const deadline = Date.now() + 480_000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const account = confirmedAccount(await this.fetchQRCodeStatus(qrcode, signal))
      if (account) return this.rememberPendingAccount(account)
      await sleep(1_000, signal)
    }
    throw new Error("微信二维码登录超时")
  }

  private rememberPendingAccount(account: AccountData): AccountData {
    // 强制登录账号仅在新绑定原子提交前临时用于 poll。
    this.pendingLoginAccount = account
    return account
  }

  private async fetchQRCodeStatus(qrcode: string, signal?: AbortSignal): Promise<QRCodeStatus | null> {
    // 状态长轮询的单次网络超时只代表暂时无响应，继续等待二维码有效期。
    try {
      return (await this.fetchJSON(
        `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        signal,
      )) as QRCodeStatus
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (isTimeout(error)) return null
      throw error
    }
  }

  async poll(cursor: string, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    try {
      return (await this.apiCall(
        "ilink/bot/getupdates",
        {
          get_updates_buf: cursor,
          base_info: { channel_version: "1.0.0" },
        },
        LONG_POLL_TIMEOUT_MS,
        signal,
      )) as GetUpdatesResponse
    } catch (error) {
      if (isTimeout(error)) return { ret: 0, msgs: [], get_updates_buf: cursor }
      throw error
    }
  }

  async sendText(input: SendTextInput): Promise<void> {
    // 具名对象固定发送边界，新增可选项时不改变调用参数顺序。
    await this.apiCall("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: input.to,
        client_id: `opencode-wechat:${crypto
          .createHash("sha256")
          .update(input.idempotencyKey)
          .digest("hex")
          .slice(0, 32)}`,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: input.text } }],
        context_token: input.contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    }, 15_000, input.signal)
  }

  private async apiCall(
    endpoint: string,
    body: object,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const storedAccount = this.store.loadAccount()
    if (
      this.pendingLoginAccount &&
      storedAccount?.accountId === this.pendingLoginAccount.accountId &&
      storedAccount.token === this.pendingLoginAccount.token
    ) {
      this.pendingLoginAccount = null
    }
    const account = this.pendingLoginAccount ?? storedAccount
    if (!account) throw new Error("微信尚未登录")

    const bodyText = JSON.stringify(body)
    const url = new URL(endpoint, withTrailingSlash(account.baseUrl))
    const response = await this.request({
      endpoint: url.pathname,
      url,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${account.token}`,
          "X-WECHAT-UIN": randomWechatUin(),
        },
        body: bodyText,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new IlinkApiError({ endpoint: url.pathname, status: response.status })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new IlinkApiError({ endpoint: url.pathname, status: response.status, errmsg: "invalid JSON" })
    }
    const failure = parseApiFailure(parsed, url.pathname, response.status)
    if (failure) throw new IlinkApiError(failure)
    return parsed
  }

  private async fetchJSON(url: string, signal?: AbortSignal): Promise<unknown> {
    const target = new URL(url)
    const response = await this.request({
      endpoint: target.pathname,
      url: target,
      init: { signal: withTimeout(signal, 15_000) },
    })
    if (!response.ok) throw new Error(`微信 API 请求失败: HTTP ${response.status}`)
    return response.json()
  }

  private async request(options: NetworkRequest): Promise<Response> {
    // 所有微信 fetch 统一在此保留底层错误码并移除敏感请求信息。
    try {
      return await this.fetcher(options.url, options.init)
    } catch (error) {
      if (options.init.signal?.aborted) throw options.init.signal.reason
      if (error instanceof IlinkNetworkError) throw error
      throw new IlinkNetworkError(options.endpoint, error)
    }
  }
}

function confirmedAccount(status: QRCodeStatus | null): AccountData | null {
  // 只有 confirmed 响应能产生临时账号，过期状态立即失败。
  if (!status) return null
  if (status.status === "expired") throw new Error("微信二维码已过期")
  if (status.status !== "confirmed") return null
  if (!status.ilink_bot_id || !status.bot_token || !status.ilink_user_id) {
    throw new Error("微信登录确认响应缺少账号、令牌或用户标识")
  }
  return {
    token: status.bot_token,
    baseUrl: status.baseurl || ILINK_BASE,
    accountId: status.ilink_bot_id,
    userId: status.ilink_user_id,
    savedAt: new Date().toISOString(),
  }
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function randomWechatUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64")
}

function isTimeout(error: unknown): boolean {
  // 包装后的网络超时仍用于轮询重试判断。
  if (error instanceof IlinkNetworkError) return error.kind === IlinkNetworkFailure.Timeout
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // 登录等待使用可取消定时器，停止插件后立即释放流程。
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  // 调用方取消与网络超时任一到达都应终止请求。
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function parseApiFailure(value: unknown, endpoint: string, status: number): IlinkApiFailure | null {
  // ret 或 errcode 任一非零都视为业务失败，兼容两种服务端响应形态。
  if (!isRecord(value)) return null
  const ret = readNumber(value.ret)
  const errcode = readNumber(value.errcode)
  if (failureCode({ ret, errcode }) === undefined) return null
  return {
    endpoint,
    status,
    ret,
    errcode,
    errmsg: sanitizeErrorMessage(typeof value.errmsg === "string" ? value.errmsg : undefined),
  }
}

function failureCode(details: Pick<IlinkApiFailure, "ret" | "errcode">): number | undefined {
  // 优先使用非零 ret，否则兼容仅返回 errcode 的接口。
  if (typeof details.ret === "number" && details.ret !== 0) return details.ret
  if (typeof details.errcode === "number" && details.errcode !== 0) return details.errcode
  return undefined
}

function readNumber(value: unknown): number | undefined {
  // 拒绝字符串和无穷值，避免错误码比较被隐式转换影响。
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatCode(value: number | undefined): string {
  // 诊断中统一显示缺失错误码，避免输出 undefined。
  return typeof value === "number" ? String(value) : "none"
}

function sanitizeErrorMessage(value: string | undefined): string | undefined {
  // 截断并替换常见凭据格式，防止服务端 errmsg 泄露令牌。
  if (!value) return undefined
  return value
    .slice(0, 200)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:context|bot)[_-]?token["'=:\s]+[^\s,}]+/gi, "token=[REDACTED]")
}

function networkErrorCode(error: unknown): string | undefined {
  // Node fetch 通常把系统错误码放在 cause，兼容顶层直抛形态。
  const direct = safeNetworkCode(error)
  if (direct) return direct
  return safeNetworkCode(isRecord(error) ? error.cause : undefined)
}

function safeNetworkCode(value: unknown): string | undefined {
  // 只允许短大写错误码进入日志，拒绝服务端文本和任意对象内容。
  if (!isRecord(value) || typeof value.code !== "string") return undefined
  const code = value.code.slice(0, NETWORK_CODE_LIMIT)
  return NETWORK_CODE_PATTERN.test(code) ? code : undefined
}

function classifyNetworkFailure(error: unknown, code: string | undefined): IlinkNetworkFailure {
  // 按系统错误码映射为稳定的用户处理建议。
  if (isNativeTimeout(error) || code === NetworkErrorCode.TimedOut) return IlinkNetworkFailure.Timeout
  if (code === NetworkErrorCode.DnsNotFound || code === NetworkErrorCode.DnsAgain) {
    return IlinkNetworkFailure.Dns
  }
  if (isConnectionCode(code)) return IlinkNetworkFailure.Connection
  if (isTlsCode(code)) return IlinkNetworkFailure.Tls
  return IlinkNetworkFailure.Unknown
}

function isNativeTimeout(error: unknown): boolean {
  // 原生 AbortSignal 超时没有稳定 code，只能依据标准错误名识别。
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

function isConnectionCode(code: string | undefined): boolean {
  // 连接拒绝、重置与路由不可达统一提示检查网络边界。
  return [
    NetworkErrorCode.ConnectionRefused,
    NetworkErrorCode.ConnectionReset,
    NetworkErrorCode.NetworkUnreachable,
    NetworkErrorCode.HostUnreachable,
  ].includes(code as NetworkErrorCode)
}

function isTlsCode(code: string | undefined): boolean {
  // 常见证书错误提示检查系统时间、证书与中间代理。
  return [
    NetworkErrorCode.CertificateExpired,
    NetworkErrorCode.CertificateInvalid,
    NetworkErrorCode.SelfSignedCertificate,
  ].includes(code as NetworkErrorCode)
}

function networkFailureAdvice(kind: IlinkNetworkFailure): string {
  // 为每类网络故障提供直接可执行的排查方向。
  if (kind === IlinkNetworkFailure.Dns) return "无法解析微信 API 地址，请检查 DNS 或代理"
  if (kind === IlinkNetworkFailure.Connection) return "无法连接微信 API，请检查网络、代理或防火墙"
  if (kind === IlinkNetworkFailure.Timeout) return "连接微信 API 超时，请检查网络或代理"
  if (kind === IlinkNetworkFailure.Tls) return "微信 API TLS 连接失败，请检查系统时间、证书或代理"
  return "微信 API 网络请求失败，请检查网络、代理或防火墙"
}
