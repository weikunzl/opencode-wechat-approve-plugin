import assert from "node:assert/strict"
import test from "node:test"

import { interpretWithModel } from "../dist/model-interpreter.js"

const MODEL_CONFIDENCE_THRESHOLD = 0.85
const PENDING_APPROVALS = [
  {
    requestID: "r1",
    sessionID: "ses_1",
    code: 1,
    permission: "bash",
    patterns: ["npm test"],
    project: "/workspace/docs",
    createdAt: 1,
    expiresAt: 999,
  },
  {
    requestID: "r2",
    sessionID: "ses_2",
    code: 2,
    permission: "bash",
    patterns: ["git push origin main"],
    project: "/workspace/api",
    createdAt: 2,
    expiresAt: 999,
  },
]
const SINGLE_PENDING_APPROVALS = [PENDING_APPROVALS[0]]

function fakeModelFor(sourceText, pending, candidate) {
  // 固定模型只检查提示词边界并返回预设结果，避免依赖外部模型服务。
  return {
    complete: async (prompt) => {
      assert.ok(prompt.includes(`用户回复: ${JSON.stringify(sourceText)}`))
      for (const request of pending) {
        assert.ok(prompt.includes(`"requestID":"${request.requestID}"`))
      }
      for (const request of PENDING_APPROVALS.filter((item) => !pending.includes(item))) {
        assert.ok(!prompt.includes(`"requestID":"${request.requestID}"`))
      }
      return candidate
    },
  }
}

async function interpret(sourceText, candidate, pending = PENDING_APPROVALS) {
  // 所有语义转述都经过同一个安全校验入口。
  return interpretWithModel(
    sourceText,
    pending,
    MODEL_CONFIDENCE_THRESHOLD,
    fakeModelFor(sourceText, pending, candidate),
  )
}

test("maps a natural single-request paraphrase to once", async () => {
  // 单请求自然转述必须保留真实 request ID 和一次性决定。
  const result = await interpret(
    "帮我把刚才的 npm test 放行一下",
    {
      requestIDs: ["r1"],
      decision: "once",
      confidence: 0.96,
      explanation: "用户指向 npm test 的本次操作",
    },
    SINGLE_PENDING_APPROVALS,
  )

  assert.deepEqual(result, {
    requestIDs: ["r1"],
    decision: "once",
    confidence: 0.96,
    explanation: "用户指向 npm test 的本次操作",
  })
})

test("does not let a target-only paraphrase establish authorization", async () => {
  // 模型可以解释目标，但没有明确授权词时不能自行生成 once。
  const result = await interpret("把那个执行一下", {
    requestIDs: ["r1"],
    decision: "once",
    confidence: 0.99,
    explanation: "模型猜测用户想执行",
  }, SINGLE_PENDING_APPROVALS)

  assert.equal(result.decision, "clarify")
  assert.deepEqual(result.requestIDs, [])
})

test("maps a natural multi-request target paraphrase to one request", async () => {
  // 多请求转述只能授权模型明确返回的目标，不能顺带授权其他请求。
  const result = await interpret("docs 项目的 npm test 可以先放行", {
    requestIDs: ["r1"],
    decision: "once",
    confidence: 0.94,
    explanation: "用户只指向 docs 项目",
  })

  assert.deepEqual(result.requestIDs, ["r1"])
  assert.equal(result.decision, "once")
})

test("accepts explicit persistent authorization semantics", async () => {
  // 持久授权必须同时出现在用户原话和模型决定中。
  const result = await interpret("以后 docs 项目的这类操作都始终允许", {
    requestIDs: ["r1"],
    decision: "always",
    confidence: 0.99,
    explanation: "用户明确表达持久授权",
  })

  assert.equal(result.decision, "always")
  assert.deepEqual(result.requestIDs, ["r1"])
})

test("clarifies ambiguous paraphrase instead of granting", async () => {
  // 没有明确允许、持久允许或拒绝语义时，模型不能建立授权。
  const result = await interpret("刚才那个要怎么处理？", {
    requestIDs: ["r1"],
    decision: "once",
    confidence: 1,
    explanation: "模型猜测用户想允许",
  })

  assert.equal(result.decision, "clarify")
  assert.deepEqual(result.requestIDs, [])
})

test("rejects model escalation for negation and questions", async () => {
  // 否定和疑问原话即使被模型误判为允许，也必须被安全校验拦截。
  for (const sourceText of ["不要放行这个操作", "这个操作可以吗？"]) {
    const result = await interpret(sourceText, {
      requestIDs: ["r1"],
      decision: "once",
      confidence: 1,
      explanation: "不安全的允许猜测",
    })

    assert.equal(result.decision, "clarify", sourceText)
    assert.deepEqual(result.requestIDs, [], sourceText)
  }
})

test("rejects an unknown request ID from the model", async () => {
  // 模型不能伪造不在当前 pending 快照中的 request ID。
  const result = await interpret("允许刚才这个操作", {
    requestIDs: ["unknown"],
    decision: "once",
    confidence: 1,
    explanation: "未知请求",
  })

  assert.equal(result.decision, "clarify")
  assert.deepEqual(result.requestIDs, [])
})
