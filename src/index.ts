import crypto from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"
import { ApprovalManager } from "./approval-manager.js"
import { IlinkClientTransport } from "./client.js"
import type { NotificationEnvelope } from "./domain.js"
import { InternalSessionRegistry } from "./internal-session-registry.js"
import { OpenCodePermissionAdapter } from "./opencode-adapter.js"
import { SdkPermissionAPI } from "./sdk-permissions.js"
import { OpenCodeApprovalModel } from "./opencode-model.js"
import { normalizeOpenCodeEvent } from "./event-normalizer.js"
import { NormalizedEventKind } from "./plugin-types.js"
import { GatewayLeader } from "./gateway-leader.js"
import { PluginEventRouter } from "./plugin-event-router.js"
import { PluginInstanceRegistry } from "./plugin-instance.js"
import { SharedMailbox } from "./shared-mailbox.js"
import { RuntimeLease } from "./runtime-lease.js"
import { SessionNotifier } from "./session-notifier.js"
import { WeChatStore } from "./store.js"
import { WeChatGateway, type InboundApprovalMessage } from "./wechat-gateway.js"

interface RuntimeGateway {
  initialize(): Promise<"ready" | "needs-binding">
  flushOutbox(): Promise<void>
  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): void
  send(notification: NotificationEnvelope): Promise<void>
  stop?(): Promise<void>
}

interface RuntimeLeader {
  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): Promise<boolean>
  stop(): Promise<void>
}

interface RuntimeEventRouter {
  publish(input: { eventID: string; eventType: string; payload: Record<string, unknown> }): void
  drain(handler: (event: { eventType: string; payload: Record<string, unknown> }) => Promise<void>): Promise<void>
}

interface RuntimeInstanceRegistry {
  dispose(instanceID: string): void
}

interface RuntimeApprovalManager {
  reconcile(isActive?: () => boolean): Promise<NotificationEnvelope[]>
  onPermissionAsked(event: PermissionAskedLike): Promise<NotificationEnvelope[]>
  onPermissionReplied(event: PermissionRepliedLike): Promise<void>
  onMessage(
    message: InboundApprovalMessage,
    isActive?: () => boolean,
  ): Promise<NotificationEnvelope[]>
  expire?(now?: number, isActive?: () => boolean): Promise<NotificationEnvelope[]>
}

interface RuntimeSessionNotifier {
  handle(event: EventLike): Promise<NotificationEnvelope[]>
}

interface EventLike {
  type: string
  properties?: Record<string, unknown>
}

interface PermissionAskedLike {
  type: "permission.asked"
  properties: {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata?: Record<string, unknown>
  }
}

interface PermissionRepliedLike {
  type: "permission.replied"
  properties: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
  }
}

interface RuntimeTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(id: unknown): void
  setInterval(callback: () => void, milliseconds: number): unknown
  clearInterval(id: unknown): void
}

type RuntimeEventHandler = (event: EventLike) => Promise<void>

let leaseOwner: RuntimeEventHandler | null = null

