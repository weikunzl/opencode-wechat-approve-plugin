export function openCodeAuthorization(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const password = environment.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = environment.OPENCODE_SERVER_USERNAME || "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

export function openCodeHeaders(
  headers?: HeadersInit,
  authorization: string | null = openCodeAuthorization(),
): Headers {
  const result = new Headers(headers)
  if (authorization) result.set("authorization", authorization)
  return result
}
