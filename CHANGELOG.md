# Changelog

LyShell 版本更新记录 / LyShell release history.

历史版本保留公开发行说明的完整内容与原文语言；可点击版本号查看对应发布页面。
Published release notes are archived in full in their original language. Click a version number to open its release page.

<!-- Synced from liangyou09/lyshell Releases on 2026-10-10. Dates prefer release-note dates or original lyshell-archive releases over repository migration timestamps. -->

## [Unreleased]

## [2.0.2] - 2026-10-18

LyShell 2.0.2 完善内置浏览器与内容查找，新增 DSH 侧栏插件市场和原生 Harness 工作通道，改进 PetLink 与共享工作台的协作，并升级 Electron 运行时。以下内容汇总自 2.0.1 以来的更新。

LyShell 2.0.2 expands the built-in browser and content search, adds a DSH sidebar plugin market and a native Harness work channel, improves PetLink integration with the shared workbench, and upgrades the Electron runtime. This release brings together the changes since 2.0.1.

### ✨ 新增 / New Features

- **浏览器设置与统一欢迎页**：欢迎页与新建页签统一提供网址和搜索输入，支持选择默认搜索引擎。新增主页、50%–200% 缩放、代理、访问记录、网页恢复及缓存和网站数据清理设置；普通网页与小窗共用浏览器配置。

  **Browser settings and welcome page**: The welcome page and new tabs share an address/search field with a selectable default search engine. Added settings for a home page, 50%–200% zoom, proxies, history, page restoration, and clearing cache and site data. Regular web tabs and the mini-browser share these settings.

- **密码保存与网站权限**：登录时可确认保存或更新密码，并在设置中管理账号；密码使用系统密钥加密，在用户操作登录区域时按站点匹配填充。摄像头、麦克风、通知、位置和读取剪贴板支持询问或禁止；证书错误页可查看证书详情，确认后仅在当前浏览器会话中信任对应主机与证书。

  **Passwords and site permissions**: Confirm password saves or updates during sign-in and manage accounts in settings. Passwords use system encryption and are filled for the matching site when the user interacts with its sign-in area. Camera, microphone, notifications, location, and clipboard reads can prompt or be denied. Certificate error pages show certificate details and allow confirmed exceptions for the matching host and certificate in the current browser session.

- **网页内嵌开发者工具**：普通网页页签支持按 `F12` 或点击检查网页按钮，在页面下方打开开发者工具，并拖动分隔条调整高度。

  **Embedded web developer tools**: Press `F12` or use the inspect button in regular web tabs to open developer tools below the page, with a draggable divider to adjust their height.

- **页签内容查找与跨终端搜索**：`Ctrl+F` 支持文档、网页、DeepSeek 工作台和 MCP 审计页签的当前内容查找。终端可切换「本标签 / 所有终端」，按分屏和页签顺序跳转匹配结果，跳过隐藏终端。网页与 DeepSeek 页面支持区分大小写；正则与全字匹配用于终端、文档等文本视图。

  **Find in tabs and across terminals**: Use `Ctrl+F` to search the current content of documents, web pages, the DeepSeek workbench, and MCP audit tabs. Terminal search can target the current tab or all terminals, following pane and tab order and skipping hidden terminals. Web pages and DeepSeek support case matching; regular expressions and whole-word matching are available in terminals and text views such as documents.

- **DSH 侧栏插件市场**：在侧栏浏览、搜索和安装 DSH 插件，提供市场安装与重新连接入口，切换面板保留页面状态。市场复用共享 Harness 后台；后台使用中会提示先结束任务并关闭工作台，再进行市场安装。

  **DSH sidebar plugin market**: Browse, search, and install DSH plugins from the sidebar, with market setup and reconnect actions and preserved page state when switching panels. The market reuses the shared Harness backend; setup prompts users to finish tasks and close the workbench when that backend is in use.

- **原生 Harness 工作通道**：新增 MCP 工具 `lyshell_harness_work` 及配套 HTTP 接口，支持创建工作会话、提交任务、查看状态与输出、处理审批和取消任务。不同调用凭据的会话、任务和审批相互隔离，可与 PetLink 共用后台。

  **Native Harness work channel**: The new `lyshell_harness_work` MCP tool and HTTP endpoints support work sessions, task submission, status and output tracking, approvals, and cancellation. Sessions, tasks, and approvals are isolated by caller credential while sharing the backend with PetLink.

### 🧩 插件与协作 / Plugins and Collaboration

- **PetLink 共享工作台**：PetLink 与 LyShell 复用一个兼容的 Harness 后台，在主区域同一官方工作台页签查看任务详情。关闭详情页签后任务继续；再次请求详情时可重开，重复状态推送不打断用户浏览历史。工作台保留正常输入、新建会话及配置能力。

  **Shared PetLink workbench**: PetLink and LyShell reuse a compatible Harness backend and show task details in the same official workbench tab. Tasks continue when the details tab is closed and an explicit details action can reopen it. Repeated state updates preserve the user's history browsing. Normal workbench input, session creation, and configuration remain available.

- **插件设置与聊天入口**：插件可通过 `contributes.settings` 将设置页嵌入 LyShell 设置。PetLink 可定位其设置页，或在主区域打开并复用聊天页签；完善聊天与模型接入。新增从源码目录启动 PowerShell 7 的示例插件。

  **Plugin settings and chat entry points**: Plugins can embed settings pages through `contributes.settings`. PetLink can open its settings or open and reuse a chat tab in the main area, with improved chat and model integration. Added example plugins for launching PowerShell 7 from a source workspace.

### 🎨 界面与修复 / Interface and Fixes

- 改善迷你浏览器清晰度，完善网页加载失败后的提示与重试，以及插件页面崩溃后的恢复。

  Improved mini-browser clarity, web page loading errors and retries, and recovery after plugin page crashes.

- 修复查找结果的选区跳转与文档匹配边界，完善欢迎页焦点、窄侧栏布局及面板折叠交互。

  Fixed selection navigation and document match boundaries in search, and refined welcome-page focus, narrow sidebars, and panel folding.

