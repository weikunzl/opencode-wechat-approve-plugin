import crypto from "node:crypto"
import { interpretDeterministic } from "./approval-intent.js"
import { ApprovalIndex, type ApprovalRecord } from "./approval-index.js"
import type { ApprovalConversation, PendingApproval } from "./domain.js"

export enum DecisionRouteStatus {
  Routed = "routed",
  Clarify = "clarify",
  Conflict = "conflict",
  Duplicate = "duplicate",
}

export enum DecisionKind {
  Once = "once",
  Always = "always",
  Reject = "reject",
}

export interface DecisionRouteInput {
  messageID: string
  ownerInstanceID: string
  text: string
  pending: PendingApproval[]
  conversation?: ApprovalConversation | null
}

export interface DecisionCommand {
  commandID: string
  messageID: string
  ownerInstanceID: string
  requestID: string
  expectedRevision: number
  decision: DecisionKind
}

export interface DecisionRouteResult {
  status: DecisionRouteStatus
  commands: DecisionCommand[]
  explanation: string
}

export class DecisionRouter {
  private readonly seen = new Set<string>()

  constructor(private readonly index: ApprovalIndex) {}

  route(input: DecisionRouteInput): DecisionRouteResult {
    // 先做确定性解析，只有明确目标和决定才会触发原子 claim。
    const intent = interpretDeterministic(input.text, input.pending, input.conversation ?? null)
    if (!intent || intent.decision === "clarify") return clarify(intent?.explanation ?? "无法识别授权目标")
    if (this.seen.has(input.messageID)) return duplicate()
    this.seen.add(input.messageID)
    const claims = this.index.claimSnapshot({ ownerInstanceID: input.ownerInstanceID, requestIDs: intent.requestIDs })
    if (claims.length !== intent.requestIDs.length) return conflict()
    return routed(input, claims, intent.decisions, intent.decision as DecisionKind)
  }
}

function routed(
  input: DecisionRouteInput,
  claims: ApprovalRecord[],
  decisions: Record<string, "once" | "always" | "reject"> | undefined,
  fallback: DecisionKind,
): DecisionRouteResult {
  // 命令携带 claim revision，owner 执行前仍需再次校验。
  return {
    status: DecisionRouteStatus.Routed,
    commands: claims.map((claim) => ({
      commandID: commandID(input.messageID, claim.requestID),
      messageID: input.messageID,
      ownerInstanceID: claim.ownerInstanceID,
      requestID: claim.requestID,
      expectedRevision: claim.revision,
      decision: (decisions?.[claim.requestID] as DecisionKind | undefined) ?? fallback,
    })),
    explanation: "已生成待 owner 执行的授权命令",
  }
}

function commandID(messageID: string, requestID: string): string {
  // commandID 只由脱敏消息标识和请求标识组成，保证重放幂等。
  return crypto.createHash("sha256").update(`${messageID}\u0000${requestID}`).digest("hex").slice(0, 24)
}

function clarify(explanation: string): DecisionRouteResult {
  // 歧义输入不修改索引，等待用户补充目标或决定。
  return { status: DecisionRouteStatus.Clarify, commands: [], explanation }
}

function conflict(): DecisionRouteResult {
  // 并发 claim 失败表示其他消息先处理，必须重新询问当前 pending。
  return { status: DecisionRouteStatus.Conflict, commands: [], explanation: "待审批请求已被其他消息处理" }
}

function duplicate(): DecisionRouteResult {
  // 相同 messageID 的重复回复不再次生成命令。
  return { status: DecisionRouteStatus.Duplicate, commands: [], explanation: "重复消息已忽略" }
}
