import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { GatewayLeader } from "../dist/gateway-leader.js"
import { SharedMailbox } from "../dist/shared-mailbox.js"

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
