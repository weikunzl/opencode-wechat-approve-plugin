export class InternalSessionRegistry {
  private readonly sessions = new Map<string, number>()

  constructor(
    private readonly retentionMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  update(sessionID: string, active: boolean): void {
    this.sessions.set(sessionID, active ? Number.POSITIVE_INFINITY : this.now() + this.retentionMs)
  }

  has(sessionID: string): boolean {
    const expiresAt = this.sessions.get(sessionID)
    if (expiresAt === undefined) return false
    if (expiresAt < this.now()) {
      this.sessions.delete(sessionID)
      return false
    }
    return true
  }
}
