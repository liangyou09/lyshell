# MCP 配置指南 · MCP Configuration

> 本节说明如何把 LyShell 作为 MCP 服务端接入 AI 客户端（Claude Code 等）。大多数情况下你**不需要手动配置** —— 让 agent 自己配即可。
> *How to connect LyShell as an MCP server to AI clients (Claude Code, etc.). In most cases you don't need to configure anything by hand — let the agent do it.*

## 概览 · Overview

- LyShell 内置一个 **MCP HTTP API**（真正的 MCP 服务端），对外暴露 19 个 `lyshell_*` 工具，受 capability 门控。*LyShell runs a built-in **MCP HTTP API** (the actual MCP server) exposing 19 `lyshell_*` tools, gated by capability.*
- 客户端经 **stdio 桥 `mcpServer.js`** 连入：它是一个用 MCP SDK `StdioClientTransport` 实现的 stdio → HTTP 转发器，Claude Code 这类 stdio 客户端都通过它连。*Clients connect through a **stdio bridge, `mcpServer.js`** — a stdio → HTTP forwarder built on the MCP SDK `StdioClientTransport`, the same way Claude Code and other stdio clients connect.*
- 连接所需信息是一组「连接包」环境变量（见下）。*The connection requires a "connection package" of environment variables (see below).*
- 服务端配置保存在 `%APPDATA%\lyshell\mcp-server.json`。*Server-side config lives in `%APPDATA%\lyshell\mcp-server.json`.*

```
Claude Code / MCP 客户端 ──stdio──▶ mcpServer.js ──HTTP──▶ LyShell MCP API ──▶ 终端会话
   (env: LYSHELL_MCP_*)              (桥 · StdioClientTransport)
```

## 推荐方式：让 agent 自己配（零手工）· Recommended: let the agent configure itself

这是最省事、也是默认该用的方式。你不需要知道端口、token 或任何配置语法。*This is the easiest and default path — you don't need to know the port, token, or any config syntax.*

1. 在 LyShell 里通过 **Agent 启动栏** 启动 Claude Code（或任意 CLI agent）。*Launch Claude Code (or any CLI agent) from LyShell's **Agent Launcher**.*
2. LyShell 会把「连接包」env 注入到该 agent 的进程环境里（端口 + token + 桥脚本 + electron 路径）。*LyShell injects the connection-package env vars into that agent's process environment (port + token + bridge script + electron path).*
3. 你只需要对 agent 说一句话，例如：*Then just tell the agent one line, e.g.:*

   > 把 LyShell 配置成你的 MCP 服务端：读你环境变量里的 `LYSHELL_MCP_PORT` / `LYSHELL_MCP_TOKEN` / `LYSHELL_MCP_SERVER_SCRIPT` / `LYSHELL_ELECTRON_EXE`，写进 `.mcp.json`（或 `claude mcp add`）。
   > *Configure LyShell as your MCP server: read `LYSHELL_MCP_PORT` / `LYSHELL_MCP_TOKEN` / `LYSHELL_MCP_SERVER_SCRIPT` / `LYSHELL_ELECTRON_EXE` from your environment and write them into `.mcp.json` (or `claude mcp add`).*

   agent 会读取自身 env 里的连接信息，自己写好 MCP 客户端配置，随后即可调用 `lyshell_*` 工具。*The agent reads the connection info from its own env, writes its own MCP client config, and can then call the `lyshell_*` tools.*

- 会话级授权与 capability 门控仍然生效：agent 只能用被授予的那部分工具。*Per-session authorization and capability gates still apply — the agent can only use the tools it was granted.*
- 关闭标签即销毁：agent 会话为瞬态，连接信息随之失效。*Close the tab and it's gone — agent sessions are transient, and the connection info is revoked with them.*

## 手动配置（外部客户端 / 高级）· Manual configuration (external clients / advanced)

默认情况下，只有由 LyShell 启动的进程（Agent 启动栏 / 插件 `spawnControlled`）能拿到连接包；**独立启动**的外部客户端连不上，因为 `allowExternalMcpClients` 默认关闭，端口文件里的 token 为 null。*By default only LyShell-launched processes (Agent Launcher / plugin `spawnControlled`) receive the connection package; a **standalone** external client cannot connect, because `allowExternalMcpClients` is off by default and the port-file token is null.*

如需手动接入一个独立客户端：*To wire up a standalone client manually:*

