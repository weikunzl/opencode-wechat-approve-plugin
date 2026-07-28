# 真实审批与安全场景矩阵

这是 registry `@wekux/opencode-wechat-approve-plugin@1.0.5` 的验收基线。总清单固定为 REAL-00～REAL-18，共 19 项。严格屏幕 PASS 使用 `evidenceMode=SCREEN`；人工模式在文字字段完整且符合预期时使用 `status=PASS`、`evidenceMode=MANUAL_REPORTED`，不要求截图。`MANUAL_CONFIRMED` 仅表示身份确认，不能单独通过。HTTP/内存集成和 fake model 只能证明自动化行为；缺少微信原文文字一律是 `UNVERIFIED` 或 `BLOCKED`。详见 [`docs/manual-live-acceptance.md`](manual-live-acceptance.md)。

所有场景的最小统一记录字段为：`scenarioID`、`status`、`evidenceMode`、微信原文、`requestID-decision`、pending 前后、outbox 前后、清理结果和阻塞原因。结构化日志可使用现有英文键名，但不得省略这些语义字段。

## 总清单

| ID | 前置条件 | 操作 | 可观察预期 | 自动化证据 | 真实状态 / 文字证据 |
| --- | --- | --- | --- | --- | --- |
| REAL-00 | registry 1.0.5、绑定、doctor | 发送无副作用诊断通知 | 微信可见原文，context 有效，outbox 可清空 | 网关/CLI 测试 | `PASS`；`evidenceMode=MANUAL_REPORTED`，原始标题为“微信 ClawBot” |
| REAL-01 | registry 1.0.5、已绑定、可执行会话 | 执行无副作用任务 | 微信仅出现一次 Done，任务完成 | `session-notifier.test.js` | `PASS`；`evidenceMode=MANUAL_REPORTED`，已观察 `[Done] REAL-01 manual approval` |
| REAL-02 | 多 pending | “那个先做一下” | 澄清目标；pending `2→2` | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-03 | 单 pending | “不要放行这个操作” | 仅 reject，不得 once/always | `approval-manager.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-04 | 多 pending | “不要放行” | 不批量拒绝，继续澄清 | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-05 | 单 pending | “帮我处理一下” | 只能解释目标，不能凭空授权 | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-06 | 单 pending | “这个能不能执行？” | 澄清，无 decision | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-07 | 单 pending | “我不确定要不要执行” | 澄清，无 decision | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-08 | 单 pending | 用户 once、模型返回 always | 拦截升级，不提交 always | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-09 | pending + 异常模型 | 非法 JSON/低置信度/未知 ID | 澄清或拒绝，无权限 API 调用 | `semantic-approval.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-10 | 无 pending | 普通模糊文本 | 不建 session、不调模型、不发审批 | `plugin.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-11 | 两个 pending | “第一个允许”，再“第二个拒绝” | `2→1→0`，中间继续询问 | `approval-manager.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-12 | 多 pending | “全部允许”；“全部始终允许/always/授权” | 分别全部 once 或 always，队列清空 | `integration.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-13 | 多 pending | “全部拒绝” | 全部 reject，队列清空 | `integration.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-14 | 两个不同 createdAt | 乱序回复 | 按 createdAt/编号映射，不按 API 顺序 | `approval-manager.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-15 | 已有 session | busy/idle、失败、取消 | 分别只出现一次 Done、Error 或 Cancelled | `session-notifier.test.js` | `UNVERIFIED`；历史记录不构成当前 PASS，文字证据待真实线程 |
| REAL-16 | 可控 transport 错误 | prepare failed、-14、刷新 context | 记录脱敏诊断；-14 要求重绑，其余只重发 outbox | `wechat-gateway.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-17 | 有 outbox/已处理消息 | 重启、重复入站 | outbox 幂等重放一次，重复消息不重复通知 | `wechat-gateway.test.js` | `UNVERIFIED`；文字证据待真实线程 |
| REAL-18 | 两个 OpenCode 目录 | 各创建一个审批/通知 | 目录、标题、Session ID 与 request ID 不串线 | `plugin.test.js` | `UNVERIFIED`；文字证据待真实线程 |

