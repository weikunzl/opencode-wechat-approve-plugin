# v2.0.0 发布影响映射

## 变更范围

v2 将插件运行方式切换为官方 OpenCode plugin 生命周期：删除固定端口中心服务依赖，插件实例共享一个受保护的微信绑定；单一 Gateway Leader 负责轮询和 outbox，实例事件通过 mailbox 去重并按 owner 路由。权限回写和模型会话优先使用 OpenCode 注入式 SDK client。

## 受影响场景

- REAL-00：registry 包加载、共享状态目录、实例注册和 Leader 选举。
- REAL-01～REAL-14：permission.updated/permission.replied 归一化、批量 claim、时间戳排序、跨进程 owner 回写和模型安全校验。
- REAL-15～REAL-18：生命周期通知、重启/outbox、-14/prepare failed 恢复和跨目录实例隔离。

## 发布门禁

发布前必须在干净临时目录运行 build、test、coverage、test:e2e，并使用待发布 registry 包启动两个独立 OpenCode 进程。不得启动 opencode web/serve 或 attach，不得使用固定端口。每个受影响场景必须记录 registry 版本、原始窗口标题、MANUAL_CONFIRMED、微信逐字/摘要文本、脱敏 requestID=decision、pending/outbox 前后和清理结果。缺字段、BLOCKED 或 UNVERIFIED 均阻止发布。

自动化 fake gateway、fake model、HTTP 兼容测试只能证明代码路径；真实微信消息是 live 通过证据。升级完成后应按 AGENTS.md 的 Conventional Commits 和 Semantic Versioning 规则，以单独 major 提交和 v2.0.0 标签发布。
