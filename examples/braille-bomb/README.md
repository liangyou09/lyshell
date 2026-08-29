# braille-bomb

跨终端「炸弹投掷」动画 demo。两个已连接的 SSH 会话并排：左侧 pane 抛出炸弹，沿抛物线飞到右侧 pane，命中后爆闪 + 粒子迸射 + 显示 "BOOM"。

## 触发

安装并启用后，在按列表顺序的前两个「停在 shell 提示符」的已连接 SSH 会话上联动播放一遍。处于 vim/htop/跑命令状态的会话会被安全门跳过。

## 前提

- 至少两个已连接、停在 shell 提示符的 SSH 会话
- 远程主机有 `python3`（纯标准库）

## 文件

- `lyshell-plugin.json` - 清单（runtime=node, lifecycle=oneshot）
- `main.js` - 列 SSH 会话、过提示符门、base64 + heredoc 投递 render.py
- `render.py` - 炸弹抛物线 + 爆闪 + 粒子渲染
