import type { PendingApproval } from "./domain.js"
import { openCodeAuthorization, openCodeHeaders } from "./server-auth.js"
import { WeChatStore } from "./store.js"

export interface PermissionAPI {
  list(): Promise<PendingApproval[]>
  reply(requestID: string, decision: "once" | "always" | "reject"): Promise<boolean>
}

interface PermissionResponse {
  id?: string
  requestID?: string
  sessionID?: string
  permission?: string
  type?: string
  patterns?: string[]
  pattern?: string | string[]
  metadata?: Record<string, unknown>
  time?: { created?: number }
  tool?: { messageID?: string }
}

interface SessionMessageResponse {
  info?: { time?: { created?: number } }
  parts?: Array<{
    time?: { start?: number }
    state?: { time?: { start?: number } }
  }>
}

export class HttpPermissionAPI implements PermissionAPI {
  constructor(
    private readonly serverURL: URL,
    private readonly store: WeChatStore,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly authorization: string | null = openCodeAuthorization(),
  ) {}

  async list(): Promise<PendingApproval[]> {
    const response = await this.fetcher(new URL("/permission", this.serverURL), {
      headers: openCodeHeaders(undefined, this.authorization),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`OpenCode permission list failed: HTTP ${response.status}`)

    const raw = (await response.json()) as PermissionResponse[]
    const existing = new Map(this.store.loadPendingApprovals().map((item) => [item.requestID, item]))
    let nextCode = Math.max(0, ...Array.from(existing.values(), (item) => item.code)) + 1

    const mapped = await Promise.all(raw.map(async (item) => {
      const requestID = item.id ?? item.requestID
      if (!requestID || !item.sessionID) return []
      const saved = existing.get(requestID)
      const createdAt = item.time?.created ?? (await this.requestCreatedAt(item)) ?? saved?.createdAt ?? Date.now()
      const pattern = item.patterns ?? (Array.isArray(item.pattern) ? item.pattern : item.pattern ? [item.pattern] : [])
      const project =
        stringMetadata(item.metadata, "directory") ??
        stringMetadata(item.metadata, "project") ??
        saved?.project ??
        "unknown"

      return [
        {
          requestID,
          sessionID: item.sessionID,
          code: saved?.code ?? nextCode++,
          permission: item.permission ?? item.type ?? saved?.permission ?? "unknown",
          patterns: pattern.length > 0 ? pattern : saved?.patterns ?? [],
          project,
          createdAt,
          expiresAt: saved?.expiresAt ?? createdAt + this.timeoutMs,
        },
      ]
    }))
    return mapped.flat()
  }

  async reply(requestID: string, decision: "once" | "always" | "reject"): Promise<boolean> {
    const response = await this.fetcher(new URL(`/permission/${encodeURIComponent(requestID)}/reply`, this.serverURL), {
      method: "POST",
      headers: openCodeHeaders({ "content-type": "application/json" }, this.authorization),
      body: JSON.stringify({ reply: decision }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`OpenCode permission reply failed: HTTP ${response.status}`)
    const body = await response.json().catch(() => true)
    return body !== false
  }

  private async requestCreatedAt(item: PermissionResponse): Promise<number | null> {
    const messageID = item.tool?.messageID
    if (!messageID || !item.sessionID) return null
    try {
      const response = await this.fetcher(
        new URL(
          `/session/${encodeURIComponent(item.sessionID)}/message/${encodeURIComponent(messageID)}`,
          this.serverURL,
        ),
        {
          headers: openCodeHeaders(undefined, this.authorization),
          signal: AbortSignal.timeout(10_000),
        },
      )
      if (!response.ok) return null
      const body = (await response.json()) as SessionMessageResponse
      const starts = (body.parts ?? [])
        .map((part) => part.state?.time?.start ?? part.time?.start)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      if (starts.length > 0) return Math.min(...starts)
      const created = body.info?.time?.created
      return typeof created === "number" && Number.isFinite(created) ? created : null
    } catch {
      return null
    }
  }
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value ? value : null
}
