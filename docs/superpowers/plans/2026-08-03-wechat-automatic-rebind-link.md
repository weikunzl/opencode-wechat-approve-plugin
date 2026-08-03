# WeChat Automatic Rebind Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically recover a stale WeChat context when possible and otherwise expose an expiring, owner-only browser QR link that lets the user rebind without restarting OpenCode.

**Architecture:** A focused `RebindCoordinator` owned by the Gateway Leader manages the context-refresh grace period and forced bind lifecycle. A separate page store renders an offline QR HTML file and persists only a redacted descriptor; `TransportHealthSupervisor` supplies failure and recovery signals, while OpenCode Toast, CLI, and doctor expose actionable status.

**Tech Stack:** TypeScript ESM, Node.js 20+, `node:test`, OpenCode SDK `client.tui.showToast`, `qrcode` SVG rendering, existing JSON file store and Gateway Leader lease.

## Global Constraints

- Do not start an HTTP listener, OpenCode server, daemon, or system service.
- Never log or persist the QR payload separately, token, context token, user ID, or complete iLink response.
- The rebind directory is `0700`; the HTML page and descriptor are `0600` where the platform supports POSIX modes.
- Only the current Gateway Leader may create a QR session, and one binding generation may own at most one page.
- A non-`-14` `prepare failed` waits 60 seconds for an inbound context refresh; `-14` starts rebind immediately.
- Existing `wechat-approve bind`, `setup`, and `install` remain backward compatible.
- Use strict TypeScript, ESM `.js` imports, two-space indentation, double quotes, no semicolons, Chinese method comments, methods no longer than 20 lines, and operation objects for more than three parameters.
- Use TDD for every behavior change and run the relevant test red before production implementation.

---

### Task 1: Persist redacted rebind state and render an owner-only QR page

