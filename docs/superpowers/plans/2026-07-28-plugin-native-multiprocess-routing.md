# Plugin-Native Multiprocess Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将插件改造成原生 OpenCode plugin：每个 OpenCode 进程仅注册插件并发布事件，多进程共享一个受保护的微信绑定，由单一带围栏的 Gateway Leader 轮询微信、顺序化入站消息并路由审批决定；不再依赖固定端口、独立 OpenCode server 或 file URL 托管入口。

**Architecture:** 采用共享文件邮箱和租约作为跨进程协调层。插件实例写入 instance registry、pending 索引、事件 outbox 与命令队列；Leader 持有可续租 epoch，先持久化微信入站再推进 cursor，按 create_time_ms 与 messageID 排序。命令携带 ownerInstanceID、requestID、expectedRevision，由拥有请求的进程通过注入的 OpenCode client 原子应用；重复、过期和竞态命令安全拒绝。

**Tech Stack:** TypeScript ESM、Node.js 20、node:test、node:assert/strict、现有 WeChatGateway transport、OpenCode plugin hooks 与 input.client。

## Global Constraints

- 不启动或要求 opencode serve、opencode web、固定 4096 端口；插件生命周期完全由 OpenCode plugin contract 管理。
- 新增源码优先 TypeScript；两空格、双引号、无分号、相对导入带 .js。
- 每个方法不超过 20 行，方法内写中文业务注释；禁止魔法值，状态和命令类型使用枚举；超过 3 个参数封装为操作对象。
- 所有持久化状态使用最小权限、原子替换和脱敏日志；token、context、绑定信息和用户 ID 不进入日志、测试快照或提交。
- 不把普通消息交给模型；模型只能处理存在 pending 的澄清请求，输出必须校验 requestID、decision、confidence、目标范围和用户原文，内部会话无工具权限并在 finally 删除。
- 保留现有用户对 AGENTS.md 的未提交修改和 .omo/；实施时只暂存计划或明确变更文件。
- 每个任务先写失败测试并运行看到失败，再做最小实现并运行通过；任务完成后运行相关测试、npm run build，并按 Conventional Commits 提交。
- 影响审批、通知、状态、配置或发布行为时，按 REAL-00～REAL-18 映射真实回归；任何 BLOCKED 或 UNVERIFIED 不得作为发布通过证据。

---

## Task 1: Typed OpenCode Boundary and Event Normalization

**Files**

- Add src/plugin-types.ts, src/event-normalizer.ts, src/opencode-adapter.ts.
- Modify src/index.ts, src/approval-manager.ts and hook-related tests.
- Add test/event-normalizer.test.js and test/opencode-adapter.test.js.

**Interfaces**

- Define PluginContext, OpenCodeClient, NormalizedEvent and PermissionEventKind types.
- Normalize permission.updated and legacy permission.asked into one event shape.
- Adapter methods accept named objects: replyPermission, readSession, listPendingPermissions.

**Steps**

- [ ] Add failing tests proving both event names produce the same normalized permission payload, malformed request IDs are rejected, and injected client.replyPermission receives no raw fetch call.
- [ ] Run npm run build && node --test test/event-normalizer.test.js test/opencode-adapter.test.js; confirm failure because current EventLike cast and raw HTTP path do not provide this contract.
- [ ] Implement the typed boundary and a single normalizer; keep compatibility handling at the boundary and add Chinese comments for event-version decisions.
- [ ] Re-run the focused tests and npm run build; then run npm test.
- [ ] Commit as fix(plugin): normalize OpenCode event boundary.

## Task 2: Shared State V2 and Safe Migration

**Files**

- Add src/shared-state.ts and src/shared-lock.ts.
- Modify src/store.ts, src/types.ts and test/store.test.js.
- Add test/shared-state.test.js.

**Interfaces**

- State schema contains schemaVersion, binding reference, instances, lease, inbox cursor, inbox records, outbox records and approval records.
- Lease fields are ownerInstanceID, processFingerprint, epoch and expiresAt.
- Lock API uses named operations and exclusive mkdir with stale-lock recovery.

**Steps**

- [ ] Add failing tests for 0600 state creation, atomic replacement, corrupt-state quarantine, V1 migration, stale lease detection and concurrent lock acquisition.
- [ ] Run npm run build && node --test test/shared-state.test.js test/store.test.js; confirm missing schema and locking behavior.
- [ ] Implement schemaVersion 2 migration without printing sensitive fields; use explicit StateStatus and LeaseStatus enums.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as feat(store): add shared mailbox state schema.

## Task 3: Instance Registry and Shared Mailbox

**Files**

- Add src/plugin-instance.ts and src/shared-mailbox.ts.
- Modify src/store.ts and src/config.ts.
- Add test/plugin-instance.test.js and test/shared-mailbox.test.js.

**Interfaces**

