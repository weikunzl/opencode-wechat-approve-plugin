# V1.1 Acceptance

## Native plugin migration baseline

当前 1.1.0 实现已切换为官方 OpenCode plugin 生命周期：插件不启动独立 server，不要求 `opencode web`、`opencode serve` 或 `opencode attach`。每个 OpenCode 进程注册到共享实例表；Gateway Leader 独占微信轮询和 outbox，其余实例通过共享 mailbox 发布事件。审批命令使用 requestID、ownerInstanceID 和 revision 原子 claim，再由 owner 进程通过注入式 SDK client 回写。

新增自动化证据包括：事件版本归一化、共享状态 0600/损坏隔离/V1 迁移、实例注册、邮箱幂等、创建时间排序的并发 claim、Leader ingress、owner command worker、失败重试、次实例事件转发和 SDK 权限回写。旧 HTTP/内存测试仍只证明兼容协议，不代表真实微信证据。

本次架构变更属于破坏性运行方式变更。发布前先用待发布 `local-dist` 或 tarball 在独立 OpenCode 进程中重跑受影响 REAL-00～REAL-18；发布后再以 registry 包复核安装来源。未完成真实微信文字证据的项目保持 UNVERIFIED，不得以现有 1.0.x 记录替代。

## Automated matrix

`npm test` covers:

- busy to idle completion once
- failure without a following Done
- cancellation classification
- once, always and reject payloads
- multiple-request clarification and stale snapshots
- native OpenCode approval races
- automatic timeout rejection
- restart outbox replay and inbound deduplication
- unauthorized and group sender rejection
- model-output validation and internal-session suppression
- secondary plugin lease ownership with secondary-project event forwarding
- ordinary-message isolation
- JSONC preservation and legacy-state migration

`test/integration.test.js` is an HTTP/内存集成层：它使用 fake gateway、fake fetcher 和 `HttpPermissionAPI`，其中的 approval payload 只证明协议路由，不是微信真实会话证据。`test/semantic-approval.test.js` 使用确定性 fake model，断言原始自然语言、pending request 快照、返回决策以及 once/always/reject 的安全校验；它同样不代表真实模型端到端结果。

REAL-00 至 REAL-18 的安全与恢复验收矩阵、受影响/全量执行档位和文字证据索引格式见 [`docs/approval-security-matrix.md`](approval-security-matrix.md)；用户手工发送时遵循 [`docs/manual-live-acceptance.md`](manual-live-acceptance.md)。真实 live 仍必须逐项观察微信原文，不能用 fake model、HTTP 或内存结果替代。

此前 1.0.x 的人工文字记录仅作为历史参考，不覆盖本次 1.1.0 原生插件迁移。严格屏幕证据使用 `evidenceMode=SCREEN`；人工模式使用结构化文字证据，不要求截图。每项必须记录 `local-dist`、tarball 或 registry 来源；发布前不得把本地证据写成 registry 证据，发布后不得以本地证据替代 registry 安装复核。

发布前必须根据 [`docs/release-impact-1.1.0.md`](release-impact-1.1.0.md) 识别受影响场景；严格标题场景需 `PASS + SCREEN`，人工场景需符合预期的完整结构化文字证据并标记 `PASS + MANUAL_REPORTED`。用户可以选择按矩阵执行 REAL-00～REAL-18 全量真实回归；任一真实线程 `BLOCKED` 或 `UNVERIFIED` 都不能改写为通过。

人工协作模式下，用户每条场景开始前必须以真实线程文字确认目标会话和绑定身份；真实线程须保留原始窗口标题、用户确认、微信原文、脱敏决策、pending/outbox、清理结果和操作者时间。`MANUAL_CONFIRMED` 仅表示身份确认；字段完整且符合预期时标记 `PASS + MANUAL_REPORTED`。主线程只接受完整结构化文字日志。

可用 `npm run test:e2e:status` 做一轮无副作用状态扫描，或用 `npm run test:e2e:status -- --interval=30000` 周期扫描。输出包含来源、观察时间、服务端与本地的脱敏 request ID、pending/outbox 前后快照；扫描器不会读取微信屏幕，也不会自动把任何真实场景标记为通过。

CI runs the same suite on Windows, macOS and Linux with Node.js 20.

## Live E2E entry

默认 `npm run test:e2e` 永远不触发扫码。真实验收必须显式运行：

