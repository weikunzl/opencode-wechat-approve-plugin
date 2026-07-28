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

安装验收还应检查全局 OpenCode `plugin` 数组包含带版本的 registry 规格
（如 `@wekux/opencode-wechat-approve-plugin@1.0.2`），不应回退到本地
`file://` 托管路径。

默认 smoke 不触发扫码、不写入真实绑定或微信状态。需要真实验收时，必须显式运行：

```bash
npm run test:e2e:live
```

该命令是扫码后的人工安全记录器，不会自动触发 OpenCode E2E，也不会把人工观察伪装成自动化证据。它每次先执行 force bind：显示二维码，要求用户扫码确认，并在标题严格为 `微信ClawBot` 的会话发送精确文本 `绑定`。脚本确认收到新的 context（不打印 token）后，逐项提示人工执行 LIVE-01 至 LIVE-06，并在内存中记录扫码时间、场景、微信文本、`requestID=decision` 列表以及处理前后 pending 数量；记录不会写入文件。每项仍必须由操作者实际创建审批和读取微信/OpenCode 结果。

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
| E2E-04 | doctor 独立报告插件、绑定、模型和服务健康状态 | `test/cli.test.js`（HTTP） | 已验证：registry 1.0.2 环境四项均为 OK |
| E2E-05 | busy→idle 只发一次 Done；失败只发一次 Error 且无 Done | `test/session-notifier.test.js`、`test/integration.test.js`（单元/HTTP 内存 fake） | 真实观察到审批通知与结果；失败链路未验证 |
| E2E-06 | 取消显示 Cancelled；超时自动拒绝 | `test/session-notifier.test.js`、`test/plugin.test.js`（单元/HTTP 内存） | 真实微信仅观察到 Timeout；Cancelled 未验证 |
| E2E-07 | 批量、混合和逐个回复精确对应 request ID | `test/approval-manager.test.js`、`test/integration.test.js`（fake PermissionAPI） | registry 1.0.2 + 真实微信已验证 once/always/reject、混合和逐个 |
| E2E-08 | 多审批先澄清，序号快照稳定，过期请求不误批 | `test/approval-intent.test.js`、`test/integration.test.js`（单元/HTTP 内存） | 未验证 |
| E2E-09 | 普通文本、群聊和未绑定发送者不触发模型或审批 | `test/plugin.test.js`、`test/wechat-gateway.test.js`（单元/内存） | 未验证 |
| E2E-10 | 重启后 outbox 重放、入站消息去重，不重复通知；新入站 context 可重发 outbox | `test/wechat-gateway.test.js`（内存） | 未验证 |
| E2E-11 | 原生 OpenCode 回复与插件回复并发时只保留有效结果 | `test/approval-manager.test.js`（HTTP fake） | 未验证 |
| E2E-12 | 第二个插件实例因租约不发送重复通知；凭据文件保持私有权限 | `test/runtime-lease.test.js`、`test/store.test.js`（单元） | 未验证 |

语义转述安全矩阵由 `test/semantic-approval.test.js` 独立覆盖：单请求 once、多请求目标、always 持久语义、模糊澄清、否定/疑问拦截和未知 requestID 拒绝。fake model 的自然语言输入与 pending 请求会在提示词中逐项断言，输出仍经过本地决定和 request ID 校验；这不是真实模型端到端验收。真实 registry 模型已验证“查看最近提交记录并放行一次”映射为唯一 request 的 once；模糊、否定、疑问和模型升级决定仍未做真实验收。

模型边界：模型可以解释自然语言中的目标，但不能凭空建立授权决定。没有 deterministic 授权词的“把那个执行一下”等目标转述，即使模型返回 once，也会被安全校验改为澄清；always 必须由用户原话显式表达持久语义。真实模型本轮仅验证了明确 once，其他安全分支仍保持“未验证”。

## 本轮真实 registry 记录

以下均在标题严格为 `微信ClawBot` 的真实微信会话中观察，插件来源为 npm registry 的 `@wekux/opencode-wechat-approve-plugin@1.0.2`；request ID 不含 token。

