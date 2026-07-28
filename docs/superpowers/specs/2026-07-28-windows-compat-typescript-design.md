# Windows 兼容性与 TypeScript 工具迁移设计

## 目标

修复仓库中真实存在的 Windows 用户目录和租约进程探测风险，
并将能够由 TypeScript 编译的项目 E2E 工具从 JavaScript 迁移到 TypeScript。
不改变审批安全边界、微信协议、配置格式和公开 CLI 行为。

## 范围与现状结论

- Node.js 20 在 Windows 上通过 libuv 支持临时文件重命名覆盖已有目标，当前
  Windows CI 已验证 Store、Installer 和 RuntimeLease 的现有写入路径，因此不
  新增 Windows 专用备份替换层，也不削弱现有 fsync 加 rename 的恢复语义。
- `runtime-lease.ts` 在 Windows 上使用 `powershell.exe` 查询进程启动时间，调用
  没有超时；进程仍存活但探测失败时，当前逻辑可能错误抢占活跃租约。
- `wechat-login.ts` 使用 `process.env.HOME || "~"`，Windows 通常没有 `HOME`，
  且 Node 不会自动展开字面量 `~`。
- `scripts/e2e-smoke.js` 和 `scripts/e2e-live.js` 是项目工具代码，能够在构建
  阶段编译为 TypeScript。`test/*.test.js` 和 `test/run-tests.js` 继续使用
  JavaScript，因为仓库约定由 Node.js `node:test` 直接执行并从 `dist/` 导入。

## 方案

### 文件写入与 Windows 回归

保留 `src/store.ts`、`src/install.ts` 和 `src/runtime-lease.ts` 当前的同目录
临时文件、fsync 和 rename 实现，不引入第三方原子写入依赖，不增加“旧文件备份
后再替换”的文件缺失窗口。

新增回归覆盖既有目标反复写入、安装失败回滚和租约心跳；这些测试在现有
Windows CI 矩阵中真实运行，而不是通过伪造 `process.platform` 模拟 Windows。
若文件被外部程序以不共享删除权限打开，写入失败必须向上层报告，不能删除目标
文件后静默继续。

### 租约进程探测

`RuntimeLease` 继续使用排他状态文件、实例 ID、PID 和进程启动时间判断所有权，
不改用文件 mtime 作为新的心跳协议。将进程检查抽象为可注入的探测器：

- `process.kill(pid, 0)` 继续判断 PID 是否存在；Node.js 在 Windows 也支持该
  用法。
- Windows PowerShell 查询设置明确的短超时，并把启动时间探测失败视为未知。
- PID 仍存活但启动时间探测失败时，按“仍可能是原进程”处理，拒绝抢占；只有
  PID 已不存在，或成功探测到不同启动时间时，才允许回收租约。

这样优先避免第二个轮询实例被错误启动。租约的损坏文件隔离、释放、心跳内容
更新和租约丢失回调保持现有行为。

### 用户目录与工具构建

`wechat-login.ts` 使用 `os.homedir()` 构造状态目录，并保留现有凭据文件权限
和输出边界。该文件是未被 npm 命令引用的遗留 TypeScript 工具，继续保留源文件
但不纳入发布包；新增源代码检查确保它不再依赖 `HOME` 或字面量 `~`。

Windows 上 Node 的 `chmod(0600)` 不提供 owner/group/others ACL 隔离。当前任务
不伪称已经完成 Windows ACL 验证；设计与验收文档明确记录该安全风险，后续若要
达成 V1 的 ACL 要求，需单独设计 Windows ACL 检查或加固方案。

将两个 E2E 工具迁移到 `scripts/*.ts`，新增独立的 `tsconfig.scripts.json`，
明确使用 `rootDir: "scripts"`、`outDir: "dist-scripts"`，输出
`dist-scripts/e2e-smoke.js` 和 `dist-scripts/e2e-live.js`。`npm run build` 同时
编译产品和工具并清理 `dist-scripts/`；该目录加入 `.gitignore`，不进入 npm 包。
`test:e2e` 和 `test:e2e:live` 先运行 `npm run build`，再执行对应编译产物，确保
干净检出也能运行。脚本中的 npm/npx Windows `.cmd` 选择、`shell: false`、临时
目录和交互式终端行为保持不变。

## 测试设计

新增和调整测试覆盖以下可观察行为：

- 在真实 Windows CI 上，已有状态文件、配置文件和租约文件能反复写入，且不会
  因目标存在而失败；安装失败仍恢复原配置。
- 现有状态文件和安装配置的写入仍能往返读取，并保留权限与回滚行为。
- 进程探测失败时，活跃 PID 不会被第二实例抢占；探测到进程已退出或 PID 被
  不同启动时间复用时，租约仍可回收；另一个实例替换租约内容后，原持有者仍
  触发丢失回调。
- TypeScript 工具配置能被构建，`scripts/` 下不再有可由 TypeScript 表达的
  `.js` 工具源文件；测试 JavaScript 不纳入迁移。
- Windows 风格路径中的盘符、空格、反斜杠仍能通过现有 CLI 路径解析和配置
  URL 生成测试。
- 遗留登录工具不再读取 `HOME` 或使用字面量 `~`；Windows ACL 状态明确显示为
  未验证，不把 POSIX `0600` 测试结果冒充 Windows 安全证明。

自动化验证顺序为：先运行新增测试确认缺陷契约失败，再实现最小改动并运行
相关测试，最后运行 `npm run build`、`npm test`、`npm run test:e2e`，并检查
`git diff` 中没有 `dist/` 或 `dist-scripts/` 产物。

## 不改变的行为

- 不引入聊天转发、额外审批决策或新的网络依赖。
- 不修改 token、context token、绑定用户和状态文件的数据结构。
- 不手工编辑 `dist/` 或提交 `dist-scripts/`。
- 不把测试 JavaScript 改成 TypeScript，也不把 macOS 接受测试中的桌面自动化
  约束扩大到产品代码。

## 风险与处理

Windows 文件替换由 Node/libuv 的现有 rename 实现处理，不新增未经验证的
平台分支。主要剩余风险是外部程序锁定状态文件，以及 Windows ACL 不能由
`chmod(0600)` 表达；前者向上层报告，后者在文档中明确列为未解决安全项。
租约进程探测失败时采用保守拒绝抢占，避免错误启动第二个轮询实例。
