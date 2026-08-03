import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { IlinkApiError, IlinkClientTransport, IlinkErrorCode } from "../dist/client.js"
import { WeChatStore } from "../dist/store.js"

test("reports a DNS failure with actionable WeChat API guidance", async () => {
  // 模拟 Node fetch 把 DNS 错误隐藏在 cause 中的真实错误结构。
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-network-")))
  store.saveAccount({
    accountId: "bot",
    token: "secret",
    baseUrl: "https://ilink.example.invalid",
    userId: "owner",
    savedAt: "2026-07-29T00:00:00.000Z",
  })
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND ilink.example.invalid"), {
    code: "ENOTFOUND",
  })
  const transport = new IlinkClientTransport(store, async () => {
    // 网络替身只模拟外部 fetch 失败，错误转换仍由真实客户端完成。
    throw new TypeError("fetch failed", { cause })
  })

  await assert.rejects(transport.sendText({
    to: "owner",
    text: "hello",
    contextToken: "context",
    idempotencyKey: "network-1",
  }), (error) => {
    assert.equal(error.name, "IlinkNetworkError")
    assert.match(error.message, /无法解析微信 API 地址.*DNS 或代理/)
    assert.match(error.message, /code=ENOTFOUND.*endpoint=\/ilink\/bot\/sendmessage/)
    assert.doesNotMatch(error.message, /secret|owner|context|ilink\.example/)
    return true
  })
})

test("reports a refused connection while requesting a WeChat QR code", async () => {
  // 首次扫码走独立 GET 路径，也必须返回可操作的网络诊断。
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-network-")))
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
  const transport = new IlinkClientTransport(store, async () => {
    // 仅替换外部网络边界，验证 login 的真实错误传播。
    throw new TypeError("fetch failed", { cause })
  })

  await assert.rejects(transport.login(), (error) => {
    assert.equal(error.name, "IlinkNetworkError")
    assert.match(error.message, /无法连接微信 API.*网络、代理或防火墙/)
    assert.match(error.message, /code=ECONNREFUSED.*endpoint=\/ilink\/bot\/get_bot_qrcode/)
    return true
  })
})

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
    transport.sendText({
      to: "owner",
      text: "hello",
      contextToken: "expired",
      idempotencyKey: "notice-1",
    }),
    (error) => {
      assert.ok(error instanceof IlinkApiError)
      assert.match(error.message, /ret=40001/)
      assert.match(error.message, /errmsg=context token expired/)
      return true
    },
  )
})

test("detects session timeout from errcode when ret is zero", async () => {
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
    async () => Response.json({ ret: 0, errcode: IlinkErrorCode.SessionTimeout, errmsg: "session timeout" }),
  )

  await assert.rejects(transport.sendText({
    to: "owner",
    text: "hello",
    contextToken: "expired",
    idempotencyKey: "notice-timeout",
  }), (error) => {
    assert.ok(error instanceof IlinkApiError)
    assert.equal(error.details.ret, 0)
    assert.equal(error.details.errcode, IlinkErrorCode.SessionTimeout)
    assert.equal(error.code, IlinkErrorCode.SessionTimeout)
    return true
  })
})

test("aborts an in-flight send when the caller cancels it", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-abort-")))
  store.saveAccount({
    accountId: "bot",
    token: "secret",
    baseUrl: "https://example.invalid",
    userId: "owner",
    savedAt: "2026-07-27T00:00:00.000Z",
  })
  const controller = new AbortController()
  const transport = new IlinkClientTransport(store, async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason))
    }),
  )
  const sending = transport.sendText({
    to: "owner",
    text: "hello",
    contextToken: "context",
    idempotencyKey: "abort",
    signal: controller.signal,
  })

  controller.abort()

  await assert.rejects(sending)
})

test("sanitizes credentials embedded in an iLink error message", () => {
  const error = new IlinkApiError({
    endpoint: "/ilink/bot/sendmessage",
    ret: -2,
    errmsg: "context_token=ctx-secret Bearer bot-secret",
  })

  assert.doesNotMatch(error.message, /ctx-secret|bot-secret/)
  assert.doesNotMatch(error.details.errmsg, /ctx-secret|bot-secret/)
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

  await transport.sendText({
    to: "owner",
    text: "hello",
    contextToken: "context",
    idempotencyKey: "notice-2",
  })

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
  await transport.sendText({
    to: "owner",
    text: "hello",
    contextToken: "context",
    idempotencyKey: "notice-3",
  })

  assert.deepEqual(requests, [
    {
      url: "https://new.example.invalid/ilink/bot/sendmessage",
      authorization: "Bearer new-token",
    },
  ])
})

test("awaits asynchronous QR publication before polling login status", async () => {
  // 页面尚未写完就轮询会让用户拿不到当前二维码链接。
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-qr-page-")))
  const order = []
  const transport = new IlinkClientTransport(store, async (url) => {
    if (String(url).includes("get_bot_qrcode")) {
      return Response.json({ qrcode: "qr", qrcode_img_content: "qr-content" })
    }
    order.push("status")
    return Response.json({
      status: "confirmed",
      ilink_bot_id: "new-bot",
      bot_token: "new-token",
      baseurl: "https://new.example.invalid",
      ilink_user_id: "owner",
    })
  })

  await transport.login(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    order.push("page")
  }, true)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(order, ["page", "status"])
})

test("aborts QR login while waiting for confirmation", async () => {
  // OpenCode 退出后登录请求必须随协调器取消，不能继续持有旧页面。
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-qr-abort-")))
  const controller = new AbortController()
  const transport = new IlinkClientTransport(store, async (url, init) => {
    if (String(url).includes("get_bot_qrcode")) {
      return Response.json({ qrcode: "qr", qrcode_img_content: "qr-content" })
    }
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
    })
  })
  const outcome = transport.login(undefined, true, controller.signal)
    .then(() => "resolved", (error) => error.name)

  controller.abort()
  const result = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve("not-aborted"), 30)),
  ])

  assert.equal(result, "AbortError")
})

test("continues QR status polling after a transient timeout", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-client-")))
  let statusCalls = 0
  const transport = new IlinkClientTransport(store, async (url) => {
    if (String(url).includes("get_bot_qrcode")) {
      return Response.json({ qrcode: "qr", qrcode_img_content: "image" })
    }
    statusCalls++
    if (statusCalls === 1) {
      const error = new Error("temporary timeout")
      error.name = "TimeoutError"
      throw error
    }
    return Response.json({
      status: "confirmed",
      ilink_bot_id: "bot",
      bot_token: "secret",
      baseurl: "https://example.invalid",
      ilink_user_id: "owner",
    })
  })

  const account = await transport.login(undefined, true)

  assert.equal(account.accountId, "bot")
  assert.equal(statusCalls, 2)
})
