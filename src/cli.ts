import fs from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { isOwnedPluginSpec } from "./install.js"
import { PluginInstanceRegistry } from "./plugin-instance.js"
import { processFingerprint } from "./runtime-lease.js"
import { WeChatStore } from "./store.js"
import { TransportHealthStatus } from "./transport-health.js"

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

enum DoctorTiming {
  TransportFreshMs = 1_800_000,
  LeaderFreshMs = 30_000,
}

interface LeaderState {
  check: Check
  active: boolean
}

export interface DoctorResult {
  plugin: Check
  binding: Check
  model: Check
  transport: Check
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
  now?: () => number
}): Promise<DoctorResult> {
  // doctor 只读组合独立检查，任何一项失败都不掩盖其他状态。
  const globalConfig = readJSONC(options.configFile)
  const pluginConfig = readJSONC(path.join(options.stateDirectory, "config.json"))
  const store = new WeChatStore(options.stateDirectory)
  const registry = new PluginInstanceRegistry(options.stateDirectory)
  const instances = registry.prune()
  const activeInstances = instances.filter((item) => item.status === "active").length
  const now = (options.now ?? Date.now)()
  const leader = readLeaderState(options.stateDirectory, now)
  return {
    plugin: readPluginCheck(globalConfig),
    binding: readBindingCheck(store),
    model: readModelCheck(pluginConfig, options.availableModels),
    transport: readTransportCheck(store, leader.active, now),
    sharedState: { ok: fs.existsSync(options.stateDirectory), detail: "shared state directory ready" },
    instances: { ok: true, detail: `${activeInstances} active instance(s)` },
    leader: leader.check,
  }
}

function readTransportCheck(store: WeChatStore, activeLeader: boolean, now: number): Check {
  // doctor 区分凭据存在与真实传输健康，避免把过期绑定误报为可用。
  const health = store.loadTransportHealth()
  if (health.status === TransportHealthStatus.Healthy) {
    return readHealthyTransportCheck(health.lastSuccessAt, activeLeader, now)
  }
  if (health.status === TransportHealthStatus.NeedsRebind) {
    return { ok: false, detail: "needs rebind; run wechat-approve bind" }
  }
  if (health.status === TransportHealthStatus.Degraded) {
    return readDegradedTransportCheck(store, health.lastFailureKind, health.nextRetryAt)
  }
  if (health.lastSuccessAt === null) {
    return { ok: false, detail: "unknown: no successful transport probe" }
  }
  return {
    ok: false,
    detail: `${health.status} lastSuccessAt=${formatTimestamp(health.lastSuccessAt)}`,
  }
}

function readHealthyTransportCheck(
  lastSuccessAt: number | null,
  activeLeader: boolean,
  now: number,
): Check {
  // 健康状态必须同时有活跃 Leader 和足够新的真实发送时间。
  if (!activeLeader) return { ok: false, detail: "stale: no active gateway leader" }
  if (lastSuccessAt === null || now - lastSuccessAt > DoctorTiming.TransportFreshMs) {
    return { ok: false, detail: `stale lastSuccessAt=${formatTimestamp(lastSuccessAt)}` }
  }
  return { ok: true, detail: `healthy lastSuccessAt=${formatTimestamp(lastSuccessAt)}` }
}

function readDegradedTransportCheck(
  store: WeChatStore,
  failure: string | null,
  nextRetryAt: number | null,
): Check {
  // 降级信息只输出枚举、队列计数和时间，不暴露服务端错误正文。
  const outbox = store.loadOutbox().length
  return {
    ok: false,
    detail: `degraded failure=${failure ?? "unknown"} outbox=${outbox} nextRetryAt=${formatTimestamp(nextRetryAt)}`,
  }
}

function readPluginCheck(value: unknown): Check {
  // 只识别本项目管理的 npm 插件规格。
  const plugins = asRecord(value)?.plugin
  const configured = Array.isArray(plugins) &&
    plugins.some((item) => typeof item === "string" && isOwnedPluginSpec(item))
  return { ok: configured, detail: configured ? "configured" : "not configured" }
}

function readBindingCheck(store: WeChatStore): Check {
  // binding 只证明本地凭据结构完整，不代表微信传输在线。
  const account = asRecord(store.loadAccount())
  const context = asRecord(store.loadContext())
  const bound = typeof account?.token === "string" &&
    typeof account.accountId === "string" &&
    typeof context?.boundUserID === "string" &&
    typeof context.contextToken === "string"
  return { ok: bound, detail: bound ? "bound" : "not bound" }
}

function readModelCheck(value: unknown, availableModels: string[]): Check {
  // 模型必须是安装时确认且当前仍可用的完整 provider/model。
  const model = asRecord(value)?.model
  if (typeof model !== "string") return { ok: false, detail: "not configured" }
  return availableModels.includes(model)
    ? { ok: true, detail: model }
    : { ok: false, detail: `unavailable: ${model}` }
}

function formatTimestamp(value: number | null): string {
  // 缺失时间使用 unknown，输出仅包含非敏感健康摘要。
  return value === null ? "unknown" : new Date(value).toISOString()
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

function readLeaderState(directory: string, now: number): LeaderState {
  // doctor 只读取租约摘要，不发起网络请求也不改变租约归属。
  const file = path.join(directory, "runtime-lease.json")
  if (!fs.existsSync(file)) return { check: { ok: true, detail: "not elected" }, active: false }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    return validateLeaderState(value, now)
  } catch (error) {
    return { check: { ok: false, detail: firstLine(error) }, active: false }
  }
}

function validateLeaderState(value: Record<string, unknown>, now: number): LeaderState {
  // Leader 必须具备有效进程、当前进程指纹和新鲜心跳。
  const pid = value.pid
  const heartbeatAt = value.heartbeatAt
  if (!validLeaseNumber(pid, true) || !validLeaseNumber(heartbeatAt, false)) {
    return inactiveLeader("invalid leader lease")
  }
  if (typeof value.instanceID !== "string") {
    return inactiveLeader("invalid leader lease")
  }
  const age = now - (heartbeatAt as number)
  if (age < 0 || age > DoctorTiming.LeaderFreshMs || !processIsAlive(pid as number)) {
    return inactiveLeader("stale leader lease")
  }
  if (!fingerprintMatches(pid as number, value.processStart)) {
    return inactiveLeader("stale leader lease")
  }
  return { check: { ok: true, detail: "active leader lease" }, active: true }
}

function fingerprintMatches(pid: number, expected: unknown): boolean {
  // 旧租约无指纹时兼容存活进程，新租约必须防 PID 复用。
  if (expected === undefined) return true
  return typeof expected === "string" && processFingerprint(pid) === expected
}

function validLeaseNumber(value: unknown, positive: boolean): value is number {
  // 租约数字必须是安全整数，PID 还必须严格大于零。
  return Number.isSafeInteger(value) && (positive ? (value as number) > 0 : (value as number) >= 0)
}

function processIsAlive(pid: number): boolean {
  // EPERM 表示进程存在但当前用户无权发送信号。
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function inactiveLeader(detail: string): LeaderState {
  return { check: { ok: false, detail }, active: false }
}
