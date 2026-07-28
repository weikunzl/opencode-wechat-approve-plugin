import type {
  NormalizedEvent,
  NormalizedPermissionAsked,
  NormalizedPermissionReplied,
  OpenCodeEventLike,
} from "./plugin-types.js"
import { NormalizedEventKind } from "./plugin-types.js"

const DECISIONS = new Set(["once", "always", "reject"])

export function normalizeOpenCodeEvent(event: OpenCodeEventLike): NormalizedEvent | null {
  // 在 SDK 边界统一新旧事件名，避免业务层依赖版本差异。
  if (event.type === "permission.updated" || event.type === "permission.asked") {
    return normalizeAsked(event.properties)
  }
  if (event.type === "permission.replied") return normalizeReplied(event.properties)
  return null
}

function normalizeAsked(properties: Record<string, unknown> | undefined): NormalizedPermissionAsked | null {
  // 只接受拥有稳定标识和会话的审批事件，避免脏事件进入队列。
  const source = properties ?? {}
  const id = readString(source, "id")
  const sessionID = readString(source, "sessionID")
  if (!id || !sessionID) return null
  const permission = readString(source, "permission") ?? readString(source, "type") ?? "unknown"
  return {
    kind: NormalizedEventKind.PermissionAsked,
    id,
    sessionID,
    permission,
    patterns: readPatterns(source),
    metadata: readRecord(source, "metadata"),
    createdAt: readCreatedAt(source),
  }
}

function normalizeReplied(properties: Record<string, unknown> | undefined): NormalizedPermissionReplied | null {
  // 兼容 permissionID/response 与旧 requestID/reply 字段。
  const source = properties ?? {}
  const sessionID = readString(source, "sessionID")
  const requestID = readString(source, "requestID") ?? readString(source, "permissionID")
  const reply = readString(source, "reply") ?? readString(source, "response")
  if (!sessionID || !requestID || !reply || !DECISIONS.has(reply)) return null
  return { kind: NormalizedEventKind.PermissionReplied, sessionID, requestID, reply: reply as NormalizedPermissionReplied["reply"] }
}

function readPatterns(properties: Record<string, unknown>): string[] {
  // 新版字段为 pattern，旧版字段为 patterns，统一为字符串数组。
  const value = properties.pattern ?? properties.patterns
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function readCreatedAt(properties: Record<string, unknown>): number | undefined {
  // 时间只用于排序，非法值必须被忽略而不是传播。
  const time = readRecord(properties, "time")
  const created = time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : undefined
}

function readString(properties: Record<string, unknown> | undefined, key: string): string | undefined {
  // 读取外部字段时拒绝空字符串，保持事件标识可用。
  const value = properties?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readRecord(properties: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  // 仅保留普通对象，避免将数组或原型对象写入状态。
  const value = properties?.[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
