# Windows Compatibility and TypeScript Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the real Windows process-lease failure mode, remove the legacy HOME path assumption, and migrate executable E2E tooling from JavaScript to TypeScript without changing product behavior.

**Architecture:** Keep Node/libuv's existing same-directory temporary-file, fsync, and rename persistence path on every platform. Inject a small process inspector into RuntimeLease; an unavailable process-start probe fails closed and cannot steal a live PID lease. Compile scripts/*.ts into dist-scripts/ with an independent TypeScript project and make both E2E npm commands build before execution.

**Tech Stack:** TypeScript 5, Node.js 20+, Node node:test, Node node:fs, Node node:child_process, npm scripts, GitHub Actions Windows/macOS/Linux matrix.

## Global Constraints

- Node.js version floor remains >=20.
- Product code and CLI support Windows, macOS, and Linux through TypeScript/Node.js.
- Do not add a Windows-specific backup replacement layer for rename; retain the existing temp-file, fsync, and rename path.
- When a live PID process-start probe fails, lease acquisition must fail closed and must not take over the lease.
- wechat-login.ts must use os.homedir() and must not use process.env.HOME or the literal ~ fallback.
- scripts/e2e-smoke.js and scripts/e2e-live.js become TypeScript source; test/*.test.js and test/run-tests.js remain JavaScript because Node executes them directly.
- dist/ and dist-scripts/ are generated artifacts and must not be hand-edited or committed.
- Windows ACL isolation is not claimed as fixed; documentation must state that Node chmod(0600) does not verify Windows owner/group/other ACLs.
- Every changed production behavior gets a failing test before implementation; changed methods stay within 20 lines and include concise Chinese business comments.

---

### Task 1: Make runtime lease process probing conservative and testable

Files:
- Modify: src/runtime-lease.ts
- Test: test/runtime-lease.test.js

Interfaces:
- Produce ProcessInspector with exists(pid: number): boolean and startTime(pid: number): string | null.
- Extend RuntimeLease constructor options with processInspector?: ProcessInspector.
- Keep RuntimeLease.acquire(), release(), setOnLost(), and lease-file JSON fields backward compatible.

- [ ] Step 1: Write the failing regression test

Add this test to test/runtime-lease.test.js:

~~~js
test("does not take over a live PID when process start probing is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-runtime-lease-unknown-start-"))
  writeFileSync(
    join(root, "runtime-lease.json"),
    JSON.stringify({
      instanceID: "live-owner",
      pid: process.pid,
      processStart: "owner-start",
      heartbeatAt: Date.now(),
    }),
  )
  const lease = new RuntimeLease(root, {
    processInspector: {
      exists: () => true,
      startTime: () => null,
    },
  })

  assert.equal(lease.acquire(), false)
})
~~~

- [ ] Step 2: Run the focused test and verify RED

Run:

~~~bash
npm run build && node --test test/runtime-lease.test.js --test-name-pattern="process start probing is unavailable"
~~~

Expected: FAIL because RuntimeLease does not accept the injected inspector and a failed start probe is currently treated as a different process.

- [ ] Step 3: Implement the minimal inspector abstraction

Add this interface and option:

~~~ts
export interface ProcessInspector {
  exists(pid: number): boolean
  startTime(pid: number): string | null
}

interface RuntimeLeaseOptions {
  now?: () => number
  staleAfterMs?: number
  heartbeatIntervalMs?: number
  processInspector?: ProcessInspector
}
~~~

Use this ownership rule:

~~~ts
function sameProcess(record: LeaseRecord, inspector: ProcessInspector): boolean {
  if (!inspector.exists(record.pid)) return false
  if (!record.processStart) return true
  const currentStart = inspector.startTime(record.pid)
  return currentStart === null || currentStart === record.processStart
}
~~~

Add a named PROCESS_PROBE_TIMEOUT_MS = 1_000 constant and pass timeout: PROCESS_PROBE_TIMEOUT_MS to the Windows spawnSync powershell.exe call. Preserve successful different-start and missing-PID reclamation. Add Chinese comments describing the fail-closed security intent.

- [ ] Step 4: Run focused lease tests and verify GREEN

Run:

~~~bash
npm run build && node --test test/runtime-lease.test.js
~~~

Expected: all runtime lease tests pass, including the new unknown-start test.

- [ ] Step 5: Refactor only after green

Keep constructor option normalization and process-inspector selection in helpers of 20 lines or fewer. Re-run the focused lease tests.

### Task 2: Remove the legacy Windows home-directory assumption

Files:
- Modify: wechat-login.ts
- Create: test/tooling.test.js

Interfaces:
- wechat-login.ts remains a legacy TypeScript source tool and is not added to the published package.
- The source-policy test reads the source file only; it never executes the QR login flow or contacts WeChat.

- [ ] Step 1: Write the failing source-policy test

Create test/tooling.test.js:

~~~js
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const loginSource = readFileSync(new URL("../wechat-login.ts", import.meta.url), "utf8")

test("legacy login tool resolves its state directory from the platform home", () => {
  assert.match(loginSource, /os\.homedir\(\)/)
  assert.doesNotMatch(loginSource, /process\\.env\\.HOME/)
  assert.doesNotMatch(loginSource, /["']~["']/)
})
~~~

- [ ] Step 2: Run the new test and verify RED

Run:

~~~bash
npm run build && node --test test/tooling.test.js --test-name-pattern="legacy login"
~~~

Expected: FAIL because wechat-login.ts still references process.env.HOME.

- [ ] Step 3: Fix the legacy tool path and method boundaries

Import node:os and replace the path expression with:

~~~ts
const WECHAT_DIR = path.join(os.homedir(), ".opencode", "wechat-approve")
~~~

Split the current long main() into fetchQRCode(), pollQRCode(), saveAccount(), and delay() helpers so each method is at most 20 lines. Keep QR protocol, timeout behavior, credential redaction, and user-facing messages unchanged. Add Chinese comments describing QR expiration, confirmation validation, and credential persistence.

- [ ] Step 4: Run the source-policy test and verify GREEN

Run:

~~~bash
npm run build && node --test test/tooling.test.js --test-name-pattern="legacy login"
~~~

Expected: the legacy login path test passes.

### Task 3: Migrate E2E tools to TypeScript and compile them separately

Files:
- Delete: scripts/e2e-smoke.js
- Delete: scripts/e2e-live.js
- Create: scripts/e2e-smoke.ts
- Create: scripts/e2e-live.ts
- Create: tsconfig.scripts.json
- Modify: package.json
- Modify: .gitignore
- Test: test/tooling.test.js

Interfaces:
- Compile scripts/*.ts with rootDir scripts and outDir dist-scripts.
- Produce dist-scripts/e2e-smoke.js and dist-scripts/e2e-live.js.
- Preserve executable selection, shell: false, environment redaction, temporary cleanup, and interactive TTY guards.

- [ ] Step 1: Add the TypeScript project configuration

Create tsconfig.scripts.json:

~~~json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./scripts",
    "outDir": "./dist-scripts",
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["scripts/**/*.ts"],
  "exclude": ["node_modules", "dist", "dist-scripts"]
}
~~~

