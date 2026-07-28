import assert from "node:assert/strict"
import test from "node:test"

import { OpenCodeApprovalModel } from "../dist/opencode-model.js"

const pending = [
  {
    requestID: "req-1",
    sessionID: "ses-user",
    code: 1,
    permission: "bash",
    patterns: ["npm test"],
    project: "C:\\workspace\\docs",
    createdAt: 1,
    expiresAt: 1000,
  },
]

test("parses a JSON text response without sending an unsupported output format", async () => {
  const requests = []
  const internal = new Set()
  const client = {
    session: {
      create: async (options) => { requests.push(["create", options]); return { data: { id: "ses-internal" } } },
      prompt: async (options) => {
        requests.push(["prompt", options])
        return { data: { parts: [{ type: "text", text: '{"requestIDs":["req-1"],"decision":"once","confidence":0.97,"explanation":"明确允许 npm test"}' }] } }
      },
      delete: async (options) => { requests.push(["delete", options]); return { data: true } },
    },
  }
  const model = new OpenCodeApprovalModel({
    client,
    directory: "C:\\workspace\\docs",
    model: "opencode-go/qwen3.7-max",
    onInternalSession: (id, active) => {
      if (active) internal.add(id)
      else internal.delete(id)
    },
  })

  const result = await model.interpret("docs 项目的可以", pending, 0.85)

  assert.equal(result.decision, "once")
  assert.deepEqual(result.requestIDs, ["req-1"])
  assert.deepEqual(requests[1][1].body.model, {
    providerID: "opencode-go",
    modelID: "qwen3.7-max",
  })
  assert.deepEqual(requests[1][1].body.tools, {})
  assert.equal("format" in requests[1][1].body, false)
  assert.equal(requests.at(-1)[0], "delete")
  assert.deepEqual([...internal], [])
})

test("returns clarification and still deletes the internal session when the model fails", async () => {
  const methods = []
  const client = {
    session: {
      create: async () => ({ data: { id: "ses-internal" } }),
      prompt: async () => { methods.push("prompt"); throw new Error("provider unavailable") },
      delete: async () => { methods.push("delete"); return { data: true } },
    },
  }
  const model = new OpenCodeApprovalModel({
    client,
    directory: "/workspace/docs",
    model: "opencode-go/qwen3.7-max",
  })

  const result = await model.interpret("那个可以", pending, 0.85)

  assert.equal(result.decision, "clarify")
  assert.equal(methods.at(-1), "delete")
})

test("uses the injected OpenCode client for model sessions", async () => {
  const calls = []
  const client = {
    session: {
      create: async (options) => { calls.push(["create", options]); return { data: { id: "ses-sdk" } } },
      prompt: async (options) => {
        calls.push(["prompt", options])
        return { data: { parts: [{ type: "text", text: '{"requestIDs":["req-1"],"decision":"once","confidence":0.97,"explanation":"ok"}' }] } }
      },
      delete: async (options) => { calls.push(["delete", options]); return { data: true } },
    },
  }
  const model = new OpenCodeApprovalModel({
    client,
    directory: "/workspace/docs",
    model: "opencode-go/qwen3.7-max",
  })

  const result = await model.interpret("允许", pending, 0.85)

  assert.equal(result.decision, "once")
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "prompt", "delete"])
})