- 完善画轴材质、紧凑面板与嵌套绳结样式，优化市场面板层次和页面颜色同步。

  Refined scroll materials, compact panels, and nested knot styling, with improved market panel layering and page color synchronization.

- 修复工作台详情重开及过期异步响应的竞态，完善插件异步停机、安装替换、共享后台连接与退出清理。

  Fixed races when reopening workbench details and handling stale asynchronous responses, and improved asynchronous plugin shutdown, installation replacement, shared backend connections, and exit cleanup.

### ⚙️ 运行时与兼容性 / Runtime and Compatibility

- Electron 升级至 **43.7.11**，node-pty 升级至 **1.1.0**；适配新运行时的原生文件拖放、网页事件及原生模块加载。源码开发需要 Node.js **22.12 或更高版本**。

  Upgraded Electron to **43.7.11** and node-pty to **1.1.0**, adapting native file drag-and-drop, web events, and native module loading. Source development requires Node.js **22.12 or later**.

- 浏览器代理与隐私设置仅作用于普通网页和小窗；网页标签恢复默认关闭，恢复 URL 不重放表单提交。系统加密不可用时，密码保存与填充不可用。

  Browser proxy and privacy settings apply to regular web tabs and the mini-browser. Web tab restoration is off by default and restores URLs without replaying form submissions. Password saving and filling are unavailable when system encryption is unavailable.

- PetLink 共享模式需配套兼容的 PetLink 构建与已安装的官方 DeepSeek Harness；本地集成验证使用 `dsh 0.2.0-rc.2`。原生工作通道沿用 MCP 权限，外部客户端需显式开启外部接入；后台重启后需新建工作会话，不自动重发结果未知的任务。

  Shared PetLink mode requires a compatible PetLink build and an installed official DeepSeek Harness; local integration validation used `dsh 0.2.0-rc.2`. The native work channel follows MCP permissions and requires external access to be explicitly enabled for external clients. Create a new work session after a backend restart; tasks with unknown submission outcomes are not automatically resubmitted.

### 📦 Windows 发行文件 / Windows Release Files

- `LyShell-2.0.2-x64-setup.exe`：Windows 10 / 11 x64 安装版，可选择安装目录并创建快捷方式。

  `LyShell-2.0.2-x64-setup.exe`: Windows 10 / 11 x64 installer with a selectable installation directory and shortcuts.

- `LyShell-2.0.2-x64-portable.exe`：Windows 10 / 11 x64 便携版，免安装运行。

  `LyShell-2.0.2-x64-portable.exe`: Windows 10 / 11 x64 portable executable; runs without installation.

## [2.0.1] - 2026-10-12

LyShell 2.0.1 完善画卷式终端与侧栏体验，新增终端截图和输出事件流，修复搜索覆盖剪贴板、SFTP 上传及版本信息显示问题。以下内容汇总自 2.0.0 以来的更新。

LyShell 2.0.1 refines the scroll-style terminal and sidebar experience, adds terminal screenshots and output event streams, and fixes clipboard, SFTP upload and version-display issues. This release brings together the changes since 2.0.0.

### ✨ 新增 / New Features

- **终端截图**：新增 MCP 工具 `lyshell_terminal_screenshot`，让 AI 客户端查看终端的真实 PNG 画面，适合识别 TUI 布局与颜色。目标终端需在主窗口中可见且无遮挡；工具不会切换页签或截取整个桌面。

  **Terminal screenshots**: The new `lyshell_terminal_screenshot` MCP tool returns a real PNG of the terminal viewport, helping AI clients inspect TUI layouts and colors. The terminal must be visible and unobscured in the main window; the tool does not switch tabs or capture the desktop.

- **终端输出事件流**：新增 HTTP 工具目录与按会话订阅的 SSE 事件流，提供初始输出快照、后续输出、连接状态和心跳。截图与事件流遵循现有读取权限和会话授权，撤销授权后停止交付内容。

  **Terminal output streams**: Added an HTTP tool catalog and per-session SSE subscriptions with an initial output snapshot, subsequent output, connection status and heartbeats. Screenshots and streams follow existing read permissions and session authorization, and stop delivering content when access is revoked.

- **内置更新记录**：点击设置面板的版本号，在文档页签中查看随应用打包的更新记录，无需联网。

  **Built-in release history**: Click the version in settings to open the bundled changelog in a document tab, without an internet connection.

### 🎨 界面与交互 / Interface and Interaction

- **水墨欢迎页**：空终端新增水墨山水与奔马画面，提供本地终端、新建连接和使用手册入口，并改进快捷入口焦点与窄窗口布局。

  **Ink landscape welcome screen**: Empty terminals now show an ink landscape and running horse, with shortcuts to a local terminal, a new connection and the user guide. Shortcut focus and narrow-window layouts have also been improved.

- **画轴与册页**：完善玉雕画轴、宣纸纹理和终端查找样式，更新连接及导入导出弹窗的册页布局，适配明暗主题。

  **Scrolls and book-style dialogs**: Refined jade scroll artwork, paper textures and terminal search styling, and updated connection and import/export dialogs with book-style layouts for light and dark themes.

- **侧栏与快捷命令**：统一侧栏标题及分组操作，更新连接协议印签和快捷命令玉匣，修复窄侧栏操作溢出，并优化窗口控制按钮的交互反馈。

  **Sidebar and quick commands**: Standardized panel headers and group actions, refreshed protocol seals and the quick-command box, fixed action overflow in narrow sidebars, and improved window-control feedback.

- **Windows 图标**：优化应用图标在 Windows 中的显示。

  **Windows icon**: Improved the application icon for Windows.

### 🐛 修复 / Fixes

- **查找与剪贴板**：终端查找生成的选区不再覆盖剪贴板；保留鼠标划选自动复制，并完善拖出终端后松手及鼠标捕获模式下的选择处理。

  **Search and clipboard**: Search-generated selections no longer overwrite the clipboard. Mouse selection still copies automatically, with improved handling when releasing the mouse outside the terminal and selecting in mouse-tracking mode.

