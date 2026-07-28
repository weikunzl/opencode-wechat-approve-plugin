import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
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
  const registry = new PluginInstanceRegistry(directory, () => 10)
  const record = registry.register({ projectDirectory: "/workspace", sessionIDs: [] })

  registry.heartbeat(record.instanceID, 20)

  assert.equal(registry.list()[0].instanceID, record.instanceID)
  assert.equal(registry.list()[0].heartbeatAt, 20)
})
