# braille-wave（demo · 远程 SSH 版）

盲文点阵动画 demo 插件。它演示一件事：**插件经 MCP API 就能驱动【远程】SSH 终端渲染盲文 + ANSI 动画**，不需要改框架、不需要往远程落脚本文件。

插件把自带的 `render.py` 经 shell heredoc 喂给远程 `python3 -u -` 的 stdin，由远程 Python 独占终端跑 ~10s 点阵动画，然后还原终端退出。脚本不落盘远程，跑完即净。

## 效果

每个目标 SSH 终端里，60×18 的盲文单元（120×72 点）做三路正弦叠加的等离子波纹，~20fps 原地刷新，10s 后自动结束、还原终端。中途 Ctrl+C 也干净还原。

## 依赖

- 远程主机上有 **`python3`**（纯标准库，无第三方包）。
- LyShell 里至少有一个**已连接的 SSH 会话**。

## 安装

1. 左侧机柜 -> Plugins ->「+ dev」选 `examples/braille-wave/`。
2. 权限确认卡显示两项 capability：`read` / `interactiveWrite`，确认安装。
   - 不想开机自放：取消「启用即开」，要看时再启用。

## 触发与作用范围

`onCommand` 在 UI 尚未接线，触发靠启用：**安装并启用 = 放一次**；禁用再启用 = 再放。

作用范围：**所有已连接、且停在 shell 提示符的 SSH 会话**。多个 SSH 会话会**同时**各放一遍。

要缩小范围：只留你想放的 SSH 会话连接，断开其它；或在远程把不想要的会话切到 vim/htop（会被安全门跳过，见下）。

## 安全门：跳过非提示符会话

发送前对每个目标会话调 `lyshell_wait_for_prompt` 确认它停在 shell 提示符。**处于 vim/htop/正在跑命令的会话会被跳过**，避免把 heredoc 打进全屏程序里。日志会打印每个会话是 `launched` 还是 `skip`。

best-effort：若你的远程 shell 用了非 `[$#>%]` 结尾的自定义提示符，会被误跳（日志可见）。把提示符改成以 `$`/`#`/`>`/`%` 结尾即可。

## 与 MCP 全屏 TUI 限制的关系

MCP 的 `read_output`/`send_and_wait` 会把 ANSI 剥成纯文本，所以全屏 TUI 程序不适合经 MCP 回读。但本 demo **单向驱动输出、不回读**，插件写进 PTY 的字节由远程终端完整渲染原始流，`ESC[H`、`ESC[?1049h`、盲文都正常显示，因此不受该限制影响。

## 文件

- `lyshell-plugin.json` - 清单（runtime=node，capabilities=read/interactiveWrite）。
- `main.js` - 插件入口：列 SSH 会话、过提示符门、heredoc 投递 render.py。
- `render.py` - 动画脚本：盲文 + ANSI 原地重绘，独占终端 10s。
