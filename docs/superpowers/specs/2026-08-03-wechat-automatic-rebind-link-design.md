# 微信上下文自动恢复与浏览器重绑链接设计

## 背景

微信 iLink 的发送上下文会过期。当前插件在 `sendmessage` 返回非 `-14` 的
`prepare failed` 时会保留 outbox，并等待绑定用户发送新消息以刷新 context；
收到 `-14` 时则进入 `needs-rebind`，要求用户在终端执行
`wechat-approve bind`。现场问题是错误提示不够主动，GUI 用户也不一定能看到
终端二维码，因此容易误以为插件失效。

OpenCode SDK 只支持文字 Toast，不能在 Toast 中直接嵌入二维码。项目又禁止为
插件新增 HTTP 监听端口，因此重绑入口采用受保护的一次性本地 `file://` 页面。

## 目标

- 优先使用新入站 context 自动恢复，不要求用户立即扫码。
- 自动恢复超时或明确收到 `-14` 时，生成用户可自行打开的浏览器链接。
- 用户扫码并发送“绑定”后，在当前 OpenCode 生命周期内自动恢复轮询并重放
  outbox，不要求重启 OpenCode。
- OpenCode Toast、CLI 和 `doctor` 给出一致、可操作且不泄密的状态。
- 多实例下只由当前 Gateway Leader 管理一个重绑会话。

## 非目标

- 不实现无用户确认的静默重绑；微信账号切换必须由用户扫码确认。
- 不启动本地 HTTP 服务、额外 OpenCode server、守护进程或系统服务。
- 不通过微信发送二维码，也不把二维码、token、context token、用户 ID 或完整
  API 响应写入日志、outbox 和健康状态。
- OpenCode 全部关闭后不继续维护二维码或监控微信。

## 方案选择

采用“自动恢复优先、一次性浏览器链接兜底”：

1. 非 `-14` 的 `prepare failed` 先进入 context 刷新宽限期。
2. 用户的新私聊消息携带新 context 时，插件取消重绑升级并自动重放 outbox。
3. 宽限期结束仍未恢复，或直接收到 `-14`，Leader 获取新二维码并创建临时
   HTML 页面。
4. OpenCode Toast 显示 `file://` 链接；用户也可运行
   `wechat-approve rebind-link` 重新查看当前有效链接。

不采用仅显示终端二维码的方案，因为它不能覆盖 OpenCode Web/TUI 用户；不采用
本地 HTTP 页面，因为它扩大监听面并违反当前插件生命周期约束。

## 状态机

新增 `RebindStatus`：

- `idle`：没有恢复任务。
- `awaiting-context`：已阻止旧 context 重试，等待新入站消息。
- `qr-ready`：一次性二维码页面有效，正在等待扫码确认。
- `confirming`：二维码已确认，等待绑定用户发送精确文本“绑定”。
- `expired`：二维码过期，临时页面已删除，可重新生成。

`TransportHealthStatus` 继续作为对外健康状态：宽限期内保持 `degraded`，二维码
生成后为 `needs-rebind`，新绑定原子保存后进入 `recovering`，真实探测和 outbox
重放成功后才恢复 `healthy`。

非 `-14` 的错误默认等待 60 秒。相同绑定代次和相同失败期间只启动一个计时器，
避免多条通知重复生成二维码。`-14` 跳过宽限期并立即进入二维码流程。

## 组件设计

### RebindCoordinator

新增 `RebindCoordinator`，由 Gateway Leader 创建并释放，职责为：

- 接收监督器的 `prepare failed` 或 `-14` 恢复请求；
- 管理宽限计时器、二维码生命周期和取消信号；
- 调用拆分后的 iLink 二维码获取、状态轮询和绑定确认能力；
- 生成、查询和删除一次性页面；
- 通过注入的 OpenCode `client.tui.showToast` 发布可操作提示；
- 在成功后通知 `TransportHealthSupervisor` 使用新绑定恢复。

Coordinator 不持有审批业务状态，也不直接决定 outbox 内容。Leader 租约丢失或
插件停止时必须取消未完成的登录请求并删除页面。

