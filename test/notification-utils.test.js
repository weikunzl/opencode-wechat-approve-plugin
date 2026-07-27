import assert from "node:assert/strict"
import test from "node:test"

import { formatError, SessionNotificationState } from "../dist/notification-utils.js"

test("formats structured errors without object coercion", () => {
  assert.equal(formatError({ name: "ProviderError", message: "Model unavailable" }), "Model unavailable")
  assert.equal(
    formatError({ name: "UnknownError", data: { message: "Model not found: provider/model" } }),
    "Model not found: provider/model",
  )
  assert.equal(formatError({ code: "MODEL_NOT_FOUND", provider: "opencode" }), '{"code":"MODEL_NOT_FOUND","provider":"opencode"}')
})

test("suppresses duplicate errors and the following idle notification", () => {
  const state = new SessionNotificationState()
  assert.equal(state.markFailed("ses_failed"), true)
  assert.equal(state.markFailed("ses_failed"), false)

  assert.equal(state.shouldNotifyDone("ses_failed"), false)
  assert.equal(state.markFailed("ses_failed"), true)
  assert.equal(state.shouldNotifyDone("ses_failed"), false)
  assert.equal(state.shouldNotifyDone("ses_failed"), true)
  assert.equal(state.shouldNotifyDone("ses_ok"), true)
})
