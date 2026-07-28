import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { PluginEventRouter } from "../dist/plugin-event-router.js"
import { SharedMailbox } from "../dist/shared-mailbox.js"

test("routes a secondary instance event exactly once through the mailbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-event-router-"))
  const mailbox = new SharedMailbox(directory)
  const secondary = new PluginEventRouter({ mailbox, instanceID: "secondary" })
  const owner = new PluginEventRouter({ mailbox, instanceID: "owner" })
  const received = []

  secondary.publish({
    eventID: "event-1",
    eventType: "session.idle",
    payload: { sessionID: "ses-1" },
  })
  await owner.drain(async (event) => received.push(event))
  await owner.drain(async (event) => received.push(event))

  assert.deepEqual(received, [{
    eventID: "event-1",
    sourceInstanceID: "secondary",
    eventType: "session.idle",
    payload: { sessionID: "ses-1" },
  }])
})

test("leaves inbound mailbox events for the gateway owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-event-router-inbox-"))
  const mailbox = new SharedMailbox(directory)
  const owner = new PluginEventRouter({ mailbox, instanceID: "owner" })

  mailbox.publishEvent({ messageID: "wechat-1", textDigest: "inbound", receivedAt: 1 })
  await owner.drain(async () => {})

  assert.equal(mailbox.readEvents().length, 1)
})
