import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  doctorInstallation,
  parseOpenCodePaths,
  readCurrentRebindLink,
  resolveApprovalAgentNames,
  resolveEffectiveModel,
} from "../dist/cli.js"
import { RebindPageStore } from "../dist/rebind-page.js"
import { RebindSchemaVersion, RebindStatus } from "../dist/rebind-state.js"
import { PluginInstanceRegistry } from "../dist/plugin-instance.js"
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

test("doctor does not report a stale healthy state without a live runtime", async () => {
  const state = doctorFixture({ registerInstance: false, now: 4_000_000 })
  const store = new WeChatStore(state.stateDirectory)
  store.saveTransportHealth({
    ...defaultTransportHealth(),
    status: TransportHealthStatus.Healthy,
    lastSuccessAt: 1_000,
    cleanShutdown: false,
  })

  const result = await doctorInstallation(state.options)

  assert.equal(result.transport.ok, false)
  assert.match(result.transport.detail, /stale.*no active gateway leader/)
})

test("doctor rejects a stale gateway lease even when an instance remains active", async () => {
  const state = doctorFixture({ now: 100_000, leaderHeartbeatAt: 1 })
  const store = new WeChatStore(state.stateDirectory)
  store.saveTransportHealth({
    ...defaultTransportHealth(),
    status: TransportHealthStatus.Healthy,
    lastSuccessAt: 99_000,
    cleanShutdown: false,
  })

  const result = await doctorInstallation(state.options)

  assert.equal(result.leader.ok, false)
  assert.match(result.leader.detail, /stale leader lease/)
  assert.match(result.transport.detail, /stale.*no active gateway leader/)
})

test("doctor rejects a nonpositive gateway leader pid", async () => {
  const state = doctorFixture({ leaderPID: 0 })
  const store = new WeChatStore(state.stateDirectory)
  store.saveTransportHealth({
    ...defaultTransportHealth(),
    status: TransportHealthStatus.Healthy,
    lastSuccessAt: 1_000,
  })

  const result = await doctorInstallation(state.options)

  assert.equal(result.leader.ok, false)
  assert.match(result.leader.detail, /invalid leader lease/)
  assert.match(result.transport.detail, /no active gateway leader/)
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
  assert.match(result.transport.detail, /wechat-approve rebind-link/)
  assert.match(result.transport.detail, /needs rebind.*wechat-approve bind/)
})

test("reads only the current unexpired browser rebind link", async () => {
  // CLI 读取受控描述符，不打印二维码原文或绑定凭据。
  const root = mkdtempSync(join(tmpdir(), "wechat-cli-rebind-link-"))
  const store = new WeChatStore(root)
  const pages = new RebindPageStore({
    directory: root,
    now: () => 1_000,
    randomID: () => "0123456789abcdef0123456789abcdef",
    renderQRCode: async () => "<svg></svg>",
  })
  const page = await pages.create({ qrContent: "qr-secret", expiresAt: 61_000 })
  store.saveRebindState({
    schemaVersion: RebindSchemaVersion.V1,
    status: RebindStatus.QrReady,
    startedAt: 1_000,
    expiresAt: 61_000,
    pageFileName: page.fileName,
    bindingGenerationDigest: "a".repeat(64),
  })

  const current = readCurrentRebindLink(store, () => 2_000)

  assert.equal(current?.url, page.url)
  assert.equal(current?.expiresAt, 61_000)
  assert.doesNotMatch(JSON.stringify(current), /qr-secret|token|owner/)
  assert.equal(readCurrentRebindLink(store, () => 62_000), null)
})

test("doctor reports redacted degraded transport recovery details", async () => {
  const state = doctorFixture()
  const store = new WeChatStore(state.stateDirectory)
  store.enqueueNotification({
    id: "health-test",
    kind: "warning",
    text: "redacted",
    createdAt: 1_000,
  })
  store.saveTransportHealth({
    ...defaultTransportHealth(),
    status: TransportHealthStatus.Degraded,
    lastFailureKind: TransportFailureKind.Network,
    nextRetryAt: 2_000,
    cleanShutdown: false,
  })

  const result = await doctorInstallation(state.options)

  assert.equal(result.transport.ok, false)
  assert.equal(
    result.transport.detail,
    "degraded failure=network outbox=1 nextRetryAt=1970-01-01T00:00:02.000Z",
  )
})

function doctorFixture(options = {}) {
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
  if (options.registerInstance !== false) {
    new PluginInstanceRegistry(stateDirectory).register({
      projectDirectory: root,
      sessionIDs: [],
    })
  }
  if (options.registerInstance !== false) {
    writeFileSync(
      join(stateDirectory, "runtime-lease.json"),
      JSON.stringify({
        instanceID: "leader",
        pid: options.leaderPID ?? process.pid,
        heartbeatAt: options.leaderHeartbeatAt ?? options.now ?? 2_000,
      }),
    )
  }
  return {
    stateDirectory,
    options: {
      configFile,
      stateDirectory,
      availableModels: ["opencode-go/qwen3.7-max"],
      now: () => options.now ?? 2_000,
    },
  }
}
