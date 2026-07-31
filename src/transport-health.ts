import crypto from "node:crypto"

export enum TransportHealthSchemaVersion {
  V1 = 1,
}

export enum TransportHealthStatus {
  Starting = "starting",
  Healthy = "healthy",
  Degraded = "degraded",
  NeedsRebind = "needs-rebind",
  Recovering = "recovering",
  Stopped = "stopped",
}

export enum TransportFailureKind {
  Network = "network",
  ContextRefresh = "context-refresh",
  SessionExpired = "session-expired",
  Unknown = "unknown",
}

export interface TransportHealthState {
  schemaVersion: TransportHealthSchemaVersion
  status: TransportHealthStatus
  lastProbeAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastFailureKind: TransportFailureKind | null
  consecutiveFailures: number
  nextRetryAt: number | null
  cleanShutdown: boolean
  bindingGenerationDigest: string | null
}

export interface BindingGenerationInput {
  accountID: string | null
  baseUrl: string | null
  contextToken: string | null
  contextUpdatedAt: number | null
}

export function defaultTransportHealth(): TransportHealthState {
  // 默认视为尚未启动且上次本地状态完整，避免把文件缺失误报为在线。
  return {
    schemaVersion: TransportHealthSchemaVersion.V1,
    status: TransportHealthStatus.Stopped,
    lastProbeAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
    cleanShutdown: true,
    bindingGenerationDigest: null,
  }
}

export function bindingGenerationDigest(input: BindingGenerationInput): string {
  // 只持久化不可逆摘要，健康文件不得复制账号或 context 凭据。
  const value = JSON.stringify([
    input.accountID,
    input.baseUrl,
    input.contextToken,
    input.contextUpdatedAt,
  ])
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function isTransportHealthState(value: unknown): value is TransportHealthState {
  // 严格验证健康状态，损坏或未来版本交给 store 隔离。
  if (!isRecord(value)) return false
  return value.schemaVersion === TransportHealthSchemaVersion.V1 &&
    Object.values(TransportHealthStatus).includes(value.status as TransportHealthStatus) &&
    nullableNumber(value.lastProbeAt) && nullableNumber(value.lastSuccessAt) &&
    nullableNumber(value.lastFailureAt) && nullableNumber(value.nextRetryAt) &&
    nullableFailure(value.lastFailureKind) && typeof value.consecutiveFailures === "number" &&
    typeof value.cleanShutdown === "boolean" &&
    (value.bindingGenerationDigest === null || typeof value.bindingGenerationDigest === "string")
}

function nullableNumber(value: unknown): boolean {
  // 时间字段允许尚未发生时使用 null。
  return value === null || typeof value === "number"
}

function nullableFailure(value: unknown): boolean {
  // 失败类别必须来自受控枚举，防止原始错误文本落盘。
  return value === null ||
    Object.values(TransportFailureKind).includes(value as TransportFailureKind)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 健康状态只接受普通对象。
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
