import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalManager } from "../dist/approval-manager.js"
import { WeChatStore } from "../dist/store.js"

function request(id, code, project = "/workspace/docs", patterns = ["npm test"]) {
  return {
    requestID: id,
    sessionID: `ses_${code}`,
    code,
    permission: "bash",
    patterns,
    project,
    createdAt: code,
    expiresAt: 10_000,
  }
}

function harness(initial = [], options = {}) {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-approval-manager-")))
  store.savePendingApprovals(initial)
  const replies = []
  const api = {
    pending: [...initial],
    list: async () => [...api.pending],
    reply: async (requestID, decision) => {
      replies.push([requestID, decision])
      api.pending = api.pending.filter((item) => item.requestID !== requestID)
      return true
    },
  }
  const manager = new ApprovalManager({
    store,
    api,
    approvalTimeoutMs: 600_000,
    modelConfidenceThreshold: 0.85,
    interpretModel: options.interpretModel,
    now: () => 100,
  })
  return { store, api, replies, manager }
}

const message = (text) => ({
  messageID: `msg-${text}`,
  senderID: "owner@im.wechat",
  text,
  receivedAt: 100,
})

test("routes once always and reject by OpenCode request ID", async () => {
  const { manager, replies } = harness([request("r1", 1), request("r2", 2)])

  await manager.onMessage(message("两个都始终允许"))

  assert.deepEqual(replies, [
    ["r1", "always"],
    ["r2", "always"],
  ])
})

test("asks a follow-up and applies the inherited decision to the selected request", async () => {
  const { manager, replies, store } = harness([request("r1", 1), request("r2", 2)])

  const clarification = await manager.onMessage(message("好的"))
  assert.match(clarification[0].text, /#1/)
  assert.match(clarification[0].text, /#2/)
  assert.equal(store.loadConversation().decision, "once")

  await manager.onMessage(message("第一个"))

  assert.deepEqual(replies, [["r1", "once"]])
})

test("displays and resolves the same persistent approval codes", async () => {
  const { manager, replies } = harness([request("r2", 2), request("r3", 3)])

  const clarification = await manager.onMessage(message("好的"))
  assert.match(clarification[0].text, /#2/)
  assert.match(clarification[0].text, /#3/)
  assert.doesNotMatch(clarification[0].text, /1\./)

  await manager.onMessage(message("3"))

  assert.deepEqual(replies, [["r3", "once"]])
})

test("rechecks pending requests before applying a clarified selection", async () => {
  const { manager, replies, api } = harness([request("r1", 1), request("r2", 2)])
  await manager.onMessage(message("好的"))
  api.pending = [request("r2", 2)]

  const notices = await manager.onMessage(message("第一个"))

  assert.deepEqual(replies, [])
  assert.match(notices[0].text, /已变化/)
})

test("removes a request answered natively in OpenCode", async () => {
  const { manager, store } = harness([request("r1", 1)])

  await manager.onPermissionReplied({
    type: "permission.replied",
    properties: { sessionID: "ses_1", requestID: "r1", reply: "once" },
  })

  assert.deepEqual(store.loadPendingApprovals(), [])
})

test("ignores ordinary text when no approval is pending", async () => {
  const { manager, replies } = harness([])

  assert.deepEqual(await manager.onMessage(message("今天天气怎么样")), [])
  assert.deepEqual(replies, [])
})

test("never sends an ordinary pending-request message to the approval model", async () => {
  let modelCalls = 0
  const { manager, replies } = harness([request("r1", 1)], {
    interpretModel: async () => {
      modelCalls += 1
      return {
        requestIDs: ["r1"],
        decision: "once",
        confidence: 1,
        explanation: "unsafe",
      }
    },
  })

  assert.deepEqual(await manager.onMessage(message("今天天气怎么样")), [])
  assert.equal(modelCalls, 0)
  assert.deepEqual(replies, [])
})
