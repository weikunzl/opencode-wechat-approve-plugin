import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadPluginConfig, type PluginConfig } from "./config.js"
import type { ApprovalConversation, NotificationEnvelope, PendingApproval, SessionRunState, WeChatContext } from "./domain.js"
import type { AccountData } from "./types.js"

export const WECHAT_DATA_DIR_NAME = "wechat-approve"

interface StoredBinding {
  account: AccountData
  context: WeChatContext
  cursor: string
}

export class WeChatStore {
  private readonly dir: string
  private ctxTokens = new Map<string, string>()

  constructor(directory?: string) {
    this.dir =
      directory ??
      path.join(os.homedir(), ".opencode", WECHAT_DATA_DIR_NAME)
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.loadLegacyContextTokens()
  }

  getDirectory(): string {
    return this.dir
  }

  loadAccount(): AccountData | null {
    const binding = this.loadBinding()
    if (binding) return binding.account
    return this.readJSON<AccountData | null>("account.json", null, isAccountData)
  }

  saveAccount(data: AccountData): void {
    const binding = this.loadBinding()
    if (binding) {
      this.atomicWrite("binding-v1.json", { ...binding, account: data })
      return
    }
    this.atomicWrite("account.json", data)
  }

  loadPluginConfig(): PluginConfig {
    return loadPluginConfig(this.readJSON<Record<string, unknown>>("config.json", {}, isRecord))
  }

  savePluginConfig(config: PluginConfig): void {
    this.atomicWrite("config.json", config)
  }

  loadContext(): WeChatContext | null {
    const binding = this.loadBinding()
    if (binding) return binding.context
    const current = this.readJSON<WeChatContext | null>("context-v1.json", null, isWeChatContext)
    if (current) return current

    const entry = [...this.ctxTokens.entries()].at(-1)
    if (!entry) return null
    return { boundUserID: entry[0], contextToken: entry[1], updatedAt: 0 }
  }

  saveContext(context: WeChatContext): void {
    const binding = this.loadBinding()
    if (binding) {
      this.atomicWrite("binding-v1.json", { ...binding, context })
      return
    }
    this.atomicWrite("context-v1.json", context)
    this.ctxTokens.set(context.boundUserID, context.contextToken)
  }

  loadCursor(): string {
    const binding = this.loadBinding()
    if (binding) return binding.cursor
    const data = this.readJSON<{ value: string } | null>(
      "cursor.json",
      null,
      (value): value is { value: string } =>
        Boolean(value && typeof value === "object" && typeof (value as { value?: unknown }).value === "string"),
    )
    if (data) return data.value

    try {
      return fs.readFileSync(path.join(this.dir, "sync_buf.txt"), "utf8")
    } catch {
      return ""
    }
  }

  saveCursor(value: string): void {
    const binding = this.loadBinding()
    if (binding) {
      this.atomicWrite("binding-v1.json", { ...binding, cursor: value })
      return
    }
    this.atomicWrite("cursor.json", { value })
  }

  commitBinding(account: AccountData, context: WeChatContext, cursor: string): void {
    this.atomicWrite("binding-v1.json", { account, context, cursor })
  }

  loadProcessedMessageIDs(): string[] {
    return this.readJSON<string[]>(
      "processed-messages.json",
      [],
      (value): value is string[] =>
        Array.isArray(value) && value.every((item) => typeof item === "string"),
    )
  }

  saveProcessedMessageIDs(value: string[]): void {
    this.atomicWrite("processed-messages.json", value.slice(-2_000))
  }

  loadPendingApprovals(): PendingApproval[] {
    return this.readJSON<PendingApproval[]>("pending-approvals.json", [], isPendingApprovalArray)
  }

  savePendingApprovals(value: PendingApproval[]): void {
    this.atomicWrite("pending-approvals.json", value)
  }

  loadSessionStates(): SessionRunState[] {
    return this.readJSON<SessionRunState[]>("runtime.json", [], isSessionRunStateArray)
  }

  saveSessionStates(value: SessionRunState[]): void {
    this.atomicWrite("runtime.json", value)
  }

  loadConversation(): ApprovalConversation | null {
    return this.readJSON<ApprovalConversation | null>("approval-conversation.json", null, isApprovalConversation)
  }

  saveConversation(value: ApprovalConversation | null): void {
    if (value) {
      this.atomicWrite("approval-conversation.json", value)
    } else {
      this.remove("approval-conversation.json")
    }
  }

