import assert from "node:assert/strict"
import test from "node:test"

import { formatStatusMessage, WECHAT_STATUS_EMOTICONS } from "../dist/status-message.js"

test("maps OpenCode states to WeChat image emoticon shortcuts", () => {
  assert.deepEqual(WECHAT_STATUS_EMOTICONS, {
    done: "[庆祝]",
    error: "[苦涩]",
    approval: "[让我看看]",
    approved: "[好的]",
    rejected: "[NO]",
    timeout: "[叹气]",
    warning: "[汗]",
    help: "[机智]",
  })
})

test("prefixes a status message with one WeChat shortcut", () => {
  assert.equal(
    formatStatusMessage("done", "[Done] Build\nAI task completed."),
    "[庆祝] [Done] Build\nAI task completed.",
  )
})

test("falls back to the warning shortcut for an unknown state", () => {
  assert.equal(formatStatusMessage("unknown", "Unexpected state"), "[汗] Unexpected state")
})
