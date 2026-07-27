# WeChat Approve V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global OpenCode plugin that reports every central-server session result to WeChat and safely routes conversational WeChat approvals back to the exact OpenCode permission request.

**Architecture:** A single plugin instance runs inside the central OpenCode server on `127.0.0.1:4096`. Focused modules isolate persistent state, iLink transport, session lifecycle, approval state, and hybrid intent interpretation; ordinary WeChat messages never enter OpenCode sessions.

**Tech Stack:** TypeScript 5, Node.js 20+, Node test runner, OpenCode plugin/SDK APIs, WeChat iLink HTTP API.

## Global Constraints

- V1 supports one central OpenCode server; additional terminals use `opencode attach`.
- All plugin state stays under `~/.opencode/wechat-approve/`.
- Only the QR-bound private-chat user may reply.
- Clear approval phrases use deterministic rules; a model may only return validated structured intent.
- Ambiguous input never grants permission.
- General WeChat chat-to-OpenCode forwarding and AI-facing WeChat tools are removed.
- Every production behavior is implemented with a red-green test cycle.

---

### Task 1: Configuration, Types, and Atomic Persistent Store

**Files:**
- Create: `src/config.ts`
- Create: `src/domain.ts`
- Rewrite: `src/store.ts`
- Create: `test/config.test.js`
- Create: `test/store.test.js`
- Remove after migration coverage exists: `test/prompt-model.test.js`
- Remove after migration coverage exists: `test/store-path.test.js`

**Interfaces:**
- Produces: `PluginConfig`, `PendingApproval`, `SessionRunState`,
  `NotificationEnvelope`, `loadPluginConfig()`, and `WeChatStore`.
- `WeChatStore` methods used later:
  `loadAccount()`, `saveAccount()`, `loadContext()`, `saveContext()`,
  `loadCursor()`, `saveCursor()`, `loadPendingApprovals()`,
  `savePendingApprovals()`, `loadSessionStates()`, `saveSessionStates()`,
  `enqueueNotification()`, `ackNotification()`, and `migrateLegacyState()`.

- [ ] **Step 1: Write failing config and store tests**

```js
test("uses safe V1 defaults", () => {
  assert.deepEqual(loadPluginConfig({}), {
    model: null,
    server: { hostname: "127.0.0.1", port: 4096 },
    approvalTimeoutMs: 600_000,
    modelConfidenceThreshold: 0.85,
  })
})

test("quarantines corrupt state and returns an empty collection", () => {
  writeFileSync(join(root, "pending-approvals.json"), "{bad")
  const store = new WeChatStore(root)
  assert.deepEqual(store.loadPendingApprovals(), [])
  assert.equal(readdirSync(root).some((name) => name.startsWith("pending-approvals.json.corrupt-")), true)
})

test("writes credential files with owner-only permissions", () => {
  const store = new WeChatStore(root)
  store.saveAccount(account)
  assert.equal(statSync(join(root, "account.json")).mode & 0o777, 0o600)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="safe V1|quarantines corrupt|owner-only"`

Expected: FAIL because `src/config.ts`, V1 domain types, and the new store API do not exist.

- [ ] **Step 3: Implement configuration, domain types, and atomic JSON writes**

```ts
export interface PendingApproval {
  requestID: string
  sessionID: string
  code: number
  permission: string
  patterns: string[]
  project: string
  createdAt: number
  expiresAt: number
}

function atomicWrite(file: string, value: unknown, mode = 0o600): void {
  const temporary = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(temporary, "w", mode)
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temporary, file)
  fs.chmodSync(file, mode)
}
```

Implement corrupt-file quarantine, schema guards, atomic writes, and migration
from the existing `session.json`, `context.json`, and `sync_buf.txt`. Archive
the obsolete session binding as `session.json.legacy`; never import it into V1.

- [ ] **Step 4: Run the full test suite and verify GREEN**

Run: `npm test`

