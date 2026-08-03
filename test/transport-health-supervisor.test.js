import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { IlinkApiError, IlinkErrorCode } from "../dist/client.js"
import { WeChatStore } from "../dist/store.js"
import {
  TransportHealthSupervisor,
  TransportStartReason,
} from "../dist/transport-health-supervisor.js"
import {
  TransportFailureKind,
  TransportHealthStatus,
} from "../dist/transport-health.js"

function seedBinding(store) {
  store.commitBinding(
    {
      accountId: "bot",
      token: "secret",
      baseUrl: "https://example.invalid",
      userId: "owner",
      savedAt: "2026-07-31T00:00:00.000Z",
    },
    { boundUserID: "owner", contextToken: "context", updatedAt: 1 },
    "cursor",
  )
}

function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wechat-health-supervisor-"))
  const store = new WeChatStore(root)
  seedBinding(store)
  const calls = []
  const notifications = []
  let interval
  let errorHandler = () => {}
  const rebindRequests = []
  const rebindCalls = []
  const rebind = {
    activate: () => rebindCalls.push("activate"),
    request: (failure) => rebindRequests.push(failure),
    observeBindingChange: () => rebindCalls.push("observe"),
    markTransportHealthy: () => rebindCalls.push("healthy"),
    requiresBinding: () => options.requiresBinding ?? false,
    stop: async () => rebindCalls.push("stop"),
  }
  const gateway = {
    initialize: async () => options.initialize?.() ?? "ready",
    start: () => calls.push("start"),
    stop: async () => calls.push("stop"),
    setTransportErrorHandler: (handler) => {
      errorHandler = handler ?? (() => {})
    },
    probe: async (notification, signal) => {
      calls.push("probe")
      notifications.push(notification)
      if (options.probe) return options.probe(signal)
      const error = typeof options.probeError === "function"
        ? options.probeError()
        : options.probeError
      if (error) throw error
    },
    flushOutbox: async () => calls.push("flush"),
  }
  return {
    calls,
    notifications,
    store,
    supervisor: new TransportHealthSupervisor({
      store,
      gateway,
      now: () => 2_000_000,
      timers: {
        setInterval: (callback) => {
          interval = callback
          return 1
        },
        clearInterval: () => {},
        ...options.timers,
      },
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      ...(options.withRebind ? { rebind } : {}),
    }),
    rebindCalls,
    rebindRequests,
    emitError: (error) => errorHandler(error),
    runMonitor: async () => {
      interval()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test("starts polling before a successful health probe and outbox replay", async () => {
  const state = harness()

  await state.supervisor.start(async () => {})

  assert.deepEqual(state.calls, ["start", "probe", "flush"])
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Healthy)
  assert.equal(state.store.loadTransportHealth().cleanShutdown, false)
})

test("keeps polling active when the startup probe has a transient failure", async () => {
  const state = harness({ probeError: new TypeError("fetch failed") })

  await state.supervisor.start(async () => {})

  assert.deepEqual(state.calls, ["start", "probe"])
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Degraded)
  assert.equal(
    state.store.loadTransportHealth().lastFailureKind,
    TransportFailureKind.Network,
  )
})

test("delegates context refresh failures without scheduling stale probes", async () => {
  const state = harness({
    withRebind: true,
    probeError: new IlinkApiError({
      endpoint: "/ilink/bot/sendmessage",
      ret: -2,
      errmsg: "prepare failed",
    }),
  })

  await state.supervisor.start(async () => {})

  assert.deepEqual(state.rebindRequests, [TransportFailureKind.ContextRefresh])
  assert.equal(state.store.loadTransportHealth().nextRetryAt, null)
  assert.deepEqual(state.rebindCalls, ["activate"])
})

test("cleans the rebind page only after a successful transport probe", async () => {
  const state = harness({ withRebind: true })

  await state.supervisor.start(async () => {})

  assert.deepEqual(state.rebindCalls, ["activate", "healthy"])
})

