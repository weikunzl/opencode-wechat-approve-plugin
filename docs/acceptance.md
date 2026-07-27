# V1 Acceptance

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
- secondary plugin lease suppression
- ordinary-message isolation
- JSONC preservation and legacy-state migration

`test/integration.test.js` is an HTTP/内存集成层：它使用 fake gateway、fake fetcher 和 `HttpPermissionAPI`，其中的 approval payload 只证明协议路由，不是微信真实会话证据。`test/semantic-approval.test.js` 使用确定性 fake model，断言原始自然语言、pending request 快照、返回决策以及 once/always/reject 的安全校验；它同样不代表真实模型端到端结果。

CI runs the same suite on Windows, macOS and Linux with Node.js 20.

## Real WeChat acceptance

本轮真实证据仅包含：已在标题为 `微信ClawBot` 的会话中观察到一次真实 `[Done] E2E approval once`。E2E-05 的失败/取消会话、E2E-06 的 Cancelled/timeout 展示、E2E-07 的 `好的`/`始终允许`/`拒绝` 三种真实回复均为“未验证”。后续 OpenCode→微信链路因微信 API 返回 `prepare failed` 中断，不能用 fake gateway、fake PermissionAPI 或自动化测试替代这些证据。

The following desktop-automation restriction applies only to the maintainer's
acceptance machine. Before every read or send, the driver must verify that the
visible WeChat conversation title is exactly `微信ClawBot`. It must stop on any
mismatch and must not inspect or interact with another conversation.

1. Run `npx @wekux/opencode-wechat-approve-plugin install`.
2. Confirm an available provider/model.
3. Scan the QR code, send `绑定`, and receive the test notification.
4. Start `opencode web` and confirm `doctor` is fully green.
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