- **SFTP 上传**：创建远端目录时先检查已有目录，修复 Windows SFTP 路径等场景下误报权限错误的问题。上传连接遇到暂时性连接或握手故障时最多重试一次，认证错误不会重试。

  **SFTP uploads**: Check for existing remote directories before creating them, fixing false permission errors in cases such as Windows SFTP paths. Upload connections retry once after transient connection or handshake failures; authentication failures are not retried.

- **插件弹窗与资源**：修复焦点位于插件页面时 Esc 无法正常关闭弹窗的问题，并限制插件页面资源读取，避免过大文件导致无界内存分配。

  **Plugin dialogs and resources**: Fixed Escape handling when a plugin page has focus, and bounded plugin resource reads to avoid unbounded memory allocation for oversized files.

- **Windows 本地终端输入**：自动提交普通命令时使用适合 Windows 本地 PTY 的回车，显式控制序列及关闭自动换行的输入保持原样。

  **Windows local terminal input**: Automatically submitted ordinary commands now use a carriage return for Windows local PTYs. Explicit control sequences and input with automatic newlines disabled remain unchanged.

- **版本与构建日期**：修复欢迎语一直显示 `v1.0.6` 的问题。版本自动跟随应用版本，Build 日期固定为构建日期；本次构建显示 `LyShell v2.0.1 Build: 2026-10-12 by Liangyou`。

  **Version and build date**: Fixed the welcome banner being stuck at `v1.0.6`. The version now follows the application version and the Build date is fixed at build time. This build displays `LyShell v2.0.1 Build: 2026-10-12 by Liangyou`.

### 📖 文档 / Documentation

- 更新中英文 README 和当前界面截图，补充插件视图、画卷式查找、统一环境变量及 MCP 截图能力说明；修正配置路径、启动权限与公开仓库链接，并移除过时配图。

  Updated both READMEs and interface screenshots, documented plugin views, scroll-style search, shared environment groups and MCP screenshots, corrected configuration paths, launch permissions and public repository links, and removed obsolete images.

### 📦 Windows 下载 / Windows Downloads

- `LyShell-2.0.1-x64-setup.exe`：Windows x64 安装版，支持 Windows 10 / 11，可选择安装目录并创建快捷方式。

  `LyShell-2.0.1-x64-setup.exe`: Windows x64 installer for Windows 10 / 11, with a selectable installation directory and shortcuts.

- `LyShell-2.0.1-x64-portable.exe`：Windows x64 便携版，支持 Windows 10 / 11，免安装运行。

  `LyShell-2.0.1-x64-portable.exe`: Windows x64 portable executable for Windows 10 / 11; runs without installation.

## [2.0.0] - 2026-10-08

LyShell 2.0.0 带来可扩展的插件界面、更完整的内嵌网页体验，以及统一的画卷式设置与终端查找界面。本次更新整理了 1.0.9 之后的主要改进，并加强插件、连接和子进程的资源回收。

LyShell 2.0.0 introduces extensible plugin interfaces, a more complete embedded browser experience, and consistent scroll-style settings and terminal search panels. This release brings together the main improvements since 1.0.9 and strengthens cleanup for plugins, connections, and child processes.

### ✨ 新增 / New Features

- **插件界面与弹窗**：插件可以在左侧机柜栏添加自己的 HTML 视图，支持声明式配置和常驻插件运行时注册。视图切换时保留状态，可打开终端、网页、文档及交互弹窗，并接收弹窗结果与主题变化事件。提供声明式和运行时两套示例。

  **Plugin views and dialogs**: Plugins can add their own HTML views to the left activity rail through declarative manifests or runtime registration by persistent plugins. Views retain their state when switching panels, can open terminals, web pages, documents, and interactive dialogs, and receive dialog results and theme events. Declarative and runtime examples are included.

- **画轴材质选择**：在设置中选择胡桃木、玉石、漆器或瓷器材质；材质独立于主题保存，并应用到画轴与终端查找窗。

  **Scroll materials**: Choose walnut, jade, lacquer, or porcelain in settings. The choice is saved independently of the theme and applies to scroll rods and the terminal search panel.

- **自动演示场景**：通过 `--demo-stage` 显式启用演示控制，按固定场景展示手册、本地终端、Agent、MCP 审计及插件页面，便于录制产品演示。

  **Automated demo scenes**: Explicitly enable demo controls with `--demo-stage` to present fixed scenes covering the manual, local terminal, agents, MCP audit, and plugins for product recordings.

### 🔄 体验改进 / Improvements

- **安装目录**：选择安装位置后自动追加 `LyShell` 子目录；所选目录已经以 `LyShell` 结尾时不重复追加，判断不区分大小写。网络共享根目录始终追加子目录。

  **Installation directory**: Automatically adds a `LyShell` subfolder unless the selected folder already ends in `LyShell`, compared without case sensitivity. Network share roots always get a subfolder.

- **网页页签保活**：切换页签和移动分屏时保留页面实例与状态，减少重复加载；关闭页签时释放资源。

  **Web tab persistence**: Keep page instances and state when switching tabs or moving split panes, reducing reloads. Closing a tab releases its resources.

- **网页弹窗处理**：完善新窗口、目标页签和 POST 表单弹出的处理，并修复抖音网页布局。

  **Web popups**: Improved handling of new windows, target tabs, and POST form popups, with a layout fix for Douyin pages.

- **设置与机柜布局**：重整设置面板、统一画轴样式、收紧面板及分组间距，提升侧栏控件和标题栏按钮的可读性。

  **Settings and activity rail**: Reworked settings, consistent scroll styling, tighter panel and group spacing, and clearer activity rail controls and title bar buttons.

- **终端查找**：查找窗改为可拖动的画卷样式，改进大小写、正则、全词匹配和搜索范围选项，提供非法正则提示及更清晰的匹配状态。

  **Terminal search**: A draggable scroll-style search panel with improved case-sensitive, regex, whole-word, and search-scope controls, invalid-regex feedback, and clearer match status.

- **浅色终端可读性**：为浅色主题调整 ANSI 配色，加深容易看不清的亮黄、亮青及白色文字，并保留多色区分。增加低对比度彩色文字补偿，改善程序输出的 256 色和真彩色文字及选中文字的可读性；自定义底色变化时，终端配色与对比度设置同步生效。

  **Light-theme terminal readability**: Adjusted the ANSI palette to make bright yellow, cyan, and white text clearer on light backgrounds while preserving color distinctions. Added contrast compensation for low-contrast 256-color and true-color output, improved selected-text readability, and synchronized terminal colors and contrast settings when the custom background changes.

