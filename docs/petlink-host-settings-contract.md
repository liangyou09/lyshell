# PetLink / LyShell 宿主 UI 契约

状态：LyShell 侧已实施并验证（2026-10-14），详见 [交付报告](petlink-host-settings-report.md)。本文件供 AIPet 侧直接读取。

## 宿主打开入口

`POST /api/plugins/ui/open`，HTTP header `x-lyshell-token` 使用插件真实 host token。
body 严格为 `{ "target": "chat2" | "settings", "pluginId": "aipet" }`。
要求：有效 host plugin token（拒绝 UI/global/session/dshBridge）、token.pluginId 与 body 一致、插件已启用，token 与当前安装授权均包含 `uiControl`。

- `chat2`：定位本插件已注册 id 为 `chat2` 的普通视图，恢复/显示/聚焦 LyShell 主窗口，打开机柜栏原有 Chat2 视图。重复点击复用保活 guest，不打开 PetLink 自己窗口，不触动共享工作台。
- `settings`：定位本插件第一个已注册设置视图，恢复/显示/聚焦主窗口，切到 LyShell 设置并选择该插件设置页。
- 响应：`{ success: true, data: { target, pluginId } }`。成功需 renderer 确认已接收并挂载目标；不返回任何凭据或端口。错误：401 无效/已撤销 token，403 身份/权限/启用检查失败，400 body 非法，404 没有注册目标，503 主窗口不可用/renderer 超时。
- 不进入通用 MCP 工具列表；不得使用页面 UI token 直接调用。

## 通用插件设置注册

使用 manifest `contributes.settings` 数组，每项形状与 `contributes.views` 完全相同：

```json
{
  "capabilities": ["uiControl"],
  "contributes": {
    "views": [{ "id": "chat2", "title": "聊天2", "entry": "views/chat2.html", "connectOrigins": ["http://127.0.0.1:31517"] }],
    "settings": [{ "id": "settings", "title": "PetLink", "entry": "views/settings.html", "connectOrigins": ["http://127.0.0.1:31517"] }]
  }
}
```

- 两种贡献合计最多 8 项，跨两组 ID 和 entry 均不得重复。entry 必须是插件 `views/` 内本地 HTML，文件包围/CSP/partition/preload 与现有 plugin view 完全一致；不接受任意远程页面 URL。
- 设置贡献仅出现在 LyShell 设置页插件选择器，不增加机柜轨槽位。`plugin:list` 的 `views` 合并两种贡献，设置项附 `surface: 'settings'`；未指定 surface 的旧视图仍为普通轨道视图。
- 页面通过现有 `window.lyshellView` 插件页面桥 bootstrap/themeChanged/callApi 等能力工作；本机 PetLink 配置 API 使用声明的 connectOrigins。宿主不持有 PetLink 配置、不暴露 token。页面可在 PetLink 同源 UI 通道调用并保存设置。
- 禁用/卸载插件立即销毁嵌入设置 guest；重新启用后重新挂载。页面在宿主设置内运行，不创建独立设置窗口。

## 同源 PetLink 页面嵌入（已确认）

视图允许可选 `frameOrigins: ["http://127.0.0.1:31517"]`（最多 8 项，严格 loopback HTTP(S) origin、拒绝远程/路径/query/重复项）；未声明时 `frame-src 'none'`。父会话提供本地 `views/chat2.html` 与 `views/settings.html`，使用 sandbox iframe（仅 allow-scripts allow-same-origin），分别指向 `/ui/chat/` 和 `/ui/settings/`。

主 frame 仍只能导航本插件 `lyshell-plugin://` 资源；子 frame 导航及重定向只允许本视图 frameOrigins。强制 `nodeIntegrationInSubFrames: false`，preload 仅主 frame 暴露 `window.lyshellView`。main 的 guest IPC 检查 senderFrame 无 parent，子 frame 不获得宿主 API；iframe 通过 PetLink 同源配置 API/WS adapter 工作。

## 生命周期与双方所有权

LyShell 沿用 persistent 插件 host + spawnControlled 的启动/退出/禁用清理链；AIPet 侧实现插件模式无独立托盘、消息气泡转发此宿主接口、设置本地入口及清单。已有 `/api/exclusive-control/*` 共享工作台接口保持原契约。

正常禁用/卸载/宿主重启/应用退出：先经 host IPC 调用并等待 async `deactivate()`（host 每插件 7s，main IPC 7.5s 总有界等待，多插件并行）；此时该插件仍启用，host token、HTTP 与共享工作台后台仍有效，允许 PetLink 完成既有 release。之后再撤 token、停止 HTTP（应用退出时）并沿用进程树强制回收。崩溃/异常退出仍立即撤 token，无延迟授权。不会无限等待挂住插件。

LyShell 文件由本会话负责；AIPet/lyshell-plugin 文件由父会话负责。源码检查发现 LyShell 无独立 Chat2 组件，因此 AIPet 侧须确保 `chat2` 已注册为普通插件视图，建议清单声明以避免运行时注册竞态。
