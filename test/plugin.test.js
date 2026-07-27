import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalManager } from "../dist/approval-manager.js"
import { createPluginRuntime } from "../dist/index.js"
import { WeChatStore } from "../dist/store.js"

function createGateway() {
  let receive = async () => {}
  const sent = []
  return {
    sent,
    receive: (text) =>
      receive({
        messageID: `msg-${text}`,
        senderID: "owner@im.wechat",
        text,
        receivedAt: 100,
      }),
    initialize: async () => "ready",
    flushOutbox: async () => {},
    start: (callback) => {
      receive = callback
    },
    send: async (notice) => {
      sent.push(notice)
    },
  }
}

function createHarness() {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-plugin-")))
  const modelCalls = []
  const permissionAPI = {
    list: async () => [],
    reply: async () => true,
  }
  const approvalManager = new ApprovalManager({
    store,
    api: permissionAPI,
    approvalTimeoutMs: 600_000,
    modelConfidenceThreshold: 0.85,
    interpretModel: async (...args) => {
      modelCalls.push(args)
      return { requestIDs: [], decision: "clarify", confidence: 0, explanation: "unused" }
    },
  })
  const gateway = createGateway()
  const sessionNotifier = { handle: async () => [] }
  const runtime = createPluginRuntime({ gateway, approvalManager, sessionNotifier })
  return { runtime, gateway, modelCalls }
}

test("ordinary WeChat text never invokes approval model or emits a notification", async () => {
  const { runtime, gateway, modelCalls } = createHarness()
  await runtime.start()

  await gateway.receive("今天天气怎么样")

  assert.deepEqual(modelCalls, [])
  assert.deepEqual(gateway.sent, [])
})

test("exposes no general-purpose WeChat AI tools or permission interception hook", () => {
  const { runtime } = createHarness()

  assert.equal(runtime.hooks.tool, undefined)
  assert.equal(runtime.hooks["permission.ask"], undefined)
})

test("a secondary plugin instance emits no duplicate notifications", async () => {
  const { runtime, gateway } = createHarness()
  const secondary = createPluginRuntime({
    gateway,
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: {
      handle: async () => [
        { id: "duplicate", kind: "done", text: "duplicate", createdAt: 1 },
      ],
    },
    lease: { acquire: () => false, release: () => {} },
  })

  assert.equal(await secondary.start(), false)
  await secondary.hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses-1" } },
  })

  assert.deepEqual(gateway.sent, [])
  assert.equal(runtime.hooks.tool, undefined)
})

test("periodically rejects expired approvals and stops the timer on disposal", async () => {
  const gateway = createGateway()
  let tick
  let cleared = false
  const runtime = createPluginRuntime({
    gateway,
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
      expire: async () => [
        { id: "expired", kind: "approval-result", text: "expired", createdAt: 1 },
      ],
    },
    sessionNotifier: { handle: async () => [] },
    timers: {
      setInterval: (callback) => {
        tick = callback
        return 7
      },
      clearInterval: (id) => {
        assert.equal(id, 7)
        cleared = true
      },
    },
  })

  await runtime.start()
  await tick()
  assert.deepEqual(gateway.sent.map((item) => item.id), ["expired"])

  await runtime.hooks.event({ event: { type: "global.disposed", properties: {} } })
  assert.equal(cleared, true)
})

test("startup does not wait for OpenCode permission reconciliation", async () => {
  const gateway = createGateway()
  let runStartupReconcile
  let reconcileStarted = false
  let finishReconcile
  const reconciliation = new Promise((resolve) => {
    finishReconcile = resolve
  })
  const runtime = createPluginRuntime({
    gateway,
    approvalManager: {
      reconcile: async () => {
        reconcileStarted = true
        return reconciliation
      },
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: { handle: async () => [] },
    timers: {
      setTimeout: (callback) => {
        runStartupReconcile = callback
        return 8
      },
      clearTimeout: () => {},
      setInterval: () => 9,
      clearInterval: () => {},
    },
  })

  const result = await Promise.race([
    runtime.start(),
    new Promise((resolve) => setImmediate(() => resolve("blocked"))),
  ])

  assert.equal(result, true)
  assert.equal(reconcileStarted, false)
  runStartupReconcile()
  await Promise.resolve()
  assert.equal(reconcileStarted, true)
  finishReconcile([])
  await reconciliation
})
