import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { SdkPermissionAPI } from "../dist/sdk-permissions.js"
import { WeChatStore } from "../dist/store.js"

test("lists authoritative pending approvals instead of stale local state", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-sdk-permission-")))
  const pending = {
    requestID: "req-1",
    sessionID: "ses-1",
    code: 1,
    permission: "bash",
    patterns: ["npm test"],
    project: "/workspace",
    createdAt: 1,
    expiresAt: 10_000,
  }
  store.savePendingApprovals([pending])
  const calls = []
  const api = new SdkPermissionAPI(store, {
    list: async () => [],
    reply: async (input) => { calls.push(input); return true },
  })

  assert.deepEqual(await api.list(), [])
  assert.equal(await api.reply("req-1", "always"), true)
  assert.deepEqual(calls, [{ sessionID: "ses-1", requestID: "req-1", decision: "always" }])
})

test("rejects a reply for an unknown pending request", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-sdk-permission-missing-")))
  const api = new SdkPermissionAPI(store, { list: async () => [], reply: async () => true })

  assert.equal(await api.reply("unknown", "reject"), false)
})
