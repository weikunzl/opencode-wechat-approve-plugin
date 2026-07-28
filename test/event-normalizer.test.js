import assert from "node:assert/strict"
import test from "node:test"

import { normalizeOpenCodeEvent } from "../dist/event-normalizer.js"

test("normalizes current permission.updated and legacy permission.asked", () => {
  const current = normalizeOpenCodeEvent({
    type: "permission.updated",
    properties: {
      id: "req-current",
      sessionID: "ses-1",
      type: "bash",
      pattern: ["npm test"],
      metadata: { directory: "/workspace" },
      time: { created: 10 },
    },
  })
  const legacy = normalizeOpenCodeEvent({
    type: "permission.asked",
    properties: {
      id: "req-legacy",
      sessionID: "ses-1",
      permission: "bash",
      patterns: ["npm test"],
      metadata: { directory: "/workspace" },
    },
  })

  assert.deepEqual(current, {
    kind: "permission.asked",
    id: "req-current",
    sessionID: "ses-1",
    permission: "bash",
    patterns: ["npm test"],
    metadata: { directory: "/workspace" },
    createdAt: 10,
  })
  assert.equal(legacy?.kind, "permission.asked")
  assert.equal(legacy?.permission, "bash")
})

test("rejects malformed permission event without exposing its payload", () => {
  assert.equal(
    normalizeOpenCodeEvent({
      type: "permission.updated",
      properties: { id: "", sessionID: "ses-1", type: "bash" },
    }),
    null,
  )
})