### 🐛 稳定性修复 / Stability Fixes

- **安装协议显示**：修复 Windows 安装向导中中英文许可证的中文乱码。

  **Installer license display**: Fixed garbled Chinese text in the bilingual license shown by the Windows installer.

- **插件退出与卸载**：完善禁用、卸载、异常退出和应用退出时的清理，回收插件创建的连接、页签、视图、弹窗及受控子进程；修复异步清理和重启竞态。

  **Plugin shutdown and uninstall**: Improved cleanup on disable, uninstall, crashes, and application shutdown. Connections, tabs, views, dialogs, and controlled child processes created by plugins are released, with fixes for asynchronous cleanup and restart races.

- **运行环境隔离**：避免开发环境变量影响插件子进程，并加入渲染异常兜底，减少异常导致的黑屏。

  **Runtime isolation**: Prevented development environment variables from affecting plugin subprocesses and added a renderer error fallback to reduce blank screens after rendering failures.

- **临时会话启动**：修复临时本地终端等会话的启动流程。

  **Transient session launch**: Fixed the launch flow for transient sessions, including local terminals.

### 📦 Windows 下载 / Windows Downloads

- `LyShell-2.0.0-x64-setup.exe`：安装版，可选择安装目录并创建快捷方式。

  `LyShell-2.0.0-x64-setup.exe`: Installer with a selectable installation directory and shortcuts.

- `LyShell-2.0.0-x64-portable.exe`：便携版，免安装运行。

  `LyShell-2.0.0-x64-portable.exe`: Portable executable that runs without installation.

目前公开发行以 Windows x64 为主，支持 Windows 10 / 11。

Public releases currently focus on Windows x64, supporting Windows 10 / 11.

### 🧩 插件兼容说明 / Plugin Compatibility

本次升级将主版本号改为 2。仅声明 `engines.lyshell: "^1.0"` 的旧插件会显示版本兼容警告，当前不会因此阻止安装。插件作者应在验证后更新支持范围；使用本次新增视图能力的插件建议声明 `"^2.0"`。

This update changes the major version to 2. Older plugins declaring only `engines.lyshell: "^1.0"` will show a compatibility warning; this currently does not block installation. Plugin authors should update their supported range after validation. Plugins using the new view APIs should declare `"^2.0"`.

## [1.0.9] - 2026-09-27

### ✨ Features
### ✨ 新增 / Features

- **Workspace directory groups**: Agents, Claude, Codex, and dsh workspaces are grouped by working directory. Each group and all groups can be folded; groups with the same directory name show a distinguishing parent fragment and a visible number.
- **Web visit groups**: recent visits are grouped by domain, with an entry to open a visit in the mini browser.
- **工作目录分组**：Agents、Claude、Codex 和 dsh 工作区按工作目录分组，支持单组及整栏折叠。同名目录显示可区分的父目录片段和序号。*Agents, Claude, Codex, and dsh workspaces are grouped by working directory, with per-group and all-group folding. Same-named directories show a distinguishing parent fragment and number.*
- **网页访问分组**：最近访问按域名分组，并可从历史记录打开迷你浏览器。*Recent web visits are grouped by domain, with an entry to open a visit in the mini browser.*

### 🔄 Changed
### 🔄 变更 / Changed

- **Cleaner rack lists**: Env and Plugins now use flat paper lists without noninteractive decorative rods. Workspace paths appear once in group headers instead of on every card.
- **Easier scroll controls**: clickable wall rods have a 24 px hit area while keeping their 5 px visual thickness.
- **Mini browser lifecycle**: switching rack tabs keeps the mini browser page alive; closing it releases its resources.
- **机柜列表更简洁**：变量组和插件改用平铺纸面列表，移除无操作的装饰辊；工作目录集中显示在分组标题，不再逐张卡片重复。*Env and Plugins use flat paper lists without noninteractive decorative rods. Workspace paths appear once in group headers instead of on every card.*
- **画轴更易点击**：可点击画轴的热区扩大到 24 px，视觉轴体仍保持 5 px。*Clickable wall rods have a 24 px hit area while keeping their 5 px visual thickness.*
- **迷你浏览器状态保留**：切换机柜页签时保留页面状态，关闭页面时释放资源。*Switching rack tabs keeps the mini browser page alive; closing it releases its resources.*

### 🐛 Bug Fixes
### 🐛 修复 / Bug Fixes

- Improved web navigation and loading-state handling, and fixed duplicate dsh Web launches and process cleanup.
- **网页与启动稳定性**：改进网页导航和加载状态处理，修复 dsh Web 重复启动及关闭后进程未及时回收的问题。*Improved web navigation and loading-state handling, and fixed duplicate dsh Web launches and process cleanup after closing.*

## [1.0.8] - 2026-09-12

