# my-node-plugin

LyShell **Node** 插件 demo。`onStartup` 激活时巡检会话状态,并起 30s 定时器持续巡检 -- 展示 node runtime 的**长驻**能力(python 是 oneshot 跑完即退,做不到定时)。

## 和 python 插件的差异

| | node | python |
|---|---|---|
| 进程 | 所有 node 插件**共享一个常驻 host** | 每插件**独立 oneshot**进程,跑完即退 |
| 适合 | 长驻 / 定时 / 事件驱动 | 一次性脚本 / 自动化 |
| 入口 | `main.js` **CJS**(`module.exports`) | `main.py`,host 注入全局 `lyshell` |
| API | `api.call('lyshell_list_sessions', {...})` | `lyshell.list_sessions(...)` |
| 日志 | `console.error`(stderr,host-mgr 捕获) | `print`(stdout) |
| token | 经 IPC 下发(共享进程,防互窃) | env 注入(单进程,安全) |

## 安装(dev 文件夹)

1. LyShell -> 设置 -> 插件 -> **添加 dev 插件**
2. 选本文件夹(`examples/plugins/my-node-plugin`)
3. 勾 `read`(已在 manifest 声明)
4. 勾 **安装即启用**
5. 看日志:dev 跑 `npm run dev` 的终端,`[my-node-plugin] activated ...`,之后每 30s 一条 snapshot

## 改哪里

- `main.js`:`snapshot()` 改业务逻辑;想取消定时就删 `setInterval` 那行
- `lyshell-plugin.json`:`id` 改成你的(lowercase kebab-case),`capabilities` 按需增减(发命令加 `interactiveWrite`,跑 exec 加 `execute`/`localExecute`,传文件加 `fileWrite`)

## 可调工具(lyshell_ 前缀,按 capability)

| capability | 工具 |
|---|---|
| `read` | list_sessions · read_output · read_session_notes · list_files · read_file · stat_file · wait_for_prompt · tail_until |
| `interactiveWrite` | send_input · send_and_wait |
| `execute` / `localExecute` | execute_command · run_on_sessions |
| `fileWrite` | download_file · upload_file |
| `sessionControl` | reconnect · close · create_session · open_connection_dialog |
| `sessionMetadataWrite` | write_session_notes |

## 重载

改完代码:插件页关再开开关(禁用->启用)触发 host restart 即生效。dev 插件记录绝对路径,不复制源码。
