# OpenCode 原生多进程微信审批架构设计

## 背景

当前实现要求用户启动固定的 `opencode web` 中心服务，并通过 `attach`
汇聚多个项目。安装器还会写入 `server.hostname` 和 `server.port`。这种结构
能够让单个插件实例看到多个目录的事件，但它把插件运行依赖于额外的部署拓扑，
不符合 OpenCode 插件应由运行中的 OpenCode 实例直接加载的使用方式。

本设计以 [OpenCode Plugins 官方文档](https://opencode.ai/docs/plugins/) 和
[`opencode-notify`](https://github.com/kdcokenny/opencode-notify) 为参考：
每个 OpenCode 进程直接加载插件，插件使用注入的 `client`、`directory`、
`worktree` 和官方 hooks 处理当前实例事件。与 `opencode-notify` 不同，本项目
还要接收微信回复并把审批决定准确路由到产生请求的 OpenCode 进程。

## 目标

- 不启动、不管理也不要求额外的本地 HTTP Server。
- 不要求固定端口、`opencode web` 中心进程或 `opencode attach`。
- 一个微信绑定可同时服务多个独立 OpenCode 进程及其并行 Session。
- 每个通知和审批以 `instanceID`、`sessionID`、`requestID` 准确隔离。
- 并发微信回复不得重复审批、覆盖先前决定或扩大授权范围。
- Leader 崩溃、进程重启、重复消息和部分失败均可恢复或明确报告。
- 保留已有的绑定用户隔离、私聊限制、脱敏、幂等和模糊语义不授权规则。

## 非目标

- 不提供通用微信聊天或远程执行能力。
- 不支持把共享状态目录放在网络文件系统上。
- 不承诺网络与进程崩溃下的理论“恰好一次”；采用至少一次投递、稳定幂等键和
  状态对账得到可观察的一次业务结果。
- 不让模型建立授权决定；模型只能解释目标和校验明确的用户决定。

## 方案选择

### 方案 A：共享文件消息箱与插件内 Leader（采用）

所有插件实例使用同一个受限权限状态目录。每个实例发布自己的事件和 pending，
只有持有带 fencing epoch 租约的实例轮询微信、发送通知和排序入站消息。审批
命令通过持久消息箱路由给请求所属实例。

该方案不需要端口或常驻守护进程，可复用现有原子文件、租约和跨平台测试能力。

### 方案 B：嵌入式 SQLite

SQLite 能提供直接的跨进程事务，但需要处理 Bun、Node、Windows 和不同 CPU
架构上的原生依赖发布。当前数据规模不需要这一复杂度，因此不采用。

### 方案 C：所有实例同时轮询微信

多个进程会竞争同一 cursor，无法可靠确定哪一个实例消费了回复，容易重复或
丢失消息，因此禁止采用。

## 总体架构

```text
OpenCode Process A                 OpenCode Process B
┌──────────────────┐              ┌──────────────────┐
│ WeChat Plugin A  │              │ WeChat Plugin B  │
│ hooks + client A │              │ hooks + client B │
│ command worker A │              │ command worker B │
└────────┬─────────┘              └────────┬─────────┘
         │                                 │
         └──────── Shared Mailbox ─────────┘
                           │
                 ┌─────────▼─────────┐
                 │ Gateway Leader    │
                 │ iLink poll/send   │
                 │ inbound sequencer │
                 │ decision router   │
                 └───────────────────┘
```

Gateway Leader 不是独立服务。它只是某个正常 OpenCode 插件实例在持有租约期间
承担的附加职责；该 OpenCode 进程退出后，其他插件实例可接管。

## 组件边界

### Plugin Composition Root

`src/index.ts` 只负责接收官方 `PluginInput`、创建当前实例依赖并返回类型安全的
hooks。禁止使用最终类型断言绕过 `Hooks` 检查。

### Event Normalizer

把 OpenCode 版本差异归一为内部事件，至少兼容：

- `permission.updated` 与 `permission.asked`
- `permission.replied` 的字段名称差异
- `session.status`、`session.idle`、`session.error`
- `server.instance.disposed`

未知事件安全忽略并使用 `client.app.log` 记录字段名称，不记录正文或凭据。

### Instance Registry

每个插件启动时生成随机 `instanceID`，并记录：

- `projectKey`：由规范化 `worktree` 或 `directory` 摘要得到
- 进程 ID、进程启动指纹和心跳时间
- OpenCode 兼容版本与插件版本
- 是否具备审批模型能力

`instanceID` 只表示一次运行；进程重启后由 `projectKey` 参与孤儿请求对账。

### Shared Approval Index

全局索引保存 `requestID`、所属实例、Session、项目、创建时间、稳定展示编号、
版本号和审批状态。所有多请求认领都在短时全局锁内通过一次原子替换提交，保证
“全部允许”等批量操作基于同一快照。

### Gateway Leader

Leader 独占：

- 微信 iLink 长轮询和 cursor
- 微信通知 outbox
- 入站消息排序与去重
- 全局展示编号和 pending 快照读取
- 决策命令生成及微信结果汇总

租约包含递增 `epoch`。任何轮询、入站处理和发送操作前都必须确认 epoch 仍为
当前值；旧 Leader 即使尚未退出也不能继续提交结果。

### Instance Command Worker

每个插件实例只消费 `commands/<instanceID>/`。Worker 在提交前重新校验
`requestID`、版本和当前状态，随后使用该实例注入的 `input.client` 回复权限。
SDK 暂未覆盖的接口才允许使用同一 `PluginInput.serverUrl`，不得读取固定地址。

### Model Interpreter

需要模型解释时，Leader 选择一个健康且已确认模型的实例并发送解释命令。
解释输入只包含脱敏 pending 快照；内部 Session 禁止工具权限并在完成后删除。
Leader 再次校验 requestID、置信度、用户原始决定和授权范围后才能建立审批命令。

## 共享状态布局

```text
wechat-approve/
├── binding-v2.json
├── cursor-v2.json
├── gateway-lease-v2.json
├── approval-index-v2.json
├── instances/
├── inbound/
├── commands/<instanceID>/
├── results/
├── outbox/
└── transactions/
```

目录权限为 `0700`，包含绑定、消息或审批信息的文件权限为 `0600`。写入使用
“临时文件、同步、原子替换”；锁使用独占创建和进程启动指纹回收，不依赖
Unix `flock`。日志不得输出微信正文、token、context token、cursor 或用户 ID。

## 审批状态机

```text
PENDING
  └── CLAIMED
        └── APPLYING
              ├── APPLIED
              ├── STALE
              └── FAILED_RETRYABLE
```

- `PENDING`：OpenCode 请求仍待处理。
- `CLAIMED`：某条微信消息已按指定版本认领。
- `APPLYING`：所属实例正在调用 OpenCode。
- `APPLIED`：OpenCode 已确认对应决定。
- `STALE`：请求已过期或被 OpenCode 原生界面处理。
- `FAILED_RETRYABLE`：暂时失败，可使用同一 `commandID` 对账后重试。

成功提交的审批不可回滚。批量操作部分失败时逐项报告，未成功项回到可重试或
待用户重新确认状态。

## 入站消息与并发语义

### 持久化顺序

1. Leader 收到 iLink 批次。
2. 按 `create_time_ms`、`messageID` 排序。
3. 以 `messageID` 为幂等键写入最小入站记录。
4. 入站记录全部落盘后更新 cursor。
5. 串行消费入站记录。

若进程在第 3、4 步之间退出，下一个 Leader 会再次收到批次，但幂等键会消除
重复；若在第 4、5 步之间退出，持久 inbox 会继续处理，消息不会丢失。

### 两条确认消息同时到达

假设 M1 为“全部允许”，M2 为“全部拒绝”：

1. M1 根据当时的 `PENDING` 集合建立快照。
2. 在决策锁内校验每个请求的版本并原子标记为 `CLAIMED(M1)`。
3. M2 随后只能看到未被认领的新请求；若没有则回复“当前审批已由上一条消息处理”。
4. M2 不得修改、覆盖或撤销 M1 已认领的请求。

“全部”只作用于该消息开始处理时的快照，之后产生的请求绝不继承该决定。

### 不相交请求

两条消息分别选择不同 request 时，可先完成各自认领，再由不同 Instance Worker
并行提交。全局锁只保护快照和状态变更，不包围网络调用。

### 原生审批竞态

`permission.replied` 事件会立即把共享请求更新为终态。Worker 调用 OpenCode 前
再次核验；若原生界面已处理，则记录 `STALE`，不得发送第二次授权。

### 重复和乱序

- 相同 `messageID` 永远只生成一个 `commandID`。
- `commandID` 由消息 ID、目标 requestID 列表和决定摘要生成。
- 重复执行先查询 result 和 OpenCode 当前状态。
- 编号来自共享索引的单调计数器，不依赖各 API 返回顺序。

## 通知数据流

每个插件实例像 `opencode-notify` 一样直接处理本实例事件：

1. Hook 接收携带 `sessionID` 的事件。
2. 使用注入 `client.session.get()` 获取该 Session 元数据。
3. 生成包含 `instanceID`、`sessionID`、项目和稳定幂等键的通知。
4. 写入共享 outbox。
5. Leader 发送后标记完成。

Session 去重键必须包含 `instanceID + sessionID + runNumber + eventKind`，避免不同
OpenCode 进程中相同局部状态互相抑制。

## 生命周期与恢复

- 插件初始化：注册实例、启动 command worker、尝试获取 Leader 租约。
- 插件释放：停止本实例任务；若为 Leader，则停止长轮询并释放租约。
- Leader 丢失：新 Leader 先恢复 inbox/outbox，再开始下一次轮询。
- Owner 丢失：其命令保留；新实例按 `projectKey` 对账，无法恢复的请求标记 stale。
- 损坏文件：隔离到 quarantine，不覆盖最后一份有效状态。
- 旧 V1 状态：迁移绑定和 outbox；删除 `server` 配置依赖，不迁移运行时租约。

## 安装器与配置

安装器只负责：

1. 将精确 npm registry 包规格加入 OpenCode `plugin` 数组。
2. 选择并确认模型。
3. 在用户明确确认后配置所需的审批 `ask` 规则。
4. 完成微信绑定并发送测试通知。

安装器不得写入 `server.hostname`、`server.port`，不得提示启动 `opencode web`
或使用 `attach`。`doctor` 改为检查包规格、绑定、模型、共享状态权限、活跃实例
和 Leader 租约；OpenCode 未运行时，活跃实例只显示为提示项而不是安装失败。

## 代码迁移

- 缩减 `src/index.ts` 为组合入口。
- 新增 `event-normalizer.ts`、`plugin-instance.ts`、`shared-mailbox.ts`。
- 新增 `approval-index.ts`、`decision-router.ts`、`command-worker.ts`。
- 新增 `gateway-leader.ts`、`opencode-adapter.ts`。
- 改造 `wechat-gateway.ts`，使其只在 Leader 模式启动。
- 改造 `opencode-model.ts`，优先使用注入 SDK client。
- 删除 `config.ts` 中的中心 Server 配置。
- 删除安装器、CLI、README 和 docs 中的固定 4096/attach 架构。
- 用新的 Leader lease 替代当前只能同进程转发的 `leaseOwner`。

所有新增源码使用 TypeScript；方法不超过 20 行，参数超过 3 个时使用操作对象，
业务方法包含简洁中文注释。

## 测试策略

### 单元测试

- 事件版本归一化。
- pending 快照、版本比较和状态迁移。
- 微信消息排序、幂等键和批量选择。
- fencing epoch 与旧 Leader 拒绝。
- 模型输出授权升级拦截。

### 多进程集成测试

使用两个或三个真实子进程和同一个临时状态目录，注入 fake iLink 与 fake
OpenCode client，覆盖：

- 两个进程同时产生 pending。
- 相反批量决定同时到达。
- 不相交请求并行提交。
- Leader 在 cursor 更新前后分别崩溃。
- Leader 脑裂与 epoch 拦截。
- 重复微信消息和重复 command。
- 原生审批与微信审批竞态。
- Owner 重启、孤儿命令和部分失败。

### 真实验收

启动两个独立 OpenCode 进程，不使用 `web` 中心服务或 `attach`，共用一个微信
绑定。先通过 REAL-00，再重跑单项、批量、混合、逐个、模型安全、生命周期、
重启、outbox 和跨目录场景。每项继续遵守仓库的结构化文字或屏幕证据门禁。

## 实施阶段

1. 官方 Hook 类型与 OpenCode adapter。
2. 实例注册、共享消息箱和 V2 状态格式。
3. 通知 outbox 与 Gateway Leader 接管。
4. 全局 pending 索引、稳定编号和事件对账。
5. 入站排序、幂等和并发认领状态机。
6. 跨实例 command/result 路由。
7. 模型解释命令与安全校验。
8. Leader/Owner 崩溃恢复和旧状态迁移。
9. 删除中心 Server 配置、安装逻辑和文档。
10. 完整自动化、双进程真实微信验收和发布。

每个阶段必须先增加失败测试，再实现最小行为并运行完整测试。阶段 5 和阶段 6
通过前不得删除旧运行路径；切换时使用一次性版本化迁移，不长期保留双架构。

## 发布与完成标准

该变更移除公开的固定中心服务运行方式，建议以 `v2.0.0` 发布。发布前必须满足：

- 配置中不存在固定 OpenCode server 地址。
- 正常 `opencode` 进程能自动加载插件，无额外启动命令。
- 两个独立进程共享绑定且通知、审批不串线。
- 并发相反回复只有先成功认领者生效。
- Leader/Owner 崩溃恢复不丢消息、不重复授权。
- 自动化测试、覆盖率、registry npx smoke 和受影响 REAL 场景全部通过。
