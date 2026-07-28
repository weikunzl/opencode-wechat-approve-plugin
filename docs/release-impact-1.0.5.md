# v1.0.5 发布影响映射

## 发布来源与运行入口

- npm 包：`@wekux/opencode-wechat-approve-plugin@1.0.5`。
- OpenCode 配置应使用包规格 `@wekux/opencode-wechat-approve-plugin@1.0.5`，不得回退到 `file://` 本地入口。
- CLI 入口为 `wechat-approve`；发布包的 `dist/index.js` 包含租约持有者事件转发修复。
- 本次记录不修改全局插件、OpenCode 服务或微信绑定状态。

## 代码与测试影响

租约持有者转发修复影响多目录实例的审批和生命周期事件，直接关联 REAL-00、REAL-15、REAL-17、REAL-18；单目录行为与审批语义回归由现有测试保持覆盖。自动化证据来自 `test/plugin.test.js`、`test/semantic-approval.test.js`、`test/integration.test.js` 和相关网关/通知测试，不等价于微信屏幕证据。

发布前影响分析必须至少覆盖上述四项；若变更同时触及审批解析、微信传输、状态存储、安装器或通知格式，应把对应 REAL-01～REAL-18 项加入受影响集合。用户可选择执行 REAL-00～REAL-18 全量真实回归，执行顺序和文字证据索引格式以 [`docs/approval-security-matrix.md`](approval-security-matrix.md) 为准。

本次发布基线已通过：

- `npm test`：123/123 通过。
- `npm run build`：通过。
- `npm run test:e2e`：通过，默认不触发扫码或真实微信操作。
- `git diff --check`：通过。

## 真实验收交接

真实执行线程必须逐项回传：场景 ID、registry 版本、原始窗口标题、用户目标会话/绑定确认、微信可见原文、脱敏 `requestID=decision`、pending/outbox 前后数量、人工文字证据和操作者时间。本线程在收到这些证据前不修改 REAL-00 至 REAL-18 或 SEC 场景状态，也不并发操作微信会话。严格标题 PASS 另需屏幕证据；人工协作规则见 [`docs/manual-live-acceptance.md`](manual-live-acceptance.md)。

用户人工身份确认以真实线程中的明确文字为证据；人工场景必须提供完整结构化文字字段，不要求截图。严格标题 `PASS` 与人工 `MANUAL_REPORTED` 分开，文字证据不得冒充屏幕 PASS。任一真实场景为 `BLOCKED`/`UNVERIFIED` 或缺少字段时，发布状态必须保持阻塞。

当前 REAL-00 已标记 `MANUAL_REPORTED`，使用 retry-00 的完整文字字段；该状态不等同于严格标题屏幕 PASS。REAL-01 可进入人工协作验收。

## 安全与回滚边界

不得在文档、日志或提交中记录 token、context token、二维码、绑定信息或其他会话内容。若 registry 运行验证失败，应回滚到上一已发布版本或暂停真实验收；不得以源码 `dist/` 替代 npm registry 包证明发布修复。
