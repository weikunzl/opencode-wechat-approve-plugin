import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalManager } from "../dist/approval-manager.js"
import { WeChatStore } from "../dist/store.js"

function request(id, code, project = "/workspace/docs", patterns = ["npm test"], createdAt = code) {
  return {
    requestID: id,
    sessionID: `ses_${code}`,
    code,
    permission: "bash",
    patterns,
    project,
    createdAt,
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

test("applies all-request decisions for Chinese and English all forms", async () => {
  for (const [text, decision] of [
    ["全部允许", "once"],
    ["全部始终允许", "always"],
    ["全部always", "always"],
    ["全部 always", "always"],
    ["all always", "always"],
    ["全部拒绝", "reject"],
    ["全部 deny", "reject"],
    ["全部 reject", "reject"],
    ["all allow", "once"],
  ]) {
    const { manager, replies, api } = harness([request("r1", 1), request("r2", 2)])

    await manager.onMessage(message(text))

    assert.deepEqual(replies, [
      ["r1", decision],
      ["r2", decision],
    ], text)
    assert.deepEqual(api.pending, [], text)
  }
})

test("preserves the original ordinal snapshot across multiple partial replies", async () => {
  const { manager, replies, store } = harness([
    request("r3", 3, "/workspace/third", ["third"], 300),
    request("r1", 1, "/workspace/first", ["first"], 100),
    request("r2", 2, "/workspace/second", ["second"], 200),
  ])

  const first = await manager.onMessage(message("第一个允许"))
  assert.deepEqual(replies, [["r1", "once"]])
  assert.match(first.map((item) => item.text).join("\n"), /还有 2 个待审批请求/)
  assert.deepEqual(store.loadConversation().requestIDs, ["r1", "r2", "r3"])
  assert.equal(store.loadConversation().selectionOnly, true)

  await manager.onMessage(message("第二个拒绝"))

  assert.deepEqual(replies, [
    ["r1", "once"],
    ["r2", "reject"],
  ])
  assert.deepEqual(store.loadPendingApprovals().map((item) => item.requestID), ["r3"])
  assert.equal(store.loadConversation().selectionOnly, true)
})

test("keeps a partial ordinal snapshot when OpenCode emits the applied reply", async () => {
  const { manager, store } = harness([request("r1", 1), request("r2", 2), request("r3", 3)])

  await manager.onMessage(message("第一个允许"))
  await manager.onPermissionReplied({
    type: "permission.replied",
    properties: { sessionID: "ses_1", requestID: "r1", reply: "once" },
  })

  assert.equal(store.loadConversation().selectionOnly, true)
  assert.deepEqual(store.loadConversation().requestIDs, ["r1", "r2", "r3"])
})

test("does not inherit a previous partial decision for a bare ordinal", async () => {
  let modelCalls = 0
  const { manager, replies } = harness([request("r1", 1), request("r2", 2)], {
    interpretModel: async () => {
      modelCalls += 1
      return { requestIDs: [], decision: "clarify", confidence: 0, explanation: "unclear" }
    },
  })

  await manager.onMessage(message("第一个允许"))
  const notices = await manager.onMessage(message("第二个"))

  assert.equal(modelCalls, 1)
  assert.deepEqual(replies, [["r1", "once"]])
  assert.match(notices.map((item) => item.text).join("\n"), /Approval unclear/)
})

test("a duplicate reply after the queue is empty is ignored", async () => {
  const { manager, replies } = harness([request("r1", 1)])

  await manager.onMessage(message("允许"))
  await manager.onMessage(message("允许"))

  assert.deepEqual(replies, [["r1", "once"]])
})

test("a once batch does not authorize a later request", async () => {
  const { manager, replies, api } = harness([request("r1", 1), request("r2", 2)])

  await manager.onMessage(message("全部允许"))
  api.pending = [request("r3", 3)]
  const notices = await manager.onPermissionAsked({
    type: "permission.asked",
    properties: {
      id: "r3",
      sessionID: "ses_3",
      permission: "bash",
      patterns: ["new command"],
      metadata: { directory: "/workspace/docs" },
    },
  })

  assert.deepEqual(replies, [["r1", "once"], ["r2", "once"]])
  assert.match(notices[0].text, /Approval #1/)
  assert.deepEqual((await manager.onMessage(message("拒绝"))).map((item) => item.kind), ["approval-result"])
  assert.deepEqual(replies, [["r1", "once"], ["r2", "once"], ["r3", "reject"]])
})

test("applies mixed ordinal decisions in created-at order", async () => {
  const { manager, replies } = harness([
    request("later", 1, "/workspace/later", ["later"], 200),
    request("earlier", 2, "/workspace/earlier", ["earlier"], 100),
  ])

  await manager.onMessage(message("第一个允许、第二个拒绝"))

  assert.deepEqual(replies, [
    ["earlier", "once"],
    ["later", "reject"],
  ])
})

test("asks for the remaining request after a partial decision", async () => {
  const { manager, replies, api } = harness([request("r1", 1), request("r2", 2)])

  const notices = await manager.onMessage(message("第一个允许"))

  assert.deepEqual(replies, [["r1", "once"]])
  assert.match(notices.map((item) => item.text).join("\n"), /还有 1 个待审批请求/)

  await manager.onMessage(message("拒绝"))

  assert.deepEqual(replies, [
    ["r1", "once"],
    ["r2", "reject"],
  ])
  assert.deepEqual(api.pending, [])
})

test("queues a new approval notification before returning it", async () => {
  const { manager, store } = harness([])
  const notices = await manager.onPermissionAsked({
    type: "permission.asked",
    properties: {
      id: "r-new",
      sessionID: "ses-new",
      permission: "bash",
      patterns: ["npm test"],
      metadata: { directory: "/workspace/docs" },
    },
  })

  assert.deepEqual(store.loadOutbox().map((item) => item.id), [notices[0].id])
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

test("keeps local approvals when authoritative reconciliation fails", async () => {
  const { manager, store, api, replies } = harness([request("r1", 1)])
  api.list = async () => { throw new Error("authority unavailable") }

  const notices = await manager.reconcile()

  assert.deepEqual(store.loadPendingApprovals().map((item) => item.requestID), ["r1"])
  assert.deepEqual(replies, [])
  assert.match(notices[0].text, /Approval sync unavailable/)
})

test("ignores ordinary text when no approval is pending", async () => {
  const { manager, replies } = harness([])

  assert.deepEqual(await manager.onMessage(message("今天天气怎么样")), [])
  assert.deepEqual(replies, [])
})

test("sends an unrecognized pending-request message to the approval model", async () => {
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

  const notices = await manager.onMessage(message("今天天气怎么样"))
  assert.equal(modelCalls, 1)
  assert.match(notices[0].text, /Approval unclear/)
  assert.deepEqual(replies, [])
})
