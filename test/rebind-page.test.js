import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { RebindPageStore } from "../dist/rebind-page.js"
import {
  RebindSchemaVersion,
  RebindStatus,
  defaultRebindState,
} from "../dist/rebind-state.js"
import { WeChatStore } from "../dist/store.js"

const PAGE_ID = "0123456789abcdef0123456789abcdef"

function pageHarness() {
  const root = mkdtempSync(join(tmpdir(), "wechat-rebind-page-"))
  const pages = new RebindPageStore({
    directory: root,
    now: () => 1_000,
    randomID: () => PAGE_ID,
    renderQRCode: async () => "<svg data-test=\"qr\"></svg>",
  })
  return { pages, root }
}

test("creates an offline owner-only QR page and exposes a file link", async () => {
  // 页面内容与 URL 都不能暴露原始二维码值或加载远程资源。
  const { pages } = pageHarness()
  const page = await pages.create({ qrContent: "secret-qr", expiresAt: 61_000 })
  const html = readFileSync(page.filePath, "utf8")

  assert.match(page.url, /^file:/)
  assert.doesNotMatch(page.url, /secret-qr/)
  assert.doesNotMatch(html, /secret-qr|<script[^>]+src=|<img[^>]+src=["']https?:/i)
  assert.match(html, /<svg data-test="qr"><\/svg>/)
  if (process.platform !== "win32") {
    assert.equal(statSync(dirname(page.filePath)).mode & 0o777, 0o700)
    assert.equal(statSync(page.filePath).mode & 0o777, 0o600)
  }
})

test("resolves only an unexpired descriptor whose page still exists", async () => {
  const { pages } = pageHarness()
  const page = await pages.create({ qrContent: "secret-qr", expiresAt: 61_000 })
  const state = {
    schemaVersion: RebindSchemaVersion.V1,
    status: RebindStatus.QrReady,
    startedAt: 1_000,
    expiresAt: 61_000,
    pageFileName: page.fileName,
    bindingGenerationDigest: "a".repeat(64),
  }

  assert.equal(pages.resolveLink(state)?.url, page.url)
  pages.removeCurrent(state)
  assert.equal(existsSync(page.filePath), false)
  assert.equal(pages.resolveLink(state), null)
})

test("rejects corrupt rebind descriptors without exposing a link", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-rebind-state-"))
  const store = new WeChatStore(root)
  const file = join(root, "rebind-v1.json")
  const invalid = {
    ...defaultRebindState(),
    status: RebindStatus.QrReady,
    startedAt: 1,
    expiresAt: 2,
    pageFileName: "../secret",
    bindingGenerationDigest: "a".repeat(64),
  }
  writeFileSync(file, JSON.stringify(invalid))

  assert.deepEqual(store.loadRebindState(), defaultRebindState())
  assert.equal(readdirSync(root).some((name) => name.startsWith("rebind-v1.json.corrupt-")), true)
})

test("round trips and clears a valid redacted rebind descriptor", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-rebind-state-"))
  const store = new WeChatStore(root)
  const state = {
    schemaVersion: RebindSchemaVersion.V1,
    status: RebindStatus.AwaitingContext,
    startedAt: 1_000,
    expiresAt: 61_000,
    pageFileName: null,
    bindingGenerationDigest: "b".repeat(64),
  }

  store.saveRebindState(state)
  assert.deepEqual(store.loadRebindState(), state)
  store.clearRebindState()
  assert.deepEqual(store.loadRebindState(), defaultRebindState())
})
