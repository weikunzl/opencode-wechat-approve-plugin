import type { ApprovalIndex, ApprovalRecord } from "./approval-index.js"
import type { OpenCodePermissionAdapter, PermissionReplyInput } from "./opencode-adapter.js"
import type { MailboxCommand, SharedMailbox } from "./shared-mailbox.js"

interface CommandWorkerOptions {
  index: ApprovalIndex
  mailbox: SharedMailbox
  ownerInstanceID: string
  adapter: Pick<OpenCodePermissionAdapter, "reply">
}

export class CommandWorker {
  constructor(private readonly options: CommandWorkerOptions) {}

  async processOnce(): Promise<void> {
    // 每轮只消费当前 owner 的命令，其他项目的权限永远不会被本进程回写。
    for (const command of this.options.mailbox.readCommands(this.options.ownerInstanceID)) {
      await this.processCommand(command)
    }
  }

  private async processCommand(command: MailboxCommand): Promise<void> {
    // revision 不匹配时清理陈旧命令，不调用 OpenCode 权限接口。
    const record = this.findRecord(command)
    if (!record || record.revision !== command.expectedRevision) {
      this.options.index.markStale({ requestID: command.requestID, expectedRevision: command.expectedRevision })
      this.options.mailbox.acknowledgeCommand(command.commandID)
      return
    }
    try {
      const applied = await this.options.adapter.reply(toReplyInput(record, command))
      if (applied) this.complete(command)
      else this.retry(command)
    } catch {
      this.retry(command)
    }
  }

  private findRecord(command: MailboxCommand): ApprovalRecord | undefined {
    // 从共享索引重读最新记录，避免使用路由时的过期对象。
    return this.options.index.snapshot().find((item) => item.requestID === command.requestID && item.ownerInstanceID === command.ownerInstanceID)
  }

  private complete(command: MailboxCommand): void {
    // 成功回写后推进 revision，再删除幂等命令。
    if (this.options.index.markApplied({ requestID: command.requestID, expectedRevision: command.expectedRevision })) this.options.mailbox.acknowledgeCommand(command.commandID)
  }

  private retry(command: MailboxCommand): void {
    // 可恢复失败保留命令和索引，下一轮使用同一 requestID 重试。
    this.options.index.markRetryable({ requestID: command.requestID, expectedRevision: command.expectedRevision })
  }
}

function toReplyInput(record: ApprovalRecord, command: MailboxCommand): PermissionReplyInput {
  // 只把已校验的 session、request 和决定传给注入式 SDK adapter。
  return { sessionID: record.sessionID, requestID: command.requestID, decision: command.decision }
}
