import type { Plugin } from "@opencode-ai/plugin"
import { ApprovalManager } from "./approval-manager.js"
import { IlinkClientTransport } from "./client.js"
import type { NotificationEnvelope } from "./domain.js"
import { InternalSessionRegistry } from "./internal-session-registry.js"
import { HttpPermissionAPI } from "./opencode-permissions.js"
import { OpenCodeApprovalModel } from "./opencode-model.js"
import { SessionNotifier } from "./session-notifier.js"
import { WeChatStore } from "./store.js"
import { WeChatGateway, type InboundApprovalMessage } from "./wechat-gateway.js"

interface RuntimeGateway {
  initialize(): Promise<"ready" | "needs-binding">
  flushOutbox(): Promise<void>
  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): void
  send(notification: NotificationEnvelope): Promise<void>
}

interface RuntimeApprovalManager {
  reconcile(): Promise<NotificationEnvelope[]>
  onPermissionAsked(event: PermissionAskedLike): Promise<NotificationEnvelope[]>
  onPermissionReplied(event: PermissionRepliedLike): Promise<void>
  onMessage(message: InboundApprovalMessage): Promise<NotificationEnvelope[]>
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

export function createPluginRuntime(dependencies: {
  gateway: RuntimeGateway
  approvalManager: RuntimeApprovalManager
  sessionNotifier: RuntimeSessionNotifier
}) {
  const { gateway, approvalManager, sessionNotifier } = dependencies

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
      if ((await gateway.initialize()) !== "ready") {
        console.error("[wechat] 尚未完成绑定；请运行 wechat-approve bind")
        return false
      }

      try {
        await gateway.flushOutbox()
      } catch (error) {
        console.error(`[wechat] 通知队列恢复失败: ${firstLine(error)}`)
      }

      try {
        await deliver(await approvalManager.reconcile())
      } catch (error) {
        console.error(`[wechat] OpenCode 授权状态同步失败: ${firstLine(error)}`)
      }

      gateway.start(async (message) => {
        await deliver(await approvalManager.onMessage(message))
      })
      return true
    },
  }
}

export const WeChatPlugin: Plugin = async (input) => {
  const store = new WeChatStore()
  store.migrateLegacyState()
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
  const runtime = createPluginRuntime({ gateway, approvalManager, sessionNotifier })
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
