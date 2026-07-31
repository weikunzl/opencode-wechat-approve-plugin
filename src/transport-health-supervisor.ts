import { isSessionTimeoutError, requiresContextRefresh } from "./client.js"
import type { NotificationEnvelope } from "./domain.js"
import { WeChatStore } from "./store.js"
import {
  TransportFailureKind,
  TransportHealthStatus,
  bindingGenerationDigest,
  type TransportHealthState,
} from "./transport-health.js"
import type { InboundApprovalMessage } from "./wechat-gateway.js"

enum HealthTiming {
  ProbeCooldownMs = 300_000,
  ContextStaleMs = 1_800_000,
  RetryBaseMs = 1_000,
  RetryMaximumMs = 300_000,
  MonitorIntervalMs = 3_000,
  ShutdownTimeoutMs = 2_000,
}

enum HealthMessage {
  Restarted = "🔄 [OpenCode] 微信授权插件已重新连接",
  Stopped = "⏹️ [OpenCode] 微信授权插件已停止",
}

interface HealthGateway {
  initialize(): Promise<"ready" | "needs-binding">
  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): void
  stop(): Promise<void>
  probe(notification: NotificationEnvelope): Promise<void>
  flushOutbox(): Promise<void>
}

interface TransportHealthSupervisorOptions {
  store: WeChatStore
  gateway: HealthGateway
  now?: () => number
  timers?: Partial<SupervisorTimers>
  shutdownTimeoutMs?: number
}

interface SupervisorTimers {
  setInterval(callback: () => void, milliseconds: number): unknown
  clearInterval(id: unknown): void
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(id: unknown): void
}

export interface TransportStopOptions {
  sendNotice: boolean
  cleanShutdown?: boolean
}

export class TransportHealthSupervisor {
  private readonly now: () => number
  private readonly timers: SupervisorTimers
  private readonly shutdownTimeoutMs: number
  private monitor: unknown = null
  private running = false
  private recovering = false
  private onMessage: ((message: InboundApprovalMessage) => Promise<void>) | null = null

  constructor(private readonly options: TransportHealthSupervisorOptions) {
    // 时间源可注入，保证重启和退避边界可确定测试。
    this.now = options.now ?? Date.now
    this.timers = { ...defaultTimers(), ...options.timers }
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? HealthTiming.ShutdownTimeoutMs
  }

  async start(onMessage: (message: InboundApprovalMessage) => Promise<void>): Promise<void> {
    // 先保留上次状态用于判断，再标记本次启动尚未正常关闭。
    const previous = this.options.store.loadTransportHealth()
    this.running = true
    this.onMessage = onMessage
    this.markStarting(previous)
    this.startMonitor()
    if ((await this.options.gateway.initialize()) !== "ready") {
      this.markNeedsRebind()
      return
    }
    this.options.gateway.start(onMessage)
    if (this.shouldProbe(previous)) await this.probeAndReplay()
    else this.markHealthy(previous)
  }

  async stop(options: TransportStopOptions): Promise<void> {
    // 停止监督器后不再接受恢复定时器，关闭通知只做有限等待。
    this.running = false
    this.stopMonitor()
    if (options.sendNotice && this.isHealthy()) await this.sendStopNotice()
    await this.options.gateway.stop()
    this.markStopped(options.cleanShutdown ?? true)
  }

  private async probeAndReplay(): Promise<void> {
    // 探测成功才恢复业务 outbox，任一失败都不能抛出到插件入口。
    try {
      await this.options.gateway.probe(this.probeNotification())
      this.markProbeSuccess()
      await this.options.gateway.flushOutbox()
    } catch (error) {
      this.markFailure(error)
      if (isSessionTimeoutError(rootCause(error))) {
        this.options.store.invalidateContext()
        await this.options.gateway.stop()
      }
    }
  }

  private async recoverIfNeeded(): Promise<void> {
    // 绑定代次或退避到期时，在同一 Leader 内恢复 transport。
    if (!this.running || this.recovering) return
    const state = this.options.store.loadTransportHealth()
    const changed = state.bindingGenerationDigest !== this.bindingDigest()
    if (!changed && !retryIsDue(state, this.now())) return
    this.recovering = true
    try {
      await this.recover(state)
    } finally {
      this.recovering = false
    }
  }

