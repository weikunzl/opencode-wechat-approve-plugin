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

  readEvents(): MailboxRecord[] {
    // 事件按持久化顺序返回，排序由 Leader 在写入前完成。
    return this.read().filter((record) => record.kind === MailboxRecordKind.Event)
  }

  readCommands(instanceID: string): Array<Extract<MailboxRecord, { kind: MailboxRecordKind.Command }>> {
    // 只返回当前实例拥有的命令，避免跨项目误应用权限。
    return this.read().filter(isCommandRecord).filter((record) => record.ownerInstanceID === instanceID)
  }

  acknowledgeCommand(commandID: string): void {
    // 命令只有在 owner 完成或明确判定过期后才从邮箱移除。
    this.update((records) => records.filter((record) => !isCommandRecord(record) || record.commandID !== commandID))
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

function isMailboxRecord(value: unknown): value is MailboxRecord {
  // 过滤状态文件中的未知记录，防止未定义命令被执行。
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<MailboxRecord>
  if (item.kind === MailboxRecordKind.Event) return typeof item.messageID === "string" && typeof item.textDigest === "string" && typeof item.receivedAt === "number"
  return item.kind === MailboxRecordKind.Command && typeof item.commandID === "string" && typeof item.messageID === "string" && typeof item.ownerInstanceID === "string" && typeof item.requestID === "string" && typeof item.expectedRevision === "number" && ["once", "always", "reject"].includes(String(item.decision))
}
