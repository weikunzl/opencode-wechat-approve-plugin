import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalIndex, ApprovalStatus } from "../dist/approval-index.js"

function approval(requestID, createdAt) {
  return {
    requestID,
    sessionID: `ses-${requestID}`,
    code: createdAt,
    permission: "bash",
    patterns: [requestID],
    project: "/workspace",
    createdAt,
    expiresAt: createdAt + 10_000,
  }
}

test("claims pending approvals in creation order", () => {
  const index = new ApprovalIndex(mkdtempSync(join(tmpdir(), "wechat-approval-index-")))
  index.replace([approval("later", 200), approval("earlier", 100)], "instance-1")

  const claimed = index.claimSnapshot({ ownerInstanceID: "instance-1", requestIDs: ["later", "earlier"] })

  assert.deepEqual(claimed.map((item) => item.requestID), ["earlier", "later"])
  assert.equal(claimed.every((item) => item.status === ApprovalStatus.Claimed), true)
})

test("first concurrent claimant wins and a stale revision is rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-approval-index-race-"))
  const first = new ApprovalIndex(directory)
  const second = new ApprovalIndex(directory)
  first.replace([approval("req-1", 1)], "owner-1")

  const claimed = first.claimSnapshot({ ownerInstanceID: "owner-1", requestIDs: ["req-1"] })
  const lost = second.claimSnapshot({ ownerInstanceID: "owner-2", requestIDs: ["req-1"] })

  assert.equal(claimed.length, 1)
  assert.deepEqual(lost, [])
  assert.equal(first.markApplied({ requestID: "req-1", expectedRevision: 1 }), true)
  assert.equal(first.markApplied({ requestID: "req-1", expectedRevision: 1 }), false)
})

test("preserves partial failure state for retryable records", () => {
  const index = new ApprovalIndex(mkdtempSync(join(tmpdir(), "wechat-approval-index-partial-")))
  index.replace([approval("ok", 1), approval("retry", 2)], "owner")
  index.claimSnapshot({ ownerInstanceID: "owner", requestIDs: ["ok", "retry"] })

  assert.equal(index.markApplied({ requestID: "ok", expectedRevision: 1 }), true)
  assert.equal(index.markRetryable({ requestID: "retry", expectedRevision: 1 }), true)
  assert.deepEqual(index.snapshot().map((item) => [item.requestID, item.status]), [
    ["ok", ApprovalStatus.Applied],
    ["retry", ApprovalStatus.FailedRetryable],
  ])
})