- Instance records contain instanceID, processFingerprint, projectDirectory, session IDs, heartbeatAt and status.
- Mailbox records use MailboxRecordKind, commandID, messageID, ownerInstanceID, requestID, expectedRevision and payloadDigest.
- APIs publishEvent, enqueueCommand, readCommands and acknowledgeCommand are idempotent.

**Steps**

- [ ] Add failing tests for unique instance IDs, registration/heartbeat/disposal, exact-once command acknowledgement and command replay after a worker restart.
- [ ] Run focused tests and confirm no shared mailbox currently exists.
- [ ] Implement atomic append/read/ack with bounded retention and digest-only logs.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as feat(mailbox): coordinate plugin instances through shared state.

## Task 4: Approval Index and Atomic Claims

**Files**

- Add src/approval-index.ts.
- Modify src/approval-manager.ts, src/approval-types.ts and related tests.
- Add test/approval-index.test.js.

**Interfaces**

- ApprovalRecord fields are requestID, ownerInstanceID, sessionID, projectDirectory, createdAtMs, revision, status and metadataDigest.
- ApprovalStatus is PENDING, CLAIMED, APPLYING, APPLIED, STALE or FAILED_RETRYABLE.
- claimSnapshot and claimByTarget accept named operation objects and return immutable snapshots.

**Steps**

- [ ] Add failing tests for createdAt ordering independent of API return order, first-claim-wins conflicts, stale native replies, partial batch failure and revision mismatch.
- [ ] Run focused tests and confirm current in-memory pending map cannot provide atomic cross-process claims.
- [ ] Implement compare-and-swap claims under shared lock; batch snapshots include only records pending at claim time.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as feat(approval): add atomic cross-process claims.

## Task 5: Fenced Gateway Leader and Durable Ingress

**Files**

- Add src/gateway-leader.ts and src/inbox-reconciler.ts.
- Modify src/wechat-gateway.ts, src/outbox.ts and gateway tests.
- Add test/gateway-leader.test.js and test/inbox-reconciler.test.js.

**Interfaces**

- GatewayLeader owns acquire, renew, poll, ingest and release operations.
- WeChatGateway exposes transport, bind, send and poll primitives; it does not own process-wide routing.
- LeaderEpoch is checked before polling, inbox writes, command publication and outbox acknowledgement.

**Steps**

- [ ] Add failing tests showing only one process polls, a message is persisted before cursor advancement, duplicate message IDs are ignored, old epochs cannot send, and non-14 errors retain outbox.
- [ ] Run focused tests and confirm current module-global leaseOwner cannot coordinate separate Node processes.
- [ ] Implement fenced leader loop with bounded retry and explicit -14 context invalidation; sort inbox by create_time_ms then messageID.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as feat(gateway): add fenced shared leader.

## Task 6: Decision Router and Concurrent Reply Semantics

**Files**

- Add src/decision-router.ts and src/decision-types.ts.
- Modify src/approval-parser.ts, src/approval-manager.ts.
- Add test/decision-router.test.js.

**Interfaces**

- DecisionCommand contains commandID, sourceMessageID, targetMode, requestIDs, decision, expectedRevisions and createdAtMs.
- TargetMode is SINGLE, BATCH, ORDINAL, PROJECT, OPERATION or SESSION.
- Router consumes an immutable pending snapshot and emits commands without calling the OpenCode API.

**Steps**

- [ ] Add failing tests for all allow/reject conflict ordering, ordinal mapping by createdAt, first-only continuation, target/decision separation and duplicate message idempotency.
- [ ] Run focused tests and confirm current manager combines parsing, model calls and API mutation in one process.
- [ ] Implement serial inbox consumption; the first successful claim wins, later conflicting commands produce clarification and never reapply.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as feat(approval): route concurrent decisions through snapshots.

## Task 7: Owner Command Worker

**Files**

- Add src/command-worker.ts and src/permission-applier.ts.
- Modify src/opencode-permissions.ts, src/approval-manager.ts and tests.
- Add test/command-worker.test.js.

**Interfaces**

- CommandWorker subscribes only to commands whose ownerInstanceID matches its instance.
- PermissionApplier uses injected OpenCodeClient and expected revision; it returns APPLIED, STALE or FAILED_RETRYABLE.
- Native OpenCode reply races are treated as STALE and removed from pending without a second authorization call.

**Steps**

- [ ] Add failing tests for owner-only application, stale requests, partial failures, once/always/reject payloads and retryable transport errors.
- [ ] Run focused tests and confirm HttpPermissionAPI/raw fetch is still the mutation path.
- [ ] Implement worker acknowledgement and safe retry; never log request content or credentials.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as feat(approval): apply commands in owning plugin process.

## Task 8: Native Plugin Runtime Composition

**Files**

- Add src/plugin-runtime.ts.
- Modify src/index.ts, src/install.ts, src/cli.ts, src/config.ts and plugin tests.
- Add or update test/plugin.test.js and test/plugin-architecture.test.js.

**Interfaces**

