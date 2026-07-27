import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

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
      "x".repeat(3_000),
    ].join("\n"),
    createdAt: 1,
  })

  assert.doesNotMatch(
    sent[0].text,
    /top-secret|private-value|openai-secret|aws-secret|my-password/,
  )
  assert.match(sent[0].text, /\[REDACTED\]/)
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
