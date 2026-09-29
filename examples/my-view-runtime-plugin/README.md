# my-view-runtime-plugin

LyShell **界面视图贡献点** demo（Node 常驻插件 + 运行时注册）。`lifecycle: "persistent"` + `activationEvents: ["onStartup"]`，在 `activate(api)` 里用 SDK 的 `api.registerView()` 动态注册视图：

- **dashboard**（声明式）：`callApi` 列会话（需 `read`）→ 每会话一个 `openTerminal` 按钮（需 `uiControl` + `sessionControl`），另演示 `openDoc`（需 `uiControl` + `read`）。
- **picker**（声明式）：被 `openDialog` 挂为弹窗的视图，`closeDialog(result)` 把点选结果只回给发起 guest（launcher）。
- **launcher**（**运行时注册**）：`api.registerView({ id: 'launcher', entry: 'views/launcher.html' })`。演示 `openWebTab`、`openDialog(picker)` 与经 `onEvent` 接收弹窗结果/取消。

## 视图来源两路

| 来源 | 何时存在 | 本例 |
| --- | --- | --- |
| 声明式（`contributes.views`） | 插件启用即有，随启停出现/消失 | dashboard、picker |
| 运行时（`api.registerView`） | 仅插件进程存活期间；禁用/卸载/宿主退出即清除 | launcher |

同插件合计最多 **8** 个视图，ID 不得冲突（运行时重复注册同 ID 被拒绝，不覆盖）。`onStartup` 保证 LyShell 重启后 activate 重放、launcher 自动重新注册。

## 安装（dev 文件夹）

1. LyShell -> 设置 -> 插件 -> **添加 dev 插件**
2. 选本文件夹（`examples/my-view-runtime-plugin`）
3. 勾 `read` + `uiControl` + `sessionControl`（manifest 已声明；`openTerminal` 缺 `sessionControl` 会被拒绝，`openDoc` 缺 `read` 同理）
4. 勾 **安装即启用**
5. 左侧机柜轨出现 **Dashboard / Session Picker / Launcher** 三个槽位；激活即触发宿主进程启动（persistent）并执行 `activate`

## 观察日志

宿主 `console.error`（stderr）由 host 捕获转 electron-log。应看到：

- `[my-view-runtime-plugin] activated (caps: read, uiControl, sessionControl)`
- `[my-view-runtime-plugin] runtime view "launcher" registered`
- `[my-view-runtime-plugin] N session(s) at activate`

禁用/卸载插件时：`deactivated (runtime views die with this process)`，且 **Launcher** 槽位即刻消失（dashboard / picker 声明式视图也一并移除）。

## 页面约定

与 `examples/my-view-plugin` 相同：页面无 token、main 侧按 guest 身份逐次校验授权；页面跟随明暗主题（`bootstrap().theme` + `themeChanged` 事件）；CSP 限定外部 JS；资源只能来自本插件 `views/`；`ok:true` 仅表示请求被接受。差异点：本插件额外需要 **persistent** 生命周期与 **uiControl** 才能用 `registerView`（host token 专有路由）；manifest 与 `registerView` 都支持 `icon` 字段（插件根目录内 `.svg`/`.png`），轨道槽位即显示自己的图标。

## 改哪里

- `views/*.js`：各视图逻辑；`main.js`：`activate`/`deactivate` 与运行时注册
- 改视图文件：**禁用再启用**插件为刷新点；改 `main.js` 同样需重启插件（禁用再启用）
