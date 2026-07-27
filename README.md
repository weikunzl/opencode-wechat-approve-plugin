# OpenCode WeChat Approve

通过微信接收一个中心 OpenCode 服务中所有会话的完成、失败、取消和权限审批通知。

V1 是通知与审批插件，不是聊天机器人：普通微信消息不会创建、继续或提示任何 OpenCode 会话。

## 功能

- 会话真实完成后发送一次通知，包含标题、Session ID 和项目目录
- 执行失败时发送精简错误，随后到达的 idle 事件不会再发送 Done
- 用户取消任务时显示为 Cancelled，不误报为失败或完成
- 将 OpenCode 权限请求发送到扫码绑定的微信用户
- 支持 `好的`、`OK`、`始终允许`、`全部授权`、`拒绝` 等自然回复
- 同时存在多个待审批时，通过编号、项目、操作或“两个都”等语言二次确认
- 使用安装时确认的模型辅助解释复杂审批回复；模型不能调用工具或直接授权
- outbox、轮询游标、去重记录、待审批和会话状态均可在重启后恢复
- 支持 Windows、macOS 和 Linux

## 运行结构

V1 使用一个固定的中心服务：

```text
opencode web / serve 127.0.0.1:4096
├── project A sessions
├── project B sessions
└── project C sessions
```

只启动一次：

```bash
opencode web
```

其他终端连接同一个服务：

```bash
opencode attach http://127.0.0.1:4096 --dir /absolute/path/to/project
```

Windows PowerShell：

```powershell
opencode attach http://127.0.0.1:4096 --dir C:\workspace\project
```

不要为每个项目单独执行 `opencode web`。独立服务拥有独立事件流，无法由一个插件实例天然合并。

## 安装

要求：

- Node.js 20 或更高版本
- OpenCode 1.x，且支持 `plugin`、`web` 和 `attach`
- 支持 iLink Bot 的微信账号

执行：

```bash
npx github:weikunzl/opencode-wechat-approve-plugin install
```

安装器会：

1. 读取 OpenCode 的真实全局配置目录；
2. 检查已安装模型并要求确认审批解释模型；
3. 保留 JSONC 注释和其他插件配置；
4. 写入中心服务默认地址 `127.0.0.1:4096`；
5. 显示微信二维码；
6. 扫码确认后等待用户向机器人发送固定文本 `绑定`；
7. 发送测试通知，成功后才完成安装。

扫码绑定的是实际微信用户 ID 和 iLink `context_token`，产品不会硬编码联系人名称。

建议在启动中心服务前设置密码：

```bash
export OPENCODE_SERVER_PASSWORD='use-a-strong-password'
opencode web
```

PowerShell：

```powershell
$env:OPENCODE_SERVER_PASSWORD = 'use-a-strong-password'
opencode web
```

## 审批回复

单个待审批：

| 回复示例 | OpenCode 决策 |
| --- | --- |
| `是`、`OK`、`好的`、`同意`、`允许`、`yes` | `once` |
| `全部授权`、`始终允许`、`always`、`allow all` | `always` |
| `no`、`拒绝`、`不同意`、`取消` | `reject` |

多个待审批：

- `好的`：不立即授权，先询问具体是哪一个
- 二次确认只接受纯选择：`#1`、`第一个`、`1 和 3`
- 也可在第一条回复中直接表达完整意图：`允许 docs 项目的`、`拒绝 npm test 那个`
- `两个都允许`
- `两个都始终允许`
- `只拒绝 git push`

执行前会重新读取 OpenCode 待审批列表。请求已在桌面端处理、已过期或集合发生变化时，不会把回复错误应用到旧请求。

## 状态图片表情

通知使用 Unicode Emoji，例如 `🎉`、`😞`、`👀`、`👍`。微信会把支持的 Emoji 字符渲染成自己的图片表情；`[庆祝]` 这类输入框快捷文字经 Bot API 发送时可能只显示为普通文本，因此插件不再发送快捷文字。参见 [微信表情列表与转换说明](https://www.emojiall.com/zh-hans/platform-wechat)。

## 诊断与恢复

```bash
npx github:weikunzl/opencode-wechat-approve-plugin doctor
```

`doctor` 分别检查：

- 全局插件配置
- 微信账号与绑定上下文
- 已确认模型是否仍可用
- `127.0.0.1:4096/global/health`

补充或恢复绑定：

```bash
npx github:weikunzl/opencode-wechat-approve-plugin bind
```

常见问题：

| 现象 | 处理 |
| --- | --- |
| `ServeError` 或端口变化 | 确认只启动一个 `opencode web`，检查 4096 是否被其他进程占用 |
| `Model not found: opencode/...` | 运行 `doctor`，重新安装并选择 `opencode models` 中存在的完整 provider/model |
| 能收到旧消息但收不到主动通知 | 运行 `bind`，向机器人发送一次固定文本 `绑定` |
| 多项目重复通知 | 让其他终端使用 `opencode attach`；插件租约会禁用同一状态目录下的次实例 |
| 微信回复“继续”没有反应 | 这是 V1 的预期行为；普通消息不会驱动 AI 会话 |

## 本地状态

所有插件状态均位于：

```text
~/.opencode/wechat-approve/
├── binding-v1.json
├── config.json
├── pending-approvals.json
├── approval-conversation.json
├── notification-outbox.json
├── processed-messages.json
├── runtime.json
└── runtime-lease.json
```

旧版 `account.json`、`context-v1.json`、`cursor.json` 会在升级时兼容读取；新绑定将账号、上下文和游标原子写入 `binding-v1.json`。

凭据与上下文不会写入日志或微信通知。POSIX 系统使用 `0600` 文件权限；Windows 依赖当前用户配置目录的 ACL 隔离。

## 开发

```bash
npm ci
npm test
npm run build
```

测试在 Windows、macOS 和 Linux 上运行。

## 安全边界

- 默认只连接回环地址
- 只接受扫码绑定用户的一对一消息
- 群聊和其他发送者被忽略
- 模糊表达永不授权
- `always` 只在用户明确表达持续授权时发送
- 模型输出必须通过请求 ID、结构、置信度和授权范围校验
- 普通微信消息不创建或推进 OpenCode 会话

## 致谢

项目基于 [Ikaros12643/opencode-wechat-plugin](https://github.com/Ikaros12643/opencode-wechat-plugin) 的 iLink 连接思路，并参考 [Johnixr/claude-code-wechat-channel](https://github.com/Johnixr/claude-code-wechat-channel)。

## License

[MIT](LICENSE)
