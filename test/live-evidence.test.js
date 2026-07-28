import assert from "node:assert/strict"
import test from "node:test"

import {
  ProvenanceKind,
  createProvenance,
  createStatusSnapshot,
} from "../dist/live-evidence.js"

test("records local dist provenance without treating it as registry evidence", () => {
  const provenance = createProvenance({
    kind: ProvenanceKind.LocalDist,
    packageVersion: "1.1.0",
    entrypoint: "file:///workspace/dist/index.js",
  })

  assert.deepEqual(provenance, {
    kind: "local-dist",
    packageVersion: "1.1.0",
    entrypoint: "file:///workspace/dist/index.js",
  })
})

test("builds a redacted before-after status snapshot", () => {
  const snapshot = createStatusSnapshot({
    observedAt: "2026-07-28T13:20:00.000Z",
    provenance: {
      kind: "local-dist",
      packageVersion: "1.1.0",
      entrypoint: "file:///workspace/dist/index.js",
    },
    localPending: [{ requestID: "per_abcdefghijk", sessionID: "ses_123", code: 1 }],
    serverPending: ["per_abcdefghijk"],
    outboxCount: 2,
  })

  assert.deepEqual(snapshot.local, { pending: 1, requestIDs: ["per_abcd…"], outbox: 2 })
  assert.deepEqual(snapshot.server, { pending: 1, requestIDs: ["per_abcd…"] })
  assert.equal(JSON.stringify(snapshot).includes("ses_123"), false)
})
