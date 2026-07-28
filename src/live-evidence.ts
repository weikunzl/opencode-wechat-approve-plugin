export enum ProvenanceKind {
  LocalDist = "local-dist",
  Tarball = "tarball",
  Registry = "registry",
}

enum EvidenceFormat {
  RequestIDSuffix = "…",
}

enum EvidenceLimit {
  RequestIDPrefixLength = 8,
}

export interface EvidenceProvenance {
  kind: ProvenanceKind
  packageVersion: string
  entrypoint: string
}

export interface EvidenceRequest {
  requestID: string
}

export interface StatusSnapshot {
  observedAt: string
  provenance: EvidenceProvenance
  local: { pending: number; requestIDs: string[]; outbox: number }
  server: { pending: number; requestIDs: string[] }
}

export interface CreateProvenanceInput {
  kind: ProvenanceKind
  packageVersion: string
  entrypoint: string
}

export interface CreateStatusSnapshotInput {
  observedAt: string
  provenance: EvidenceProvenance
  localPending: EvidenceRequest[]
  serverPending: string[]
  outboxCount: number
}

export function createProvenance(input: CreateProvenanceInput): EvidenceProvenance {
  // 明确记录构建物来源，避免把本地或 tarball 验收误记为 registry 验收。
  return { kind: input.kind, packageVersion: input.packageVersion, entrypoint: input.entrypoint }
}

export function createStatusSnapshot(input: CreateStatusSnapshotInput): StatusSnapshot {
  // 快照只保留数量和脱敏请求摘要，不能包含会话、上下文或用户身份。
  return {
    observedAt: input.observedAt,
    provenance: input.provenance,
    local: snapshotLocal(input),
    server: snapshotServer(input),
  }
}

function snapshotLocal(input: CreateStatusSnapshotInput): StatusSnapshot["local"] {
  // 本地状态用于证明 pending/outbox 的场景前后变化。
  return {
    pending: input.localPending.length,
    requestIDs: summarizeRequestIDs(input.localPending.map((item) => item.requestID)),
    outbox: input.outboxCount,
  }
}

function snapshotServer(input: CreateStatusSnapshotInput): StatusSnapshot["server"] {
  // 服务端摘要与本地索引并列展示，便于发现重启后的状态漂移。
  return {
    pending: input.serverPending.length,
    requestIDs: summarizeRequestIDs(input.serverPending),
  }
}

function summarizeRequestIDs(requestIDs: string[]): string[] {
  // 每个请求 ID 仅保留固定前缀，避免记录完整关联标识。
  return requestIDs.map((requestID) => summarizeRequestID(requestID))
}

function summarizeRequestID(requestID: string): string {
  // 短 ID 保持可读，长 ID 使用统一省略标记。
  return requestID.length <= EvidenceLimit.RequestIDPrefixLength
    ? requestID
    : `${requestID.slice(0, EvidenceLimit.RequestIDPrefixLength)}${EvidenceFormat.RequestIDSuffix}`
}
