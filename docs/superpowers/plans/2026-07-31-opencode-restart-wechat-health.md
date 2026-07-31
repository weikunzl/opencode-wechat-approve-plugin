# OpenCode Restart WeChat Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WeChat transport startup observable and recoverable across OpenCode restarts without an external daemon.

**Architecture:** Persist a redacted transport health state, supervise the Gateway Leader independently from outbox delivery, and retry leader acquisition and binding recovery inside the OpenCode plugin lifecycle. Real send probes gate outbox replay while failures remain non-fatal to plugin startup.

**Tech Stack:** TypeScript ESM, Node.js 20, `node:test`, existing `WeChatStore`, `WeChatGateway`, `RuntimeLease`, `PluginInstanceRegistry`, and OpenCode plugin hooks.

## Global Constraints

- Do not start an external service, OpenCode server, HTTP port, or background daemon.
- Never persist or log token, context token, bound user ID, QR data, message text, or full API URLs in transport health state.
- Keep source methods at 20 lines or fewer, use Chinese boundary comments, named operation objects for more than three parameters, and enums instead of magic status values.
- Production behavior follows strict red-green-refactor TDD.
- Preserve the user's uncommitted `AGENTS.md`.
- Release as `1.2.0` only after automated verification and affected registry REAL acceptance.

---

### Task 1: Persist Redacted Transport Health

**Files:**
- Create: `src/transport-health.ts`
- Modify: `src/store.ts`
- Modify: `src/domain.ts`
- Test: `test/store.test.js`
- Test: `test/transport-health.test.js`

**Interfaces:**
- Produces `TransportHealthStatus`, `TransportFailureKind`, `TransportHealthState`, `defaultTransportHealth()`, and `bindingGenerationDigest()`.
- `WeChatStore.loadTransportHealth()` returns a validated state.
- `WeChatStore.saveTransportHealth(state)` writes `transport-health-v1.json` with owner-only permissions.

- [ ] **Step 1: Write failing persistence and redaction tests**

Add tests proving the default is `stopped`, a valid state round-trips, a corrupt file is quarantined, and the generation digest contains none of the account/context inputs.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run build && node --test test/store.test.js test/transport-health.test.js`

Expected: FAIL because transport health types and store methods do not exist.

- [ ] **Step 3: Implement the minimal domain and store methods**

Create the enum-backed state schema, SHA-256 binding digest, validator, safe default, and atomic persistence through `WeChatStore`.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `npm run build && node --test test/store.test.js test/transport-health.test.js`

Expected: PASS with no credential text in snapshots or assertion output.

- [ ] **Step 5: Commit**

```bash
git add src/domain.ts src/store.ts src/transport-health.ts test/store.test.js test/transport-health.test.js
git commit -m "feat(health): persist redacted transport state"
```

---

### Task 2: Make Startup Probe and Outbox Recovery Non-Fatal

**Files:**
- Create: `src/transport-health-supervisor.ts`
- Modify: `src/wechat-gateway.ts`
- Modify: `src/gateway-leader.ts`
- Test: `test/wechat-gateway.test.js`
- Test: `test/gateway-leader.test.js`
- Test: `test/transport-health-supervisor.test.js`

**Interfaces:**
- `WeChatGateway.probe(notification)` sends without enqueueing normal outbox.
- `TransportHealthSupervisor.start(onMessage)` starts polling before probing and returns without throwing on transport failure.
- `TransportHealthSupervisor.stop(options)` optionally emits the final stop message.
- `GatewayLeader` delegates transport activation and shutdown to the supervisor.

- [ ] **Step 1: Write failing startup and probe tests**

Cover a failed outbox/probe that still starts polling, probe messages absent from outbox, successful probe before outbox replay, and `-14` entering `needs-rebind`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run build && node --test test/wechat-gateway.test.js test/gateway-leader.test.js test/transport-health-supervisor.test.js`

Expected: FAIL because `probe` and the supervisor do not exist and current Leader startup rejects.

- [ ] **Step 3: Implement minimal supervised startup**

Add direct idempotent probe delivery, enum-based failure classification, safe startup ordering, health persistence, and non-fatal outbox recovery.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `npm run build && node --test test/wechat-gateway.test.js test/gateway-leader.test.js test/transport-health-supervisor.test.js`

Expected: PASS; startup returns while failed notifications remain durable.

- [ ] **Step 5: Commit**

```bash
git add src/wechat-gateway.ts src/gateway-leader.ts src/transport-health-supervisor.ts test/wechat-gateway.test.js test/gateway-leader.test.js test/transport-health-supervisor.test.js
git commit -m "fix(runtime): recover WeChat transport after restart"
```

