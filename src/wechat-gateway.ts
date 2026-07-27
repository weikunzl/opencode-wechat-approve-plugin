import crypto from "node:crypto"
import type { NotificationEnvelope } from "./domain.js"
import { sanitizeNotificationText } from "./notification-utils.js"
import { WeChatStore } from "./store.js"
import type { AccountData, GetUpdatesResponse, WeChatMessage } from "./types.js"
import { MSG_ITEM_TEXT, MSG_STATE_FINISH, MSG_TYPE_USER } from "./types.js"

export interface InboundApprovalMessage {
  messageID: string
  senderID: string
  text: string
  receivedAt: number
}

export interface IlinkTransport {
  login(onQRCode?: (value: string) => void, force?: boolean): Promise<AccountData>
  poll(cursor: string): Promise<GetUpdatesResponse>
  sendText(to: string, text: string, contextToken: string, idempotencyKey: string): Promise<void>
}

export class WeChatGateway {
  private running = false
  private seen: Set<string>

  constructor(
    private readonly store: WeChatStore,
    private readonly transport: IlinkTransport,
  ) {
    this.seen = new Set(store.loadProcessedMessageIDs())
  }

  async initialize(): Promise<"ready" | "needs-binding"> {
    return this.store.loadAccount() && this.store.loadContext() ? "ready" : "needs-binding"
  }

  async bind(onQRCode?: (value: string) => void, force = false): Promise<void> {
    if (!force && this.store.loadAccount() && this.store.loadContext()) return
    const account = await this.transport.login(onQRCode, force)
    if (!account.userId) throw new Error("微信登录响应缺少用户标识")
    let cursor = force ? "" : this.store.loadCursor()

    while (true) {
      const response = await this.transport.poll(cursor)
      if (response.ret !== undefined && response.ret !== 0) {
        throw new Error(`微信轮询失败: ${response.errmsg || response.ret}`)
      }
      if (typeof response.get_updates_buf === "string") {
        cursor = response.get_updates_buf
      }

      for (const raw of response.msgs ?? []) {
        const parsed = parseInbound(raw)
        if (
          !parsed ||
          parsed.group ||
          parsed.message.senderID !== account.userId ||
          normalize(parsed.message.text) !== "绑定"
        ) {
          continue
        }
        if (!parsed.contextToken) throw new Error("绑定消息缺少上下文令牌")
        this.store.commitBinding(
          account,
          {
            boundUserID: account.userId,
            contextToken: parsed.contextToken,
            updatedAt: parsed.message.receivedAt,
          },
          cursor,
        )
        this.seen.add(parsed.message.messageID)
        this.store.saveProcessedMessageIDs([...this.seen])
        return
      }
    }
  }

  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): void {
    if (this.running) return
    this.running = true
    void this.pollLoop(onMessage)
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async pollOnce(
    onMessage: (message: InboundApprovalMessage) => Promise<void>,
    binding = false,
  ): Promise<void> {
    const response = await this.transport.poll(this.store.loadCursor())
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`微信轮询失败: ${response.errmsg || response.ret}`)
    }

    if (typeof response.get_updates_buf === "string") {
      this.store.saveCursor(response.get_updates_buf)
    }

    const account = this.store.loadAccount()
    const current = this.store.loadContext()
    const ownerID = binding ? account?.userId : current?.boundUserID ?? account?.userId

    for (const raw of response.msgs ?? []) {
      const parsed = parseInbound(raw)
      if (!parsed || !ownerID || parsed.message.senderID !== ownerID) continue
      if (parsed.group || this.seen.has(parsed.message.messageID)) continue

      this.seen.add(parsed.message.messageID)
      this.store.saveProcessedMessageIDs([...this.seen])
      const bindingMessage = binding && normalize(parsed.message.text) === "绑定"
      if (binding && !bindingMessage) continue
      if (bindingMessage && !parsed.contextToken) {
        throw new Error("绑定消息缺少上下文令牌")
      }
      if (parsed.contextToken) {
        this.store.saveContext({
          boundUserID: ownerID,
          contextToken: parsed.contextToken,
          updatedAt: parsed.message.receivedAt,
        })
      }

      await onMessage(parsed.message)
    }
    if (!binding && this.store.loadOutbox().length > 0) {
      await this.flushOutbox()
    }
  }

  async send(notification: NotificationEnvelope): Promise<void> {
    const safeNotification = {
      ...notification,
      text: sanitizeNotificationText(notification.text),
    }
    this.store.enqueueNotification(safeNotification)
    const context = this.store.loadContext()
    if (!context) throw new Error("微信尚未绑定，缺少通知上下文")

    await this.transport.sendText(
      context.boundUserID,
      safeNotification.text,
      context.contextToken,
      safeNotification.id,
    )
    this.store.ackNotification(safeNotification.id)
  }

  async flushOutbox(): Promise<void> {
    for (const notification of this.store.loadOutbox()) {
      await this.send(notification)
    }
  }

  private async pollLoop(onMessage: (message: InboundApprovalMessage) => Promise<void>): Promise<void> {
    let failures = 0
    while (this.running) {
      try {
        await this.pollOnce(onMessage)
        failures = 0
      } catch (error) {
        failures++
        const delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 250)
        console.error(`[wechat] 轮询异常: ${redact(error)}`)
        await sleep(delay)
      }
    }
  }
}

function parseInbound(
  raw: WeChatMessage,
): { message: InboundApprovalMessage; contextToken: string | null; group: boolean } | null {
  if (raw.message_type !== MSG_TYPE_USER || raw.message_state !== MSG_STATE_FINISH) return null
  const text = raw.item_list?.find((item) => item.type === MSG_ITEM_TEXT)?.text_item?.text?.trim()
  if (!text || !raw.from_user_id) return null

  const receivedAt = raw.create_time_ms ?? Date.now()
  const messageID =
    raw.message_id ??
    crypto
      .createHash("sha256")
      .update(`${raw.from_user_id}\u0000${receivedAt}\u0000${text}`)
      .digest("hex")
      .slice(0, 24)

  return {
    message: {
      messageID,
      senderID: raw.from_user_id,
      text,
      receivedAt,
    },
    contextToken: raw.context_token ?? null,
    group: Boolean(raw.group_id),
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[。！!，,\s]/g, "")
}

function redact(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/context[_-]?token["'=:\s]+[^\s,}]+/gi, "context_token=[REDACTED]")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
