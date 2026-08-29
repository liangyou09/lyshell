# braille-rhythm

跨终端「音律跳动」动画 demo。N 个已连接的 SSH 会话各画一片竖切片，合成一个横跨所有终端的频谱条跳动画面。

## 触发

安装并启用后，在所有「停在 shell 提示符」的已连接 SSH 会话上联动播放一遍。处于 vim/htop/跑命令状态的会话会被安全门跳过。各 pane 等宽时切片对齐最完整（不等宽会错位，但跳动仍能看）。

## 前提

- 至少一个已连接、停在 shell 提示符的 SSH 会话
- 远程主机有 `python3`（纯标准库）

## 文件

- `lyshell-plugin.json` - 清单（runtime=node, lifecycle=oneshot）
- `main.js` - 列 SSH 会话、过提示符门、base64 + heredoc 投递 render.py
- `render.py` - 频谱条跳动渲染
