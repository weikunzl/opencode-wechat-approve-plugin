# OpenCode 重启后的微信健康恢复设计

## 背景与根因

当前绑定通过 `binding-v1.json` 持久化，OpenCode 重启不会删除账号、context
和 cursor。现场诊断发现绑定结构有效且 `doctor` 显示 `bound`，但 context
长时间未刷新、outbox 存在积压。

原生运行路径中的 `GatewayLeader.start()` 在取得租约后同步执行
`flushOutbox()`。任何发送失败都会让启动 Promise 拒绝，同时不释放租约，也
不启动微信长轮询。结果是持久绑定存在、Leader 租约存在，但 transport 实际
不可用，形成“假健康 Leader”。

## 目标

- OpenCode 启动后通过真实微信消息验证 transport，而不只检查本地绑定文件。
- outbox 或健康检查失败不得中断插件初始化。
- 临时网络错误、`prepare failed` 和 `errcode=-14` 使用不同恢复路径。
- 重新执行 `wechat-approve bind` 后，运行中的插件自动恢复，无需再次重启。
- 多进程中只有 Gateway Leader 发送健康消息；Leader 退出后其他实例可接管。
- 正常关闭最后一个 OpenCode 实例时发送 best-effort 停止通知。
- `doctor` 分开报告持久绑定与真实 transport 健康。

## 非目标

- 不启动独立守护进程、OpenCode server、HTTP 端口或系统服务。
- OpenCode 全部关闭后不继续监控微信。
- 不承诺崩溃、断电或强制杀进程时一定能发送停止通知。
- 不在健康状态中保存 token、context token、用户 ID、微信正文或完整 URL。

## 状态机

`TransportHealthStatus` 包含：

- `starting`：Leader 已取得租约，正在恢复。
- `healthy`：最近一次真实发送成功，可以重放 outbox。
- `degraded`：临时网络错误或非 `-14` 的 `prepare failed`。
- `needs-rebind`：缺少绑定或收到 `errcode=-14`。
- `recovering`：检测到新绑定代次，正在重新验证。
- `stopped`：正常释放或丢失 Leader 租约。

状态由 `TransportHealthSupervisor` 管理。监督器只在 OpenCode 插件生命周期
内运行；所有 OpenCode 实例关闭时不存在后台监控。

## 持久化健康状态

新增 `transport-health-v1.json`，权限保持 `0600`：

```ts
interface TransportHealthState {
  schemaVersion: 1
  status: TransportHealthStatus
  lastProbeAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastFailureKind: TransportFailureKind | null
  consecutiveFailures: number
  nextRetryAt: number | null
  cleanShutdown: boolean
  bindingGenerationDigest: string | null
}
```

绑定代次使用账号、context 与更新时间计算 SHA-256 摘要；摘要不允许反推出
原始凭据。损坏状态沿用现有隔离策略并回退到安全默认值。

## 启动与健康消息

Leader 获取租约后先标记 `cleanShutdown=false`，启动长轮询，再决定是否发送：

`🔄 [OpenCode] 微信授权插件已重新连接`

满足任一条件时发送：

- 上次成功探测距今超过 5 分钟；
- context 超过 30 分钟未刷新；
- outbox 非空；
- 上次不是正常关闭；
- 上次状态不是 `healthy`。

健康探测使用当前启动代次的稳定幂等键，不进入普通 outbox。发送成功后标记
`healthy`，然后按原顺序重放 outbox。探测或 outbox 失败只改变健康状态，不能
阻止长轮询和插件 hooks 初始化。

## 错误与重新绑定

- DNS、连接失败和超时进入 `degraded`，指数退避，最大间隔 5 分钟。
- 非 `-14` 的 `prepare failed` 保留绑定和 outbox，等待新入站 context 后立即
  重新探测。
- `errcode=-14` 使旧 context 失效，进入 `needs-rebind`，停止旧 transport
  并提示运行 `wechat-approve bind`。
- 监督器低频检查绑定摘要；新绑定原子提交后进入 `recovering`，重新启动轮询、
  发送连接消息并重放 outbox。

## Leader 接管与实例清理

非 Leader 插件实例不连接微信，但使用带随机抖动的低频定时器重新竞争租约。
Leader 正常退出、崩溃或租约丢失后，存活实例可接管并执行恢复流程。

实例注册表在注册、列举和诊断前清理已死亡 PID 或超过心跳期限的记录，避免
`doctor` 把历史实例计为 active。清理只使用 PID、进程指纹和心跳，不读取业务
数据。

## 正常关闭通知

仅当当前实例是 Leader、transport 为 `healthy` 且没有其他可接管实例时发送：

`⏹️ [OpenCode] 微信授权插件已停止`

发送最多等待 2 秒，不进入 outbox。成功或失败都必须继续停止长轮询、释放租约
并完成 OpenCode 退出。若存在其他活跃实例，则不发送停止消息；接管者发送：

`🔄 [OpenCode] 微信授权网关已切换并恢复连接`

## Doctor

`doctor` 新增 `transport` 检查：

- `healthy`：展示最近成功时间。
- `degraded`：展示脱敏失败类别、outbox 数量和下次重试状态。
- `needs rebind`：失败并显示 `wechat-approve bind`。
- `unknown`：尚无真实健康探测，不得将 `binding: bound` 当作 transport 通过。

## 测试与验收

TDD 单元测试覆盖：

- outbox 恢复失败不阻止 Leader 启动且不遗留假健康状态；
- 健康探测条件、冷却和稳定幂等键；
- 临时错误、`prepare failed`、`-14` 状态转换；
- 新绑定代次自动恢复；
- 非 Leader 接管；
- 停止通知只由最后一个健康 Leader 发送且超时不阻塞；
- 陈旧实例清理；
- `doctor` 区分 binding 与 transport。

集成测试覆盖重启、outbox 保留、重新绑定与接管。发布候选使用 registry 包重跑
REAL-00、REAL-16、REAL-17，并新增启动/停止消息的人工文字证据。任何
`BLOCKED` 或 `UNVERIFIED` 不得作为发布通过证据。

## 版本与发布

该变更新增用户可见健康与停止通知，并提供向后兼容的自动恢复能力，正式版本按
SemVer 发布为 `1.2.0`。先发布 prerelease dist-tag 做真实微信验收，通过后再
发布正式 `latest`。
