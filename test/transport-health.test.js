import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { WeChatStore } from "../dist/store.js"
import {
  TransportFailureKind,
  TransportHealthStatus,
  bindingGenerationDigest,
  defaultTransportHealth,
} from "../dist/transport-health.js"

test("defaults transport health to a stopped clean state", () => {
  assert.deepEqual(defaultTransportHealth(), {
    schemaVersion: 1,
    status: TransportHealthStatus.Stopped,
    lastProbeAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
    cleanShutdown: true,
    bindingGenerationDigest: null,
  })
})

test("persists validated transport health with owner-only permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-health-store-"))
  const store = new WeChatStore(root)
  const state = {
    ...defaultTransportHealth(),
    status: TransportHealthStatus.Degraded,
    lastFailureAt: 20,
    lastFailureKind: TransportFailureKind.Network,
    consecutiveFailures: 2,
    cleanShutdown: false,
  }

  store.saveTransportHealth(state)

  assert.deepEqual(store.loadTransportHealth(), state)
  assert.equal(statSync(join(root, "transport-health-v1.json")).mode & 0o777, 0o600)
})

test("quarantines corrupt transport health and returns the safe default", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-health-corrupt-"))
  writeFileSync(join(root, "transport-health-v1.json"), "{bad")
  const store = new WeChatStore(root)

  assert.deepEqual(store.loadTransportHealth(), defaultTransportHealth())
  assert.equal(
    readdirSync(root).some((name) => name.startsWith("transport-health-v1.json.corrupt-")),
    true,
  )
})

test("binding generation digest never contains account or context values", () => {
  const digest = bindingGenerationDigest({
    accountID: "bot-secret",
    baseUrl: "https://ilink.example/secret",
    contextToken: "context-secret",
    contextUpdatedAt: 30,
  })

  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(digest, /bot-secret|ilink|context-secret/)
})

test("quarantines unsafe transport health numbers and digests", () => {
  const invalidStates = [
    { ...defaultTransportHealth(), lastSuccessAt: Number.MAX_VALUE },
    { ...defaultTransportHealth(), consecutiveFailures: -1 },
    { ...defaultTransportHealth(), consecutiveFailures: 1.5 },
    { ...defaultTransportHealth(), bindingGenerationDigest: "not-a-digest" },
  ]

  for (const state of invalidStates) {
    const root = mkdtempSync(join(tmpdir(), "wechat-health-invalid-"))
    writeFileSync(join(root, "transport-health-v1.json"), JSON.stringify(state))
    assert.deepEqual(new WeChatStore(root).loadTransportHealth(), defaultTransportHealth())
  }
})
