import assert from "node:assert/strict"
import test from "node:test"

import { WeChatClient } from "../dist/client.js"

test("restores the last WeChat notification target during initialization", async () => {
  const target = "user@im.wechat"
  const store = {
    loadCredentials: () => ({
      accountId: "bot@im.bot",
      token: "test-token",
      baseUrl: "https://example.invalid",
    }),
    getLastContextTarget: () => target,
  }
  const client = new WeChatClient(store)

  assert.equal(await client.init(), true)
  assert.equal(client.getNotificationTarget(), target)
})
