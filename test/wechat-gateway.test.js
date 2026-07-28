import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { IlinkApiError, IlinkErrorCode } from "../dist/client.js"
import { WeChatStore } from "../dist/store.js"
import { WeChatGateway } from "../dist/wechat-gateway.js"

function privateText({ senderID, text, id, token = "ctx" }) {
  return {
    message_id: id,
    from_user_id: senderID,
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: token,
    create_time_ms: 1,
  }
}

function groupText({ senderID, text, id, token = "ctx" }) {
  return {
    ...privateText({ senderID, text, id, token }),
    group_id: "group@chatroom",
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "wechat-gateway-"))
  const store = new WeChatStore(root)
  store.saveAccount({
    accountId: "bot@im.bot",
    token: "secret",
    baseUrl: "https://example.invalid",
    userId: "owner@im.wechat",
    savedAt: "2026-07-27T00:00:00.000Z",
  })
  store.saveContext({
    boundUserID: "owner@im.wechat",
    contextToken: "ctx",
    updatedAt: 1,
  })
  const batches = []
  const sent = []
  const transport = {
    poll: async () => batches.shift() ?? { ret: 0, msgs: [], get_updates_buf: "empty" },
    sendText: async (to, text, contextToken, idempotencyKey) => {
      sent.push({ to, text, contextToken, idempotencyKey })
    },
    login: async () => {
      throw new Error("not expected")
    },
  }
  return {
    store,
    batches,
    sent,
    gateway: new WeChatGateway(store, transport),
  }
}

test("accepts only the QR-bound private-chat user and deduplicates messages", async () => {
  const { batches, gateway } = harness()
  const messages = []
  batches.push({
    ret: 0,
    get_updates_buf: "cursor-1",
    msgs: [
      privateText({ senderID: "intruder@im.wechat", text: "好的", id: "m1" }),
      groupText({ senderID: "owner@im.wechat", text: "好的", id: "m2" }),
      privateText({ senderID: "owner@im.wechat", text: "好的", id: "m3" }),
      privateText({ senderID: "owner@im.wechat", text: "好的", id: "m3" }),
    ],
  })

  await gateway.pollOnce(async (message) => messages.push(message))

  assert.deepEqual(messages.map((message) => message.messageID), ["m3"])
})

test("persists cursor before dispatching received messages", async () => {
  const { batches, gateway, store } = harness()
  const order = []
  batches.push({
    ret: 0,
    get_updates_buf: "cursor-before-message",
    msgs: [privateText({ senderID: "owner@im.wechat", text: "好的", id: "m4" })],
  })

  await gateway.pollOnce(async () => {
    order.push(store.loadCursor())
  })

  assert.deepEqual(order, ["cursor-before-message"])
})

test("persists inbox before cursor when an ingress recorder is configured", async () => {
  const { batches, gateway, store } = harness()
  const order = []
  gateway.setInboundRecorder(async () => {
    order.push(`inbox:${store.loadCursor()}`)
  })
  batches.push({
    ret: 0,
    get_updates_buf: "cursor-after-inbox",
    msgs: [privateText({ senderID: "owner@im.wechat", text: "好的", id: "m5" })],
  })

  await gateway.pollOnce(async () => {
    order.push(`handler:${store.loadCursor()}`)
  })

  assert.deepEqual(order, ["inbox:", "handler:"])
  assert.equal(store.loadCursor(), "cursor-after-inbox")
})

test("does not advance processed messages when ingress recording fails", async () => {
  const { batches, gateway, store } = harness()
  gateway.setInboundRecorder(async () => {
    throw new Error("inbox unavailable")
  })
  batches.push({
    ret: 0,
    get_updates_buf: "cursor-after-failure",
    msgs: [privateText({ senderID: "owner@im.wechat", text: "好的", id: "m-inbox-failure" })],
  })

  await assert.rejects(gateway.pollOnce(async () => {}), /inbox unavailable/)

  assert.equal(store.loadCursor(), "")
  assert.deepEqual(store.loadProcessedMessageIDs(), [])
})

test("does not mark a message processed when its handler fails", async () => {
  const { batches, gateway, store } = harness()
  gateway.setInboundRecorder(async () => {})
  batches.push({
    ret: 0,
    get_updates_buf: "cursor-after-handler-failure",
    msgs: [privateText({ senderID: "owner@im.wechat", text: "好的", id: "m-handler-failure" })],
  })

  await assert.rejects(gateway.pollOnce(async () => { throw new Error("handler unavailable") }), /handler unavailable/)

  assert.equal(store.loadCursor(), "")
  assert.deepEqual(store.loadProcessedMessageIDs(), [])
})

test("persists outbound notification until delivery succeeds", async () => {
  const { gateway, store, sent } = harness()
  const notification = {
    id: "notice-1",
    kind: "done",
    text: "任务完成",
    createdAt: 1,
  }

  await gateway.send(notification)

  assert.deepEqual(sent, [
    {
      to: "owner@im.wechat",
      text: "任务完成",
      contextToken: "ctx",
      idempotencyKey: "notice-1",
    },
  ])
  assert.deepEqual(store.loadOutbox(), [])
})

