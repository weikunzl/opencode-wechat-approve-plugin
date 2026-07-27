import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse } from "jsonc-parser"
import { loadPluginConfig } from "./config.js"
import { WeChatStore } from "./store.js"

export const PACKAGE_NAME = "opencode-wechat-approve-plugin"

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
      PACKAGE_NAME,
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
  const target = path.join(managedDirectory, PACKAGE_NAME)
  const temporary = path.join(
    managedDirectory,
    `.${PACKAGE_NAME}.${process.pid}.${Date.now()}.tmp`,
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
      settled = true
      fs.rmSync(target, { recursive: true, force: true })
      if (hadPrevious && fs.existsSync(backup)) fs.renameSync(backup, target)
    },
    finalize(): void {
      if (settled) return
      settled = true
      fs.rmSync(backup, { recursive: true, force: true })
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
}

export function patchOpenCodeConfig(source: string, patch: ConfigPatch): string {
  let output = source.trim() ? source : "{}\n"
  const parsed = parse(output) as { plugin?: unknown } | undefined
  const currentPlugins = Array.isArray(parsed?.plugin)
    ? parsed.plugin
        .filter((item): item is string => typeof item === "string")
        .filter((item) => !isOwnedPluginSpec(item))
    : []
  const plugins = [...currentPlugins, patch.plugin]
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: detectEOL(output) }

  output = applyEdits(output, modify(output, ["plugin"], plugins, { formattingOptions }))
  output = applyEdits(output, modify(output, ["server", "hostname"], patch.hostname, { formattingOptions }))
  output = applyEdits(output, modify(output, ["server", "port"], patch.port, { formattingOptions }))
  return output.endsWith(formattingOptions.eol) ? output : `${output}${formattingOptions.eol}`
}

export function isOwnedPluginSpec(spec: string): boolean {
  if (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`)) return true
  if (!spec.startsWith("file:")) return false
  try {
    const pathname = decodeURIComponent(new URL(spec).pathname).replaceAll("\\", "/")
    return pathname.endsWith(`/${PACKAGE_NAME}/dist/index.js`)
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
    restoreText(options.configFile, configExisted ? source : null)
    restoreText(pluginConfigFile, previousPluginConfig)
    pluginCommit?.rollback()
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
  try {
    if (value === null) {
      fs.rmSync(file, { force: true })
    } else {
      atomicWriteText(file, value)
    }
  } catch {}
}

function detectEOL(value: string): "\r\n" | "\n" {
  return value.includes("\r\n") ? "\r\n" : "\n"
}
