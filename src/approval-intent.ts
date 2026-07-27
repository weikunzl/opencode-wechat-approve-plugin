import path from "node:path"
import type { ApprovalConversation, PendingApproval } from "./domain.js"
import type { ApprovalIntent } from "./model-interpreter.js"

const REJECT =
  /(?:^|[^a-z])(no|deny|reject)(?:$|[^a-z])|拒绝|不同意|不允许|不可以|不通过|不确认|不要|别执行|取消|驳回|否决/
const NEGATED_APPROVAL =
  /(?:不能|不可|不准|无法|禁止|别|勿|未|没|不要|莫|暂缓|暂停|停止).{0,6}(?:确认|同意|允许|通过|授权|执行)|(?:do\s+not|don't|cannot|can't|never)\s+(?:allow|approve|confirm|execute)/
const NEGATIVE_MODALITY =
  /(?:不|别|勿|未|没|无|禁止|拒绝|取消|否|停止|暂停|暂缓|不能|不可|不准|甭|莫)|(?:^|[^a-z])(?:not|never|cannot|can't|don't|without)(?:$|[^a-z])/
const ALWAYS =
  /allow\s*all|always|始终允许|永久允许|以后都允许|全部授权|全部允许|全部都允许|全部始终|都始终允许|始终放行|永久放行/
const ONCE =
  /(?:^|[^a-z])(ok|okay|yes|y|allow|approve)(?:$|[^a-z])|好的|好啊|可以|是的|确认|同意|允许|通过|批准|放行/
const ASSIGNMENT_SELECTOR = /第(?:[一二三四五六七八九十百]+|\d+)个|#?\d+/

export function interpretDeterministic(
  text: string,
  pending: PendingApproval[],
  conversation: ApprovalConversation | null = null,
): ApprovalIntent | null {
  const normalized = normalize(text)
  const explicitDecision = parseApprovalDecision(text)
  const inheritedDecision =
    explicitDecision === null && conversation && isStrictSelectionReply(text)
      ? conversation.decision
      : null
  const decision = explicitDecision ?? inheritedDecision
  if (!decision) return null
  if (pending.length === 0) return clarify("没有待审批请求")

  const assignments = parseAssignments(text, pending)
  if (assignments) return resolvedAssignments(assignments)

  if (pending.length === 1) {
    return resolved([pending[0].requestID], decision)
  }

  const selected = selectRequests(normalized, pending, conversation)
  if (selected.length === 0) return clarify("存在多个待审批请求，需要确认目标")

  return resolved(selected, decision)
}

