import assert from "node:assert/strict"
import test from "node:test"

import { formatStatusMessage, WECHAT_STATUS_EMOTICONS } from "../dist/status-message.js"

test("maps OpenCode states to WeChat image emoticon shortcuts", () => {
  assert.deepEqual(WECHAT_STATUS_EMOTICONS, {
    done: "🎉",
    error: "😞",
    cancelled: "🛑",
    approval: "👀",
    approved: "👍",
    rejected: "👎",
    timeout: "⏰",
    warning: "⚠️",
    help: "💡",
  })
})

test("prefixes a status message with one WeChat shortcut", () => {
  assert.equal(
    formatStatusMessage("done", "[Done] Build\nAI task completed."),
    "🎉 [Done] Build\nAI task completed.",
  )
})

test("falls back to the warning shortcut for an unknown state", () => {
  assert.equal(formatStatusMessage("unknown", "Unexpected state"), "⚠️ Unexpected state")
})
