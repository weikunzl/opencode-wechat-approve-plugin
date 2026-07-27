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
  private readonly heartbeatIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private onLost: (() => void) | null = null

  constructor(
    directory: string,
    options: {
      now?: () => number
      staleAfterMs?: number
      heartbeatIntervalMs?: number
    } = {},
  ) {
    fs.mkdirSync(directory, { recursive: true })
    this.file = path.join(directory, "runtime-lease.json")
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? 30_000
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.staleAfterMs / 3))
  }

  setOnLost(callback: () => void): void {
    this.onLost = callback
  }

  acquire(): boolean {
    if (this.tryCreate()) {
      this.startHeartbeat()
      return true
    }

    const current = this.read()
    if (!current) {
      if (!this.quarantineCorrupt()) return false
      if (!this.tryCreate()) return false
      this.startHeartbeat()
      return true
    }
    if (processExists(current.pid)) return false
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
    const temporary = this.temporaryFile()
    try {
      this.writeTemporary(temporary, this.record())
      fs.linkSync(temporary, this.file)
      fs.chmodSync(this.file, 0o600)
      return true
    } catch {
      return false
    } finally {
      try {
        fs.unlinkSync(temporary)
      } catch {}
    }
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => {
      if (this.read()?.instanceID !== this.instanceID) {
        this.lose()
        return
      }
      try {
        this.atomicReplace(this.record())
      } catch {
        this.lose()
      }
    }, this.heartbeatIntervalMs)
    this.timer.unref()
  }

  private atomicReplace(record: LeaseRecord): void {
    const temporary = this.temporaryFile()
    try {
      this.writeTemporary(temporary, record)
      if (this.read()?.instanceID !== this.instanceID) {
        throw new Error("runtime lease ownership changed")
      }
      fs.renameSync(temporary, this.file)
      fs.chmodSync(this.file, 0o600)
    } finally {
      try {
        fs.unlinkSync(temporary)
      } catch {}
    }
  }

  private writeTemporary(file: string, record: LeaseRecord): void {
    const descriptor = fs.openSync(file, "wx", 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(record), "utf8")
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }

  private temporaryFile(): string {
    return `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
  }

  private quarantineCorrupt(): boolean {
    try {
      fs.renameSync(
        this.file,
        `${this.file}.corrupt-${this.now()}-${crypto.randomUUID()}`,
      )
      return true
    } catch {
      return false
    }
  }

  private lose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const callback = this.onLost
    this.onLost = null
    callback?.()
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
