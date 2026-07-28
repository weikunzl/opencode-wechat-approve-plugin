import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse } from "jsonc-parser"
import { loadPluginConfig } from "./config.js"
import { WeChatStore } from "./store.js"

export const PACKAGE_NAME = "@wekux/opencode-wechat-approve-plugin"
const LEGACY_PACKAGE_NAME = "opencode-wechat-approve-plugin"

enum PermissionKey {
  All = "*",
  Bash = "bash",
}

enum PermissionAction {
  Ask = "ask",
  Deny = "deny",
}

type JSONRecord = Record<string, unknown>

export function registryPluginSpec(packageRoot: string): string {
  // 从发布包元数据读取版本，避免安装器与 package.json 版本漂移。
  const file = path.join(packageRoot, "package.json")
  const metadata = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }
  if (typeof metadata.version !== "string" || !metadata.version) {
    throw new Error("安装包缺少有效版本号")
  }
  return `${PACKAGE_NAME}@${metadata.version}`
}

export interface PluginCommit {
  pluginSpec: string
  rollback(): void
  finalize(): void
}

export function localPluginSpec(configDirectory: string): string {
  return pathToFileURL(
    path.join(
      configDirectory,
      "managed-plugins",
      LEGACY_PACKAGE_NAME,
      "dist",
      "index.js",
    ),
  ).href
}

export function commitLocalPlugin(
  sourceRoot: string,
  configDirectory: string,
): PluginCommit {
  const sourceDist = path.join(sourceRoot, "dist")
  const sourcePackage = path.join(sourceRoot, "package.json")
  if (!fs.existsSync(path.join(sourceDist, "index.js")) || !fs.existsSync(sourcePackage)) {
    throw new Error("安装包缺少已构建的 dist/index.js 或 package.json")
  }

  const managedDirectory = path.join(configDirectory, "managed-plugins")
  const target = path.join(managedDirectory, LEGACY_PACKAGE_NAME)
  const temporary = path.join(
    managedDirectory,
    `.${LEGACY_PACKAGE_NAME}.${process.pid}.${Date.now()}.tmp`,
  )
  const backup = `${target}.previous`
  fs.mkdirSync(managedDirectory, { recursive: true })
  fs.mkdirSync(temporary)
  let hadPrevious = false
  try {
    fs.cpSync(sourceDist, path.join(temporary, "dist"), { recursive: true })
    fs.copyFileSync(sourcePackage, path.join(temporary, "package.json"))
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true })
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup)
      hadPrevious = true
    }
    try {
      fs.renameSync(temporary, target)
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target)
      throw error
    }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  let settled = false
  return {
    pluginSpec: localPluginSpec(configDirectory),
    rollback(): void {
      if (settled) return
      fs.rmSync(target, { recursive: true, force: true })
      if (hadPrevious && fs.existsSync(backup)) fs.renameSync(backup, target)
      settled = true
    },
    finalize(): void {
      if (settled) return
      fs.rmSync(backup, { recursive: true, force: true })
      settled = true
    },
  }
}

export function stageLocalPlugin(sourceRoot: string, configDirectory: string): string {
  const commit = commitLocalPlugin(sourceRoot, configDirectory)
  commit.finalize()
  return commit.pluginSpec
}

interface ConfigPatch {
  plugin: string
  hostname: string
  port: number
  agentNames?: string[]
}

interface PermissionPatchOptions {
  source: string
  value: unknown
  path: string[]
  formattingOptions: { insertSpaces: boolean; tabSize: number; eol: "\r\n" | "\n" }
}

interface ApprovalPatchOptions {
  source: string
  config: JSONRecord | null
  agentNames: string[]
  formattingOptions: { insertSpaces: boolean; tabSize: number; eol: "\r\n" | "\n" }
}

interface CorePatchOptions {
  source: string
  plugin: string
  hostname: string
  port: number
  formattingOptions: { insertSpaces: boolean; tabSize: number; eol: "\r\n" | "\n" }
}

