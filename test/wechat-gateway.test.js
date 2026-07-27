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
    sendText: async (to, text, contextToken) => {
      sent.push({ to, text, contextToken })
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

  assert.deepEqual(sent, [{ to: "owner@im.wechat", text: "任务完成", contextToken: "ctx" }])
  assert.deepEqual(store.loadOutbox(), [])
})
