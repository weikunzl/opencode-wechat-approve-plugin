import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { install, patchOpenCodeConfig, stageLocalPlugin } from "../dist/install.js"
import { WeChatStore } from "../dist/store.js"

test("preserves JSONC comments and unrelated settings while installing idempotently", () => {
  const source = `{
  // keep this formatter
  "formatter": { "prettier": {} },
  "plugin": ["existing-plugin"],
  "server": { "hostname": "127.0.0.1", "port": 9000 }
}\n`

  const once = patchOpenCodeConfig(source, {
    plugin: "opencode-wechat-approve-plugin",
    hostname: "127.0.0.1",
    port: 4096,
  })
  const twice = patchOpenCodeConfig(once, {
    plugin: "opencode-wechat-approve-plugin",
    hostname: "127.0.0.1",
    port: 4096,
  })

  assert.match(twice, /keep this formatter/)
  assert.match(twice, /"formatter": \{ "prettier": \{\} \}/)
  assert.equal((twice.match(/opencode-wechat-approve-plugin/g) ?? []).length, 1)
  assert.match(twice, /"port": 4096/)
})

test("replaces every previously managed plugin alias with one entry", () => {
  const source = JSON.stringify({
    plugin: [
      "existing-plugin",
      "opencode-wechat-approve-plugin",
      "opencode-wechat-approve-plugin@0.9.0",
      "file:///Users/test/.config/opencode/plugins/opencode-wechat-approve-plugin/dist/index.js",
    ],
  })
  const managed =
    "file:///Users/test/.config/opencode/managed-plugins/opencode-wechat-approve-plugin/dist/index.js"

  const patched = JSON.parse(
    patchOpenCodeConfig(source, {
      plugin: managed,
      hostname: "127.0.0.1",
      port: 4096,
    }),
  )

  assert.deepEqual(patched.plugin, ["existing-plugin", managed])
})

test("persists the confirmed model and finishes only after binding and test delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-installer-"))
  const configFile = join(root, "opencode.jsonc")
  writeFileSync(configFile, '{ "plugin": ["existing"] }\n')
  const store = new WeChatStore(join(root, "state"))
  const calls = []

  await install({
    configFile,
    store,
    availableModels: ["opencode-go/qwen3.7-max"],
    configuredModel: "opencode-go/qwen3.7-max",
    confirmModel: async (model) => {
      calls.push(["confirm", model])
      return true
    },
    bind: async () => {
      calls.push(["bind"])
      store.saveAccount({
        token: "secret",
        baseUrl: "https://example.invalid",
        accountId: "bot",
        userId: "owner",
        savedAt: "2026-07-27T00:00:00.000Z",
      })
      store.saveContext({
        boundUserID: "owner",
        contextToken: "context",
        updatedAt: 1,
      })
    },
    sendTest: async () => {
      calls.push(["send-test"])
      return true
    },
  })

  assert.deepEqual(calls, [
    ["confirm", "opencode-go/qwen3.7-max"],
    ["bind"],
    ["send-test"],
  ])
  assert.equal(store.loadPluginConfig().model, "opencode-go/qwen3.7-max")
  assert.match(readFileSync(configFile, "utf8"), /opencode-wechat-approve-plugin/)
})

test("rejects unavailable models and incomplete binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-installer-invalid-"))
  const configFile = join(root, "opencode.json")
  writeFileSync(configFile, "{}\n")
  const store = new WeChatStore(join(root, "state"))

  await assert.rejects(
    install({
      configFile,
      store,
      availableModels: ["anthropic/claude-opus-4-7"],
      configuredModel: "opencode/claude-opus-4-7",
      confirmModel: async () => true,
      bind: async () => {},
      sendTest: async () => true,
    }),
    /模型不可用/,
  )

  await assert.rejects(
    install({
      configFile,
      store,
      availableModels: ["anthropic/claude-opus-4-7"],
      configuredModel: "anthropic/claude-opus-4-7",
      confirmModel: async () => true,
      bind: async () => {},
      sendTest: async () => true,
    }),
    /绑定消息/,
  )
})

test("migrates a legacy binding before doctor checks the installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-installer-migration-"))
  const stateDirectory = join(root, "state")
  const configFile = join(root, "opencode.jsonc")
  writeFileSync(configFile, "{}\n")
  const store = new WeChatStore(stateDirectory)
  store.saveAccount({
    token: "secret",
    baseUrl: "https://example.invalid",
    accountId: "bot",
    userId: "owner",
    savedAt: "2026-07-27T00:00:00.000Z",
  })
  writeFileSync(join(stateDirectory, "context.json"), '{"owner":"legacy-context"}')
  const reloaded = new WeChatStore(stateDirectory)
  const bindForces = []

  await install({
    configFile,
    store: reloaded,
    availableModels: ["opencode-go/qwen3.7-max"],
    configuredModel: "opencode-go/qwen3.7-max",
    confirmModel: async () => true,
    bind: async (force) => {
      bindForces.push(force)
      reloaded.saveContext({
        boundUserID: "owner",
        contextToken: "fresh-context",
        updatedAt: 100,
      })
    },
    sendTest: async () => true,
  })

  assert.deepEqual(bindForces, [true])
  assert.equal(JSON.parse(readFileSync(join(stateDirectory, "context-v1.json"))).boundUserID, "owner")
  assert.equal(JSON.parse(readFileSync(join(stateDirectory, "context-v1.json"))).updatedAt, 100)
})

test("reuses a recently refreshed binding without forcing a new QR login", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-installer-fresh-binding-"))
  const configFile = join(root, "opencode.jsonc")
  writeFileSync(configFile, "{}\n")
  const store = new WeChatStore(join(root, "state"))
  store.saveAccount({
    token: "secret",
    baseUrl: "https://example.invalid",
    accountId: "bot",
    userId: "owner",
    savedAt: "2026-07-27T00:00:00.000Z",
  })
  store.saveContext({
    boundUserID: "owner",
    contextToken: "fresh-context",
    updatedAt: 100,
  })
  const bindForces = []

  await install({
    configFile,
    store,
    availableModels: ["opencode-go/qwen3.7-max"],
    configuredModel: "opencode-go/qwen3.7-max",
    confirmModel: async () => true,
    bind: async (force) => bindForces.push(force),
    sendTest: async () => true,
  })

  assert.deepEqual(bindForces, [false])
})

test("stages a self-contained global plugin entry from a GitHub installation", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-local-plugin-"))
  const sourceRoot = join(root, "source")
  const configDirectory = join(root, "OpenCode Config With Spaces")
  mkdirSync(join(sourceRoot, "dist"), { recursive: true })
  writeFileSync(join(sourceRoot, "dist", "index.js"), "export default async () => ({})\n")
  writeFileSync(
    join(sourceRoot, "package.json"),
    JSON.stringify({ name: "opencode-wechat-approve-plugin", type: "module", main: "dist/index.js" }),
  )

  const spec = stageLocalPlugin(sourceRoot, configDirectory)

  assert.match(spec, /^file:/)
  assert.equal(
    readFileSync(
      join(configDirectory, "managed-plugins", "opencode-wechat-approve-plugin", "dist", "index.js"),
      "utf8",
    ),
    "export default async () => ({})\n",
  )
  assert.equal(
    fileURLToPath(spec),
    join(configDirectory, "managed-plugins", "opencode-wechat-approve-plugin", "dist", "index.js"),
  )
})
