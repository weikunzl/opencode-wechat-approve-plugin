import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface FileLock {
  release(): void
}

export function acquireDirectoryLock(directory: string): FileLock | null {
  // mkdir 为跨进程原子操作，失败时让调用者保持原状态并稍后重试。
  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
  } catch {
    return null
  }
  return { release: () => releaseDirectoryLock(directory) }
}

export function writeSharedJSON(file: string, value: unknown): void {
  // 临时文件与目标文件位于同一目录，rename 在同一文件系统内原子生效。
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, "wx", 0o600)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value), "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}

export function readSharedJSON<T>(file: string, fallback: T): T {
  // 共享文件损坏时返回调用方提供的安全默认值，不输出正文。
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function releaseDirectoryLock(directory: string): void {
  // 只清理本模块使用的锁目录，失败代表其他进程已接管或已释放。
  try {
    fs.rmdirSync(directory)
  } catch {}
}

export function ensureSharedDirectory(directory: string): void {
  // 状态目录以 0700 创建，后续文件由写入函数固定为 0600。
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 })
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
}
