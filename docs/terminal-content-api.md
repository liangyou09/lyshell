# 终端内容 API

在既有 `127.0.0.1` 鉴权 API 上新增：

- `GET /api/tools`：HTTP 工具目录，包含工具名、参数 schema 和能力要求。
- `POST /api/terminal-screenshot`：`{ "sessionId": "..." }`，返回实际 PNG 的 `mimeType/data/width/height/sessionId/capturedAt`；同时作为 MCP `lyshell_terminal_screenshot` 暴露图片内容块。
- `GET /api/sessions/{id}/events`：SSE，初始 `snapshot`（最近 4096 字符及截断标记），随后 `output`、`status` 和五秒 `heartbeat`。

请求携 `X-LyShell-Token`。截图/事件流受既有 `read` 能力、总开关与会话名单限制，撤权后不再交付内容；不放宽终端输入或命令执行权限。
SSE 每连接只绑定一个已解析的 runtime 会话；客户端断开、取消、撤权、背压、会话删除或服务退出时清理。
使用外部端口文件凭据的客户端需开启外部 MCP 接入并重启 LyShell。内部插件/终端凭据继续使用原有授权模型。

截图使用 LyShell 主窗口自身的 `capturePage`，按终端 DOM 位置向内裁切；不捕获其它应用/整个窗口。
目标必须真实可见且未被遮挡，窗口不能隐藏或最小化。调用不会自动切换页签；布局在截取期间改变会失败。
截图默认不落盘，由调用方决定如何保存/展示。模型应优先通过 `read_output` 分析长文本，通过图片理解视觉/TUI 信息。

Windows 本地 PTY 的普通命令自动提交使用 CR；其它会话使用 LF。显式输入控制序列及关闭自动换行时不改输入。
