import crypto from "node:crypto"
import path from "node:path"
import { acquireDirectoryLock, ensureSharedDirectory, readSharedJSON, writeSharedJSON } from "./shared-file.js"

export enum InstanceStatus {
  Active = "active",
}

export interface PluginInstanceRecord {
  instanceID: string
  pid: number
  processFingerprint: string
  projectDirectory: string
  sessionIDs: string[]
  heartbeatAt: number
  status: InstanceStatus
}

interface InstanceInput {
  projectDirectory: string
  sessionIDs: string[]
}

const INSTANCE_FILE = "plugin-instances-v1.json"
const LOCK_DIRECTORY = "plugin-instances.lock"

export class PluginInstanceRegistry {
  private readonly file: string
  private readonly lock: string

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {
    // 实例注册与共享绑定使用同一受保护目录。
    ensureSharedDirectory(directory)
    this.file = path.join(directory, INSTANCE_FILE)
    this.lock = path.join(directory, LOCK_DIRECTORY)
  }

  register(input: InstanceInput): PluginInstanceRecord {
    // 注册前获取锁，确保两个 OpenCode 进程不会覆盖彼此的心跳记录。
    return this.update((records) => {
      const record = this.createRecord(input)
      records.push(record)
      return record
    })
  }

  heartbeat(instanceID: string, timestamp = this.now()): void {
    // 心跳只更新匹配实例，不允许借用其他实例身份。
    this.update((records) => {
      const record = records.find((item) => item.instanceID === instanceID)
      if (record) record.heartbeatAt = timestamp
      return undefined
    })
  }

  dispose(instanceID: string): void {
    // 释放实例时从注册表删除，避免已退出进程继续被路由命令。
    this.update((records) => records.filter((item) => item.instanceID !== instanceID))
  }

  list(): PluginInstanceRecord[] {
    // 读取时过滤损坏记录，调用方只看到完整的实例快照。
    return readSharedJSON<PluginInstanceRecord[]>(this.file, []).filter(isInstanceRecord)
  }

  private createRecord(input: InstanceInput): PluginInstanceRecord {
    // processFingerprint 用于诊断 PID 复用，但不包含用户或凭据数据。
    return {
      instanceID: crypto.randomUUID(),
      pid: process.pid,
      processFingerprint: `${process.platform}:${process.pid}`,
      projectDirectory: input.projectDirectory,
      sessionIDs: [...input.sessionIDs],
      heartbeatAt: this.now(),
      status: InstanceStatus.Active,
    }
  }

  private update<T>(operation: (records: PluginInstanceRecord[]) => T): T {
    // 锁内重读并写回，降低多进程同时心跳时的丢更新风险。
    const owner = acquireDirectoryLock(this.lock)
    if (!owner) throw new Error("plugin instance registry is busy")
    try {
      const records = this.list()
      const result = operation(records)
      const next = Array.isArray(result) ? result : records
      writeSharedJSON(this.file, next)
      return result
    } finally {
      owner.release()
    }
  }
}

function isInstanceRecord(value: unknown): value is PluginInstanceRecord {
  // 只接受需要路由的非敏感实例字段。
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<PluginInstanceRecord>
  return typeof item.instanceID === "string" && typeof item.pid === "number" &&
    typeof item.processFingerprint === "string" && typeof item.projectDirectory === "string" &&
    Array.isArray(item.sessionIDs) && item.sessionIDs.every((id) => typeof id === "string") &&
    typeof item.heartbeatAt === "number" && item.status === InstanceStatus.Active
}
