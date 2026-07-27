import { spawn } from "node:child_process"
import { createInterface } from "node:readline/promises"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { WeChatStore } from "../dist/store.js"

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))
const NODE_EXECUTABLE = process.execPath
const NPM_EXECUTABLE = process.platform === "win32" ? "npm.cmd" : "npm"
const LIVE_CONFIRMATION = "LIVE"
const TARGET_TITLE = "微信ClawBot"
const SCENARIOS = ["E2E-05", "E2E-06", "E2E-07"]

function ask(reader, question) {
  // 任何真实读写前都要求操作者确认目标会话标题。
  return reader.question(`${question} `)
}

function runInteractive(command, args) {
  // 绑定命令必须继承终端，才能显示二维码并接收用户确认。
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false" },
      stdio: "inherit",
      windowsHide: false,
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} 退出码 ${code ?? "unknown"}`))
    })
  })
}

function assertSafe(value, label) {
  // 记录只允许短文本和 request ID，拒绝凭据、二维码和 token 片段。
  if (value.length > 500 || /token|bearer|qrcode|二维码/i.test(value)) {
    throw new Error(`${label} 可能包含凭据或长度超限，已停止记录`)
  }
}

async function collectScenario(reader, scenario, scanTime) {
  // 每个场景都重新确认标题，并只在内存中保留脱敏验收摘要。
  const title = await ask(reader, `${scenario} 开始前输入可见会话标题（必须为 ${TARGET_TITLE}）：`)
  if (title.trim() !== TARGET_TITLE) throw new Error(`${scenario} 会话标题不匹配，已停止`)
  const observedText = (await ask(reader, `${scenario} 输入观察到的微信文本摘要（不得输入 token）：`)).trim()
  const requestID = (await ask(reader, `${scenario} 输入 request ID（可留空，不得输入 token）：`)).trim()
  assertSafe(observedText, `${scenario} 微信文本`)
  assertSafe(requestID, `${scenario} request ID`)
  if (requestID && /[^\w.:-]/.test(requestID)) {
    throw new Error(`${scenario} request ID 含不安全字符，已停止记录`)
  }
  return { scanTime, scenario, observedText, requestID }
}

async function main() {
  // 默认 smoke 不触发扫码；只有显式 live 命令才会强制重新绑定。
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("live E2E 需要交互式终端")
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const confirmation = (await ask(reader, "将强制扫码并写入当前绑定，输入 LIVE 继续：")).trim()
    if (confirmation !== LIVE_CONFIRMATION) throw new Error("未确认 live E2E，未执行扫码")
    const previousUpdatedAt = new WeChatStore().loadContext()?.updatedAt ?? 0
    await runInteractive(NPM_EXECUTABLE, ["run", "build"])
    await runInteractive(NODE_EXECUTABLE, ["dist/bin.js", "bind"])
    const context = new WeChatStore().loadContext()
    if (!context || context.updatedAt <= previousUpdatedAt) throw new Error("未收到新的绑定 context，停止 live E2E")
    const scanTime = (await ask(reader, "请输入本次扫码确认时间（ISO 时间，不得输入 token）：")).trim()
    assertSafe(scanTime, "扫码时间")
    const records = []
    for (const scenario of SCENARIOS) records.push(await collectScenario(reader, scenario, scanTime))
    process.stdout.write(`live E2E 记录（未写入文件）：${JSON.stringify(records)}\n`)
  } finally {
    reader.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
