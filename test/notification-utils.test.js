import assert from "node:assert/strict"
import test from "node:test"

import { formatError, SessionNotificationState } from "../dist/notification-utils.js"

test("formats structured errors without object coercion", () => {
  assert.equal(formatError({ name: "ProviderError", message: "Model unavailable" }), "Model unavailable")
  assert.equal(formatError({ code: "MODEL_NOT_FOUND", provider: "opencode" }), '{"code":"MODEL_NOT_FOUND","provider":"opencode"}')
})

test("suppresses the first idle notification after a session error", () => {
  const state = new SessionNotificationState()
  state.markFailed("ses_failed")

  assert.equal(state.shouldNotifyDone("ses_failed"), false)
  assert.equal(state.shouldNotifyDone("ses_failed"), true)
  assert.equal(state.shouldNotifyDone("ses_ok"), true)
})
