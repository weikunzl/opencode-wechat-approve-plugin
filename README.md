# OpenCode WeChat Approve Plugin

通过微信接收 OpenCode 任务通知，并远程批准或拒绝权限请求。插件基于微信 ilink API，同时支持把微信消息桥接到 OpenCode 会话。

## 功能

- AI 任务完成或出错时发送微信通知
- OpenCode 请求权限时发送微信审批消息
- 在微信回复 `C1 yes`、`C1 no` 或 `C1 always` 完成审批
- 接收微信消息并注入指定的 OpenCode 会话
- 支持文本和图片回复
- 自动恢复最近的微信通知目标，重启后无需再次激活
- 登录凭据仅保存在本机 `~/.opencode/wechat-approve/`

## 状态图片表情

状态通知使用微信支持的 Unicode Emoji。微信客户端会使用自己的图片样式渲染这些字符；不会依赖 `[庆祝]` 之类仅在输入框中生效的快捷码。

| 状态 | 微信图片表情快捷码 |
| --- | --- |
| 任务完成 | `🎉` |
| 执行错误 | `😞` |
| 等待审批 | `👀` |
| 已批准 | `👍` |
| 已拒绝 | `👎` |
| 审批超时 | `⏰` |
| 警告 | `⚠️` |
| 帮助 | `💡` |

## 要求

- OpenCode 1.x
- Node.js 20 或更高版本
- 支持 ilink/ClawBot 的微信版本

## 安装

将仓库克隆为 `.opencode/plugins/` 的直接子目录：

```bash
git clone https://github.com/weikunzl/opencode-wechat-approve-plugin \
  .opencode/plugins/opencode-wechat-approve-plugin

cd .opencode/plugins/opencode-wechat-approve-plugin
npm install
npm test
```

OpenCode 会自动发现该目录中的插件包，无需在 `opencode.json` 中重复声明。

如果使用其他安装位置，可以在项目的 `opencode.json` 中显式指定构建入口：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./path/to/opencode-wechat-approve-plugin/dist/index.js"]
}
```

## 首次登录

在项目目录启动 OpenCode：

```bash
opencode
```

或：

```bash
opencode web
```

首次启动时，运行 OpenCode 的终端会显示微信二维码和扫码链接。扫码并在微信确认后，凭据会保存到：

```text
~/.opencode/wechat-approve/account.json
```

`opencode web` 的浏览器页面不会显示二维码，请查看启动它的终端。

## 启用权限审批

只有配置为 `ask` 的操作才会触发微信审批。例如：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": "ask",
    "edit": "ask",
    "external_directory": "ask"
  }
}
```

先在微信给机器人发送一条消息以建立回复上下文。之后收到权限请求时，微信会显示：

```text
[Approval Required #C1]
Tool: bash
Action: Run command
Args: npm test

Reply "C1 yes" to approve
Reply "C1 no" to deny
```

支持的回复：

- `C1 yes` 或 `C1 确认`：本次允许
- `C1 no` 或 `C1 拒绝`：拒绝
- `C1 always` 或 `C1 始终`：本次会话始终允许
- `status`：查看待处理审批
- `help`：显示微信命令

审批请求超过 10 分钟未处理会自动拒绝。

## OpenCode 工具

插件注册以下工具：

- `wechat_reply`：发送微信文本
- `wechat_send_image`：发送微信图片
- `wechat_notify`：主动发送通知
- `wechat_permission_confirm`：主动请求微信确认
- `wechat_new_session`：创建新的微信桥接会话

## 会话绑定

微信消息默认进入 `~/.opencode/wechat-approve/session.json` 中保存的 OpenCode 会话。可以把现有会话 ID 写入该文件：

```json
{
  "sessionID": "ses_xxx"
}
```

也可以调用 `wechat_new_session` 创建新会话。

## 本地数据

```text
~/.opencode/wechat-approve/
├── account.json     # 微信登录凭据，权限为 600
├── config.json      # 可选插件配置
├── session.json     # OpenCode 会话 ID
├── context.json     # 微信回复上下文
└── sync_buf.txt     # 消息同步状态
```

这些文件包含敏感信息，不应提交到 Git。

如果会话可能残留不可用的模型，可通过 `config.json` 显式指定微信消息使用的模型：

```json
{
  "model": "opencode-go/qwen3.7-max"
}
```

插件转发微信消息和权限重试时会使用该模型，不再依赖会话最后一次使用的模型。

## 开发

```bash
npm install
npm test
npm run dev
```

## 安全说明

远程审批会授权 OpenCode 在本机执行操作。请确保微信账号安全，仔细阅读通知中的工具、操作和参数，不要批准来源不明的请求。插件当前采用单用户、单通知目标模式。

## 致谢

本项目基于 [Ikaros12643/opencode-wechat-plugin](https://github.com/Ikaros12643/opencode-wechat-plugin) 扩展，并参考了 [Johnixr/claude-code-wechat-channel](https://github.com/Johnixr/claude-code-wechat-channel) 的微信连接实现。

## License

[MIT](LICENSE)
