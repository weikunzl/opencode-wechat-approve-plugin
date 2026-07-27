import path from "node:path"
import { interpretDeterministic, parseApprovalDecision } from "./approval-intent.js"
import type { ApprovalConversation, NotificationEnvelope, PendingApproval } from "./domain.js"
import type { ApprovalIntent } from "./model-interpreter.js"
import type { PermissionAPI } from "./opencode-permissions.js"
import { formatStatusMessage } from "./status-message.js"
import { WeChatStore } from "./store.js"
import type { InboundApprovalMessage } from "./wechat-gateway.js"

interface PermissionAskedEvent {
  type: "permission.asked"
  properties: {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata?: Record<string, unknown>
  }
}

interface PermissionRepliedEvent {
  type: "permission.replied"
  properties: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
  }
}

interface ApprovalManagerOptions {
  store: WeChatStore
  api: PermissionAPI
  approvalTimeoutMs: number
  modelConfidenceThreshold: number
  interpretModel?: (text: string, pending: PendingApproval[], threshold: number) => Promise<ApprovalIntent>
  now?: () => number
}

export class ApprovalManager {
  private readonly store: WeChatStore
  private readonly api: PermissionAPI
  private readonly approvalTimeoutMs: number
  private readonly modelConfidenceThreshold: number
  private readonly interpretModel?: ApprovalManagerOptions["interpretModel"]
  private readonly now: () => number

  constructor(options: ApprovalManagerOptions) {
    this.store = options.store
    this.api = options.api
    this.approvalTimeoutMs = options.approvalTimeoutMs
    this.modelConfidenceThreshold = options.modelConfidenceThreshold
    this.interpretModel = options.interpretModel
    this.now = options.now ?? Date.now
  }

  async reconcile(isActive: () => boolean = alwaysActive): Promise<NotificationEnvelope[]> {
    const before = this.store.loadPendingApprovals()
    const current = await this.api.list()
    if (!isActive()) return []
    this.store.savePendingApprovals(current)

    const removed = before.filter((item) => !current.some((candidate) => candidate.requestID === item.requestID))
    if (removed.length === 0) return []
    return [
      this.notice(
        `approval-reconciled:${removed.map((item) => item.requestID).join(",")}`,
        "approval-result",
        "warning",
        `[Approval updated]\n${removed.length} 个请求已在 OpenCode 中处理或失效。`,
      ),
    ]
  }