### 二维码页面

页面写入插件状态目录的私有子目录，目录权限 `0700`、文件权限 `0600`。文件名
使用随机不可预测标识，例如 `wechat-rebind-<random>.html`。页面只包含：

- 本次二维码的内嵌 SVG；
- “使用微信扫码，然后在目标私聊发送‘绑定’”说明；
- 过期时间和关闭页面提示。

页面不得加载远程脚本、图片或字体。二维码原始内容不单独落盘，HTML 路径不写入
普通业务日志。成功、过期、取消、Leader 退出和下次启动清理陈旧文件时均删除。

### 用户入口

OpenCode Toast 使用 warning 级别显示简短原因、一次性 `file://` 链接和
`wechat-approve rebind-link` 备用命令。Toast 失败不能影响恢复流程。

CLI 新增 `rebind-link`：

- 有有效页面时仅输出链接和过期时间；
- 正在等待 context 时说明仍可向机器人发送一条私聊消息自动恢复；
- 无有效页面或已过期时请求当前运行中的 Leader 生成新链接不可行，因此明确提示
  运行 `wechat-approve bind` 作为兼容兜底；
- 不打印二维码内容、绑定信息或任何凭据。

`doctor` 在 `needs-rebind` 时显示“打开一次性链接或运行 bind”，但不把完整链接
写入可持久化报告。

## 并发与恢复

- 只有持有 Gateway Leader 租约的实例可以生成二维码和执行登录轮询。
- 同一恢复代次复用当前有效二维码；并发失败只更新计数，不创建多个页面。
- 新入站 context 在宽限期到达时优先取消二维码升级并按现有逻辑重放 outbox。
- 二维码已生成但用户未扫码时不替换现有绑定；扫码确认属于显式用户授权。
- 新绑定必须原子保存完整 account/context/cursor 后再删除旧恢复状态。
- 进程重启不会复用旧二维码；启动时清理陈旧页面，再根据 transport 探测重新决定
  是否需要生成。

## 错误处理与提示

- 网络超时、DNS 和临时 HTTP 错误继续使用现有指数退避，不生成二维码。
- 非 `-14` 的 `prepare failed` 显示“正在等待新消息刷新微信上下文”。
- 宽限期结束显示“微信上下文未恢复，请打开链接扫码重新绑定”。
- `-14` 立即显示“微信会话已失效，需要重新绑定”。
- 二维码 API 失败时保留 outbox，记录脱敏失败类别，并提示使用
  `wechat-approve bind`；不得循环生成页面。
- 绑定成功但真实 transport 探测失败时保持 `recovering/degraded`，不得提前显示
  恢复成功。

## 测试与验收

TDD 单元测试覆盖：

- `prepare failed` 进入 60 秒宽限期且相同 context 不重复发送；
- 新入站 context 在宽限期内取消升级并重放 outbox；
- 宽限超时和 `-14` 分别生成一次二维码页面；
- 页面权限、离线资源、随机文件名、成功/过期/停止清理；
- 多实例只有 Leader 生成二维码；
- Toast 失败不阻断绑定，二维码 API 失败不泄露响应；
- `rebind-link` 和 `doctor` 的有效、等待、过期状态；
- 绑定成功后必须完成真实探测才标记 `healthy`。

自动化 E2E 使用 fake transport 验证完整状态转换和 outbox 幂等重放。发布候选必须
使用 registry 包执行真实微信恢复：先验证新入站 context 自修复，再验证二维码
链接、扫码、“绑定”、Toast 和 outbox 重放。无法观察到微信原文或 OpenCode
健康恢复时标记 `BLOCKED/UNVERIFIED`，不得作为发布通过证据。

## 兼容性与发布影响

现有 `wechat-approve bind` 保留不变，`setup/install` 流程不受影响。新增二维码
SVG 生成运行时依赖和 `rebind-link` CLI 子命令属于向后兼容功能，按 SemVer 使用
PATCH 版本发布。发布前需更新 README、故障排查、release impact 和 REAL-16/17
验收记录。
