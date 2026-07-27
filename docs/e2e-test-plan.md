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

默认 smoke 不触发扫码、不写入真实绑定或微信状态。需要真实验收时，必须显式运行：

```bash
npm run test:e2e:live
```

该命令是扫码后的人工安全记录器，不会自动触发 OpenCode E2E-05/06/07，也不会把人工观察伪装成自动化证据。它每次先执行 force bind：显示二维码，要求用户扫码确认，并在标题严格为 `微信ClawBot` 的会话发送精确文本 `绑定`。脚本确认收到新的 context（不打印 token）后，才逐项提示人工执行 E2E-05、E2E-06、E2E-07，并在内存中记录扫码时间、场景、微信文本摘要和 request ID；记录不会写入文件。

## 证据分层

- **真实微信/OpenCode**：维护机上真实 WeChat 会话与 OpenCode 服务的观察结果，不能由测试替代。
- **HTTP/内存集成**：`test/integration.test.js` 使用 fake gateway、fake fetcher 和 `HttpPermissionAPI`，只证明协议与内存流程。
- **单元与安全校验**：模块级测试和 `test/semantic-approval.test.js` 使用确定性 fake model，证明输入边界、pending 快照、输出决策与安全拦截，不代表真实模型或微信。

## 场景矩阵

| 编号 | 场景与通过条件 | 自动化证据（类别） | 真实微信/OpenCode 状态 |
| --- | --- | --- | --- |
| E2E-01 | npx 安装后 `--help` 显示 install、bind、doctor | `scripts/e2e-smoke.js`（CLI/registry） | 已验证 |
| E2E-02 | install 只接受可用模型，保留 JSONC 注释并原子写入配置 | `test/install.test.js`（单元/内存） | npx install 已验证；新绑定未验证 |
| E2E-03 | 绑定成功后收到唯一测试通知；绑定不完整则不提交配置 | `test/install.test.js`、`test/wechat-gateway.test.js`（单元/内存） | 未验证 |
| E2E-04 | doctor 独立报告插件、绑定、模型和服务健康状态 | `test/cli.test.js`（HTTP） | doctor 绿灯已验证 |
| E2E-05 | busy→idle 只发一次 Done；失败只发一次 Error 且无 Done | `test/session-notifier.test.js`、`test/integration.test.js`（单元/HTTP 内存 fake） | 仅确认一次真实 Done；失败未验证 |
| E2E-06 | 取消显示 Cancelled；超时自动拒绝 | `test/session-notifier.test.js`、`test/plugin.test.js`（单元/HTTP 内存） | 未验证；自动化不等于微信展示 |
| E2E-07 | `好的`、`始终允许`、`拒绝` 精确回复对应 request ID | `test/approval-manager.test.js`、`test/integration.test.js`（fake PermissionAPI） | 三种真实回复均未验证 |
| E2E-08 | 多审批先澄清，序号快照稳定，过期请求不误批 | `test/approval-intent.test.js`、`test/integration.test.js`（单元/HTTP 内存） | 未验证 |
| E2E-09 | 普通文本、群聊和未绑定发送者不触发模型或审批 | `test/plugin.test.js`、`test/wechat-gateway.test.js`（单元/内存） | 未验证 |
| E2E-10 | 重启后 outbox 重放、入站消息去重，不重复通知；新入站 context 可重发 outbox | `test/wechat-gateway.test.js`（内存） | 未验证 |
| E2E-11 | 原生 OpenCode 回复与插件回复并发时只保留有效结果 | `test/approval-manager.test.js`（HTTP fake） | 未验证 |
| E2E-12 | 第二个插件实例因租约不发送重复通知；凭据文件保持私有权限 | `test/runtime-lease.test.js`、`test/store.test.js`（单元） | 未验证 |

语义转述安全矩阵由 `test/semantic-approval.test.js` 独立覆盖：单请求 once、多请求目标、always 持久语义、模糊澄清、否定/疑问拦截和未知 requestID 拒绝。fake model 的自然语言输入与 pending 请求会在提示词中逐项断言，输出仍经过本地决定和 request ID 校验；这不是真实模型端到端验收。

## 真实环境验收

真实微信和 OpenCode 验收必须在隔离账号、临时配置目录和维护者可控设备上执行。每次读写前确认会话标题为 `微信ClawBot`，依次完成 E2E-01 至 E2E-12，并记录 request ID、回复载荷和最终微信文本。不得记录 bot token、context token、二维码内容或本地状态文件。无法执行的场景在验收记录中标记为“未验证”，不能用单元测试替代。

建议保存以下结果摘要：

```text
版本：vX.Y.Z
命令：npm run test:e2e
测试：通过/失败（N passed, M failed）
覆盖率：Statements / Branches / Functions / Lines
registry npx：通过/未发布/失败原因
真实微信：E2E-05 仅 Done 已观察；E2E-05 失败、E2E-06、E2E-07 及其余场景未验证
```

本轮真实链路在一次 Done 后遇到微信 API `prepare failed`，无法稳定送达审批通知或回收完整会话。因此失败、取消、三种权限回复及语义转述真实效果必须保持“未验证”，不能以 fake gateway、fake PermissionAPI 或单元测试改写状态。

### `prepare failed` 处理记录

先记录脱敏的 `ret`、`errcode`、`errmsg`、`baseHost`、账号摘要、目标摘要和 `contextAgeMs`，不要循环重试。`ret/errcode=-14` 表示 iLink 会话失效：插件清除旧 context、停止轮询，要求重新运行 `bind` 扫码并重启 `opencode web`。非 `-14` 的 `prepare failed` 保留 outbox；绑定用户发送一条新消息后，网关先保存消息携带的新 context，再尝试重发 outbox。该恢复路径已有内存回归测试，但仍需 live E2E 逐项观察微信文本。
