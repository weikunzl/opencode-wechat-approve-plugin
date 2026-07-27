import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { RuntimeLease } from "../dist/runtime-lease.js"

test("allows only one cross-platform polling owner and transfers after release", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-"))
  const first = new RuntimeLease(root)
  const second = new RuntimeLease(root)

  assert.equal(first.acquire(), true)
  assert.equal(second.acquire(), false)
  first.release()
  assert.equal(second.acquire(), true)
  second.release()
})

test("reclaims a stale lease without relying on flock", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-stale-"))
  writeFileSync(
    join(root, "runtime-lease.json"),
    JSON.stringify({ instanceID: "stale", pid: 999999, heartbeatAt: 1 }),
  )
  const lease = new RuntimeLease(root, { now: () => 100_000, staleAfterMs: 30_000 })

  assert.equal(lease.acquire(), true)
  lease.release()
})

test("reclaims a recent lease immediately when its process no longer exists", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-dead-pid-"))
  writeFileSync(
    join(root, "runtime-lease.json"),
    JSON.stringify({ instanceID: "dead", pid: 999999, heartbeatAt: 99_999 }),
  )
  const lease = new RuntimeLease(root, { now: () => 100_000, staleAfterMs: 30_000 })

  assert.equal(lease.acquire(), true)
  lease.release()
})