| 场景 | 微信原文与可见结果 | request ID → decision | pending |
| --- | --- | --- | --- |
| 批量 once | `全部允许`；`#1: 本次允许`、`#2: 本次允许` | `per_fa4506c3a001muJmveGeWrt2KD` → once；`per_fa4506daa0018WsGNQoqTdvHDl` → once | 2 → 0 |
| 批量 always | `全部授权`；`#1: 始终允许`、`#2: 始终允许` | `per_fa457b954001S6CdsB3ZcQFtdr` → always；`per_fa457bad6001i3wBoUlIu0MpRA` → always | 2 → 0 |
| 批量 reject | `全部拒绝`；`#1: 已拒绝`、`#2: 已拒绝` | `per_fa455d0da001GDf359IoVzMzM1` → reject；`per_fa455d1c8001qxcDJykBvYqgSd` → reject | 2 → 0 |
| 创建时间混合 | `第一个允许、第二个拒绝`；`#1: 本次允许`、`#2: 已拒绝` | `per_fa45d7092001uTM9Thf6tguUkO`（createdAt 1785169014898）→ once；`per_fa45d7180001jhDtFeCtcm8gTl`（createdAt 1785169015145）→ reject | 2 → 0 |
| 逐个续问 | `第一个允许` 后继续询问 #2；再发 `第二个拒绝` | `per_fa458ba1f001lh6kiKcR00AW5A` → once；`per_fa458bf46001XJlzIC1T88ifUR` → reject | 2 → 1 → 0 |
| 模型 once | `请把查看最近提交记录这个操作放行一次`；`#1: 本次允许` | `per_fa45a179f001bV1Ip0gaZ0X4DL` → once | 1 → 0 |

真实证据仍有边界：Cancelled、失败 Error、跨两个 OpenCode 目录同时 attach、模糊/否定/疑问模型回复、重启后的微信去重和 outbox 恢复尚未真实验证。此前一次未及时回复的批次在微信中显示 `[Timeout] #1, #2 已自动拒绝`，仅作为 timeout 观察，不算审批通过。

## A-F 验收覆盖总览

| 前置条件 | 操作 | 可观察预期 | 证据类别 |
| --- | --- | --- | --- |
| A：registry 包、模型和 loopback 服务可用 | npx `--help`/`install`/`doctor`，绑定后重启服务 | CLI 可用、doctor 四项 OK、上下文刷新 | 自动化 + 真实；QR 过期/拒绝未验证 |
| B：已绑定且存在会话事件 | busy/idle、error、cancel、outbox 失败后新消息、重启 | Done/Error/Cancelled 去重，失败保留并恢复发送 | 自动化；真实仅 Done/Timeout |
| C：真实 OpenCode 有 1～2 个 pending | 发送批量、混合、序号和目标回复 | request ID、decision、pending 前后与微信文本一致 | 真实已验证主线；目标/竞态未验证 |
| D：模型已配置且 deterministic 无法确定 | 发送明确目标 once、模糊/否定/疑问和非法模型输出 | 仅高置信度明确 once 可执行，其余澄清/拒绝 | fake model 全覆盖；真实仅明确 once |
| E：未绑定、群聊、普通消息和第二实例 | 发送隔离消息、启动第二实例、检查权限 | 不建模型会话、不越权、不重复通知 | 自动化；真实未验证 |
| F：transport 返回超时、-14 或 prepare failed | 刷新 context/rebind 后重试 outbox | -14 要求扫码，非 -14 只在新 context 后重发且无 token 日志 | 自动化已覆盖；真实恢复未验证 |

## 真实环境验收

真实微信和 OpenCode 验收必须在隔离账号、临时配置目录和维护者可控设备上执行。每次读写前确认会话标题为 `微信ClawBot`，依次完成 E2E-01 至 E2E-12，并记录 request ID、回复载荷和最终微信文本。不得记录 bot token、context token、二维码内容或本地状态文件。无法执行的场景在验收记录中标记为“未验证”，不能用单元测试替代。

建议保存以下结果摘要：

```text
版本：vX.Y.Z
命令：npm run test:e2e
测试：通过/失败（N passed, M failed）
覆盖率：Statements / Branches / Functions / Lines
registry npx：通过/未发布/失败原因
真实微信：registry 1.0.2 已观察批量 once/always/reject、混合、逐个和模型 once；失败、Cancelled、重启恢复等保持未验证
```

早期绑定上下文曾返回 `ret/errcode=-14`，导致一次 `prepare failed`；按诊断流程 force bind、重新扫码并刷新 context 后，registry 1.0.2 审批通知已恢复。该历史失败仍作为恢复风险记录，不能把它与后续成功消息混为同一证据。

### `prepare failed` 处理记录

先记录脱敏的 `ret`、`errcode`、`errmsg`、`baseHost`、账号摘要、目标摘要和 `contextAgeMs`，不要循环重试。`ret/errcode=-14` 表示 iLink 会话失效：插件清除旧 context、停止轮询，要求重新运行 `bind` 扫码并重启 `opencode web`。非 `-14` 的 `prepare failed` 保留 outbox；绑定用户发送一条新消息后，网关先保存消息携带的新 context，再尝试重发 outbox。该恢复路径已有内存回归测试，但仍需 live E2E 逐项观察微信文本。
