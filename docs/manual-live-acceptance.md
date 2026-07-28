# 人工协作真实验收规范

## 适用范围

当用户手工在目标微信会话中发送或回复时，真实线程只负责观察、截图和记录；主线程负责扫描结构化日志、校验字段和给出验收结论。本模式不允许主线程代替用户操作微信。

## 门禁与执行顺序

1. 主流程先使用待验收 registry 包创建 REAL-00 无副作用通知。
2. 用户确认屏幕上只显示目标会话、绑定身份和有效 context，并提供脱敏截图。
3. 用户在每个 REAL-00～REAL-18 开始前再次确认目标会话和绑定身份；真实线程记录原始窗口标题，即使标题是“微信 ClawBot”。
4. REAL-00 通过门禁后，严格按 REAL-01、REAL-02…REAL-18 串行执行；每条完成后清理 pending，未清理不得进入下一条。

严格模式要求原始标题恰为 `微信ClawBot`。用户明确选择人工模式时，标题不匹配只能记录为 `MANUAL_CONFIRMED`，不能改写为严格标题 `PASS`；截图和其他安全字段仍然全部必填。

## 结构化日志字段

真实线程应为每个场景输出一条 JSONL 或等价记录。主线程必须校验以下字段全部存在且相互一致：

| 字段 | 要求 |
| --- | --- |
| `scenarioID` | `REAL-00` 至 `REAL-18` 的精确值 |
| `packageVersion` | 实际 registry 包版本，不能用本地 `dist` 代替 |
| `originalWindowTitle` | 屏幕观察到的原始标题，不做覆盖或静默修正 |
| `manualConfirmation` | 用户已确认目标会话和绑定身份的布尔值 |
| `wechatTextSummary` | 微信可见原文的脱敏摘要 |
| `pluginTextSummary` | 插件在微信中可见回复的脱敏摘要 |
| `requestDecisions` | 脱敏 `requestID=decision`；澄清场景允许为空 |
| `pendingBefore` / `pendingAfter` | 处理前后非负整数 |
| `outboxBefore` / `outboxAfter` | 处理前后非负整数 |
| `screenshotIndex` | 脱敏截图路径或受控证据索引，PASS 必填 |
| `cleanupResult` | pending 清理动作和结果 |
| `observedAt` | ISO-8601 时间戳 |
| `status` | `PASS`、`MANUAL_CONFIRMED`、`BLOCKED` 或 `UNVERIFIED` |

示例（仅为格式，不是真实证据）：

```json
{"scenarioID":"REAL-00","packageVersion":"1.0.5","originalWindowTitle":"微信 ClawBot","manualConfirmation":true,"wechatTextSummary":"<脱敏原文>","pluginTextSummary":"<脱敏回复>","requestDecisions":[],"pendingBefore":0,"pendingAfter":0,"outboxBefore":1,"outboxAfter":0,"screenshotIndex":"<受控索引>/REAL-00-<UTC>.png","cleanupResult":"无 pending，已确认","observedAt":"<ISO-8601>","status":"MANUAL_CONFIRMED"}
```

## 主线程校验与安全规则

- 缺少任一字段、版本不符、标题未记录、用户未确认、截图不可定位或 pending 清理失败时，状态只能是 `UNVERIFIED` 或 `BLOCKED`。
- 截图必须只包含目标会话；不得出现其他聊天、token、context token、二维码、绑定信息或用户 ID。
- `MANUAL_CONFIRMED` 证明用户确认了目标范围，不证明严格标题匹配，也不得作为严格 `PASS` 的替代品。
- 真实线程出现 `BLOCKED`/`UNVERIFIED` 时，主线程不得继续跨场景推进、不得伪造通过、不得发布。
- 日志索引可提交，截图原件应保存在受控目录；日志只保存脱敏摘要，不保存完整聊天内容。
