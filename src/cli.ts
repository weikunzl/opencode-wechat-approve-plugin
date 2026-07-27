import fs from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { PACKAGE_NAME } from "./install.js"

export interface OpenCodePaths {
  home?: string
  config?: string
  state?: string
  [key: string]: string | undefined
}

interface Check {
  ok: boolean
  detail: string
}

export interface DoctorResult {
  plugin: Check
  binding: Check
  model: Check
  server: Check
}

export function parseOpenCodePaths(output: string): OpenCodePaths {
  const result: OpenCodePaths = {}
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.+?)\s*$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}

export function resolveEffectiveModel(
  resolvedConfig: unknown,
  modelState: unknown,
): string | null {
  const config = asRecord(resolvedConfig)
  if (typeof config?.model === "string" && config.model.includes("/")) return config.model

  const recent = asRecord(modelState)?.recent
  if (!Array.isArray(recent)) return null
  const first = asRecord(recent[0])
  return typeof first?.providerID === "string" && typeof first.modelID === "string"
    ? `${first.providerID}/${first.modelID}`
    : null
}

export async function doctorInstallation(options: {
  configFile: string
  stateDirectory: string
  availableModels: string[]
  fetcher?: typeof fetch
}): Promise<DoctorResult> {
  const globalConfig = readJSONC(options.configFile)
  const pluginConfig = readJSONC(path.join(options.stateDirectory, "config.json"))
  const plugins = asRecord(globalConfig)?.plugin
  const configured =
    Array.isArray(plugins) &&
    plugins.some(
      (item) =>
        typeof item === "string" &&
        (item === PACKAGE_NAME ||
          item.startsWith(`${PACKAGE_NAME}@`) ||
          (item.startsWith("file:") &&
            item.includes(`/plugins/${PACKAGE_NAME}/dist/index.js`))),
    )

  const account = asRecord(readJSONC(path.join(options.stateDirectory, "account.json")))
  const context = asRecord(readJSONC(path.join(options.stateDirectory, "context-v1.json")))
  const bound =
    typeof account?.token === "string" &&
    typeof account.accountId === "string" &&
    typeof context?.boundUserID === "string" &&
    typeof context.contextToken === "string"

  const modelValue = asRecord(pluginConfig)?.model
  const model =
    typeof modelValue === "string" && options.availableModels.includes(modelValue)
      ? { ok: true, detail: modelValue }
      : {
          ok: false,
          detail:
            typeof modelValue === "string"
              ? `unavailable: ${modelValue}`
              : "not configured",
        }

  const serverConfig = asRecord(pluginConfig)?.server
  const serverRecord = asRecord(serverConfig)
  const hostname = typeof serverRecord?.hostname === "string" ? serverRecord.hostname : "127.0.0.1"
  const port = typeof serverRecord?.port === "number" ? serverRecord.port : 4096
  let server: Check
  try {
    const response = await (options.fetcher ?? fetch)(
      new URL("/global/health", `http://${formatHost(hostname)}:${port}`),
      { signal: AbortSignal.timeout(3_000) },
    )
    const body = asRecord(await response.json())
    server =
      response.ok && body?.healthy === true
        ? { ok: true, detail: `OpenCode ${String(body.version || "healthy")}` }
        : { ok: false, detail: `unhealthy: HTTP ${response.status}` }
  } catch (error) {
    server = { ok: false, detail: firstLine(error) }
  }

  return {
    plugin: { ok: configured, detail: configured ? "configured" : "not configured" },
    binding: { ok: bound, detail: bound ? "bound" : "not bound" },
    model,
    server,
  }
}

function readJSONC(file: string): unknown {
  try {
    return parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
}
