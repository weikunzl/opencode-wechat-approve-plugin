import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ApprovalManager } from "../dist/approval-manager.js"
import { createPluginRuntime } from "../dist/index.js"
import { WeChatStore } from "../dist/store.js"

function createGateway() {
  let receive = async () => {}
  const sent = []
  return {
    sent,
    receive: (text) =>
      receive({
        messageID: `msg-${text}`,
        senderID: "owner@im.wechat",
        text,
        receivedAt: 100,
      }),
    initialize: async () => "ready",
    flushOutbox: async () => {},
    start: (callback) => {
      receive = callback
    },
    send: async (notice) => {
      sent.push(notice)
    },
  }
}

function createHarness() {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-plugin-")))
  const modelCalls = []
  const permissionAPI = {
    list: async () => [],
    reply: async () => true,
  }
  const approvalManager = new ApprovalManager({
    store,
    api: permissionAPI,
    approvalTimeoutMs: 600_000,
    modelConfidenceThreshold: 0.85,
    interpretModel: async (...args) => {
      modelCalls.push(args)
      return { requestIDs: [], decision: "clarify", confidence: 0, explanation: "unused" }
    },
  })
  const gateway = createGateway()
  const sessionNotifier = { handle: async () => [] }
  const runtime = createPluginRuntime({ gateway, approvalManager, sessionNotifier })
  return { runtime, gateway, modelCalls }
}

test("ordinary WeChat text never invokes approval model or emits a notification", async () => {
  const { runtime, gateway, modelCalls } = createHarness()
  await runtime.start()

  await gateway.receive("今天天气怎么样")

  assert.deepEqual(modelCalls, [])
  assert.deepEqual(gateway.sent, [])
})

test("exposes no general-purpose WeChat AI tools or permission interception hook", () => {
  const { runtime } = createHarness()

  assert.equal(runtime.hooks.tool, undefined)
  assert.equal(runtime.hooks["permission.ask"], undefined)
})
