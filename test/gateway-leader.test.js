import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { GatewayLeader } from "../dist/gateway-leader.js"
import { SharedMailbox } from "../dist/shared-mailbox.js"
import { WeChatStore } from "../dist/store.js"
import { TransportHealthSupervisor } from "../dist/transport-health-supervisor.js"
import {
  TransportFailureKind,
  TransportHealthStatus,
} from "../dist/transport-health.js"

function gatewayHarness() {
  let callback = null
  let starts = 0
  return {
    gateway: {
      initialize: async () => "ready",
      flushOutbox: async () => {},
      start: (handler) => {
        starts += 1
        callback = handler
      },
      stop: async () => {},
    },
    emit: async (message) => callback?.(message),
    starts: () => starts,
  }
}

test("only the lease holder starts polling and persists inbound events first", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-"))
  const firstGateway = gatewayHarness()
  const secondGateway = gatewayHarness()
  const lease = {
    acquire: () => true,
    release: () => {},
  }
  const first = new GatewayLeader({
    gateway: firstGateway.gateway,
    mailbox: new SharedMailbox(directory),
    lease,
    ownerInstanceID: "owner-1",
  })
  const second = new GatewayLeader({
    gateway: secondGateway.gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => false, release: () => {} },
    ownerInstanceID: "owner-2",
  })
  const messages = []

  assert.equal(await first.start(async (message) => messages.push(message)), true)
  assert.equal(await second.start(async () => {}), false)
  await firstGateway.emit({ messageID: "msg-1", senderID: "owner", text: "允许", receivedAt: 10 })

  assert.equal(firstGateway.starts(), 1)
  assert.equal(secondGateway.starts(), 0)
  assert.equal(new SharedMailbox(directory).readEvents().length, 0)
  assert.equal(messages.length, 1)
  await first.stop()
})

test("prepares authoritative approval state before starting the supervisor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-prepare-"))
  const order = []
  const leader = new GatewayLeader({
    gateway: gatewayHarness().gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => true, release: () => {} },
    ownerInstanceID: "owner",
    prepareStartup: async () => order.push("prepare"),
    supervisor: {
      start: async () => order.push("supervisor"),
      stop: async () => {},
    },
  })

  await leader.start(async () => {})

  assert.deepEqual(order, ["prepare", "supervisor"])
  await leader.stop()
})

test("does not dispatch a late callback after leader stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-stop-"))
  const harness = gatewayHarness()
  const leader = new GatewayLeader({
    gateway: harness.gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => true, release: () => {} },
    ownerInstanceID: "owner",
  })
  const messages = []

  await leader.start(async (message) => messages.push(message))
  await leader.stop()
  await harness.emit({ messageID: "late", senderID: "owner", text: "拒绝", receivedAt: 20 })

  assert.deepEqual(messages, [])
})

test("retains inbound mailbox event when owner handling fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-retry-"))
  const harness = gatewayHarness()
  const mailbox = new SharedMailbox(directory)
  const leader = new GatewayLeader({
    gateway: harness.gateway,
    mailbox,
    lease: { acquire: () => true, release: () => {} },
    ownerInstanceID: "owner",
  })

  await leader.start(async () => { throw new Error("owner unavailable") })
  await assert.rejects(harness.emit({ messageID: "retry", senderID: "owner", text: "允许", receivedAt: 20 }), /owner unavailable/)

  assert.equal(mailbox.readEvents().length, 1)
  await leader.stop()
})

test("starts polling when durable outbox recovery fails during restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-outbox-"))
  const harness = gatewayHarness()
  harness.gateway.flushOutbox = async () => {
    throw new Error("stale context")
  }
  let releases = 0
  const leader = new GatewayLeader({
    gateway: harness.gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => true, release: () => { releases += 1 } },
    ownerInstanceID: "owner",
  })

  assert.equal(await leader.start(async () => {}), true)
  assert.equal(harness.starts(), 1)
  assert.equal(releases, 0)
  await leader.stop()
})