test("observes a fresh context before recovering degraded transport", async () => {
  const state = harness({ withRebind: true })
  await state.supervisor.start(async () => {})
  state.store.saveTransportHealth({
    ...state.store.loadTransportHealth(),
    status: TransportHealthStatus.Degraded,
    lastFailureKind: TransportFailureKind.ContextRefresh,
  })
  state.store.saveContext({
    boundUserID: "owner",
    contextToken: "fresh-context",
    updatedAt: 2_000_001,
  })

  await state.runMonitor()

  assert.equal(state.rebindCalls.includes("observe"), true)
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Healthy)
})

test("uses a distinct message when taking over gateway leadership", async () => {
  const state = harness()

  await state.supervisor.start(async () => {}, TransportStartReason.Takeover)

  assert.equal(
    state.notifications[0].text,
    "🔄 [OpenCode] 微信授权网关已切换并恢复连接",
  )
})

test("stops the old transport and requires rebind after session timeout", async () => {
  const state = harness({
    probeError: new IlinkApiError({
      endpoint: "/ilink/bot/sendmessage",
      ret: 0,
      errcode: IlinkErrorCode.SessionTimeout,
      errmsg: "session timeout",
    }),
  })

  await state.supervisor.start(async () => {})

  assert.deepEqual(state.calls, ["start", "probe", "stop"])
  assert.equal(
    state.store.loadTransportHealth().status,
    TransportHealthStatus.NeedsRebind,
  )
  assert.equal(state.store.loadContext(), null)
})

test("detects a newly committed binding and recovers without OpenCode restart", async () => {
  let probeAttempt = 0
  const timeout = new IlinkApiError({
    endpoint: "/ilink/bot/sendmessage",
    ret: 0,
    errcode: IlinkErrorCode.SessionTimeout,
    errmsg: "session timeout",
  })
  const state = harness({
    probeError: () => {
      probeAttempt += 1
      return probeAttempt === 1 ? timeout : null
    },
  })

  await state.supervisor.start(async () => {})
  seedBinding(state.store)
  state.store.saveContext({
    boundUserID: "owner",
    contextToken: "fresh-context",
    updatedAt: 2_000_001,
  })
  await state.runMonitor()

  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Healthy)
  assert.deepEqual(state.calls, ["start", "probe", "stop", "start", "probe", "flush"])
})

test("does not reconnect after a healthy inbound context refresh", async () => {
  const state = harness()
  await state.supervisor.start(async () => {})
  state.store.saveContext({
    boundUserID: "owner",
    contextToken: "rotated-context",
    updatedAt: 2_000_001,
  })

  await state.runMonitor()

  assert.equal(state.calls.filter((item) => item === "probe").length, 1)
  assert.equal(state.calls.filter((item) => item === "start").length, 1)
})

test("records a runtime session timeout as requiring rebind", async () => {
  const state = harness()
  await state.supervisor.start(async () => {})

  state.emitError(new IlinkApiError({
    endpoint: "/ilink/bot/getupdates",
    ret: 0,
    errcode: IlinkErrorCode.SessionTimeout,
    errmsg: "session timeout",
  }))

  assert.equal(
    state.store.loadTransportHealth().status,
    TransportHealthStatus.NeedsRebind,
  )
})

test("does not resume a deferred recovery after shutdown", async () => {
  let resolveInitialize
  let initializeCount = 0
  const state = harness({
    initialize: () => {
      initializeCount += 1
      if (initializeCount === 1) return "ready"
      return new Promise((resolve) => {
        resolveInitialize = resolve
      })
    },
  })
  await state.supervisor.start(async () => {})
  state.store.saveTransportHealth({
    ...state.store.loadTransportHealth(),
    status: TransportHealthStatus.Degraded,
    nextRetryAt: 1,
  })
  const recovery = state.runMonitor()
  await new Promise((resolve) => setImmediate(resolve))
  const stopping = state.supervisor.stop({ sendNotice: false })
  resolveInitialize("ready")
  await Promise.all([recovery, stopping])

  assert.equal(state.calls.filter((item) => item === "start").length, 1)
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Stopped)
})

