import assert from "node:assert/strict"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { RebindCoordinator } from "../dist/rebind-coordinator.js"
import { RebindPageStore } from "../dist/rebind-page.js"
import { RebindStatus } from "../dist/rebind-state.js"
import { WeChatStore } from "../dist/store.js"
import { TransportFailureKind } from "../dist/transport-health.js"

const START_TIME = 1_000
const PAGE_ID = "0123456789abcdef0123456789abcdef"

function seedBinding(store, contextToken = "old-context") {
  store.commitBinding(
    {
      accountId: "bot",
      token: "secret",
      baseUrl: "https://example.invalid",
      userId: "owner",
      savedAt: "2026-08-03T00:00:00.000Z",
    },
    { boundUserID: "owner", contextToken, updatedAt: START_TIME },
    "cursor",
  )
}

function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wechat-rebind-coordinator-"))
  const store = new WeChatStore(root)
  seedBinding(store)
  const timers = []
  const bindCalls = []
  const notices = []
  const pages = new RebindPageStore({
    directory: root,
    now: () => START_TIME,
    randomID: () => PAGE_ID,
    renderQRCode: async () => "<svg></svg>",
  })
  const gateway = {
    stop: async () => {},
    bind: async (onQRCode, force, signal) => {
      bindCalls.push({ force, signal })
      await onQRCode("qr-secret")
      if (options.bindError) throw options.bindError
      seedBinding(store, "fresh-context")
    },
  }
  const coordinator = new RebindCoordinator({
    store,
    gateway,
    pages,
    now: () => START_TIME,
    timers: {
      setTimeout: (callback, milliseconds) => {
        const entry = { callback, milliseconds, active: true }
        timers.push(entry)
        return entry
      },
      clearTimeout: (entry) => {
        entry.active = false
      },
    },
    notify: async (notice) => {
      notices.push(notice)
      if (options.notifyError) throw options.notifyError
    },
  })
  return {
    bindCalls,
    coordinator,
    notices,
    pages,
    store,
    runTimer: async (milliseconds) => {
      const timer = timers.find((entry) => entry.active && entry.milliseconds === milliseconds)
      assert.ok(timer, `missing timer ${milliseconds}`)
      timer.active = false
      timer.callback()
      await flushAsync()
    },
  }
}

test("waits for context refresh before starting forced rebind", async () => {
  const state = harness()

  state.coordinator.request(TransportFailureKind.ContextRefresh)

  assert.equal(state.store.loadRebindState().status, RebindStatus.AwaitingContext)
  assert.equal(state.bindCalls.length, 0)
  await state.runTimer(60_000)
  assert.equal(state.bindCalls.length, 1)
  assert.equal(state.store.loadRebindState().status, RebindStatus.Confirming)
})

test("starts one QR session immediately for session expiry", async () => {
  const state = harness()

  state.coordinator.request(TransportFailureKind.SessionExpired)
  state.coordinator.request(TransportFailureKind.SessionExpired)
  await flushAsync()

  assert.equal(state.bindCalls.length, 1)
  assert.equal(state.bindCalls[0].force, true)
  assert.equal(state.store.loadRebindState().status, RebindStatus.Confirming)
  assert.match(state.notices[0].message, /^file:/)
  assert.doesNotMatch(state.notices[0].message, /qr-secret|secret|owner/)
})

test("cancels escalation when a fresh inbound context arrives", async () => {
  const state = harness()
  state.coordinator.request(TransportFailureKind.ContextRefresh)
  seedBinding(state.store, "rotated-context")

  state.coordinator.observeBindingChange()
  await flushAsync()

  assert.equal(state.bindCalls.length, 0)
  assert.equal(state.store.loadRebindState().status, RebindStatus.Idle)
})

test("removes the QR page only after transport becomes healthy", async () => {
  const state = harness()
  state.coordinator.request(TransportFailureKind.SessionExpired)
  await flushAsync()
  const descriptor = state.store.loadRebindState()
  const page = state.pages.resolveLink(descriptor)

  assert.ok(page && existsSync(page.filePath))
  state.coordinator.markTransportHealthy()
  await flushAsync()

  assert.equal(existsSync(page.filePath), false)
  assert.equal(state.store.loadRebindState().status, RebindStatus.Idle)
  assert.equal(state.notices.at(-1).variant, "success")
})

test("allows transport verification after the new binding is committed", async () => {
  const state = harness()
  state.coordinator.request(TransportFailureKind.SessionExpired)
  await flushAsync()

  assert.equal(state.store.loadRebindState().status, RebindStatus.Confirming)
  assert.equal(state.coordinator.requiresBinding(), false)
})

test("expires and removes a QR page after binding fails without persisting secrets", async () => {
  const state = harness({ bindError: new Error("Bearer secret qr-secret") })
  state.coordinator.request(TransportFailureKind.SessionExpired)
  await flushAsync()

  const descriptor = state.store.loadRebindState()
  assert.equal(descriptor.status, RebindStatus.Expired)
  assert.equal(descriptor.pageFileName, null)
  assert.doesNotMatch(JSON.stringify(descriptor), /secret|qr-secret|owner/)
})

test("stops an active rebind and ignores toast delivery failures", async () => {
  const state = harness({ notifyError: new Error("TUI unavailable") })
  state.coordinator.request(TransportFailureKind.ContextRefresh)

  await state.coordinator.stop()

  assert.equal(state.store.loadRebindState().status, RebindStatus.Idle)
  assert.equal(state.bindCalls.length, 0)
})

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
