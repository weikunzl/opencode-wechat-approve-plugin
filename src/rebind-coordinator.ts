import { RebindPageStore } from "./rebind-page.js"
import {
  RebindSchemaVersion,
  RebindStatus,
  type RebindState,
} from "./rebind-state.js"
import { WeChatStore } from "./store.js"
import {
  TransportFailureKind,
  bindingGenerationDigest,
} from "./transport-health.js"

enum RebindTiming {
  ContextGraceMs = 60_000,
  QRValidityMs = 480_000,
}

enum RebindMessage {
  WaitingTitle = "微信连接正在自动恢复",
  Waiting = "请向微信机器人发送一条私聊消息，插件会使用新上下文自动恢复。",
  LinkTitle = "微信需要重新绑定",
  LinkFallback = "也可运行 wechat-approve rebind-link 再次查看。",
  ExpiredTitle = "微信重绑二维码不可用",
  Expired = "请运行 wechat-approve bind 重新生成二维码。",
  RecoveredTitle = "微信连接已恢复",
  Recovered = "新绑定已通过真实发送验证，通知队列正在恢复。",
}

export interface RebindNotice {
  title: string
  message: string
  variant: "info" | "success" | "warning" | "error"
}

export interface RebindRecovery {
  activate(): void
  request(failure: TransportFailureKind): void
  observeBindingChange(): void
  markTransportHealthy(): void
  requiresBinding(): boolean
  stop(): Promise<void>
}

interface RebindGateway {
  stop(): Promise<void>
  bind(
    onQRCode?: (value: string) => void | Promise<void>,
    force?: boolean,
    signal?: AbortSignal,
  ): Promise<void>
}

interface RebindTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(id: unknown): void
}

interface RebindCoordinatorOptions {
  store: WeChatStore
  gateway: RebindGateway
  pages: RebindPageStore
  notify: (notice: RebindNotice) => Promise<void>
  now?: () => number
  timers?: Partial<RebindTimers>
  contextGraceMs?: number
}

export class RebindCoordinator implements RebindRecovery {
  private readonly now: () => number
  private readonly timers: RebindTimers
  private readonly contextGraceMs: number
  private graceTimer: unknown = null
  private controller: AbortController | null = null
  private operation: Promise<void> | null = null

  constructor(private readonly options: RebindCoordinatorOptions) {
    // 时间与计时器可注入，宽限和退出路径可确定测试。
    this.now = options.now ?? Date.now
    this.timers = { ...defaultTimers(), ...options.timers }
    this.contextGraceMs = options.contextGraceMs ?? RebindTiming.ContextGraceMs
  }

  activate(): void {
    // 只有 Leader 激活时清理旧进程遗留的二维码页面。
    this.options.pages.cleanupAll()
    this.options.store.clearRebindState()
  }

  request(failure: TransportFailureKind): void {
    // 网络错误继续走退避，只有上下文和会话失效进入重绑流程。
    if (failure === TransportFailureKind.ContextRefresh) this.awaitContext()
    if (failure === TransportFailureKind.SessionExpired) this.startImmediately()
  }

  observeBindingChange(): void {
    // 宽限期内的新 context 取消二维码升级，真实健康仍由监督器验证。
    const state = this.options.store.loadRebindState()
    if (state.status !== RebindStatus.AwaitingContext) return
    if (state.bindingGenerationDigest === currentBindingDigest(this.options.store)) return
    this.clearGrace()
    this.options.store.clearRebindState()
  }

  markTransportHealthy(): void {
    // 只有真实发送成功后才删除页面并向用户报告恢复。
    const state = this.options.store.loadRebindState()
    if (state.status === RebindStatus.Idle) return
    this.options.pages.removeCurrent(state)
    this.options.store.clearRebindState()
    this.notify({ title: RebindMessage.RecoveredTitle, message: RebindMessage.Recovered, variant: "success" })
  }

  requiresBinding(): boolean {
    const status = this.options.store.loadRebindState().status
    return [RebindStatus.QrReady, RebindStatus.Expired].includes(status)
  }

  async stop(): Promise<void> {
    // 释放 Leader 时取消计时和登录请求，并精确删除临时页面。
    this.clearGrace()
    this.controller?.abort()
    await this.operation?.catch(() => {})
    this.options.pages.removeCurrent(this.options.store.loadRebindState())
    this.options.pages.cleanupAll()
    this.options.store.clearRebindState()
  }

