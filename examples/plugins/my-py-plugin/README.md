# my-py-plugin

LyShell Python 插件模板。`onStartup` 激活时:列会话 -> 对首个连着的会话演示读输出 + 发命令。装上启用就能在主进程日志看到它干了什么,用来验证 plugin token -> HTTP 回连链路通了。

## 安装(dev 文件夹)

1. LyShell -> 设置 -> 插件 -> **添加 dev 插件**
2. 选本文件夹(`examples/plugins/my-py-plugin`)
3. 勾选 `read` + `interactiveWrite`(已在 manifest 声明)
4. 勾选 **安装即启用**
5. 看主进程日志(dev 跑 `npm run dev` 的终端):`[my-py-plugin] activating ...`

## 改哪里

- `main.py` - 业务逻辑,改 `print` / `lyshell.*` 调用即可
- `lyshell-plugin.json` - `id` 改成你的(lowercase kebab-case),`capabilities` 按需增减;长任务可加 `pythonTimeoutMs`(ms,默认 120000、上限 600000)

## 前提

- Python 插件需要系统装了 Python(LyShell 启动时检测 PATH 里的 `python.exe` 或便携版);找不到则 python 插件无法激活
- 改完代码:插件页关再开开关(或禁用->启用),host 重启即生效(dev 插件记录绝对路径,不复制源码)
- python 为 oneshot 模型:`main.py` 跑完即退出,`onStartup` = 启动跑一次(非常驻);长驻/事件驱动请用 node 运行时(见 examples/plugins/my-node-plugin)

## 可用 lyshell 方法

见 `src/main/python/engine.ts` 的 `LYSHELL_API`,或主仓库插件开发指南。