```bash
npm run test:e2e:live
```

该入口是扫码后的人工安全记录器，不会自动触发 OpenCode E2E，也不会代替真实会话断言。它每次先强制 bind，显示二维码并要求用户扫码确认；随后操作者必须在会话标题为 `微信ClawBot` 的窗口发送精确文本 `绑定`。脚本确认新的 context 已收到后，才提示人工执行 LIVE-01 至 LIVE-06。每个场景开始前都重新确认标题，并记录扫码时间、场景、微信文本、`requestID=decision` 列表和 pending 前后数量；不得记录 token、二维码或本地状态文件。

## Historical 1.0.x WeChat evidence

registry 包 `@wekux/opencode-wechat-approve-plugin@1.0.2` 已在标题严格为 `微信ClawBot` 的真实会话中完成主要审批链路。观察记录如下（不含 token/context）：

- `全部允许`：`per_fa4506c3a001muJmveGeWrt2KD`、`per_fa4506daa0018WsGNQoqTdvHDl` 均为 once，pending `2 → 0`。
- `全部授权`：`per_fa457b954001S6CdsB3ZcQFtdr`、`per_fa457bad6001i3wBoUlIu0MpRA` 均为 always，pending `2 → 0`。
- `全部拒绝`：`per_fa455d0da001GDf359IoVzMzM1`、`per_fa455d1c8001qxcDJykBvYqgSd` 均为 reject，pending `2 → 0`。
- `第一个允许、第二个拒绝`：按 createdAt `1785169014898 < 1785169015145` 映射为 once/reject，pending `2 → 0`。
- `第一个允许` 后微信继续询问 #2，再发 `第二个拒绝`，pending `2 → 1 → 0`。
- 真实配置模型对“请把查看最近提交记录这个操作放行一次”返回唯一 request 的 once，pending `1 → 0`。

真实未验证：Cancelled、失败 Error、重启后的微信去重/outbox 恢复、跨目录 attach，以及模型对模糊/否定/疑问语句的安全拒绝。此前未及时回复的一批真实通知显示 `[Timeout] #1, #2 已自动拒绝`，只作为 timeout 观察。fake gateway、fake PermissionAPI 和 fake model 仅属于自动化证据，不能替代上述缺口。

The following desktop-automation restriction applies only to the maintainer's
acceptance machine. Before every read or send, the driver must verify that the
visible WeChat conversation title is exactly `微信ClawBot`. It must stop on any
mismatch and must not inspect or interact with another conversation.

1. Run `npx @wekux/opencode-wechat-approve-plugin install`.
   Confirm the resulting global `plugin` entry is the registry spec
   `@wekux/opencode-wechat-approve-plugin@1.0.5`, not a local `file://` path.
2. Confirm an available provider/model.
3. Scan the QR code, send `绑定`, and receive the test notification.
4. Start `opencode web` and confirm `doctor` is fully green（本轮已验证 plugin、binding、model、server 四项 OK）。
5. Attach two project directories to `http://127.0.0.1:4096`.
6. Complete one real session and verify title, Session ID and project.
7. Fail one session and verify exactly one Error and no later Done.
8. Cancel one session and verify Cancelled.
9. Trigger permissions and verify `好的`, `始终允许` and `拒绝`.
10. Trigger two permissions concurrently; verify `好的` changes nothing until
    a second reply selects one or more requests.
11. Send ordinary text with no pending request and verify it creates no
    OpenCode session or model call.
12. Restart the center server and verify no duplicate notification is sent.

Record the OpenCode permission request ID, reply payload and resulting WeChat
text for each approval case. Never record bot tokens or context tokens.

The live recorder does not create approvals or call OpenCode. The maintainer must
create the requests manually, send the exact Chinese/English reply for the
scenario, observe the WeChat text, inspect the OpenCode request IDs and pending
count, and enter only the redacted summary. Model target interpretation without
an explicit user decision remains unverified in real OpenCode.

If `sendmessage` reports `prepare failed`, record only the redacted `ret`,
`errcode`, `errmsg`, `baseHost`, account/target summaries and context age. Do
not retry indefinitely. Error `-14` invalidates the stored context and requires
`npx @wekux/opencode-wechat-approve-plugin bind` with a new QR scan and the
exact `绑定` message, then restart `opencode web`. For other errors, send one new private message to refresh
the inbound context; the durable outbox is retried after that context is saved.
