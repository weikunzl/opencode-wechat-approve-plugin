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

test("uses a newly committed binding without restarting the transport", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-")))
  const oldAccount = {
    accountId: "old-bot",
    token: "old-token",
    baseUrl: "https://old.example.invalid",
    userId: "owner",
    savedAt: "2026-07-27T00:00:00.000Z",
  }
  store.saveAccount(oldAccount)
  const requests = []
  const transport = new IlinkClientTransport(store, async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.Authorization })
    return Response.json({ ret: 0 })
  })
  store.commitBinding(
    {
      ...oldAccount,
      accountId: "new-bot",
      token: "new-token",
      baseUrl: "https://new.example.invalid",
    },
    { boundUserID: "owner", contextToken: "context", updatedAt: 1 },
    "cursor",
  )

  await transport.sendText("owner", "hello", "context", "notice-2")

  assert.deepEqual(requests, [
    {
      url: "https://new.example.invalid/ilink/bot/sendmessage",
      authorization: "Bearer new-token",
    },
  ])
})

test("uses a forced login account before its binding is committed", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-")))
  store.saveAccount({
    accountId: "old-bot",
    token: "old-token",
    baseUrl: "https://old.example.invalid",
    userId: "owner",
    savedAt: "2026-07-27T00:00:00.000Z",
  })
  const requests = []
  const transport = new IlinkClientTransport(store, async (url, init) => {
    const value = String(url)
    if (value.includes("get_bot_qrcode")) {
      return Response.json({ qrcode: "qr", qrcode_img_content: "image" })
    }
    if (value.includes("get_qrcode_status")) {
      return Response.json({
        status: "confirmed",
        ilink_bot_id: "new-bot",
        bot_token: "new-token",
        baseurl: "https://new.example.invalid",
        ilink_user_id: "owner",
      })
    }
    requests.push({ url: value, authorization: init.headers.Authorization })
    return Response.json({ ret: 0 })
  })

  await transport.login(undefined, true)
  await transport.sendText("owner", "hello", "context", "notice-3")

  assert.deepEqual(requests, [
    {
      url: "https://new.example.invalid/ilink/bot/sendmessage",
      authorization: "Bearer new-token",
    },
  ])
})
