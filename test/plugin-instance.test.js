import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { InstanceStatus, PluginInstanceRegistry } from "../dist/plugin-instance.js"

test("registers unique plugin instances and removes disposed records", () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-instance-"))
  const first = new PluginInstanceRegistry(directory)
  const second = new PluginInstanceRegistry(directory)
  const one = first.register({ projectDirectory: "/workspace/one", sessionIDs: ["ses-1"] })
  const two = second.register({ projectDirectory: "/workspace/two", sessionIDs: ["ses-2"] })

  assert.notEqual(one.instanceID, two.instanceID)
  assert.deepEqual(first.list().map((item) => item.status), [InstanceStatus.Active, InstanceStatus.Active])
  first.dispose(one.instanceID)
  assert.equal(first.list().some((item) => item.instanceID === one.instanceID), false)
})

test("updates heartbeat without changing instance identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "wechat-instance-heartbeat-"))
  const registry = new PluginInstanceRegistry(directory, { now: () => 10 })
  const record = registry.register({ projectDirectory: "/workspace", sessionIDs: [] })

  registry.heartbeat(record.instanceID, 20)

  assert.equal(registry.list()[0].instanceID, record.instanceID)
  assert.equal(registry.list()[0].heartbeatAt, 20)
})

test("prunes dead and expired plugin instances before reporting active state", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-plugin-instance-prune-"))
  writeFileSync(
    join(root, "plugin-instances-v1.json"),
    JSON.stringify([
      {
        instanceID: "live",
        pid: 10,
        processFingerprint: "test:10",
        projectDirectory: "/live",
        sessionIDs: [],
        heartbeatAt: 95,
        status: "active",
      },
      {
        instanceID: "dead",
        pid: 11,
        processFingerprint: "test:11",
        projectDirectory: "/dead",
        sessionIDs: [],
        heartbeatAt: 95,
        status: "active",
      },
      {
        instanceID: "expired",
        pid: 12,
        processFingerprint: "test:12",
        projectDirectory: "/expired",
        sessionIDs: [],
        heartbeatAt: 1,
        status: "active",
      },
    ]),
  )
  const registry = new PluginInstanceRegistry(root, {
    now: () => 100,
    processAlive: (pid) => pid !== 11,
    processFingerprint: (pid) => `test:${pid}`,
    staleAfterMs: 50,
  })

  assert.deepEqual(registry.prune().map((item) => item.instanceID), ["live"])
  assert.deepEqual(registry.list().map((item) => item.instanceID), ["live"])
})

test("prunes a reused pid with a different process fingerprint", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-plugin-instance-pid-reuse-"))
  writeFileSync(
    join(root, "plugin-instances-v1.json"),
    JSON.stringify([{
      instanceID: "old-process",
      pid: 10,
      processFingerprint: "start:old",
      projectDirectory: "/old",
      sessionIDs: [],
      heartbeatAt: 100,
      status: "active",
    }]),
  )
  const registry = new PluginInstanceRegistry(root, {
    now: () => 100,
    processAlive: () => true,
    processFingerprint: () => "start:new",
  })

  assert.deepEqual(registry.prune(), [])
})
