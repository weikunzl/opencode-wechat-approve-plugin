import type { PendingApproval } from "./domain.js"
import { parseApprovalDecision } from "./approval-intent.js"

export interface ApprovalIntent {
  requestIDs: string[]
  decision: "once" | "always" | "reject" | "clarify"
  confidence: number
  explanation: string
}

export interface ModelCompleter {
  complete(prompt: string): Promise<unknown>
}

export function validateModelIntent(
  candidate: unknown,
  pending: PendingApproval[],
  threshold: number,
  sourceText: string,
): ApprovalIntent {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return clarify("模型输出不是对象")
  }

  const value = candidate as Record<string, unknown>
  const requestIDs = Array.isArray(value.requestIDs)
    ? [...new Set(value.requestIDs.filter((item): item is string => typeof item === "string"))]
    : []
  const decision = value.decision
  const confidence = value.confidence
  const explanation = typeof value.explanation === "string" ? value.explanation : ""
  const knownIDs = new Set(pending.map((item) => item.requestID))

  if (
    requestIDs.length === 0 ||
    requestIDs.some((id) => !knownIDs.has(id)) ||
    !["once", "always", "reject"].includes(String(decision)) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < threshold ||
    confidence > 1
  ) {
    return clarify("模型输出未通过安全校验")
  }

  const localDecision = parseApprovalDecision(sourceText)
  if (!localDecision || decision !== localDecision) {
    return clarify("模型不能建立或改变用户的授权决定")
  }

  return {
    requestIDs,
    decision: decision as "once" | "always" | "reject",
    confidence,
    explanation,
  }
}

export async function interpretWithModel(
  text: string,
  pending: PendingApproval[],
  threshold: number,
  model: ModelCompleter,
): Promise<ApprovalIntent> {
  try {
    const candidate = await model.complete(buildPrompt(text, pending))
    return validateModelIntent(candidate, pending, threshold, text)
  } catch {
    return clarify("模型不可用，请使用编号确认")
  }
}

function buildPrompt(text: string, pending: PendingApproval[]): string {
  const safePending = pending.map((item) => ({
    requestID: item.requestID,
    code: item.code,
    sessionID: item.sessionID,
    project: item.project,
    permission: item.permission,
    patterns: item.patterns.map((pattern) => pattern.slice(0, 200)),
  }))

  return [
    "你只负责把微信授权回复解析为 JSON，不执行授权，不调用工具。",
    '输出字段: {"requestIDs":[],"decision":"once|always|reject|clarify","confidence":0到1,"explanation":""}',
    `待审批请求: ${JSON.stringify(safePending)}`,
    `用户回复: ${JSON.stringify(text.slice(0, 500))}`,
  ].join("\n")
}

function clarify(explanation: string): ApprovalIntent {
  return {
    requestIDs: [],
    decision: "clarify",
    confidence: 0,
    explanation,
  }
}
