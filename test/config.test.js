import assert from "node:assert/strict"
import test from "node:test"

import { loadPluginConfig } from "../dist/config.js"

test("uses safe V1 defaults", () => {
  assert.deepEqual(loadPluginConfig({}), {
    model: null,
    approvalTimeoutMs: 600_000,
    modelConfidenceThreshold: 0.85,
  })
})

test("accepts an explicit approval model and bounded thresholds", () => {
  assert.deepEqual(
    loadPluginConfig({
      model: "opencode-go/qwen3.7-max",
      approvalTimeoutMs: 120_000,
      modelConfidenceThreshold: 0.9,
    }),
    {
      model: "opencode-go/qwen3.7-max",
      approvalTimeoutMs: 120_000,
      modelConfidenceThreshold: 0.9,
    },
  )
})

test("ignores legacy server settings because plugin runs in native OpenCode lifecycle", () => {
  const config = loadPluginConfig({ server: { hostname: "127.0.0.1", port: 4096 } })

  assert.equal("server" in config, false)
})
