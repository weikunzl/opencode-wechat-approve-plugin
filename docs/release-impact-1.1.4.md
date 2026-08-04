# v1.1.4 发布影响映射

## 变更范围

1.1.4 为微信 context 过期增加分级恢复。非 `-14` 的 `prepare failed` 先等待
60 秒新入站 context；仍未恢复或直接收到 `-14` 时，Gateway Leader 生成一个
受保护、会过期的本地 `file://` 二维码页面，并通过 OpenCode Toast 提供链接。
用户扫码并发送“绑定”后，插件无需重启即可真实探测 transport 并重放 outbox。

Gateway Leader 启动时先读取 OpenCode 权威审批快照，再恢复 outbox。历史完成、错误、
审批结果和警告不会在重绑后重新发送；过期审批只清理本地索引，不调用权限回复接口。
权威快照失败时本轮 Leader 不启动 transport，由现有租约机制重试，避免脏消息抢先发送。

新增 `wechat-approve rebind-link` 用于再次查看当前有效链接。现有 `bind`、
`setup` 和 `install` 保持兼容。不新增 HTTP 端口、后台守护进程或浏览器自动打开。

## 安全影响

- 二维码只在内存中传入 SVG 渲染器，不单独持久化原始内容。
- 临时目录和页面分别使用 `0700`、`0600`，文件名为随机白名单值。
- 页面不加载远程脚本、图片或字体，成功、过期、取消和 Leader 退出时删除。
- 状态文件仅保存阶段、时间、随机文件名和绑定摘要，不保存凭据或服务端正文。
- 只有 Gateway Leader 可以创建二维码和执行强制登录；其他实例不能重复生成。

## 自动化门禁

- 二维码页面权限、离线资源、路径校验、过期和清理。
- QR 发布顺序、登录和绑定取消、旧绑定原子保留。
- context 宽限、`-14` 立即升级、重复失败去重和绑定变化取消。
- 新绑定完成后允许真实探测，探测成功前不报告恢复。
- 启动权威快照先于 transport，且只恢复当前未过期审批对应的 outbox 通知。
- OpenCode Toast、`rebind-link`、doctor 和敏感信息脱敏。
- 完整 `npm test`、coverage、自动化 E2E、build、pack 和 diff check。

## 真实微信门禁

- REAL-00：候选包加载并完成真实 transport 探测。
- REAL-16A：非 `-14` 的失败保留 outbox；用户发送一条新私聊后 context 刷新，
  outbox 只重放一次且无需二维码。
- REAL-16B：`-14` 或宽限超时后 OpenCode 显示一次性 `file://` 链接；用户自行
  打开、扫码并发送“绑定”，页面被删除，transport 恢复健康。
- REAL-17：恢复及 OpenCode 重启后不重复通知，多实例只出现一个二维码流程。

每项记录候选版本来源、OpenCode 可见提示、微信原文、outbox 前后和清理结果，
不得记录二维码、token、context 或用户 ID。任何 `FAIL`、`BLOCKED` 或
`UNVERIFIED` 不得作为发布通过证据。
