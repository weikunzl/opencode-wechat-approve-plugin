import assert from "node:assert/strict"
import test from "node:test"

import { WECHAT_DATA_DIR_NAME } from "../dist/store.js"

test("isolates plugin state in the wechat-approve directory", () => {
  assert.equal(WECHAT_DATA_DIR_NAME, "wechat-approve")
})
