import process from "node:process"

import { ProvenanceKind, createProvenance, createStatusSnapshot } from "../dist/live-evidence.js"
import { WeChatStore } from "../dist/store.js"

const SCENARIO_IDS = Array.from({ length: 19 }, (_, index) => `REAL-${String(index).padStart(2, "0")}`)
const DEFAULT_SERVER_URL = "http://127.0.0.1:4096"
const MIN_INTERVAL_MS = 1_000
const DEFAULT_PROVENANCE = ProvenanceKind.LocalDist
const DEFAULT_VERSION = "unknown"
const DEFAULT_ENTRYPOINT = "local-dist"

function parseInterval(argv) {
  // 默认只扫描一轮，显式 interval 才保持周期运行。
  const value = argv.find((item) => item.startsWith("--interval="))?.split("=", 2)[1]
  if (value === undefined) return 0
  const interval = Number(value)
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) {
    throw new Error(`--interval 必须是不小于 ${MIN_INTERVAL_MS} 的整数毫秒`)
  }
  return interval
}

function readLocalState() {
  // 只输出计数和上下文年龄，严禁读取或打印 token、游标和用户标识。
  const store = new WeChatStore()
  const context = store.loadContext()
  const pending = store.loadPendingApprovals()
  const state = {
    pending,
    outboxCount: store.loadOutbox().length,
    context: context ? "bound" : "unavailable",
    contextAgeMs: context ? Math.max(0, Date.now() - context.updatedAt) : null,
  }
  return state
}

async function readServerState() {
  // OpenCode 只读取 permission 数量；不可访问时保留可审计的错误类别。
  const url = process.env.OPENCODE_URL ?? DEFAULT_SERVER_URL
  try {
    const response = await fetch(new URL("/permission", url), {
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return { status: `http-${response.status}`, pending: null, requestIDs: [] }
    const value = await response.json()
    const pending = Array.isArray(value) ? value : []
    return { status: "ok", pending: Array.isArray(value) ? pending.length : null, requestIDs: readRequestIDs(pending) }
  } catch (error) {
    return { status: error instanceof Error ? error.name : "unavailable", pending: null, requestIDs: [] }
  }
}

function readRequestIDs(pending) {
  // 仅从权威响应读取 request ID，后续由快照模块统一脱敏。
  return pending.map((item) => item?.id ?? item?.requestID).filter((item) => typeof item === "string")
}

function readProvenance() {
  // 显式来源防止本地构建、tarball 与 registry 验收相互替代。
  const kind = process.env.E2E_PROVENANCE_KIND ?? DEFAULT_PROVENANCE
  if (!Object.values(ProvenanceKind).includes(kind)) throw new Error("E2E_PROVENANCE_KIND 无效")
  return createProvenance({
    kind,
    packageVersion: process.env.E2E_PACKAGE_VERSION ?? DEFAULT_VERSION,
    entrypoint: process.env.E2E_ENTRYPOINT ?? DEFAULT_ENTRYPOINT,
  })
}

function printSnapshot(local, server) {
  // 微信屏幕无法由该无副作用扫描器读取，必须人工核对原文后才能标记 live 通过。
  const snapshot = createStatusSnapshot({
    observedAt: new Date().toISOString(),
    provenance: readProvenance(),
    localPending: local.pending,
    serverPending: server.requestIDs,
    outboxCount: local.outboxCount,
  })
  process.stdout.write(`状态扫描 ${JSON.stringify(snapshot)}\n`)
  process.stdout.write(`OpenCode: ${server.status}, pending=${server.pending ?? "?"}\n`)
  process.stdout.write(`本地: context=${local.context}, contextAgeMs=${local.contextAgeMs ?? "?"}\n`)
  process.stdout.write("微信ClawBot: 需要人工确认可见标题、原文、requestID/decision；未观察不得通过\n")
  for (const scenario of SCENARIO_IDS) process.stdout.write(`${scenario}: UNVERIFIED\n`)
}

async function scan() {
  // 单轮扫描不创建 session、审批或微信消息，适合定时任务调用。
  const [local, server] = await Promise.all([readLocalState(), readServerState()])
  printSnapshot(local, server)
}

async function main() {
  // 周期扫描只在显式指定间隔时启动，避免默认命令常驻后台。
  const interval = parseInterval(process.argv.slice(2))
  do {
    await scan()
    if (interval === 0) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  } while (true)
}

main().catch((error) => {
  // 错误消息只保留类别，不回显可能来自环境的敏感内容。
  const detail = error instanceof Error ? error.message : "status scan failed"
  process.stderr.write(`${detail.split(/\r?\n/, 1)[0]}\n`)
  process.exitCode = 1
})
