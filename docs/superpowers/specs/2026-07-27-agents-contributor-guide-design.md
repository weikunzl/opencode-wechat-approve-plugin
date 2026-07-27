# AI 贡献指南设计

## 目标

在仓库根目录创建中文 `AGENTS.md`，作为 AI 编码代理的首要工作规范。文档应简洁、可执行，并基于当前 TypeScript/Node.js 项目的实际结构、命令与安全边界。

`README.md` 继续作为安装、绑定和使用插件的用户手册；架构设计、实施计划与验收记录继续存放在 `docs/`。

## 内容结构

`AGENTS.md` 使用标题“Repository Guidelines”，包含以下内容：

1. 项目结构：说明 `src/`、`test/`、`docs/`、`dist/`、`wechat-login.ts` 和 `.github/workflows/ci.yml` 的职责。
2. 构建与验证：记录 `npm ci`、`npm run dev`、`npm run build`、`npm test`，要求修改后运行与风险相称的验证。
3. 代码风格：遵循严格 TypeScript、ESM、现有两空格缩进、无分号风格；文件使用 kebab-case，类型和类使用 PascalCase，变量和函数使用 camelCase。
4. 测试规范：使用 `node:test` 和 `node:assert/strict`；测试从 `dist/` 导入，文件命名为 `test/<module>.test.js`；行为变更必须补充回归测试。
5. 安全与配置：不得记录或提交 token、绑定上下文和本地状态；保持回环监听、绑定用户校验、模糊表达不授权、模型输出验证等安全边界。
6. 提交与 PR：沿用仓库历史中的简短祈使句提交标题；PR 说明行为变化、测试证据和相关问题，用户界面或微信消息变化附示例。
7. AI 工作约束：先阅读相关实现、测试和设计文档，避免无关重构，不手工编辑生成的 `dist/`，并保持 README 与设计文档职责分离。

## 完成标准

- 文档为中文，命令、路径和代码标识符保留原样。
- 总体信息量保持在用户要求的简洁范围内。
- 所有规则均能从仓库现有配置、源码、测试、CI、README 或提交历史得到支持。
- 不修改 `README.md`，不包含凭据、机器专属路径或未经验证的工具要求。
