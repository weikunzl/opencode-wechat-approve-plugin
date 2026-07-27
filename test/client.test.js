import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { IlinkClientTransport } from "../dist/client.js"
import { WeChatStore } from "../dist/store.js"

test("rejects a successful HTTP response containing a failed WeChat ret code", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-")))
  store.saveAccount({
    accountId: "bot",
    token: "secret",
    baseUrl: "https://example.invalid",
    userId: "owner",
    savedAt: "2026-07-27T00:00:00.000Z",
  })
  const transport = new IlinkClientTransport(
    store,
    async () =>
      Response.json({ ret: 40001, errmsg: "context token expired" }, { status: 200 }),
  )

  await assert.rejects(
    transport.sendText("owner", "hello", "expired", "notice-1"),
    /context token expired/,
  )
})
