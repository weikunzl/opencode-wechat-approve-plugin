import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const executeFile = promisify(execFile)
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))
const PACKAGE_NAME = "@wekux/opencode-wechat-approve-plugin"
const CLI_NAME = "wechat-approve"
const EXPECTED_FILES = ["README.md", "dist/bin.js", "dist/index.js"]
const MAX_BUFFER = 4 * 1024 * 1024
const NPM_EXECUTABLE = process.platform === "win32" ? "npm.cmd" : "npm"
const NPX_EXECUTABLE = process.platform === "win32" ? "npx.cmd" : "npx"

async function run(command, args, cwd = REPOSITORY_ROOT) {
  // 统一关闭 npm 遥测和审计输出，避免测试日志泄露环境信息。
  const environment = {
    ...process.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  }
  try {
    return await executeFile(command, args, {
      cwd,
      env: environment,
      maxBuffer: MAX_BUFFER,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${command} ${args.join(" ")} 失败: ${detail.split(/\r?\n/, 1)[0]}`)
  }
}

function assertIncludes(text, expected) {
  // 只检查公开 CLI 帮助文本，不把运行环境中的凭据写入报告。
  for (const line of expected) {
    if (!text.includes(line)) throw new Error(`CLI 输出缺少: ${line}`)
  }
}

function parsePackInfo(stdout) {
  // npm pack --json 返回单元素数组，结构变化时应立即让冒烟测试失败。
  const entries = JSON.parse(stdout)
  const info = Array.isArray(entries) ? entries[0] : null
  if (!info || typeof info.filename !== "string") throw new Error("无法解析 npm pack 结果")
  return info
}

function assertPackageContents(info) {
  // 发布包只能依赖构建产物和用户手册，防止把测试或凭据带入 npm。
  const names = new Set(info.files.map((file) => file.path))
  for (const file of EXPECTED_FILES) {
    if (!names.has(file)) throw new Error(`发布包缺少: ${file}`)
  }
}

async function createTarball() {
  const result = await run(NPM_EXECUTABLE, ["pack", "--silent", "--json"])
  const info = parsePackInfo(result.stdout)
  assertPackageContents(info)
  return path.join(REPOSITORY_ROOT, info.filename)
}

async function verifyNpx(spec) {
  // 默认从本地 tarball 验证，设置 E2E_NPM_SPEC 后可切换到 registry 包。
  const tempDirectory = await fs.mkdtemp(path.join(tmpdir(), "wechat-approve-e2e-"))
  try {
    const result = await run(
      NPX_EXECUTABLE,
      ["--yes", "--package", spec, CLI_NAME, "--help"],
      tempDirectory,
    )
    assertIncludes(result.stdout, [
      "wechat-approve install",
      "wechat-approve bind",
      "wechat-approve doctor",
    ])
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
}

async function main() {
  // 先执行现有集成矩阵，再验证最终 npm 包的 CLI 入口。
  await run(NPM_EXECUTABLE, ["run", "build"])
  await run(NPM_EXECUTABLE, ["test"])
  await run(NPM_EXECUTABLE, ["run", "coverage"])
  const tarball = await createTarball()
  const packageSpec = process.env.E2E_NPM_SPEC ?? tarball
  try {
    await verifyNpx(packageSpec)
  } finally {
    await fs.rm(tarball, { force: true })
  }
  process.stdout.write(`E2E smoke passed: ${PACKAGE_NAME}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
