# my-py-plugin

LyShell Python **oneshot** 插件模板。manifest 声明 `lifecycle: oneshot`,**不会随 LyShell 启动自动运行**--在插件页点「运行」按钮按需触发一次:`main.py` 列会话 -> 对首个连着的会话演示读输出 + 发命令,跑完即退出。用来验证 plugin token -> HTTP 回连链路通了。

## 安装(dev 文件夹)

1. LyShell -> 设置 -> 插件 -> **添加 dev 插件**
2. 选本文件夹(`examples/my-py-plugin`)
3. 勾选 `read` + `interactiveWrite`(已在 manifest 声明),安装即注册(oneshot 无「安装即启用」开关)
4. 点插件卡片上的「运行」按钮,查看 `[my-py-plugin] ...` 日志

## 改哪里

- `main.py` - 业务逻辑,改 `print` / `lyshell.*` 调用即可
- `lyshell-plugin.json` - `id` 改成你的(lowercase kebab-case),`capabilities` 按需增减;长任务可加 `pythonTimeoutMs`(ms,默认 120000、上限 600000)

## 前提

- Python 插件需要系统装了 Python(LyShell 启动时检测 PATH 里的 `python.exe` 或便携版);找不到则 python 插件无法激活
- 改完代码:直接再次点「运行」即可(每次运行从磁盘重读 `main.py`,无需重启 host;dev 插件记录绝对路径,不复制源码)
- oneshot vs persistent:`lifecycle: oneshot`(本模板)手动触发、跑完即退,`onStartup` 不会自动跑;需要长驻/事件驱动改成 `"lifecycle": "persistent"`(见 `examples/my-py-persistent-plugin`),或用 node 运行时(见 `examples/my-node-plugin`)

## 可用 lyshell 方法

| capability | 工具 |
|---|---|
| `read` | list_sessions · read_output · read_session_notes · list_files · read_file · stat_file · wait_for_prompt · tail_until |
| `interactiveWrite` | send_input · send_and_wait |
| `execute` / `localExecute` | execute_command · run_on_sessions |
| `fileWrite` | download_file · upload_file |
| `sessionControl` | reconnect_session · close_session · create_session · open_connection_dialog |
| `sessionMetadataWrite` | write_session_notes |

`tools/list` 会返回全部工具名 + inputSchema；调用未声明 capability 的工具会被服务端 403。
