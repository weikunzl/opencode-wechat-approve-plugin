# 真实审批与安全场景矩阵

这是 registry `@wekux/opencode-wechat-approve-plugin@1.0.5` 的验收基线。总清单固定为 REAL-00～REAL-18，共 19 项。每个真实场景只允许在可见标题严格为 `微信ClawBot` 的窗口执行，或在用户明确选择人工模式后记录为 `MANUAL_CONFIRMED`；两者都必须记录原始标题、用户确认、时间、微信原文、插件可见回复原文、脱敏 request ID/decision、pending 与 outbox 前后数量。HTTP/内存集成和 fake model 只能证明自动化行为；看不到微信原文一律是 `UNVERIFIED` 或 `BLOCKED`。详见 [`docs/manual-live-acceptance.md`](manual-live-acceptance.md)。

## 总清单

| ID | 前置条件 | 操作 | 可观察预期 | 自动化证据 | 真实状态 / 截图索引 |
| --- | --- | --- | --- | --- | --- |
| REAL-00 | registry 1.0.5、绑定、doctor | 发送无副作用诊断通知 | 微信可见原文，context 有效，outbox 可清空 | 网关/CLI 测试 | `BLOCKED`；截图缺失（标题含空格，未发送） |
| REAL-01 | 单 pending | “这个操作可以吗？” | 澄清；decision 空；pending `1→1` | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-02 | 多 pending | “那个先做一下” | 澄清目标；pending `2→2` | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-03 | 单 pending | “不要放行这个操作” | 仅 reject，不得 once/always | `approval-manager.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-04 | 多 pending | “不要放行” | 不批量拒绝，继续澄清 | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-05 | 单 pending | “帮我处理一下” | 只能解释目标，不能凭空授权 | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-06 | 单 pending | “这个能不能执行？” | 澄清，无 decision | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-07 | 单 pending | “我不确定要不要执行” | 澄清，无 decision | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-08 | 单 pending | 用户 once、模型返回 always | 拦截升级，不提交 always | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-09 | pending + 异常模型 | 非法 JSON/低置信度/未知 ID | 澄清或拒绝，无权限 API 调用 | `semantic-approval.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-10 | 无 pending | 普通模糊文本 | 不建 session、不调模型、不发审批 | `plugin.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-11 | 两个 pending | “第一个允许”，再“第二个拒绝” | `2→1→0`，中间继续询问 | `approval-manager.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-12 | 多 pending | “全部允许”；“全部始终允许/always/授权” | 分别全部 once 或 always，队列清空 | `integration.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-13 | 多 pending | “全部拒绝” | 全部 reject，队列清空 | `integration.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-14 | 两个不同 createdAt | 乱序回复 | 按 createdAt/编号映射，不按 API 顺序 | `approval-manager.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-15 | 已有 session | busy/idle、失败、取消 | 分别只出现一次 Done、Error 或 Cancelled | `session-notifier.test.js` | `UNVERIFIED`；历史记录不构成当前 PASS，截图待真实线程 |
| REAL-16 | 可控 transport 错误 | prepare failed、-14、刷新 context | 记录脱敏诊断；-14 要求重绑，其余只重发 outbox | `wechat-gateway.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-17 | 有 outbox/已处理消息 | 重启、重复入站 | outbox 幂等重放一次，重复消息不重复通知 | `wechat-gateway.test.js` | `UNVERIFIED`；截图待真实线程 |
| REAL-18 | 两个 OpenCode 目录 | 各创建一个审批/通知 | 目录、标题、Session ID 与 request ID 不串线 | `plugin.test.js` | `UNVERIFIED`；截图待真实线程 |

## 执行选项

| 档位 | 命令/范围 | 适用场景 | 发布门禁 |
| --- | --- | --- | --- |
| 自动化 smoke | `npm run test:e2e`；必要时 `npm test` | 日常开发、无外部副作用回归 | 不能单独批准发布 |
| 受影响真实回归 | 使用 registry 包，仅执行发布影响映射列出的 REAL 项 | 小版本修复且影响范围明确 | 所有受影响项必须真实 PASS 并有截图 |
| 全量真实回归 | 用户明确选择后，按 REAL-00、REAL-01…REAL-18 顺序执行 | 跨模块、发布前高风险变更 | 19 项均需真实 PASS 并有截图 |

真实回归始终先执行 REAL-00，由主流程创建无副作用通知并由用户确认屏幕原文和截图。严格模式标题不匹配时立即停止；人工模式可在用户逐条确认目标会话/绑定身份后记录 `MANUAL_CONFIRMED`，但不能记为严格 `PASS`。没有微信可见原文或清理 pending 失败时立即停止。`npm run test:e2e:live` 目前只是扫码后的人工记录器，不能自动创建审批或替代上述证据。

## 截图证据索引格式

真实线程每完成一项，在受控证据索引中新增一行；截图可存放在不入库的安全目录，文档只保存索引，不保存聊天原图：

| 场景 ID | 状态 | 截图索引 | 捕获时间 | 窗口标题 | 微信可见原文摘要（脱敏） | requestID=decision（脱敏） | pending 前→后 | outbox 前→后 | 清理结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REAL-00 | BLOCKED | `待补充` | `待补充` | `微信 ClawBot` | `未发送` | `无` | `0→0` | `0→0` | `未开始` |

截图索引命名建议为 `REAL-<nn>-<UTC 时间>.png`，每个 `PASS` 必须能定位一张只包含 `微信ClawBot` 会话的脱敏截图，并与该行的时间、原文、request ID、decision 和 pending/outbox 数量对应。不得以截图文件存在代替可见原文核对；`BLOCKED`、`UNVERIFIED` 和缺截图项不得标记通过或进入发布。

## 证据与清理

每项结束后必须用明确“第 N 个拒绝”或“拒绝”清空 pending；清理失败即停止并标记 `BLOCKED`。`npm run test:e2e:status` 默认做一轮无副作用扫描，`npm run test:e2e:status -- --interval=30000` 才会周期运行；它只输出 pending/outbox/context 年龄，微信标题和原文仍需人工观察，不会把状态标为通过。

当前实现已修复多目录租约事件转发，且 registry 1.0.5 `dist/index.js` 已包含修复。当前唯一门禁阻塞是屏幕标题显示“微信 ClawBot”而非严格要求的“微信ClawBot”；在标题符合且看到微信原文前，REAL-00 至 REAL-18 仍不得宣称真实通过。旧 QR 绑定进程已停止，避免竞争 context。

主线程按 [`docs/manual-live-acceptance.md`](manual-live-acceptance.md) 扫描真实线程日志；任何缺字段、无截图或 `BLOCKED`/`UNVERIFIED` 记录都不得转成通过。
