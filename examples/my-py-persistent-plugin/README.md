# my-py-persistent-plugin

LyShell Python **persistent** 插件模板。manifest 声明 `lifecycle: persistent`，激活时 host 会注入全局 `lyshell` 对象，本进程长期保持——用来演示 python runtime 的**长驻**能力（对比 `oneshot` 手动触发、跑完即退）。

## 安装（dev 文件夹）

1. LyShell -> 设置 -> 插件 -> **添加 dev 插件**
2. 选本文件夹（`examples/my-py-persistent-plugin`）
3. 勾选 `read`（已在 manifest 声明），勾 **安装即启用** -> 安装
4. 查看插件日志：`[my-py-persistent-plugin] activating ...`，之后每 5s 一条 session count

## 改哪里

- `main.py` - 业务逻辑；把 `while True` 循环里的示例改成你的巡检 / 事件逻辑即可
- `lyshell-plugin.json` - `id` 改成你的（lowercase kebab-case），`capabilities` 按需增减（发命令加 `interactiveWrite`，跑 exec 加 `execute`/`localExecute`，传文件加 `fileWrite`）

## 前提

- 系统装了 Python（LyShell 启动时检测 PATH 里的 `python.exe` 或便携版），找不到则 python 插件无法激活
- persistent 插件仅支持 `onStartup` / `*` 激活一次；禁用 / 卸载 / 退出 LyShell 时主进程会主动 kill 该 Python 进程
- oneshot vs persistent：`lifecycle: oneshot`（见 `examples/my-py-plugin`）手动触发、跑完即退；长驻用本模板的 `"lifecycle": "persistent"`，或用 node 运行时（见 `examples/my-node-plugin`，多插件共享一个 host 进程）

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
