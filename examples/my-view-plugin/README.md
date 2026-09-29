# my-view-plugin

LyShell **界面视图贡献点** demo（纯声明式）。无 `main` 入口、无插件宿主进程 —— 只靠 `lyshell-plugin.json` 的 `contributes.views` + `views/` 下的 HTML/CSS/JS，就向左侧机柜轨贡献了两个视图：

- **status**（带 `icon.svg` 图标）：面板视图。演示 `bootstrap()` 身份握手、`callApi`（只读工具 `lyshell_list_sessions`，需 `read`）、`openWebTab` 与 `openDialog` 动作（需 `uiControl`）、经 `onEvent` 接收弹窗结果。
- **picker**：被 `openDialog` 挂为弹窗的视图。列出会话后 `closeDialog(result)` 把点选结果只回给发起弹窗的 guest。

## 安装（dev 文件夹）

1. LyShell -> 设置 -> 插件 -> **添加 dev 插件**
2. 选本文件夹（`examples/my-view-plugin`）
3. 勾 `read` + `uiControl`（已在 manifest 声明；不勾 `uiControl` 时按钮动作会被拒绝，页面仍可展示）
4. 勾 **安装即启用**
5. 左侧机柜轨出现 **My Status** 槽位（在固定页签之后）；点开即挂载，切走仅隐藏（保活）

## 页面约定

- 页面**没有任何 token**；`window.lyshellView.*` 全部进入 main 后以登记 guest 身份执行、按插件当前授权逐次校验。
- 页面跟随 LyShell 明暗主题：`bootstrap().theme` 给当前模式（`dark`/`light`），切换时 `themeChanged` 事件推送；示例用 `<html data-theme>` + CSS 变量适配。
- CSP 由 main 下发（`script-src 'self'`）：JS 必须是 `views/` 下的外部文件，不能内联。
- 页面资源只能从本插件 `views/` 目录加载；图标经受限 IPC 读取（main 净化后回 data URL）。
- `ok:true` 只表示「请求被接受/页签已挂载」，不保证 SSH 最终连通或外站加载成功。

## 改哪里

- `views/status.js`：改 `refreshSessions()` / 按钮逻辑
- `lyshell-plugin.json`：`views` 增删视图（单插件最多 8 个；`entry` 必须在 `views/` 下，`icon` 可在插件根目录）
- 改完 dev 插件的视图文件：**禁用再启用**该插件（或重新安装）为刷新点（不做磁盘实时监听）

## 运行时注册？

本 demo 是纯声明式：视图随插件启停自动出现/消失。要看 Node 常驻插件 `activate(api)` 里 `api.registerView()` 的动态注册，见 `examples/my-view-runtime-plugin/`。