  private async recover(state: TransportHealthState): Promise<void> {
    // 只有完整新绑定才能重新启动长轮询并验证真实发送。
    if ((await this.options.gateway.initialize()) !== "ready") return
    this.markRecovering(state)
    if (this.onMessage) this.options.gateway.start(this.onMessage)
    await this.probeAndReplay()
  }

  private shouldProbe(previous: TransportHealthState): boolean {
    // 旧状态、积压和 context 年龄任一异常都强制真实发送。
    if (!previous.cleanShutdown || previous.status !== TransportHealthStatus.Healthy) return true
    if (this.options.store.loadOutbox().length > 0) return true
    if (previous.lastSuccessAt === null) return true
    if (this.now() - previous.lastSuccessAt >= HealthTiming.ProbeCooldownMs) return true
    return this.contextIsStale()
  }

  private contextIsStale(): boolean {
    // 未知更新时间按陈旧处理，避免迁移状态被误判为健康。
    const updatedAt = this.options.store.loadContext()?.updatedAt
    return !updatedAt || this.now() - updatedAt >= HealthTiming.ContextStaleMs
  }

  private markStarting(previous: TransportHealthState): void {
    // 启动即清除 clean 标记，崩溃后的下一次启动会强制探测。
    this.options.store.saveTransportHealth({
      ...previous,
      status: TransportHealthStatus.Starting,
      cleanShutdown: false,
      bindingGenerationDigest: this.bindingDigest(),
    })
  }

  private markHealthy(previous: TransportHealthState): void {
    // 冷却期内复用最近一次真实成功，不伪造新的成功时间。
    this.options.store.saveTransportHealth({
      ...previous,
      status: TransportHealthStatus.Healthy,
      cleanShutdown: false,
      bindingGenerationDigest: this.bindingDigest(),
    })
  }

  private markProbeSuccess(): void {
    // 真实 sendmessage 成功后才重置失败计数并标记 transport 健康。
    const timestamp = this.now()
    this.options.store.saveTransportHealth({
      ...this.options.store.loadTransportHealth(),
      status: TransportHealthStatus.Healthy,
      lastProbeAt: timestamp,
      lastSuccessAt: timestamp,
      lastFailureKind: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      bindingGenerationDigest: this.bindingDigest(),
    })
  }

  private markNeedsRebind(): void {
    // 本地绑定不完整时保留监督器状态，等待新的原子绑定代次。
    const current = this.options.store.loadTransportHealth()
    this.options.store.saveTransportHealth({
      ...current,
      status: TransportHealthStatus.NeedsRebind,
      lastFailureAt: this.now(),
      lastFailureKind: TransportFailureKind.SessionExpired,
    })
  }

  private markRecovering(previous: TransportHealthState): void {
    // 新绑定或退避到期先进入显式恢复态，doctor 不会提前报告健康。
    this.options.store.saveTransportHealth({
      ...previous,
      status: TransportHealthStatus.Recovering,
      bindingGenerationDigest: this.bindingDigest(),
    })
  }

  private markFailure(error: unknown): void {
    // 只保存受控失败类别，不持久化原始错误文本。
    const current = this.options.store.loadTransportHealth()
    const failure = classifyFailure(error)
    const failures = current.consecutiveFailures + 1
    this.options.store.saveTransportHealth({
      ...current,
      status: failure === TransportFailureKind.SessionExpired
        ? TransportHealthStatus.NeedsRebind
        : TransportHealthStatus.Degraded,
      lastProbeAt: this.now(),
      lastFailureAt: this.now(),
      lastFailureKind: failure,
      consecutiveFailures: failures,
      nextRetryAt: this.now() + retryDelay(failures),
    })
  }

  private probeNotification(): NotificationEnvelope {
    // 时间桶与绑定摘要组成稳定键，热重载和同轮重试不会重复提示。
    const bucket = Math.floor(this.now() / HealthTiming.ProbeCooldownMs)
    return {
      id: `transport-health:start:${this.bindingDigest()}:${bucket}`,
      kind: "warning",
      text: HealthMessage.Restarted,
      createdAt: this.now(),
    }
  }