test("keeps a failed outbound notification queued for retry", async () => {
  const { store } = harness()
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => ({ ret: 0, msgs: [] }),
    sendText: async () => {
      throw new Error("temporary failure")
    },
  })
  const notification = {
    id: "notice-retry",
    kind: "done",
    text: "任务完成",
    createdAt: 1,
  }

  await assert.rejects(gateway.send(notification), /temporary failure/)

  assert.deepEqual(store.loadOutbox(), [notification])
})

test("retries the durable outbox while the gateway remains running", async () => {
  const { store } = harness()
  let attempts = 0
  let fail = true
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => ({ ret: 0, msgs: [], get_updates_buf: "next" }),
    sendText: async () => {
      attempts += 1
      if (fail) throw new Error("temporary failure")
    },
  })
  const notification = {
    id: "notice-live-retry",
    kind: "done",
    text: "任务完成",
    createdAt: 1,
  }
  await assert.rejects(gateway.send(notification), /temporary failure/)
  fail = false

  await gateway.pollOnce(async () => {})

  assert.equal(attempts, 2)
  assert.deepEqual(store.loadOutbox(), [])
})

test("refreshes context from a new message before retrying the outbox", async () => {
  const { store } = harness()
  const batches = []
  const contexts = []
  let failed = true
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => batches.shift() ?? { ret: 0, msgs: [] },
    sendText: async (_to, _text, contextToken) => {
      contexts.push(contextToken)
      if (failed) {
        failed = false
        throw new IlinkApiError({ endpoint: "/ilink/bot/sendmessage", ret: -2, errmsg: "prepare failed" })
      }
    },
  })
  const notification = {
    id: "notice-context-refresh",
    kind: "done",
    text: "任务完成",
    createdAt: 1,
  }

  await assert.rejects(gateway.send(notification), /prepare failed/)
  await gateway.pollOnce(async () => {})
  assert.deepEqual(contexts, ["ctx"])
  assert.deepEqual(store.loadOutbox(), [notification])
  batches.push({
    ret: 0,
    msgs: [privateText({ senderID: "owner@im.wechat", text: "收到", id: "refresh", token: "fresh-ctx" })],
  })

  await gateway.pollOnce(async () => {})

  assert.deepEqual(contexts, ["ctx", "fresh-ctx"])
  assert.equal(store.loadContext().contextToken, "fresh-ctx")
  assert.deepEqual(store.loadOutbox(), [])
})

test("requires rebinding after an iLink session timeout", async () => {
  const { store } = harness()
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => {
      throw new IlinkApiError({
        endpoint: "/ilink/bot/getupdates",
        ret: 0,
        errcode: IlinkErrorCode.SessionTimeout,
        errmsg: "session timeout",
      })
    },
    sendText: async () => {},
  })

  await assert.rejects(gateway.pollOnce(async () => {}), /ret=0.*errcode=-14/)

  assert.equal(store.loadContext(), null)
  assert.equal(await gateway.initialize(), "needs-binding")

  store.saveContext({ boundUserID: "owner@im.wechat", contextToken: "fresh-ctx", updatedAt: 2 })
  assert.equal(store.loadContext().contextToken, "fresh-ctx")
})

test("includes redacted transport diagnostics without credentials", async () => {
  const { store } = harness()
  const error = new IlinkApiError({
    endpoint: "/ilink/bot/sendmessage",
    ret: -2,
    errcode: -2,
    errmsg: "prepare failed",
  })
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => ({ ret: 0, msgs: [] }),
    sendText: async () => {
      throw error
    },
  })

  await assert.rejects(
    gateway.send({ id: "notice-diagnostic", kind: "done", text: "完成", createdAt: 1 }),
    (caught) => {
      assert.match(caught.message, /ret=-2.*errcode=-2.*prepare failed/)
      assert.match(caught.message, /baseHost=example\.invalid/)
      assert.match(caught.message, /contextAgeMs=/)
      assert.doesNotMatch(caught.message, /secret|ctx|owner@im\.wechat/)
      return true
    },
  )
  assert.equal(error.code, -2)
})

test("stop waits for an in-flight poll and never dispatches its response", async () => {
  const { store } = harness()
  let finishPoll
  let receivedSignal
  const messages = []
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async (_cursor, signal) => {
      receivedSignal = signal
      return new Promise((resolve) => {
        finishPoll = resolve
      })
    },
    sendText: async () => {},
  })
  gateway.start(async (message) => messages.push(message))
  await new Promise((resolve) => setImmediate(resolve))

  const stopping = gateway.stop()
  assert.equal(receivedSignal.aborted, true)
  finishPoll({
    ret: 0,
    get_updates_buf: "stale-cursor",
    msgs: [privateText({ senderID: "owner@im.wechat", text: "好的", id: "stale-message" })],
  })
  await stopping

  assert.deepEqual(messages, [])
  assert.notEqual(store.loadCursor(), "stale-cursor")
})

