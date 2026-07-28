import type { PendingApproval } from "./domain.js"
import { validateModelIntent, type ApprovalIntent } from "./model-interpreter.js"

interface ModelOptions {
  client: ModelClient
  directory: string
  model: string
  onInternalSession?: (sessionID: string, active: boolean) => void
}

interface ModelClient {
  session: {
    create(options: unknown): Promise<unknown>
    prompt(options: unknown): Promise<unknown>
    delete(options: unknown): Promise<unknown>
  }
}

enum ModelRoute {
  Create = "/session",
  Message = "/message",
}

export class OpenCodeApprovalModel {
  constructor(private readonly options: ModelOptions) {}

  async interpret(
    text: string,
    pending: PendingApproval[],
    threshold: number,
  ): Promise<ApprovalIntent> {
    let sessionID: string | null = null
    try {
      const created = await this.request("/session", {
        method: "POST",
        body: {
          title: "[internal] WeChat approval interpreter",
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
      })
      const id = record(created)?.id
      if (typeof id !== "string") throw new Error("OpenCode 未返回解释会话 ID")
      sessionID = id
      this.options.onInternalSession?.(sessionID, true)

      const parsedModel = splitModel(this.options.model)
      const response = await this.request(`/session/${encodeURIComponent(sessionID)}/message`, {
        method: "POST",
        body: {
          model: parsedModel,
          tools: {},
          format: {
            type: "json_schema",
            schema: intentSchema,
            retryCount: 1,
          },
          system: [
            "You classify a WeChat reply to pending OpenCode permission requests.",
            "Return JSON only. Never call tools. Never invent request IDs.",
            "Ambiguous target or decision must use decision=clarify and requestIDs=[].",
          ].join(" "),
          parts: [
            {
              type: "text",
              text: JSON.stringify({
                reply: text.slice(0, 500),
                pending: pending.map((item) => ({
                  requestID: item.requestID,
                  code: item.code,
                  project: sanitize(item.project, 160),
                  permission: sanitize(item.permission, 80),
                  patterns: item.patterns.map((pattern) => sanitize(pattern, 160)).slice(0, 5),
                })),
              }),
            },
          ],
        },
      })
      return validateModelIntent(record(record(response)?.info)?.structured, pending, threshold, text)
    } catch {
      return {
        requestIDs: [],
        decision: "clarify",
        confidence: 0,
        explanation: "模型解释失败，请明确选择待授权请求。",
      }
    } finally {
      if (sessionID) {
        try {
          await this.request(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
        } catch {}
        this.options.onInternalSession?.(sessionID, false)
      }
    }
  }

  private async request(
    route: string,
    options: { method: "POST" | "DELETE"; body?: unknown },
  ): Promise<unknown> {
    // 模型会话始终通过官方注入 client，避免插件自行管理 server 鉴权。
    return this.requestWithClient(route, options)
  }

  private async requestWithClient(
    route: string,
    options: { method: "POST" | "DELETE"; body?: unknown },
  ): Promise<unknown> {
    // SDK 覆盖会话生命周期时，直接使用注入 client，避免固定端口和自行鉴权。
    const client = this.options.client
    if (route === ModelRoute.Create) return unwrap(await client.session.create({ query: { directory: this.options.directory }, body: options.body }))
    const sessionID = this.sessionIDFromRoute(route, options.method === "DELETE")
    if (options.method === "DELETE") return client.session.delete({ path: { id: sessionID }, query: { directory: this.options.directory } })
    return unwrap(await client.session.prompt({ path: { id: sessionID }, query: { directory: this.options.directory }, body: options.body }))
  }

  private sessionIDFromRoute(route: string, deleting: boolean): string {
    // 内部路由只允许本类生成的 /session/{id}/message 形式。
    const suffix = deleting ? "(?:/message)?" : "/message"
    const match = route.match(new RegExp(`^/session/([^/]+)${suffix}$`))
    if (!match) throw new Error("模型会话路由无效")
    return decodeURIComponent(match[1])
  }
}

const intentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestIDs", "decision", "confidence", "explanation"],
  properties: {
    requestIDs: { type: "array", items: { type: "string" } },
    decision: { type: "string", enum: ["once", "always", "reject", "clarify"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string" },
  },
}

function splitModel(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) throw new Error("模型格式必须为 provider/model")
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

function sanitize(value: string, limit: number): string {
  return value.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, limit)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function unwrap(value: unknown): unknown {
  // SDK ResponseResult 的 data 才是接口正文，失败结构交给上层统一澄清。
  const recordValue = record(value)
  return recordValue && "data" in recordValue ? recordValue.data : value
}
