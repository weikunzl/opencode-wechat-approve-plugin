import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalIndex, ApprovalStatus } from "../dist/approval-index.js"
import { CommandWorker } from "../dist/command-worker.js"
import { DecisionRouter } from "../dist/decision-router.js"
import { SharedMailbox } from "../dist/shared-mailbox.js"

function request(id) {
  return {
    requestID: id,
    sessionID: `ses-${id}`,
    code: 1,
    permission: "bash",
    patterns: ["npm test"],
    project: "/workspace",
    createdAt: 1,
    expiresAt: 10_000,
  }
}

test("applies only commands owned by the current instance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-command-worker-"))
  const index = new ApprovalIndex(directory)
  const mailbox = new SharedMailbox(directory)
  index.replace([request("req-1")], "owner-1")
  const router = new DecisionRouter(index)
  const result = router.route({
    messageID: "msg-1",
    ownerInstanceID: "owner-1",
    text: "允许",
    pending: [request("req-1")],
  })
  for (const command of result.commands) mailbox.enqueueCommand(command)
  const replies = []
  const worker = new CommandWorker({
    index,
    mailbox,
    ownerInstanceID: "owner-1",
    adapter: { reply: async (input) => replies.push(input) || true },
  })

  await worker.processOnce()

  assert.deepEqual(replies, [{ sessionID: "ses-req-1", requestID: "req-1", decision: "once" }])
  assert.equal(index.snapshot()[0].status, ApprovalStatus.Applied)
  assert.deepEqual(mailbox.readCommands("owner-1"), [])
})

test("keeps failed owner commands retryable without calling another owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-command-worker-fail-"))
  const index = new ApprovalIndex(directory)
  const mailbox = new SharedMailbox(directory)
  index.replace([request("req-1")], "owner-1")
  const router = new DecisionRouter(index)
  const result = router.route({ messageID: "msg-1", ownerInstanceID: "owner-1", text: "允许", pending: [request("req-1")] })
  for (const command of result.commands) mailbox.enqueueCommand(command)
  const worker = new CommandWorker({
    index,
    mailbox,
    ownerInstanceID: "owner-2",
    adapter: { reply: async () => true },
  })

  await worker.processOnce()

  assert.equal(index.snapshot()[0].status, ApprovalStatus.Claimed)
  assert.equal(mailbox.readCommands("owner-1").length, 1)
})

test("retries a failed command with the same claim revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-command-worker-retry-"))
  const index = new ApprovalIndex(directory)
  const mailbox = new SharedMailbox(directory)
  index.replace([request("req-1")], "owner")
  const result = new DecisionRouter(index).route({ messageID: "msg-1", ownerInstanceID: "owner", text: "允许", pending: [request("req-1")] })
  for (const command of result.commands) mailbox.enqueueCommand(command)
  let attempts = 0
  const worker = new CommandWorker({
    index,
    mailbox,
    ownerInstanceID: "owner",
    adapter: { reply: async () => (++attempts > 1) },
  })

  await worker.processOnce()
  await worker.processOnce()

  assert.equal(attempts, 2)
  assert.equal(index.snapshot()[0].status, ApprovalStatus.Applied)
})
