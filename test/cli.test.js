import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  doctorInstallation,
  parseOpenCodePaths,
  resolveApprovalAgentNames,
  resolveEffectiveModel,
} from "../dist/cli.js"
import {
  TransportFailureKind,
  TransportHealthStatus,
  defaultTransportHealth,
} from "../dist/transport-health.js"
import { WeChatStore } from "../dist/store.js"

test("parses OpenCode paths containing Windows drive letters and spaces", () => {
  const paths = parseOpenCodePaths(
    [
      "home       C:\\Users\\Jane Doe",
      "config     C:\\Users\\Jane Doe\\AppData\\Roaming\\opencode",
      "state      C:\\Users\\Jane Doe\\AppData\\Local\\opencode",
    ].join("\r\n"),
  )

  assert.deepEqual(paths, {
    home: "C:\\Users\\Jane Doe",
    config: "C:\\Users\\Jane Doe\\AppData\\Roaming\\opencode",
    state: "C:\\Users\\Jane Doe\\AppData\\Local\\opencode",
  })
})

test("resolves the configured model before the most recently used model", () => {
  assert.equal(
    resolveEffectiveModel(
      { model: "anthropic/claude-opus-4-7" },
      { recent: [{ providerID: "opencode-go", modelID: "qwen3.7-max" }] },
    ),
    "anthropic/claude-opus-4-7",
  )
  assert.equal(
    resolveEffectiveModel({}, { recent: [{ providerID: "opencode-go", modelID: "qwen3.7-max" }] }),
    "opencode-go/qwen3.7-max",
  )
})

test("selects resolved primary agents for approval overrides", () => {
  // 只覆盖会承接用户任务的 agent，避免修改子 agent 的独立授权边界。
  const names = resolveApprovalAgentNames({
    agent: {
      build: { mode: "primary" },
      general: { mode: "all" },
      helper: { mode: "subagent" },
      invalid: null,
    },
  })

  assert.deepEqual(names, ["build", "general"])
})

test("doctor reports plugin binding model and native shared runtime independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-doctor-"))
  const configFile = join(root, "opencode.jsonc")
  const stateDirectory = join(root, "wechat-approve")
  mkdirSync(stateDirectory)
  writeFileSync(
    configFile,
    `{
      "plugin": ["opencode-wechat-approve-plugin"],
      "server": { "hostname": "127.0.0.1", "port": 4096 }
    }`,
  )
  writeFileSync(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      model: "opencode-go/qwen3.7-max",
      server: { hostname: "127.0.0.1", port: 4096 },
      approvalTimeoutMs: 600000,
      modelConfidenceThreshold: 0.85,
    }),
  )
  writeFileSync(join(stateDirectory, "account.json"), '{"token":"x","baseUrl":"https://example","accountId":"bot"}')
  writeFileSync(
    join(stateDirectory, "context-v1.json"),
    '{"boundUserID":"owner","contextToken":"x","updatedAt":1}',
  )

  const result = await doctorInstallation({
    configFile,
    stateDirectory,
    availableModels: ["opencode-go/qwen3.7-max"],
    authorization: "Basic protected",
    fetcher: async (_input, init = {}) => {
      assert.equal(new Headers(init.headers).get("authorization"), "Basic protected")
      return new Response('{"healthy":true,"version":"1.18.2"}', { status: 200 })
    },
  })

  assert.deepEqual(result, {
    plugin: { ok: true, detail: "configured" },
    binding: { ok: true, detail: "bound" },
    model: { ok: true, detail: "opencode-go/qwen3.7-max" },
    transport: { ok: false, detail: "unknown: no successful transport probe" },
    sharedState: { ok: true, detail: "shared state directory ready" },
    instances: { ok: true, detail: "0 active instance(s)" },
    leader: { ok: true, detail: "not elected" },
  })
})

test("doctor distinguishes healthy transport from a persisted binding", async () => {
  const state = doctorFixture()
  const store = new WeChatStore(state.stateDirectory)
  store.saveTransportHealth({
    ...defaultTransportHealth(),
    status: TransportHealthStatus.Healthy,
    lastSuccessAt: 1_000,
    cleanShutdown: false,
  })

  const result = await doctorInstallation(state.options)

  assert.equal(result.binding.ok, true)
  assert.equal(result.transport.ok, true)
  assert.match(result.transport.detail, /healthy.*1970-01-01T00:00:01.000Z/)
})

test("doctor requires bind after an expired WeChat session", async () => {
  const state = doctorFixture()
  const store = new WeChatStore(state.stateDirectory)
  store.saveTransportHealth({
    ...defaultTransportHealth(),
    status: TransportHealthStatus.NeedsRebind,
    lastFailureKind: TransportFailureKind.SessionExpired,
    cleanShutdown: false,
  })

  const result = await doctorInstallation(state.options)

  assert.equal(result.binding.ok, true)
  assert.equal(result.transport.ok, false)
  assert.match(result.transport.detail, /needs rebind.*wechat-approve bind/)
})

function doctorFixture() {
  const root = mkdtempSync(join(tmpdir(), "wechat-doctor-health-"))
  const configFile = join(root, "opencode.jsonc")
  const stateDirectory = join(root, "wechat-approve")
  mkdirSync(stateDirectory)
  writeFileSync(configFile, '{"plugin":["@wekux/opencode-wechat-approve-plugin@latest"]}')
  writeFileSync(
    join(stateDirectory, "config.json"),
    JSON.stringify({ model: "opencode-go/qwen3.7-max" }),
  )
  writeFileSync(
    join(stateDirectory, "account.json"),
    '{"token":"x","baseUrl":"https://example","accountId":"bot"}',
  )
  writeFileSync(
    join(stateDirectory, "context-v1.json"),
    '{"boundUserID":"owner","contextToken":"x","updatedAt":1}',
  )
  return {
    stateDirectory,
    options: {
      configFile,
      stateDirectory,
      availableModels: ["opencode-go/qwen3.7-max"],
    },
  }
}
