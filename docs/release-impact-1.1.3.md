# v1.1.3 发布影响映射

## 变更范围

1.1.3 增加 OpenCode 生命周期内的微信传输健康监督。Leader 启动失败不再因旧
outbox 阻断长轮询；非 Leader 会重试租约接管；上下文过期后进入
`needs-rebind`，新绑定保存后由当前进程自动恢复。最后一个实例正常退出时尽力发送
停止通知，全部实例退出后不再运行任何监控。

## 自动化门禁

- 启动探测成功后才回放 outbox，并持久化脱敏健康摘要。
- 网络或 context 刷新失败进入有上限的退避，不让插件初始化失败。
- iLink `-14` 停用旧 context，并在新绑定代次出现后恢复。
- 租约竞争、丢失和接管不会产生两个微信轮询 Leader。
- 最后一个活跃实例发送停止通知；异常退出不会伪造正常停止。
- `doctor` 分别报告 binding 与 transport，不输出凭据或原始错误正文。

执行 `npm test`、`npm run coverage`、`npm run test:e2e`、`npm run build`、
`npm pack --dry-run` 和 `git diff --check`。

## 真实微信门禁

正式发布前先发布 `1.1.3-rc.0` 到 `next`，从 npm registry 安装候选包并执行：

- REAL-00：OpenCode 加载候选包，启动探测原文可见，`doctor` transport 为 healthy。
- REAL-16：模拟/观察失效 context，确认不无限重试旧 context；重新扫码绑定后，
  无需再次重启 OpenCode即可收到恢复探测，并回放原 outbox 一次。
- REAL-17：重启后通知不重复；最后一个实例正常退出只出现一次停止通知；OpenCode
  全部关闭期间没有继续监控或发送。

每项记录版本来源、微信原文、pending/outbox 前后和清理结果。任一场景
`FAIL`、`BLOCKED` 或 `UNVERIFIED` 时不得发布正式 `latest`。
