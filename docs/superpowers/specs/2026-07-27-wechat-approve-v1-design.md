# WeChat Approve V1 Design

## 1. Purpose

`wechat-approve` is a global OpenCode plugin that reports the outcome of every
session managed by one central OpenCode server and lets the bound WeChat user
respond to pending OpenCode permission requests.

V1 is not a chat bridge. A WeChat message must never create an OpenCode
session, append a prompt to a session, or invoke an agent. Inbound messages are
accepted only during initial binding or while at least one permission request
is pending.

## 2. Supported Runtime Model

V1 uses one central OpenCode server on `127.0.0.1:4096`.

The shipped implementation is cross-platform TypeScript/Node.js and supports
Windows, macOS, and Linux. Product code must not depend on AppleScript,
Accessibility APIs, `launchd`, Unix sockets, `flock`, Bash, or POSIX-only
process signals. macOS Accessibility is used only by the real acceptance
driver on the developer machine and is not part of the plugin or installer.

```text
opencode web / serve :4096
├── sessions for project A
├── sessions for project B
├── sessions for project C
└── one global wechat-approve plugin instance
```

Additional terminals attach to that server:

```bash
opencode attach http://127.0.0.1:4096 --dir /absolute/project/path
```

Starting independent OpenCode servers creates independent plugin instances and
is outside V1's supported topology. The installer and health command must
detect and explain this instead of silently claiming multi-process coverage.

## 3. Installation and Binding

The package exposes a CLI:

```bash
npx opencode-wechat-approve-plugin install
```

The installer performs these steps in order:

1. Verify that `opencode` is installed and supports `plugin`, `web`, and
   `attach`.
2. Resolve the effective global OpenCode model.
3. Show the provider/model identifier and require explicit confirmation. If it
   is missing or unavailable, let the user choose from `opencode models` and
   persist the selection.
4. Add the package to the global OpenCode plugin configuration without
   deleting unrelated settings or comments.
5. Set the default server to `127.0.0.1:4096`, unless the user explicitly
   chooses another loopback port during installation.
6. Request an iLink Bot QR code, render it in the terminal, and wait for scan
   confirmation.
7. Persist the returned bot token, bot ID, base URL, and bound user ID with
   file mode `0600`.
8. Ask the user to send the fixed text `绑定` once. This inbound message supplies
   the iLink `context_token` required for later proactive notifications.
9. Restrict all future inbound processing to the bound user and persist the
   context token.
10. Send a test notification and finish only after the API accepts it.

The confirmed default model is used only by the approval intent interpreter.
Session completion and failure notifications do not require a model.

Re-running the installer is idempotent. It offers to keep the existing binding,
rebind WeChat, or update only the model.

## 4. Components

### 4.1 Installer

Owns environment checks, model confirmation, global configuration edits, QR
binding, and installation verification. It never starts an AI task.

### 4.2 WeChat Gateway

Owns exactly one iLink long-poll loop, outbound delivery, retry policy, cursor
persistence, context-token refresh, inbound deduplication, and bound-user
filtering.

### 4.3 Session Notifier

Consumes OpenCode events and maintains a per-session state machine:

```text
unknown/idle -> busy -> completed
                     -> failed
                     -> cancelled
```

A completion notification is emitted only for a real `busy -> idle`
transition. A `session.error` marks the run failed and suppresses the
immediately following idle event. Repeated events for the same run are
idempotent.

Notifications include:

- status emoji;
- session title;
- session ID;
- project directory;
- completion time or concise failure reason.

### 4.4 Approval Manager

Consumes `permission.asked` events and stores the OpenCode request ID, session
ID, project, permission, patterns, metadata, timestamps, and a short display
number.

It calls OpenCode's permission reply endpoint with one of:

- `once`;
- `always`;
- `reject`.

It does not inject prompts into sessions and does not emulate `always` with a
one-time hook mutation.

### 4.5 Intent Interpreter

Uses a safety-first hybrid strategy:

1. Normalize punctuation, casing, whitespace, Chinese variants, and common
   English forms.
2. Resolve clear phrases locally.
3. For multiple pending requests or referential language, ask the confirmed
   model for a structured interpretation.
4. Validate the model output against the current pending-request snapshot.
5. If the target set or decision is ambiguous, ask a follow-up question and
   execute nothing.

The model returns data only:

```ts
interface ApprovalIntent {
  requestIDs: string[]
  decision: "once" | "always" | "reject" | "clarify"
  confidence: number
  explanation: string
}
```

The model cannot call tools or permission APIs. Unknown request IDs, an empty
selection, conflicting decisions, or confidence below the configured threshold
become `clarify`.

### 4.6 Persistent Store

All state lives under:

```text
~/.opencode/wechat-approve/
├── account.json
├── config.json
├── context.json
├── cursor.json
├── pending-approvals.json
├── notification-outbox.json
└── runtime.json
```

Writes use a temporary file, `fsync`, atomic rename, and restrictive
permissions where the operating system supports POSIX modes. Windows relies on
the current user's profile ACLs; a doctor check warns when the state directory
is accessible to other principals. Corrupt files are quarantined with a
timestamp instead of being silently overwritten.

## 5. Approval Conversation

### 5.1 One Pending Request

Clear replies execute directly:

- `是`, `OK`, `好的`, `同意`, `允许`, `yes` -> `once`;
- `全部授权`, `始终允许`, `always`, `allow all` -> `always`;
- `no`, `拒绝`, `不同意`, `取消` -> `reject`.

### 5.2 Multiple Pending Requests

Every notification contains a short number and identifying context, but the
user is not required to type that number.

If the user says only `好的`, no permission is changed. The plugin asks which
request or requests were intended and presents a numbered summary.

Natural replies may select by:

