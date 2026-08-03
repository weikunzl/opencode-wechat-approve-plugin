import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("help presents setup as the first-time initialization command", () => {
  // 通过真实 CLI 进程验证帮助文本暴露首次初始化入口。
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url))
  const result = spawnSync(process.execPath, [bin, "help"], { encoding: "utf8" })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /wechat-approve setup/)
  assert.match(result.stdout, /wechat-approve install/)
  assert.match(result.stdout, /wechat-approve rebind-link/)
})