  loadOutbox(): NotificationEnvelope[] {
    return this.readJSON<NotificationEnvelope[]>("notification-outbox.json", [], isNotificationEnvelopeArray)
  }

  enqueueNotification(notification: NotificationEnvelope): void {
    const outbox = this.loadOutbox()
    if (!outbox.some((item) => item.id === notification.id)) {
      outbox.push(notification)
      this.atomicWrite("notification-outbox.json", outbox)
    }
  }

  ackNotification(id: string): void {
    this.atomicWrite(
      "notification-outbox.json",
      this.loadOutbox().filter((item) => item.id !== id),
    )
  }

  migrateLegacyState(): void {
    const legacySession = path.join(this.dir, "session.json")
    if (fs.existsSync(legacySession)) {
      const archive = path.join(this.dir, "session.json.legacy")
      if (!fs.existsSync(archive)) fs.renameSync(legacySession, archive)
    }
    const context = this.loadContext()
    if (context && !fs.existsSync(path.join(this.dir, "context-v1.json"))) this.saveContext(context)
    const cursor = this.loadCursor()
    if (cursor && !fs.existsSync(path.join(this.dir, "cursor.json"))) this.saveCursor(cursor)
  }

  private loadLegacyContextTokens(): void {
    const file = path.join(this.dir, "context.json")
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      if (isRecord(data)) {
        this.ctxTokens = new Map(
          Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      }
    } catch {}
  }

  private loadBinding(): StoredBinding | null {
    return this.readJSON<StoredBinding | null>(
      "binding-v1.json",
      null,
      isStoredBinding,
    )
  }

  private atomicWrite(name: string, value: unknown): void {
    const file = path.join(this.dir, name)
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    const fd = fs.openSync(temporary, "w", 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  }

  private readJSON<T>(name: string, fallback: T, guard: (value: unknown) => boolean): T {
    const file = path.join(this.dir, name)
    if (!fs.existsSync(file)) return fallback
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"))
      if (!guard(value)) throw new Error("invalid state shape")
      return value as T
    } catch {
      this.quarantine(file)
      return fallback
    }
  }

  private quarantine(file: string): void {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
  }

  private remove(name: string): void {
    try {
      fs.unlinkSync(path.join(this.dir, name))
    } catch {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isAccountData(value: unknown): value is AccountData {
  if (!isRecord(value)) return false
  return (
    typeof value.token === "string" &&
    typeof value.baseUrl === "string" &&
    typeof value.accountId === "string" &&
    (value.userId === undefined || typeof value.userId === "string")
  )
}

function isWeChatContext(value: unknown): value is WeChatContext {
  if (!isRecord(value)) return false
  return (
    typeof value.boundUserID === "string" &&
    typeof value.contextToken === "string" &&
    typeof value.updatedAt === "number"
  )
}

function isStoredBinding(value: unknown): value is StoredBinding {
  return (
    isRecord(value) &&
    isAccountData(value.account) &&
    isWeChatContext(value.context) &&
    typeof value.cursor === "string"
  )
}

function isPendingApprovalArray(value: unknown): value is PendingApproval[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.requestID === "string" &&
        typeof item.sessionID === "string" &&
        typeof item.code === "number" &&
        typeof item.permission === "string" &&
        Array.isArray(item.patterns) &&
        item.patterns.every((pattern) => typeof pattern === "string") &&
        typeof item.project === "string" &&
        typeof item.createdAt === "number" &&
        typeof item.expiresAt === "number",
    )
  )
}

function isSessionRunStateArray(value: unknown): value is SessionRunState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.sessionID === "string" &&
        ["idle", "busy", "completed", "failed", "cancelled"].includes(String(item.phase)) &&
        typeof item.run === "number" &&
        typeof item.updatedAt === "number",
    )
  )
}

function isApprovalConversation(value: unknown): value is ApprovalConversation {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    Array.isArray(value.requestIDs) &&
    value.requestIDs.every((id) => typeof id === "string") &&
    ["once", "always", "reject"].includes(String(value.decision)) &&
    typeof value.createdAt === "number"
  )
}

function isNotificationEnvelopeArray(value: unknown): value is NotificationEnvelope[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.kind === "string" &&
        typeof item.text === "string" &&
        typeof item.createdAt === "number",
    )
  )
}