interface InstallOptions {
  configFile: string
  store: WeChatStore
  availableModels: string[]
  configuredModel: string | null
  confirmModel(model: string): Promise<boolean>
  bind(force: boolean): Promise<void>
  sendTest(): Promise<boolean>
  pluginName?: string
  commitPlugin?(): PluginCommit
  hostname?: string
  port?: number
  agentNames?: string[]
}

export function patchOpenCodeConfig(source: string, patch: ConfigPatch): string {
  // 保留用户 JSONC 内容，同时只写入安装器负责的字段。
  const output = source.trim() ? source : "{}\n"
  const parsed = asRecord(parse(output))
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: detectEOL(output) }
  const core = patchCoreConfig({ source: output, ...patch, formattingOptions })
  const approved = patchApprovalPermissions({
    source: core,
    config: parsed,
    agentNames: patch.agentNames ?? [],
    formattingOptions,
  })
  return withTrailingEOL(approved, formattingOptions.eol)
}

function patchCoreConfig(options: CorePatchOptions): string {
  // 只更新 registry 插件字段，插件不再写入独立 server 配置。
  const plugins = installedPlugins(options.source, options.plugin)
  return applyEdits(options.source, modify(options.source, ["plugin"], plugins, {
    formattingOptions: options.formattingOptions,
  }))
}

function installedPlugins(source: string, plugin: string): string[] {
  // 移除旧托管入口后只保留当前 registry 包规格。
  const plugins = asRecord(parse(source))?.plugin
  const current = Array.isArray(plugins) ? plugins.filter((item): item is string => {
    return typeof item === "string" && !isOwnedPluginSpec(item)
  }) : []
  return [...current, plugin]
}

function withTrailingEOL(value: string, eol: "\r\n" | "\n"): string {
  // 统一文件结尾换行，避免无意义的跨平台配置差异。
  return value.endsWith(eol) ? value : `${value}${eol}`
}

function patchApprovalPermissions(options: ApprovalPatchOptions): string {
  // 让全局规则及用户已声明 agent 都产生可转发的 bash 审批。
  let output = patchPermissionValue({
    source: options.source,
    value: options.config?.permission,
    path: ["permission"],
    formattingOptions: options.formattingOptions,
  })
  for (const [name, agent] of agentEntries(options.config?.agent, options.agentNames)) {
    output = patchPermissionValue({
      source: output,
      value: agent.permission,
      path: ["agent", name, "permission"],
      formattingOptions: options.formattingOptions,
    })
  }
  return output
}

function patchPermissionValue(options: PermissionPatchOptions): string {
  // 仅替换权限对象，避免覆盖 agent 的模型、提示词或工具设置。
  const permission = approvalPermissionValue(options.value)
  const edits = modify(options.source, options.path, permission, {
    formattingOptions: options.formattingOptions,
  })
  return applyEdits(options.source, edits)
}

function approvalPermissionValue(value: unknown): JSONRecord {
  // 将简写规则规范为对象，并让 bash 规则排在通配规则之后。
  const record = asRecord(value)
  if (!record) return { [PermissionKey.Bash]: PermissionAction.Ask }
  const { [PermissionKey.All]: wildcard, [PermissionKey.Bash]: bash, ...specific } = record
  return {
    ...(typeof wildcard === "string" ? { [PermissionKey.All]: wildcard } : {}),
    ...specific,
    [PermissionKey.Bash]: approvalBashRule(bash),
  }
}

function approvalBashRule(value: unknown): unknown {
  // 通配 ask 必须先于具体命令例外，才能保留其原有优先级。
  if (value === PermissionAction.Deny) return value
  const rules = asRecord(value)
  if (!rules) return PermissionAction.Ask
  if (rules[PermissionKey.All] === PermissionAction.Deny) return rules
  const { [PermissionKey.All]: ignored, ...specific } = rules
  return { [PermissionKey.All]: PermissionAction.Ask, ...specific }
}

function agentEntries(value: unknown, agentNames: string[]): Array<[string, JSONRecord]> {
  // 合并已声明与已解析的 agent，确保外部 agent 不会覆盖全局 ask。
  const configured = configuredAgentEntries(value)
  for (const name of agentNames) addMissingAgent(configured, name)
  return [...configured.entries()]
}

