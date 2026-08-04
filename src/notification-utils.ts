const APPROVAL_NOTIFICATION_PREFIX = "approval:"

export function approvalNotificationID(requestID: string): string {
  // 审批通知键集中生成，启动裁剪与实时入队使用同一命名规则。
  return `${APPROVAL_NOTIFICATION_PREFIX}${requestID}`
}

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
      return JSON.stringify(redactSensitiveValues(error))
    } catch {
      return "Unknown error"
    }
  }

  return String(error || "Unknown error")
}

export function sanitizeNotificationText(text: string, limit = 1_800): string {
  const redacted = text
    .replace(/\bBearer\s+[^\s,;}\]]+/gi, "Bearer [REDACTED]")
    .replace(
      /(^|\n)(\s*[a-z0-9_-]*(?:authorization|api[_-]?key|access[_-]?token|context[_-]?token|password|passwd|secret(?:[_-]?access[_-]?key)?)\s*=\s*)[^\r\n]*/gim,
      "$1$2[REDACTED]",
    )
    .replace(
      /("(?:[a-z0-9_-]*(?:authorization|api[_-]?key|access[_-]?token|context[_-]?token|password|passwd|secret(?:[_-]?access[_-]?key)?))"\s*:\s*)(?:"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null)/gim,
      '$1"[REDACTED]"',
    )
    .replace(
      /('(?:[a-z0-9_-]*(?:authorization|api[_-]?key|access[_-]?token|context[_-]?token|password|passwd|secret(?:[_-]?access[_-]?key)?))'\s*:\s*)'(?:\\.|[^'\\])*'/gim,
      "$1'[REDACTED]'",
    )
    .replace(
      /(^|[^a-z0-9])([a-z0-9_-]*(?:authorization|api[_-]?key|access[_-]?token|context[_-]?token|password|passwd|secret(?:[_-]?access[_-]?key)?))(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gim,
      "$1$2$3[REDACTED]",
    )
    .replace(/\[REDACTED\]\]+/g, "[REDACTED]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
  if (redacted.length <= limit) return redacted
  const suffix = "\n…[truncated]"
  return `${redacted.slice(0, Math.max(0, limit - suffix.length))}${suffix}`
}

function redactSensitiveValues(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, seen))
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : redactSensitiveValues(item, seen)
  }
  return output
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|api[_-]?key|access[_-]?token|context[_-]?token|password|passwd|secret(?:[_-]?access[_-]?key)?)/i.test(
    key,
  )
}
