# 人工协作真实验收规范

## 适用范围

当用户手工在目标微信会话中发送或回复时，真实线程只负责观察并提供结构化文字证据；主线程负责扫描日志、校验字段和给出验收结论。本模式不允许主线程代替用户操作微信。

## 门禁与执行顺序

1. 主流程先使用待验收 registry 包创建 REAL-00 无副作用通知。
2. 用户在真实线程中明确文字确认目标会话、绑定身份和有效 context；人工模式以对应时间点的结构化文字证据为准，不要求截图。
3. 用户在每个 REAL-00～REAL-18 开始前再次确认目标会话和绑定身份；真实线程记录原始窗口标题，即使标题是“微信 ClawBot”。
4. REAL-00 通过门禁后，严格按 REAL-01、REAL-02…REAL-18 串行执行；每条完成后清理 pending，未清理不得进入下一条。

严格模式要求原始标题恰为 `微信ClawBot`，屏幕证据使用 `evidenceMode=SCREEN`。用户明确选择人工模式时，标题不匹配仍可在文字证据完整且符合预期时标记 `status=PASS`、`evidenceMode=MANUAL_REPORTED`，但不能改写成屏幕证据。

证据分层：严格标题 `PASS` 代表屏幕证据；人工模式的 `evidenceMode=MANUAL_REPORTED` 表示完整文字证据，`MANUAL_CONFIRMED` 表示用户身份/目标确认，不能单独通过。人工模式不要求截图，但必须记录原始标题、用户确认、可见原文和操作者时间。

## 结构化日志字段

真实线程应为每个场景输出一条 JSONL 或等价记录。主线程必须校验以下字段全部存在且相互一致：

| 字段 | 要求 |
| --- | --- |
| `scenarioID` | `REAL-00` 至 `REAL-18` 的精确值 |
| `packageVersion` | 实际 registry 包版本，不能用本地 `dist` 代替 |
| `originalWindowTitle` | 屏幕观察到的原始标题，不做覆盖或静默修正 |
| `manualConfirmation` | 固定为 `MANUAL_CONFIRMED`，表示用户已确认目标会话和绑定身份 |
| `evidenceMode` | 严格屏幕证据为 `SCREEN`；人工文字证据为 `MANUAL_REPORTED` |
| `userConfirmation` | 用户确认文字的脱敏记录 |
| `wechatTextSummary` | 微信可见原文的逐字或脱敏摘要 |
| `pluginTextSummary` | 插件在微信中可见回复的逐字或脱敏摘要 |
| `requestDecisions` | 脱敏 `requestID=decision`；诊断无审批时明确记录“无审批请求” |
| `pendingBefore` / `pendingAfter` | 处理前后非负整数 |
| `outboxBefore` / `outboxAfter` | 处理前后非负整数 |
| `conversationRecord` | 人工模式必填；与操作者时间对应的脱敏对话记录 |
| `cleanupResult` | pending 清理动作和结果 |
| `operatorTime` | 操作者记录该场景的 ISO-8601 时间 |
| `status` | 结果状态为 `PASS`、`BLOCKED` 或 `UNVERIFIED`；人工 PASS 必须同时有 `evidenceMode=MANUAL_REPORTED` |

示例（仅为格式，不是真实证据）：

```json
{"scenarioID":"REAL-00","packageVersion":"1.0.5","originalWindowTitle":"微信 ClawBot","manualConfirmation":"MANUAL_CONFIRMED","evidenceMode":"MANUAL_REPORTED","userConfirmation":"<用户明确确认>","wechatTextSummary":"[Done] REAL-00 retry-00 registry smoke ...","pluginTextSummary":"[Done] REAL-00 retry-00 registry smoke ...","requestDecisions":"无审批请求","pendingBefore":0,"pendingAfter":0,"outboxBefore":0,"outboxAfter":0,"conversationRecord":"<脱敏对话记录>","cleanupResult":"无 pending/outbox（只读快照）","operatorTime":"2026-07-28T05:14:33.899Z","status":"PASS"}
```

## 主线程校验与安全规则

- 缺少任一字段、版本不符、标题未记录、用户未确认、对话记录不可定位或 pending 清理失败时，状态只能是 `UNVERIFIED` 或 `BLOCKED`。
- `status=PASS` 需要完整字段且符合场景预期；人工 PASS 必须有 `evidenceMode=MANUAL_REPORTED`，`MANUAL_CONFIRMED` 只能证明用户确认，不能单独通过。
- 严格屏幕证据与人工文字证据必须通过 `evidenceMode` 分开记录，不得把文字证据伪装成屏幕证据。
- 文字证据不得出现其他聊天、token、context token、二维码、绑定信息或用户 ID。
- 真实线程出现 `BLOCKED`/`UNVERIFIED` 时，主线程不得继续跨场景推进、不得伪造通过、不得发布。
- 文字索引可提交，严格 PASS 的屏幕证据另行受控保存；日志只保存脱敏摘要，不保存完整聊天内容。