  private awaitContext(): void {
    // 相同绑定代次只建立一个宽限期，避免重复 Toast 和二维码。
    const current = this.options.store.loadRebindState()
    if (current.status !== RebindStatus.Idle) return
    const startedAt = this.now()
    this.saveState(RebindStatus.AwaitingContext, startedAt, startedAt + this.contextGraceMs)
    this.notify({ title: RebindMessage.WaitingTitle, message: RebindMessage.Waiting, variant: "warning" })
    this.graceTimer = this.timers.setTimeout(() => this.launch(), this.contextGraceMs)
  }

  private startImmediately(): void {
    // -14 跳过宽限，同一进行中任务不会重复启动。
    this.clearGrace()
    if (this.operation) return
    const current = this.options.store.loadRebindState()
    if ([RebindStatus.QrReady, RebindStatus.Confirming].includes(current.status)) return
    this.saveState(RebindStatus.AwaitingContext, this.now(), this.now())
    this.launch()
  }

  private launch(): void {
    // 异步任务先保存引用，后续重复失败只复用本轮流程。
    this.clearGrace()
    if (this.operation) return
    const operation = this.runRebind()
    this.operation = operation
    void operation.finally(() => {
      if (this.operation === operation) this.operation = null
    })
  }

  private async runRebind(): Promise<void> {
    // 停止普通轮询后，二维码登录独占 transport 直到提交新绑定。
    this.options.store.invalidateContext()
    this.controller = new AbortController()
    try {
      await this.options.gateway.stop()
      await this.options.gateway.bind((value) => this.publishPage(value), true, this.controller.signal)
      if (!this.controller.signal.aborted) this.markConfirming()
    } catch {
      if (!this.controller.signal.aborted) this.markExpired()
    } finally {
      this.controller = null
    }
  }

  private async publishPage(qrContent: string): Promise<void> {
    // QR 原文只传给内存渲染器，持久状态仅保存随机文件名。
    const expiresAt = this.now() + RebindTiming.QRValidityMs
    const page = await this.options.pages.create({ qrContent, expiresAt })
    this.saveState(RebindStatus.QrReady, this.startedAt(), expiresAt, page.fileName)
    this.notify({
      title: RebindMessage.LinkTitle,
      message: `${page.url}\n${RebindMessage.LinkFallback}`,
      variant: "warning",
    })
  }

  private markConfirming(): void {
    // 已收到绑定消息但尚未完成真实探测，页面暂时保留。
    const current = this.options.store.loadRebindState()
    if (!current.pageFileName || current.expiresAt === null) return
    this.saveState(RebindStatus.Confirming, this.startedAt(), current.expiresAt, current.pageFileName)
  }

  private markExpired(): void {
    // 错误正文不进入状态或通知，只保留固定的重新绑定指引。
    const current = this.options.store.loadRebindState()
    this.options.pages.removeCurrent(current)
    this.saveState(RebindStatus.Expired, this.startedAt(), current.expiresAt)
    this.notify({ title: RebindMessage.ExpiredTitle, message: RebindMessage.Expired, variant: "error" })
  }

  private saveState(
    status: RebindStatus,
    startedAt: number,
    expiresAt: number | null,
    pageFileName: string | null = null,
  ): void {
    // 描述符只保存受控枚举、时间、随机文件名和不可逆绑定摘要。
    this.options.store.saveRebindState({
      schemaVersion: RebindSchemaVersion.V1,
      status,
      startedAt,
      expiresAt,
      pageFileName,
      bindingGenerationDigest: currentBindingDigest(this.options.store),
    })
  }

  private startedAt(): number {
    return this.options.store.loadRebindState().startedAt ?? this.now()
  }

  private clearGrace(): void {
    if (this.graceTimer === null) return
    this.timers.clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private notify(notice: RebindNotice): void {
    // TUI 不可用不能阻断恢复状态机。
    void this.options.notify(notice).catch(() => {})
  }
}

function currentBindingDigest(store: WeChatStore): string {
  const account = store.loadAccount()
  const context = store.loadContext()
  return bindingGenerationDigest({
    accountID: account?.accountId ?? null,
    baseUrl: account?.baseUrl ?? null,
    contextToken: context?.contextToken ?? null,
    contextUpdatedAt: context?.updatedAt ?? null,
  })
}

function defaultTimers(): RebindTimers {
  return {
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}
