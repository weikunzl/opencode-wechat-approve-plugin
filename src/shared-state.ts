import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export enum StateSchemaVersion {
  V1 = 1,
  V2 = 2,
}

export interface SharedStateDocument {
  schemaVersion: StateSchemaVersion.V2
  approvals: unknown[]
  inbox: unknown[]
}

export interface SharedLock {
  release(): void
}

const STATE_FILE = "shared-state-v2.json"
const LOCK_DIRECTORY = "shared-state.lock"

export class SharedStateStore {
  private readonly stateFile: string
  private readonly lockDirectory: string

  constructor(private readonly directory: string) {
    // 共享状态目录只允许当前用户访问，避免跨用户读取绑定元数据。
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.stateFile = path.join(directory, STATE_FILE)
    this.lockDirectory = path.join(directory, LOCK_DIRECTORY)
  }

  load(): SharedStateDocument {
    // 读取失败时隔离损坏文件，返回不含敏感数据的空状态。
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown
      if (isV2(value)) return value
      if (isV1(value)) return migrateV1(value)
      throw new Error("invalid shared state")
    } catch {
      this.quarantine()
      return this.empty()
    }
  }

  save(value: SharedStateDocument): void {
    // 使用同目录临时文件和 rename，保证进程崩溃不会留下半个 JSON。
    const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`
    const descriptor = fs.openSync(temporary, "wx", 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value), "utf8")
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, this.stateFile)
    fs.chmodSync(this.stateFile, 0o600)
  }

  acquireLock(): SharedLock | null {
    // mkdir 具备跨进程排他性，失败表示其他实例正在更新共享状态。
    try {
      fs.mkdirSync(this.lockDirectory, { recursive: false, mode: 0o700 })
    } catch {
      return null
    }
    return { release: () => this.releaseLock() }
  }

  private releaseLock(): void {
    // 释放仅删除本实例创建的锁目录，不触碰其他状态文件。
    try {
      fs.rmdirSync(this.lockDirectory)
    } catch {}
  }

  private empty(): SharedStateDocument {
    // 空状态明确使用 V2，避免新实例重新写回旧格式。
    return { schemaVersion: StateSchemaVersion.V2, approvals: [], inbox: [] }
  }

  private quarantine(): void {
    // 损坏文件改名保留证据，文件名不包含状态正文。
    if (!fs.existsSync(this.stateFile)) return
    try {
      fs.renameSync(this.stateFile, `${this.stateFile}.corrupt-${Date.now()}`)
    } catch {}
  }
}

function isV2(value: unknown): value is SharedStateDocument {
  // 只接受版本号和两个数组，避免未知字段进入共享协调状态。
  if (!isRecord(value) || value.schemaVersion !== StateSchemaVersion.V2) return false
  return Array.isArray(value.approvals) && Array.isArray(value.inbox)
}

function isV1(value: unknown): value is { schemaVersion: StateSchemaVersion.V1; pending?: unknown[] } {
  // V1 仅用于一次性迁移，旧 server 配置不会被复制。
  return isRecord(value) && value.schemaVersion === StateSchemaVersion.V1 && (value.pending === undefined || Array.isArray(value.pending))
}

function migrateV1(value: { pending?: unknown[] }): SharedStateDocument {
  // 将旧 pending 列表放入 approvals，并丢弃不再支持的 server 字段。
  return { schemaVersion: StateSchemaVersion.V2, approvals: value.pending ?? [], inbox: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // JSON 对象必须是普通非数组对象。
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
