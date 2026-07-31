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
}

export class TransportHealthSupervisor {
  private readonly now: () => number

  constructor(private readonly options: TransportHealthSupervisorOptions) {
    // 时间源可注入，保证重启和退避边界可确定测试。
    this.now = options.now ?? Date.now
  }

  async start(onMessage: (message: InboundApprovalMessage) => Promise<void>): Promise<void> {
    // 先保留上次状态用于判断，再标记本次启动尚未正常关闭。
    const previous = this.options.store.loadTransportHealth()
    this.markStarting(previous)
    if ((await this.options.gateway.initialize()) !== "ready") {
      this.markNeedsRebind()
      return
    }
    this.options.gateway.start(onMessage)
    if (this.shouldProbe(previous)) await this.probeAndReplay()
    else this.markHealthy(previous)
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