Expected: all store/config tests pass and existing account restoration remains green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/domain.ts src/store.ts test/config.test.js test/store.test.js test/client.test.js
git commit -m "Build V1 persistent state foundation"
```

---

### Task 2: Safe WeChat Gateway and Binding State Machine

**Files:**
- Rewrite: `src/client.ts`
- Rewrite: `src/message.ts`
- Modify: `src/types.ts`
- Create: `src/wechat-gateway.ts`
- Create: `test/wechat-gateway.test.js`
- Create: `test/fakes/fake-ilink.js`

**Interfaces:**
- Consumes: `WeChatStore`, `AccountData`, and stored bound-user context.
- Produces:

```ts
export interface InboundApprovalMessage {
  messageID: string
  senderID: string
  text: string
  receivedAt: number
}

export interface WeChatGateway {
  initialize(): Promise<"ready" | "needs-binding">
  bind(onQRCode: (value: string) => void): Promise<void>
  start(onMessage: (message: InboundApprovalMessage) => Promise<void>): void
  stop(): Promise<void>
  send(notification: NotificationEnvelope): Promise<void>
}
```

- [ ] **Step 1: Write failing gateway tests**

```js
test("accepts only the QR-bound private-chat user", async () => {
  const messages = []
  const gateway = createGateway({ boundUserID: "owner", ilink: fake })
  gateway.start(async (message) => messages.push(message))
  fake.push(privateText({ senderID: "intruder", text: "好的" }))
  fake.push(groupText({ senderID: "owner", text: "好的" }))
  fake.push(privateText({ senderID: "owner", text: "好的", id: "m3" }))
  fake.push(privateText({ senderID: "owner", text: "好的", id: "m3" }))
  await fake.flush()
  assert.deepEqual(messages.map((message) => message.messageID), ["m3"])
})

