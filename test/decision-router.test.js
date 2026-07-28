import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalIndex } from "../dist/approval-index.js"
import { DecisionRouteStatus, DecisionRouter } from "../dist/decision-router.js"

function request(id, createdAt, code) {
  return {
    requestID: id,
    sessionID: `ses-${id}`,
    code,
    permission: "bash",
    patterns: [id],
    project: "/workspace",
    createdAt,
    expiresAt: createdAt + 10_000,
  }
}

test("routes mixed ordinal decisions by creation time and revision", () => {
  const index = new ApprovalIndex(mkdtempSync(join(tmpdir(), "wechat-router-")))
  const pending = [request("later", 200, 1), request("earlier", 100, 2)]
  index.replace(pending, "owner")
  const router = new DecisionRouter(index)

  const result = router.route({
    messageID: "msg-1",
    ownerInstanceID: "owner",
    text: "第一个允许、第二个拒绝",
    pending,
  })

  assert.equal(result.status, DecisionRouteStatus.Routed)
  assert.deepEqual(result.commands.map((item) => [item.requestID, item.decision, item.expectedRevision]), [
    ["earlier", "once", 1],
    ["later", "reject", 1],
  ])
})

test("does not claim ambiguous multi-request text", () => {
  const index = new ApprovalIndex(mkdtempSync(join(tmpdir(), "wechat-router-clarify-")))
  const pending = [request("one", 1, 1), request("two", 2, 2)]
  index.replace(pending, "owner")
  const router = new DecisionRouter(index)

  const result = router.route({ messageID: "msg-clarify", ownerInstanceID: "owner", text: "好的", pending })

  assert.equal(result.status, DecisionRouteStatus.Clarify)
  assert.deepEqual(result.commands, [])
  assert.equal(index.snapshot().every((item) => item.status === "pending"), true)
})

test("serializes duplicate and conflicting batch replies", () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-router-race-"))
  const pending = [request("one", 1, 1), request("two", 2, 2)]
  const firstIndex = new ApprovalIndex(directory)
  firstIndex.replace(pending, "owner-1")
  const first = new DecisionRouter(firstIndex)
  const second = new DecisionRouter(new ApprovalIndex(directory))

  const allow = first.route({ messageID: "msg-allow", ownerInstanceID: "owner-1", text: "全部允许", pending })
  const reject = second.route({ messageID: "msg-reject", ownerInstanceID: "owner-2", text: "全部拒绝", pending })
  const duplicate = first.route({ messageID: "msg-allow", ownerInstanceID: "owner-1", text: "全部允许", pending })

  assert.equal(allow.status, DecisionRouteStatus.Routed)
  assert.equal(reject.status, DecisionRouteStatus.Conflict)
  assert.equal(duplicate.status, DecisionRouteStatus.Duplicate)
})
