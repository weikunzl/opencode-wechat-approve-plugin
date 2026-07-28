import fs from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { isOwnedPluginSpec } from "./install.js"
import { PluginInstanceRegistry } from "./plugin-instance.js"
import { WeChatStore } from "./store.js"

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

enum AgentMode {
  Subagent = "subagent",
}

export interface DoctorResult {
  plugin: Check
  binding: Check
  model: Check
  sharedState: Check
  instances: Check
  leader: Check
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

export function resolveApprovalAgentNames(resolvedConfig: unknown): string[] {
  // 只选择会处理用户任务的 agent，避免改变子 agent 的独立授权边界。
  const agents = asRecord(asRecord(resolvedConfig)?.agent)
  return Object.entries(agents ?? {}).flatMap(([name, agent]) => {
    const config = asRecord(agent)
    return name && config && config.mode !== AgentMode.Subagent ? [name] : []
  })
}

export async function doctorInstallation(options: {
  configFile: string
  stateDirectory: string
  availableModels: string[]
  fetcher?: typeof fetch
  authorization?: string | null
}): Promise<DoctorResult> {
  const globalConfig = readJSONC(options.configFile)
  const pluginConfig = readJSONC(path.join(options.stateDirectory, "config.json"))
  const plugins = asRecord(globalConfig)?.plugin
  const configured =
    Array.isArray(plugins) &&
    plugins.some((item) => typeof item === "string" && isOwnedPluginSpec(item))

  const store = new WeChatStore(options.stateDirectory)
  const account = asRecord(store.loadAccount())
  const context = asRecord(store.loadContext())
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

  const registry = new PluginInstanceRegistry(options.stateDirectory)
  const instances = registry.list()
  const sharedState = { ok: fs.existsSync(options.stateDirectory), detail: "shared state directory ready" }
  const activeInstances = instances.filter((item) => item.status === "active").length
  const leader = readLeaderCheck(options.stateDirectory)

  return {
    plugin: { ok: configured, detail: configured ? "configured" : "not configured" },
    binding: { ok: bound, detail: bound ? "bound" : "not bound" },
    model,
    sharedState,
    instances: { ok: true, detail: `${activeInstances} active instance(s)` },
    leader,
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

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
}

function readLeaderCheck(directory: string): Check {
  // doctor 只读取租约摘要，不发起网络请求也不改变租约归属。
  const file = path.join(directory, "runtime-lease.json")
  if (!fs.existsSync(file)) return { ok: true, detail: "not elected" }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    return typeof value.instanceID === "string" ? { ok: true, detail: "leader lease present" } : { ok: false, detail: "invalid leader lease" }
  } catch (error) {
    return { ok: false, detail: firstLine(error) }
  }
}
