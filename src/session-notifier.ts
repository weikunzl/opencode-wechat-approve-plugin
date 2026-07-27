import type { NotificationEnvelope, SessionRunState } from "./domain.js"
import { formatError } from "./notification-utils.js"
import { formatStatusMessage } from "./status-message.js"
import { WeChatStore } from "./store.js"

export interface SessionMetadata {
  title: string
  directory: string
}

type MetadataResolver = (sessionID: string) => Promise<SessionMetadata>

interface SessionEventLike {
  type: string
  properties?: {
    sessionID?: string
    status?: { type?: string }
    error?: unknown
    info?: {
      id?: string
      title?: string
      directory?: string
    }
  }
}

export class SessionNotifier {
  private states = new Map<string, SessionRunState>()

  constructor(
    private readonly store: WeChatStore,
    private readonly resolveMetadata: MetadataResolver,
    private readonly now: () => number = Date.now,
    private readonly shouldIgnore: (sessionID: string) => boolean = () => false,
  ) {
    for (const state of store.loadSessionStates()) this.states.set(state.sessionID, state)
  }

  async handle(event: SessionEventLike): Promise<NotificationEnvelope[]> {
    if (event.type === "session.updated" || event.type === "session.created") {
      const info = event.properties?.info
      if (!info?.id || this.shouldIgnore(info.id)) return []
      const current = this.states.get(info.id)
      this.states.set(info.id, {
        sessionID: info.id,
        phase: current?.phase ?? "idle",
        run: current?.run ?? 0,
        title: info.title || current?.title,
        directory: info.directory || current?.directory,
        updatedAt: this.now(),
      })
      this.persist()
      return []
    }

    const sessionID = event.properties?.sessionID
    if (!sessionID || this.shouldIgnore(sessionID)) return []

    if (event.type === "session.status") {
      const type = event.properties?.status?.type
      if (type === "busy" || type === "retry") this.markBusy(sessionID)
      if (type === "idle") return this.markIdle(sessionID)
      return []
    }

    if (event.type === "session.idle") return this.markIdle(sessionID)
    if (event.type === "session.error") return this.markError(sessionID, event.properties?.error)
    return []
  }

  snapshot(): SessionRunState[] {
    return [...this.states.values()].sort((left, right) => left.sessionID.localeCompare(right.sessionID))
  }

  restore(states: SessionRunState[]): void {
    this.states = new Map(states.map((state) => [state.sessionID, state]))
    this.persist()
  }

  private markBusy(sessionID: string): void {
    const current = this.states.get(sessionID)
    if (current?.phase === "busy") return

    this.states.set(sessionID, {
      ...current,
      sessionID,
      phase: "busy",
      run: (current?.run ?? 0) + 1,
      updatedAt: this.now(),
    })
    this.persist()
  }

  private async markIdle(sessionID: string): Promise<NotificationEnvelope[]> {
    const current = this.states.get(sessionID)
    if (!current) {
      this.states.set(sessionID, { sessionID, phase: "idle", run: 0, updatedAt: this.now() })
      this.persist()
      return []
    }

    if (current.phase === "failed" || current.phase === "cancelled") {
      this.states.set(sessionID, { ...current, phase: "idle", updatedAt: this.now() })
      this.persist()
      return []
    }

    if (current.phase !== "busy") return []

    const metadata = await this.safeMetadata(sessionID)
    const completed: SessionRunState = {
      ...current,
      ...metadata,
      phase: "completed",
      updatedAt: this.now(),
    }
    const notification: NotificationEnvelope = {
      id: `session:${sessionID}:run:${completed.run}:done`,
      kind: "done",
      text: formatStatusMessage(
        "done",
        [
          `[Done] ${metadata.title}`,
          `Session: ${sessionID}`,
          `Project: ${metadata.directory}`,
          `Completed: ${new Date(completed.updatedAt).toISOString()}`,
        ].join("\n"),
      ),
      createdAt: completed.updatedAt,
    }
    this.store.enqueueNotification(notification)
    this.states.set(sessionID, completed)
    this.persist()
    return [notification]
  }

  private async markError(sessionID: string, error: unknown): Promise<NotificationEnvelope[]> {
    const current = this.states.get(sessionID)
    const cancelled = errorName(error) === "MessageAbortedError"
    const phase = cancelled ? "cancelled" : "failed"

    if (current?.phase === phase) return []

    const metadata = await this.safeMetadata(sessionID)
    const failed: SessionRunState = {
      ...current,
      ...metadata,
      sessionID,
      phase,
      run: Math.max(1, current?.run ?? 0),
      updatedAt: this.now(),
    }
    const kind = cancelled ? "cancelled" : "error"
    const label = cancelled ? "Cancelled" : "Error"
    const details = cancelled ? "Task cancelled by user or client." : formatError(error)

    const notification: NotificationEnvelope = {
      id: `session:${sessionID}:run:${failed.run}:${kind}`,
      kind,
      text: formatStatusMessage(
        kind,
        [
          `[${label}] ${metadata.title}`,
          `Session: ${sessionID}`,
          `Project: ${metadata.directory}`,
          details,
        ].join("\n"),
      ),
      createdAt: failed.updatedAt,
    }
    this.store.enqueueNotification(notification)
    this.states.set(sessionID, failed)
    this.persist()
    return [notification]
  }

  private async safeMetadata(sessionID: string): Promise<SessionMetadata> {
    try {
      const metadata = await this.resolveMetadata(sessionID)
      return {
        title: metadata.title || sessionID,
        directory: metadata.directory || "unknown",
      }
    } catch {
      const current = this.states.get(sessionID)
      return {
        title: current?.title || sessionID,
        directory: current?.directory || "unknown",
      }
    }
  }

  private persist(): void {
    this.store.saveSessionStates(this.snapshot())
  }
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const name = (error as { name?: unknown }).name
  return typeof name === "string" ? name : ""
}