function isStrictSelectionReply(text: string): boolean {
  if (/[?？]/.test(text)) return false
  text = normalize(text)
  if (NEGATIVE_MODALITY.test(text)) return false
  if (/^(?:全部|所有|全都|两个都|三个都|都)$/.test(text)) return true

  const selectors = text.match(/(?:第(?:一|二|三|1|2|3)个)|(?:(?:c|#)\s*)?\d+/g)
  if (!selectors?.length) return false
  const remainder = text
    .replace(/(?:第(?:一|二|三|1|2|3)个)|(?:(?:c|#)\s*)?\d+/g, "")
    .replace(/(?:和|与|及|以及|、|\s)+/g, "")
  return remainder.length === 0
}

export function parseApprovalDecision(text: string): "once" | "always" | "reject" | null {
  const source = text.normalize("NFKC").trim().toLowerCase()
  if (/[?？]/.test(source) || /(?:可以|确认|通过|允许|同意)吗(?:\s|$)/.test(source)) return null
  text = normalize(text)
  if (REJECT.test(text)) return "reject"
  if (NEGATED_APPROVAL.test(text)) return "reject"
  if (NEGATIVE_MODALITY.test(text)) return null
  if (ALWAYS.test(text)) return "always"
  if (ONCE.test(text)) return "once"
  return null
}

function selectRequests(
  text: string,
  pending: PendingApproval[],
  conversation: ApprovalConversation | null,
): string[] {
  const byCode = new Set<string>()
  for (const match of text.matchAll(/(?:c|#)?(\d+)/g)) {
    const code = Number(match[1])
    const request = pending.find((item) => item.code === code)
    if (request) byCode.add(request.requestID)
  }
  if (byCode.size > 0) return pending.filter((item) => byCode.has(item.requestID)).map((item) => item.requestID)

  if (/(?:全部|所有|全都|两个都|三个都|都允许|都拒绝|都始终)/.test(text)) {
    return orderedPending(pending).map((item) => item.requestID)
  }

  const ordinal = ordinalIndex(text)
  if (ordinal !== null) {
    const snapshotIDs = conversation?.requestIDs ?? orderedPending(pending).map((item) => item.requestID)
    const requestID = snapshotIDs[ordinal]
    return requestID && pending.some((item) => item.requestID === requestID) ? [requestID] : []
  }

  const compact = compactText(text)
  const matches = pending.filter((item) => {
    const project = compactText(path.basename(item.project))
    if (project.length >= 2 && compact.includes(project)) return true

    return item.patterns.some((pattern) => {
      const words = pattern
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      const candidates = [words.slice(0, 2).join(""), words[0] ?? "", compactText(pattern)].filter(
        (candidate) => candidate.length >= 2,
      )
      return candidates.some((candidate) => compact.includes(candidate))
    })
  })

  return matches.length === 1 ? [matches[0].requestID] : []
}

function ordinalIndex(text: string): number | null {
  const match = text.match(/第([一二三四五六七八九十百]+|\d+)个/)
  if (match) {
    const value = Number(match[1]) || chineseNumber(match[1])
    return value > 0 ? value - 1 : null
  }
  return null
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[。！!，,；;：:？?]/g, " ")
    .replace(/\s+/g, " ")
}

function compactText(value: string): string {
  return normalize(value).replace(/\s+/g, "")
}

function resolved(requestIDs: string[], decision: "once" | "always" | "reject"): ApprovalIntent {
  return {
    requestIDs,
    decision,
    confidence: 1,
    explanation: "deterministic",
  }
}

function parseAssignments(
  text: string,
  pending: PendingApproval[],
): Array<{ requestID: string; decision: "once" | "always" | "reject" }> | null {
  const clauses = splitAssignmentClauses(text)
  if (clauses.length === 0 || clauses.some((clause) => !ASSIGNMENT_SELECTOR.test(clause))) {
    return null
  }

  const ordered = orderedPending(pending)
  const assignments: Array<{ requestID: string; decision: "once" | "always" | "reject"; order: number }> = []
  for (const clause of clauses) {
    if ((clause.match(/第(?:[一二三四五六七八九十百]+|\d+)个|#?\d+/g) ?? []).length !== 1) return null
    const selector = selectorOf(clause)
    const decision = parseApprovalDecision(clause)
    if (!selector || !decision) return null

    const target =
      selector.kind === "ordinal"
        ? ordered[selector.index]
        : pending.find((item) => item.code === selector.code)
    if (!target) return null
    const order = ordered.findIndex((item) => item.requestID === target.requestID)
    if (assignments.some((item) => item.requestID === target.requestID)) return null
    assignments.push({ requestID: target.requestID, decision, order })
  }

  return assignments
    .sort((left, right) => left.order - right.order)
    .map(({ requestID, decision }) => ({ requestID, decision }))
}

function splitAssignmentClauses(text: string): string[] {
  const punctuated = text
    .split(/[，,、；;。]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (punctuated.length > 1) return punctuated

  const connected = text
    .split(/\s*(?:和|与|及|以及)\s*(?=(?:第|#?\d))/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (connected.length > 1 && connected.every((part) => parseApprovalDecision(part))) return connected
  return punctuated
}

function selectorOf(text: string): { kind: "ordinal"; index: number } | { kind: "code"; code: number } | null {
  const ordinal = text.match(/第([一二三四五六七八九十百]+|\d+)个/)
  if (ordinal) {
    const value = Number(ordinal[1]) || chineseNumber(ordinal[1])
    return value > 0 ? { kind: "ordinal", index: value - 1 } : null
  }
  const code = text.match(/#?(\d+)/)
  return code ? { kind: "code", code: Number(code[1]) } : null
}

function orderedPending(pending: PendingApproval[]): PendingApproval[] {
  return [...pending].sort(
    (left, right) => left.createdAt - right.createdAt || left.code - right.code || left.requestID.localeCompare(right.requestID),
  )
}

function chineseNumber(value: string): number {
  const direct: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  }
  if (direct[value]) return direct[value]
  return 0
}

function resolvedAssignments(
  assignments: Array<{ requestID: string; decision: "once" | "always" | "reject" }>,
): ApprovalIntent {
  if (assignments.length === 1) return resolved([assignments[0].requestID], assignments[0].decision)
  return {
    requestIDs: assignments.map((item) => item.requestID),
    decision: assignments[0].decision,
    decisions: Object.fromEntries(assignments.map((item) => [item.requestID, item.decision])),
    confidence: 1,
    explanation: "deterministic",
  }
}

function clarify(explanation: string): ApprovalIntent {
  return {
    requestIDs: [],
    decision: "clarify",
    confidence: 0,
    explanation,
  }
}