- ordinal: `第一个`;
- number: `1 和 3`;
- project/session: `docs 项目的`;
- operation: `npm test 那个`;
- set: `两个都允许`, `全部拒绝`.

Selection scope and decision scope remain distinct:

- `两个都允许` applies `once` to both selected requests;
- `两个都始终允许` applies `always` to both;
- `只拒绝 git push` applies `reject` to the matching request only.

### 5.3 Concurrent Changes

Clarification uses a versioned snapshot. Before execution, the manager reloads
pending permissions from OpenCode. Expired or already answered requests are
removed. If the selected set changed, the plugin explains the change and asks
again instead of applying a stale decision.

Batch responses are executed independently. A partial failure reports exactly
which requests succeeded, expired, or failed; successful replies are never
repeated.

### 5.4 No Pending Request

Inbound messages other than the one-time binding message are silently ignored.
No model call is made and no session is created.

## 6. Failure Handling

### WeChat transport

- Long-poll timeout is normal and immediately reconnects.
- Transient failures use bounded exponential backoff with jitter.
- Authentication failure pauses delivery and emits a local diagnostic asking
  for rebind.
- Outbound notifications enter a persistent outbox before sending.
- A stable idempotency key prevents duplicate sends after restart.
- Messages that exceed the platform limit are summarized and truncated without
  exposing credentials.

### OpenCode lifecycle

- Duplicate busy, idle, error, and permission events are deduplicated.
- Missing session metadata falls back to the session ID and known directory.
- Error objects are normalized to a concise first-line message.
- A failed run never emits a subsequent success notification.
- A user cancellation is reported as cancelled, not failed or completed.
- Plugin startup reconciles current pending permissions with persisted state.
- A native OpenCode approval removes the matching WeChat pending request.

### Approval safety

- Only the QR-bound WeChat user is accepted.
- Group messages are rejected in V1.
- Ambiguous text never grants permission.
- Model failure falls back to a deterministic numbered clarification.
- Approval requests expire after a configurable timeout, default 10 minutes.
- Timeout performs `reject` only if OpenCode still reports the request pending.
- Reply API failures preserve the pending item and report that no decision was
  applied.
- `always` is sent only when the user explicitly expresses persistent scope.

### Local state and process failures

- Only one long-poll loop may run in the supported central-server topology.
- A second independent plugin instance detects the active runtime lease and
  disables inbound processing with a visible local warning.
- Runtime leasing uses an exclusive state file plus PID/heartbeat validation,
  not `flock`, so the same algorithm works on Windows, macOS, and Linux.
- Restart resumes the cursor, outbox, session run states, and pending approval
  reconciliation.
- Secrets and context tokens are redacted from logs.

## 7. Security Boundaries

- Listen only on loopback by default.
- Recommend an `OPENCODE_SERVER_PASSWORD`; never persist it in plugin logs.
- Store bot credentials and context tokens with mode `0600`.
- On Windows, store state under the user's profile and verify effective ACL
  isolation instead of claiming POSIX `0600` semantics.
- Never include environment variables, full file contents, or secrets in
  WeChat notifications.
- Limit approval previews to permission type, sanitized patterns, project,
  session, and bounded metadata.
- Remove the existing AI chat bridge and all general-purpose WeChat tools from
  V1.

## 8. Testing Strategy

### Unit tests

- deterministic intent synonyms and negations;
- selection of one, many, and all requests;
- ambiguity and confidence thresholds;
- model-output validation;
- session transition and notification deduplication;
- error formatting;
- atomic store recovery and permissions;
- timeout and stale-snapshot behavior.

### Integration tests

Use fake OpenCode and fake iLink HTTP servers to verify:

- installation/model confirmation;
- QR wait, scan, confirm, bind, and expiry;
- global session completion/failure notifications;
- `once`, `always`, and `reject` API payloads;
- multiple simultaneous approvals and clarification;
- native approval racing with WeChat;
- restart reconciliation;
- transport retry, authentication failure, and outbox replay;
- unauthorized sender and group-message rejection;
- ordinary messages never reach OpenCode.

Run the automated suite on current Windows, macOS, and Linux runners. Path
handling uses `node:path`/`node:os`; child processes use argument arrays with
`shell: false`; tests must not assume `/tmp`, `$HOME`, slash separators, or
POSIX exit signals.

### Real end-to-end acceptance

On the user's machine:

Desktop automation may interact only with the WeChat conversation whose title
is exactly `微信ClawBot`. Before every send, the acceptance driver must read the
active conversation title and stop if it is not an exact match. It must not
open, inspect, or send to any other contact, conversation, or group.

1. Run the installer and confirm the selected model.
2. Reuse or renew QR binding and send `绑定`.
3. Start the central server on port 4096.
4. Attach two different project directories.
5. Complete one session and verify its exact identity in WeChat.
6. Fail one session and verify one concise failure notification and no Done.
7. Trigger one permission and test `好的`.
8. Trigger another and test `全部授权`.
9. Trigger another and test `拒绝`.
10. Trigger two concurrently and test conversational disambiguation plus a
    batch decision.
11. Send an ordinary message with no pending approval and verify that OpenCode
    receives nothing.
12. Restart OpenCode and verify state recovery without duplicate messages.

The release is not complete until automated tests pass and the real WeChat
acceptance flow has been exercised.

## 9. Migration From the Current Prototype

V1 removes:

- bound OpenCode session state;
- inbound prompt forwarding;
- automatic WeChat-created sessions;
- `wechat_reply`, `wechat_send_image`, `wechat_notify`,
  `wechat_permission_confirm`, and `wechat_new_session` AI tools;
- `help` and `status` chatbot commands;
- permission approval through prompt injection.

Existing account and context credentials are migrated in place when valid.
Legacy session files are ignored and archived during installation.
