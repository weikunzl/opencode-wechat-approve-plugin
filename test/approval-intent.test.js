import assert from "node:assert/strict"
import test from "node:test"

import { interpretDeterministic } from "../dist/approval-intent.js"

function approval(requestID, code, project = "/workspace/docs", patterns = ["npm test"]) {
  return {
    requestID,
    sessionID: `ses_${code}`,
    code,
    permission: "bash",
    patterns,
    project,
    createdAt: code,
    expiresAt: 999,
  }
}

test("maps clear one-request synonyms without a model", () => {
  const pending = [approval("r1", 1)]

  assert.equal(interpretDeterministic("好的", pending).decision, "once")
  assert.equal(interpretDeterministic("OK", pending).decision, "once")
  assert.equal(interpretDeterministic("全部授权", pending).decision, "always")
  assert.equal(interpretDeterministic("allow all", pending).decision, "always")
  assert.equal(interpretDeterministic("不要，拒绝", pending).decision, "reject")
})

test("clarifies a bare approval when multiple requests are pending", () => {
  const result = interpretDeterministic("好的", [approval("r1", 1), approval("r2", 2)])

  assert.equal(result.decision, "clarify")
  assert.deepEqual(result.requestIDs, [])
})

test("selects multiple requests independently from the decision scope", () => {
  const pending = [approval("r1", 1), approval("r2", 2), approval("r3", 3)]

  assert.deepEqual(interpretDeterministic("1 和 3 都允许", pending), {
    requestIDs: ["r1", "r3"],
    decision: "once",
    confidence: 1,
    explanation: "deterministic",
  })
  assert.deepEqual(interpretDeterministic("C1 和 C3 都始终允许", pending), {
    requestIDs: ["r1", "r3"],
    decision: "always",
    confidence: 1,
    explanation: "deterministic",
  })
})

test("selects by ordinal project and operation description", () => {
  const pending = [
    approval("r1", 1, "/workspace/docs", ["npm test"]),
    approval("r2", 2, "/workspace/api", ["git push origin main"]),
  ]

  assert.deepEqual(interpretDeterministic("拒绝第二个", pending).requestIDs, ["r2"])
  assert.deepEqual(interpretDeterministic("允许 docs 项目的", pending).requestIDs, ["r1"])
  assert.deepEqual(interpretDeterministic("拒绝 git push 那个", pending).requestIDs, ["r2"])
})

test("returns null for ordinary text that is not an approval reply", () => {
  assert.equal(interpretDeterministic("今天天气怎么样", [approval("r1", 1)]), null)
})

test("inherits the decision during a clarification conversation", () => {
  const pending = [approval("r1", 1), approval("r2", 2)]
  const conversation = {
    version: "r1,r2",
    requestIDs: ["r1", "r2"],
    decision: "once",
    createdAt: 1,
  }

  assert.deepEqual(interpretDeterministic("第一个", pending, conversation), {
    requestIDs: ["r1"],
    decision: "once",
    confidence: 1,
    explanation: "deterministic",
  })
})
