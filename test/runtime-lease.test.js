import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
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

test("quarantines a corrupt lease and acquires a fresh one", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-corrupt-"))
  writeFileSync(join(root, "runtime-lease.json"), "{")
  const lease = new RuntimeLease(root)

  assert.equal(lease.acquire(), true)
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, "runtime-lease.json"), "utf8")))
  assert.equal(
    readdirSync(root).some((name) => name.startsWith("runtime-lease.json.corrupt-")),
    true,
  )
  lease.release()
})

test("never takes over a stale lease owned by a live process", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-live-"))
  writeFileSync(
    join(root, "runtime-lease.json"),
    JSON.stringify({ instanceID: "live", pid: process.pid, heartbeatAt: 1 }),
  )
  const lease = new RuntimeLease(root, { now: () => 100_000, staleAfterMs: 30_000 })

  assert.equal(lease.acquire(), false)
})

test("reclaims a lease when the pid belongs to a different process start", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-pid-reuse-"))
  writeFileSync(
    join(root, "runtime-lease.json"),
    JSON.stringify({
      instanceID: "crashed-owner",
      pid: process.pid,
      processStart: "different-process-start",
      heartbeatAt: Date.now(),
    }),
  )
  const lease = new RuntimeLease(root)

  assert.equal(lease.acquire(), true)
  lease.release()
})

test("reports lease loss after another owner replaces the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-loss-"))
  let lost = false
  const lease = new RuntimeLease(root, { heartbeatIntervalMs: 10 })
  lease.setOnLost(() => {
    lost = true
  })
  assert.equal(lease.acquire(), true)
  writeFileSync(
    join(root, "runtime-lease.json"),
    JSON.stringify({ instanceID: "replacement", pid: process.pid, heartbeatAt: Date.now() }),
  )

  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(lost, true)
  lease.release()
})
