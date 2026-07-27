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

    return raw.flatMap((item) => {
      const requestID = item.id ?? item.requestID
      if (!requestID || !item.sessionID) return []
      const saved = existing.get(requestID)
      const createdAt = item.time?.created ?? saved?.createdAt ?? Date.now()
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
    })
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
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value ? value : null
}
