import assert from "node:assert/strict"
import test from "node:test"

import { validateModelIntent } from "../dist/model-interpreter.js"

const pending = [
  {
    requestID: "r1",
    sessionID: "ses_1",
    code: 1,
    permission: "bash",
    patterns: ["npm test"],
    project: "/workspace/docs",
    createdAt: 1,
    expiresAt: 999,
  },
]

test("accepts bounded high-confidence structured model intent", () => {
  assert.deepEqual(
    validateModelIntent(
      {
        requestIDs: ["r1"],
        decision: "once",
        confidence: 0.95,
        explanation: "用户指向 npm test",
      },
      pending,
      0.85,
      "允许 npm test",
    ),
    {
      requestIDs: ["r1"],
      decision: "once",
      confidence: 0.95,
      explanation: "用户指向 npm test",
    },
  )
})

test("rejects model output containing unknown request IDs", () => {
  const result = validateModelIntent(
    { requestIDs: ["invented"], decision: "always", confidence: 1, explanation: "" },
    pending,
    0.85,
    "全部授权",
  )

  assert.equal(result.decision, "clarify")
  assert.deepEqual(result.requestIDs, [])
})

test("requires explicit persistent language before accepting always", () => {
  const result = validateModelIntent(
    { requestIDs: ["r1"], decision: "always", confidence: 0.99, explanation: "" },
    pending,
    0.85,
    "好的",
  )

  assert.equal(result.decision, "clarify")
})

test("never lets the model establish or escalate an approval decision", () => {
  assert.equal(
    validateModelIntent(
      { requestIDs: ["r1"], decision: "once", confidence: 1, explanation: "" },
      pending,
      0.85,
      "今天天气怎么样",
    ).decision,
    "clarify",
  )
  assert.equal(
    validateModelIntent(
      { requestIDs: ["r1"], decision: "always", confidence: 1, explanation: "" },
      pending,
      0.85,
      "允许 npm test",
    ).decision,
    "clarify",
  )
})

test("clarifies low-confidence malformed or conflicting model output", () => {
  assert.equal(
    validateModelIntent(
      { requestIDs: ["r1"], decision: "once", confidence: 0.5, explanation: "" },
      pending,
      0.85,
      "好的",
    ).decision,
    "clarify",
  )
  assert.equal(validateModelIntent("not-json", pending, 0.85, "好的").decision, "clarify")
})
