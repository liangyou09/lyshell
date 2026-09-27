# Changelog

All notable user-facing changes to LyShell are documented here. 本文档记录 LyShell 面向用户的版本变更。

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 变更 Changed

- **变量组启用改为全局单选**：环境变量组的启用从 dsh / codex / claude 三根独立指针收敛为全应用同一时刻至多一组通电（dsh / codex / claude 与 dsh Web 共用同一根；点亮新组即熄灭旧组，再点一次回落系统环境变量）。升级时按 dsh → codex → claude 顺序保留首个既有指针。*Env profile activation is now a single global switch instead of three per-kind pointers — dsh / codex / claude and the dsh Web UI all follow the same one (lighting a new set dims the old; clicking the lit one again falls back to system env). On upgrade the first existing pointer (dsh → codex → claude order) is kept.*

### 修复 Fixes

- **dsh Web 默认工作区吃不到变量组凭据**：此前无绑定工作区的 dsh Web 启动分支只注入启用组的附加变量，结构化核心（`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`）从未物化注入；现与 TUI 启动走同一份解析链。*The dsh Web default-workspace launch only injected the enabled set's extra vars and never materialized its structured credentials (`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`); it now shares the same resolution chain as TUI launches.*

## [1.0.9] - 2026-09-27

### 新增 Features

- **机柜目录分组**：Agents、Claude、Codex、dsh 工作区按工作目录分组，支持单组和整栏折叠；同名目录在组头显示可区分的父目录片段。*Agent and Harness workspaces are grouped by working directory, with per-group and all-group folding and distinguishable labels for same-named directories.*
- **网页最近访问**：最近访问按域名分组，并增加从历史记录打开迷你浏览器的入口。*Recent web visits are grouped by domain, with an entry to open a visit in the mini browser.*

### 变更 Changed

- **画轴与列表**：会话、网页及工作区画轴统一布局，扩大可点击画轴热区；变量组与插件列表移除无操作的装饰辊，工作目录集中显示在分组标题。*Scroll layouts are aligned across panels, clickable rods have a larger hit area, decorative rods are removed from flat lists, and working directories appear once in group headers.*
- **迷你浏览器**：切换机柜页签时保留页面状态，关闭页面时释放资源。*The mini browser preserves its page across rack tabs and releases resources when closed.*

### 修复 Fixes

- **网页与启动稳定性**：改进网页导航和加载状态处理，修复 dsh Web 进程重复启动及关闭后的回收问题。*Improved web navigation and loading states, and fixed duplicate dsh Web launches and process cleanup.*

## [1.0.4] - 2026-08-17

### 新增 Features

- **DeepSeek Harness 工作区**：新增专属面板，集中管理 DeepSeek Harness 工作区 — 创建、编辑、置顶、删除，支持按工作区配置环境变量（`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DSH_HOME` 等）与模型预设。*A dedicated DeepSeek Harness workspace panel — create, edit, pin, and delete workspaces, with per-workspace env vars (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DSH_HOME`, …) and model presets.*
- **TUI 与 Web UI 双启动**：每个工作区可打开为终端 TUI（`dsh-tui`）或内嵌 Web UI。Web UI 以 `dsh web --port 0` 启动，从 stdout 解析真实端口，并在 LyShell 内作为 `<webview>` 标签页渲染。*Each workspace launches as a terminal TUI (`dsh-tui`) or an embedded Web UI — spawned as `dsh web --port 0`, its real port parsed from stdout, rendered as a `<webview>` tab.*
- **Web UI 视作终端标签页**：可点击 ✕ 关闭，也可来回切换 — 切走即隐藏，但保留页面状态与子进程存活，仅 ✕ 才真正销毁。*Web UI behaves like a terminal tab — closable via ✕ and switchable back and forth; switching away hides it while keeping page state and the subprocess alive, and only ✕ tears it down.*

### 安全 Security

- **Web UI 导航锁定**：Web UI 的导航与弹窗锁定在工作区回环源；回显 URL 在 `<webview>` 加载前先校验（回环 + 显式端口、无内嵌凭据）。*Web UI navigation and popups are locked to the workspace's loopback origin; the echoed URL is validated (loopback + explicit port, no embedded credentials) before `<webview>` loads it.*

## [1.0.3] - 2026-08-14

### 新增 Features

- MCP 注册输出多格式配置（JSON / CLI / TOML），统一面板等宽字体。*MCP registration now emits JSON / CLI / TOML configs and unifies panel monospace fonts.*
- Agent 图标优化为圆角机器人头，新增微笑嘴与 `round` 线帽。*Rounded robot-head Agent icon with a smile and `round` line caps.*
- 机柜栏图标放大至 24px，新增悬停缩放 / 激活辉光 / 在线呼吸动画。*Rack-bar icons enlarged to 24px with hover scale, active glow, and an online breathing animation.*
- 快捷命令栏常驻显示并新增「新建」按钮，补充名称 / 命令必填校验。*Persistent quick-command bar with a "New" button, plus required name / command validation.*
- 设置入口合入左侧机柜栏轨道底槽位，移除标题栏 ⚙ 与悬浮面板。*Settings merged into the left rack bar's bottom slot; removed the title-bar ⚙ and floating panel.*

### 修复 Fixes

- 新建会话或切换页签后自动聚焦终端，仅聚焦活跃且未隐藏的实例，避免争抢焦点。*Auto-focus the terminal after creating a session or switching tabs, limited to the active, unhidden instance to avoid focus contention.*
- 终端改用 Unicode 15 宽度表并启用浮点宽度测量，修复中文 / emoji 首列文字漂移。*Switched to a Unicode 15 width table with floating-point width measurement, fixing first-column drift with CJK / emoji.*

## [1.0.2] - 2026-08-13

- 首个对外发布的 Windows 便携版（x64）。*First public Windows portable release (x64).*
- 支持 SSH、Telnet、串口、本地 PTY 四类连接。*SSH, Telnet, serial, and local PTY connections.*
- 内置 SFTP 文件管理、快捷命令、AI Agent 启动栏、Python 脚本引擎。*Built-in SFTP file manager, quick commands, AI Agent launcher, and Python scripting engine.*
- 新增插件系统（Python / Node.js 两种运行时，支持开发目录 / ZIP / URL 安装）。*Plugin system with Python and Node.js runtimes, installable from a dev directory, ZIP, or URL.*
- 提供 MCP HTTP API，供外部工具与 AI Agent 编排终端会话。*MCP HTTP API for external tools and AI agents to orchestrate terminal sessions.*

[Unreleased]: https://github.com/liangyou09/lyshell_release/compare/v1.0.9...HEAD

[1.0.9]: https://github.com/liangyou09/lyshell_release/releases/tag/v1.0.9
[1.0.4]: https://github.com/liangyou09/lyshell_release/releases/tag/v1.0.4
[1.0.3]: https://github.com/liangyou09/lyshell_release/releases/tag/v1.0.3
[1.0.2]: https://github.com/liangyou09/lyshell_release/releases/tag/v1.0.2
