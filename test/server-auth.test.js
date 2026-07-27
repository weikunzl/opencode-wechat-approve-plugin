import assert from "node:assert/strict"
import test from "node:test"

import { openCodeAuthorization } from "../dist/server-auth.js"

test("builds OpenCode Basic auth from process-style environment values", () => {
  assert.equal(
    openCodeAuthorization({
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_SERVER_USERNAME: "wechat-user",
    }),
    `Basic ${Buffer.from("wechat-user:secret").toString("base64")}`,
  )
  assert.equal(
    openCodeAuthorization({ OPENCODE_SERVER_PASSWORD: "secret" }),
    `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
  )
  assert.equal(openCodeAuthorization({}), null)
})
