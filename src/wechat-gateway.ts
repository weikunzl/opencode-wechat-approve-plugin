import crypto from "node:crypto"
import { isSessionTimeoutError, requiresContextRefresh } from "./client.js"
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
  poll(cursor: string, signal?: AbortSignal): Promise<GetUpdatesResponse>
  sendText(to: string, text: string, contextToken: string, idempotencyKey: string): Promise<void>
}

export class WeChatGateway {
  private running = false
  private pollController: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null
  private retryContextGeneration: string | null = null
  private seen: Set<string>
  private inboundRecorder: ((message: InboundApprovalMessage) => Promise<void>) | null = null

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
    this.pollController = new AbortController()
    this.pollLoopPromise = this.pollLoop(onMessage, this.pollController.signal)
  }

  setInboundRecorder(recorder: (message: InboundApprovalMessage) => Promise<void>): void {
    // Leader 模式先持久化入站摘要，再推进外部 cursor，避免崩溃丢消息。
    this.inboundRecorder = recorder
  }

  async stop(): Promise<void> {
    this.running = false
    this.pollController?.abort()
    await this.pollLoopPromise
    this.pollController = null
    this.pollLoopPromise = null
  }

  async pollOnce(
    onMessage: (message: InboundApprovalMessage) => Promise<void>,
    binding = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = bindingGeneration(this.store)
    let response: GetUpdatesResponse
    try {
      response = await this.transport.poll(this.store.loadCursor(), signal)
    } catch (error) {
      if (signal?.aborted) return
      const diagnostic = formatTransportError(error, this.store)
      this.handleTransportError(error)
      throw new Error(diagnostic, { cause: error })
    }
    if (signal?.aborted) return
    if (generation !== bindingGeneration(this.store)) return
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`微信轮询失败: ${response.errmsg || response.ret}`)
    }

    const nextCursor = response.get_updates_buf
    if (typeof nextCursor === "string" && !this.inboundRecorder) {
      this.store.saveCursor(nextCursor)
    }

    const account = this.store.loadAccount()
    const current = this.store.loadContext()
    const ownerID = binding ? account?.userId : current?.boundUserID ?? account?.userId

    for (const raw of response.msgs ?? []) {
      const parsed = parseInbound(raw)
      if (!parsed || !ownerID || parsed.message.senderID !== ownerID) continue
      if (parsed.group || this.seen.has(parsed.message.messageID)) continue

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

      if (signal?.aborted) return
      if (this.inboundRecorder) await this.inboundRecorder(parsed.message)
      await onMessage(parsed.message)
      this.seen.add(parsed.message.messageID)
      this.store.saveProcessedMessageIDs([...this.seen])
    }
    if (typeof nextCursor === "string" && this.inboundRecorder) this.store.saveCursor(nextCursor)
    if (!signal?.aborted && !binding && this.store.loadOutbox().length > 0 && this.canFlushOutbox()) {
      await this.flushOutbox()
    }
  }

  async send(notification: NotificationEnvelope): Promise<void> {
    // 业务通知先持久化，只有 transport 成功后才确认出队。
    const safeNotification = this.sanitize(notification)
    this.store.enqueueNotification(safeNotification)
    await this.deliver(safeNotification)
    this.store.ackNotification(safeNotification.id)
  }

  async probe(notification: NotificationEnvelope): Promise<void> {
    // 健康探测不进入业务 outbox，避免恢复后发送过期的启动消息。
    await this.deliver(this.sanitize(notification))
  }

  private async deliver(notification: NotificationEnvelope): Promise<void> {
    // 每次发送都读取最新绑定，使外部 bind 无需重启 transport。
    const context = this.store.loadContext()
    if (!context) throw new Error("微信尚未绑定，缺少通知上下文")
    try {
      await this.transport.sendText(
        context.boundUserID,
        notification.text,
        context.contextToken,
        notification.id,
      )
    } catch (error) {
      const diagnostic = formatTransportError(error, this.store)
      if (requiresContextRefresh(error)) this.retryContextGeneration = bindingGeneration(this.store)
      this.handleTransportError(error)
      throw new Error(diagnostic, { cause: error })
    }
  }

  private sanitize(notification: NotificationEnvelope): NotificationEnvelope {
    // 所有主动消息共用同一脱敏和长度边界。
    return { ...notification, text: sanitizeNotificationText(notification.text) }
  }

  async flushOutbox(): Promise<void> {
    if (!this.store.loadContext()) return
    for (const notification of this.store.loadOutbox()) {
      await this.send(notification)
    }
  }

  private async pollLoop(
    onMessage: (message: InboundApprovalMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0
    while (this.running && !signal.aborted) {
      try {
        await this.pollOnce(onMessage, false, signal)
        failures = 0
      } catch (error) {
        if (signal.aborted) return
        failures++
        const delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 250)
        console.error(`[wechat] 轮询异常: ${redact(error)}`)
        if (!this.running) return
        await sleep(delay, signal)
      }
    }
  }

  private handleTransportError(error: unknown): void {
    // -14 表示会话已失效，停止旧上下文重试并要求用户重新绑定。
    if (!isSessionTimeoutError(error)) return
    this.store.invalidateContext()
    this.running = false
  }

  private canFlushOutbox(): boolean {
    // prepare failed 后必须等入站消息带来新 context，避免旧令牌循环重试。
    if (this.retryContextGeneration === null) return true
    if (this.retryContextGeneration === bindingGeneration(this.store)) return false
    this.retryContextGeneration = null
    return true
  }
}

function bindingGeneration(store: WeChatStore): string {
  const account = store.loadAccount()
  const context = store.loadContext()
  return JSON.stringify([
    account?.accountId ?? null,
    account?.token ?? null,
    account?.baseUrl ?? null,
    context?.boundUserID ?? null,
    context?.contextToken ?? null,
    context?.updatedAt ?? null,
  ])
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
    .replace(/bot[_-]?token["'=:\s]+[^\s,}]+/gi, "bot_token=[REDACTED]")
}

function formatTransportError(error: unknown, store: WeChatStore): string {
  // 诊断只保留错误字段、主机、摘要和上下文年龄，不记录任何凭据。
  const account = store.loadAccount()
  const context = store.loadContext()
  const contextAge = context && context.updatedAt > 0 ? Math.max(0, Date.now() - context.updatedAt) : "unknown"
  return `${redact(error)} [baseHost=${baseHost(account?.baseUrl)} account=${summarize(account?.accountId)} ` +
    `target=${summarize(context?.boundUserID)} contextAgeMs=${contextAge}]`
}

function baseHost(value: string | undefined): string {
  try {
    return value ? new URL(value).host : "none"
  } catch {
    return "invalid"
  }
}

function summarize(value: string | undefined): string {
  if (!value) return "none"
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
