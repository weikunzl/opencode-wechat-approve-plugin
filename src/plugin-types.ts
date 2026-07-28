import type { OpencodeClient } from "@opencode-ai/sdk"

export interface OpenCodeClient {
  postSessionIdPermissionsPermissionId: OpencodeClient["postSessionIdPermissionsPermissionId"]
  session?: OpencodeClient["session"]
}

export interface OpenCodeEventLike {
  type: string
  properties?: Record<string, unknown>
}

export enum NormalizedEventKind {
  PermissionAsked = "permission.asked",
  PermissionReplied = "permission.replied",
  Other = "other",
}

export interface NormalizedPermissionAsked {
  kind: NormalizedEventKind.PermissionAsked
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  createdAt?: number
}

export interface NormalizedPermissionReplied {
  kind: NormalizedEventKind.PermissionReplied
  sessionID: string
  requestID: string
  reply: "once" | "always" | "reject"
}

export type NormalizedEvent = NormalizedPermissionAsked | NormalizedPermissionReplied
