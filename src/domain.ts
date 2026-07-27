export interface PendingApproval {
  requestID: string
  sessionID: string
  code: number
  permission: string
  patterns: string[]
  project: string
  createdAt: number
  expiresAt: number
}

export type SessionRunPhase = "idle" | "busy" | "completed" | "failed" | "cancelled"

export interface SessionRunState {
  sessionID: string
  phase: SessionRunPhase
  run: number
  updatedAt: number
  title?: string
  directory?: string
}

export interface NotificationEnvelope {
  id: string
  kind: "done" | "error" | "cancelled" | "approval" | "approval-result" | "warning"
  text: string
  createdAt: number
  attempts?: number
}

export interface WeChatContext {
  boundUserID: string
  contextToken: string
  updatedAt: number
}

export interface ApprovalConversation {
  version: string
  requestIDs: string[]
  createdAt: number
}