  private stopNotification(): NotificationEnvelope {
    // 停止消息使用本次绑定摘要和时间，避免与启动探测共享幂等键。
    return {
      id: `transport-health:stop:${this.bindingDigest()}:${this.now()}`,
      kind: "warning",
      text: HealthMessage.Stopped,
      createdAt: this.now(),
    }
  }

  private bindingDigest(): string {
    // 健康状态只使用凭据摘要比较绑定代次。
    const account = this.options.store.loadAccount()
    const context = this.options.store.loadContext()
    return bindingGenerationDigest({
      accountID: account?.accountId ?? null,
      baseUrl: account?.baseUrl ?? null,
      contextToken: context?.contextToken ?? null,
      contextUpdatedAt: context?.updatedAt ?? null,
    })
  }

  private startMonitor(): void {
    // 低频监督绑定代次与退避状态，不创建 OpenCode 外部守护进程。
    if (this.monitor !== null) return
    this.monitor = this.timers.setInterval(
      () => void this.recoverIfNeeded(),
      HealthTiming.MonitorIntervalMs,
    )
    unrefTimer(this.monitor)
  }

  private stopMonitor(): void {
    // 释放插件时同步取消所有恢复检查。
    if (this.monitor === null) return
    this.timers.clearInterval(this.monitor)
    this.monitor = null
  }

  private async sendStopNotice(): Promise<void> {
    // 关闭通知失败或超时都不能阻塞 OpenCode 退出。
    try {
      await this.withTimeout(this.options.gateway.probe(this.stopNotification()))
    } catch {}
  }

  private withTimeout(operation: Promise<void>): Promise<void> {
    // 定时器可注入，测试无需等待真实的两秒关闭上限。
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(resolve, this.shutdownTimeoutMs)
      operation.then(
        () => {
          this.timers.clearTimeout(timer)
          resolve()
        },
        (error) => {
          this.timers.clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  private isHealthy(): boolean {
    // 只有最近真实发送成功的 Leader 才能发送停止通知。
    return this.options.store.loadTransportHealth().status === TransportHealthStatus.Healthy
  }

  private markStopped(cleanShutdown: boolean): void {
    // 崩溃或租约丢失保留 false，下一位 Leader 会强制健康检查。
    this.options.store.saveTransportHealth({
      ...this.options.store.loadTransportHealth(),
      status: TransportHealthStatus.Stopped,
      cleanShutdown,
    })
  }
}

function classifyFailure(error: unknown): TransportFailureKind {
  // 包装错误向 cause 回溯，保持 transport 诊断类型可识别。
  const cause = rootCause(error)
  if (isSessionTimeoutError(cause)) return TransportFailureKind.SessionExpired
  if (requiresContextRefresh(cause)) return TransportFailureKind.ContextRefresh
  if (cause instanceof TypeError || (cause instanceof Error && cause.name === "IlinkNetworkError")) {
    return TransportFailureKind.Network
  }
  return TransportFailureKind.Unknown
}

function rootCause(error: unknown): unknown {
  // WeChatGateway 使用 cause 包装脱敏消息，监督器只读取类型不输出内容。
  return error instanceof Error && error.cause ? error.cause : error
}

function retryDelay(failures: number): number {
  // 指数退避限制到五分钟，避免网络故障期间持续打扰微信 API。
  return Math.min(
    HealthTiming.RetryMaximumMs,
    HealthTiming.RetryBaseMs * 2 ** Math.min(failures - 1, 10),
  )
}

function retryIsDue(state: TransportHealthState, now: number): boolean {
  // 仅 degraded 状态按 nextRetryAt 主动重试，needs-rebind 必须等待新绑定。
  return state.status === TransportHealthStatus.Degraded &&
    state.nextRetryAt !== null && state.nextRetryAt <= now
}

function defaultTimers(): SupervisorTimers {
  // 默认定时器完全依附当前 OpenCode 进程生命周期。
  return {
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}

function unrefTimer(timer: unknown): void {
  // Node 定时器不应单独阻止 OpenCode 进程退出。
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref(): void }).unref()
  }
}
