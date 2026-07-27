import type { Plugin } from "@opencode-ai/plugin"
import { ApprovalManager } from "./approval-manager.js"
import { IlinkClientTransport } from "./client.js"
import type { NotificationEnvelope } from "./domain.js"
import { InternalSessionRegistry } from "./internal-session-registry.js"
import { HttpPermissionAPI } from "./opencode-permissions.js"
import { OpenCodeApprovalModel } from "./opencode-model.js"
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

interface RuntimeApprovalManager {
  reconcile(): Promise<NotificationEnvelope[]>
  onPermissionAsked(event: PermissionAskedLike): Promise<NotificationEnvelope[]>
  onPermissionReplied(event: PermissionRepliedLike): Promise<void>
  onMessage(message: InboundApprovalMessage): Promise<NotificationEnvelope[]>
  expire?(): Promise<NotificationEnvelope[]>
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
}) {
  const { gateway, approvalManager, sessionNotifier, lease } = dependencies
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

  const deactivate = (releaseLease: boolean): Promise<void> => {
    if (deactivation) return deactivation
    deactivation = (async () => {
      active = false
      if (startupTimer !== null) timers.clearTimeout(startupTimer)
      startupTimer = null
      if (expiryTimer !== null) timers.clearInterval(expiryTimer)
      expiryTimer = null
      await gateway.stop?.()
      if (releaseLease) lease?.release()
    })()
    return deactivation
  }
  lease?.setOnLost?.(() => {
    void deactivate(false)
  })

  const deliver = async (notifications: NotificationEnvelope[]): Promise<void> => {
    for (const notification of notifications) {
      try {
        await gateway.send(notification)
      } catch (error) {
        console.error(`[wechat] 通知发送失败: ${firstLine(error)}`)
      }
    }
  }

  const hooks = {
    event: async ({ event }: { event: EventLike }): Promise<void> => {
      if (event.type === "global.disposed" || event.type === "server.instance.disposed") {
        await deactivate(true)
        return
      }
      if (!active) return
      if (isPermissionAsked(event)) {
        await deliver(await approvalManager.onPermissionAsked(event))
        return
      }

      const replied = normalizePermissionReplied(event)
      if (replied) {
        await approvalManager.onPermissionReplied(replied)
        return
      }

      await deliver(await sessionNotifier.handle(event))
    },
  }

  return {
    hooks,
    async start(): Promise<boolean> {
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
        await deliver(await approvalManager.onMessage(message))
      })
      active = true
      startupTimer = timers.setTimeout(() => {
        startupTimer = null
        if (!active) return
        void approvalManager
          .reconcile()
          .then(deliver)
          .catch((error) =>
            console.error(`[wechat] OpenCode 授权状态同步失败: ${firstLine(error)}`),
          )
      }, 1_000)
      unrefTimer(startupTimer)
      if (approvalManager.expire) {
        expiryTimer = timers.setInterval(() => {
          void approvalManager
            .expire?.()
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
  const config = store.loadPluginConfig()
  const internalSessions = new InternalSessionRegistry()

  const gateway = new WeChatGateway(store, new IlinkClientTransport(store))
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
    api: new HttpPermissionAPI(input.serverUrl, store, config.approvalTimeoutMs),
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
  const runtime = createPluginRuntime({ gateway, approvalManager, sessionNotifier, lease })
  await runtime.start()
  return runtime.hooks as Awaited<ReturnType<Plugin>>
}

function isPermissionAsked(event: EventLike): event is PermissionAskedLike {
  if (event.type !== "permission.asked" || !event.properties) return false
  return (
    typeof event.properties.id === "string" &&
    typeof event.properties.sessionID === "string" &&
    typeof event.properties.permission === "string" &&
    Array.isArray(event.properties.patterns)
  )
}

function normalizePermissionReplied(event: EventLike): PermissionRepliedLike | null {
  if (event.type !== "permission.replied" || !event.properties) return null
  const requestID = event.properties.requestID ?? event.properties.permissionID
  const reply = event.properties.reply ?? event.properties.response
  if (
    typeof event.properties.sessionID !== "string" ||
    typeof requestID !== "string" ||
    !["once", "always", "reject"].includes(String(reply))
  ) {
    return null
  }
  return {
    type: "permission.replied",
    properties: {
      sessionID: event.properties.sessionID,
      requestID,
      reply: reply as "once" | "always" | "reject",
    },
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
}

export default WeChatPlugin
