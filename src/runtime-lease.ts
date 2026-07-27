import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

interface LeaseRecord {
  instanceID: string
  pid: number
  heartbeatAt: number
}

export class RuntimeLease {
  private readonly file: string
  private readonly instanceID = crypto.randomUUID()
  private readonly now: () => number
  private readonly staleAfterMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    directory: string,
    options: { now?: () => number; staleAfterMs?: number } = {},
  ) {
    fs.mkdirSync(directory, { recursive: true })
    this.file = path.join(directory, "runtime-lease.json")
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? 30_000
  }

  acquire(): boolean {
    if (this.tryCreate()) {
      this.startHeartbeat()
      return true
    }

    const current = this.read()
    if (!current || this.now() - current.heartbeatAt <= this.staleAfterMs) return false
    try {
      fs.unlinkSync(this.file)
    } catch {
      return false
    }
    if (!this.tryCreate()) return false
    this.startHeartbeat()
    return true
  }

  release(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.read()?.instanceID !== this.instanceID) return
    try {
      fs.unlinkSync(this.file)
    } catch {}
  }

  private tryCreate(): boolean {
    try {
      const descriptor = fs.openSync(this.file, "wx", 0o600)
      try {
        fs.writeFileSync(descriptor, JSON.stringify(this.record()), "utf8")
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      return true
    } catch {
      return false
    }
  }

  private startHeartbeat(): void {
    const interval = Math.max(1_000, Math.floor(this.staleAfterMs / 3))
    this.timer = setInterval(() => {
      if (this.read()?.instanceID !== this.instanceID) {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        return
      }
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.record()), { mode: 0o600 })
      } catch {}
    }, interval)
    this.timer.unref()
  }

  private record(): LeaseRecord {
    return {
      instanceID: this.instanceID,
      pid: process.pid,
      heartbeatAt: this.now(),
    }
  }

  private read(): LeaseRecord | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LeaseRecord>
      return typeof value.instanceID === "string" &&
        typeof value.pid === "number" &&
        typeof value.heartbeatAt === "number"
        ? (value as LeaseRecord)
        : null
    } catch {
      return null
    }
  }
}
