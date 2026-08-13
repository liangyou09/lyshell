# LyShell 插件示例

一组最小可跑的插件 demo，演示两种 runtime（Python / Node.js）的典型用法。

### 入门模板

| demo | runtime | 生命周期 | 看点 |
|---|---|---|---|
| [my-py-plugin](./my-py-plugin) | python | oneshot | 一次性脚本：列会话 + 对首个连着会话演示读输出 / 发命令 |
| [my-py-persistent-plugin](./my-py-persistent-plugin) | python | persistent | Python 长驻：每 5s 巡检会话数 |
| [my-node-plugin](./my-node-plugin) | node | persistent | Node 常驻：巡检 + 30s 定时器（共享 host） |
| [my-pet-plugin](./my-pet-plugin) | node | persistent | 路线2：插件只当启动器，桌宠像 Claude 一样经 stdio MCP 连 LyShell |

### 多终端盲文动画（terminal art）

这些 demo 通过 heredoc 把 `render.py` 投递到已连接的 SSH 会话，在远端终端放盲文点阵动画。

| demo | 看点 |
|---|---|
| [braille-wave](./braille-wave) | 盲文波浪动画 |
| [braille-punch](./braille-punch) | 第一人称 3D 出拳（透视 + 屏震 + 粒子） |
| [braille-bomb](./braille-bomb) | 多终端盲文爆炸 |
| [braille-rhythm](./braille-rhythm) | 多终端盲文节奏 |
| [braille-wall](./braille-wall) | 多终端盲文墙 |
| [braille-zongzhu](./braille-zongzhu) | 盲文"宗主"（铁山靠 / 打篮球） |

## 安装

这些 demo 是文件夹形式，用 **dev 插件**方式安装；也可以打包成 `.lyshell-plugin` zip 后走 ZIP/URL 安装。

**dev 文件夹安装：**

1. 启动 LyShell 应用
2. 设置 → 插件 → **添加 dev 插件** → 选对应 demo 文件夹
3. 勾选 manifest 声明的 capability → 勾 **安装即启用** → 安装
4. 查看插件日志（`[my-py-plugin]` / `[my-node-plugin]` 等前缀）

**ZIP 安装**：插件页 → 从 ZIP 导入 → 选 `.lyshell-plugin` / `.zip` 文件。
**URL 安装**：插件页 → 从 URL 安装 → 填入 zip 下载地址。

带 README 的 demo 见各自目录内的 README。

## 当前支持范围

- ✅ `onStartup` / `*` 激活、全部 19 个 `lyshell_*` 工具（受 capability 限制）、dev 文件夹 / ZIP / URL 安装、启用 / 禁用 / 卸载
- ⏳ `onCommand` / `onConnectionType` 激活事件源未接通 — 现在用 `onStartup`
- ⏳ `contributes` 声明式贡献 UI 未消费（commands 不进命令面板）
- ⏳ node 插件在打包版（release）中尚未充分验证 — dev 模式可跑
