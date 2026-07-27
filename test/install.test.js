import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { install, patchOpenCodeConfig } from "../dist/install.js"
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
