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

  async reconcile(): Promise<NotificationEnvelope[]> {
    const before = this.store.loadPendingApprovals()
    const current = await this.api.list()
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
    this.store.savePendingApprovals([...existing, approval])

    return [
      this.notice(
        `approval:${approval.requestID}`,
        "approval",
        "approval",
        [
          `[Approval #${approval.code}] ${path.basename(approval.project) || approval.project}`,
          `Session: ${approval.sessionID}`,
          `Permission: ${approval.permission}`,
          approval.patterns.length ? `Action: ${approval.patterns.join(", ").slice(0, 400)}` : "",
          "请回复“好的”“始终允许”或“拒绝”。",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ]
  }

  async onPermissionReplied(event: PermissionRepliedEvent): Promise<void> {
    const current = this.store.loadPendingApprovals()
    this.store.savePendingApprovals(current.filter((item) => item.requestID !== event.properties.requestID))
    const conversation = this.store.loadConversation()
    if (conversation?.requestIDs.includes(event.properties.requestID)) this.store.saveConversation(null)
  }

  async onMessage(message: InboundApprovalMessage): Promise<NotificationEnvelope[]> {
    const pending = await this.api.list()
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

    const localDecision = parseApprovalDecision(message.text) ?? conversation?.decision ?? null
    let intent = interpretDeterministic(message.text, pending, conversation)
    if (
      localDecision &&
      this.interpretModel &&
      hasSelectionDescription(message.text) &&
      (!intent || intent.decision === "clarify")
    ) {
      const selected = await this.interpretModel(
        message.text,
        pending,
        this.modelConfidenceThreshold,
      )
      if (selected.decision !== "clarify") {
        intent = { ...selected, decision: localDecision }
      }
    }
    if (!intent) return []

    if (intent.decision === "clarify") {
      const decision = parseApprovalDecision(message.text) ?? conversation?.decision
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
        requestIDs: pending.map((item) => item.requestID),
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
      const approval = latest.find((item) => item.requestID === requestID)
      if (!approval) {
        results.push(`${requestID}: 已失效`)
        continue
      }
      try {
        const applied = await this.api.reply(requestID, intent.decision)
        results.push(`#${approval.code}: ${applied ? label(intent.decision) : "未应用"}`)
      } catch (error) {
        results.push(`#${approval.code}: 失败（${firstLine(error)}）`)
      }
    }

    const remaining = await this.api.list()
    this.store.savePendingApprovals(remaining)
    this.store.saveConversation(null)
    return [
      this.notice(
        `approval-result:${message.messageID}`,
        "approval-result",
        intent.decision === "reject" ? "rejected" : "approved",
        `[Approval result]\n${results.join("\n")}`,
      ),
    ]
  }

  async expire(now = this.now()): Promise<NotificationEnvelope[]> {
    const current = await this.api.list()
    const expired = current.filter((item) => item.expiresAt <= now)
    const results: string[] = []
    for (const item of expired) {
      try {
        if (await this.api.reply(item.requestID, "reject")) results.push(`#${item.code}`)
      } catch {}
    }
    const remaining = await this.api.list()
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
    return {
      id,
      kind,
      text: formatStatusMessage(status, text),
      createdAt: this.now(),
    }
  }
}

function versionOf(pending: PendingApproval[]): string {
  return pending
    .map((item) => item.requestID)
    .sort()
    .join(",")
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

function hasSelectionDescription(text: string): boolean {
  const remainder = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /allow\s*all|always|deny|reject|approve|allow|okay|yes|始终允许|永久允许|以后都允许|全部授权|好的|好啊|可以|是的|确认|同意|允许|通过|拒绝|不同意|不允许|不可以|不通过|不确认|不要|别执行|取消/g,
      "",
    )
    .replace(/[\s,.，。!！?？;；:#]/g, "")
  return remainder.length >= 2
}