export function createPluginRuntime(dependencies: {
  gateway: RuntimeGateway
  approvalManager: RuntimeApprovalManager
  sessionNotifier: RuntimeSessionNotifier
  lease?: {
    acquire(): boolean
    release(): void
    setOnLost?(callback: () => void): void
  }
  timers?: Partial<RuntimeTimers>
  leader?: RuntimeLeader
  eventRouter?: RuntimeEventRouter
  instanceRegistry?: RuntimeInstanceRegistry
  instanceID?: string
}) {
  const { gateway, approvalManager, sessionNotifier, lease, leader, eventRouter } = dependencies
  const defaultTimers: RuntimeTimers = {
    setTimeout: (callback: () => void, milliseconds: number) =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (id: unknown) =>
      globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
    setInterval: (callback: () => void, milliseconds: number) =>
      globalThis.setInterval(callback, milliseconds),
    clearInterval: (id: unknown) =>
      globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>),
  }
  const timers = { ...defaultTimers, ...dependencies.timers }
  let active = false
  let startupTimer: unknown = null
  let expiryTimer: unknown = null
  let deactivation: Promise<void> | null = null
  let ownerHandler: RuntimeEventHandler | null = null
  let leaderActive = false
  let eventDrainTimer: unknown = null

  const deactivate = (releaseLease: boolean): Promise<void> => {
    if (deactivation) return deactivation
    deactivation = (async () => {
      active = false
      if (startupTimer !== null) timers.clearTimeout(startupTimer)
      startupTimer = null
      if (expiryTimer !== null) timers.clearInterval(expiryTimer)
      expiryTimer = null
      if (leader) await leader.stop()
      else await gateway.stop?.()
      if (eventDrainTimer !== null) timers.clearInterval(eventDrainTimer)
      eventDrainTimer = null
      if (dependencies.instanceRegistry && dependencies.instanceID) dependencies.instanceRegistry.dispose(dependencies.instanceID)
      if (leaseOwner === ownerHandler) leaseOwner = null
      if (releaseLease) lease?.release()
    })()
    return deactivation
  }
  lease?.setOnLost?.(() => {
    void deactivate(false)
  })

  const deliver = async (notifications: NotificationEnvelope[]): Promise<void> => {
    for (const notification of notifications) {
      if (!active) return
      try {
        await gateway.send(notification)
      } catch (error) {
        console.error(`[wechat] 通知发送失败: ${firstLine(error)}`)
      }
    }
  }

  const processEvent = async (event: EventLike): Promise<void> => {
    // Leader 统一处理本地和邮箱事件，审批状态只在一个 owner 中变更。
    const normalized = normalizeOpenCodeEvent(event)
    if (normalized?.kind === NormalizedEventKind.PermissionAsked) {
      await deliver(await approvalManager.onPermissionAsked(toPermissionAsked(normalized)))
      return
    }
    if (normalized?.kind === NormalizedEventKind.PermissionReplied) {
      await approvalManager.onPermissionReplied(toPermissionReplied(normalized))
      return
    }
    await deliver(await sessionNotifier.handle(event))
  }

  const drainRemoteEvents = async (): Promise<void> => {
    // 远程实例事件逐条确认，处理期间崩溃会在下轮重放。
    if (!leaderActive || !eventRouter || !active) return
    await eventRouter.drain(async (event) => processEvent({ type: event.eventType, properties: event.payload }))
  }

  const hooks = {
    event: async ({ event }: { event: EventLike }): Promise<void> => {
      if (event.type === "global.disposed" || event.type === "server.instance.disposed") {
        await deactivate(true)
        return
      }
      if (!active) {
        // 多项目实例共享一个租约，非持有者把事件交给唯一活跃实例处理。
        if (leaseOwner && leaseOwner !== ownerHandler) await leaseOwner(event)
        return
      }
      if (eventRouter && !leaderActive) {
        eventRouter.publish(toPluginEvent(event))
        return
      }
      await processEvent(event)
    },
  }

  return {
    hooks,
    async start(): Promise<boolean> {
      if (leader) return startNative()
      if (lease && !lease.acquire()) {
        return false
      }
      if ((await gateway.initialize()) !== "ready") {
        console.error("[wechat] 尚未完成绑定；请运行 wechat-approve bind")
        lease?.release()
        return false
      }

      try {
        await gateway.flushOutbox()
      } catch (error) {
        console.error(`[wechat] 通知队列恢复失败: ${firstLine(error)}`)
      }

      gateway.start(async (message) => {
        if (!active) return
        await deliver(await approvalManager.onMessage(message, () => active))
      })
      active = true
      ownerHandler = (event) => hooks.event({ event })
      if (lease) leaseOwner = ownerHandler
      startupTimer = timers.setTimeout(() => {
        startupTimer = null
        if (!active) return
        void approvalManager
          .reconcile(() => active)
          .then(deliver)
          .catch((error) =>
            console.error(`[wechat] OpenCode 授权状态同步失败: ${firstLine(error)}`),
          )
      }, 1_000)
      unrefTimer(startupTimer)
      if (approvalManager.expire) {
        expiryTimer = timers.setInterval(() => {
          void approvalManager
            .expire?.(undefined, () => active)
            .then(deliver)
            .catch((error) =>
              console.error(`[wechat] 授权超时检查失败: ${firstLine(error)}`),
            )
        }, 30_000)
        unrefTimer(expiryTimer)
      }
      return true
    },
  }

  async function startNative(): Promise<boolean> {
    // 原生插件实例都加载成功，只有 Leader 负责绑定、轮询和恢复 outbox。
    active = true
    leaderActive = await leader!.start(async (message) => {
      if (active) await deliver(await approvalManager.onMessage(message, () => active))
    })
    if (leaderActive && eventRouter) {
      eventDrainTimer = timers.setInterval(() => void drainRemoteEvents(), 250)
      unrefTimer(eventDrainTimer)
    }
    if (leaderActive) scheduleReconcile()
    return true
  }

  function scheduleReconcile(): void {
    // 仅 Leader 做一次 OpenCode 权限同步，避免多进程重复刷新 pending。
    startupTimer = timers.setTimeout(() => {
      startupTimer = null
      void approvalManager.reconcile(() => active).then(deliver)
    }, 1_000)
    unrefTimer(startupTimer)
  }
}

