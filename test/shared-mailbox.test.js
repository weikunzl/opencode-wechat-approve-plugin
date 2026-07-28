import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { MailboxRecordKind, SharedMailbox } from "../dist/shared-mailbox.js"

test("publishes each command once and acknowledges only its owner", () => {
  const mailbox = new SharedMailbox(mkdtempSync(join(tmpdir(), "wechat-mailbox-")))
  const command = {
    commandID: "cmd-1",
    messageID: "msg-1",
    ownerInstanceID: "instance-1",
    requestID: "req-1",
    expectedRevision: 3,
    decision: "once",
  }

  mailbox.enqueueCommand(command)
  mailbox.enqueueCommand(command)

  assert.deepEqual(mailbox.readCommands("instance-2"), [])
  assert.deepEqual(mailbox.readCommands("instance-1"), [
    { kind: MailboxRecordKind.Command, ...command },
  ])
  mailbox.acknowledgeCommand("cmd-1")
  assert.deepEqual(mailbox.readCommands("instance-1"), [])
})

test("deduplicates inbound events by message ID", () => {
  const mailbox = new SharedMailbox(mkdtempSync(join(tmpdir(), "wechat-mailbox-event-")))
  const event = { messageID: "msg-1", textDigest: "digest", receivedAt: 1 }

  mailbox.publishEvent(event)
  mailbox.publishEvent(event)

  assert.deepEqual(mailbox.readEvents(), [{ kind: MailboxRecordKind.Event, ...event }])
})
