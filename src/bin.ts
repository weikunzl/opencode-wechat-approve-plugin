#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import spawn from "cross-spawn"
import { parse } from "jsonc-parser"
import qrcode from "qrcode-terminal"
import {
  doctorInstallation,
  parseOpenCodePaths,
  resolveApprovalAgentNames,
  resolveEffectiveModel,
} from "./cli.js"
import { IlinkClientTransport } from "./client.js"
import {
  install,
  PACKAGE_NAME,
  registryPluginSpec,
} from "./install.js"
import { WeChatStore } from "./store.js"
import { WeChatGateway } from "./wechat-gateway.js"

async function main(args: string[]): Promise<number> {
  const command = args[0] ?? "help"
  if (!["install", "bind", "doctor", "help", "--help", "-h"].includes(command)) {
    throw new Error(`未知命令: ${command}`)
  }
  if (["help", "--help", "-h"].includes(command)) {
    printHelp()
    return 0
  }

  const paths = parseOpenCodePaths(await runOpenCode(["debug", "paths"]))
  if (!paths.config || !paths.state) throw new Error("无法解析 OpenCode 配置和状态目录")
  const configDirectory = paths.config
  const configFile = findConfigFile(configDirectory)
  const stateDirectory = path.join(paths.home || path.dirname(paths.config), ".opencode", "wechat-approve")
  const availableModels = lines(await runOpenCode(["models"]))

  if (command === "doctor") {
    const result = await doctorInstallation({
      configFile,
      stateDirectory,
      availableModels,
    })
    for (const [name, check] of Object.entries(result)) {
      process.stdout.write(`${check.ok ? "OK" : "FAIL"} ${name}: ${check.detail}\n`)
    }
    return Object.values(result).every((check) => check.ok) ? 0 : 1
  }

  const store = new WeChatStore(stateDirectory)
  const gateway = new WeChatGateway(store, new IlinkClientTransport(store))
  if (command === "bind") {
    await bind(gateway, true)
    await sendTest(gateway)
    process.stdout.write("微信绑定及测试通知成功。\n")
    return 0
  }

  const resolvedConfig = parse(await runOpenCode(["debug", "config"]))
  const approvalAgentNames = resolveApprovalAgentNames(resolvedConfig)
  const modelState = readJSON(path.join(paths.state, "model.json"))
  const proposed = resolveEffectiveModel(resolvedConfig, modelState)
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const pluginSpec = registryPluginSpec(packageRoot)
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const configuredModel =
      proposed ??
      (await terminal.question("未检测到默认模型，请输入 provider/model: ")).trim()
    await install({
      configFile,
      store,
      availableModels,
      configuredModel,
      confirmModel: async (model) => {
        const answer = (await terminal.question(`审批解释模型为 ${model}，确认？[Y/n] `))
          .trim()
          .toLowerCase()
        return answer === "" || answer === "y" || answer === "yes" || answer === "是"
      },
      bind: async (force) => bind(gateway, force),
      sendTest: async () => sendTest(gateway),
      pluginName: pluginSpec,
      agentNames: approvalAgentNames,
    })
  } finally {
    terminal.close()
  }
  process.stdout.write(`安装完成。插件 ${PACKAGE_NAME} 已写入全局配置。\n`)
  process.stdout.write("请分别启动 OpenCode 会话；插件会自动共享绑定并选举微信网关 Leader。\n")
  return 0
}

async function bind(gateway: WeChatGateway, force = false): Promise<void> {
  if (!force && (await gateway.initialize()) === "ready") return
  process.stdout.write("请使用微信扫码并确认，然后向机器人发送“绑定”。\n")
  await gateway.bind((value) => {
    qrcode.generate(value, { small: true }, (rendered) => process.stdout.write(`${rendered}\n`))
  }, force)
}

async function sendTest(gateway: WeChatGateway): Promise<boolean> {
  await gateway.send({
    id: `install-test:${Date.now()}`,
    kind: "done",
    text: "🎉 [OpenCode 验证] 微信授权插件已绑定",
    createdAt: Date.now(),
  })
  return true
}

function runOpenCode(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`opencode ${args.join(" ")} 失败: ${firstLine(stderr)}`))
    })
  })
}

function findConfigFile(directory: string): string {
  const jsonc = path.join(directory, "opencode.jsonc")
  if (fs.existsSync(jsonc)) return jsonc
  const json = path.join(directory, "opencode.json")
  return fs.existsSync(json) ? json : jsonc
}

function readJSON(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] || "unknown error"
}

function printHelp(): void {
  process.stdout.write(
    [
      "wechat-approve install   配置插件、确认模型并扫码绑定",
      "wechat-approve bind      重新扫码或补充绑定消息",
      "wechat-approve doctor    检查插件、模型、绑定和共享运行时",
      "",
    ].join("\n"),
  )
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`wechat-approve: ${firstLine(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  })