test("aborts the stop notification at the shutdown deadline", async () => {
  let aborted = false
  const state = harness({
    shutdownTimeoutMs: 5,
    probe: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true
        reject(signal.reason)
      })
    }),
  })
  state.store.saveTransportHealth({
    ...state.store.loadTransportHealth(),
    status: TransportHealthStatus.Healthy,
    lastSuccessAt: 1,
  })

  await state.supervisor.stop({ sendNotice: true })

  assert.equal(aborted, true)
})

test("sends a best-effort stop notice and records a clean shutdown", async () => {
  const state = harness()
  await state.supervisor.start(async () => {})

  await state.supervisor.stop({ sendNotice: true })

  assert.equal(state.calls.filter((item) => item === "probe").length, 2)
  assert.equal(state.calls.at(-1), "stop")
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Stopped)
  assert.equal(state.store.loadTransportHealth().cleanShutdown, true)
})

test("preserves healthy shared state while handing leadership to another instance", async () => {
  const state = harness()
  await state.supervisor.start(async () => {})

  await state.supervisor.stop({ sendNotice: false, preserveHealth: true })

  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Healthy)
  assert.equal(state.store.loadTransportHealth().cleanShutdown, false)
})

test("does not overwrite a degraded state while handing leadership to another instance", async () => {
  const state = harness()
  await state.supervisor.start(async () => {})
  state.store.saveTransportHealth({
    ...state.store.loadTransportHealth(),
    status: TransportHealthStatus.Degraded,
    lastFailureKind: TransportFailureKind.Network,
  })

  await state.supervisor.stop({ sendNotice: false, preserveHealth: true })

  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Degraded)
  assert.equal(state.store.loadTransportHealth().lastFailureKind, TransportFailureKind.Network)
})

test("a final supervisor sends the stop notice after a healthy handoff", async () => {
  const state = harness()
  await state.supervisor.start(async () => {})
  await state.supervisor.stop({ sendNotice: false, preserveHealth: true })
  const final = supervisorForStore(state.store)

  await final.supervisor.stop({ sendNotice: true })

  assert.equal(final.notifications[0].text, "⏹️ [OpenCode] 微信授权插件已停止")
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Stopped)
})

test("contains a failed monitor recovery and retries on the next due check", async () => {
  let initializeAttempt = 0
  const state = harness({
    initialize: () => {
      initializeAttempt += 1
      if (initializeAttempt === 2) throw new TypeError("fetch failed with secret")
      return "ready"
    },
  })
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(message)
  try {
    await state.supervisor.start(async () => {})
    markRetryDue(state.store)
    await state.runMonitor()
    assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Degraded)
    markRetryDue(state.store)
    await state.runMonitor()
  } finally {
    console.error = originalError
  }

  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Healthy)
  assert.deepEqual(errors, ["[wechat] transport 恢复失败: network"])
})

test("contains monitor recovery errors when health persistence is unavailable", async () => {
  let initializeAttempt = 0
  const state = harness({
    initialize: () => {
      initializeAttempt += 1
      if (initializeAttempt === 2) throw new TypeError("network secret")
      return "ready"
    },
  })
  await state.supervisor.start(async () => {})
  markRetryDue(state.store)
  state.store.saveTransportHealth = () => {
    throw new Error("storage secret")
  }
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(message)
  try {
    await state.runMonitor()
  } finally {
    console.error = originalError
  }

  assert.deepEqual(errors, [
    "[wechat] transport 恢复状态写入失败",
    "[wechat] transport 恢复失败: network",
  ])
})

function supervisorForStore(store) {
  const notifications = []
  const gateway = {
    initialize: async () => "ready",
    start: () => {},
    stop: async () => {},
    probe: async (notification) => notifications.push(notification),
    flushOutbox: async () => {},
  }
  return {
    notifications,
    supervisor: new TransportHealthSupervisor({ store, gateway, now: () => 2_000_000 }),
  }
}

function markRetryDue(store) {
  store.saveTransportHealth({
    ...store.loadTransportHealth(),
    status: TransportHealthStatus.Degraded,
    nextRetryAt: 1,
  })
}
