import assert from "node:assert/strict"
import test from "node:test"

import { buildPromptBody, parsePromptModel } from "../dist/prompt-model.js"

test("parses a configured provider and model identifier", () => {
  assert.deepEqual(parsePromptModel("opencode-go/qwen3.7-max"), {
    providerID: "opencode-go",
    modelID: "qwen3.7-max",
  })
})

test("injects the configured model into forwarded WeChat prompts", () => {
  assert.deepEqual(buildPromptBody("继续", "opencode-go/qwen3.7-max"), {
    model: {
      providerID: "opencode-go",
      modelID: "qwen3.7-max",
    },
    parts: [{ type: "text", text: "继续" }],
  })
})
