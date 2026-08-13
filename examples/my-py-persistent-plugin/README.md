# my-py-persistent-plugin

LyShell Python 常驻插件模板，用于演示 `lifecycle: persistent`。

## 行为

- LyShell 启动时（或启用后 `restart()`）自动 spawn 一个 Python 子进程。
- 子进程长期保持，每 5 秒调用 `lyshell.list_sessions()` 打印当前会话数。
- 禁用/卸载/退出 LyShell 时，主进程会主动 kill 该 Python 进程。

## 安装

```
PluginPanel → + dev → 选择本文件夹 → 安装
```

安装后插件会显示 `persistent` 标签并自动启用（若勾选）。
