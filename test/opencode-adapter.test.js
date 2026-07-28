import assert from "node:assert/strict"
import test from "node:test"

import { OpenCodePermissionAdapter } from "../dist/opencode-adapter.js"

test("replies through the injected OpenCode client", async () => {
  const calls = []
  const client = {
    postSessionIdPermissionsPermissionId: async (options) => {
      calls.push(options)
      return { data: true }
    },
  }
  const adapter = new OpenCodePermissionAdapter(client)

  const applied = await adapter.reply({
    sessionID: "ses-1",
    requestID: "req-1",
    decision: "once",
  })

  assert.equal(applied, true)
  assert.deepEqual(calls, [{
    path: { id: "ses-1", permissionID: "req-1" },
    body: { response: "once" },
  }])
})