test("a secondary retries the lease and becomes the gateway leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-takeover-"))
  const harness = gatewayHarness()
  const attempts = [false, true]
  let retry
  const transitions = []
  const leader = new GatewayLeader({
    gateway: harness.gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => attempts.shift(), release: () => {} },
    ownerInstanceID: "owner",
    timers: {
      setTimeout: (callback) => {
        retry = callback
        return 1
      },
      clearTimeout: () => {},
    },
    random: () => 0,
  })
  leader.setLeadershipHandler((active) => transitions.push(active))

  assert.equal(await leader.start(async () => {}), false)
  retry()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(harness.starts(), 1)
  assert.deepEqual(transitions, [true])
  await leader.stop()
})

test("passes the final-instance decision to supervised shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-leader-stop-notice-"))
  const stopOptions = []
  const leader = new GatewayLeader({
    gateway: gatewayHarness().gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => true, release: () => {} },
    ownerInstanceID: "owner",
    supervisor: {
      start: async () => {},
      stop: async (options) => stopOptions.push(options),
    },
    shouldNotifyStop: () => false,
  })

  await leader.start(async () => {})
  await leader.stop()

  assert.deepEqual(stopOptions, [{ sendNotice: false, preserveHealth: true }])
})

test("a final secondary acquires the lease only to send the stop notice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-final-secondary-"))
  const stopOptions = []
  let releases = 0
  const attempts = [false, true]
  const leader = new GatewayLeader({
    gateway: gatewayHarness().gateway,
    mailbox: new SharedMailbox(directory),
    lease: {
      acquire: () => attempts.shift() ?? false,
      release: () => {
        releases += 1
      },
    },
    ownerInstanceID: "secondary",
    supervisor: {
      start: async () => {},
      stop: async (options) => stopOptions.push(options),
    },
    shouldNotifyStop: () => true,
    wait: async () => {},
  })

  assert.equal(await leader.start(async () => {}), false)
  await leader.stop()

  assert.deepEqual(stopOptions, [{ sendNotice: true }])
  assert.equal(releases, 1)
})

test("always releases the lease when the final-instance check fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-release-finally-"))
  let releases = 0
  let stops = 0
  const leader = new GatewayLeader({
    gateway: gatewayHarness().gateway,
    mailbox: new SharedMailbox(directory),
    lease: {
      acquire: () => true,
      release: () => {
        releases += 1
      },
    },
    ownerInstanceID: "owner",
    supervisor: {
      start: async () => {},
      stop: async () => {
        stops += 1
      },
    },
    shouldNotifyStop: () => {
      throw new Error("registry busy")
    },
  })
  await leader.start(async () => {})

  await assert.doesNotReject(leader.stop())

  assert.equal(stops, 1)
  assert.equal(releases, 1)
})

test("does not announce leadership after losing the lease during activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-activation-loss-"))
  let resolveStart
  const transitions = []
  const stopOptions = []
  const leader = new GatewayLeader({
    gateway: gatewayHarness().gateway,
    mailbox: new SharedMailbox(directory),
    lease: { acquire: () => true, release: () => {} },
    ownerInstanceID: "owner",
    supervisor: {
      start: () => new Promise((resolve) => {
        resolveStart = resolve
      }),
      stop: async (options) => stopOptions.push(options),
    },
  })
  leader.setLeadershipHandler((active) => transitions.push(active))

  const starting = leader.start(async () => {})
  await new Promise((resolve) => setImmediate(resolve))
  const losing = leader.handleLeaseLoss()
  resolveStart()
  await Promise.all([starting, losing])

  assert.deepEqual(transitions, [false])
  assert.equal(stopOptions.some((item) => item.sendNotice === false), true)
})