- [ ] Step 2: Rename the source tools and add explicit types

Port the current JavaScript bodies to TypeScript. Define these types in e2e-live.ts:

~~~ts
type Scenario = readonly [scenarioID: string, description: string]
type Decision = { requestID: string; decision: "once" | "always" | "reject" }
type ScenarioRecord = {
  scanTime: string
  scenario: string
  description: string
  observedText: string
  decisions: Decision[]
  pendingBefore: number
  pendingAfter: number
}
~~~

Type every existing function, keep each method within 20 lines, and extract only existing responsibilities. Do not add E2E scenarios or change redaction rules.

- [ ] Step 3: Update build and E2E npm commands

Change build to clean both generated directories and compile both projects. Make E2E commands build before executing generated tools:

~~~json
{
  "build": "node -e \"const fs=require('node:fs'); fs.rmSync('dist',{recursive:true,force:true}); fs.rmSync('dist-scripts',{recursive:true,force:true})\" && tsc && tsc -p tsconfig.scripts.json",
  "test:e2e": "npm run build && node dist-scripts/e2e-smoke.js",
  "test:e2e:live": "npm run build && node dist-scripts/e2e-live.js"
}
~~~

Add dist-scripts/ to .gitignore; keep it outside the package files list.

- [ ] Step 4: Extend tooling tests and verify GREEN

Add tests asserting that package scripts reference both generated files, then run:

~~~bash
npm run build && node --test test/tooling.test.js
~~~

Expected: both compiled tools exist, scripts/ contains no .js files, and all tooling tests pass.

### Task 4: Synchronize documentation and preserve the ACL boundary

Files:
- Modify: docs/e2e-test-plan.md
- Modify: docs/acceptance.md
- Test: test/tooling.test.js

- [ ] Step 1: Add the documentation consistency expectation

Add:

~~~js
test("E2E documentation names the TypeScript source tools", () => {
  const plan = readFileSync(new URL("../docs/e2e-test-plan.md", import.meta.url), "utf8")
  assert.match(plan, /scripts\/e2e-smoke\.ts/)
  assert.match(plan, /dist-scripts\/e2e-smoke\.js/)
})
~~~

- [ ] Step 2: Run the documentation test and verify RED

Run:

~~~bash
npm run build && node --test test/tooling.test.js --test-name-pattern="documentation"
~~~

Expected: FAIL because the E2E plan still names scripts/e2e-smoke.js.

- [ ] Step 3: Update documentation

Replace source-tool references with scripts/*.ts and compiled output paths. Add an explicit acceptance note that Windows ACL effective isolation remains unverified and requires a separate platform-specific security design.

- [ ] Step 4: Run tooling and documentation tests and verify GREEN

Run:

~~~bash
npm run build && node --test test/tooling.test.js
~~~

Expected: all source-policy, package-script, and documentation consistency tests pass.

### Task 5: Full verification and handoff

Files:
- Verify only: git diff, generated artifact status, test output, build output

- [ ] Step 1: Run focused regressions

~~~bash
npm run build && node --test test/runtime-lease.test.js test/tooling.test.js
~~~

Expected: all lease, tooling, and documentation tests pass.

- [ ] Step 2: Run the complete suite

~~~bash
npm test
~~~

Expected: the complete Node test suite passes with zero failures.

- [ ] Step 3: Run the package E2E smoke command

~~~bash
npm run test:e2e
~~~

Expected: the compiled smoke tool builds the package, runs tests and coverage, validates npm package contents, and prints E2E smoke passed without secrets.

- [ ] Step 4: Inspect the final diff and generated artifacts

~~~bash
git diff --check
git status --short
rg --files scripts -g "*.js"
~~~

Expected: no whitespace errors, no JavaScript files remain under scripts/, and dist/ and dist-scripts/ are absent from the tracked diff. Preserve the user's existing AGENTS.md, .opencode/, docs/approval-security-matrix.md, docs/acceptance.md, and docs/e2e-test-plan.md changes except for documented lines required by this plan.
