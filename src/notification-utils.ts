export function formatError(error: unknown): string {
  const firstLine = (message: string) => message.split(/\r?\n/, 1)[0]

  if (error instanceof Error) return firstLine(error.message)
  if (typeof error === "string") return firstLine(error)

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return firstLine(message)

    const nestedMessage = (error as { data?: { message?: unknown } }).data?.message
    if (typeof nestedMessage === "string" && nestedMessage) return firstLine(nestedMessage)

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

  markFailed(sessionID: string): boolean {
    if (this.failedSessions.has(sessionID)) return false
    this.failedSessions.add(sessionID)
    return true
  }

  shouldNotifyDone(sessionID: string): boolean {
    if (!this.failedSessions.delete(sessionID)) return true
    return false
  }
}