  async onPermissionAsked(event: PermissionAskedEvent): Promise<NotificationEnvelope[]> {
    const existing = this.store.loadPendingApprovals()
    if (existing.some((item) => item.requestID === event.properties.id)) return []

    const now = this.now()
    const code = Math.max(0, ...existing.map((item) => item.code)) + 1
    const project =
      readString(event.properties.metadata, "directory") ??
      readString(event.properties.metadata, "project") ??
      "unknown"
    const approval: PendingApproval = {
      requestID: event.properties.id,
      sessionID: event.properties.sessionID,
      code,
      permission: event.properties.permission,
      patterns: event.properties.patterns ?? [],
      project,
      createdAt: now,
      expiresAt: now + this.approvalTimeoutMs,
    }
    const notification = this.notice(
        `approval:${approval.requestID}`,
        "approval",
        "approval",
        [
          `[Approval #${approval.code}] ${path.basename(approval.project) || approval.project}`,
          `Session: ${approval.sessionID}`,
          `Permission: ${approval.permission}`,
          approval.patterns.length ? `Action: ${approval.patterns.join(", ").slice(0, 400)}` : "",
          "请回复“好的”(本次)、“全部允许”(全部本次)、“全部始终允许”(全部持久)或“拒绝”。",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    this.store.savePendingApprovals([...existing, approval])
    return [notification]
  }

  async onPermissionReplied(event: PermissionRepliedEvent): Promise<void> {
    const current = this.store.loadPendingApprovals()
    this.store.savePendingApprovals(current.filter((item) => item.requestID !== event.properties.requestID))
    const conversation = this.store.loadConversation()
    if (conversation?.requestIDs.includes(event.properties.requestID)) this.store.saveConversation(null)
  }

  async onMessage(
    message: InboundApprovalMessage,
    isActive: () => boolean = alwaysActive,
  ): Promise<NotificationEnvelope[]> {
    const pending = await this.api.list()
    if (!isActive()) return []
    this.store.savePendingApprovals(pending)
    if (pending.length === 0) {
      this.store.saveConversation(null)
      return []
    }

    const conversation = this.store.loadConversation()
    const currentVersion = versionOf(pending)
    if (conversation && conversation.version !== currentVersion) {
      this.store.saveConversation({
        ...conversation,
        version: currentVersion,
        requestIDs: pending.map((item) => item.requestID),
        createdAt: this.now(),
      })
      return [
        this.notice(
          `approval-changed:${message.messageID}`,
          "warning",
          "warning",
          `[Approval changed]\n待审批列表已变化，请重新选择。\n${formatPending(pending)}`,
        ),
      ]
    }

    const localDecision =
      parseApprovalDecision(message.text) ??
      (conversation?.selectionOnly ? null : conversation?.decision ?? null)
    let intent = interpretDeterministic(message.text, pending, conversation)
    if (this.interpretModel && (!intent || intent.decision === "clarify")) {
      const selected = await this.interpretModel(
        message.text,
        pending,
        this.modelConfidenceThreshold,
      )
      if (!isActive()) return []
      if (selected.decision !== "clarify" && localDecision && selected.decision === localDecision) {
        intent = selected
      } else {
        intent = {
          requestIDs: [],
          decision: "clarify",
          confidence: 0,
          explanation: "模型不能建立或改变用户的授权决定",
        }
      }
    }
    if (!intent) {
      intent = {
        requestIDs: [],
        decision: "clarify",
        confidence: 0,
        explanation: "无法识别授权目标或决定",
      }
    }

    if (intent.decision === "clarify") {
      const decision =
        parseApprovalDecision(message.text) ??
        (conversation?.selectionOnly ? null : conversation?.decision)
      if (!decision) {
        return [
          this.notice(
            `approval-unclear:${message.messageID}`,
            "warning",
            "warning",
            `[Approval unclear]\n请明确回复允许、始终允许或拒绝。\n${formatPending(pending)}`,
          ),
        ]
      }
      this.store.saveConversation({
        version: currentVersion,
        requestIDs: orderPending(pending).map((item) => item.requestID),
        decision,
        createdAt: this.now(),
      })
      return [
        this.notice(
          `approval-clarify:${message.messageID}`,
          "approval",
          "approval",
          `[Which approval?]\n${formatPending(pending)}\n请回复“#编号”“第一个”“docs 项目的”或“两个都”。`,
        ),
      ]
    }

    const latest = await this.api.list()
    if (!isActive()) return []
    if (versionOf(latest) !== currentVersion) {
      this.store.savePendingApprovals(latest)
      return [
        this.notice(
          `approval-race:${message.messageID}`,
          "warning",
          "warning",
          `[Approval changed]\n执行前待审批列表已变化，未应用任何授权。\n${formatPending(latest)}`,
        ),
      ]
    }

    const results: string[] = []
    for (const requestID of intent.requestIDs) {
      if (!isActive()) return []
      const approval = latest.find((item) => item.requestID === requestID)
      if (!approval) {
        results.push(`${requestID}: 已失效`)
        continue
      }
      try {
        const decision = intent.decisions?.[requestID] ?? intent.decision
        const applied = await this.api.reply(requestID, decision)
        if (!isActive()) return []
        results.push(`#${approval.code}: ${applied ? label(decision) : "未应用"}`)
      } catch (error) {
        results.push(`#${approval.code}: 失败（${firstLine(error)}）`)
      }
    }

    if (!isActive()) return []
    const remaining = await this.api.list()
    if (!isActive()) return []
    this.store.savePendingApprovals(remaining)
    if (remaining.length > 0) {
      this.store.saveConversation({
        version: versionOf(remaining),
        requestIDs: orderPending(latest).map((item) => item.requestID),
        // The follow-up must explicitly choose its decision; never inherit
        // the decision used for the previous partial selection.
        decision: "once",
        selectionOnly: true,
        createdAt: this.now(),
      })
    } else {
      this.store.saveConversation(null)
    }
    const notices = [
      this.notice(
        `approval-result:${message.messageID}`,
        "approval-result",
        intent.decision === "reject" ? "rejected" : "approved",
        `[Approval result]\n${results.join("\n")}`,
      ),
    ]
    if (remaining.length > 0) {
      notices.push(
        this.notice(
          `approval-follow-up:${message.messageID}`,
          "approval",
          "approval",
          `[Approval pending]\n还有 ${remaining.length} 个待审批请求，请继续回复处理方式。\n${formatPending(remaining)}\n可回复“全部允许”(本次)、“全部始终允许”(持久)、“全部拒绝”，或指定“第一个允许”等。`,
        ),
      )
    }
    return notices
  }

  async expire(
    now = this.now(),
    isActive: () => boolean = alwaysActive,
  ): Promise<NotificationEnvelope[]> {
    const current = await this.api.list()
    if (!isActive()) return []
    const expired = current.filter((item) => item.expiresAt <= now)
    const results: string[] = []
    for (const item of expired) {
      if (!isActive()) return []
      try {
        const applied = await this.api.reply(item.requestID, "reject")
        if (!isActive()) return []
        if (applied) results.push(`#${item.code}`)
      } catch {}
    }
    if (!isActive()) return []
    const remaining = await this.api.list()
    if (!isActive()) return []
    this.store.savePendingApprovals(remaining)
    if (results.length === 0) return []
    return [
      this.notice(
        `approval-timeout:${results.join(",")}:${now}`,
        "approval-result",
        "timeout",
        `[Timeout]\n${results.join(", ")} 已自动拒绝。`,
      ),
    ]
  }

  private notice(
    id: string,
    kind: NotificationEnvelope["kind"],
    status: string,
    text: string,
  ): NotificationEnvelope {
    const notification: NotificationEnvelope = {
      id,
      kind,
      text: formatStatusMessage(status, text),
      createdAt: this.now(),
    }
    this.store.enqueueNotification(notification)
    return notification
  }
}

function alwaysActive(): boolean {
  return true
}

function versionOf(pending: PendingApproval[]): string {
  return pending
    .map((item) => item.requestID)
    .sort()
    .join(",")
}

function orderPending(pending: PendingApproval[]): PendingApproval[] {
  return [...pending].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.code - right.code ||
      left.requestID.localeCompare(right.requestID),
  )
}

function formatPending(pending: PendingApproval[]): string {
  return pending
    .map(
      (item) =>
        `#${item.code} [${path.basename(item.project) || item.project}] ${item.patterns.join(", ") || item.permission}`,
    )
    .join("\n")
}

function readString(value: Record<string, unknown> | undefined, key: string): string | null {
  const candidate = value?.[key]
  return typeof candidate === "string" && candidate ? candidate : null
}

function label(decision: "once" | "always" | "reject"): string {
  if (decision === "always") return "始终允许"
  if (decision === "reject") return "已拒绝"
  return "本次允许"
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
}
