# Changelog

All notable user-facing changes to LyShell are documented here. 本文档记录 LyShell 面向用户的版本变更。

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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

[Unreleased]: https://github.com/liangyou09/lyshell_release/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/liangyou09/lyshell_release/releases/tag/v1.0.3
[1.0.2]: https://github.com/liangyou09/lyshell_release/releases/tag/v1.0.2
