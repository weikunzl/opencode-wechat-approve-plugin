import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { WeChatStore } from "../dist/store.js"

const account = {
  accountId: "bot@im.bot",
  token: "secret",
  baseUrl: "https://example.invalid",
  userId: "owner@im.wechat",
  savedAt: "2026-07-27T00:00:00.000Z",
}

function temporaryStore() {
  const root = mkdtempSync(join(tmpdir(), "wechat-approve-store-"))
  return { root, store: new WeChatStore(root) }
}

test("quarantines corrupt state and returns an empty collection", () => {
  const { root, store } = temporaryStore()
  writeFileSync(join(root, "pending-approvals.json"), "{bad")

  assert.deepEqual(store.loadPendingApprovals(), [])
  assert.equal(
    readdirSync(root).some((name) => name.startsWith("pending-approvals.json.corrupt-")),
    true,
  )
})

test("writes credential files with owner-only permissions", () => {
  const { root, store } = temporaryStore()
  store.saveAccount(account)

  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "account.json")).mode & 0o777, 0o600)
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, "account.json"), "utf8")), account)
})

test("commits account, context, and cursor as one atomic binding", () => {
  const { root, store } = temporaryStore()
  const context = {
    boundUserID: "owner@im.wechat",
    contextToken: "context-secret",
    updatedAt: 1,
  }

  store.commitBinding(account, context, "cursor-1")

  assert.deepEqual(store.loadAccount(), account)
  assert.deepEqual(store.loadContext(), context)
  assert.equal(store.loadCursor(), "cursor-1")
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "binding-v1.json"), "utf8")),
    { account, context, cursor: "cursor-1" },
  )
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "binding-v1.json")).mode & 0o777, 0o600)
  }
})

test("round trips V1 approval and runtime state atomically", () => {
  const { store } = temporaryStore()
  const approval = {
    requestID: "req_1",
    sessionID: "ses_1",
    code: 1,
    permission: "bash",
    patterns: ["npm test"],
    project: "/tmp/project",
    createdAt: 1,
    expiresAt: 2,
  }
  const session = {
    sessionID: "ses_1",
    phase: "busy",
    run: 1,
    updatedAt: 1,
  }

  store.savePendingApprovals([approval])
  store.saveSessionStates([session])

  assert.deepEqual(store.loadPendingApprovals(), [approval])
  assert.deepEqual(store.loadSessionStates(), [session])
})