function configuredAgentEntries(value: unknown): Map<string, JSONRecord> {
  // 忽略异常 agent 配置，避免安装器破坏未知格式的用户字段。
  return new Map(Object.entries(asRecord(value) ?? {}).flatMap(([name, agent]) => {
    const record = asRecord(agent)
    return record ? [[name, record]] : []
  }))
}

function addMissingAgent(agents: Map<string, JSONRecord>, name: string): void {
  // 仅添加合法且未声明的名称，保留用户已有 agent 内容。
  if (name.trim() && !agents.has(name)) agents.set(name, {})
}

function asRecord(value: unknown): JSONRecord | null {
  // 仅接受普通对象，数组和 null 不可作为 JSONC 配置节点。
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JSONRecord
    : null
}

export function isOwnedPluginSpec(spec: string): boolean {
  if (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`)) return true
  if (spec === LEGACY_PACKAGE_NAME || spec.startsWith(`${LEGACY_PACKAGE_NAME}@`)) return true
  if (!spec.startsWith("file:")) return false
  try {
    const pathname = decodeURIComponent(new URL(spec).pathname).replaceAll("\\", "/")
    return pathname.endsWith(`/${LEGACY_PACKAGE_NAME}/dist/index.js`)
  } catch {
    return false
  }
}

export async function install(options: InstallOptions): Promise<void> {
  options.store.migrateLegacyState()
  const model = options.configuredModel
  if (!model || !options.availableModels.includes(model)) {
    throw new Error(`模型不可用: ${model || "未配置"}`)
  }
  if (!(await options.confirmModel(model))) throw new Error("用户未确认默认模型")

  const source = fs.existsSync(options.configFile) ? fs.readFileSync(options.configFile, "utf8") : "{}\n"
  const updated = patchOpenCodeConfig(source, {
    plugin: options.pluginName ?? PACKAGE_NAME,
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4096,
    agentNames: options.agentNames,
  })

  const previousContext = options.store.loadContext()
  const forceBinding =
    !options.store.loadAccount() ||
    !previousContext ||
    previousContext.updatedAt <= 0
  await options.bind(forceBinding)
  const currentContext = options.store.loadContext()
  if (
    !options.store.loadAccount() ||
    !currentContext ||
    currentContext.updatedAt <= 0
  ) {
    throw new Error("未收到绑定消息（请发送“绑定”），无法完成微信绑定")
  }
  if (!(await options.sendTest())) throw new Error("微信测试通知发送失败")

  const pluginConfigFile = path.join(options.store.getDirectory(), "config.json")
  const previousPluginConfig = fs.existsSync(pluginConfigFile)
    ? fs.readFileSync(pluginConfigFile, "utf8")
    : null
  const configExisted = fs.existsSync(options.configFile)
  let pluginCommit: PluginCommit | null = null
  try {
    pluginCommit = options.commitPlugin?.() ?? null
    atomicWriteText(options.configFile, updated)
    options.store.savePluginConfig(
      loadPluginConfig({
        model,
        server: {
          hostname: options.hostname ?? "127.0.0.1",
          port: options.port ?? 4096,
        },
      }),
    )
    pluginCommit?.finalize()
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try {
      restoreText(options.configFile, configExisted ? source : null)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    try {
      restoreText(pluginConfigFile, previousPluginConfig)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    try {
      pluginCommit?.rollback()
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "安装失败且回滚不完整，请运行 wechat-approve doctor",
      )
    }
    throw error
  }
}

function atomicWriteText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const descriptor = fs.openSync(temporary, "w")
  try {
    fs.writeFileSync(descriptor, value, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
}

function restoreText(file: string, value: string | null): void {
  if (value === null) {
    fs.rmSync(file, { force: true })
  } else {
    atomicWriteText(file, value)
  }
}

function detectEOL(value: string): "\r\n" | "\n" {
  return value.includes("\r\n") ? "\r\n" : "\n"
}
