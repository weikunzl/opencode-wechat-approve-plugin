import { readdir } from "node:fs/promises"

const testFiles = (await readdir(new URL(".", import.meta.url)))
  .filter((name) => name.endsWith(".test.js"))
  .sort()

for (const name of testFiles) {
  await import(new URL(name, import.meta.url))
}
