import crypto from "node:crypto"
import type {
  TransportHealthSupervisor,
  TransportStopOptions,
} from "./transport-health-supervisor.js"
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
  supervisor?: Pick<TransportHealthSupervisor, "start" | "stop">
  shouldNotifyStop?: () => boolean
  timers?: Partial<LeaderTimers>
  random?: () => number
}

interface LeaderTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(id: unknown): void
}

enum LeaderTiming {
  RetryBaseMs = 3_000,
  RetryJitterMs = 1_000,
}

export class GatewayLeader {
  private running = false
  private desired = false
  private recorderConfigured = false
  private retryTimer: unknown = null
  private onMessage: ((message: InboundApprovalMessage) => Promise<void>) | null = null
  private onLeadership: ((active: boolean) => void) | null = null
  private readonly timers: LeaderTimers
  private readonly random: () => number

  constructor(private readonly options: GatewayLeaderOptions) {
    // 定时器和随机源可注入，接管测试不依赖真实等待。
    this.timers = { ...defaultLeaderTimers(), ...options.timers }
    this.random = options.random ?? Math.random
  }

  async start(onMessage: (message: InboundApprovalMessage) => Promise<void>): Promise<boolean> {
    // 所有实例保留接管意图，只有租约持有者激活微信 transport。
    this.desired = true
    this.onMessage = onMessage
    return this.tryActivate()
  }

  setLeadershipHandler(handler: (active: boolean) => void): void {
    // 运行时通过回调同步事件 drain 和权限 reconcile。
    this.onLeadership = handler
  }

  async stop(): Promise<void> {
    // 停止先关闭回调入口，再释放租约，避免旧 Leader 继续发送命令。
    this.desired = false
    this.clearRetry()
    if (!this.running) return
    await this.deactivate({ sendNotice: this.options.shouldNotifyStop?.() ?? true })
    this.options.lease.release()
  }

  async handleLeaseLoss(): Promise<void> {
    // 丢失租约时不发送停止通知，保留插件实例等待重新选举。
    if (this.running) await this.deactivate({ sendNotice: false, cleanShutdown: false })
    if (this.desired) this.scheduleRetry()
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

  private async tryActivate(): Promise<boolean> {
    // 获取失败进入低频重试，获取成功后只初始化一次 transport。
    if (!this.desired || this.running) return this.running
    if (!this.options.lease.acquire()) {
      this.scheduleRetry()
      return false
    }
    const active = await this.activate()
    if (!active) this.scheduleRetry()
    return active
  }

  private async activate(): Promise<boolean> {
    // recorder 必须在 supervisor 启动长轮询前配置。
    this.configureRecorder()
    this.running = true
    const handler = (message: InboundApprovalMessage) => this.handleCurrentMessage(message)
    if (this.options.supervisor) await this.options.supervisor.start(handler)
    else if (!(await this.startLegacy(handler))) return false
    this.onLeadership?.(true)
    return true
  }

  private async startLegacy(
    handler: (message: InboundApprovalMessage) => Promise<void>,
  ): Promise<boolean> {
    // 兼容测试与旧组合入口，同时保持 outbox 失败非致命。
    if ((await this.options.gateway.initialize()) !== "ready") {
      this.running = false
      return this.stopBeforeStart()
    }
    await this.recoverOutbox()
    this.options.gateway.start(handler)
    return true
  }

  private handleCurrentMessage(message: InboundApprovalMessage): Promise<void> {
    // 接管后始终使用最新注册的业务回调。
    return this.onMessage ? this.handleMessage(message, this.onMessage) : Promise.resolve()
  }

  private async deactivate(options: TransportStopOptions): Promise<void> {
    // 先关闭消息入口，再停止 supervisor 或兼容 gateway。
    this.running = false
    this.onLeadership?.(false)
    if (this.options.supervisor) await this.options.supervisor.stop(options)
    else await this.options.gateway.stop()
  }

  private scheduleRetry(): void {
    // 非 Leader 使用带抖动的低频重试，避免多个进程同时争抢租约。
    if (!this.desired || this.retryTimer !== null) return
    const delay = LeaderTiming.RetryBaseMs +
      Math.floor(this.random() * LeaderTiming.RetryJitterMs)
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      void this.tryActivate().catch((error) =>
        console.error(`[wechat] Leader 接管失败: ${firstLine(error)}`),
      )
    }, delay)
    unrefTimer(this.retryTimer)
  }

  private clearRetry(): void {
    // 插件释放后取消尚未执行的接管竞争。
    if (this.retryTimer === null) return
    this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
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

function defaultLeaderTimers(): LeaderTimers {
  // 接管定时器只依附当前 OpenCode 插件实例。
  return {
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}

function unrefTimer(timer: unknown): void {
  // 定时接管不能单独阻止 OpenCode 退出。
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref(): void }).unref()
  }
}
