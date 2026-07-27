import assert from "node:assert/strict"
import test from "node:test"

import { InternalSessionRegistry } from "../dist/internal-session-registry.js"

test("keeps completed interpreter sessions ignored for delayed lifecycle events", () => {
  let now = 100
  const registry = new InternalSessionRegistry(60_000, () => now)

  registry.update("ses-internal", true)
  registry.update("ses-internal", false)
  assert.equal(registry.has("ses-internal"), true)

  now += 60_001
  assert.equal(registry.has("ses-internal"), false)
})
