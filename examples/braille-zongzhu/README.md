# braille-zongzhu

LyShell 示例插件：在终端用 Braille 点阵播放「铁山靠」/「打篮球」动画。

## 运行方式

1. 将本目录复制到 LyShell 插件目录（本仓库中可直接在 `examples/braille-zongzhu` 选择）。
2. 在 LyShell 中启用 `braille-zongzhu` 插件。
3. 插件会在 `onStartup` 时自动在所有「停在 shell 提示符」的已连接 SSH 会话上播放动画。

## 切换模式

编辑 `main.js` 顶部的常量：

```js
const MODE = 'basketball' // 可选 'tieshankao' 或 'both'
```

- `tieshankao`：侧身顶肩，重心左右切换（默认）。
- `basketball`：正面运球 / 举球。
- `both`：两种动作各放 6 秒自动切换。

## 实现要点

- 与 `braille-punch` / `braille-wave` 同构：`render.py` 经 heredoc 进入远程 `python3 -u -`，远程不落盘。
- 源码刻意零反斜杠：ANSI ESC / 换行均用 `bytes([N])` 拼接，避免 `send_input` 的转义处理器干扰。
- 自适应终端尺寸：每帧查询 `os.get_terminal_size(1)`，窗口拖动缩放逐帧跟上。