test("persists cursor before dispatching received messages", async () => {
  const order = []
  const gateway = createGateway({ onCursor: () => order.push("cursor"), onMessage: () => order.push("message") })
  await gateway.pollOnce()
  assert.deepEqual(order, ["cursor", "message"])
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="QR-bound|cursor before"`

Expected: FAIL because V1 gateway filtering and deduplication do not exist.

- [ ] **Step 3: Implement binding, polling, filtering, and outbox delivery**

Implement QR `wait -> scaned -> confirmed -> expired`, require the fixed inbound
text `绑定`, save the latest context token for the bound user, reject group and
foreign-user messages, deduplicate by stable message ID, and retry transient
HTTP failures with bounded exponential backoff plus jitter.

Persist every outbound `NotificationEnvelope` before the first send. Remove it
only after an HTTP-success response. Redact tokens and context values from
errors and logs.

- [ ] **Step 4: Run gateway and full tests**

Run: `npm test`

Expected: gateway tests and all prior tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts src/message.ts src/types.ts src/wechat-gateway.ts test/wechat-gateway.test.js test/fakes/fake-ilink.js
git commit -m "Harden WeChat binding and transport"
```

---

### Task 3: Session Lifecycle Notifications

**Files:**
- Create: `src/session-notifier.ts`
- Replace: `src/notification-utils.ts`
- Modify: `src/status-message.ts`
- Create: `test/session-notifier.test.js`
- Modify: `test/notification-utils.test.js`
- Modify: `test/status-message.test.js`

**Interfaces:**
- Consumes OpenCode `session.status`, `session.idle`, `session.error`,
  `session.updated`, and message activity events.
- Produces:

```ts
export class SessionNotifier {
  handle(event: Event): Promise<NotificationEnvelope[]>
  restore(states: SessionRunState[]): void
  snapshot(): SessionRunState[]
}
```

- [ ] **Step 1: Write failing lifecycle tests**

```js
test("notifies exactly once for a busy to idle transition", async () => {
  const notifier = createNotifier()
  await notifier.handle(status("ses_1", "busy"))
  const first = await notifier.handle(idle("ses_1"))
  const duplicate = await notifier.handle(idle("ses_1"))
  assert.equal(first.length, 1)
  assert.equal(duplicate.length, 0)
  assert.match(first[0].text, /ses_1/)
})

test("failure suppresses the following idle success", async () => {
  const notifier = createNotifier()
  await notifier.handle(status("ses_1", "busy"))
  assert.equal((await notifier.handle(error("ses_1", nestedError))).length, 1)
  assert.equal((await notifier.handle(idle("ses_1"))).length, 0)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="busy to idle|suppresses the following"`

Expected: FAIL because notifications are not based on persisted run transitions.

- [ ] **Step 3: Implement the run state machine**

Track a monotonically increasing run number per session. Emit completion only
after observed busy activity. Classify `MessageAbortedError` as cancelled.
Resolve title and directory through the session API and fall back to the ID and
plugin directory. Format structured errors as a concise first line.

- [ ] **Step 4: Run lifecycle and full tests**

Run: `npm test`

Expected: lifecycle, formatting, and all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/session-notifier.ts src/notification-utils.ts src/status-message.ts test/session-notifier.test.js test/notification-utils.test.js test/status-message.test.js
git commit -m "Notify reliable session outcomes"
```

---

### Task 4: Deterministic and Model-Assisted Approval Intent

**Files:**
- Create: `src/approval-intent.ts`
- Create: `src/model-interpreter.ts`
- Create: `test/approval-intent.test.js`
- Create: `test/model-interpreter.test.js`

**Interfaces:**
- Produces:

```ts
export interface ApprovalIntent {
  requestIDs: string[]
  decision: "once" | "always" | "reject" | "clarify"
  confidence: number
  explanation: string
}

export function interpretDeterministic(
  text: string,
  pending: PendingApproval[],
  conversation: ApprovalConversation | null,
): ApprovalIntent | null

export function validateModelIntent(
  candidate: unknown,
  pending: PendingApproval[],
  threshold: number,
): ApprovalIntent
```

- [ ] **Step 1: Write failing intent tests**

```js
test("maps clear one-request synonyms without a model", () => {
  assert.equal(interpret("好的", [approval("r1")]).decision, "once")
  assert.equal(interpret("全部授权", [approval("r1")]).decision, "always")
  assert.equal(interpret("不要，拒绝", [approval("r1")]).decision, "reject")
})

test("clarifies a bare approval when multiple requests are pending", () => {
  assert.equal(interpret("好的", [approval("r1"), approval("r2")]).decision, "clarify")
})

test("rejects model output containing unknown request IDs", () => {
  const result = validateModelIntent(
    { requestIDs: ["invented"], decision: "always", confidence: 1, explanation: "" },
    [approval("r1")],
    0.85,
  )
  assert.equal(result.decision, "clarify")
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="one-request synonyms|bare approval|unknown request"`

Expected: FAIL because the V1 intent modules do not exist.

- [ ] **Step 3: Implement normalization, selection, and validation**

Implement exact phrase families, negation precedence, ordinal/number parsing,
project/session/pattern matching, batch selection, and the distinction between
selection scope and `once`/`always` decision scope.

The model request uses a tool-free structured-output prompt containing only
sanitized pending summaries. Validate schema, current request IDs, confidence,
non-empty selection, and explicit persistent wording before permitting
`always`. Any model error returns `clarify`.

- [ ] **Step 4: Run intent and full tests**

Run: `npm test`

Expected: all intent, validation, and prior tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/approval-intent.ts src/model-interpreter.ts test/approval-intent.test.js test/model-interpreter.test.js
git commit -m "Interpret conversational approvals safely"
```

---

### Task 5: Approval Manager and Exact OpenCode Routing

**Files:**
- Create: `src/approval-manager.ts`
- Create: `src/opencode-permissions.ts`
- Create: `test/approval-manager.test.js`
- Create: `test/fakes/fake-opencode.js`

**Interfaces:**
- Consumes `permission.asked`, `permission.replied`, inbound WeChat messages,
  `interpretDeterministic()`, and model interpretation.
- Produces:

```ts
export interface PermissionAPI {
  list(): Promise<OpenCodePermissionRequest[]>
  reply(requestID: string, decision: "once" | "always" | "reject"): Promise<boolean>
}

export class ApprovalManager {
  reconcile(): Promise<NotificationEnvelope[]>
  onPermissionAsked(event: EventPermissionAsked): Promise<NotificationEnvelope[]>
  onPermissionReplied(event: EventPermissionReplied): Promise<void>
  onMessage(message: InboundApprovalMessage): Promise<NotificationEnvelope[]>
  expire(now: number): Promise<NotificationEnvelope[]>
}
```

- [ ] **Step 1: Write failing routing and race tests**

```js
test("routes once always and reject by OpenCode request ID", async () => {
  const manager = createManager({ pending: [approval("r1"), approval("r2")] })
  await manager.onMessage(message("两个都始终允许"))
  assert.deepEqual(api.replies, [
    ["r1", "always"],
    ["r2", "always"],
  ])
})

test("rechecks pending requests before applying a clarified selection", async () => {
  const manager = createManager({ pending: [approval("r1"), approval("r2")] })
  await manager.onMessage(message("好的"))
  api.pending = [approval("r2")]
  const notices = await manager.onMessage(message("第一个"))
  assert.deepEqual(api.replies, [])
  assert.match(notices[0].text, /已变化/)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="routes once|rechecks pending"`

Expected: FAIL because request-ID routing and snapshot reconciliation do not exist.

- [ ] **Step 3: Implement approval state and API adapter**

Prefer the current V2 endpoint:

```text
POST /permission/{requestID}/reply
{"reply":"once"|"always"|"reject"}
```

Detect a legacy OpenCode server and use its session permission response endpoint
only when the health/version capability check proves it is required. Do not use
prompt injection or mutate `permission.ask` output to emulate `always`.

Persist pending requests and clarification snapshots. Reconcile against
`GET /permission` at startup and before every decision. Process batch replies
independently and report partial outcomes.

- [ ] **Step 4: Run approval and full tests**

Run: `npm test`

Expected: approval routing, race, timeout, and all prior tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/approval-manager.ts src/opencode-permissions.ts test/approval-manager.test.js test/fakes/fake-opencode.js
git commit -m "Route WeChat approvals to exact requests"
```

---

### Task 6: Assemble the V1 Plugin and Remove Chat-Bridge Behavior

**Files:**
- Rewrite: `src/index.ts`
- Delete: `src/prompt-model.ts`
- Delete obsolete tests: `test/prompt-model.test.js`, `test/store-path.test.js`
- Create: `test/plugin.test.js`

**Interfaces:**
- Consumes all components from Tasks 1-5.
- Produces the default `WeChatPlugin` export with only the OpenCode `event`
  hook. It registers no AI-facing WeChat tools and no inbound prompt forwarding.

- [ ] **Step 1: Write failing plugin boundary tests**

```js
test("ordinary WeChat text never calls an OpenCode session prompt endpoint", async () => {
  const plugin = await createPluginHarness()
  await plugin.wechat.receive("今天怎么样")
  assert.equal(plugin.opencode.promptCalls.length, 0)
  assert.equal(plugin.model.calls.length, 0)
})

test("exposes no general-purpose WeChat AI tools", async () => {
  const hooks = await createHooks()
  assert.equal(hooks.tool, undefined)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="ordinary WeChat|no general-purpose"`

Expected: FAIL because the prototype forwards messages and registers five tools.

- [ ] **Step 3: Assemble event dispatch and delete prototype paths**

Wire session events to `SessionNotifier`, permission events to
`ApprovalManager`, inbound messages to the manager only when pending approvals
exist, and notifications to the persistent gateway outbox.

Remove bound session creation, `promptAsync`, help/status chat commands, image
send tool, proactive AI tool, and manual permission tool.

- [ ] **Step 4: Run plugin and full tests**

Run: `npm test`

Expected: no prompt forwarding remains and every test passes.

- [ ] **Step 5: Commit**

```bash
git add -A src/index.ts src/prompt-model.ts test/plugin.test.js test/prompt-model.test.js test/store-path.test.js
git commit -m "Assemble notification-only approval plugin"
```

---

### Task 7: Installer CLI and Central-Server Health Checks

**Files:**
- Create: `src/install.ts`
- Create: `src/bin.ts`
- Modify: `package.json`
- Create: `test/install.test.js`

**Interfaces:**
- Produces CLI commands:
  `install`, `doctor`, `bind`, and `uninstall --keep-credentials`.
- `doctor` verifies model availability, binding/context, central server health,
  plugin loading, runtime lease, and outbound notification delivery.

- [ ] **Step 1: Write failing installer tests**

```js
test("preserves unrelated OpenCode configuration while installing globally", async () => {
  writeConfig({ plugin: ["existing"], formatter: { prettier: {} } })
  await install({ confirmModel: async () => true, bind: fakeBinding })
  assert.deepEqual(readConfig().plugin, ["existing", "opencode-wechat-approve-plugin"])
  assert.deepEqual(readConfig().formatter, { prettier: {} })
  assert.deepEqual(readConfig().server, { hostname: "127.0.0.1", port: 4096 })
})

test("does not finish until binding and test delivery succeed", async () => {
  await assert.rejects(
    install({ bind: bindingWithoutContext, sendTest: async () => false }),
    /绑定消息|测试通知/,
  )
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="preserves unrelated|does not finish"`

Expected: FAIL because no installer CLI exists.

- [ ] **Step 3: Implement CLI and package bin entry**

```json
{
  "bin": {
    "wechat-approve": "./dist/bin.js"
  }
}
```

Support JSON and JSONC through a parser that preserves unrelated fields and
comments. Detect duplicate plugin installation and a second independent runtime
lease. Never overwrite a non-loopback hostname without explicit confirmation.

- [ ] **Step 4: Run installer tests and a temporary-home smoke test**

Run:

```bash
npm test
temporary_home="$(mktemp -d)"
HOME="$temporary_home" node dist/bin.js doctor
```

Expected: automated tests pass; doctor reports unbound/model/server checks
without creating files outside the temporary home.

- [ ] **Step 5: Commit**

```bash
git add src/install.ts src/bin.ts package.json package-lock.json test/install.test.js
git commit -m "Add safe global installer and doctor"
```

---

### Task 8: Documentation, Automated Fault Matrix, and Local Deployment

**Files:**
- Rewrite: `README.md`
- Create: `docs/acceptance.md`
- Create: `test/integration.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Documents the supported central-server topology, install/bind flow, attach
  commands, approval language, recovery, security boundaries, and diagnostics.

- [ ] **Step 1: Write the failing integration matrix**

Create table-driven integration cases for:

```js
const cases = [
  "completion once",
  "failure without done",
  "once approval",
  "always approval",
  "reject approval",
  "multiple approval clarification",
  "native approval race",
  "expired approval",
  "restart outbox replay",
  "unauthorized sender",
  "group sender",
  "ordinary message isolation",
]
```

Each case must assert the exact OpenCode API calls and outbound WeChat messages.

- [ ] **Step 2: Run integration tests and verify RED for uncovered cases**

Run: `npm test -- --test-name-pattern="integration:"`

Expected: uncovered cases fail until all adapters are wired through the plugin harness.

- [ ] **Step 3: Complete integration wiring and rewrite documentation**

Document:

```bash
npx opencode-wechat-approve-plugin install
opencode web
opencode attach http://127.0.0.1:4096 --dir /path/to/project
npx opencode-wechat-approve-plugin doctor
```

Remove all README claims about general WeChat chat, session binding, image
tools, and AI-created sessions. Add a troubleshooting table with exact doctor
checks and recovery commands.

- [ ] **Step 4: Run final automated verification**

Run:

```bash
npm clean-install
npm test
npm run build
git diff --check
```

Expected: clean dependency install, zero test failures, successful TypeScript
build, and no whitespace errors.

- [ ] **Step 5: Deploy the built plugin to the current global OpenCode setup**

Back up the current prototype entry and state metadata. Install the new global
entry, run `doctor`, restart only the central `opencode web` process, and verify
`GET /global/health` reports healthy on port 4096.

- [ ] **Step 6: Execute real WeChat acceptance**

Use the logged-in macOS WeChat client, with Accessibility permission, to send
the binding and approval phrases listed in the design's twelve-step acceptance
flow. Capture:

- OpenCode request IDs and reply payloads;
- WeChat notification text;
- absence of duplicate/error-followed-by-Done notifications;
- absence of any session prompt call for ordinary text.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/acceptance.md test/integration.test.js .gitignore
git commit -m "Document and verify WeChat approval V1"
```

- [ ] **Step 8: Publish**

Push `agent/wechat-approve-v1`, open a pull request with the design, root cause,
security boundaries, automated evidence, and real acceptance evidence. Merge
only after all checks and the real WeChat flow pass.
