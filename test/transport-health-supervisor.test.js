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
      if (options.probeError) throw options.probeError
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
