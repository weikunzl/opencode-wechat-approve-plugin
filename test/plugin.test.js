import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalManager } from "../dist/approval-manager.js"
import { createPluginRuntime, createRebindNotifier } from "../dist/index.js"
import { PluginEventRouter } from "../dist/plugin-event-router.js"
import { SharedMailbox } from "../dist/shared-mailbox.js"
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

test("publishes a browser rebind link through the injected OpenCode TUI", async () => {
  // 插件只把受控通知交给当前 OpenCode TUI，不自行打开浏览器。
  const toasts = []
  const notify = createRebindNotifier({
    tui: { showToast: async (input) => toasts.push(input) },
  }, "/workspace")

  await notify({
    title: "微信需要重新绑定",
    message: "file:///private/rebind.html",
    variant: "warning",
  })

  assert.deepEqual(toasts, [{
    body: {
      title: "微信需要重新绑定",
      message: "file:///private/rebind.html",
      variant: "warning",
      duration: 15_000,
    },
    query: { directory: "/workspace" },
  }])
})

test("exposes no general-purpose WeChat AI tools or permission interception hook", () => {
  const { runtime } = createHarness()

  assert.equal(runtime.hooks.tool, undefined)
  assert.equal(runtime.hooks["permission.ask"], undefined)
})

test("a secondary plugin instance emits no duplicate notifications", async () => {
  const { runtime, gateway } = createHarness()
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args)
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

  try {
    assert.equal(await secondary.start(), false)
    await secondary.hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses-1" } },
    })
  } finally {
    console.error = originalError
  }

  assert.deepEqual(gateway.sent, [])
  assert.deepEqual(errors, [])
  assert.equal(runtime.hooks.tool, undefined)
})

test("drops uncoordinated secondary events without a native mailbox", async () => {
  const ownerGateway = createGateway()
  const owner = createPluginRuntime({
    gateway: ownerGateway,
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [
        { id: "approval-owner", kind: "approval", text: "owner", createdAt: 1 },
      ],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: { handle: async () => [] },
    lease: { acquire: () => true, release: () => {} },
  })
  const secondary = createPluginRuntime({
    gateway: createGateway(),
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: { handle: async () => [] },
    lease: { acquire: () => false, release: () => {} },
  })

  await owner.start()
  assert.equal(await secondary.start(), false)
  await secondary.hooks.event({
    event: {
      type: "permission.asked",
      properties: { id: "req-1", sessionID: "ses-1", permission: "bash", patterns: [] },
    },
  })

  assert.deepEqual(ownerGateway.sent, [])
  await owner.hooks.event({ event: { type: "global.disposed", properties: {} } })
})

test("accepts the current permission.updated event shape", async () => {
  const gateway = createGateway()
  const received = []
  const runtime = createPluginRuntime({
    gateway,
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async (event) => {
        received.push(event)
        return []
      },
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: { handle: async () => [] },
  })

  await runtime.start()
  await runtime.hooks.event({
    event: {
      type: "permission.updated",
      properties: {
        id: "req-current",
        sessionID: "ses-current",
        type: "bash",
        pattern: "npm test",
        metadata: { directory: "/workspace" },
      },
    },
  })

  assert.deepEqual(received, [{
    type: "permission.asked",
    properties: {
      id: "req-current",
      sessionID: "ses-current",
      permission: "bash",
      patterns: ["npm test"],
      metadata: { directory: "/workspace" },
    },
  }])
})

test("routes native plugin events from a secondary instance to the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-native-runtime-"))
  const mailbox = new SharedMailbox(directory)
  let drain
  const ownerEvents = []
  const owner = createPluginRuntime({
    gateway: createGateway(),
    approvalManager: { reconcile: async () => [], onPermissionAsked: async () => [], onPermissionReplied: async () => {}, onMessage: async () => [] },
    sessionNotifier: { handle: async (event) => { ownerEvents.push(event); return [] } },
    leader: { start: async () => true, stop: async () => {} },
    eventRouter: new PluginEventRouter({ mailbox, instanceID: "owner" }),
    timers: {
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: (callback) => {
        drain = callback
        return 2
      },
      clearInterval: () => {},
    },
  })
  const secondary = createPluginRuntime({
    gateway: createGateway(),
    approvalManager: { reconcile: async () => [], onPermissionAsked: async () => [], onPermissionReplied: async () => {}, onMessage: async () => [] },
    sessionNotifier: { handle: async () => [] },
    leader: { start: async () => false, stop: async () => {} },
    eventRouter: new PluginEventRouter({ mailbox, instanceID: "secondary" }),
    timers: { setTimeout: () => 3, clearTimeout: () => {}, setInterval: () => 4, clearInterval: () => {} },
  })

  await owner.start()
  await secondary.start()
  await secondary.hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses-secondary" } } })
  await drain()

  assert.deepEqual(ownerEvents, [{ type: "session.idle", properties: { sessionID: "ses-secondary" } }])
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

test("stops the gateway immediately when the runtime lease is lost", async () => {
  const gateway = createGateway()
  let stopped = false
  let onLost
  gateway.stop = async () => {
    stopped = true
  }
  const runtime = createPluginRuntime({
    gateway,
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: { handle: async () => [] },
    lease: {
      acquire: () => true,
      release: () => {},
      setOnLost: (callback) => {
        onLost = callback
      },
    },
  })
  await runtime.start()

  onLost()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stopped, true)
})

test("drops a notification completed after the runtime lease is lost", async () => {
  const gateway = createGateway()
  let onLost
  let finishHandle
  const runtime = createPluginRuntime({
    gateway,
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: {
      handle: async () =>
        new Promise((resolve) => {
          finishHandle = resolve
        }),
    },
    lease: {
      acquire: () => true,
      release: () => {},
      setOnLost: (callback) => {
        onLost = callback
      },
    },
  })
  await runtime.start()
  const event = runtime.hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses-late" } },
  })

  onLost()
  finishHandle([{ id: "late", kind: "done", text: "late", createdAt: 1 }])
  await event

  assert.deepEqual(gateway.sent, [])
})

test("continues shutdown when plugin instance disposal is temporarily busy", async () => {
  let stopped = 0
  const runtime = createPluginRuntime({
    gateway: createGateway(),
    approvalManager: {
      reconcile: async () => [],
      onPermissionAsked: async () => [],
      onPermissionReplied: async () => {},
      onMessage: async () => [],
    },
    sessionNotifier: { handle: async () => [] },
    leader: {
      start: async () => true,
      stop: async () => {
        stopped += 1
      },
    },
    instanceRegistry: {
      heartbeat: () => {},
      dispose: () => {
        throw new Error("registry busy")
      },
    },
    instanceID: "instance",
  })
  const originalError = console.error
  console.error = () => {}
  try {
    await runtime.start()
    await assert.doesNotReject(
      runtime.hooks.event({ event: { type: "global.disposed", properties: {} } }),
    )
  } finally {
    console.error = originalError
  }

  assert.equal(stopped, 1)
})