[中文说明](#中文说明) · [English](#english)

---

### 中文说明

本版主线是**全屏命令面板**（`Ctrl+Shift+P` 一处直达所有入口，含清点文档与内置使用手册）与**终端运行时编码切换**（UTF-8 / GBK / GB2312 状态栏直切）；同时为 Harness 工作区引入**权限档位**与危险态界面，页签改为 **Edge 式收缩**，并修复终端字体加载竞态、搜狗输入法 Shift 丢字等问题。

#### ✨ 新功能

##### 全屏命令面板（本版主线）

- **`Ctrl+Shift+P` 唤起全局命令面板**：全屏浮层聚合所有入口——保存 / 运行中的会话、Agent、dsh / codex / claude 工作区、变量组、插件、网页与设置页签，模糊搜索直达；与空状态命令屏共用命令集，`/new` 新建会话、`/local` 直连本地终端、`/help` 打开使用手册、`/ls` 打开清点文档；ESC 或关闭命令退出。页签条尾也新增打开面板的入口。
- **清点文档**：`/ls` 在文档页签中生成会话 / Agent / 变量组 / 三个 harness 工作区 / 插件的全量清单，`/ls <对象>`（如 `/ls env`、`/ls claude`）为单节子清单；内容为时点快照，重跑或点页签刷新按钮重新清点；清单内的 `lyshell-action://` 动作链接可直接跳转打开对应对象。
- **内置使用手册**：`/help`（可带 chinese / english 参数）在文档页签打开中英文使用手册，渲染管线复用 DocPanel（大纲轨 / 缩放 / 主题）。

##### 终端运行时编码切换

- **状态栏直切 UTF-8 / GBK / GB2312**：connector 热替换 iconv 解码流，跨切换边界的切分多字节不烂；重连保持当前编码，关闭重开回落保存值；本地会话恒 UTF-8（ConPTY 无编码层，拒绝切换）。
- 编码值统一净化（`@shared/encoding`）：仓库加载 / 保存与 IPC / MCP 入口同一口径，local 归一 utf-8、非法值回落 utf-8。
- MCP `lyshell_create_session` 新增 `encoding` 参数（复用未连接会话时连接前落位、失败不回滚）。
- 终端读数（编码 / 字号 / 尺寸等）迁移到会话侧栏底部；窄宽度两级降级（行数 <300 / 尺寸段 <260，迟滞 6px 防反复横跳）。

##### Harness 权限档位

- **工作区新增权限档位，启动即生效**：
  - Codex：`:read-only` / `:workspace` / `:danger-full-access` 三档，启动拼 `-c default_permissions=<档位>`；
  - Claude：`default` / `acceptEdits` / `plan` / `bypassPermissions` 四档，启动拼 `--permission-mode <mode>`，bypass 档拼 `--dangerously-skip-permissions` 直连 flag。
- **危险态界面**：选到全开放档位时表单给出显著视觉提示。
- 历史布尔开关 `skipPermissions` 自动迁移为 `bypassPermissions` 档。

##### 页签与界面

- **页签 Edge 式收缩**：页签多时只缩不滚（无地板宽度），页签条尾部保留新页签位；悬停详情卡展示完整标题。
- **变量组启用收敛为全局单选**：同一时刻全应用至多一组通电（dsh / codex / claude 与 dsh Web 共用一根指针），点亮新组即熄灭旧组，再点一次回落系统环境变量。
- 面板头条图标钮与卡片操作样式全站统一（IconBtn），六个面板视觉语言一致。

#### 🐛 修复

- **终端字体加载竞态**：woff2 未就绪时留下脏度量，导致「字号往返后字体变样」；改为字体就绪（loadingdone）后重测 + 门闩拦截竞态窗口。
- **字号步进手感**：设置面板此前失焦才派发、按住会连跳（「−2 假象」）；改为步进实时派发，并放开 1px 步进。
- **PTY resize 防抖**优化，减少 resize 风暴下的抖动。
- **搜狗输入法 Shift 丢字**：搜狗中文态敲字母后按 Shift 切英文，字母不再被静默吞掉（根因是 xterm 对纯修饰键 keydown 的标志位误伤 insertText，与上游 xtermjs#6054 同根因，已打补丁）。
- **焦点接管**：命令面板等浮层开着时，后台异步挂载的会话不再越权抢走键盘焦点；面板关闭后焦点悬空时，可见的活动终端自动接回。
- **浮层 ESC 统一回退栈**：全应用 ESC 改为模块级 LIFO 栈，仅栈顶消费，杜绝裸 `\x1b` 透传到远端 PTY；浮层层叠时按栈序逐层回退；两步确认（如删除二次确认）一次 ESC 只退一层；带 IME 守卫（isComposing），中文输入态不再误关浮层。
- **dsh Web 默认工作区吃不到变量组凭据**：此前无绑定工作区的 dsh Web 启动只注入附加变量，结构化核心（`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`）从未物化注入；现与 TUI 启动走同一份解析链。

#### 🔄 升级说明

- 变量组启用指针从三根（dsh / codex / claude）收敛为一根：升级时按 dsh → codex → claude 顺序保留首个既有指针，无需手动操作。
- Harness 工作区的历史 `skipPermissions` 布尔开关自动迁移为 `bypassPermissions` 档。
- 终端编码为运行时值不落盘：重连保持当前编码，关闭重开回落到会话保存值（默认 UTF-8）。

---

### English

The headline of this release is a **full-screen command palette** (`Ctrl+Shift+P` — one place to reach everything, including inventory docs and a built-in user manual) and **runtime terminal encoding switching** (UTF-8 / GBK / GB2312, switchable straight from the status bar). It also introduces **permission tiers** with a danger-state UI for Harness workspaces, moves tabs to **Edge-style shrinking**, and fixes the terminal font-loading race and the Sogou IME Shift character loss.

#### ✨ New Features

##### Full-screen command palette (headline change)

- **`Ctrl+Shift+P` opens the global command palette**: a full-screen overlay aggregating every entry point — saved and running sessions, agents, dsh / codex / claude workspaces, variable groups, plugins, web and settings tabs — with fuzzy search to jump straight to any of them. It shares the command set with the empty-state command screen: `/new` for a new session, `/local` for an instant local terminal, `/help` to open the user manual, `/ls` for the inventory doc; ESC or a close command dismisses it. The tab strip also gains an entry to open the palette.
- **Inventory docs**: `/ls` renders a full inventory of sessions / agents / variable groups / the three harness workspaces / plugins in a document tab; `/ls <object>` (e.g. `/ls env`, `/ls claude`) yields a single-section sub-inventory. Content is a point-in-time snapshot — rerun or hit the tab's refresh button to re-inventory; `lyshell-action://` action links inside the doc jump straight to the corresponding object.
- **Built-in user manual**: `/help` (optionally with a chinese / english argument) opens the user manual in a document tab, reusing the DocPanel pipeline (outline rail / zoom / theme).

##### Runtime terminal encoding switching

- **Switch UTF-8 / GBK / GB2312 straight from the status bar**: the connector hot-swaps the iconv decoder stream, so multi-byte characters split across a switch boundary don't corrupt; reconnects keep the current encoding, close-and-reopen falls back to the saved value; local sessions are always UTF-8 (ConPTY has no encoding layer — switching is refused).
- Encoding values are sanitized through a single gate (`@shared/encoding`): repository load/save and IPC / MCP entry points share one policy — local normalizes to utf-8, invalid values fall back to utf-8.
- The MCP `lyshell_create_session` tool gains an `encoding` parameter (applied before connecting when an unconnected session is reused, and left in place if the connection fails).
- Terminal readouts (encoding / font size / dimensions) move to the bottom of the session sidebar, with two-level degradation at narrow widths (row count <300 / size segment <260, 6px hysteresis to prevent flapping).

##### Harness permission tiers

- **Workspaces gain permission tiers, applied at launch**:
  - Codex: three tiers — `:read-only` / `:workspace` / `:danger-full-access` — passed as `-c default_permissions=<tier>`;
  - Claude: four tiers — `default` / `acceptEdits` / `plan` / `bypassPermissions` — passed as `--permission-mode <mode>`, with the bypass tier passing the `--dangerously-skip-permissions` flag directly.
- **Danger-state UI**: selecting a fully-open tier shows a prominent visual warning in the form.
- The legacy `skipPermissions` boolean migrates automatically to the `bypassPermissions` tier.

##### Tabs & UI

- **Edge-style tab shrinking**: tabs shrink as they multiply (no scrolling, no floor width), with the new-tab slot reserved at the end of the strip; a hover detail card shows the full title.
- **Variable group activation collapses to a single global switch**: at most one group is live app-wide (dsh / codex / claude and dsh Web share one pointer) — lighting a new group dims the old one; clicking the lit one again falls back to the system environment.
- Panel header icon buttons and card action styles are unified across the app (IconBtn) — six panels now speak one visual language.

#### 🐛 Fixes

- **Terminal font-loading race**: a not-yet-ready woff2 left stale metrics behind, making the font look different after a size round-trip; metrics are now re-measured once the font is ready (loadingdone), with a latch guarding the race window.
- **Font-size stepping feel**: the settings panel used to dispatch only on blur and skip values while a key was held (the "−2 illusion"); stepping now dispatches in real time, and 1px steps are unlocked.
- **PTY resize debouncing** improved, reducing jitter during resize storms.
- **Sogou IME Shift character loss**: typing letters in Sogou's Chinese state and pressing Shift (to switch to English and commit the letters) no longer silently swallows them (root cause: xterm's flag for plain modifier-key keydowns eating insertText events — same root as upstream xtermjs#6054; patched locally).
- **Focus takeover**: with an overlay like the command palette open, sessions mounting asynchronously in the background no longer steal keyboard focus; when the palette closes with focus left dangling, the visible active terminal takes it back.
- **Unified ESC back-stack for overlays**: ESC is now handled by an app-wide module-level LIFO stack — only the top of the stack consumes it, so a bare `\x1b` never leaks to the remote PTY; stacked overlays retreat layer by layer in stack order; two-step confirmations (e.g. delete double-confirm) retreat one layer per ESC; an IME guard (isComposing) keeps Chinese composition from dismissing overlays.
- **dsh Web default workspace missing variable-group credentials**: a dsh Web launch without a bound workspace only injected the enabled group's extra variables — the structured core (`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`) was never materialized; it now shares the same resolution chain as TUI launches.

#### 🔄 Upgrade notes

- The variable group activation pointers collapse from three (dsh / codex / claude) to one: on upgrade the first existing pointer is kept in dsh → codex → claude order — nothing to do manually.
- The Harness workspace legacy `skipPermissions` boolean migrates automatically to the `bypassPermissions` tier.
- Terminal encoding is a runtime value and is not persisted: reconnects keep the current encoding; close-and-reopen falls back to the session's saved value (default UTF-8).

## [1.0.7] - 2026-09-04

The headline of this release is a **rework of environment variable groups** — a global group library, structured credentials, and a dedicated management panel. It also adds **document tabs** (read-only preview), **Ctrl+click** link opening in the terminal, a **Lark light theme**, and agent / harness hosts now prefer **PowerShell 7**.

### ✨ New Features

#### Environment variable groups (headline change)

- **Global group library**: the three per-kind variable group stores (dsh / codex / claude) merge into a single global library (`env-profiles.json`); "enabled" becomes a per-kind pointer, so one group can be enabled for several kinds at once. Existing data migrates automatically on startup (idempotent; the old file is kept as `.bak`).
- **New "Environment Variables" entry in the left rail**: all group CRUD is consolidated into one global panel. The dsh / codex / claude switches on each card are both indicator and control — click to point that kind's enabled pointer at this group, click again to fall back to the system environment; an "n references" count reads back explicit bindings from agents and workspaces, with the referencing parties listed on hover.
- **Structured core — Base URL + API Key**: credentials are injected via a per-consumer mapping — on the harness side dsh→`DEEPSEEK_*`, codex→`OPENAI_*`, claude→`ANTHROPIC_*`; generic agents declare their own mapping via `envKeyMap`, and without one only the extra variables pass through. On key collisions the structured core wins.
- **Explicit group binding for generic agents**: resolution chain is bound group → inline env → system environment; dangling bindings are rejected at save time.
- **Hardening & normalization**: agent env is sanitized on write (empty keys / non-string values dropped, so dirty data never reaches node-pty); the masked row editor is unified across agents and harness (sensitive keys masked, with an eye toggle for plaintext).

#### Document tabs

- New document tabs with read-only preview — multiple can be open and split. Four entry points: double-click in the file tree, drop onto the window, `Ctrl+Shift+O` to open the system file dialog, or Ctrl+click a path in the terminal.
- Links inside documents resolve through a unified merge (including relative paths in the SSH docs).

#### Terminal

- `Ctrl+click` in the terminal: URLs open in a web tab, paths open in document preview — no more copying into a browser.

#### Agent / Harness host shell

- Agents and harness workspaces now prefer **PowerShell 7** as the launch shell: the system PATH, WindowsApps aliases, and well-known install locations are probed, so a freshly installed pwsh is picked up without restarting the app. Without pwsh, behavior is unchanged — user-created local sessions are unaffected.
- The pwsh host adds `-NoProfile`: an interactive profile's `Set-Location` no longer silently overrides the workspace / worktree cwd, keeping the host transparent.

#### Themes & UI

- New **Lark** light theme (Feishu-style: cool-gray chrome + pure-white canvas + ink-blue text + brand-blue focus).
- Web tabs show the site favicon and adapt to light / dark themes.
- Panel tabs and the rack layout language are unified; the MCP activity chip moves to the bottom of the left rail.

#### Misc

- Harness worktree and default names switch to timestamps: the worktree key becomes `<kind>-<workspace-name>-<seconds-level timestamp>` (creation time is readable, replacing the random code), and empty names default to `Workspace-<minute-level timestamp>`.

### 🐛 Fixes

- **Shortcut conflict**: opening a local document moves from `Ctrl+O` to `Ctrl+Shift+O`, no longer stealing the terminal's `^O` control character — vim's jump-to-previous-position and bash's operate-and-get-next work again.
- **Panes**: fixed drag-and-drop and overlay splitting on empty panes.
- **Persistence robustness** (variable group / agent / workspace repositories):
  - unified atomic writes (temp file + rename), so a mid-write crash no longer leaves a truncated JSON behind;
  - save and delete failures are no longer silent — the form stays open with the reason shown, and errors distinguish "record not found" from "write failed";
  - the ENV panel warns when extra variables contain another protocol's credential keys, suggesting folding them into the core or splitting the group, to prevent credential cross-talk.
- **Session dedup & cloning**: the dedup key and same-config check now compare `shellArgs` — the same shell with different arguments (e.g. `pwsh -NoProfile` vs interactive pwsh) is no longer misjudged as one session; `cloneSession` now deep-copies arrays, removing shared references across the disk boundary.
- `LocalConfig` is unified into a single definition in `@shared/types`; the connectors-side copy and its dead fields are gone.

### 🔄 Upgrade notes

- Existing variable groups migrate to the global library and are structured (Base URL / API Key) on first launch; the original file is kept as `.bak` — nothing to do manually.
- The MCP `lyshell_create_session` `local` parameter deliberately does not expose `shellArgs` (internal plumbing only); interactive terminals keep default-shell behavior — the external surface is unchanged.

## [1.0.6] - 2026-08-28

### ✨ Features

- **Readable Harness worktree names**: worktree-isolated workspaces now get a stable, human-readable key (`<kind>-<name>-<code>`, e.g. `claude-myrepo-x7k2`) generated on first launch and persisted — no more UUID-suffixed directories. The workspace edit dialog previews the resulting worktree path and lets you pick an existing key from the repo.
- **In-place legacy worktree migration**: workspaces previously launched under the old `<kind>-<id>` key are migrated on next launch — the directory is `git worktree move`d and the branch renamed in place, uncommitted changes carry over, so a saved workspace keeps the exact tree it had last time.
- **Serialized launch resolution**: harness launch (read record → resolve worktree) is serialized per workspace, closing the concurrent-double-launch race that could roll back a just-persisted key or hand out a stale path.
- **Claude skip-permissions toggle**: per-workspace switch that appends `--dangerously-skip-permissions` to the Claude launch command (worktree isolation recommended when enabled).
- **Generic web tab with recent history**: any URL can be opened as a web tab, with recent-visit history; the dsh Web tab and MCP audit view ride the same mechanism.
- **Harness session tab brand badges**: terminal tabs for harness sessions show which agent (dsh / codex / claude) spawned them.
- **Named environment variable groups**: harness environment variables moved from inline editing to reusable named groups, with Codex upstream configuration support.
- **Browser-style tab row**: terminal tabs promoted to a first-class top row with sidebar-collapse L-shaped inset; quick commands merged into the session rail and the bottom status bar removed.

### 🔄 Changed

- **Harness detection caching**: dependency detection results are cached per session instead of re-probing on every panel open.
- **Workspace dialog layout**: selecting an env profile auto-fills the model field (manual edits opt out); name/model fields are single-row, env-profile section moved above the skip-permissions section.

### 🔒 Security

- **Sensitive variable masking**: environment-variable values marked sensitive are masked in the Harness UI instead of shown in clear text.

### 🐛 Bug Fixes

- **MCP / web tab interaction & split-pane drag**: fixed focus conflicts between the MCP view and web tabs, plus drag glitches when dropping on pane edges.
- **dsh web embedded launch**: appends `--no-open` when embedding in the webview so the system default browser is no longer spawned alongside.

## [1.0.5] - 2026-08-19

### ✨ Features

- **First-class codex & claude agents**: `codex` and `claude` join `dsh` as first-class Harness agents — each gets its own left-rail tab, a dedicated workspace list, dependency detection, and per-workspace model & environment variables.
- **Shared Harness framework**: `dsh` was migrated onto a generic framework (detect / cwd / storage / launch), with the three agents' IPC channels registered from a single loop instead of three copies of duplicated logic.
- **Instant PATH refresh**: the environment now reads the registry PATH live and injects it consistently across local sessions, `dsh web`, and dependency detection — newly installed CLIs are picked up without restarting the app.
- **Per-workspace model for codex/claude**: the model is passed as `codex --model <model>` / `claude --model <model>` (left blank to omit); environment defaults are `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
- **dsh Web tab drag-to-split**: the dsh Web tab can now be dragged — to a pane's center to remount it, or to an edge to split into its own pane; the webview is hidden during the drag so it doesn't swallow drag events.
- **Overlay pane keep-alive**: empty panes hosting the dsh Web / MCP audit view are no longer accidentally removed by pane cleanup.

### 🔄 Changed

- **dsh Web entry reworked**: the per-workspace globe icon is gone — the panel title is now the single Web UI entry, opening `dsh web` at the dsh-specific `$DSH_HOME/web` directory, decoupled from the TUI workspace list.

### 🗑️ Removed

- **Workspace pinning**: the workspace pin (置顶) control and its `setPinned` IPC, introduced in v1.0.4, have been removed.

### 🔒 Security

- **Model-name whitelist**: codex/claude model strings are validated against a strict `[A-Za-z0-9._:-]` whitelist before being appended as `--model`. This is the sole defense against command injection, since model strings are typed into an interactive shell via the PTY. Covered by a new `launch.test.ts` suite.

### 🐛 Bug Fixes

- **Sessions panel drag reset**: the drag handler now resets `draggedIndex` on `onDragEnd`, fixing rows stuck in the dragging state when dropped on an invalid target.

### 🎨 Polish

- Harness panel title / workspace header restyled for clearer visual hierarchy, and the environment-variable fill button was de-crowded from its hint text.

## [1.0.4] - 2026-08-17

### ✨ Features

- **DeepSeek Harness workspace**: a dedicated panel for managing DeepSeek Harness workspaces — create, edit, pin, and delete, with per-workspace environment variables (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DSH_HOME, …) and model presets.
- **TUI & Web UI launch**: each workspace can open in a terminal TUI (`dsh-tui`) or an embedded Web UI. The Web UI is spawned as `dsh web --port 0`, its real port parsed from stdout, and rendered inside LyShell as a `<webview>` tab.
- **Web UI behaves like a terminal tab**: closable via ✕ and switchable back and forth — switching away hides it while keeping the page state and subprocess alive, and only ✕ tears it down.

### 🔒 Security

- Web UI navigation and popups are locked to the workspace's loopback origin; the echoed URL is validated (loopback + explicit port, no embedded credentials) before the `<webview>` ever loads it.

### 🐛 Bug Fixes

- Workspace `cwd` is now validated on save and launch (expands `~`, must be an absolute existing directory).
- Workspace storage is hardened: dedup by id, reindex on load and delete, rollback on save failure.
- Workspace deletion now requires a two-step confirmation.
- The DSH web subprocess is fully reclaimed on every exit path — tab close, window close, pane merge, dragging the last terminal away, and rapid workspace switching.

## [1.0.3] - 2026-08-14

### ✨ Features

- **Multi-format MCP registration**: MCP registration now emits JSON / CLI / TOML configs and unifies panel monospace fonts for direct client integration.
- **Agent icon redesign**: rounded robot head with a smile and `round` line caps.
- **Rack bar icon upgrade**: icons enlarged to 24px with hover scale, active glow, and an online breathing animation.
- **Persistent quick-command bar**: the quick-command bar is now always visible with a "New" button, plus required name / command validation.
- **Settings merged into the rack bar**: settings now lives in the left rack bar's bottom slot; removed the title-bar ⚙ and floating panel.

### 🐛 Bug Fixes

- **Terminal auto-focus**: auto-focus the terminal after creating a session or switching tabs, limited to the active, unhidden instance to avoid focus contention.
- **First-column text drift**: switched to a Unicode 15 width table with floating-point width measurement, fixing first-column drift with CJK / emoji.

### 📖 Docs

- Documented plugin sub-process isolation and new MCP tools in the README.

## [1.0.2] - 2026-08-12

### 🧩 Plugin System

A full plugin host with per-plugin capability gates, token-based auth, and local dev installation UI. Plugins run inside the host with scoped API tokens
  (Python one-shot/persistent, Node.js persistent); they can also spawn controlled external processes that connect back over stdio MCP. Install from a dev
  directory, ZIP, or URL  all sandboxed behind granular capability gates.

  🛡 MCP Security & Audit

  - Activity audit panel  real-time MCP call log with calendar picker, filtering, and pagination, accessible from the title bar
  - Destructive command confirmation guard
  - Per-session token model with fine-grained capability toggles (read / interactiveWrite / execute / localExecute / fileWrite / sessionControl /
  sessionMetadataWrite)
  - Built-in brand icon matching by command name + emoji picker overlay
  - Agent sessions are now transient (never leak into the session list)

  🖥 Terminal

  - Canvas now follows light/dark theme with a unified terminal background color
  - CJK IME candidate positioning fixed
  - First-column text drift on xterm resize eliminated
  - Ctrl+F1F12 shortcuts now work even when the terminal is focused

  🪟 Window

  - Built-in Chinese and English language bundles

  🔧 Fixes

  - Closing a tab now fully removes the runtime session entry  no more leaked temporary sessions
  - File transfer Worker security hardening
  - Settings panel split into Terminal / MCP tabs with improved readability
  - Status bar cols  rows indicator now clickable to clear screen (Ctrl+L), scrollback line counter clickable to scroll to bottom / double-click to clear

### 基础能力 / Baseline capabilities

- 首个对外发布的 Windows 便携版（x64）。*First public Windows portable release (x64).*
- 支持 SSH、Telnet、串口、本地 PTY 四类连接。*SSH, Telnet, serial, and local PTY connections.*
- 内置 SFTP 文件管理、快捷命令、AI Agent 启动栏、Python 脚本引擎。*Built-in SFTP file manager, quick commands, AI Agent launcher, and Python scripting engine.*
- 新增插件系统（Python / Node.js 两种运行时，支持开发目录 / ZIP / URL 安装）。*Plugin system with Python and Node.js runtimes, installable from a dev directory, ZIP, or URL.*
- 提供 MCP HTTP API，供外部工具与 AI Agent 编排终端会话。*MCP HTTP API for external tools and AI agents to orchestrate terminal sessions.*

[Unreleased]: https://github.com/liangyou09/lyshell/compare/v2.0.2...HEAD
[2.0.2]: https://github.com/liangyou09/lyshell/releases/tag/v2.0.2
[2.0.1]: https://github.com/liangyou09/lyshell/releases/tag/v2.0.1
[2.0.0]: https://github.com/liangyou09/lyshell/releases/tag/v2.0.0
[1.0.9]: https://github.com/liangyou09/lyshell/releases/tag/1.0.9
[1.0.8]: https://github.com/liangyou09/lyshell/releases/tag/1.0.8
[1.0.7]: https://github.com/liangyou09/lyshell/releases/tag/1.0.7
[1.0.6]: https://github.com/liangyou09/lyshell/releases/tag/1.0.6
[1.0.5]: https://github.com/liangyou09/lyshell/releases/tag/1.0.5
[1.0.4]: https://github.com/liangyou09/lyshell/releases/tag/1.0.4
[1.0.3]: https://github.com/liangyou09/lyshell/releases/tag/1.0.3
[1.0.2]: https://github.com/liangyou09/lyshell/releases/tag/1.02
