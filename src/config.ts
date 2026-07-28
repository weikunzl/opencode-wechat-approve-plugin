export interface PluginConfig {
  model: string | null
  approvalTimeoutMs: number
  modelConfidenceThreshold: number
}

export function loadPluginConfig(value: unknown): PluginConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
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
    approvalTimeoutMs,
    modelConfidenceThreshold,
  }
}
