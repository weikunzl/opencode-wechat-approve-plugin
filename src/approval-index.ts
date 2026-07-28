import path from "node:path"
import type { PendingApproval } from "./domain.js"
import { acquireDirectoryLock, ensureSharedDirectory, readSharedJSON, writeSharedJSON } from "./shared-file.js"

export enum ApprovalStatus {
  Pending = "pending",
  Claimed = "claimed",
  Applying = "applying",
  Applied = "applied",
  Stale = "stale",
  FailedRetryable = "failed-retryable",
}

export interface ApprovalRecord extends PendingApproval {
  ownerInstanceID: string
  revision: number
  status: ApprovalStatus
}

interface ClaimInput {
  ownerInstanceID: string
  requestIDs: string[]
}

interface RevisionInput {
  requestID: string
  expectedRevision: number
}

const INDEX_FILE = "approval-index-v1.json"
const LOCK_DIRECTORY = "approval-index.lock"

export class ApprovalIndex {
  private readonly file: string
  private readonly lock: string

  constructor(private readonly directory: string) {
    // 审批索引与邮箱放在同一共享目录，便于跨进程原子 claim。
    ensureSharedDirectory(directory)
    this.file = path.join(directory, INDEX_FILE)
    this.lock = path.join(directory, LOCK_DIRECTORY)
  }

  replace(pending: PendingApproval[], ownerInstanceID: string): void {
    // OpenCode 当前快照重建 pending，已应用记录不再重新进入队列。
    this.update((records) => ({
      records: pending.map((item) => fromPending(item, ownerInstanceID, records.find((old) => old.requestID === item.requestID))),
      result: undefined,
    }))
  }

  snapshot(): ApprovalRecord[] {
    // 调用方按创建时间读取稳定顺序，API 返回顺序不会影响编号语义。
    return this.read().sort(orderByCreation)
  }

  claimSnapshot(input: ClaimInput): ApprovalRecord[] {
    // claim 在锁内完成，第二个并发回复只能看到非 pending 状态。
    return this.update((records) => {
      const claims = records.filter((item) => input.requestIDs.includes(item.requestID) && item.status === ApprovalStatus.Pending)
      for (const item of claims) {
        item.status = ApprovalStatus.Claimed
        item.revision += 1
        item.ownerInstanceID = input.ownerInstanceID
      }
      return { records, result: claims.sort(orderByCreation).map((item) => ({ ...item })) }
    })
  }

  markApplied(input: RevisionInput): boolean {
    // 只有 claim 产生的 revision 能提交授权，避免陈旧命令覆盖新状态。
    return this.mark(input, ApprovalStatus.Applied)
  }

  markRetryable(input: RevisionInput): boolean {
    // 可恢复的传输失败保留记录，后续 Leader 可重新投递而不重复 claim。
    return this.mark(input, ApprovalStatus.FailedRetryable)
  }

  markStale(input: RevisionInput): boolean {
    // 原生 OpenCode 已处理的请求标记为 stale，阻止旧命令再次授权。
    return this.mark(input, ApprovalStatus.Stale)
  }

  private mark(input: RevisionInput, status: ApprovalStatus): boolean {
    return this.update((records) => {
      const item = records.find((candidate) => candidate.requestID === input.requestID)
      const retrying = status === ApprovalStatus.Applied && item?.status === ApprovalStatus.FailedRetryable
      const valid = Boolean(item && (item.status === ApprovalStatus.Claimed || retrying) && item.revision === input.expectedRevision)
      if (valid && item) {
        item.status = status
        if (status !== ApprovalStatus.FailedRetryable) item.revision += 1
      }
      return { records, result: valid }
    })
  }

  private read(): ApprovalRecord[] {
    // 只返回结构完整的审批记录，损坏条目不会被路由。
    return readSharedJSON<ApprovalRecord[]>(this.file, []).filter(isApprovalRecord)
  }

  private update<T>(operation: (records: ApprovalRecord[]) => { records: ApprovalRecord[]; result: T }): T {
    // 锁内重读并原子写回，保证多个实例的 revision 单调递增。
    const owner = acquireDirectoryLock(this.lock)
    if (!owner) throw new Error("approval index is busy")
    try {
      const changed = operation(this.read())
      writeSharedJSON(this.file, changed.records)
      return changed.result
    } finally {
      owner.release()
    }
  }
}

function fromPending(item: PendingApproval, ownerInstanceID: string, previous?: ApprovalRecord): ApprovalRecord {
  // 新请求从 pending 开始，已知 revision 只在仍存在时延续。
  return {
    ...item,
    ownerInstanceID,
    revision: previous?.revision ?? 0,
    status: previous?.status === ApprovalStatus.Applied ? ApprovalStatus.Applied : ApprovalStatus.Pending,
  }
}

function orderByCreation(left: ApprovalRecord, right: ApprovalRecord): number {
  // 创建时间相同用 requestID 稳定打破平局。
  return left.createdAt - right.createdAt || left.requestID.localeCompare(right.requestID)
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  // 过滤不完整记录，防止未知状态进入授权路径。
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<ApprovalRecord>
  return typeof item.requestID === "string" && typeof item.sessionID === "string" && typeof item.code === "number" && typeof item.permission === "string" && Array.isArray(item.patterns) && typeof item.project === "string" && typeof item.createdAt === "number" && typeof item.expiresAt === "number" && typeof item.ownerInstanceID === "string" && typeof item.revision === "number" && Object.values(ApprovalStatus).includes(item.status as ApprovalStatus)
}
