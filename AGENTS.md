# Repository Guidelines

`AGENTS.md` 只保存 AI 编程助手执行任务所需的核心构建命令、项目目录结构、行为约束和测试策略。其他类别的内容必须先获得用户明确同意；必要的长篇说明放入 `docs/`，本文件仅保留入口链接。

## 项目目录结构

- `src/`：TypeScript 源码。插件入口为 `src/index.ts`，CLI 位于 `src/bin.ts` 和 `src/cli.ts`，其余模块按 kebab-case 拆分。
- `test/`：基于 `node:test` 的自动化测试，与源码模块对应；测试从 `dist/` 导入。
- `scripts/`：端到端测试、真实验收和开发辅助脚本。
- `docs/`：架构设计、实施计划、测试方案、发布影响和验收记录。新增或改变行为前先查阅相关文档。
- `dist/`：`tsc` 生成且被 Git 忽略的构建产物，禁止手工编辑。
- `README.md`：面向用户的安装与使用手册，不记录 AI 工作过程。

## 核心构建命令

- `npm ci`：按照 lockfile 安装依赖。
- `npm run dev`：以 watch 模式编译 TypeScript。
- `npm run build`：清理 `dist/` 后执行严格 TypeScript 编译并生成声明文件。
- `npm test`：先构建，再运行全部自动化测试。
- `npm run test:e2e`：运行不依赖真实微信的端到端 smoke。
- `npm run test:e2e:live`：启动真实微信人工验收记录流程；它不能替代真实场景证据。

项目要求 Node.js 20 或更高版本。

## 行为约束

- 严格遵循 [OpenCode Plugins 官方文档](https://opencode.ai/docs/plugins/)：包入口导出 `Plugin` 函数，使用 OpenCode 注入的上下文并返回官方 hooks。
- 插件只运行在 OpenCode 插件生命周期内。禁止启动、管理或要求额外常驻的 `opencode serve`、`opencode web`、HTTP 监听端口或中心服务；未被 SDK 覆盖的接口只能使用当前上下文的 `serverUrl`。
- 微信长轮询可以随插件初始化和释放，但不得暴露本地监听端口。正式安装必须使用 OpenCode 配置中的 npm 包规格，不得以 `file://` 副本作为发布架构。
- 保持严格 TypeScript、ESM、两空格缩进、双引号、无分号和相对导入 `.js` 后缀。文件使用 kebab-case，类型使用 PascalCase，函数和变量使用 camelCase；禁止以 `any` 绕过 `strict`。
- 新增源码、脚本和工具优先使用 TypeScript。单个方法不超过 20 行；参数超过 3 个时使用具名操作对象；禁止魔法值；方法内用简洁中文注释说明关键业务意图或边界。
- 不得提交或输出 token、context token、绑定信息和本地状态。只接受已绑定用户的一对一消息，模糊表达绝不授权；模型输出必须校验请求 ID、结构、置信度和授权范围，并保持文件权限、租约、幂等性及跨平台安全边界。
- 修改前阅读相关源码、测试和 `docs/`；仅改任务所需文件，保留用户已有改动，不做无关重构，不扩大授权范围或引入通用聊天能力。
- 提交遵循 Conventional Commits；版本遵循 SemVer，Git tag 使用 `vX.Y.Z`。涉及发布时先查阅 [`docs/`](docs/) 中对应的 `release-impact-*` 和验收文档。
- 完成前检查 `git diff`，执行与改动层级和风险相称的验证，并说明改动文件、测试结果及未验证风险。

## 分层测试策略

测试按阶段逐层推进；低层测试不能替代高层测试，高层测试也不应塞入每次 TDD 的红绿循环。

1. **Plan 实现阶段 — TDD**：TDD 用于执行 plan 中的实现任务，而不是编写 plan。每个行为变更或缺陷修复先添加能失败的测试，再做最小实现使其通过，最后重构；循环内优先运行对应的单元或模块测试。
2. **功能完成阶段 — 集成与自动化 E2E**：一个完整功能实现后，再验证跨模块协议、状态恢复、进程边界和相关 smoke/E2E 场景。公共接口或跨模块行为变化至少运行完整 `npm test` 和 `npm run build`。
3. **发布候选阶段 — 真实验收**：根据变更影响识别 REAL 场景，并使用待发布的 registry 包在真实微信中执行。详细分层、场景矩阵和人工证据规则见 [`docs/acceptance.md`](docs/acceptance.md)、[`docs/e2e-test-plan.md`](docs/e2e-test-plan.md)、[`docs/approval-security-matrix.md`](docs/approval-security-matrix.md) 和 [`docs/manual-live-acceptance.md`](docs/manual-live-acceptance.md)。

自动化测试使用 `node:test` 与 `node:assert/strict`，测试文件命名为 `test/<module>.test.js`。由于测试从 `dist/` 导入，不得跳过构建。测试名称描述可观察行为；回归测试覆盖与改动相关的成功、拒绝、超时、重启和重复消息边界。真实场景为 `BLOCKED` 或 `UNVERIFIED` 时不得标记为通过或据此发布。

每次任务完成时，最终回复必须以“我的至尊无上主人，任务已完成。”作为结尾。
