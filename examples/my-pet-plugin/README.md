# my-pet-plugin

桌宠 agent 示例:**插件只当启动器,桌宠作为独立 MCP 客户端像 Claude 一样连 LyShell**。

## 工作方式

```
插件栏启用 ─▶ plugin host ─▶ api.spawnControlled(桌宠 exe)
                                │ host 内部注入连接包到桌宠 env(插件代码看不到 token):
                                │   LYSHELL_MCP_PORT / LYSHELL_MCP_TOKEN(本插件 token)
                                │   LYSHELL_MCP_SERVER_SCRIPT / LYSHELL_ELECTRON_EXE
                                ▼
                              桌宠(Electron GUI + agent)
                                │ spawn mcpServer.js(MCP SDK StdioClientTransport;
                                │   子 env 加 ELECTRON_RUN_AS_NODE=1,继承 port+token)
                                ▼
                              LyShell HTTP API(持本插件 capability,动态 tools/list)
```

- `main.js`(host 入口):`onStartup` 用 `api.spawnControlled` 拉起桌宠;`deactivate` kill。
- `pet/main.ts`(参考):桌宠 Electron 入口,读连接包 -> spawn mcpServer.js -> `listTools()` / `callTool()`。

## 与 my-node-plugin 的区别

| | my-node-plugin | my-pet-plugin |
|---|---|---|
| 桌宠怎么连 LyShell | 插件自己 `api.call`(经 host) | 桌宠 spawn mcpServer.js,像 Claude 走 stdio MCP |
| 动态工具发现 | 无(写死工具名) | ✓ `tools/list` 自动跟上 LyShell 工具变化 |
| token 在哪 | host 内存(不出 host) | 桌宠 env(经 spawnControlled 注入) |
| 适合 | host 内轮询/定时 | 独立 GUI agent |

## 安装

1. 把 `pet/main.ts` 编译成 `pet/main.js`(桌宠自己的构建;需 `electron` + `@modelcontextprotocol/sdk` 依赖)。或把 `main.js` 里的 `petExe` 改成你自己的桌宠入口。
2. 启动 LyShell 应用
3. 设置 -> 插件 -> 添加 dev 插件 -> 选本文件夹
4. 勾 `read` + `interactiveWrite`(manifest 已声明)
5. 勾「安装即启用」
6. 桌宠窗口起来;查看 `[my-pet-plugin]` / `[pet]` 日志

## 改哪里

- `main.js` 的 `petExe` 改成你自己的桌宠入口。
- `pet/main.ts` 的 `agentLoop` 改你的 agent 逻辑(LLM 调用 + 工具编排)。
- `lyshell-plugin.json` 的 `capabilities` 按需增减(发命令要 `interactiveWrite`,跑 exec 要 `execute`/`localExecute`,传文件要 `fileWrite`)。

## 安全模型

- 桌宠用的是**本插件 token**(经 host `spawnControlled` 注入,插件代码看不到)。
- 禁用插件 -> `revokePluginToken` -> 桌宠的 mcpServer.js 调用即 401,控制权秒收。
- **独立启动桌宠(不经过插件)-> env 没连接包 -> discoverLyshell 走端口文件 -> `allowExternalMcpClients` 关(默认)时端口文件 token 为 null -> 连不上。即「只从插件启动才有控制权」。**
- 代价:插件 token 在桌宠 env 里,同用户进程理论上能读(直到插件禁用失效)。

## 前提

- `allowExternalMcpClients` 保持**关**(默认)。开了的话独立启动的桌宠也能经全局 token 连上,「只从插件启动」不成立。
- 桌宠依赖 `@modelcontextprotocol/sdk`(MCP 客户端)+ `electron`。
- 桌宠与 LyShell 共用 electron.exe,`pet/main.ts` 里设了独立 `userData` 避开单实例锁冲突。

## 可调工具(lyshell_ 前缀,按 capability)

| capability | 工具 |
|---|---|
| `read` | list_sessions · read_output · read_session_notes · list_files · read_file · stat_file · wait_for_prompt · tail_until |
| `interactiveWrite` | send_input · send_and_wait |
| `execute` / `localExecute` | execute_command · run_on_sessions |
| `fileWrite` | download_file · upload_file |
| `sessionControl` | reconnect_session · close_session · create_session · open_connection_dialog |
| `sessionMetadataWrite` | write_session_notes |

`tools/list` 会返回全部工具名 + inputSchema;`tools/call` 调没声明 capability 的工具会被服务端 403。
