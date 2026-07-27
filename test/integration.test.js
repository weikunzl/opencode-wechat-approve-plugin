import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalManager } from "../dist/approval-manager.js"
import { createPluginRuntime } from "../dist/index.js"
import { HttpPermissionAPI } from "../dist/opencode-permissions.js"
import { SessionNotifier } from "../dist/session-notifier.js"
import { WeChatStore } from "../dist/store.js"

function harness() {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-integration-")))
  const pending = []
  const replies = []
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === "/permission" && (init.method ?? "GET") === "GET") {
      return Response.json(pending)
    }
    const match = url.pathname.match(/^\/permission\/([^/]+)\/reply$/)
    if (match && init.method === "POST") {
      const requestID = decodeURIComponent(match[1])
      const body = JSON.parse(init.body)
      replies.push({ requestID, body })
      const index = pending.findIndex((item) => item.id === requestID)
      if (index >= 0) pending.splice(index, 1)
      return Response.json(true)
    }
    return new Response("not found", { status: 404 })
  }
  const api = new HttpPermissionAPI(new URL("http://127.0.0.1:4096"), store, 600_000, fetcher)
  const approvalManager = new ApprovalManager({
    store,
    api,
    approvalTimeoutMs: 600_000,
    modelConfidenceThreshold: 0.85,
    now: () => 100,
  })
  const sessionNotifier = new SessionNotifier(
    store,
    async (sessionID) => ({ title: `title-${sessionID}`, directory: "/workspace/docs" }),
    () => 100,
  )
  const sent = []
  let receive = async () => {}
  const gateway = {
    initialize: async () => "ready",
    flushOutbox: async () => {},
    start: (callback) => {
      receive = callback
    },
    send: async (notice) => sent.push(notice),
    stop: async () => {},
  }
  const runtime = createPluginRuntime({
    gateway,
    approvalManager,
    sessionNotifier,
    timers: {
      setInterval: () => 1,
      clearInterval: () => {},
    },
  })
  return {
    pending,
    replies,
    sent,
    runtime,
    receive: (text) =>
      receive({
        messageID: `msg-${text}`,
        senderID: "owner",
        text,
        receivedAt: 100,
      }),
  }
}

function request(id, project = "/workspace/docs", pattern = "npm test") {
  return {
    id,
    sessionID: `ses-${id}`,
    permission: "bash",
    patterns: [pattern],
    metadata: { directory: project },
    always: [pattern],
  }
}

test("permission list and reply authenticate to a protected OpenCode server", async () => {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-auth-")))
  const authorization = "Basic protected"
  const requests = []
  const api = new HttpPermissionAPI(
    new URL("http://127.0.0.1:4096"),
    store,
    600_000,
    async (_input, init = {}) => {
      requests.push(init)
      return Response.json((init.method ?? "GET") === "GET" ? [] : true)
    },
    authorization,
  )

  await api.list()
  await api.reply("req-1", "once")

  assert.deepEqual(
    requests.map((init) => new Headers(init.headers).get("authorization")),
    [authorization, authorization],
  )
})

for (const [phrase, reply] of [
  ["好的", "once"],
  ["始终允许", "always"],
  ["拒绝", "reject"],
]) {
  test(`integration: ${reply} approval reaches the exact OpenCode request`, async () => {
    const state = harness()
    state.pending.push(request(`req-${reply}`))
    await state.runtime.start()
    await state.runtime.hooks.event({
      event: {
        type: "permission.asked",
        properties: state.pending[0],
      },
    })

    await state.receive(phrase)

    assert.deepEqual(state.replies, [
      { requestID: `req-${reply}`, body: { reply } },
    ])
    assert.match(state.sent.at(-1).text, /Approval result/)
  })
}

test("integration: multiple approvals require clarification before one exact reply", async () => {
  const state = harness()
  state.pending.push(request("req-1", "/workspace/docs"), request("req-2", "C:\\workspace\\api", "git push"))
  await state.runtime.start()

  await state.receive("好的")
  assert.deepEqual(state.replies, [])
  assert.match(state.sent.at(-1).text, /Which approval/)

  await state.receive("第二个")
  assert.deepEqual(state.replies, [
    { requestID: "req-2", body: { reply: "once" } },
  ])
})

test("integration: a failed run emits one error and never a following done", async () => {
  const state = harness()
  await state.runtime.start()

  await state.runtime.hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "ses-fail", status: { type: "busy" } },
    },
  })
  await state.runtime.hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: "ses-fail", error: { data: { message: "provider unavailable" } } },
    },
  })
  await state.runtime.hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses-fail" } },
  })

  assert.equal(state.sent.length, 1)
  assert.match(state.sent[0].text, /provider unavailable/)
  assert.doesNotMatch(state.sent[0].text, /\[Done\]/)
})

test("integration: ordinary text with no pending approval is isolated", async () => {
  const state = harness()
  await state.runtime.start()

  await state.receive("继续完成刚才的任务")

  assert.deepEqual(state.replies, [])
  assert.deepEqual(state.sent, [])
})
