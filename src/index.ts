import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Permission } from "@opencode-ai/sdk"
import { tool } from "@opencode-ai/plugin"
import { WeChatClient } from "./client.js"
import { WeChatStore } from "./store.js"
import { formatStatusMessage } from "./status-message.js"
import { formatError, SessionNotificationState } from "./notification-utils.js"

interface PendingPermission {
  permission: Permission
  confirmCode: string
  resolve: (response: "once" | "always" | "reject") => void
  createdAt: number
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export const WeChatPlugin: Plugin = async (input) => {
  const { client } = input

  const store = new WeChatStore()
  const wechat = new WeChatClient(store)

  const initialized = await wechat.init()
  if (!initialized) {
    console.error("[wechat] init failed, plugin disabled")
    return {}
  }

  const pendingPermissions = new Map<string, PendingPermission>()
  const notificationState = new SessionNotificationState()
  let confirmCounter = 0

  const nextConfirmCode = (): string => {
    confirmCounter++
    return `C${confirmCounter}`
  }

  const cleanupStalePermissions = () => {
    const timeout = 10 * 60 * 1000
    const now = Date.now()
    for (const [code, pending] of pendingPermissions) {
      if (now - pending.createdAt > timeout) {
        pending.resolve("reject")
        pendingPermissions.delete(code)
        console.log(`[wechat] stale permission ${code} auto-rejected`)
      }
    }
  }

  const getSessionTitle = async (sessionID: string): Promise<string> => {
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      if (res.data) return (res.data as any).title || sessionID.slice(0, 8)
    } catch {}
    return sessionID.slice(0, 8)
  }

  const resolvePendingPermission = (code: string, response: "once" | "always" | "reject"): boolean => {
    const pending = pendingPermissions.get(code)
    if (!pending) return false
    pending.resolve(response)
    pendingPermissions.delete(code)
    console.log(`[wechat] permission ${code} resolved: ${response}`)
    return true
  }

  const handlePermissionConfirmation = async (
    code: string,
    response: "once" | "always" | "reject",
  ): Promise<string> => {
    const pending = pendingPermissions.get(code)
    if (pending) {
      resolvePendingPermission(code, response)
      const label = response === "reject" ? "Denied" : response === "always" ? "Always allowed" : "Approved"
      const status = response === "reject" ? "rejected" : "approved"
      return formatStatusMessage(status, `[OK] #${code} ${label}`)
    }

    return formatStatusMessage("warning", `[WARN] #${code} expired, please retry the operation`)
  }

  const parseCommand = (content: string): { code: string; action: string } | null => {
    const trimmed = content.trim()
    const match = trimmed.match(/^(C\d+)\s+(yes|no|always|y|n|确认|拒绝|始终)$/i)
    if (match) return { code: match[1].toUpperCase(), action: match[2].toLowerCase() }

    const simpleMatch = trimmed.match(/^(yes|no|always|y|n|确认|拒绝|始终)$/i)
    if (simpleMatch && pendingPermissions.size === 1) {
      const code = [...pendingPermissions.keys()][0]
      return { code, action: simpleMatch[1].toLowerCase() }
    }

    return null
  }

  const normalizeAction = (action: string): "once" | "always" | "reject" => {
    if (["yes", "y", "确认"].includes(action)) return "once"
    if (["always", "始终"].includes(action)) return "always"
    return "reject"
  }

