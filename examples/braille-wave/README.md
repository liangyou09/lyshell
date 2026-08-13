# braille-wave（demo · 远程 SSH 版）

盲文点阵动画 demo 插件。验证一件事:**插件经现有 MCP API 就能驱动【远程】SSH 终端渲染盲文 + ANSI 动画**,不需要改框架、不需要往远程落脚本文件。

插件本身不画动画。它把自带的 `render.py` 内容**经 shell heredoc 管进远程 `python3 -u -` 的 stdin**,由远程 Python 独占终端(进备用屏、藏光标、`\x1b[H` 原地重绘)跑 ~10s 点阵动画,然后还原终端退出。脚本不落盘远程,跑完即净。

## 效果

每个目标 SSH 终端里,60×18 的盲文单元(120×72 点)做三路正弦叠加的等离子波纹,~20fps 原地刷新,10s 后自动结束、还原终端。中途 Ctrl+C 也干净还原(不留在备用屏)。

## 依赖

- 远程主机上有 **`python3`**(纯标准库,无第三方包)。
- LyShell 里至少有一个**已连接的 SSH 会话**。

## 安装

1. 左侧机柜 -> Plugins ->「+ dev」选 `examples/braille-wave/`。
2. 权限确认卡显示两项 capability:`read` / `interactiveWrite`,确认安装。
   - 不想开机自放:取消「启用即开」,要看时再启用。

## 触发与作用范围

`onCommand` 在 UI 尚未接线,触发靠启用:**安装并启用 = 放一次**;禁用再启用 = 再放。

作用范围:**所有已连接、且停在 shell 提示符的 SSH 会话**。多个 SSH 会话会**同时**各放一遍(这是多终端联动的第一步;目前每个终端放完整画面,尚未切片)。

要缩小范围:
- 只留你想放的 SSH 会话连接,断开其它。
- 或在远程把不想要的会话切到 vim/htop(会被安全门跳过,见下)。

## 安全门:跳过非提示符会话

发送前对每个目标会话调 `lyshell_wait_for_prompt` 确认它停在 shell 提示符。**处于 vim/htop/正在跑命令的会话会被跳过**,避免把 heredoc 打进全屏程序里。日志会打印每个会话是 `launched` 还是 `skip`。

best-effort:若你的远程 shell 用了非 `[$#>%]` 结尾的自定义提示符,会被误跳(日志可见)。把提示符改成以 `$`/`#`/`>`/`%` 结尾即可。

## 工作原理

```
activate()
  ├─ lyshell_list_sessions(terminalStatus=true)  过滤 type=ssh && connected
  ├─ readScript()  读 render.py,归一化行尾
  ├─ buildHeredoc(): "python3 -u - <<'LYSHELL_BRAILLE'\n<render.py 全文>\nLYSHELL_BRAILLE"
  └─ 对每个 ssh 会话(并发):
       ├─ lyshell_wait_for_prompt   安全门:确认停在提示符,否则 skip
       └─ lyshell_send_input(heredoc)   autoNewline 自动补末尾 \n 提交
             ↓ 远程 shell 解析 heredoc,把 render.py 喂给 python3 -u - 的 stdin
       render.py(远程终端里独占运行)
         ├─ ESC[?1049h  进备用屏(命令回显/提示符藏进主缓冲区)
         ├─ ESC[?25l    藏光标
         ├─ loop: build_frame(t) -> ESC[H 归位 -> 写 UTF-8 盲文字节 -> sleep
         └─ finally: ESC[?25h ESC[?1049l  还原光标 + 退出备用屏
```

### 两个关键设计点

1. **render.py 源码不含任何反斜杠**。`send_input` 会把文本过 `processInputEscapeSequences`(`shared/escape-sequences.ts`),字面 `\n`/`\t`/`\xHH` 会被转成控制字节--这会破坏 heredoc 里的 Python 源码(比如 `b'\n'` 的 `\n` 被吃成真换行,源码断行报错)。所以 ESC 与换行一律用 `bytes([27])`/`bytes([10])` 拼,源码零反斜杠,转义处理器对本体就是 no-op,heredoc 体逐字到远程。
2. **heredoc 定界符加引号** `<<'LYSHELL_BRAILLE'`:禁变量/反引量展开,render.py 里的 `$`、引号、反斜杠(本就没有)都逐字传入,无需转义。

### 关于「MCP 不支持全屏 TUI」那条限制

那条限制**只作用在回读路径**--`read_output`/`send_and_wait` 会把 ANSI 剥成纯文本。但插件写进 PTY 的字节,远程的 xterm.js 完整渲染原始流,`ESC[H`、`ESC[?1049h`、盲文都正常显示。本 demo **单向驱动输出、不回读**,所以不受影响。安全门用的 `wait_for_prompt` 只匹配提示符结尾,不依赖完整 ANSI 解析。

## 扩展:多终端切片矩阵

目前每个终端放完整动画。要做成「多个终端拼成一张大图」:

1. 用户在 UI 手动分屏排出 N 个 SSH 终端(插件 API 暂无分屏布局能力)。
2. `render.py` 的 `build_frame(t)` 改成按「切片号 / 总切片数」取全局网格的子矩形(纯函数改动)。
3. `main.js` 给每个会话的 heredoc 注入切片参数--但 heredoc 体不能含反斜杠,参数走 `python3 -u - 切片号 总数` 的 argv(heredoc 仍只管脚本本体,argv 在命令行上,不受转义影响)。
4. 各终端按时钟本地算自己那片,高 FPS、无需每帧 HTTP 往返;结束时各发 `\x03`。

## 文件

- `lyshell-plugin.json` - 清单(runtime=node,capabilities=read/interactiveWrite)。
- `main.js` - 插件入口:列 SSH 会话、过提示符门、heredoc 投递 render.py。
- `render.py` - 动画脚本:零反斜杠源码,盲文 + ANSI 原地重绘,独占终端 10s。
