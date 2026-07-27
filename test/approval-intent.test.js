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
  assert.equal(interpretDeterministic("全部允许", pending).decision, "once")
  assert.equal(interpretDeterministic("全部都允许", pending).decision, "once")
  assert.equal(interpretDeterministic("全部始终允许", pending).decision, "always")
  assert.equal(interpretDeterministic("全部always", pending).decision, "always")
  assert.equal(interpretDeterministic("allow all", pending).decision, "once")
  assert.equal(interpretDeterministic("不要，拒绝", pending).decision, "reject")
})

test("maps all-request rejection without a model", () => {
  const result = interpretDeterministic("全部拒绝", [approval("r1", 1), approval("r2", 2)])

  assert.deepEqual(result, {
    requestIDs: ["r1", "r2"],
    decision: "reject",
    confidence: 1,
    explanation: "deterministic",
  })
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

test("parses mixed ordinal decisions in timestamp order", () => {
  const pending = [
    { ...approval("later", 1, "/workspace/later"), createdAt: 200 },
    { ...approval("earlier", 2, "/workspace/earlier"), createdAt: 100 },
  ]

  assert.deepEqual(interpretDeterministic("第一个允许、第二个拒绝", pending), {
    requestIDs: ["earlier", "later"],
    decision: "once",
    decisions: { earlier: "once", later: "reject" },
    confidence: 1,
    explanation: "deterministic",
  })
})

test("returns null for ordinary text that is not an approval reply", () => {
  assert.equal(interpretDeterministic("今天天气怎么样", [approval("r1", 1)]), null)
})

test("never grants negated or questioning Chinese phrases", () => {
  const pending = [approval("r1", 1)]

  assert.equal(interpretDeterministic("不可以", pending).decision, "reject")
  assert.equal(interpretDeterministic("不通过", pending).decision, "reject")
  assert.equal(interpretDeterministic("不确认", pending).decision, "reject")
  assert.equal(interpretDeterministic("可以吗？", pending), null)
  assert.equal(interpretDeterministic("这个能通过吗", pending), null)
})

test("never grants approval tokens under Chinese negative modality", () => {
  const pending = [approval("r1", 1)]

  for (const text of [
    "不能允许",
    "无法同意",
    "先别允许",
    "禁止通过",
    "未确认",
    "暂时不授权",
    "不要执行，稍后确认",
  ]) {
    assert.notEqual(
      interpretDeterministic(text, pending)?.decision,
      "once",
      text,
    )
    assert.notEqual(
      interpretDeterministic(text, pending)?.decision,
      "always",
      text,
    )
  }
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

test("inherits a clarification decision only from a strict selection reply", () => {
  const pending = [approval("r1", 1), approval("r2", 2)]
  const conversation = {
    version: "r1,r2",
    requestIDs: ["r1", "r2"],
    decision: "once",
    createdAt: 1,
  }

  for (const text of [
    "不能第一个",
    "先别选第一个",
    "第一个可以吗？",
    "#1？",
    "第一个？",
    "docs 最近怎么样",
  ]) {
    assert.equal(interpretDeterministic(text, pending, conversation), null, text)
  }

  assert.equal(interpretDeterministic("#1", pending, conversation).decision, "once")
  assert.equal(interpretDeterministic("第一个", pending, conversation).decision, "once")
  assert.deepEqual(
    interpretDeterministic("1 和 2", pending, conversation).requestIDs,
    ["r1", "r2"],
  )
})
