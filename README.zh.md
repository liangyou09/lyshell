<p align="center">
  <img src="https://img.shields.io/badge/LyShell-v2.0.1-0078D4?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/MCP-ready-FF6B6B?style=flat-square" alt="mcp">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-ready-4D6BFE?style=flat-square" alt="deepseek-harness">
</p>

# 💻 LyShell

> 🔌 **你的终端，也是 AI 的终端。** LyShell 是一款内置 MCP 服务端的 Windows 终端 — 让 Claude Code 等 AI 客户端直接操控你的 SSH / Telnet / 串口 / 本地 PTY 会话。还集成了 `Ctrl+Shift+P` 全屏命令面板、AI Harness 工作区（TUI + 内嵌 Web UI，支持 git worktree 隔离）、文档页签、通用网页页签、AI Agent 启动栏、插件系统和 Python 脚本引擎。

**简体中文** | [English](README.md)

[v2.0.1 中英文更新日志 / Changelog](CHANGELOG.md)

**2.0 新增与改进**：插件视图与交互弹窗、网页页签切换及移动分屏时保留页面状态、画卷式设置与终端查找界面，以及四种画轴材质。

[✨ 核心亮点](#-核心亮点) · [⌨️ 命令面板与文档页签](#-命令面板与文档页签) · [🐋 AI Harness](#-ai-harness) · [🌐 网页页签](#-网页页签) · [🔗 MCP 集成](#-mcp-集成) · [🤖 AI Agent](#-ai-agent) · [🧩 插件与脚本](#-插件系统--python-脚本) · [🚀 快速上手](#-快速上手) · [❓ 常见问题](#-常见问题)

---

## ✨ 核心亮点

| | |
|---|---|
| 🔗 **MCP 服务端** — 将终端暴露给 AI 客户端，会话级授权 + 审计日志 | 🤖 **Agent 启动栏** — 一键启动 Claude Code / Aider / Copilot CLI / 任意自定义 CLI |
| ⌨️ **全屏命令面板** — `Ctrl+Shift+P` 模糊直达所有入口：会话、Agent、工作区、面板、文档 | 📄 **文档页签** — 只读 Markdown 预览带大纲轨，附内置手册与清点文档 |
| 🧩 **插件系统** — Python / Node.js 自动化、自定义侧栏视图与交互弹窗，按能力授权 | 🐍 **Python 引擎** — 内置 `LyShell` API 驱动终端自动化 |
| 🐋 **AI Harness** — 统一管理 DeepSeek / Codex / Claude 工作区的模型、环境变量与启动权限 | 🔐 **内嵌 Web UI** — 应用内 `<webview>` 标签页运行 `dsh web`，回环锁定 + URL 校验 |
| 🌳 **worktree 隔离** — 每个 Harness 工作区在专属 git worktree 中启动，多 agent 指向同一仓库互不踩踏 | 🌐 **网页页签** — 任意 URL 开成应用内页签，带最近访问历史与自动补全 |

---

<p align="center">
  <img src="docs/assets/screenshot-main.jpg" alt="LyShell 主界面" width="90%">
</p>

---

## 📥 安装

从 [Releases](https://github.com/liangyou09/lyshell/releases) 下载安装版或便携版；便携版免安装，下载即用。

| 平台 | 格式 | 架构 | 系统要求 |
|------|------|------|----------|
| 🪟 Windows | 安装版 (`-setup.exe`) | x64 | Windows 10 / 11，64 位 |
| 🪟 Windows | 便携版 (`-portable.exe`) | x64 | Windows 10 / 11，64 位 |

> 🚧 目前**仅提供 Windows 版本**，macOS / Linux 暂未发布。

### 从资源管理器打开终端

安装版会注册以下入口（更新后需运行新的 `-setup.exe`）：

- 右键文件夹、驱动器或文件夹空白处，选择 **使用 LyShell 打开**。Windows 11 可在“显示更多选项”中找到。
- 在资源管理器地址栏输入 `lyshell` 并回车，在当前目录打开终端。
- 也可指定目录：`lyshell --open-directory "D:\项目目录"`。

终端优先使用 PowerShell 7（`pwsh.exe`），未安装时使用 Windows PowerShell。已有窗口时新增临时终端页签；目录不会保存为连接配置。终端使用 `-NoProfile`，保证启动目录不被 PowerShell profile 改写。地址栏无参数启动会读取前台资源管理器的活动页签目录；其它无参数启动使用进程启动工作目录。

便携版不注册右键菜单或地址栏名称；可通过完整可执行文件路径加 `--open-directory` 启动。卸载安装版时自动移除对应入口。

---

## ⌨️ 命令面板与文档页签

### 全屏命令面板

`Ctrl+Shift+P` 唤起全屏命令面板 — **一处直达所有入口**。模糊搜索保存 / 运行中的会话、Agent、dsh / codex / claude 工作区、变量组、插件、网页与设置页签；斜杠命令同样可用：

- `/new` — 新建连接对话框 · `/local` — 直连本地终端
- `/help` — 打开内置使用手册 · `/ls` — 打开清点文档

ESC 退出；页签条尾也有面板入口。

### 文档页签与内置文档

只读文档预览开成普通页签 — 可多开、可分屏、可拖拽。四个入口：文件树双击、窗口拖放、`Ctrl+Shift+O` 打开系统文件对话框、终端内 **Ctrl+点击** 路径。Markdown 走完整文档渲染管线 — 大纲轨、缩放、主题 — 链接跨页签归一解析（含 SSH 相对路径场景）。

- **内置使用手册** — `/help`（或 `/help chinese` / `/help english`）把使用手册开成文档页签。
- **清点文档** — `/ls` 把会话 / Agent / 变量组 / harness 工作区 / 插件清点成一份文档页签；文档内 `lyshell-action://` 链接直接跳转打开对应对象，`/ls <对象>`（如 `/ls env`）只看单节。重跑或点页签刷新按钮即可重新清点。

<p align="center">
  <img src="docs/assets/screenshot-command-palette.jpg" alt="全屏命令面板（Ctrl+Shift+P）" width="90%">
</p>

<p align="center">
  <img src="docs/assets/screenshot-doc-tab.jpg" alt="文档页签 Markdown 预览" width="90%">
</p>

---

## 🔗 MCP 集成

**这是 LyShell 最大的不同。** LyShell 可以作为 MCP 服务端，让 Claude Code 等外部 AI 客户端通过 MCP 协议操控终端 — 列出会话、发送命令、读取输出、传输文件、管理连接，一应俱全。

> 📖 **配置** — 见 [MCP 配置指南](docs/mcp-config.md)。大多数情况下你无需手动配置：从 **Agent 启动栏** 启动 agent，让它自己把 LyShell 配成自己的 MCP 服务端即可。注册配置可输出 **JSON / CLI / TOML** 三种格式，适配不同客户端。

### 工具列表

当前工具名称统一使用 `lyshell_` 前缀；客户端实际可用的工具取决于所获授权。

| 工具 | 能力 | 说明 |
|------|------|------|
| `lyshell_list_sessions` | `read` | 列出侧边栏会话 |
| `lyshell_send_input` | `interactiveWrite` | 发送文本，autoNewline 自动补换行 |
| `lyshell_send_and_wait` | `interactiveWrite` | 发送并捕获响应，自动剥离回显和 ANSI |
| `lyshell_execute_command` | `execute` / `localExecute` | 独立于交互终端执行（SSH / 本地 PTY；默认不出现在工具发现列表） |
| `lyshell_run_on_sessions` | `execute` / `localExecute` | 广播命令，最多 50 会话并发 10 |
| `lyshell_read_output` | `read` | 读取 N 行终端输出 |
| `lyshell_terminal_screenshot` | `read` | 将当前可见、无遮挡的终端视口捕获为 PNG |
| `lyshell_upload_file` / `lyshell_download_file` | `fileWrite` | SFTP 文件传输 |
| `lyshell_read_file` / `lyshell_stat_file` / `lyshell_list_files` | `read` | 远程文件检查，支持递归和通配符 |
| `lyshell_create_session` | `sessionControl` | 创建/复用会话，同 target 自动去重 |
| `lyshell_reconnect_session` | `sessionControl` | 重连断开连接 |
| `lyshell_close_session` | `sessionControl` | 断开连接但不删除已保存会话 |
| `lyshell_open_connection_dialog` | `sessionControl` | 打开新建连接对话框，供用户手动填写 |
| `lyshell_read_session_notes` | `read` | 读取会话摘要、说明、标签 |
| `lyshell_write_session_notes` | `sessionMetadataWrite` | 更新摘要、说明、标签 |
| `lyshell_wait_for_prompt` | `read` | 等待 Shell 提示符或正则 |
| `lyshell_tail_until` | `read` | 轮询直到匹配 |

### 安全机制

- 🔑 **会话级授权** — 每个终端拥有独立权限范围
- 🚪 **能力门控** — 每端点服务端强制执行
- 🛡️ **破坏性命令确认** — 扫描 `rm -rf`、`dd if=` 等模式
- 🔒 **共享 PTY 锁定** — 协调 MCP 写入与人工输入
- 📊 **审计面板** — 标题栏入口，日历选择器 + 过滤 + 分页

> 全屏 TUI（vim、htop、less）的布局无法仅靠文本回读准确呈现。可用 `lyshell_terminal_screenshot` 查看可见界面，再用 `lyshell_send_input` 发送输入。截图要求目标终端当前可见且无遮挡；工具不会自动切换页签，也不会截取整个桌面。

<p align="center">
  <img src="docs/assets/screenshot-mcp-audit.jpg" alt="MCP 审计面板" width="90%">
</p>

---

## 🤖 AI Agent

LyShell 是**与 Agent 无关的终端** — 不绑定任何特定 AI 工具。启动你正在用的任意 CLI Agent，它就像普通会话一样运行在标准终端里：回滚、分屏、输入法支持一视同仁。

| Agent | 命令 |
|-------|------|
| 🧠 Claude Code | `claude` |
| 🛠️ OpenAI Codex | `codex` |
| 🤝 Aider | `aider` |
| 🔧 自定义 CLI | 你配置的启动命令 |

**Harness Agent** — `dsh`、`codex`、`claude` 各自拥有专属工作区面板，支持依赖检测、模型与环境变量设置、启动权限（Codex / Claude），以及可选的 **worktree 隔离**。详见 [AI Harness](#-ai-harness)。

**自定义 Agent**：任意 CLI 工具都能注册 — 名称、命令、图标、工作目录、环境变量。Agent 会话为**瞬态**，关闭标签即消失，不残留。

<p align="center">
  <img src="docs/assets/screenshot-agents.jpg" alt="AI Agent 启动栏" width="90%">
</p>

---

<a id="-deepseek-harness"></a>

## 🐋 AI Harness

在各自的专属面板中管理 **DeepSeek Harness、OpenAI Codex 与 Claude Code** 工作区。每个工作区保存工作目录、模型及环境变量组，Codex 和 Claude 还可设置启动权限。三者均支持终端启动；DeepSeek Harness 额外支持**内嵌 Web UI**，可与 TUI 分屏并排运行。

| | |
|---|---|
| 🗂️ **工作区面板** — 创建、编辑、删除 | 🔧 **变量组** — 结构化 Base URL + API Key，全局单选切换 |
| 🎛️ **模型预设** — 按工作区保存并切换模型 | 🖥️ **终端启动** — 在原生终端页签运行 `dsh-tui`、`codex` 或 `claude` |
| 🌳 **worktree 隔离** — 每个工作区一个专属 git worktree | 🏷️ **品牌来源标** — 页签上标明由哪个 harness 启动 |

### 启动权限

Claude 可选 `default`、`acceptEdits`、`plan`、`bypassPermissions`，其中最后一档追加 `--dangerously-skip-permissions`。Codex 可选 `:read-only`、`:workspace`、`:danger-full-access`，通过 `-c default_permissions=<档位>` 传入；完全开放档位还会追加 `-c approval_policy=never`。完全开放时，表单和工作区卡片会显示红色警示，并在启动前展示对应参数。

<p align="center">
  <img src="docs/assets/screenshot-harness-permissions.jpg" alt="危险态工作区卡片 — 完全放开档位整卡红染" width="90%">
</p>

### 依赖检测与安装方法

CLI 依赖 — DeepSeek Harness 需 `dsh` + `dsh-tui`，codex / claude 各自单个 — 在**应用启动时统一检测一次**（三个 agent 并行）并缓存：切到 Harness 标签直接读缓存，不重复扫描。缺失时面板会指出缺哪个依赖、给出对应的一行安装命令与源码仓库链接 — 但不会替你安装。**重新检测** 按钮强制重扫，PATH 从注册表实时读取，新装的 CLI 无需重启 LyShell 即可识别。

### 共享环境变量组

变量组住在左侧机柜的**环境变量**面板，dsh / codex / claude 与内嵌 dsh Web UI 共用。同一时刻至多一组**通电** — 卡片本身就是开关：点亮即全应用生效，再点一次回落系统环境变量。

凭据结构化为 **Base URL + API Key**，按消费方注入（dsh → `DEEPSEEK_*`、codex → `OPENAI_*`、claude → `ANTHROPIC_*`）；组内其余变量作为附加项透传，通用 Agent 也可显式绑定变量组（绑定组 → 内联 env → 系统环境变量）。每个工作区可绑定特定变量组或跟随已启用的一组 — 密钥录入一次，切换环境无需逐工作区改动。

敏感值（`*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD` 等）**默认打码**，点眼睛按钮可显示。启动 Codex 前，LyShell 还会把所选变量组的 Base URL 写入 `CODEX_HOME`（未指定时为 `~/.codex/`）下 `config.toml` 的当前 provider 配置；原文件首次修改前备份为 `.bak`。

### worktree 目录隔离

让多个 agent 指向同一个仓库而互不踩踏：把工作区切到 **worktree** 隔离模式，它将在 `<仓库根>/.lyshell-worktrees/<key>` 的专属 git worktree 中、于 `lyshell/<key>` 分支上启动 — 首次启动创建，此后每次复用，**未提交修改跨启动保留**。删除工作区不会动它的 worktree。

- **私有（默认）** — 自动生成可读 key（如 `claude-myapp-20260708-160745`，尾段时间戳为创建时刻、精确到秒），每个工作区一份独立检出。
- **共享** — 显式指定共享名后，填了同一共享名的工作区共用同一份检出与同一分支，跨 dsh / codex / claude 也行 — 彼此实时可见对方的改动。
- 表单在保存前**预览 worktree 完整路径**；非法 key（路径分隔符、ref 非法字符等）当场拒绝。

### 启动方式：TUI 或 Web UI

DeepSeek Harness 工作区支持以下两种打开方式；Codex 与 Claude 工作区通过终端启动：

- **终端 TUI** — `dsh-tui` 作为标准终端标签页运行，完整回滚、分屏、输入法一视同仁。
- **内嵌 Web UI** — 以 `dsh web --port 0` 启动；LyShell 从 stdout 解析真实端口，把应用渲染进应用内 `<webview>` 标签页。无需浏览器，也无需手动折腾端口。

### TUI 与 Web UI 同框

把 Web UI 标签拖到分屏边缘即可拆分为独立窗格 — TUI 与内嵌 Web UI **同框并排**运行。拖回某个窗格中央即还原为普通标签页。

### Web UI 视作终端标签页

- **✕ 关闭** — 只有 ✕ 才会真正销毁标签并终止子进程。
- **切走即隐藏** — 切换到其他标签页会隐藏 Web UI，但保留页面状态与 `dsh web` 子进程存活；切回即秒开。

### 安全机制

- 🔒 **回环锁定** — 导航与弹窗被固定在工作区回环源。
- ✅ **URL 校验** — 回显 URL 在 `<webview>` 加载前先校验（回环 + 显式端口、无内嵌凭据）。

<p align="center">
  <img src="docs/assets/screenshot-deepseek-panel.jpg" alt="DeepSeek Harness 工作区面板" width="90%">
</p>

<p align="center">
  <img src="docs/assets/screenshot-env-panel.jpg" alt="环境变量面板与共享变量组" width="90%">
</p>

<p align="center">
  <img src="docs/assets/screenshot-deepseek-split.jpg" alt="TUI 与内嵌 Web UI 同框并排" width="90%">
</p>

<p align="center">
  <img src="docs/assets/screenshot-deepseek-webui.jpg" alt="内嵌 Web UI 标签页" width="90%">
</p>

---

## 🌐 网页页签

左侧机柜的 **Web** 面板给 LyShell 装上一个轻量内置浏览器，用来看监控大盘和文档再合适不过。输入完整网址（无 scheme 自动补 `https://`）回车，即以普通页签形式打开在当前活动分屏 — 拖拽拆分、页签语义与 `dsh web` 内嵌 Web UI 完全一致，大盘可以和喂数据的终端同框并排。

- **打开列表** — 点击跳到承载分屏并激活页签，✕ 关闭。
- **最近访问** — 成功加载过的 URL 会被记住（去重、最近优先、本地持久化、封顶 30 条），在输入框做原生自动补全；点击重开、✕ 删除单条、一键清空。
- **安全** — 仅放行 `http`/`https` URL；webview 的导航与弹窗由主进程走专属 partition 分流。

---

## 🧩 插件系统 & Python 脚本

### 插件系统

权限门控的插件宿主，支持 **Python**（一次性 / 常驻）和 **Node.js**（常驻）插件。可从本地目录、ZIP 或远程 URL 安装。每个插件独立授权，按细粒度权限（读取 / 写入 / 执行 / 文件 / 会话控制）服务端校验，含路径安全、破坏性命令确认、共享终端锁定等多层防护。

插件可通过声明式配置，或由常驻插件在运行时注册，添加 **HTML 侧栏视图与交互弹窗**。切换面板时视图保留状态，并接收主题变化；获得对应权限后，可打开终端、网页与文档，调用 LyShell API，并返回弹窗结果。禁用或卸载插件时，会回收其视图、页签、弹窗和受控子进程。

- [声明式视图示例](examples/my-view-plugin/)
- [运行时视图示例](examples/my-view-runtime-plugin/)

> 已支持启动激活（`onStartup` / `*`）；`onCommand` / `onConnectionType` 事件触发，以及向命令面板贡献声明式命令，尚未接通。

**2.0 兼容性**：仅声明 `engines.lyshell: "^1.0"` 的旧插件会显示兼容警告，当前不会因此阻止安装。使用新增视图 API 的插件建议声明 `"^2.0"`。

<p align="center">
  <img src="docs/assets/screenshot-plugin-views.jpg" alt="LyShell 内的 PetLink 插件界面" width="90%">
</p>

📦 开箱即用的示例见 [`examples/`](examples/)。

### Python 脚本引擎

内置 Python 执行引擎，提供 `LyShell` API 驱动终端自动化：

```python
session = LyShell.get_current_session()
LyShell.execute("ls -la")
LyShell.send("hello\n")
LyShell.wait_for("prompt$")
```

环境变量：`LYSHELL_SESSION_ID` · `LYSHELL_SESSION_TYPE` · `LYSHELL_HOST` · `LYSHELL_PORT`

Python 路径自动检测系统 PATH，可在设置中配置自定义解释器。

> 💡 长驻或定时任务建议使用**Node.js 插件**（通过[插件系统](#-插件系统--python-脚本)），更加适合。

---

## 🚀 快速上手

### 本地终端

按 `Ctrl+Shift+P` 打开命令面板，输入 `/local` 并回车，即可启动本地终端。输入 `/help` 可阅读内置使用手册。

### 首次连接

1. 点击会话列表顶部的 **+** → **SSH**
2. 填写主机、端口、用户名、密码/私钥
3. 点击 **连接**，标签变为 🟢 绿色

> 💡 网络设备需先 `shell` → `enable` 才能进入 CLI？在 **Shell 进入命令** 中逐行写入，LyShell 会自动按序发送。

### 多机监控
点击会话 → `Ctrl+Shift+V` 垂直分屏 → 点击另一个会话。布局自动保存。

### 文件传输
- **上传**：桌面拖拽到文件面板
- **下载**：双击远程文件，或右键 → 下载
- **进度**：实时速度 + 预估时间，下载完成自动 MD5 校验
- **历史**：记录文件名、大小、路径、MD5，支持重新下载
- **安全**：独立 SSH 连接（不阻塞终端），SFTP 或 TCP-over-SSH 隧道；`AllowTcpForwarding` 禁用不会回退明文
- **下载目录**：默认 `~/Downloads/LyShell/`，可选"自动创建服务器子目录"归档

### 快捷命令
快捷命令位于会话面板底部 — 右键 → **编辑分组** → 添加 `tail -f /var/log/syslog` 等命令。`Ctrl+F1`–`F12` 随处可触发，侧栏收起时同样有效。最多 12 条命令 × 5 组。

### 会话管理
- 📌 置顶 — 悬停卡片 → 点击 📌
- 📋 克隆会话 — 双击标签左半侧
- ⚡ 克隆通道（免重认证） — 双击标签右半侧（仅 SSH）
- 🔍 搜索 — 搜索框输入名称/主机/标签

### 终端技巧
- 选中文本 → 自动复制 · 右键粘贴 · 鼠标中键 → 搜索栏
- `Ctrl+F` → 可拖动的画卷式查找（正则、区分大小写、全词匹配、当前或全部页签，含非法正则提示）
- 终端内 **Ctrl+点击** — URL 开成网页页签，路径打开文档预览
- **编码** — 点侧栏 LIVE 行的编码读数，运行时直切 UTF-8 / GBK / GB2312（重连保持；关闭重开回落保存值；本地终端恒 UTF-8）
- Edge 式收缩页签栏（悬停详情卡）提顶为第一行；侧栏可收起，还你全宽终端
- 侧栏 LIVE 行中点击「列 × 行」→ 清屏；点击缓冲行数 → 滚回底部，双击 → 清空回滚

<p align="center">
  <img src="docs/assets/screenshot-terminal-search.jpg" alt="画卷式终端查找：匹配选项与搜索范围" width="90%">
</p>

---

## 🔌 连接类型 & 终端

| 类型 | 关键参数 | 说明 |
|------|---------|------|
| 🖥️ **SSH** | 密码或私钥；端口 `22` | 登录后命令、心跳；双击标签克隆 |
| 📟 **Telnet** | 主机 + 端口 `23` | 完整 IAC 协商 |
| 🔌 **串口** | COM 口，波特率 `115200`（9600–921600），8N1 | 自动检测端口 |
| 💻 **本地 PTY** | cmd.exe / PowerShell | 可配工作目录 + 环境变量 |

**终端**：GPU 加速渲染，完整 ANSI + 256 色。回滚最多 100,000 行。分屏（水平/垂直）、拖拽拆分。Edge 式收缩页签栏（悬停详情卡）置于第一行，侧栏可收起。侧栏运行时切换编码（UTF-8 / GBK / GB2312）。全局快捷命令 `Ctrl+F1–F12`。标签状态：🟢 已连接 · 🔴 错误 · ⚪ 未连接 · 🔵 新输出 — 从 Harness 工作区启动的页签还带品牌标（🐋 dsh · 🛠️ codex · 🧠 claude）。

---

## 🎨 主题

6 种预设 + 自定义。即时切换，无需重启。

| 主题 | 风格 | 明/暗 |
|------|------|-------|
| **Graphite** | 深石墨 + 钨丝琥珀（默认） | 暗 |
| **Slate** | 偏蓝石板，强调色琥珀 | 暗 |
| **Carbon** | 中性炭灰，无蓝调 | 暗 |
| **Ember** | 暖色胡桃木褐 + 暖琥珀 | 暗 |
| **Paper** | 自然浅纸 · 石墨墨 | 亮 |
| **Lark** | 飞书风亮色 · 冷灰白 + 纯白画布 + 品牌蓝 | 亮 |

**自定义**：选取背景色和强调色，LyShell 自动生成一整套和谐配色。

**画轴材质**：在设置中选择胡桃木、玉石、漆器或瓷器。材质独立于颜色主题保存，应用到画轴与终端查找窗。浅色主题还会调整终端 ANSI 配色，并补偿低对比度彩色输出。

<p align="center">
  <img src="docs/assets/screenshot-theme-comparison.jpg" alt="设置中的主题预设，当前选中 Graphite 深色主题" width="90%">
</p>

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + Shift + P` | 全屏命令面板 |
| `Ctrl + F` | 终端搜索 |
| `Ctrl + Shift + O` | 打开文档（系统文件对话框） |
| `Ctrl + F1` ~ `F12` | 快捷命令 1–12 |
| `Ctrl + Shift + H` | 水平分屏 |
| `Ctrl + Shift + V` | 垂直分屏 |
| 右键 | 粘贴 |
| 鼠标中键 | 搜索栏 |

---

## ⚙️ 配置文件

安装版与便携版的用户数据存储于 `%APPDATA%\lyshell\`：

| 位置 | 内容 |
|------|------|
| `config/` | `sessions.json`、`preferences.json`、`quickCommands.json`、`agents.json`、`env-profiles.json`、`dsh-workspaces.json`、`codex-workspaces.json`、`claude-workspaces.json` |
| `data/` | `download-history.json`、`download-config.json` |
| 用户数据根目录 | `mcp-server.json`（运行时连接信息）、`mcp-audit.json` |

开发实例使用独立的 `%APPDATA%\lyshell-dev\` 目录。

支持 AES-256-CBC 加密导出/导入会话与快捷命令。

---

## ❓ 常见问题

<details>
<summary><b>SSH 连接后中文乱码？</b></summary>
点侧栏 LIVE 行的编码读数，运行时直切 UTF-8 / GBK / GB2312，无需编辑会话。
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
<summary><b>如何重置保存的配置？</b></summary>
退出 LyShell，先备份 `%APPDATA%\lyshell\`，再重命名其中的 `config` 文件夹并重启。这会重置保存的会话、偏好、Agent 与工作区；若还要重置下载历史及下载设置，再重命名 `data`。主题与网页状态另行存储，这些步骤不会重置它们。
</details>

<details>
<summary><b>下载的文件在哪？</b></summary>
默认 `~/Downloads/LyShell/`，可在设置中修改。
</details>

---

## 📄 许可证

LyShell 基于 [MIT 许可证](LICENSE) 开源。你可以自由使用、修改与再分发，但需保留原始版权与许可声明。

© 2026 liangyou

---

<p align="center">
  <a href="https://github.com/liangyou09/lyshell">GitHub</a> ·
  <a href="https://github.com/liangyou09/lyshell/issues">Issues</a> ·
  <a href="https://github.com/liangyou09/lyshell/releases">Releases</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>
