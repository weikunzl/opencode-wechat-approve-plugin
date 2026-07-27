import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HttpPermissionAPI } from "../dist/opencode-permissions.js"
import { WeChatStore } from "../dist/store.js"

test("uses the OpenCode tool start time for ordinal approval ordering", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-permissions-time-")))
  const fetcher = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === "/permission") {
      return Response.json([
        {
          id: "req-later",
          sessionID: "ses-later",
          permission: "bash",
          patterns: ["later"],
          tool: { messageID: "msg-later" },
        },
        {
          id: "req-earlier",
          sessionID: "ses-earlier",
          permission: "bash",
          patterns: ["earlier"],
          tool: { messageID: "msg-earlier" },
        },
      ])
    }
    if (url.pathname.endsWith("/msg-later")) {
      return Response.json({ parts: [{ state: { time: { start: 200 } } }] })
    }
    if (url.pathname.endsWith("/msg-earlier")) {
      return Response.json({ parts: [{ state: { time: { start: 100 } } }] })
    }
    return new Response("not found", { status: 404 })
  }

  const api = new HttpPermissionAPI(new URL("http://127.0.0.1:4096"), store, 600_000, fetcher)
  const pending = await api.list()

  assert.deepEqual(
    pending.map((item) => [item.requestID, item.createdAt]),
    [
      ["req-later", 200],
      ["req-earlier", 100],
    ],
  )
})