---

### Task 3: Recover Binding and Leader Ownership Automatically

**Files:**
- Modify: `src/gateway-leader.ts`
- Modify: `src/plugin-instance.ts`
- Modify: `src/index.ts`
- Test: `test/gateway-leader.test.js`
- Test: `test/plugin-instance.test.js`
- Test: `test/plugin.test.js`

**Interfaces:**
- Non-Leaders periodically retry `RuntimeLease.acquire()` with bounded jitter.
- The supervisor observes binding generation changes and reactivates from `needs-rebind`.
- `PluginInstanceRegistry.prune()` removes dead or expired records and returns the live snapshot.
- Leadership callbacks start and stop event draining and reconciliation.

- [ ] **Step 1: Write failing recovery and takeover tests**

Prove a new binding restarts polling without OpenCode restart, a secondary takes over after release, stale instances disappear, and only the final healthy Leader sends a stop notification.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run build && node --test test/gateway-leader.test.js test/plugin-instance.test.js test/plugin.test.js`

Expected: FAIL because current non-Leaders attempt acquisition only once and instance records are never pruned.

- [ ] **Step 3: Implement bounded coordination**

Add timer-injected retry and binding checks, leadership transition callbacks, process-liveness pruning, and best-effort two-second shutdown delivery.

- [ ] **Step 4: Run focused and integration tests**

Run: `npm run build && node --test test/gateway-leader.test.js test/plugin-instance.test.js test/plugin.test.js test/integration.test.js`

Expected: PASS without duplicate polling, notifications, or permission replies.

- [ ] **Step 5: Commit**

```bash
git add src/gateway-leader.ts src/plugin-instance.ts src/index.ts test/gateway-leader.test.js test/plugin-instance.test.js test/plugin.test.js
git commit -m "feat(runtime): restore gateway leadership automatically"
```

---

### Task 4: Expose Health in Doctor and Prepare Release

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `docs/acceptance.md`
- Create: `docs/release-impact-1.2.0.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `test/cli.test.js`

**Interfaces:**
- `DoctorResult.transport` distinguishes `healthy`, `degraded`, `needs rebind`, and `unknown`.
- README documents startup, handoff, stop, and recovery messages.
- Release impact maps REAL-00, REAL-16, and REAL-17.

- [ ] **Step 1: Write failing doctor tests**

Add fixtures for healthy, degraded, needs-rebind, and missing health state; assert that `binding: bound` alone does not produce transport success.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run build && node --test test/cli.test.js`

Expected: FAIL because `DoctorResult` has no transport check.

- [ ] **Step 3: Implement doctor output and documentation**

Read the redacted health state, return actionable details, document behavior, add the release impact matrix, and set package/lockfile version to `1.2.0`.

- [ ] **Step 4: Run complete automated verification**

Run:

```bash
npm test
npm run coverage
npm run test:e2e
npm run build
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.js README.md docs/acceptance.md docs/release-impact-1.2.0.md package.json package-lock.json
git commit -m "feat(cli): report WeChat transport health"
```

---

### Task 5: Registry Candidate and Real Acceptance

**Files:**
- Modify after evidence: `docs/release-impact-1.2.0.md`
- Modify after evidence: `docs/acceptance.md`

**Interfaces:**
- Prerelease `1.2.0-rc.0` is published with dist-tag `next`.
- REAL evidence records startup, degraded/rebind recovery, outbox replay, and final shutdown.

- [ ] **Step 1: Inspect package contents**

Run: `npm pack --dry-run`

Expected: source state, local binding files, credentials, coverage, and worktree metadata are absent.

- [ ] **Step 2: Publish and install the candidate**

Run:

```bash
npm version 1.2.0-rc.0 --no-git-tag-version
npm publish --access public --tag next
```

User completes npm 2FA without sharing credentials.

- [ ] **Step 3: Execute affected REAL scenarios**

Install the registry candidate in an isolated OpenCode configuration and record REAL-00, REAL-16, and REAL-17 using the repository evidence schema. Startup and shutdown messages must be visible in the confirmed WeChat conversation.

- [ ] **Step 4: Publish formal 1.2.0**

Restore package/lockfile to `1.2.0`, run full verification again, publish with `latest`, verify `npm view`, then tag and push `v1.2.0`.

- [ ] **Step 5: Merge and push**

Merge `codex/restart-wechat-health` into `main`, preserve the user's `AGENTS.md`, push `main` and the release tag, and verify the worktree is clean.
