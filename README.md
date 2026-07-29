# OpenCode WeChat Approve

[![CI](https://github.com/weikunzl/opencode-wechat-approve-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/weikunzl/opencode-wechat-approve-plugin/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/weikunzl/opencode-wechat-approve-plugin/branch/main/graph/badge.svg)](https://codecov.io/gh/weikunzl/opencode-wechat-approve-plugin)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/weikunzl/opencode-wechat-approve-plugin.svg)](LICENSE)

通过微信接收多个 OpenCode 原生插件实例的完成、失败、取消和权限审批通知。

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

插件遵循 OpenCode 原生 plugin 生命周期。每个项目会加载一个插件实例，实例通过共享状态目录注册；只有一个带租约的 Leader 负责微信长轮询和 outbox，其余实例发布事件并接收路由结果：

```text
OpenCode instance A ─┐
OpenCode instance B ─┼─ shared mailbox ── Gateway Leader ── WeChat
OpenCode instance C ─┘
```

不需要 `opencode web`、`opencode serve`、`opencode attach` 或固定 4096 端口。多个独立 OpenCode 会话可直接共用同一个绑定。

## 安装

要求：

- Node.js 20 或更高版本
- OpenCode 1.x，且支持官方 `plugin` hook 与注入式 SDK client
- 支持 iLink Bot 的微信账号

首次使用时，先显式执行初始化：

```bash
npm exec --yes --package=@wekux/opencode-wechat-approve-plugin -- wechat-approve setup
```

`npm exec` 显式指定了包内的 `wechat-approve` 可执行文件，可避免部分
`npx` 环境无法解析 bin 的问题。`setup` 会依次要求确认审批解释模型、
将必要的 `bash: ask` 规则以 JSONC 最小补丁写入配置，并显示二维码完成微信绑定。
它不会覆盖 MCP、其他插件、模型或显式 `deny` 规则。也可以选择全局安装：

```bash
npm install -g @wekux/opencode-wechat-approve-plugin
wechat-approve setup
```

安装器会：

1. 读取 OpenCode 的真实全局配置目录；
2. 检查已安装模型并要求确认审批解释模型；
3. 保留 JSONC 注释和其他插件配置；
4. 自动为全局规则及已解析的主 agent 写入 `bash: ask`，保留已有的更具体命令例外和显式 `deny`；
5. 显示微信二维码；
6. 扫码确认后等待用户向机器人发送固定文本 `绑定`；
7. 发送测试通知，成功后才完成安装。

初始化成功后，安装器会把当前发布版本的 npm registry 规格写入 OpenCode 的
`plugin` 数组。配置与 `opencode-notify` 等 npm 插件相同，不会使用本地
`file://` 托管副本作为最终入口：

```json
{
  "plugin": [
    "@wekux/opencode-wechat-approve-plugin@1.1.1"
  ]
}
```

无需手工覆盖现有数组；`setup` 会保留其他插件和 JSONC 注释。旧命令
`wechat-approve install` 仍可用，作为 `setup` 的兼容别名。

安装完成后重新启动 OpenCode 会话，使自动写入的审批规则参与权限计算；不需要启动独立 server。

扫码绑定的是实际微信用户 ID 和 iLink `context_token`，产品不会硬编码联系人名称。

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
npm exec --yes --package=@wekux/opencode-wechat-approve-plugin -- wechat-approve doctor
```

`doctor` 分别检查：

- 全局插件配置
- 微信账号与绑定上下文
- 已确认模型是否仍可用
- 共享状态目录权限
- 已注册插件实例数量
- 当前 Leader 租约摘要

补充或恢复绑定：

```bash
npm exec --yes --package=@wekux/opencode-wechat-approve-plugin -- wechat-approve bind
```

常见问题：

| 现象 | 处理 |
| --- | --- |
| 多个实例没有通知 | 确认各 OpenCode 会话均加载相同 registry 插件规格，并运行上方的 `doctor` 命令检查实例和 Leader |
| `Model not found: opencode/...` | 运行上方的 `doctor` 命令，重新安装并选择 `opencode models` 中存在的完整 provider/model |
| `微信 API 网络错误` | 根据提示中的安全错误码检查网络：`ENOTFOUND`/`EAI_AGAIN` 检查 DNS 或代理；`ECONNREFUSED`/`ENETUNREACH` 检查网络、防火墙或代理；超时检查网络质量和代理可达性 |
| 能收到旧消息但收不到主动通知 | 运行上方的 `bind` 命令，向机器人发送一次固定文本 `绑定` |
| `sendmessage` 返回 `prepare failed` | 先查看脱敏 `ret`、`errcode`、`errmsg`、`baseHost` 和 `contextAgeMs`；若为 `-14`，运行上方的 `bind` 命令重新扫码并发送 `绑定`；其他错误等待新入站 context 后由 outbox 重试 |
| 多项目重复通知 | 检查共享状态目录权限和 Leader 租约；实例事件通过 mailbox 去重，不需要 attach |
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
├── context-invalid.json       # iLink -14 后生成，重新绑定或收到新 context 后清除
├── processed-messages.json
├── runtime.json
├── shared-mailbox-v1.json
├── plugin-instances-v1.json
├── approval-index-v1.json
└── runtime-lease.json
```

旧版 `account.json`、`context-v1.json`、`cursor.json` 会在升级时兼容读取；新绑定将账号、上下文和游标原子写入 `binding-v1.json`。

凭据与上下文不会写入日志或微信通知。POSIX 系统使用 `0600` 文件权限；Windows 依赖当前用户配置目录的 ACL 隔离。

## 开发

```bash
npm ci
npm test
npm run build
npm run coverage
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

## License

[MIT](LICENSE)
