export interface PluginConfig {
  model: string | null
  server: {
    hostname: string
    port: number
  }
  approvalTimeoutMs: number
  modelConfidenceThreshold: number
}

export function loadPluginConfig(value: unknown): PluginConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const server =
    input.server && typeof input.server === "object" ? (input.server as Record<string, unknown>) : {}

  const hostname =
    typeof server.hostname === "string" && isLoopback(server.hostname) ? server.hostname : "127.0.0.1"
  const port =
    typeof server.port === "number" && Number.isInteger(server.port) && server.port > 0 && server.port <= 65_535
      ? server.port
      : 4096
  const approvalTimeoutMs =
    typeof input.approvalTimeoutMs === "number" &&
    Number.isFinite(input.approvalTimeoutMs) &&
    input.approvalTimeoutMs >= 30_000 &&
    input.approvalTimeoutMs <= 86_400_000
      ? input.approvalTimeoutMs
      : 600_000
  const modelConfidenceThreshold =
    typeof input.modelConfidenceThreshold === "number" &&
    input.modelConfidenceThreshold >= 0.5 &&
    input.modelConfidenceThreshold <= 1
      ? input.modelConfidenceThreshold
      : 0.85

  return {
    model: typeof input.model === "string" && input.model.includes("/") ? input.model : null,
    server: { hostname, port },
    approvalTimeoutMs,
    modelConfidenceThreshold,
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}
