# v1.0.6 发布影响映射

> 注意：当前工作树已开始原生 plugin 多进程改造；本文件的 1.0.6 记录只描述历史安装器变更，不能作为新架构的发布批准依据。新版本应单独建立 major 版本影响文档。

## 变更

安装器现在会读取 OpenCode 的已解析 agent，并在它管理的 `opencode.jsonc` 中为全局规则和每个主 agent 写入 `bash: ask`。这修复了 agent 级 `*/*=allow` 覆盖全局审批规则、导致插件收不到 `permission.asked` 的问题。安装器保留现有插件、JSONC 注释、bash 的更具体命令例外和显式 `deny`；不会修改外部 agent 文件、微信绑定或其他工具配置。

## 自动化证据

- `test/install.test.js`：全局/agent 覆盖、细粒度 bash 例外与外部已解析 agent。
- `test/cli.test.js`：只选择非 `subagent` 的已解析 agent。

## 发布后真实回归

使用 registry `1.0.6` 执行安装后新建两个独立 OpenCode 会话，不启动 `opencode web` 或 `attach`；先确认 `permission.updated`/兼容事件与 pending=1。随后按 [`approval-security-matrix.md`](approval-security-matrix.md) 重跑 REAL-00～REAL-18；每项只以完整人工文字证据或严格屏幕证据判定通过。REAL-00 与 REAL-01 的 1.0.5 历史证据不能替代本版本的审批回归。
