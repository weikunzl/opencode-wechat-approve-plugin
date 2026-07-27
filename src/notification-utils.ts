export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message

    try {
      return JSON.stringify(error)
    } catch {
      return "Unknown error"
    }
  }

  return String(error || "Unknown error")
}

export class SessionNotificationState {
  private failedSessions = new Set<string>()

  markFailed(sessionID: string): void {
    this.failedSessions.add(sessionID)
  }

  shouldNotifyDone(sessionID: string): boolean {
    if (!this.failedSessions.delete(sessionID)) return true
    return false
  }
}
