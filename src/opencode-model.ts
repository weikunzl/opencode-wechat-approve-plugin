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

interface InterpretSessionInput {
  sessionID: string
  text: string
  pending: PendingApproval[]
  threshold: number
}

enum ModelRoute {
  Create = "/session",
  Message = "/message",
}

enum ModelInputLimit {
  ReplyLength = 500,
  ProjectLength = 160,
  PermissionLength = 80,
  PatternLength = 160,
  PatternCount = 5,
}

export class OpenCodeApprovalModel {
  constructor(private readonly options: ModelOptions) {}

  async interpret(
    text: string,
    pending: PendingApproval[],
    threshold: number,
  ): Promise<ApprovalIntent> {
    // 内部会话只承担语义解释，任何失败都必须回退为澄清。
    let sessionID: string | null = null
    try {
      sessionID = await this.createSession()
      this.options.onInternalSession?.(sessionID, true)
      return await this.interpretSession({ sessionID, text, pending, threshold })
    } catch {
      return failedInterpretation()
    } finally {
      await this.deleteSession(sessionID)
    }
  }

  private async createSession(): Promise<string> {
    // 明确拒绝内部会话的一切工具权限，防止模型具备执行能力。
    const created = await this.request(ModelRoute.Create, { method: "POST", body: internalSessionBody() })
    const sessionID = record(created)?.id
    if (typeof sessionID !== "string") throw new Error("OpenCode 未返回解释会话 ID")
    return sessionID
  }

  private async interpretSession(input: InterpretSessionInput): Promise<ApprovalIntent> {
    // 兼容不接受 format 的 OpenCode 服务，仅解析 prompt 响应中的纯文本 JSON。
    const response = await this.request(`/session/${encodeURIComponent(input.sessionID)}${ModelRoute.Message}`, {
      method: "POST",
      body: this.promptBody(input),
    })
    return validateModelIntent(responseIntent(response), input.pending, input.threshold, input.text)
  }

  private promptBody(input: InterpretSessionInput): unknown {
    // 输出契约写入提示词，不能通过未声明的 SDK 字段绕过服务端校验。
    return {
      model: splitModel(this.options.model),
      tools: {},
      system: MODEL_SYSTEM_PROMPT,
      parts: [{ type: "text", text: JSON.stringify(modelInput(input)) }],
    }
  }

  private async deleteSession(sessionID: string | null): Promise<void> {
    // 无论模型成功与否都删除内部会话，避免产生生命周期通知或保留解释上下文。
    if (!sessionID) return
    try {
      await this.request(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    } catch {}
    this.options.onInternalSession?.(sessionID, false)
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

const MODEL_SYSTEM_PROMPT = [
  "You classify a WeChat reply to pending OpenCode permission requests.",
  "Return exactly one JSON object with requestIDs, decision, confidence, and explanation.",
  "Never call tools, invent request IDs, or wrap the JSON in Markdown.",
  "Ambiguous target or decision must use decision=clarify and requestIDs=[].",
].join(" ")

function internalSessionBody(): Record<string, unknown> {
  // 内部会话只允许文本解释，显式 deny 阻断工具和权限调用。
  return {
    title: "[internal] WeChat approval interpreter",
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
  }
}

function modelInput(input: InterpretSessionInput): Record<string, unknown> {
  // 仅向模型传递审批选择所需的脱敏字段，避免泄露无关会话内容。
  return {
    reply: input.text.slice(0, ModelInputLimit.ReplyLength),
    pending: input.pending.map((item) => ({
      requestID: item.requestID,
      code: item.code,
      project: sanitize(item.project, ModelInputLimit.ProjectLength),
      permission: sanitize(item.permission, ModelInputLimit.PermissionLength),
      patterns: item.patterns
        .map((pattern) => sanitize(pattern, ModelInputLimit.PatternLength))
        .slice(0, ModelInputLimit.PatternCount),
    })),
  }
}

function responseIntent(response: unknown): unknown {
  // 只接受响应 text parts 拼成的完整 JSON，其他格式一律交给安全校验澄清。
  const parts = record(response)?.parts
  if (!Array.isArray(parts)) return null
  return parseJson(parts.map(textPart).join(""))
}

function textPart(value: unknown): string {
  // 非文本 part 不属于模型授权决定，不能参与 JSON 拼接。
  const part = record(value)
  return part?.type === "text" && typeof part.text === "string" ? part.text : ""
}

function parseJson(value: string): unknown {
  // JSON 解析失败时返回空值，后续统一转换为 clarify。
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function failedInterpretation(): ApprovalIntent {
  // 服务端或模型异常不能生成授权，只提示用户使用确定性审批回复。
  return { requestIDs: [], decision: "clarify", confidence: 0, explanation: "模型解释失败，请明确选择待授权请求。" }
}

function splitModel(value: string): { providerID: string; modelID: string } {
  // 配置模型必须使用 provider/model 形式，避免向 OpenCode 传递歧义引用。
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) throw new Error("模型格式必须为 provider/model")
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

function sanitize(value: string, limit: number): string {
  // 清除控制字符并限制字段长度，防止模型提示被原始工具内容污染。
  return value.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, limit)
}

function record(value: unknown): Record<string, unknown> | null {
  // 仅把普通对象当作 API 响应，数组和原始值不能承载命名字段。
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function unwrap(value: unknown): unknown {
  // SDK ResponseResult 的 data 才是接口正文，失败结构交给上层统一澄清。
  const recordValue = record(value)
  return recordValue && "data" in recordValue ? recordValue.data : value
}
