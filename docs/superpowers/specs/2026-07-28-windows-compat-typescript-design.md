# Windows 兼容性与 TypeScript 工具迁移设计

## 目标

修复仓库中在 Windows 上可能失败的文件替换、租约心跳和用户目录处理，
并将能够由 TypeScript 编译的项目 E2E 工具从 JavaScript 迁移到 TypeScript。
不改变审批安全边界、微信协议、配置格式和公开 CLI 行为。

## 范围与现状结论

- `src/store.ts`、`src/install.ts` 和 `src/runtime-lease.ts` 都存在临时文件
  重命名覆盖已有目标的路径。Windows 对目标文件已存在时的 `rename` 行为不
  与 POSIX 一致，可能导致状态持久化、安装回滚或租约心跳失败。
- `runtime-lease.ts` 的租约所有权由文件内容决定，心跳没有必要替换整个文件；
  使用文件时间戳更新可以避免 Windows 的覆盖重命名问题，同时继续检测实例 ID。
- `wechat-login.ts` 使用 `process.env.HOME || "~"`，Windows 通常没有 `HOME`，
  且 Node 不会自动展开字面量 `~`。
- `scripts/e2e-smoke.js` 和 `scripts/e2e-live.js` 是项目工具代码，能够在构建
  阶段编译为 TypeScript。`test/*.test.js` 和 `test/run-tests.js` 继续使用
  JavaScript，因为仓库约定由 Node.js `node:test` 直接执行并从 `dist/` 导入。

## 方案

### 文件替换兼容层

新增 `src/file-utils.ts`，提供两个职责清晰的操作：

1. 将临时文件替换为目标文件。
2. 将文本安全写入指定文件。

POSIX 保持现有的同目录临时文件加 `rename` 语义。Windows 分支先将已有目标
移动到带随机后缀的备份文件，再将临时文件移动到目标；替换失败时恢复备份，
成功后清理备份。该分支避免直接覆盖已有目标，并明确接受替换期间的短暂
恢复窗口。租约不使用该恢复窗口，因此不会通过此层更新租约。

`store.ts` 和 `install.ts` 统一调用该兼容层，保留现有文件权限、fsync、回滚
和 JSONC 注释行为。凭据仍写入当前用户配置目录；Windows 不宣称 POSIX
`0600` 语义，依赖用户目录默认 ACL。

### 租约心跳

`RuntimeLease` 创建租约时仍以排他文件创建和实例记录竞争所有权。心跳只在
确认实例 ID 未变化后调用 `fs.utimesSync` 更新租约文件的访问/修改时间，不
重写 JSON 文件。读取租约时保留记录校验，并以文件元数据的修改时间作为最新
心跳时间。释放、抢占、损坏文件隔离和租约丢失回调保持现有行为。

### 用户目录与工具构建

`wechat-login.ts` 使用 `os.homedir()` 构造状态目录，并保留现有凭据文件权限
和输出边界。

将两个 E2E 工具迁移到 `scripts/*.ts`，新增独立的 `tsconfig.scripts.json`，
输出到未跟踪的 `dist-scripts/`。`npm run build` 同时编译产品和工具；E2E
命令改为运行编译后的工具。脚本中的 npm/npx Windows `.cmd` 选择、`shell: false`、
临时目录和交互式终端行为保持不变。

## 测试设计

新增和调整测试覆盖以下可观察行为：

- 在模拟 Windows 平台的替换路径下，已有目标能被新内容替换，失败时旧内容
  能恢复，且不会遗留临时/备份文件。
- 现有状态文件和安装配置的写入仍能往返读取，并保留权限与回滚行为。
- 租约心跳更新文件时间戳后，持有者继续有效；另一个实例替换租约内容后，
  原持有者仍触发丢失回调。
- TypeScript 工具配置能被构建，`scripts/` 下不再有可由 TypeScript 表达的
  `.js` 工具源文件；测试 JavaScript 不纳入迁移。
- Windows 风格路径中的盘符、空格、反斜杠仍能通过现有 CLI 路径解析和配置
  URL 生成测试。

自动化验证顺序为：先运行新增测试确认缺陷契约失败，再实现最小改动并运行
相关测试，最后运行 `npm run build`、`npm test` 和 `npm run test:e2e`。

## 不改变的行为

- 不引入聊天转发、额外审批决策或新的网络依赖。
- 不修改 token、context token、绑定用户和状态文件的数据结构。
- 不手工编辑 `dist/` 或提交 `dist-scripts/`。
- 不把测试 JavaScript 改成 TypeScript，也不把 macOS 接受测试中的桌面自动化
  约束扩大到产品代码。

## 风险与处理

Windows 文件替换无法同时保证 POSIX 的单次原子覆盖和无文件空窗，因此替换
层在失败时执行恢复，并通过同目录临时文件、备份命名和现有回滚路径降低风险。
租约心跳使用元数据避免了该窗口；若文件系统不支持时间戳更新，心跳会触发
既有租约丢失处理，防止继续重复轮询。
