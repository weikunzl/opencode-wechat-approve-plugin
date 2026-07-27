import assert from "node:assert/strict"
import test from "node:test"

import { formatError } from "../dist/notification-utils.js"

test("formats structured errors without object coercion", () => {
  assert.equal(formatError({ name: "ProviderError", message: "Model unavailable" }), "Model unavailable")
  assert.equal(
    formatError({ name: "UnknownError", data: { message: "Model not found: provider/model" } }),
    "Model not found: provider/model",
  )
  assert.equal(formatError({ code: "MODEL_NOT_FOUND", provider: "opencode" }), '{"code":"MODEL_NOT_FOUND","provider":"opencode"}')
})
