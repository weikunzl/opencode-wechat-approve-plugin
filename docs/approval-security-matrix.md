# 真实审批与安全场景矩阵

这是 registry `@wekux/opencode-wechat-approve-plugin@1.0.4` 的验收基线。每个真实场景只允许在可见标题严格为 `微信ClawBot` 的窗口执行，并记录时间、微信原文、插件可见回复原文、脱敏 request ID/decision、pending 与 outbox 前后数量。HTTP/内存集成和 fake model 只能证明自动化行为；看不到微信原文一律是 `UNVERIFIED` 或 `BLOCKED`。

| ID | 前置条件 | 操作 | 可观察预期 | 证据类别/状态 |
| --- | --- | --- | --- | --- |
| REAL-00 | registry 1.0.4、绑定、doctor | 发送无副作用诊断通知 | 微信可见原文，context 有效，outbox 可清空 | 自动化 + 真实；BLOCKED（1.0.4 未包含 hook 转发修复） |
| REAL-01 | 单 pending | “这个操作可以吗？” | 澄清；decision 空；pending `1→1` | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-02 | 多 pending | “那个先做一下” | 澄清目标；pending `2→2` | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-03 | 单 pending | “不要放行这个操作” | 仅 reject，不得 once/always | `approval-manager.test.js`；真实 UNVERIFIED |
| REAL-04 | 多 pending | “不要放行” | 不批量拒绝，继续澄清 | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-05 | 单 pending | “帮我处理一下” | 只能解释目标，不能凭空授权 | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-06 | 单 pending | “这个能不能执行？” | 澄清，无 decision | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-07 | 单 pending | “我不确定要不要执行” | 澄清，无 decision | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-08 | 单 pending | 用户 once、模型返回 always | 拦截升级，不提交 always | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-09 | pending + 异常模型 | 非法 JSON/低置信度/未知 ID | 澄清或拒绝，无权限 API 调用 | `semantic-approval.test.js`；真实 UNVERIFIED |
| REAL-10 | 无 pending | 普通模糊文本 | 不建 session、不调模型、不发审批 | `plugin.test.js`；真实 UNVERIFIED |
| REAL-11 | 两个 pending | “第一个允许”，再“第二个拒绝” | `2→1→0`，中间继续询问 | `approval-manager.test.js`；真实 UNVERIFIED |
| REAL-12 | 多 pending | “全部允许”；“全部始终允许/always/授权” | 分别全部 once 或 always，队列清空 | `integration.test.js`；真实 UNVERIFIED |
| REAL-13 | 多 pending | “全部拒绝” | 全部 reject，队列清空 | `integration.test.js`；真实 UNVERIFIED |
| REAL-14 | 两个不同 createdAt | 乱序回复 | 按 createdAt/编号映射，不按 API 顺序 | `approval-manager.test.js`；真实 UNVERIFIED |
| REAL-15 | 已有 session | busy/idle、失败、取消 | 分别只出现一次 Done、Error 或 Cancelled | `session-notifier.test.js`；真实部分（历史） |
| REAL-16 | 可控 transport 错误 | prepare failed、-14、刷新 context | 记录脱敏诊断；-14 要求重绑，其余只重发 outbox | `wechat-gateway.test.js`；真实 UNVERIFIED |
| REAL-17 | 有 outbox/已处理消息 | 重启、重复入站 | outbox 幂等重放一次，重复消息不重复通知 | `wechat-gateway.test.js`；真实 UNVERIFIED |
| REAL-18 | 两个 OpenCode 目录 | 各创建一个审批/通知 | 目录、标题、Session ID 与 request ID 不串线 | `plugin.test.js`；真实 UNVERIFIED |

## 证据与清理

每项结束后必须用明确“第 N 个拒绝”或“拒绝”清空 pending；清理失败即停止并标记 `BLOCKED`。`npm run test:e2e:status` 默认做一轮无副作用扫描，`npm run test:e2e:status -- --interval=30000` 才会周期运行；它只输出 pending/outbox/context 年龄，微信标题和原文仍需人工观察，不会把状态标为通过。

当前阻塞根因已定位：OpenCode 为不同目录创建多个插件实例，只有持有全局租约的实例启动网关，非持有者以前直接丢弃事件。源码已增加租约持有者事件转发回归测试，但已实际检查的 registry 1.0.4 `dist/index.js` 不含该修复；在重新发布并看到微信原文前，REAL-00 至 REAL-18 仍不得宣称真实通过。旧 QR 绑定进程也已停止，避免竞争 context。
