import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { IlinkApiError, IlinkErrorCode } from "../dist/client.js"
import { WeChatStore } from "../dist/store.js"
import { TransportHealthSupervisor } from "../dist/transport-health-supervisor.js"
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
  const gateway = {
    initialize: async () => "ready",
    start: () => calls.push("start"),
    stop: async () => calls.push("stop"),
    probe: async () => {
      calls.push("probe")
      const error = typeof options.probeError === "function"
        ? options.probeError()
        : options.probeError
      if (error) throw error
    },
    flushOutbox: async () => calls.push("flush"),
  }
  return {
    calls,
    store,
    supervisor: new TransportHealthSupervisor({
      store,
      gateway,
      now: () => 2_000_000,
      timers: options.timers,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    }),
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
  let interval
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
    timers: {
      setInterval: (callback) => {
        interval = callback
        return 1
      },
      clearInterval: () => {},
    },
  })

  await state.supervisor.start(async () => {})
  seedBinding(state.store)
  state.store.saveContext({
    boundUserID: "owner",
    contextToken: "fresh-context",
    updatedAt: 2_000_001,
  })
  interval()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Healthy)
  assert.deepEqual(state.calls, ["start", "probe", "stop", "start", "probe", "flush"])
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
