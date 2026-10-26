# Claude Code / Codex TUI 通知

从 LyShell 的 Claude / Codex 工作区启动器或项目现场启动、打开历史选择器时，自动给本次 CLI 启动加入官方生命周期 hooks。普通终端手动输入 `claude` / `codex`、自定义 Agent 命令和已经运行的旧会话不自动改写；更新 LyShell 后应重新从对应启动器打开。

## 使用

- `UserPromptSubmit` / 工具生命周期提供本轮运行证据，`Stop` 提示“Claude / Codex · 本轮结束”，不会写成整个任务或目标已经成功。
- `PermissionRequest` 与 Claude 的 `Notification(permission_prompt)` 提示审批。提醒持续保留，点击查看会话后选择“定位终端”，在原 CLI 核对操作并回答。通知中心不代答 TUI 审批，也不提供允许按钮。
- 同一会话在上下文压缩时再次发出 `SessionStart`，会保留当前回合和审批状态。Claude 的工具失败事件只解除对应的审批等待，不能据此判断整个回合失败。
- Codex 的 `Interrupt` 提示本轮中断；Claude 的 `StopFailure` 提示本轮异常停止。完成回复、失败、中断提醒沿用 8 秒停留，悬停/聚焦暂停，历史及未读保留。
- 后台每 4 秒读取有界状态，CLI 回调另即时推送。原生 Harness 离线不影响 TUI 提醒。静音项目、关闭提醒和终端定位沿用通知中心现有行为。

Codex 会要求检查并信任新增 hooks：按 CLI 自己的提示打开 `/hooks`，核对 LyShell 的通知定义后由用户选择。未信任、被禁用或策略禁止时不会执行钩子，LyShell 显示“等待 CLI 事件”，不伪造完成状态。不会添加绕过信任的参数或更改已有权限模式。

本机接入依据为 Codex CLI **0.163.0**、Claude Code **2.1.309**。旧版本应先核对是否支持这些事件、Codex inline hooks / `--no-daemon` 与 Claude `--settings`；不支持时可能拒绝启动或不发通知，不承诺解析终端文本作为兼容办法。

## 语义边界

TUI 状态是最近确认的 CLI 生命周期事件，进程存活、终端静默和退出码都不会被提升成模型任务成功。`Stop` 是 CLI 的停止回复钩子；其他用户钩子可能让助手继续工作，因此它不证明整个目标完成，也不检查测试、后台任务或提交结果。后续运行事件会更新状态。

Claude 本次没有独立中断事件适配；用户中断且 CLI 未发其他事件时，最近状态可能仍保留开始/运行证据，应以原终端为准。Codex 没有在这里接入通用 API 错误终态，未报告的错误不会猜成成功或失败。CLI/系统崩溃也可能没有正常结束回执；PTY 断开只会让未确认的运行和审批降为未知。

## 实现与隔离

- 临时配置只写到 LyShell 的 `userData/tui-activity`，不写用户全局或项目的 Claude / Codex 配置。Windows 使用短启动入口，避免 cmd 长度上限；关闭会话或正常退出时清理本次文件。
- Claude 使用 `--settings` 合并本次 hooks；Codex 使用 `-c hooks.<Event>=...` 增加会话层定义，并用 `--no-daemon` 保留本次启动的通知环境。已有用户 hooks、模型和审批模式继续生效，不覆盖 `notify` 配置。
- 主进程只监听随机 IPv4 回环端口，每个终端启动有独立的 256 位通知凭据，经运行期 PTY 环境注入。凭据不进入渲染进程、会话配置、启动命令或通知记录；该端点没有执行、文件写入或审批功能。
- 独立 helper 只转发事件名、CLI 会话/回合/工具调用 ID、通知类型、时间与去重 ID。不转发提示词、回复、工具参数、工作目录或 transcript；目录由启动器绑定。helper 失败静默、有限时，不返回任何批准/拒绝/继续控制字段。
- 事件按启动、CLI 会话、回合和事件 ID 隔离，重复 Stop 不重复提醒，旧回合/旧凭据迟到回执不能覆盖新回合。审批有工具调用 ID 时关联同一调用，避免并行工具结束误清另一个审批；无调用 ID 时只能使用较粗的生命周期证据。
- 最多 256 个终端接入、100 条近期事件；重连轮换凭据和启动身份，旧凭据立即失效。状态只保留在本次 LyShell 运行中，不接管外部 CLI 或跨重启历史。

官方接口依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)。
