# LyShell v2.0.0 发行说明 / Release Notes

LyShell 2.0.0 带来可扩展的插件界面、更完整的内嵌网页体验，以及统一的画卷式设置与终端查找界面。本次更新整理了 1.0.9 之后的主要改进，并加强插件、连接和子进程的资源回收。

LyShell 2.0.0 introduces extensible plugin interfaces, a more complete embedded browser experience, and consistent scroll-style settings and terminal search panels. This release brings together the main improvements since 1.0.9 and strengthens cleanup for plugins, connections, and child processes.

## ✨ 新增 / New Features

- **插件界面与弹窗**：插件可以在左侧机柜栏添加自己的 HTML 视图，支持声明式配置和常驻插件运行时注册。视图切换时保留状态，可打开终端、网页、文档及交互弹窗，并接收弹窗结果与主题变化事件。提供声明式和运行时两套示例。

  **Plugin views and dialogs**: Plugins can add their own HTML views to the left activity rail through declarative manifests or runtime registration by persistent plugins. Views retain their state when switching panels, can open terminals, web pages, documents, and interactive dialogs, and receive dialog results and theme events. Declarative and runtime examples are included.

- **画轴材质选择**：在设置中选择胡桃木、玉石、漆器或瓷器材质；材质独立于主题保存，并应用到画轴与终端查找窗。

  **Scroll materials**: Choose walnut, jade, lacquer, or porcelain in settings. The choice is saved independently of the theme and applies to scroll rods and the terminal search panel.

- **自动演示场景**：通过 `--demo-stage` 显式启用演示控制，按固定场景展示手册、本地终端、Agent、MCP 审计及插件页面，便于录制产品演示。

  **Automated demo scenes**: Explicitly enable demo controls with `--demo-stage` to present fixed scenes covering the manual, local terminal, agents, MCP audit, and plugins for product recordings.

## 🔄 体验改进 / Improvements

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

## 🐛 稳定性修复 / Stability Fixes

- **安装协议显示**：修复 Windows 安装向导中中英文许可证的中文乱码。

  **Installer license display**: Fixed garbled Chinese text in the bilingual license shown by the Windows installer.

- **插件退出与卸载**：完善禁用、卸载、异常退出和应用退出时的清理，回收插件创建的连接、页签、视图、弹窗及受控子进程；修复异步清理和重启竞态。

  **Plugin shutdown and uninstall**: Improved cleanup on disable, uninstall, crashes, and application shutdown. Connections, tabs, views, dialogs, and controlled child processes created by plugins are released, with fixes for asynchronous cleanup and restart races.

- **运行环境隔离**：避免开发环境变量影响插件子进程，并加入渲染异常兜底，减少异常导致的黑屏。

  **Runtime isolation**: Prevented development environment variables from affecting plugin subprocesses and added a renderer error fallback to reduce blank screens after rendering failures.

- **临时会话启动**：修复临时本地终端等会话的启动流程。

  **Transient session launch**: Fixed the launch flow for transient sessions, including local terminals.

## 📦 Windows 下载 / Windows Downloads

- `LyShell-2.0.0-x64-setup.exe`：安装版，可选择安装目录并创建快捷方式。

  `LyShell-2.0.0-x64-setup.exe`: Installer with a selectable installation directory and shortcuts.

- `LyShell-2.0.0-x64-portable.exe`：便携版，免安装运行。

  `LyShell-2.0.0-x64-portable.exe`: Portable executable that runs without installation.

目前公开发行以 Windows x64 为主，支持 Windows 10 / 11。

Public releases currently focus on Windows x64, supporting Windows 10 / 11.

## 🧩 插件兼容说明 / Plugin Compatibility

本次升级将主版本号改为 2。仅声明 `engines.lyshell: "^1.0"` 的旧插件会显示版本兼容警告，当前不会因此阻止安装。插件作者应在验证后更新支持范围；使用本次新增视图能力的插件建议声明 `"^2.0"`。

This update changes the major version to 2. Older plugins declaring only `engines.lyshell: "^1.0"` will show a compatibility warning; this currently does not block installation. Plugin authors should update their supported range after validation. Plugins using the new view APIs should declare `"^2.0"`.
