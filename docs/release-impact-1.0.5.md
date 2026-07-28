# v1.0.5 发布影响映射

## 发布来源与运行入口

- npm 包：`@wekux/opencode-wechat-approve-plugin@1.0.5`。
- OpenCode 配置应使用包规格 `@wekux/opencode-wechat-approve-plugin@1.0.5`，不得回退到 `file://` 本地入口。
- CLI 入口为 `wechat-approve`；发布包的 `dist/index.js` 包含租约持有者事件转发修复。
- 本次记录不修改全局插件、OpenCode 服务或微信绑定状态。

## 代码与测试影响

租约持有者转发修复影响多目录实例的审批和生命周期事件，直接关联 REAL-00、REAL-15、REAL-17、REAL-18；单目录行为与审批语义回归由现有测试保持覆盖。自动化证据来自 `test/plugin.test.js`、`test/semantic-approval.test.js`、`test/integration.test.js` 和相关网关/通知测试，不等价于微信屏幕证据。

本次发布基线已通过：

- `npm test`：123/123 通过。
- `npm run build`：通过。
- `npm run test:e2e`：通过，默认不触发扫码或真实微信操作。
- `git diff --check`：通过。

## 真实验收交接

真实执行线程必须逐项回传：场景 ID、窗口标题、微信可见原文、脱敏 `requestID=decision`、pending/outbox 前后数量、清理结果和时间戳。本线程在收到这些证据前不修改 REAL-00 至 REAL-18 或 SEC 场景状态，也不并发操作微信会话。

当前门禁仍为 `BLOCKED`：屏幕标题观察到“微信 ClawBot”（含空格），不满足严格标题 `微信ClawBot`，因此没有发送诊断通知，也没有真实 request ID/decision 证据。pending 与 outbox 均为 0，不能据此宣称 REAL-00 通过。

## 安全与回滚边界

不得在文档、日志或提交中记录 token、context token、二维码、绑定信息或其他会话内容。若 registry 运行验证失败，应回滚到上一已发布版本或暂停真实验收；不得以源码 `dist/` 替代 npm registry 包证明发布修复。
