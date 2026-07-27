# 端到端测试计划

本文记录发布前必须验证的安装、OpenCode、微信审批和恢复场景。自动化脚本只使用临时 npm 包和内存网关，不会读取真实令牌，也不会修改当前用户的 OpenCode 配置。

## 自动化入口

```bash
npm ci
npm run test:e2e
```

脚本会依次执行构建、完整 `node:test` 集成矩阵、覆盖率、`npm pack` 内容检查，以及从本地 tarball 运行：

```bash
npx --yes --package ./wekux-opencode-wechat-approve-plugin-X.Y.Z.tgz wechat-approve --help
```

npx 命令在隔离临时目录执行，避免仓库同名包上下文干扰 CLI 解析；临时 tarball 在验证结束后自动清理。

包发布后，用下面命令切换为 registry 验证；命令不会输出 token：

```bash
E2E_NPM_SPEC=@wekux/opencode-wechat-approve-plugin npm run test:e2e
```

## 场景矩阵

| 编号 | 场景与通过条件 | 自动化证据 |
| --- | --- | --- |
| E2E-01 | npx 安装后 `--help` 显示 install、bind、doctor | `scripts/e2e-smoke.js` |
| E2E-02 | install 只接受可用模型，保留 JSONC 注释并原子写入配置 | `test/install.test.js` |
| E2E-03 | 绑定成功后收到唯一测试通知；绑定不完整则不提交配置 | `test/install.test.js`、`test/wechat-gateway.test.js` |
| E2E-04 | doctor 独立报告插件、绑定、模型和服务健康状态 | `test/cli.test.js` |
| E2E-05 | busy→idle 只发一次 Done，失败只发一次 Error 且无 Done | `test/session-notifier.test.js`、`test/integration.test.js` |
| E2E-06 | 取消显示 Cancelled；超时自动拒绝 | `test/session-notifier.test.js`、`test/plugin.test.js` |
| E2E-07 | `好的`、`始终允许`、`拒绝` 精确回复对应 request ID | `test/approval-manager.test.js`、`test/integration.test.js` |
| E2E-08 | 多审批先澄清，序号快照稳定，过期请求不误批 | `test/approval-intent.test.js`、`test/integration.test.js` |
| E2E-09 | 普通文本、群聊和未绑定发送者不触发模型或审批 | `test/plugin.test.js`、`test/wechat-gateway.test.js` |
| E2E-10 | 重启后 outbox 重放、入站消息去重，不重复通知 | `test/wechat-gateway.test.js` |
| E2E-11 | 原生 OpenCode 回复与插件回复并发时只保留有效结果 | `test/approval-manager.test.js` |
| E2E-12 | 第二个插件实例因租约不发送重复通知；凭据文件保持私有权限 | `test/runtime-lease.test.js`、`test/store.test.js` |

## 真实环境验收

真实微信和 OpenCode 验收必须在隔离账号、临时配置目录和维护者可控设备上执行。每次读写前确认会话标题为 `微信ClawBot`，依次完成 E2E-01 至 E2E-12，并记录 request ID、回复载荷和最终微信文本。不得记录 bot token、context token、二维码内容或本地状态文件。无法执行的场景在验收记录中标记为“未验证”，不能用单元测试替代。

建议保存以下结果摘要：

```text
版本：vX.Y.Z
命令：npm run test:e2e
测试：通过/失败（N passed, M failed）
覆盖率：Statements / Branches / Functions / Lines
registry npx：通过/未发布/失败原因
真实微信：E2E-01 ... E2E-12
```