**Files:**
- Create: `src/rebind-state.ts`
- Create: `src/rebind-page.ts`
- Modify: `src/store.ts`
- Create: `test/rebind-page.test.js`
- Modify: `test/store.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `RebindStatus`, `RebindState`, `defaultRebindState()`, and `isRebindState(value)`.
- Produces: `RebindPageStore.create({ qrContent, expiresAt }): Promise<RebindPageDescriptor>`, `resolveLink()`, `removeCurrent()`, and `cleanupExpired()`.
- Produces: `WeChatStore.loadRebindState()`, `saveRebindState(state)`, and `clearRebindState()`.

- [ ] **Step 1: Write failing page and state tests**

```js
test("creates an offline owner-only QR page and exposes a file link", async () => {
  const pages = new RebindPageStore({
    directory: root,
    now: () => 1_000,
    randomID: () => "0123456789abcdef0123456789abcdef",
    renderQRCode: async () => "<svg data-test=\"qr\"></svg>",
  })
  const page = await pages.create({ qrContent: "secret-qr", expiresAt: 61_000 })

  assert.match(page.url, /^file:/)
  assert.doesNotMatch(page.url, /secret-qr/)
  assert.doesNotMatch(readFileSync(page.filePath, "utf8"), /https?:\/\//)
  if (process.platform !== "win32") assert.equal(statSync(page.filePath).mode & 0o777, 0o600)
})

test("rejects corrupt rebind descriptors without exposing a link", () => {
  writeFileSync(join(root, "rebind-v1.json"), JSON.stringify({ status: "qr-ready", pageFileName: "../secret" }))
  assert.equal(store.loadRebindState().status, RebindStatus.Idle)
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm run build && node --test test/rebind-page.test.js test/store.test.js`

Expected: FAIL because `rebind-page.js`, the state types, and store methods do not exist.

- [ ] **Step 3: Add the QR dependency and minimal state/page implementation**

Run: `npm install qrcode@^1.5.4 && npm install --save-dev @types/qrcode@^1.5.5`

Implement the public interfaces above. Persist only this shape:

```ts
export interface RebindState {
  schemaVersion: RebindSchemaVersion
  status: RebindStatus
  startedAt: number | null
  expiresAt: number | null
  pageFileName: string | null
  bindingGenerationDigest: string | null
}
```

The HTML must embed only the generated SVG and fixed Chinese instructions. Validate page file names with `^wechat-rebind-[a-f0-9]{32}\\.html$`, use `pathToFileURL`, and remove expired or abandoned pages.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run build && node --test test/rebind-page.test.js test/store.test.js`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the page/state unit**

```bash
git add package.json package-lock.json src/rebind-state.ts src/rebind-page.ts src/store.ts test/rebind-page.test.js test/store.test.js
git commit -m "feat: add secure WeChat rebind page state"
```

### Task 2: Make QR login and forced binding cancellable

**Files:**
- Modify: `src/wechat-gateway.ts`
- Modify: `src/client.ts`
- Modify: `test/client.test.js`
- Modify: `test/wechat-gateway.test.js`

**Interfaces:**
- Changes: `IlinkTransport.login(onQRCode?, force?, signal?): Promise<AccountData>` where `onQRCode` may return `Promise<void>`.
- Changes: `WeChatGateway.bind(onQRCode?, force?, signal?): Promise<void>`.
- Consumes: an `AbortSignal` from the future `RebindCoordinator`.

- [ ] **Step 1: Write failing cancellation tests**

```js
test("aborts QR login while waiting for confirmation", async () => {
  const controller = new AbortController()
  const login = transport.login(undefined, true, controller.signal)
  controller.abort()
  await assert.rejects(login, (error) => error.name === "AbortError")
})

test("awaits asynchronous QR publication before polling binding messages", async () => {
  const order = []
  await gateway.bind(async () => order.push("page"), true)
  assert.deepEqual(order.slice(0, 2), ["page", "poll"])
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm run build && node --test test/client.test.js test/wechat-gateway.test.js`

Expected: FAIL because login/bind ignore cancellation and do not await QR publication.

- [ ] **Step 3: Implement abort-aware login and binding**

Pass the caller signal into QR fetches, status polls, binding polls, and abort-aware sleeps. Check `signal.throwIfAborted()` at each loop boundary. Preserve the previous binding until `commitBinding()` succeeds.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run build && node --test test/client.test.js test/wechat-gateway.test.js`

Expected: all selected tests PASS, including interrupted forced rebind preserving the old binding.

- [ ] **Step 5: Commit cancellable binding**

```bash
git add src/client.ts src/wechat-gateway.ts test/client.test.js test/wechat-gateway.test.js
git commit -m "feat: make WeChat rebind cancellable"
```

### Task 3: Coordinate context refresh and one active rebind session

**Files:**
- Create: `src/rebind-coordinator.ts`
- Create: `test/rebind-coordinator.test.js`

**Interfaces:**
- Consumes: `WeChatStore`, `RebindPageStore`, and a gateway exposing `stop()` and cancellable `bind()`.
- Produces: `RebindCoordinator.request(failureKind)`, `observeBindingChange()`, `markTransportHealthy()`, `requiresBinding()`, and `stop()`.
- Produces: `RebindNotice` with controlled `title`, `message`, and Toast variant; the coordinator receives `notify(notice)` as an injected callback.

- [ ] **Step 1: Write failing coordinator tests**

```js
test("waits for context refresh before starting forced rebind", async () => {
  coordinator.request(TransportFailureKind.ContextRefresh)
  assert.equal(state.store.loadRebindState().status, RebindStatus.AwaitingContext)
  assert.equal(state.bindCalls.length, 0)

  await state.advanceGrace()
  assert.equal(state.bindCalls.length, 1)
})

test("starts one QR session immediately for session expiry", async () => {
  coordinator.request(TransportFailureKind.SessionExpired)
  coordinator.request(TransportFailureKind.SessionExpired)
  await state.flush()
  assert.equal(state.bindCalls.length, 1)
  assert.equal(state.store.loadRebindState().status, RebindStatus.QrReady)
})

test("cancels escalation when a fresh inbound context arrives", async () => {
  coordinator.request(TransportFailureKind.ContextRefresh)
  state.rotateContext()
  coordinator.observeBindingChange()
  await state.advanceGrace()
  assert.equal(state.bindCalls.length, 0)
  assert.equal(state.store.loadRebindState().status, RebindStatus.Idle)
})
```

- [ ] **Step 2: Run the coordinator test and verify RED**

Run: `npm run build && node --test test/rebind-coordinator.test.js`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the minimal coordinator state machine**

Use named options:

```ts
interface RebindCoordinatorOptions {
  store: WeChatStore
  gateway: RebindGateway
  pages: RebindPageStore
  notify: (notice: RebindNotice) => Promise<void>
  now?: () => number
  timers?: Partial<RebindTimers>
  contextGraceMs?: number
}
```

The coordinator must invalidate context only when escalation begins, stop normal polling before forced bind, create one page from the QR callback, and retain `confirming` until a real transport probe succeeds. Notification failures are caught and never abort binding.

- [ ] **Step 4: Add expiry, cleanup, and no-leak tests**

Cover QR expiration, bind error, leader stop, repeated requests, and notification errors. Assert persisted state and logged messages never contain the QR payload or fake credentials.

- [ ] **Step 5: Run coordinator tests and verify GREEN**

Run: `npm run build && node --test test/rebind-coordinator.test.js test/rebind-page.test.js`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the coordinator**

```bash
git add src/rebind-coordinator.ts test/rebind-coordinator.test.js
git commit -m "feat: coordinate automatic WeChat rebind recovery"
```

### Task 4: Integrate recovery with transport health, Leader lifecycle, and OpenCode Toast

**Files:**
- Modify: `src/transport-health-supervisor.ts`
- Modify: `src/plugin-types.ts`
- Modify: `src/index.ts`
- Modify: `test/transport-health-supervisor.test.js`
- Modify: `test/plugin.test.js`

**Interfaces:**
- `TransportHealthSupervisorOptions` accepts `rebind?: RebindRecovery`.
- `RebindRecovery` exposes `request`, `observeBindingChange`, `markTransportHealthy`, `requiresBinding`, and `stop`.
- `OpenCodeClient` exposes the SDK `tui.showToast` surface used by the plugin entry.

- [ ] **Step 1: Write failing supervisor and plugin tests**

```js
test("delegates context refresh failures without scheduling stale probes", async () => {
  await state.supervisor.start(async () => {})
  assert.deepEqual(state.rebindRequests, [TransportFailureKind.ContextRefresh])
  assert.equal(state.store.loadTransportHealth().nextRetryAt, null)
})

test("publishes a rebind file link through the injected OpenCode TUI", async () => {
  await notifier({ title: "微信需要重新绑定", message: "file:///private/rebind.html", variant: "warning" })
  assert.deepEqual(toasts[0].body.variant, "warning")
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run build && node --test test/transport-health-supervisor.test.js test/plugin.test.js`

Expected: FAIL because supervisor and plugin entry do not connect rebind recovery or Toast.

- [ ] **Step 3: Implement supervisor integration**

Context-refresh and session-expired failures call `rebind.request`. Only network failures retain exponential retry. The monitor cancels a waiting escalation when the binding digest changes; `markProbeSuccess()` calls `markTransportHealthy()`. `stop()` aborts coordinator work before stopping the gateway.

- [ ] **Step 4: Wire the Leader-owned coordinator in `WeChatPlugin`**

Construct one coordinator beside the existing gateway/supervisor. Its notifier calls:

```ts
await input.client.tui.showToast({
  body: {
    title: notice.title,
    message: notice.message,
    variant: notice.variant,
    duration: 15_000,
  },
})
```

Each plugin instance may construct the lightweight coordinator, but only the supervisor activated by
the current `GatewayLeader` may call it; secondary instances never create a QR page or login request.

- [ ] **Step 5: Run focused and integration tests**

Run: `npm run build && node --test test/transport-health-supervisor.test.js test/plugin.test.js test/gateway-leader.test.js test/integration.test.js`

Expected: all selected tests PASS with no duplicate QR request from secondary instances.

- [ ] **Step 6: Commit runtime integration**

```bash
git add src/transport-health-supervisor.ts src/plugin-types.ts src/index.ts test/transport-health-supervisor.test.js test/plugin.test.js
git commit -m "feat: expose automatic rebind through OpenCode"
```

### Task 5: Add CLI discovery, doctor guidance, docs, version, and release validation

**Files:**
- Modify: `src/bin.ts`
- Modify: `src/cli.ts`
- Modify: `test/bin.test.js`
- Modify: `test/cli.test.js`
- Modify: `README.md`
- Modify: `docs/acceptance.md`
- Modify: `docs/e2e-test-plan.md`
- Modify: `docs/approval-security-matrix.md`
- Create: `docs/release-impact-1.1.4.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Adds CLI command `wechat-approve rebind-link`.
- Adds `readCurrentRebindLink(store, now)` for a valid `qr-ready` or `confirming` page.
- Keeps `DoctorResult` shape stable while improving the `transport` detail.

- [ ] **Step 1: Write failing CLI and doctor tests**

```js
test("help exposes the browser rebind link command", () => {
  assert.match(result.stdout, /wechat-approve rebind-link/)
})

test("doctor points needs-rebind users to the one-time link", async () => {
  const result = await doctorInstallation(state.options)
  assert.match(result.transport.detail, /wechat-approve rebind-link/)
})
```

Add a spawned CLI test with a temporary OpenCode executable fixture that verifies `rebind-link` prints only a valid `file://` URL and expiry, and never prints QR payload or credentials.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `npm run build && node --test test/bin.test.js test/cli.test.js`

Expected: FAIL because the command and guidance are absent.

- [ ] **Step 3: Implement CLI and doctor guidance**

Add `RebindLink` to `CliCommand`, keep the branch read-only except safe expiry cleanup, and retain `wechat-approve bind` as the fallback when no page is valid.

- [ ] **Step 4: Update user and acceptance documentation**

Document the self-repair ladder, exact command, one-time local page security, OpenCode lifecycle limitation, and REAL-16/17 evidence. Create `release-impact-1.1.4.md` with affected automated and real scenarios.

- [ ] **Step 5: Bump the unpublished source version to `1.1.4`**

Run: `npm version 1.1.4 --no-git-tag-version`

Do not publish or create a tag in this task.

- [ ] **Step 6: Run the complete verification suite**

Run:

```bash
npm test
npm run coverage
npm run test:e2e
npm run build
git diff --check
npm pack --dry-run
```

Expected: every command exits 0; the tarball contains `dist`, README, package metadata, and no state/QR files.

- [ ] **Step 7: Commit the release candidate changes**

```bash
git add src/bin.ts src/cli.ts test/bin.test.js test/cli.test.js README.md docs/acceptance.md docs/e2e-test-plan.md docs/approval-security-matrix.md docs/release-impact-1.1.4.md package.json package-lock.json
git commit -m "feat: add browser-assisted WeChat rebind recovery"
```

### Task 6: Perform local live acceptance without publishing

**Files:**
- Modify only the relevant acceptance record if the user supplies complete evidence.

**Interfaces:**
- Consumes: local `1.1.4` package tarball or `local-dist` provenance.
- Produces: REAL-16/17 status separated from automated evidence.

- [ ] **Step 1: Start from a clean, local-only runtime**

Use a temporary OpenCode configuration that loads the local tarball/dist. Do not overwrite global registry configuration and do not publish npm.

- [ ] **Step 2: Verify context-refresh self-repair**

Create one harmless queued notification, induce the controlled non-`-14` failure, send one new message in the confirmed `微信ClawBot` private conversation, and record the visible replay plus pending/outbox before and after.

- [ ] **Step 3: Verify browser-link rebind**

Induce the controlled `-14`/invalid context state, confirm OpenCode shows the `file://` link, ask the user to open it, scan, and send exact text `绑定`. Record the visible recovery notification, transport health, and outbox replay without recording the QR or credentials.

- [ ] **Step 4: Record the honest outcome**

Mark each scenario `PASS`, `FAIL`, `BLOCKED`, or `UNVERIFIED`. A missing visible WeChat/OpenCode result cannot be replaced by fake transport or HTTP evidence.

- [ ] **Step 5: Commit acceptance evidence only when complete**

```bash
git add docs/acceptance.md docs/e2e-test-plan.md docs/approval-security-matrix.md docs/release-impact-1.1.4.md
git commit -m "test(e2e): record WeChat rebind recovery evidence"
```