  wechat.onMessage(async (prompt, senderId, _contextToken) => {
    cleanupStalePermissions()

    const cmd = parseCommand(prompt.replace(/<wechat_message>[\s\S]*?---\n?/, "").trim())

    if (cmd) {
      const response = normalizeAction(cmd.action)
      const wasPending = pendingPermissions.has(cmd.code)
      const result = await handlePermissionConfirmation(cmd.code, response)
      await wechat.notifyUser(result)

      if (response !== "reject" && wasPending) {
        try {
          const sessionID = store.getSessionID()
          if (sessionID) {
            await client.session.promptAsync({
              path: { id: sessionID },
              body: {
                parts: [
                  {
                    type: "text",
                    text: `[System] Permission #${cmd.code} approved via WeChat. Retry the previously denied operation.`,
                  },
                ],
              },
            })
          }
        } catch (err) {
          console.error("[wechat] inject retry prompt failed:", err)
        }
      }
      return
    }

    if (/^(帮助|help|\?)$/i.test(prompt.trim())) {
      await wechat.notifyUser(
        formatStatusMessage(
          "help",
          [
            "Commands:",
            "  C<code> yes  - Approve permission",
            "  C<code> no   - Deny permission",
            "  C<code> always - Always allow",
            "  status       - Pending permissions",
            "  help         - Show this help",
            "",
            "Other messages are forwarded to AI.",
          ].join("\n"),
        ),
      )
      return
    }

    if (/^status$/i.test(prompt.trim())) {
      if (pendingPermissions.size === 0) {
        await wechat.notifyUser("No pending permissions")
      } else {
        const lines = [...pendingPermissions.entries()].map(
          ([code, p]) => `#${code}: ${p.permission.type} - ${p.permission.title || "N/A"}`,
        )
        await wechat.notifyUser(`Pending:\n${lines.join("\n")}`)
      }
      return
    }

    try {
      let sessionID = store.getSessionID()

      if (!sessionID) {
        console.log("[wechat] creating session...")
        const res = await client.session.create({ body: { title: "WeChat Bot" } })
        if (!res.data) throw new Error("create session failed")
        sessionID = res.data.id
        store.setSessionID(sessionID)
      }

      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: prompt }] },
      })

      console.log(`[wechat] message injected -> session ${sessionID}`)
    } catch (err) {
      console.error("[wechat] inject failed:", err)
    }
  })

  wechat.startPolling()

  return {
    event: async ({ event }: { event: Event }) => {
      const target = wechat.getNotificationTarget()
      if (!target) return

      switch (event.type) {
        case "session.idle": {
          const { sessionID } = (event as any).properties || {}
          if (!sessionID) break
          if (!notificationState.shouldNotifyDone(sessionID)) break
          const title = await getSessionTitle(sessionID)
          await wechat.notifyUser(formatStatusMessage("done", `[Done] ${title}\nAI task completed.`))
          break
        }

        case "session.error": {
          const { sessionID, error } = (event as any).properties || {}
          if (!sessionID) break
          notificationState.markFailed(sessionID)
          const title = await getSessionTitle(sessionID)
          const errMsg = formatError(error)
          await wechat.notifyUser(formatStatusMessage("error", `[Error] ${title}\n${errMsg.slice(0, 500)}`))
          break
        }

      }
    },

    "permission.ask": async (input: Permission, output: { status: "ask" | "deny" | "allow" }) => {
      if (!wechat.getNotificationTarget()) return

      const code = nextConfirmCode()
      const argsStr = input.metadata?.args
        ? typeof input.metadata.args === "string"
          ? input.metadata.args
          : JSON.stringify(input.metadata.args)
        : ""

      const message = [
        `[Approval Required #${code}]`,
        `Tool: ${input.type}`,
        input.title ? `Action: ${input.title}` : "",
        argsStr ? `Args: ${argsStr.slice(0, 200)}` : "",
        "",
        `Reply "${code} yes" to approve`,
        `Reply "${code} no" to deny`,
      ]
        .filter(Boolean)
        .join("\n")

      await wechat.notifyUser(formatStatusMessage("approval", message))

      const { promise, resolve } = createDeferred<"once" | "always" | "reject">()

      pendingPermissions.set(code, {
        permission: input,
        confirmCode: code,
        resolve,
        createdAt: Date.now(),
      })

      setTimeout(() => {
        const pending = pendingPermissions.get(code)
        if (pending) {
          pending.resolve("reject")
          pendingPermissions.delete(code)
          wechat.notifyUser(formatStatusMessage("timeout", `[Timeout] #${code} auto-denied (10min)`)).catch(() => {})
        }
      }, 10 * 60 * 1000)

      output.status = "deny"

      const response = await promise
      pendingPermissions.delete(code)

      if (response === "once" || response === "always") {
        output.status = "allow"
        console.log(`[wechat] #${code} approved via WeChat`)
      } else {
        output.status = "deny"
        console.log(`[wechat] #${code} denied via WeChat`)
      }
    },

    tool: {
      wechat_reply: tool({
        description: "Send WeChat text reply (plain text, no markdown)",
        args: {
          sender_id: tool.schema.string().describe("Sender ID (xxx@im.wechat format)"),
          text: tool.schema.string().describe("Reply text (plain text, no markdown)"),
        },
        async execute(args) {
          try {
            return await wechat.sendText(args.sender_id, args.text)
          } catch (err) {
            return `Send failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      wechat_send_image: tool({
        description: "Send WeChat image",
        args: {
          sender_id: tool.schema.string().describe("Sender ID"),
          file_path: tool.schema.string().describe("Absolute image path"),
        },
        async execute(args) {
          try {
            return await wechat.sendImage(args.sender_id, args.file_path)
          } catch (err) {
            return `Send failed: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      wechat_notify: tool({
        description: "Send a notification to the WeChat user (for proactive updates)",
        args: {
          text: tool.schema.string().describe("Notification text (plain text)"),
        },
        async execute(args) {
          const sent = await wechat.notifyUser(args.text)
          return sent ? "Notification sent" : "No target set. User must send a message first."
        },
      }),

      wechat_permission_confirm: tool({
        description: "Request WeChat user confirmation for a permission. Blocks until user replies.",
        args: {
          permission_id: tool.schema.string().describe("Permission ID to confirm"),
          description: tool.schema.string().describe("Human-readable description of the action"),
        },
        async execute(args) {
          const code = nextConfirmCode()
          await wechat.notifyUser(
            formatStatusMessage(
              "approval",
              [
                `[Confirmation #${code}]`,
                args.description,
                "",
                `Reply "${code} yes" or "${code} no"`,
              ].join("\n"),
            ),
          )

          const { promise, resolve } = createDeferred<"once" | "always" | "reject">()

          pendingPermissions.set(code, {
            permission: {
              id: args.permission_id,
              type: "manual",
              sessionID: "",
              messageID: "",
              title: args.description,
              metadata: {},
              time: { created: Date.now() },
            },
            confirmCode: code,
            resolve,
            createdAt: Date.now(),
          })

          setTimeout(() => {
            const p = pendingPermissions.get(code)
            if (p) {
              p.resolve("reject")
              pendingPermissions.delete(code)
              wechat.notifyUser(formatStatusMessage("timeout", `[Timeout] #${code} auto-denied (5min)`)).catch(() => {})
            }
          }, 5 * 60 * 1000)

          const response = await promise
          const label = response === "reject" ? "Denied" : response === "always" ? "Always allowed" : "Approved"
          const status = response === "reject" ? "rejected" : "approved"
          return formatStatusMessage(status, `[${label}] ${args.description}`)
        },
      }),

      wechat_new_session: tool({
        description: "Create new WeChat session (clears history)",
        args: {},
        async execute() {
          store.clearSessionID()
          const res = await client.session.create({ body: { title: "WeChat Bot" } })
          if (!res.data) throw new Error("create session failed")
          store.setSessionID(res.data.id)
          return `New session: ${res.data.id}`
        },
      }),
    },
  }
}

export default WeChatPlugin
