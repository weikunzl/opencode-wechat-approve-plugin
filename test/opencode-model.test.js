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

test("uses a temporary tool-disabled structured session and deletes it", async () => {
  const requests = []
  const internal = new Set()
  const fetcher = async (input, init = {}) => {
    const url = String(input)
    requests.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    })
    if (new URL(url).pathname === "/session") {
      return new Response('{"id":"ses-internal"}', { status: 200 })
    }
    if (url.includes("/message")) {
      return new Response(
        JSON.stringify({
          info: {
            structured: {
              requestIDs: ["req-1"],
              decision: "once",
              confidence: 0.97,
              explanation: "明确允许 npm test",
            },
          },
          parts: [],
        }),
        { status: 200 },
      )
    }
    return new Response("true", { status: 200 })
  }
  const model = new OpenCodeApprovalModel({
    serverURL: new URL("http://127.0.0.1:4096"),
    directory: "C:\\workspace\\docs",
    model: "opencode-go/qwen3.7-max",
    authorization: "Basic protected",
    fetcher,
    onInternalSession: (id, active) => {
      if (active) internal.add(id)
      else internal.delete(id)
    },
  })

  const result = await model.interpret("docs 项目的可以", pending, 0.85)

  assert.equal(result.decision, "once")
  assert.deepEqual(result.requestIDs, ["req-1"])
  assert.equal(requests[0].method, "POST")
  assert.equal(
    requests.every((request) => new Headers(request.headers).get("authorization") === "Basic protected"),
    true,
  )
  assert.deepEqual(requests[1].body.model, {
    providerID: "opencode-go",
    modelID: "qwen3.7-max",
  })
  assert.deepEqual(requests[1].body.tools, {})
  assert.equal(requests[1].body.format.type, "json_schema")
  assert.equal(requests.at(-1).method, "DELETE")
  assert.deepEqual([...internal], [])
})

test("returns clarification and still deletes the internal session when the model fails", async () => {
  const methods = []
  const fetcher = async (input, init = {}) => {
    methods.push(init.method ?? "GET")
    if (new URL(String(input)).pathname === "/session") {
      return new Response('{"id":"ses-internal"}', { status: 200 })
    }
    if ((init.method ?? "GET") === "DELETE") return new Response("true", { status: 200 })
    return new Response('{"error":"provider unavailable"}', { status: 500 })
  }
  const model = new OpenCodeApprovalModel({
    serverURL: new URL("http://127.0.0.1:4096"),
    directory: "/workspace/docs",
    model: "opencode-go/qwen3.7-max",
    fetcher,
  })

  const result = await model.interpret("那个可以", pending, 0.85)

  assert.equal(result.decision, "clarify")
  assert.equal(methods.at(-1), "DELETE")
})
