<p align="center">
  <img src="https://img.shields.io/badge/LyShell-v1.0.2-0078D4?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/MCP-ready-FF6B6B?style=flat-square" alt="mcp">
</p>

# 💻 LyShell

> 🤖 Windows 智能终端 — SSH / Telnet / 串口 / 本地 PTY 四合一，内置 SFTP 文件管理、AI Agent 启动栏、Python 脚本引擎、插件系统及 MCP API，面向运维工程师与开发者的终端工作台。

**简体中文** | [English](README.md)

[📖 使用指南](#-使用指南) · [📥 安装](#-安装) · [✨ 功能特性](#-功能特性) · [🔌 连接类型](#-连接类型) · [🖥️ 终端](#-终端) · [📂 文件管理](#-文件管理) · [🤖 AI Agent](#-ai-agent)<br>[🧩 插件](#-插件系统) · [🐍 Python](#-python-脚本) · [🔗 MCP](#-mcp-集成) · [🎨 主题](#-主题) · [⌨️ 快捷键](#-快捷键) · [❓ FAQ](#-常见问题)

---

<p align="center">
  <img src="docs/assets/screenshot-main.jpg" alt="LyShell 主界面" width="90%">
</p>

---

## 📖 使用指南

### 界面布局

```
┌──────────────────────────────────────────────────────────┐
│  标题栏      │  标签页 (会话标签 × N)            │ ⚙ — ✕ │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│  活动      │                                             │
│  导航栏    │          终端 / 分屏区域                    │
│  (侧边栏)  │                                             │
│            │                                             │
│  ┌───────┐ │                                             │
│  │ 会话  │ │                                             │
│  │ 列表  │ │   🔍 搜索                                   │
│  │       │ │                                             │
│  │ sess1 │ │                                             │
│  │ sess2 │ │                                             │
│  │  ...  │ │                                             │
│  └───────┘ │                                             │
│  ┌───────┐ │                                             │
│  │ Agent │ │                                             │
│  │ 快速  │ │                                             │
│  │ 启动  │ │                                             │
│  └───────┘ │                                             │
│  ┌───────┐ │                                             │
│  │ 文件  │ │                                             │
│  │ 面板  │ │                                             │
│  └───────┘ │                                             │
├────────────┴─────────────────────────────────────────────┤
│  快捷命令栏        │  列×行      │  状态信息             │
└──────────────────────────────────────────────────────────┘
```

| 区域 | 功能 |
|------|------|
| **活动导航栏** | 切换会话列表、Agent 启动栏、文件管理器、插件管理 |
| **会话列表** | 点击连接，右键菜单，悬停操作（✏️编辑 📋复制 📌置顶 🗑️删除） |
| **Agent 快速启动** | 一键启动 Claude Code、Aider、Copilot CLI 及自定义 Agent |
| **文件面板** | SSH 远程文件浏览 — 拖拽上传、双击下载、右键操作 |
| **终端区域** | 主终端画布 — 分屏、多标签、拖拽拆分、终端内搜索 |
| **快捷命令栏** | 底部可配置快捷键 — 点击执行，`Ctrl+F1–F12` 触发 |
| **状态栏** | 列×行（点击清屏）、回滚行数（单击滚回底部 / 双击清空 scrollback）、连接状态、编码指示 |
| **标题栏** | ⚙ 设置面板，📊 MCP 审计面板，浮窗切换 |

### 首次使用

#### 1️⃣ 创建第一个 SSH 会话

1. 点击会话列表顶部的 **+** 按钮创建新连接
2. 选择 **SSH** 连接类型，填写参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 名称 | 便于识别的标签，如"生产环境 Web" | - |
| 主机 | 服务器 IP 或域名 | - |
| 端口 | SSH 端口 | `22` |
| 用户名 | 登录用户名 | - |
| 密码 / 私钥 | 认证方式 | - |
| Shell 进入命令 | 登录后逐行执行的命令序列 | - |
| Shell 进入等待 | 每条命令间的等待（毫秒） | `1000` |
| Keepalive 间隔 | 心跳包间隔（秒） | - |
| 连接超时 | 连接就绪超时（毫秒） | - |
| 编码 | 终端字符集 | UTF-8 |

3. 点击 **连接**，终端标签指示灯变为 🟢 绿色

> 💡 **网络设备登录**：需先输入 `shell`、`enable` 才能进入 CLI 的交换机/路由器，在 Shell 进入命令中逐行写入，LyShell 会自动按序发送。

#### 2️⃣ 配置启动命令

编辑会话，在 **启动命令** 文本框中每行一条。连接后自动执行，适用于切换到工作目录、加载环境变量、网络设备自动提权等场景。

#### 3️⃣ 随时快速连接

`Ctrl+Alt+F` 呼出浮窗 → 搜索 → 回车即连，任何应用中有效。

<p align="center">
  <img src="docs/assets/screenshot-float-window.jpg" alt="浮窗快速连接" width="70%">
</p>

### 日常工作流

#### 🖥️ 多机监控（分屏）

<p align="center">
  <img src="docs/assets/screenshot-split-panes.jpg" alt="分屏多机监控" width="90%">
</p>

1. 点击会话打开第一个面板
2. `Ctrl+Shift+V` 垂直分屏
3. 点击另一个会话在新面板中打开
4. `Ctrl+Shift+H` 水平分屏
5. 拖拽分隔线调整比例

布局自动保存，重启后恢复。

#### ⌨️ 快捷命令看日志

1. 右键快捷命令栏 → **编辑分组**
2. 为当前分组添加命令：`tail -f /var/log/syslog`、`tail -f /var/log/nginx/access.log`……
3. 切换服务器标签页，点击命令或按 `Ctrl+F1`/`Ctrl+F2`/`Ctrl+F3` 触发

为不同服务器角色创建独立分组（"Web 层"、"数据库层"……），每组最多 12 条命令，共 5 组。

<p align="center">
  <img src="docs/assets/screenshot-quick-commands.jpg" alt="快捷命令栏" width="90%">
</p>

#### 📂 文件传输

- **上传**：桌面拖拽到文件面板
- **下载**：双击远程文件，或右键 → 下载
- **进度**：状态栏实时速度与预估时间，下载完成自动 MD5 校验
- **安全**：SFTP 不可用时走 TCP-over-SSH 隧道，`AllowTcpForwarding` 禁用不会回退明文

#### 🤖 AI Agent 即用

侧边栏点击 Claude Code / Aider / Copilot CLI → 新标签页在当前目录启动 → 用完关闭，不残留于会话列表。

#### 🐍 Python 自动化

```python
sessions = LyShell.list_sessions(tag="prod-env")
for s in sessions:
    LyShell.connect(s.id)
    LyShell.wait_for("$")
    LyShell.execute("uptime")
    LyShell.execute("df -h /")
```

从活动导航栏打开 Python 面板 → 粘贴/加载 → 执行，自动驱动终端操作。

### 会话管理

| 操作 | 方法 |
|------|------|
| 📌 置顶 | 悬停卡片 → 点击 📌 |
| 📋 克隆会话 | 双击标签左半侧 |
| ⚡ 克隆通道（免重认证） | 双击标签右半侧（仅 SSH） |
| 🔍 搜索 | 搜索框输入名称/主机/标签 |
| ✏️ 编辑 | 右键 → ✏️，或悬停点击 ✏️ |
| 🗑️ 删除 | 悬停 → 点击 🗑️ |

### 终端技巧

- 选中文本 → 自动复制 | 右键 → 粘贴 | 鼠标中键 → 搜索栏
- `Ctrl+F` → 终端内搜索（正则、区分大小写、跨标签搜索）
- 中文乱码 → 编辑会话，UTF-8 / GBK / GB2312 切换
- **清屏** — 点击右下角状态栏的「列 × 行」指示（发送 `Ctrl+L`，保留回滚）
- **清回滚** — 点击右下角状态栏的缓冲行数（单击滚回底部，双击清空回滚）

---

## 📥 安装

从 [Releases](https://github.com/liangyou09/lyshell_release/releases) 下载最新版本。**免安装** — 便携版下载即用，无需安装。

| 平台 | 格式 | 架构 |
|------|------|------|
| 🪟 Windows | 便携版 (.exe) — 下载即用 | x64 |

**系统要求**：Windows 10 或 Windows 11，64 位（x64）。

> 🚧 目前**仅提供 Windows 版本**，macOS / Linux 暂未发布。

---

## ✨ 功能特性

| 类别 | 说明 |
|------|------|
| 🔌 **多协议** | SSH、Telnet、串口、本地 PTY — 一个窗口全搞定 |
| 🪟 **分屏终端** | 水平/垂直分屏，拖拽拆分、标签交换，布局自动持久化 |
| ⌨️ **快捷命令** | 分组管理，右键编辑，`Ctrl+F1–F12` 一键触发 |
| 📂 **文件管理** | SFTP/SSH 浏览，拖拽上传，双击下载，MD5 校验 |
| 🤖 **AI Agent** | 与 Agent 无关的干净终端 — Claude Code、Aider、Copilot CLI 或任意自定义 CLI 都能跑 |
| 🧩 **插件系统** | 权限门控，支持 Python + Node.js 插件，开发/ZIP/URL 安装 |
| 🐍 **Python 引擎** | 内置执行引擎，`LyShell` API 驱动终端自动化 |
| 🔗 **MCP API** | 标准 MCP 服务端，审计日志 + 会话级授权 |
| 🪟 **浮窗** | `Ctrl+Alt+F` 全局热键，可折叠悬停展开 |
| 🌐 **国际化** | 内置中英双语，新增语言只需 JSON |
| 🎨 **主题** | 5 预设 + 自定义颜色，即时切换无需重启 |
| 🔒 **数据安全** | AES-256-CBC 加密导出 |
| 💾 **窗口记忆** | 大小、位置、分屏布局重启恢复 |

---

## 🔌 连接类型

### SSH

支持密码/私钥认证、Keepalive、Shell 进入命令（登录后逐条执行）、可配超时。

**会话克隆**：双击标签左半侧 → 克隆会话（新连接）；双击右半侧 → 克隆通道（共享连接，免重认证）

### Telnet

原始 TCP Socket + 完整 Telnet 协议（IAC 协商）。

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 主机 | 目标地址 | - |
| 端口 | Telnet 端口 | `23` |
| 超时 | 连接超时（毫秒） | - |

### 串口

自动检测系统可用 COM 端口。

| 参数 | 可选值 | 默认值 |
|------|--------|--------|
| 串口路径 | 下拉选择 | - |
| 波特率 | 9600 ~ 921600 | `115200` |
| 数据位 | 5 / 6 / 7 / **8** | `8` |
| 停止位 | **1** / 2 | `1` |
| 校验位 | **none** / even / odd / mark / space | `none` |

### 本地终端

应用内打开 cmd.exe / PowerShell，可配工作目录和环境变量。

---

## 🖥️ 终端

GPU 加速渲染，完整 ANSI 序列 + 256 色。

### 功能速览

| 功能 | 操作 |
|------|------|
| 🔍 搜索 | `Ctrl+F` 或鼠标中键，支持正则/区分大小写/跨标签搜索，搜索栏可拖拽 |
| 📜 回滚 | 1,000 ~ 100,000 行可配 |
| 🔤 编码 | UTF-8 / GBK / GB2312，每会话独立 |
| 🚀 启动命令 | 连接后自动逐条执行 |
| 📋 复制粘贴 | 选中即复制，右键粘贴 |
| ⌨️ 输入法 | CJK 候选框定位修正 |
| ✏️ 光标闪烁 | 默认关闭（性能优先），可开启 |

### 标签状态

🟢 已连接 | 🔴 连接错误 | ⚪ 未连接 | 🔵 非活动标签有新输出

### 终端设置

通过标题栏 ⚙ 进入，已拆分为 **终端** / **MCP** 两个页签：

| 设置 | 范围 | 默认值 |
|------|------|--------|
| 回滚行数 | 1,000 ~ 100,000 | 10,000 |
| 字体大小 | 8 ~ 32 | 16 |
| 光标闪烁 | 开/关 | 关 |

---

## 📂 文件管理

侧边栏嵌入，仅 SSH 可用。独立 SSH 连接，不阻塞终端。

<p align="center">
  <img src="docs/assets/screenshot-file-manager.jpg" alt="文件管理器" width="90%">
</p>

| 操作 | 说明 |
|------|------|
| 📤 上传 | 桌面拖拽到文件面板 |
| 📥 下载 | 双击远程文件 / 右键下载 |
| 📋 右键菜单 | 下载、删除、重命名、新建目录 |
| 🔄 传输 | Worker 线程池并发，实时速度 + 预估时间 |
| ✅ 校验 | 下载完成自动 MD5 |
| 📜 历史 | 记录含文件名、大小、路径、MD5，支持重新下载 |

下载目录设置 → 默认 `~/Downloads/LyShell/`，可选"自动创建服务器子目录"归档至 `下载目录/服务器名/`。

---

## 🤖 AI Agent

LyShell 是一个**干净的、与 Agent 无关的终端** — 不绑定任何特定 AI 工具。启动你正在用的任意 CLI Agent，它就像普通会话一样运行在标准终端里：回滚、分屏、输入法支持一视同仁。

<p align="center">
  <img src="docs/assets/screenshot-agents.jpg" alt="AI Agent 启动栏" width="90%">
</p>

### 预置 Agent

| Agent | 命令 |
|-------|------|
| 🧠 Claude Code | `claude` |
| 🤝 Aider | `aider` |
| 🐙 Copilot CLI | `gh copilot` |

### 自定义 Agent

任意 CLI 工具都能注册为 Agent — 启动栏只是执行它的 shell 命令：

| 字段 | 说明 |
|------|------|
| 名称 | 显示名称 |
| 命令 | Shell 启动命令 |
| 图标 | Emoji 选择器 / 品牌图标（按 command 自动匹配） |
| 工作目录 | 原生目录选择器，ESC 关闭 |
| 环境变量 | 启动时注入 |

Agent 会话为**瞬态** — 关闭标签即消失，不残留。

---

## 🧩 插件系统

权限门控的插件宿主。每个插件以独立的授权范围运行。

<p align="center">
  <img src="docs/assets/screenshot-plugins.jpg" alt="插件管理" width="90%">
</p>

插件用两种运行时编写：

| 运行时 | 入口 | 生命周期 | 适用场景 |
|--------|------|----------|----------|
| 🐍 Python | `main.py` | 一次性 / 常驻 | 一次性自动化脚本 |
| 🟢 Node.js | `main.js` | 常驻（共享宿主） | 长驻、定时、事件驱动 |

**安装方式**：本地开发目录 · ZIP 导入 · URL 远程安装

**安全模型**：每个插件独立授权，每次请求都按细粒度权限（读取 / 写入 / 执行 / 文件 / 会话控制）服务端校验。多层防护：路径安全、破坏性命令确认、共享终端锁定。

插件可列表/读取/交互会话、执行命令、访问文件管理器、启动受控进程。

> ⚠️ **当前范围** — 插件目前按启动事件（`onStartup`）激活；按命令/连接类型事件激活、以及声明式 UI 贡献尚未接通。

📦 **开箱即用的示例** — 见 [`examples/`](examples/)，含最小可跑的 Python 与 Node.js 插件 demo。

---

## 🐍 Python 脚本

内置 Python 执行引擎，提供 `LyShell` API 驱动终端自动化。

```python
session = LyShell.get_current_session()
LyShell.execute("ls -la")
LyShell.send("hello\n")
LyShell.wait_for("prompt$")
```

| 环境变量 | 说明 |
|----------|------|
| `LYSHELL_SESSION_ID` | 当前会话 ID |
| `LYSHELL_SESSION_TYPE` | ssh / telnet / serial / local |
| `LYSHELL_HOST` | 连接主机 |
| `LYSHELL_PORT` | 连接端口 |

Python 路径自动检测系统 PATH，可在设置中配置自定义解释器。

> 💡 除内置 Python 面板外，[插件系统](#-插件系统) 还支持 **Node.js** 插件 — 长驻、定时任务的首选。

---

## 🔗 MCP 集成

LyShell 可以作为 MCP 服务端，让 Claude Code 等外部 AI 客户端通过 MCP 协议操控终端。

### 工具列表

| 工具 | 能力 | 说明 |
|------|------|------|
| `list_sessions` | `read` | 列出侧边栏会话 |
| `send_input` | `interactiveWrite` | 发送文本，autoNewline 自动补换行 |
| `send_and_wait` | `interactiveWrite` | 发送并捕获响应，自动剥离回显和 ANSI |
| `execute_command` | `execute` | 独立 exec 通道执行（仅 SSH） |
| `run_on_sessions` | `execute` | 广播命令，最多 50 会话并发 10 |
| `read_output` | `read` | 读取 N 行终端输出 |
| `upload_file` / `download_file` | `fileWrite` | SFTP 文件传输 |
| `read_file` / `stat_file` / `list_files` | `read` | 远程文件检查，支持递归和通配符 |
| `create_session` | `sessionControl` | 创建/复用会话，同 target 自动去重 |
| `reconnect_session` | `sessionControl` | 重连断开连接 |
| `close_session` | `sessionControl` | 断开连接但不删除已保存会话 |
| `open_connection_dialog` | `sessionControl` | 打开新建连接对话框，供用户手动填写 |
| `read_session_notes` | `read` | 读取会话摘要、说明、标签 |
| `write_session_notes` | `sessionMetadataWrite` | 更新摘要、说明、标签 |
| `wait_for_prompt` | `read` | 等待 Shell 提示符或正则 |
| `tail_until` | `read` | 轮询直到匹配 |

### 安全机制

- 🔑 **会话级授权** — 每个终端拥有独立权限范围
- 🚪 **能力门控** — 每端点服务端强制执行
- 🛡️ **破坏性命令确认** — 扫描 `rm -rf`、`dd if=` 等模式
- 🔒 **共享 PTY 锁定** — MCP 与人工输入不冲突
- 📊 **审计面板** — 标题栏入口，日历选择器 + 过滤 + 分页

> ⚠️ 全屏 TUI（vim、htop、less）不支持 MCP 操作 — ANSI 剥离后交替屏幕为乱码，请用 LyShell 界面原生终端。

<p align="center">
  <img src="docs/assets/screenshot-mcp-audit.jpg" alt="MCP 审计面板" width="90%">
</p>

---

## 🎨 主题

5 种预设主题 + 自定义颜色。切换即时生效，整界面一起变 — 终端画布、标签、面板同步切换，无需重启。

### 预设

| 主题 | 风格 | 明/暗 |
|------|------|-------|
| **Graphite** | 深石墨 + 钨丝琥珀（默认） | 暗 |
| **Slate** | 偏蓝石板，焦点同琥珀 | 暗 |
| **Carbon** | 中性炭灰，无蓝调 | 暗 |
| **Ember** | 暖色胡桃木褐 + 暖琥珀 | 暗 |
| **Paper** | 自然浅纸 · 石墨墨 | 亮 |

强调色与状态色跨主题保持一致 — 每种协议（SSH、Telnet、串口、本机）都有专属色，一眼就能区分连接类型。

### 自定义

选取背景色和强调色，LyShell 自动生成一整套和谐配色 — 明暗模式也会自动判断。

<p align="center">
  <img src="docs/assets/screenshot-theme-comparison.jpg" alt="主题预设与自定义取色器" width="90%">
</p>

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + Alt + F` | 显示/隐藏浮窗 |
| `Ctrl + F` | 终端搜索 |
| `Ctrl + F1` ~ `F12` | 快捷命令 1–12 |
| `Ctrl + Shift + H` | 水平分屏 |
| `Ctrl + Shift + V` | 垂直分屏 |
| 右键 | 粘贴 |
| 鼠标中键 | 搜索栏 |
| 双击标签左半侧 | 克隆会话 |
| 双击标签右半侧 | 克隆通道（SSH） |

---

## ⚙️ 配置文件

所有配置以 JSON 存储于用户数据目录：

| 文件 | 内容 |
|------|------|
| `sessions.json` | 会话配置 |
| `preferences.json` | 用户偏好 |
| `quickCommands.json` | 快捷命令分组 |
| `agents.json` | AI Agent 定义 |
| `download-history.json` | 传输历史 |
| `download-config.json` | 下载目录设置 |
| `mcp-server.json` | MCP 授权 |

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\lyshell\` |

支持 AES-256-CBC 加密导出会话与快捷命令，导入提供预览确认。

---

## ❓ 常见问题

<details>
<summary><b>SSH 连接后中文乱码？</b></summary>
编辑会话，编码从 UTF-8 切换为 GBK 或 GB2312。
</details>

<details>
<summary><b>串口连接后无输出？</b></summary>
确认端口号和波特率正确 → 检查设备管理器未被占用 → 部分设备需回车激活。
</details>

<details>
<summary><b>文件管理器不显示？</b></summary>
仅 SSH 会话可用。确保当前活动标签是 SSH 连接。
</details>

<details>
<summary><b>如何重置所有配置？</b></summary>
删除用户数据目录下所有 JSON 文件，重启即恢复默认。
</details>

<details>
<summary><b>Ctrl+Alt+F 不生效？</b></summary>
可能被其他应用占用，可在设置中修改。
</details>

<details>
<summary><b>下载的文件在哪？</b></summary>
默认 `~/Downloads/LyShell/`，设置中可改目录，开启"自动创建服务器子目录"按服务器名归档。
</details>

---

## 📄 许可证

MIT © liangyou

---

<p align="center">
  <a href="https://github.com/liangyou09/lyshell_release">GitHub</a> ·
  <a href="https://github.com/liangyou09/lyshell_release/issues">Issues</a> ·
  <a href="https://github.com/liangyou09/lyshell_release/releases">Releases</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>
