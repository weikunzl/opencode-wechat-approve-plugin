import crypto from "node:crypto"
import type { AccountData, GetUpdatesResponse } from "./types.js"
import { MSG_ITEM_TEXT, MSG_STATE_FINISH, MSG_TYPE_BOT } from "./types.js"
import type { IlinkTransport } from "./wechat-gateway.js"
import { WeChatStore } from "./store.js"

const ILINK_BASE = "https://ilinkai.weixin.qq.com"
const BOT_TYPE = "3"
const LONG_POLL_TIMEOUT_MS = 35_000

export enum IlinkErrorCode {
  SessionTimeout = -14,
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

  async login(onQRCode?: (value: string) => void, force = false): Promise<AccountData> {
    const storedAccount = this.store.loadAccount()
    if (storedAccount && !force) return storedAccount

    const response = await this.fetchJSON(
      `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    )
    const qr = response as QRCodeResponse
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("微信二维码响应无效")
    onQRCode?.(qr.qrcode_img_content)

    const deadline = Date.now() + 480_000
    while (Date.now() < deadline) {
      const raw = await this.fetchJSON(
        `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
      )
      const status = raw as QRCodeStatus
      if (status.status === "expired") throw new Error("微信二维码已过期")
      if (status.status === "confirmed") {
        if (!status.ilink_bot_id || !status.bot_token || !status.ilink_user_id) {
          throw new Error("微信登录确认响应缺少账号、令牌或用户标识")
        }
        this.pendingLoginAccount = {
          token: status.bot_token,
          baseUrl: status.baseurl || ILINK_BASE,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        }
        return this.pendingLoginAccount
      }
      await sleep(1_000)
    }
    throw new Error("微信二维码登录超时")
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

  async sendText(
    to: string,
    text: string,
    contextToken: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.apiCall("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `opencode-wechat:${crypto
          .createHash("sha256")
          .update(idempotencyKey)
          .digest("hex")
          .slice(0, 32)}`,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    })
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
    const response = await this.fetcher(url, {
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

  private async fetchJSON(url: string): Promise<unknown> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`微信 API 请求失败: HTTP ${response.status}`)
    return response.json()
  }
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function randomWechatUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64")
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
