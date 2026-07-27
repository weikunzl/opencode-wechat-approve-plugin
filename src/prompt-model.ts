export interface PromptModel {
  providerID: string
  modelID: string
}

export function parsePromptModel(value: unknown): PromptModel | undefined {
  if (typeof value !== "string") return undefined

  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined

  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

export function buildPromptBody(text: string, configuredModel?: string | null) {
  const model = parsePromptModel(configuredModel)
  return {
    ...(model ? { model } : {}),
    parts: [{ type: "text" as const, text }],
  }
}
