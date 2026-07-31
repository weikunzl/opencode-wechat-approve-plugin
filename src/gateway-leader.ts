import crypto from "node:crypto"
import type { InboundApprovalMessage } from "./wechat-gateway.js"
import { SharedMailbox } from "./shared-mailbox.js"

interface GatewayLike {
  initialize(): Promise<"ready" | "needs-binding">
  flushOutbox(): Promise<void>
  setInboundRecorder?(recorder: (message: InboundApprovalMessage) => Promise<void>): void
  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): void
  stop(): Promise<void>
}

interface LeaseLike {
  acquire(): boolean
  release(): void
}

interface GatewayLeaderOptions {
  gateway: GatewayLike
  mailbox: SharedMailbox
  lease: LeaseLike
  ownerInstanceID: string
}

export class GatewayLeader {
  private running = false
  private recorderConfigured = false

  constructor(private readonly options: GatewayLeaderOptions) {}

  async start(onMessage: (message: InboundApprovalMessage) => Promise<void>): Promise<boolean> {
    // 只有租约持有者初始化 transport 和长轮询，其他进程保持插件事件可用。
    if (!this.options.lease.acquire()) return false
    if ((await this.options.gateway.initialize()) !== "ready") return this.stopBeforeStart()
    await this.recoverOutbox()
    this.configureRecorder()
    this.running = true
    this.options.gateway.start((message) => this.handleMessage(message, onMessage))
    return true
  }

  async stop(): Promise<void> {
    // 停止先关闭回调入口，再释放租约，避免旧 Leader 继续发送命令。
    this.running = false
    await this.options.gateway.stop()
    this.options.lease.release()
  }

  private async handleMessage(
    message: InboundApprovalMessage,
    onMessage: (message: InboundApprovalMessage) => Promise<void>,
  ): Promise<void> {
    // 入站先写脱敏事件摘要，再交给审批路由，保证重启可检测重复消息。
    if (!this.running) return
    if (!this.recorderConfigured) this.persistInbound(message)
    if (!this.running) return
    await onMessage(message)
    this.options.mailbox.acknowledgeEvent(message.messageID)
  }

  private configureRecorder(): void {
    // 支持 WeChatGateway 的 cursor 前置持久化扩展，同时兼容测试 transport。
    if (!this.options.gateway.setInboundRecorder) return
    this.options.gateway.setInboundRecorder((message) => this.persistInbound(message))
    this.recorderConfigured = true
  }

  private persistInbound(message: InboundApprovalMessage): Promise<void> {
    // 邮箱只保存摘要，正文继续由当前 owner 在内存中解析。
    this.options.mailbox.publishEvent({ messageID: message.messageID, textDigest: digest(message.text), receivedAt: message.receivedAt })
    return Promise.resolve()
  }

  private async stopBeforeStart(): Promise<boolean> {
    // 未绑定时立即释放租约，避免阻塞其他实例的绑定恢复流程。
    this.options.lease.release()
    return false
  }

  private async recoverOutbox(): Promise<void> {
    // 旧通知失败不能阻止长轮询启动，否则会形成持有租约的假 Leader。
    try {
      await this.options.gateway.flushOutbox()
    } catch (error) {
      console.error(`[wechat] 通知队列恢复失败: ${firstLine(error)}`)
    }
  }
}

function digest(value: string): string {
  // 邮箱只保存摘要，原始微信正文仍留在内存回调中处理。
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function firstLine(error: unknown): string {
  // 日志只保留已由 gateway 脱敏的首行诊断。
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
}
