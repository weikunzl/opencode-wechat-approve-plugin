import assert from "node:assert/strict"
import { mkdtempSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { SharedStateStore, StateSchemaVersion } from "../dist/shared-state.js"

function root(name) {
  return mkdtempSync(join(tmpdir(), name))
}

test("writes shared state atomically with owner-only permissions", () => {
  const directory = root("wechat-shared-state-")
  const store = new SharedStateStore(directory)

  store.save({ schemaVersion: StateSchemaVersion.V2, approvals: [], inbox: [] })

  assert.deepEqual(store.load(), { schemaVersion: 2, approvals: [], inbox: [] })
  if (process.platform !== "win32") {
    assert.equal(statSync(join(directory, "shared-state-v2.json")).mode & 0o777, 0o600)
  }
})

test("quarantines corrupt shared state and returns a safe empty document", () => {
  const directory = root("wechat-shared-state-corrupt-")
  writeFileSync(join(directory, "shared-state-v2.json"), "{")
  const store = new SharedStateStore(directory)

  assert.deepEqual(store.load(), { schemaVersion: 2, approvals: [], inbox: [] })
  assert.equal(readdirSync(directory).some((name) => name.startsWith("shared-state-v2.json.corrupt-")), true)
})

test("migrates the previous state shape without retaining server settings", () => {
  const directory = root("wechat-shared-state-migrate-")
  writeFileSync(
    join(directory, "shared-state-v2.json"),
    JSON.stringify({ schemaVersion: 1, pending: [{ requestID: "req-1" }], server: { port: 4096 } }),
  )
  const store = new SharedStateStore(directory)

  assert.deepEqual(store.load(), {
    schemaVersion: 2,
    approvals: [{ requestID: "req-1" }],
    inbox: [],
  })
})

test("only one process can hold the shared lock", () => {
  const directory = root("wechat-shared-lock-")
  const first = new SharedStateStore(directory)
  const second = new SharedStateStore(directory)
  const owner = first.acquireLock()

  assert.notEqual(owner, null)
  assert.equal(second.acquireLock(), null)
  owner?.release()
  assert.notEqual(second.acquireLock(), null)
})