test("does not overwrite a new leader failure while the old leader stops", async () => {
  const state = sharedLeaderHarness()
  let finishOldStop
  let retrySecond
  state.firstGateway.stop = () => new Promise((resolve) => {
    finishOldStop = resolve
  })
  state.secondGateway.probe = async () => {
    throw new TypeError("network unavailable")
  }
  const leaders = createSharedLeaders(state, (callback) => {
    retrySecond = callback
  })

  assert.equal(await leaders.first.start(async () => {}), true)
  assert.equal(await leaders.second.start(async () => {}), false)
  state.lease.releaseOwner("first")
  const losing = leaders.first.handleLeaseLoss()
  await new Promise((resolve) => setImmediate(resolve))
  retrySecond()
  await new Promise((resolve) => setImmediate(resolve))
  finishOldStop()
  await losing

  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Degraded)
  assert.equal(
    state.store.loadTransportHealth().lastFailureKind,
    TransportFailureKind.Network,
  )
  await leaders.second.stop()
  await leaders.first.stop()
})

test("a waiting final secondary sends one stop notice after leader release", async () => {
  const state = sharedLeaderHarness()
  const leaders = createSharedLeaders(state, () => {})

  assert.equal(await leaders.first.start(async () => {}), true)
  assert.equal(await leaders.second.start(async () => {}), false)
  const finalStopping = leaders.second.stop()
  await new Promise((resolve) => setImmediate(resolve))
  await leaders.first.stop()
  await finalStopping

  assert.equal(
    state.secondNotifications.filter((item) => item.text.includes("已停止")).length,
    1,
  )
  assert.equal(state.store.loadTransportHealth().status, TransportHealthStatus.Stopped)
})

function sharedLeaderHarness() {
  const directory = mkdtempSync(join(tmpdir(), "wechat-gateway-shared-"))
  const store = new WeChatStore(directory)
  seedBinding(store)
  const firstNotifications = []
  const secondNotifications = []
  const firstGateway = healthGateway(firstNotifications)
  const secondGateway = healthGateway(secondNotifications)
  return {
    directory,
    store,
    lease: leaseCoordinator(),
    firstGateway,
    secondGateway,
    firstNotifications,
    secondNotifications,
  }
}

function createSharedLeaders(state, captureSecondRetry) {
  const first = new GatewayLeader({
    gateway: state.firstGateway,
    mailbox: new SharedMailbox(state.directory),
    lease: state.lease.forOwner("first"),
    ownerInstanceID: "first",
    supervisor: new TransportHealthSupervisor({
      store: state.store,
      gateway: state.firstGateway,
      now: () => 2_000_000,
    }),
    shouldNotifyStop: () => false,
    timers: noOpTimers(),
  })
  const second = new GatewayLeader({
    gateway: state.secondGateway,
    mailbox: new SharedMailbox(state.directory),
    lease: state.lease.forOwner("second"),
    ownerInstanceID: "second",
    supervisor: new TransportHealthSupervisor({
      store: state.store,
      gateway: state.secondGateway,
      now: () => 2_000_000,
    }),
    shouldNotifyStop: () => true,
    timers: {
      setTimeout: (callback) => {
        captureSecondRetry(callback)
        return 1
      },
      clearTimeout: () => {},
    },
    wait: async () => new Promise((resolve) => setImmediate(resolve)),
  })
  return { first, second }
}

function healthGateway(notifications) {
  return {
    initialize: async () => "ready",
    start: () => {},
    stop: async () => {},
    setTransportErrorHandler: () => {},
    probe: async (notification) => notifications.push(notification),
    flushOutbox: async () => {},
  }
}

function leaseCoordinator() {
  let owner = null
  return {
    forOwner: (id) => ({
      acquire: () => {
        if (owner !== null && owner !== id) return false
        owner = id
        return true
      },
      release: () => {
        if (owner === id) owner = null
      },
    }),
    releaseOwner: (id) => {
      if (owner === id) owner = null
    },
  }
}

function noOpTimers() {
  return {
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
}

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