test("discards an old-account poll response after a binding change", async () => {
  const { store } = harness()
  const gateway = new WeChatGateway(store, {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => {
      store.commitBinding(
        {
          accountId: "new-bot",
          token: "new-secret",
          baseUrl: "https://new.example.invalid",
          userId: "owner@im.wechat",
          savedAt: "2026-07-27T00:00:00.000Z",
        },
        {
          boundUserID: "owner@im.wechat",
          contextToken: "new-context",
          updatedAt: 2,
        },
        "new-bind-cursor",
      )
      return { ret: 0, msgs: [], get_updates_buf: "old-poll-cursor" }
    },
    sendText: async () => {},
  })

  await gateway.pollOnce(async () => {})

  assert.equal(store.loadCursor(), "new-bind-cursor")
  assert.equal(store.loadAccount().accountId, "new-bot")
})

test("redacts credentials and bounds every outbound WeChat notification", async () => {
  const { gateway, sent } = harness()

  await gateway.send({
    id: "notice-sensitive",
    kind: "error",
    text: [
      "Authorization: Bearer top-secret",
      "API_KEY=private-value",
      "OPENAI_API_KEY=openai-secret",
      "AWS_SECRET_ACCESS_KEY=aws-secret",
      "MY_PASSWORD=my-password",
      '{"OPENAI_API_KEY":"json-openai-secret","AWS_SECRET_ACCESS_KEY":"json-aws-secret"}',
      "{'AWS_SECRET_ACCESS_KEY':'single-quoted-secret'}",
      '{"MY_PASSWORD":123456}',
      "API_KEY=abc,def",
      "x".repeat(3_000),
    ].join("\n"),
    createdAt: 1,
  })

  assert.doesNotMatch(
    sent[0].text,
    /top-secret|private-value|openai-secret|aws-secret|my-password|json-openai-secret|json-aws-secret|single-quoted-secret|123456|\babc\b|\bdef\b/,
  )
  assert.match(sent[0].text, /\[REDACTED\]/)
  assert.doesNotMatch(sent[0].text, /\[REDACTED\]\]/)
  assert.ok(sent[0].text.length <= 1_800)
})

test("deduplicates an inbound message after a process restart", async () => {
  const { batches, gateway, store } = harness()
  const messages = []
  const duplicate = privateText({ senderID: "owner@im.wechat", text: "好的", id: "m-restart" })
  batches.push({ ret: 0, get_updates_buf: "cursor-1", msgs: [duplicate] })
  await gateway.pollOnce(async (message) => messages.push(message))

  const restartedTransport = {
    login: async () => {
      throw new Error("not expected")
    },
    poll: async () => ({ ret: 0, get_updates_buf: "cursor-2", msgs: [duplicate] }),
    sendText: async () => {},
  }
  const restarted = new WeChatGateway(store, restartedTransport)
  await restarted.pollOnce(async (message) => messages.push(message))

  assert.deepEqual(messages.map((message) => message.messageID), ["m-restart"])
})

test("binding ignores ordinary text and persists only the exact binding message context", async () => {
  const { store } = harness()
  const loginCalls = []
  const batches = [
    {
      ret: 0,
      get_updates_buf: "cursor-ordinary",
      msgs: [
        privateText({
          senderID: "new-owner@im.wechat",
          text: "今天天气怎么样",
          id: "ordinary",
          token: "wrong-context",
        }),
      ],
    },
    {
      ret: 0,
      get_updates_buf: "cursor-binding",
      msgs: [
        privateText({
          senderID: "new-owner@im.wechat",
          text: "绑定",
          id: "binding",
          token: "correct-context",
        }),
      ],
    },
  ]
  const gateway = new WeChatGateway(store, {
    login: async (_onQRCode, force) => {
      loginCalls.push(force)
      return {
        accountId: "new-bot",
        token: "new-secret",
        baseUrl: "https://example.invalid",
        userId: "new-owner@im.wechat",
        savedAt: "2026-07-27T00:00:00.000Z",
      }
    },
    poll: async () => batches.shift(),
    sendText: async () => {},
  })

  await gateway.bind(undefined, true)

  assert.deepEqual(loginCalls, [true])
  assert.deepEqual(store.loadContext(), {
    boundUserID: "new-owner@im.wechat",
    contextToken: "correct-context",
    updatedAt: 1,
  })
})

test("an interrupted forced rebind preserves the previous binding and uses a fresh cursor", async () => {
  const { store } = harness()
  store.saveCursor("old-cursor")
  const cursors = []
  const gateway = new WeChatGateway(store, {
    login: async () => ({
      accountId: "new-bot",
      token: "new-secret",
      baseUrl: "https://example.invalid",
      userId: "new-owner@im.wechat",
      savedAt: "2026-07-27T00:00:00.000Z",
    }),
    poll: async (cursor) => {
      cursors.push(cursor)
      throw new Error("binding interrupted")
    },
    sendText: async () => {},
  })

  await assert.rejects(gateway.bind(undefined, true), /binding interrupted/)

  assert.deepEqual(cursors, [""])
  assert.equal(store.loadAccount().accountId, "bot@im.bot")
  assert.equal(store.loadContext().boundUserID, "owner@im.wechat")
  assert.equal(store.loadCursor(), "old-cursor")
})