## 执行选项

| 档位 | 命令/范围 | 适用场景 | 发布门禁 |
| --- | --- | --- | --- |
| 自动化 smoke | `npm run test:e2e`；必要时 `npm test` | 日常开发、无外部副作用回归 | 不能单独批准发布 |
| 受影响真实回归 | 使用 registry 包，仅执行发布影响映射列出的 REAL 项 | 小版本修复且影响范围明确 | 严格项需 `PASS + SCREEN`；人工项需 `PASS + MANUAL_REPORTED` |
| 全量真实回归 | 用户明确选择后，按 REAL-00、REAL-01…REAL-18 顺序执行 | 跨模块、发布前高风险变更 | 严格项需 `PASS + SCREEN`；人工项需 `PASS + MANUAL_REPORTED` |

真实回归始终先执行 REAL-00，由主流程创建无副作用通知；用户以真实线程明确文字确认目标会话/绑定身份。人工模式字段完整且符合预期后标记 `PASS + MANUAL_REPORTED`，不得记为屏幕证据。没有微信可见原文文字或清理 pending 失败时立即停止。`npm run test:e2e:live` 目前只是扫码后的人工记录器，不能自动创建审批或替代上述证据。

## 文字证据索引格式

真实线程每完成一项，在受控文字证据索引中新增一行；人工模式不要求截图，文档只保存脱敏文字：

| 场景 ID | 状态 | evidenceMode | registry 版本 | 原始窗口标题 | MANUAL_CONFIRMED | 用户确认 | 微信可见原文 | requestID=decision | pending 前→后 | outbox 前→后 | 清理结果 | 操作者时间 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REAL-00 | PASS | `MANUAL_REPORTED` | `1.0.5` | `微信 ClawBot` | `是` | `已确认目标会话和绑定身份` | `[Done] REAL-00 retry-00 registry smoke ...` | `无审批请求` | `0→0` | `0→0` | `无 pending/outbox（只读快照）` | `2026-07-28T05:14:33.899Z` |
| REAL-01 | PASS | `MANUAL_REPORTED` | `1.0.5` | `微信 ClawBot` | `是` | `沿用已确认的目标会话和绑定身份` | `[Done] REAL-01 manual approval` | `无审批请求` | `0→0` | `0→0` | `任务完成；无 pending/outbox` | `2026-07-28T05:29:14.841Z` |

严格标题 `PASS` 需要 `evidenceMode=SCREEN`；人工 `PASS` 需要 `evidenceMode=MANUAL_REPORTED` 和完整文字字段。`MANUAL_CONFIRMED` 仅表示身份确认，`BLOCKED`、`UNVERIFIED` 和缺字段项不得标记通过或进入发布。

## 证据与清理

每项结束后必须用明确“第 N 个拒绝”或“拒绝”清空 pending；清理失败即停止并标记 `BLOCKED`。`npm run test:e2e:status` 默认做一轮无副作用扫描，`npm run test:e2e:status -- --interval=30000` 才会周期运行；它只输出 pending/outbox/context 年龄，微信标题和原文仍需人工观察，不会把状态标为通过。

当前实现已修复多目录租约事件转发，且 registry 1.0.5 `dist/index.js` 已包含修复。REAL-00 和 REAL-01 已分别消费 retry-00 与任务完成的完整文字证据，均标记 `status=PASS`、`evidenceMode=MANUAL_REPORTED`；两者都不是屏幕证据。OpenCode 的 `bash/*=allow` 仍会阻止 REAL-02 至 REAL-14 等审批语义场景形成 `permission.asked`/pending=1；这些场景在 active agent 最终匹配为 `bash=ask` 并重载会话后才能继续。旧 QR 绑定进程已停止，避免竞争 context。

主线程按 [`docs/manual-live-acceptance.md`](manual-live-acceptance.md) 扫描真实线程日志；任何缺字段或 `BLOCKED`/`UNVERIFIED` 记录都不得转成通过。
