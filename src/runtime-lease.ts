import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

interface LeaseRecord {
  instanceID: string
  pid: number
  processStart?: string
  heartbeatAt: number
}

export class RuntimeLease {
  private readonly file: string
  private readonly instanceID = crypto.randomUUID()
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly heartbeatIntervalMs: number
  private readonly processStart = processFingerprint(process.pid)
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
      return this.claimAndAcquire(null)
    }
    if (sameProcess(current)) return false
    return this.claimAndAcquire(current.instanceID)
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

  private claimAndAcquire(expectedInstanceID: string | null): boolean {
    const claim = `${this.file}.claim-${process.pid}-${crypto.randomUUID()}`
    try {
      fs.renameSync(this.file, claim)
    } catch {
      return false
    }
    const claimed = readLeaseFile(claim)
    if (
      (expectedInstanceID === null && claimed !== null) ||
      (expectedInstanceID !== null && claimed?.instanceID !== expectedInstanceID)
    ) {
      this.restoreClaim(claim)
      return false
    }
    if (!this.tryCreate()) {
      this.restoreClaim(claim)
      return false
    }
    if (claimed === null) {
      try {
        fs.renameSync(
          claim,
          `${this.file}.corrupt-${this.now()}-${crypto.randomUUID()}`,
        )
      } catch {}
    } else {
      try {
        fs.unlinkSync(claim)
      } catch {}
    }
    this.startHeartbeat()
    return true
  }

  private restoreClaim(claim: string): void {
    try {
      if (!fs.existsSync(this.file)) fs.renameSync(claim, this.file)
      else fs.unlinkSync(claim)
    } catch {}
  }

  private lose(): void {
    // 回调跨接管周期保持注册，重新取得租约后仍能报告后续丢失。
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.onLost?.()
  }

  private record(): LeaseRecord {
    return {
      instanceID: this.instanceID,
      pid: process.pid,
      ...(this.processStart ? { processStart: this.processStart } : {}),
      heartbeatAt: this.now(),
    }
  }

  private read(): LeaseRecord | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LeaseRecord>
      return typeof value.instanceID === "string" &&
        typeof value.pid === "number" &&
        (value.processStart === undefined || typeof value.processStart === "string") &&
        typeof value.heartbeatAt === "number"
        ? (value as LeaseRecord)
        : null
    } catch {
      return null
    }
  }
}

function sameProcess(record: LeaseRecord): boolean {
  if (!processExists(record.pid)) return false
  if (!record.processStart) return true
  const currentStart = processFingerprint(record.pid)
  return currentStart !== null && currentStart === record.processStart
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readLeaseFile(file: string): LeaseRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LeaseRecord>
    return typeof value.instanceID === "string" &&
      typeof value.pid === "number" &&
      (value.processStart === undefined || typeof value.processStart === "string") &&
      typeof value.heartbeatAt === "number"
      ? (value as LeaseRecord)
      : null
  } catch {
    return null
  }
}

export function processFingerprint(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const end = stat.lastIndexOf(")")
      const fields = stat.slice(end + 2).split(" ")
      return fields[19] ? `linux:${fields[19]}` : null
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        windowsHide: true,
      })
      const value = result.status === 0 ? result.stdout.trim() : ""
      return value ? `${process.platform}:${value}` : null
    }
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true },
      )
      const value = result.status === 0 ? result.stdout.trim() : ""
      return value ? `win32:${value}` : null
    }
  } catch {}
  return null
}
