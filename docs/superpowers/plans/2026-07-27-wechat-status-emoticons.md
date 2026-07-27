# WeChat Status Emoticons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefix every OpenCode status notification with a WeChat-native image emoticon shortcut.

**Architecture:** Add a small, pure status-message formatter that owns the shortcut mapping and fallback behavior. Route existing notification strings through that formatter without changing the ilink message transport, then mirror the compiled change into the active local plugin.

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin API, WeChat ilink text messages

---

### Task 1: Status message formatter

**Files:**
- Create: `src/status-message.ts`
- Create: `test/status-message.test.js`

- [ ] **Step 1: Write the failing formatter tests**

```js
import assert from "node:assert/strict"
import test from "node:test"

import { formatStatusMessage, WECHAT_STATUS_EMOTICONS } from "../dist/status-message.js"

test("maps OpenCode states to WeChat image emoticon shortcuts", () => {
  assert.deepEqual(WECHAT_STATUS_EMOTICONS, {
    done: "[庆祝]",
    error: "[苦涩]",
    approval: "[让我看看]",
    approved: "[好的]",
    rejected: "[NO]",
    timeout: "[叹气]",
    warning: "[汗]",
    help: "[机智]",
  })
})

test("prefixes a status message with one WeChat shortcut", () => {
  assert.equal(formatStatusMessage("done", "[Done] Build\nAI task completed."), "[庆祝] [Done] Build\nAI task completed.")
})

test("falls back to the warning shortcut for an unknown state", () => {
  assert.equal(formatStatusMessage("unknown", "Unexpected state"), "[汗] Unexpected state")
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm run build && node --test test/status-message.test.js
```

Expected: FAIL because `dist/status-message.js` does not exist.

- [ ] **Step 3: Implement the minimal formatter**

```ts
export const WECHAT_STATUS_EMOTICONS = {
  done: "[庆祝]",
  error: "[苦涩]",
  approval: "[让我看看]",
  approved: "[好的]",
  rejected: "[NO]",
  timeout: "[叹气]",
  warning: "[汗]",
  help: "[机智]",
} as const

export type WeChatStatus = keyof typeof WECHAT_STATUS_EMOTICONS

export function formatStatusMessage(status: string, message: string): string {
  const emoticon =
    WECHAT_STATUS_EMOTICONS[status as WeChatStatus] ?? WECHAT_STATUS_EMOTICONS.warning
  return `${emoticon} ${message}`
}
```

- [ ] **Step 4: Run the formatter tests and verify GREEN**

Run:

```bash
npm run build && node --test test/status-message.test.js
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the formatter**

```bash
git add src/status-message.ts test/status-message.test.js
git commit -m "Add WeChat status emoticon formatter"
```

### Task 2: Route notifications through the formatter

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/status-message.test.js`

- [ ] **Step 1: Import the formatter**

Add:

```ts
import { formatStatusMessage } from "./status-message.js"
```

- [ ] **Step 2: Format approval results without relying on message prefixes**

Before calling `handlePermissionConfirmation`, record whether the code is active:

```ts
const wasPending = pendingPermissions.has(cmd.code)
const result = await handlePermissionConfirmation(cmd.code, response)
await wechat.notifyUser(result)

if (response !== "reject" && wasPending) {
  // Existing retry-prompt logic remains unchanged.
}
```

Return formatted results:

```ts
const status = response === "reject" ? "rejected" : "approved"
return formatStatusMessage(status, `[OK] #${code} ${label}`)
```

For expired codes:

```ts
return formatStatusMessage("warning", `[WARN] #${code} expired, please retry the operation`)
```

- [ ] **Step 3: Format event, prompt, timeout, help, and confirmation messages**

Apply these exact mappings:

```ts
formatStatusMessage("done", `[Done] ${title}\nAI task completed.`)
formatStatusMessage("error", `[Error] ${title}\n${errMsg.slice(0, 500)}`)
formatStatusMessage("approval", approvalMessage)
formatStatusMessage("timeout", `[Timeout] #${code} auto-denied (10min)`)
formatStatusMessage("help", helpMessage)
formatStatusMessage("approval", confirmationMessage)
formatStatusMessage(response === "reject" ? "rejected" : "approved", resultMessage)
```

- [ ] **Step 4: Document the status mapping**

Add the eight-state shortcut table to `README.md` and explain that WeChat converts shortcuts such as `[庆祝]` into native image emoticons while unsupported clients show readable text.

- [ ] **Step 5: Run the full test suite**

Run:

```bash
npm test
git diff --check
```

Expected: all tests pass and `git diff --check` prints no errors.

- [ ] **Step 6: Commit notification integration**

```bash
git add src/index.ts README.md
git commit -m "Use WeChat emoticons in status notifications"
```

### Task 3: Deploy and publish

**Files:**
- Create: `/Users/kunwei/Documents/workspace/docs/.opencode/wechat/status-message.js`
- Modify: `/Users/kunwei/Documents/workspace/docs/.opencode/plugins/index.js`

- [ ] **Step 1: Build the publishable plugin**

Run:

```bash
npm test
```

Expected: all tests pass and `dist/status-message.js` exists.

- [ ] **Step 2: Mirror the formatter into the active plugin**

Copy the compiled formatter to:

```text
/Users/kunwei/Documents/workspace/docs/.opencode/wechat/status-message.js
```

Update the active entry import to:

```js
import { formatStatusMessage } from "../wechat/status-message.js";
```

Apply the same notification formatting calls from Task 2 to the active compiled entry.

- [ ] **Step 3: Verify the active plugin**

Run:

```bash
node --check /Users/kunwei/Documents/workspace/docs/.opencode/plugins/index.js
node --check /Users/kunwei/Documents/workspace/docs/.opencode/wechat/status-message.js
node --test test/*.test.js
```

Expected: syntax checks and all tests pass.

- [ ] **Step 4: Restart OpenCode and verify registration**

Restart `opencode web --port 4096`, then query:

```bash
curl -fsS --get "http://127.0.0.1:4096/experimental/tool/ids" \
  --data-urlencode "directory=/Users/kunwei/Documents/workspace/docs"
```

Expected: response includes all five `wechat_*` tools and startup logs contain no plugin errors.

- [ ] **Step 5: Push and verify GitHub**

```bash
git push
git status -sb
git ls-remote origin refs/heads/main
```

Expected: local `main` is clean, tracks `origin/main`, and both commit hashes match.