1. 在 `mcp-server.json` 里把 `allowExternalMcpClients` 设为 `true`，拿到全局 token。*In `mcp-server.json`, set `allowExternalMcpClients` to `true` and obtain the global token.*
2. 找到 LyShell 写的端口文件（`discoverLyshell` 用同一个端口文件发现服务），拿到端口与全局 token。*Locate LyShell's port file (`discoverLyshell` uses the same port file to discover the server) to get the port and global token.*
3. 配置客户端经 `mcpServer.js` 桥连入。以 Claude Code 的项目级 `.mcp.json` 为例：*Configure the client to connect through the `mcpServer.js` bridge. Example — Claude Code project-level `.mcp.json`:*

```json
{
  "mcpServers": {
    "lyshell": {
      "command": "<LYSHELL_ELECTRON_EXE>",
      "args": ["<LYSHELL_MCP_SERVER_SCRIPT>"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "LYSHELL_MCP_PORT": "<port>",
        "LYSHELL_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

> 等价地可用 `claude mcp add lyshell -- <LYSHELL_ELECTRON_EXE> <LYSHELL_MCP_SERVER_SCRIPT>` 并补上环境变量（`ELECTRON_RUN_AS_NODE=1`、端口、token）。
> *Equivalently: `claude mcp add lyshell -- <LYSHELL_ELECTRON_EXE> <LYSHELL_MCP_SERVER_SCRIPT>` plus the env vars (`ELECTRON_RUN_AS_NODE=1`, port, token).*

> ⚠️ 打开 `allowExternalMcpClients` 会让任何拿到全局 token 的进程都能连上。仅在确实需要独立客户端时开启；用完建议关回 `false`。*⚠️ Enabling `allowExternalMcpClients` lets any process holding the global token connect. Only enable it when you genuinely need a standalone client; turn it back to `false` afterwards.*

## 连接包字段 · Connection-package fields

| 变量 Variable | 含义 Meaning |
|---|---|
| `LYSHELL_MCP_PORT` | LyShell MCP HTTP API 的端口。*Port of the LyShell MCP HTTP API.* |
| `LYSHELL_MCP_TOKEN` | 当前进程的 token（插件 / agent 各自独立签发，互不可见）。*Token for the current process (issued per plugin / agent, mutually invisible).* |
| `LYSHELL_MCP_SERVER_SCRIPT` | `mcpServer.js` 桥脚本的绝对路径。*Absolute path to the `mcpServer.js` bridge script.* |
| `LYSHELL_ELECTRON_EXE` | 用来跑桥脚本的 electron.exe（以 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 运行）。*The electron.exe used to run the bridge script (run as plain Node via `ELECTRON_RUN_AS_NODE=1`).* |

## 权限：capability → 工具 · Permissions: capability → tools

连接包里的 token 绑定了该进程被授予的 capability；`tools/list` 动态返回工具清单，`tools/call` 调用未声明 capability 的工具会被服务端 403。*The token in the connection package is bound to the process's granted capabilities; `tools/list` returns the tool list dynamically, and calling a tool outside the declared capabilities is rejected with 403.*

| capability | 工具 tools |
|---|---|
| `read` | list_sessions · read_output · read_session_notes · list_files · read_file · stat_file · wait_for_prompt · tail_until |
| `interactiveWrite` | send_input · send_and_wait |
| `execute` / `localExecute` | execute_command · run_on_sessions |
| `fileWrite` | download_file · upload_file |
| `sessionControl` | reconnect_session · close_session · create_session · open_connection_dialog |
| `sessionMetadataWrite` | write_session_notes |

## 安全 · Security

- token 按进程（插件 / agent）独立签发；禁用插件 → `revokePluginToken` → 对应调用立即 401，控制权秒收。*Tokens are issued per process (plugin / agent); disabling a plugin → `revokePluginToken` → its calls immediately 401.*
- 每个 capability 服务端强制校验。*Every capability is enforced server-side.*
- 全屏 TUI（vim / htop / less）不支持经 MCP 回读 —— 见 [README](../README.md) 的说明。*Full-screen TUI apps (vim / htop / less) can't be read back over MCP — see [README](../README.md).*

## 相关 · Related

- [README · MCP 集成](../README.md#-mcp-integration) · [中文 README](../README.zh.md#-mcp-集成)
- [插件示例 · my-pet-plugin](../examples/my-pet-plugin/README.md) —— 一个「像 Claude 一样经 stdio MCP 连 LyShell」的完整参考实现。*A complete reference implementation that "connects to LyShell over stdio MCP, just like Claude".*
