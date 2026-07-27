import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { SessionNotifier } from "../dist/session-notifier.js"
import { WeChatStore } from "../dist/store.js"

function harness() {
  const store = new WeChatStore(mkdtempSync(join(tmpdir(), "wechat-session-notifier-")))
  const notifier = new SessionNotifier(
    store,
    async (sessionID) => ({
      title: sessionID === "ses_1" ? "插件实现" : sessionID,
      directory: "/workspace/docs",
    }),
    () => 100,
  )
  return { notifier, store }
}

const status = (sessionID, type) => ({
  type: "session.status",
  properties: { sessionID, status: { type } },
})
const idle = (sessionID) => ({ type: "session.idle", properties: { sessionID } })
const error = (sessionID, value) => ({
  type: "session.error",
  properties: { sessionID, error: value },
})

test("notifies exactly once for a busy to idle transition", async () => {
  const { notifier, store } = harness()

  await notifier.handle(status("ses_1", "busy"))
  const first = await notifier.handle(idle("ses_1"))
  const duplicate = await notifier.handle(idle("ses_1"))

  assert.equal(first.length, 1)
  assert.equal(duplicate.length, 0)
  assert.match(first[0].text, /插件实现/)
  assert.match(first[0].text, /ses_1/)
  assert.match(first[0].text, /\/workspace\/docs/)
  assert.deepEqual(store.loadOutbox().map((item) => item.id), [first[0].id])
})

test("failure suppresses the following idle success and deduplicates errors", async () => {
  const { notifier } = harness()
  const nested = {
    name: "UnknownError",
    data: { message: "Model not found\n    at internal" },
  }

  await notifier.handle(status("ses_1", "busy"))
  const failed = await notifier.handle(error("ses_1", nested))
  const duplicate = await notifier.handle(error("ses_1", nested))
  const afterFailure = await notifier.handle(idle("ses_1"))

  assert.equal(failed.length, 1)
  assert.match(failed[0].text, /Model not found/)
  assert.doesNotMatch(failed[0].text, /at internal/)
  assert.equal(duplicate.length, 0)
  assert.equal(afterFailure.length, 0)
})

test("serializes concurrent error and idle events so failure cannot become done", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-session-notifier-race-"))
  const store = new WeChatStore(root)
  let resolveMetadata
  let metadataCalls = 0
  const metadata = new Promise((resolve) => {
    resolveMetadata = resolve
  })
  const notifier = new SessionNotifier(
    store,
    async () => {
      metadataCalls += 1
      return metadata
    },
    () => 100,
  )
  await notifier.handle(status("ses-race", "busy"))

  const failedPromise = notifier.handle(
    error("ses-race", {
      name: "UnknownError",
      data: { message: "Model not found" },
    }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  const idlePromise = notifier.handle(idle("ses-race"))
  await new Promise((resolve) => setImmediate(resolve))
  resolveMetadata({ title: "race", directory: "/workspace/docs" })

  const [failed, afterFailure] = await Promise.all([failedPromise, idlePromise])

  assert.equal(metadataCalls, 1)
  assert.equal(failed[0].kind, "error")
  assert.deepEqual(afterFailure, [])
  assert.equal(
    store.loadOutbox().some((notice) => notice.kind === "done"),
    false,
  )
})

test("a slow metadata lookup in one session does not block another session", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-session-notifier-independent-"))
  const store = new WeChatStore(root)
  let resolveSlowMetadata
  const slowMetadata = new Promise((resolve) => {
    resolveSlowMetadata = resolve
  })
  const notifier = new SessionNotifier(
    store,
    async (sessionID) =>
      sessionID === "ses-slow"
        ? slowMetadata
        : { title: sessionID, directory: "/workspace/fast" },
    () => 100,
  )
  await notifier.handle(status("ses-slow", "busy"))
  const slowCompletion = notifier.handle(idle("ses-slow"))
  await new Promise((resolve) => setImmediate(resolve))

  const fastResult = await Promise.race([
    notifier.handle(status("ses-fast", "busy")),
    new Promise((resolve) => setImmediate(() => resolve("blocked"))),
  ])

  assert.deepEqual(fastResult, [])
  resolveSlowMetadata({ title: "slow", directory: "/workspace/slow" })
  await slowCompletion
})

test("bounds session metadata lookup time before falling back", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-session-notifier-timeout-"))
  const store = new WeChatStore(root)
  const notifier = new SessionNotifier(
    store,
    async () => new Promise(() => {}),
    () => 100,
    () => false,
    10,
  )
  await notifier.handle(status("ses-timeout", "busy"))

  const notices = await notifier.handle(idle("ses-timeout"))

  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /ses-timeout/)
})

test("reports an aborted run as cancelled rather than failed or done", async () => {
  const { notifier } = harness()

  await notifier.handle(status("ses_1", "busy"))
  const notices = await notifier.handle(
    error("ses_1", { name: "MessageAbortedError", data: { message: "aborted" } }),
  )

  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, "cancelled")
  assert.match(notices[0].text, /Cancelled/)
  assert.equal((await notifier.handle(idle("ses_1"))).length, 0)
})

test("restores busy state and increments run number on the next run", async () => {
  const { notifier, store } = harness()
  await notifier.handle(status("ses_1", "busy"))

  const restored = new SessionNotifier(store, async () => ({ title: "x", directory: "/x" }), () => 200)
  await restored.handle(idle("ses_1"))
  await restored.handle(status("ses_1", "busy"))

  assert.equal(restored.snapshot()[0].run, 2)
})

test("ignores lifecycle events from internal approval interpreter sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-session-notifier-internal-"))
  const store = new WeChatStore(root)
  const notifier = new SessionNotifier(
    store,
    async () => ({ title: "internal", directory: "/workspace" }),
    () => 100,
    (sessionID) => sessionID === "ses-internal",
  )

  assert.deepEqual(
    await notifier.handle({
      type: "session.status",
      properties: { sessionID: "ses-internal", status: { type: "busy" } },
    }),
    [],
  )
  assert.deepEqual(
    await notifier.handle({
      type: "session.idle",
      properties: { sessionID: "ses-internal" },
    }),
    [],
  )
  assert.deepEqual(notifier.snapshot(), [])
})

test("uses session.updated metadata for sessions attached from another project", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-session-notifier-attached-"))
  const store = new WeChatStore(root)
  const notifier = new SessionNotifier(
    store,
    async () => {
      throw new Error("not available through the startup project client")
    },
    () => 100,
  )

  await notifier.handle({
    type: "session.updated",
    properties: {
      info: {
        id: "ses-attached",
        title: "Attached API task",
        directory: "C:\\workspace\\api",
      },
    },
  })
  await notifier.handle({
    type: "session.status",
    properties: { sessionID: "ses-attached", status: { type: "busy" } },
  })
  const notices = await notifier.handle({
    type: "session.idle",
    properties: { sessionID: "ses-attached" },
  })

  assert.match(notices[0].text, /Attached API task/)
  assert.match(notices[0].text, /C:\\workspace\\api/)
})