- PluginRuntime.start receives the official plugin input, registers hooks, starts instance heartbeat, and starts the leader only when elected.
- PluginRuntime.dispose releases instance and lease resources.
- PluginConfig contains model, confidence, timeout, mailboxPollMs and stateDirectory; it contains no host, port or central-server URL.

**Steps**

- [ ] Add failing architecture tests rejecting opencode attach, opencode web, fixed 4096 and module-global leaseOwner in production code.
- [ ] Run focused tests and confirm current install/docs/runtime still require a central server.
- [ ] Compose normal OpenCode lifecycle hooks with shared runtime; delete same-process event forwarding assumptions and remove fixed-server installer writes.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as refactor(plugin): run entirely inside OpenCode lifecycle.

## Task 9: Multi-Process Integration Fixture

**Files**

- Add test/fixtures/multiprocess-worker.mjs and test/multiprocess.test.js.
- Modify scripts/e2e-smoke.js if fixture invocation needs a stable entry.
- Add docs/testing-multiprocess.md.

**Interfaces**

- Fixture accepts a temp state directory and worker role through environment variables; it never uses real credentials.
- Test harness exposes deterministic WeChat transport, fake injected OpenCode clients and a controllable clock.

**Steps**

- [ ] Add failing process-level tests for two instances sharing one binding, one leader, mixed decisions, conflicting batch replies, leader crash/re-election, duplicate inbound messages, old epoch fencing and native reply races.
- [ ] Run node --test test/multiprocess.test.js and confirm failure against the current module-global lease.
- [ ] Implement only test infrastructure needed to reproduce real process boundaries; assert no fixed port is opened.
- [ ] Re-run fixture tests, npm run build, npm test and npm run test:e2e.
- [ ] Commit as test(multiprocess): cover shared binding and fencing.

## Task 10: Model Interpretation Safety

**Files**

- Modify src/model-interpreter.ts and src/decision-router.ts.
- Add test/model-interpreter.test.js and test/model-safety.test.js.

**Interfaces**

- ModelInterpretationRequest contains originalText, pendingSnapshot and session context summary.
- ModelInterpretation is validated against ModelDecision, confidence threshold and exact request IDs.
- Only explicit once/always/reject semantics may become commands; target-only, negation, questions, low confidence, invalid JSON and unknown IDs clarify or reject.

**Steps**

- [ ] Add failing tests for deterministic natural-language input, model always escalation after once, target-only text, negation, question, low confidence, invalid JSON and unknown request ID.
- [ ] Run focused tests and confirm model output can currently bypass the shared snapshot boundary.
- [ ] Implement a validator that compares user intent to model output and emits no command on mismatch; disable tools and delete internal sessions in finally.
- [ ] Re-run focused tests, npm run build and npm test.
- [ ] Commit as fix(model): enforce decision and target safety.

## Task 11: Configuration, Doctor and Release Cutover

**Files**

- Modify src/install.ts, src/cli.ts, src/config.ts, package.json, package-lock.json, README.md and affected docs.
- Add test/install.test.js, test/doctor.test.js and test/release-config.test.js.
- Update docs/release-impact-2.0.0.md and docs/acceptance.md.

**Interfaces**

- Installer writes only registry plugin spec and explicit user-approved permission scope; it preserves JSONC and rolls back atomically.
- Doctor reports plugin package, binding health, model health, shared state permissions, instance count and leader status; it does not start a server.
- Release metadata uses SemVer 2.0.0 only after all affected real scenarios are rerun.

**Steps**

- [ ] Add failing tests for registry package configuration, JSONC preservation, repeated install, rollback, doctor leader status and absence of server commands.
- [ ] Run focused tests and confirm current installer still writes host/port or file URL references.
- [ ] Implement configuration cutover, migration notices and docs mapping; keep legacy state readable and mark it migrated.
- [ ] Re-run focused tests, npm run build, npm test, npm run coverage and npm run test:e2e.
- [ ] Commit as feat!: remove central-server architecture and prepare v2 release.

---

## Verification and Real Acceptance

- [ ] Run final npm test, npm run build, npm run coverage, npm run test:e2e and git diff --check.
- [ ] Run the multi-process fixture in a clean temporary directory and verify no 4096 listener, no opencode web process and one shared binding.
- [ ] Use the registry package in two normal OpenCode processes for REAL-00 through REAL-18. Record scenario ID, package version, original window title, evidence mode, exact WeChat text, redacted requestID and decision, pending/outbox before and after, cleanup result and operator time.
- [ ] Verify single, batch, ordinal, target, ambiguity, model safety, lifecycle, failure, cancellation, timeout, restart/outbox, prepare failed/-14 recovery and cross-directory attach. Any missing real text evidence remains UNVERIFIED.
- [ ] Only after all affected scenarios pass, create a Conventional Commit and v2.0.0 tag; never include AGENTS.md, .omo/ or local state.

## Commit Checkpoints

Each task commit must contain only its implementation and tests. Use the prescribed commit type/scope, run git diff --check before committing, and keep release version/tag changes isolated from behavior changes.
