import crypto from "node:crypto"
import type { AccountData, GetUpdatesResponse } from "./types.js"
import { MSG_ITEM_TEXT, MSG_STATE_FINISH, MSG_TYPE_BOT } from "./types.js"
import type { IlinkTransport } from "./wechat-gateway.js"
import { WeChatStore } from "./store.js"

const ILINK_BASE = "https://ilinkai.weixin.qq.com"
const BOT_TYPE = "3"
const LONG_POLL_TIMEOUT_MS = 35_000

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
  private account: AccountData | null

  constructor(
    private readonly store: WeChatStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.account = store.loadAccount()
  }

  async login(onQRCode?: (value: string) => void): Promise<AccountData> {
    if (this.account) return this.account

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
        this.account = {
          token: status.bot_token,
          baseUrl: status.baseurl || ILINK_BASE,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        }
        return this.account
      }
      await sleep(1_000)
    }
    throw new Error("微信二维码登录超时")
  }

  async poll(cursor: string): Promise<GetUpdatesResponse> {
    try {
      return (await this.apiCall(
        "ilink/bot/getupdates",
        {
          get_updates_buf: cursor,
          base_info: { channel_version: "1.0.0" },
        },
        LONG_POLL_TIMEOUT_MS,
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

  private async apiCall(endpoint: string, body: object, timeoutMs = 15_000): Promise<unknown> {
    const account = this.account ?? this.store.loadAccount()
    if (!account) throw new Error("微信尚未登录")

    const bodyText = JSON.stringify(body)
    const response = await this.fetcher(new URL(endpoint, withTrailingSlash(account.baseUrl)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${account.token}`,
        "X-WECHAT-UIN": randomWechatUin(),
      },
      body: bodyText,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`微信 API 请求失败: HTTP ${response.status}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error("微信 API 返回了无效 JSON")
    }
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
