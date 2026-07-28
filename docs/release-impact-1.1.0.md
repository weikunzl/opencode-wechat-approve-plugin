# v1.1.0 发布影响映射

## 变更范围

1.1.0 切换为官方 OpenCode plugin 生命周期：插件不再依赖固定端口中心服务；实例共享受保护的微信绑定，由单一 Gateway Leader 负责轮询和 outbox，其余实例通过 mailbox 路由事件。`permission.updated` 与旧 `permission.asked` 统一归一化，权限回写使用注入式 SDK client。

## 受影响场景

- REAL-00：registry 包加载、共享状态目录、实例注册和 Leader 选举。
- REAL-01～REAL-14：权限事件归一化、批量 claim、时间戳排序、跨进程 owner 回写和模型安全校验。
- REAL-15～REAL-18：生命周期通知、重启/outbox、-14/prepare failed 恢复和跨目录实例隔离。

## 发布门禁

发布前必须运行 build、test、coverage、test:e2e，并使用待发布 registry 包启动两个独立 OpenCode 进程。不得启动固定端口服务。每个受影响场景必须记录 registry 版本、原始窗口标题、MANUAL_CONFIRMED、微信文字、脱敏 requestID=decision、pending/outbox 前后和清理结果。缺字段、BLOCKED 或 UNVERIFIED 均阻止发布。

自动化 fake gateway、fake model 和 HTTP 兼容测试只能证明代码路径；真实微信文字才是 live 通过证据。