function unrefTimer(timer: unknown): void {
  if (
    timer &&
    typeof timer === "object" &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}

export const WeChatPlugin: Plugin = async (input) => {
  const store = new WeChatStore()
  store.migrateLegacyState()
  const lease = new RuntimeLease(store.getDirectory())
  const instances = new PluginInstanceRegistry(store.getDirectory())
  const instance = instances.register({ projectDirectory: input.directory, sessionIDs: [] })
  const mailbox = new SharedMailbox(store.getDirectory())
  const eventRouter = new PluginEventRouter({ mailbox, instanceID: instance.instanceID })
  const config = store.loadPluginConfig()
  const internalSessions = new InternalSessionRegistry()

  const gateway = new WeChatGateway(store, new IlinkClientTransport(store))
  const leader = new GatewayLeader({
    gateway,
    mailbox,
    lease,
    ownerInstanceID: instance.instanceID,
  })
  const approvalModel = config.model
    ? new OpenCodeApprovalModel({
        serverURL: input.serverUrl,
        directory: input.directory,
        model: config.model,
        onInternalSession: (sessionID, active) => internalSessions.update(sessionID, active),
      })
    : null
  const approvalManager = new ApprovalManager({
    store,
    api: new SdkPermissionAPI(store, new OpenCodePermissionAdapter(input.client)),
    approvalTimeoutMs: config.approvalTimeoutMs,
    modelConfidenceThreshold: config.modelConfidenceThreshold,
    interpretModel: approvalModel
      ? (text, pending, threshold) => approvalModel.interpret(text, pending, threshold)
      : undefined,
  })
  const sessionNotifier = new SessionNotifier(
    store,
    async (sessionID) => {
      const response = await input.client.session.get({ path: { id: sessionID } })
      const session = response.data as { title?: string; directory?: string } | undefined
      return {
        title: session?.title || sessionID,
        directory: session?.directory || input.directory,
      }
    },
    Date.now,
    (sessionID) => internalSessions.has(sessionID),
  )
  const runtime = createPluginRuntime({
    gateway,
    approvalManager,
    sessionNotifier,
    lease,
    leader,
    eventRouter,
    instanceRegistry: instances,
    instanceID: instance.instanceID,
  })
  await runtime.start()
  return runtime.hooks as Awaited<ReturnType<Plugin>>
}

function toPermissionAsked(event: Extract<ReturnType<typeof normalizeOpenCodeEvent>, { kind: NormalizedEventKind.PermissionAsked }>): PermissionAskedLike {
  // 兼容旧 ApprovalManager 输入结构，集中完成字段映射。
  return {
    type: "permission.asked",
    properties: {
      id: event.id,
      sessionID: event.sessionID,
      permission: event.permission,
      patterns: event.patterns,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    },
  }
}

function toPermissionReplied(event: Extract<ReturnType<typeof normalizeOpenCodeEvent>, { kind: NormalizedEventKind.PermissionReplied }>): PermissionRepliedLike {
  // 统一新版 permissionID/response 与旧字段，保持审批状态机不变。
  return {
    type: "permission.replied",
    properties: { sessionID: event.sessionID, requestID: event.requestID, reply: event.reply },
  }
}

function toPluginEvent(event: EventLike): { eventID: string; eventType: string; payload: Record<string, unknown> } {
  // 只把生命周期和审批所需字段写入邮箱，正文和凭据留在本地内存。
  const payload = safeEventPayload(event)
  const eventID = crypto.createHash("sha256").update(JSON.stringify([event.type, payload])).digest("hex").slice(0, 24)
  return { eventID, eventType: event.type, payload }
}

function safeEventPayload(event: EventLike): Record<string, unknown> {
  // 跨进程事件仅保留可重建业务事件的最小字段集合。
  const source = event.properties ?? {}
  const payload: Record<string, unknown> = {}
  for (const key of ["sessionID", "status", "info", "id", "permission", "permissionID", "requestID", "reply", "response", "type", "pattern", "patterns", "time"]) {
    if (source[key] !== undefined) payload[key] = safeEventValue(key, source[key])
  }
  return payload
}

function safeEventValue(key: string, value: unknown): unknown {
  // metadata 只允许项目目录，error 只允许错误名，其他字段按原始结构保留。
  if (key === "info" && isRecord(value)) return pickInfo(value)
  if (key === "status" && isRecord(value)) return { type: value.type }
  if (key === "time" && isRecord(value)) return { created: value.created }
  return key === "error" ? firstLine(value) : value
}

function pickInfo(value: Record<string, unknown>): Record<string, unknown> {
  // 会话标题和目录用于通知显示，不携带消息正文。
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.directory === "string" ? { directory: value.directory } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 只接受普通对象，拒绝数组和可执行对象。
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
}

export default WeChatPlugin
