export enum RebindSchemaVersion {
  V1 = 1,
}

export enum RebindStatus {
  Idle = "idle",
  AwaitingContext = "awaiting-context",
  QrReady = "qr-ready",
  Confirming = "confirming",
  Expired = "expired",
}

enum RebindValueLimit {
  MaximumTimestamp = 8_640_000_000_000_000,
}

export const REBIND_PAGE_NAME_PATTERN = /^wechat-rebind-[a-f0-9]{32}\.html$/
const BINDING_DIGEST_PATTERN = /^[a-f0-9]{64}$/

export interface RebindState {
  schemaVersion: RebindSchemaVersion
  status: RebindStatus
  startedAt: number | null
  expiresAt: number | null
  pageFileName: string | null
  bindingGenerationDigest: string | null
}

export function defaultRebindState(): RebindState {
  // 缺失状态表示没有恢复流程，绝不能推断为已有二维码。
  return {
    schemaVersion: RebindSchemaVersion.V1,
    status: RebindStatus.Idle,
    startedAt: null,
    expiresAt: null,
    pageFileName: null,
    bindingGenerationDigest: null,
  }
}

export function isRebindState(value: unknown): value is RebindState {
  // 严格限制字段，阻止路径穿越和任意正文进入恢复描述符。
  if (!isRecord(value)) return false
  return value.schemaVersion === RebindSchemaVersion.V1 &&
    Object.values(RebindStatus).includes(value.status as RebindStatus) &&
    nullableTimestamp(value.startedAt) && nullableTimestamp(value.expiresAt) &&
    nullablePageName(value.pageFileName) && nullableDigest(value.bindingGenerationDigest) &&
    stateShapeIsConsistent(value as unknown as RebindState)
}

function stateShapeIsConsistent(value: RebindState): boolean {
  // 只有二维码相关状态允许引用本地页面。
  const pageRequired = [RebindStatus.QrReady, RebindStatus.Confirming].includes(value.status)
  if (pageRequired) return value.pageFileName !== null && value.expiresAt !== null
  return value.pageFileName === null
}

function nullableTimestamp(value: unknown): boolean {
  return value === null || (
    typeof value === "number" && Number.isInteger(value) && value >= 0 &&
    value <= RebindValueLimit.MaximumTimestamp
  )
}

function nullablePageName(value: unknown): boolean {
  return value === null || (
    typeof value === "string" && REBIND_PAGE_NAME_PATTERN.test(value)
  )
}

function nullableDigest(value: unknown): boolean {
  return value === null || (
    typeof value === "string" && BINDING_DIGEST_PATTERN.test(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
