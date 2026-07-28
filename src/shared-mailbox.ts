import path from "node:path"
import { acquireDirectoryLock, ensureSharedDirectory, readSharedJSON, writeSharedJSON } from "./shared-file.js"

export enum MailboxRecordKind {
  Event = "event",
  Command = "command",
}

export interface MailboxEvent {
  messageID: string
  textDigest: string
  receivedAt: number
  sourceInstanceID?: string
  eventType?: string
  payload?: Record<string, unknown>
}

export interface MailboxCommand {
  commandID: string
  messageID: string
  ownerInstanceID: string
  requestID: string
  expectedRevision: number
  decision: "once" | "always" | "reject"
}

export type MailboxRecord =
  | ({ kind: MailboxRecordKind.Event } & MailboxEvent)
  | ({ kind: MailboxRecordKind.Command } & MailboxCommand)

type MailboxEventRecord = Extract<MailboxRecord, { kind: MailboxRecordKind.Event }>
type PluginMailboxEvent = MailboxEventRecord & { eventType: string; payload: Record<string, unknown> }

const MAILBOX_FILE = "shared-mailbox-v1.json"
const LOCK_DIRECTORY = "shared-mailbox.lock"

export class SharedMailbox {
  private readonly file: string
  private readonly lock: string

  constructor(private readonly directory: string) {
    // 邮箱与绑定状态共用受保护目录，但保留独立文件便于原子重放。
    ensureSharedDirectory(directory)
    this.file = path.join(directory, MAILBOX_FILE)
    this.lock = path.join(directory, LOCK_DIRECTORY)
  }

  publishEvent(event: MailboxEvent): void {
    // 先持久化入站事件，再由 Leader 推进外部 cursor。
    this.update((records) => this.appendUnique(records, { kind: MailboxRecordKind.Event, ...event }, event.messageID))
  }

  enqueueCommand(command: MailboxCommand): void {
    // commandID 是幂等键，重复微信消息不能重复授权。
    this.update((records) => this.appendUnique(records, { kind: MailboxRecordKind.Command, ...command }, command.commandID))
  }

  readEvents(): MailboxEventRecord[] {
    // 事件按持久化顺序返回，排序由 Leader 在写入前完成。
    return this.read().filter(isEventRecord)
  }

  readPluginEvents(): PluginMailboxEvent[] {
    // 只把带插件事件类型的记录交给事件路由，保留微信入站记录的确认权。
    return this.readEvents().filter(isPluginEvent)
  }

  readCommands(instanceID: string): Array<Extract<MailboxRecord, { kind: MailboxRecordKind.Command }>> {
    // 只返回当前实例拥有的命令，避免跨项目误应用权限。
    return this.read().filter(isCommandRecord).filter((record) => record.ownerInstanceID === instanceID)
  }

  acknowledgeCommand(commandID: string): void {
    // 命令只有在 owner 完成或明确判定过期后才从邮箱移除。
    this.update((records) => records.filter((record) => !isCommandRecord(record) || record.commandID !== commandID))
  }

  acknowledgeEvent(messageID: string): void {
    // Leader 完成事件分发后删除记录，重启前仍可从邮箱重放未确认事件。
    this.update((records) => records.filter((record) => !isEventRecord(record) || record.messageID !== messageID))
  }

  private read(): MailboxRecord[] {
    // 不可信文件内容只保留结构完整的邮箱记录。
    return readSharedJSON<MailboxRecord[]>(this.file, []).filter(isMailboxRecord)
  }

  private update(operation: (records: MailboxRecord[]) => MailboxRecord[]): void {
    // 锁内重读写入，确保两个进程追加命令时不会互相覆盖。
    const owner = acquireDirectoryLock(this.lock)
    if (!owner) throw new Error("shared mailbox is busy")
    try {
      writeSharedJSON(this.file, operation(this.read()))
    } finally {
      owner.release()
    }
  }

  private appendUnique(records: MailboxRecord[], record: MailboxRecord, key: string): MailboxRecord[] {
    // 同一种记录的幂等键重复时保留第一次观察到的内容。
    const exists = records.some((item) => item.kind === record.kind && recordKey(item) === key)
    return exists ? records : [...records, record]
  }
}

function recordKey(record: MailboxRecord): string {
  // 事件按 messageID 去重，命令按 commandID 去重。
  return record.kind === MailboxRecordKind.Event ? record.messageID : record.commandID
}

function isCommandRecord(record: MailboxRecord): record is Extract<MailboxRecord, { kind: MailboxRecordKind.Command }> {
  // 类型守卫让命令路由不会误读入站事件字段。
  return record.kind === MailboxRecordKind.Command
}

function isEventRecord(record: MailboxRecord): record is Extract<MailboxRecord, { kind: MailboxRecordKind.Event }> {
  // 事件记录必须有稳定 messageID 和摘要，附加插件事件字段可选。
  return record.kind === MailboxRecordKind.Event
}

function isMailboxRecord(value: unknown): value is MailboxRecord {
  // 过滤状态文件中的未知记录，防止未定义命令被执行。
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<MailboxRecord>
  if (item.kind === MailboxRecordKind.Event) return typeof item.messageID === "string" && typeof item.textDigest === "string" && typeof item.receivedAt === "number" && (item.payload === undefined || isPayload(item.payload))
  return item.kind === MailboxRecordKind.Command && typeof item.commandID === "string" && typeof item.messageID === "string" && typeof item.ownerInstanceID === "string" && typeof item.requestID === "string" && typeof item.expectedRevision === "number" && ["once", "always", "reject"].includes(String(item.decision))
}

function isPayload(value: unknown): value is Record<string, unknown> {
  // 事件 payload 只接受普通对象，防止函数或数组跨进程序列化。
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isPluginEvent(record: MailboxEventRecord): record is PluginMailboxEvent {
  // 插件事件必须同时包含类型和对象负载，微信入站摘要不参与路由。
  return typeof record.eventType === "string" && isPayload(record.payload)
}
