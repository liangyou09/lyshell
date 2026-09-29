# 插件界面视图贡献点实施方案

> 目标：发布后，开发者仅通过插件包中的 `lyshell-plugin.json` 和 HTML/CSS/JS，即可贡献左侧机柜栏视图；支持自定义弹窗、终端/网页/文档动作、动态注册和切换保活。本文供实施智能体直接执行；各阶段均须满足相应验收条件。

## 产品契约

1. 一个插件最多贡献 8 个视图，**每个视图独占轨道槽位**。全链路统一用 `{pluginId, viewId}` 标识视图，不能仅以 pluginId 作页签或保活键。
2. 声明式视图不要求 `main` 入口或插件宿主进程。**Node persistent** 插件可在 `activate(api)` 动态注册/注销；Python persistent 没有 `LyShellPluginApi`，如需动态视图须使用同一 HTTP 注册路由和自身 host token。运行时视图仅在当前插件进程期间有效；重启后由 Node `activate` 或 Python 启动脚本重新注册。
3. 面板首次打开后常挂载，切走只隐藏；注销视图、禁用或卸载插件时销毁 guest。弹窗关闭即销毁。
4. 页面没有 token。所有页面调用以 guest 身份进入 main，由 main 执行权限校验。纯展示视图不需要 `uiControl`；UI 动作需要 `uiControl`，其中打开终端另需 `sessionControl`，打开文档另需 `read`。API 工具调用仍按原 HTTP 路由 capability 鉴权。
5. `openDialog` 只能打开本插件已注册的视图；结果只回到发起弹窗的那个 guest，多个同插件视图或并发弹窗互不串扰。

## 现有代码约束

- `McpCapability` 位于 `src/shared/api-routes.ts`，manifest capability 白名单位于 `src/shared/plugin-types.ts`。
- `src/main/plugin/host-mgr.ts` 不给没有 `main` 的插件签发 host token；oneshot token 运行结束即撤销。因此 UI 页面必须拥有**独立的服务端凭据生命周期**。
- `src/main/index.ts` 已有 webbar/dsh 的 webview attach、导航和弹窗闸。插件分支放在 dsh 默认分支之前，且不得放宽原有两类 webview 的规则。
- `src/main/ipc/handlers.ts` 的 `plugin:list` 由 `enrichEntry` 返回展示字段；`PluginPanel` 挂载后才调用 `plugin-store.load()`，所以轨道须在 `MainWindow` 启动时自行加载。
- `src/preload/index.ts` 与 `src/shared/constants/index.ts` 各有通道常量，新通道要同步。
- 主 renderer 的 CSS 图标请求走默认 session。仅给插件专属 partition 注册的资源协议不能直接作为 ActivityRail 的 `maskImage` URL。

## 一、共享类型与校验

在 `src/shared/plugin-types.ts` 增加：

```ts
interface PluginViewDefinition {
  id: string          // ^[a-z][a-z0-9-]*$，单插件内唯一
  title: string       // 非空，限制长度
  icon?: string       // 插件根目录内的 .svg 或 .png
  entry: string       // 插件根目录内的 .html
}
interface PluginViewMeta extends PluginViewDefinition {
  pluginId: string
  source: 'manifest' | 'runtime'
}
```

- `PluginContributes.views?: PluginViewDefinition[]`；`PluginListItem.views: PluginViewMeta[]`。禁用插件的 `views` 返回空数组，避免误入轨道。管理卡若要展示禁用前声明，另用展示字段。
- 提取可复用的 `validateViewDefinition`，manifest 与运行时注册使用同一规则：最多 8 项，禁止重复 ID；校验字段类型、长度、扩展名和相对路径。`entry` 必须位于插件的 `views/` 目录下，页面引用的 CSS/JS/图片/字体也放在该目录；`icon` 可在插件根目录内。拒绝空路径、盘符、绝对路径、`..`、NUL、URL 查询串/fragment。安装解压或 dev 文件夹确认后、运行时注册时，还要核实 entry/icon 文件实际存在且通过真实路径包围；ZIP 预览阶段仅能做清单字段校验。运行时与声明式 ID 冲突直接拒绝，不做覆盖。
- `McpCapability` 和 `VALID_CAPABILITIES` 同步加 `uiControl`。该 capability 只控制视图/UI 动作，不作为 MCP 工具。
- `src/shared/plugin-api.ts` 增 `registerView(def): Promise<void>` 与 `unregisterView(id): Promise<void>`，实现位于 Node 的 `src/main/plugin-host/api.ts`。Python persistent 可直接调用对应 HTTP 路由，文档给出请求格式；oneshot 插件不提供运行时视图的持续存在承诺，但仍可提供声明式视图。
- `NavTab` 插件键采用 `plugin:${pluginId}:${viewId}`，构造/解析放在单个纯函数中，禁止各组件自行拼接。

## 二、main：注册表、凭据和路由

### 视图注册表 `src/main/plugin/view-registry.ts`

- 声明式来源是已启用插件的有效 manifest；运行时来源是 `Map<pluginId, Map<viewId, PluginViewDefinition>>`。合并时按插件安装顺序、manifest 顺序和注册顺序稳定排序，总数上限含两种来源。
- `listViews()` 仅返回 enabled 项；`handlers.ts` 的 `enrichEntry` 必须从该注册表填充 `PluginListItem.views`，保证 `plugin:list` 与通知重拉返回同一数据。安装、启用、禁用、卸载、运行时注册/注销均广播 `PLUGIN_VIEWS_CHANGED`；先变更/撤权，再通知 renderer 重拉。dev 插件文件在磁盘上被外部编辑时不做实时监听，以重新启用或重新安装为刷新点。宿主重启时清除旧运行时项，允许新 `activate` 注册。
- 重复注册返回错误；注销不存在的运行时 ID 可幂等成功。禁用/卸载/注销触发对应面板与弹窗关闭。共享 Node host **异常退出**时清除其中所有插件的运行时视图，单个 Python persistent 进程异常退出时只清该插件的视图；同时撤对应 host token 并广播，不能只在正常 restart 时清理。声明式视图保持可用。

### UI 专用凭据

- 扩展 `src/main/mcp/auth.ts`，允许同一插件同时拥有 host token 与 UI token，不能让第二次 `bindPluginToken` 覆盖前者。保留现有 `bindPluginToken/revokePluginToken` **仅管理 host token** 的语义，另增 UI token 的 bind/revoke，并提供禁用/卸载使用的整插件撤销方法；`host-mgr.stop()/restart()` 对所有插件撤 host token 时，不得误撤仍启用插件的 UI token。两者最终均解析为带 pluginId 和当前授权 capability 的 plugin binding，但须标记 token 来源，运行时注册路由只接受 host token。
- 对每个已启用且有视图的插件建立 UI token，包括无 `main` 和 oneshot；**动态注册首个视图时同步建立**，注销最后一个视图时撤销。token 只留在 main，不传给 renderer、guest、preload 暴露对象或插件宿主。
- `handlers.ts` 的禁用/卸载路径须调用整插件撤销方法；权限变更撤销并按新授权重签该插件的 UI token。host 重启不能永久切断仍启用的声明式视图。每次调用重新核对 enabled、授权和 token 有效性。
- `callApi(tool,args)` 只允许 `API_ROUTES` 中具有 `http` transport 的工具。复用/抽取 `src/main/plugin-host/api.ts` 的路由查找、`:id` 替换、GET query/POST body 规则，再由 main 携 UI token 回环调用 HTTP server；HTTP 端负责最终鉴权和审计。返回实际响应或具体错误，并设置超时。

### 动态注册 HTTP 路由

- `POST /api/plugins/:id/views` 与 `DELETE /api/plugins/:id/views/:viewId`：要求有效 **host plugin token**、binding.pluginId 与路径 ID 相同、插件 enabled、生命周期为 persistent、已批准 `uiControl`。全局/session/UI token 和 oneshot 插件均不可调用。
- 路由用共享定义校验器；成功后修改注册表并广播，失败返回具体 4xx。复用 `auth.ts.resolveToken`，不另写 token 比对。
- `src/main/plugin-host/api.ts` 的 SDK 方法调用这两个路由，并明确处理宿主退出或禁用时的在途请求。

## 三、资源协议与 webview 隔离

### `src/main/plugin/view-protocol.ts`

- `app.ready` 前 `protocol.registerSchemesAsPrivileged` 注册 `lyshell-plugin`（standard、secure、supportFetchAPI、stream）。每个插件使用独立的内存 partition `pluginviews:${pluginId}`；guest 创建前，在对应 `session.fromPartition(...)` 注册只服务该 pluginId 的 handler。不要让所有插件共享一个会话或协议 handler。
- URL 格式 `lyshell-plugin://{pluginId}/{relativePath}`。handler 要求 URL host 与其 partition 绑定的 pluginId **完全一致**，再检查 enabled 和解码后路径；拒绝编码遍历/分隔符、反斜杠、NUL、空段、目录请求。普通资源 URL 不带查询串；弹窗入口只允许下述一次性 `dialogId` 查询参数，协议读取文件时不把参数拼进文件路径。先确认真实 `views/` 目录位于真实插件根内，再确认目标文件真实路径位于该 `views/` 目录内，防 dev 插件中的 symlink/junction 指向根目录其他文件或目录外。设置 MIME、`X-Content-Type-Options: nosniff`，失败返回 403/404。
- 协议只服务 `views/` 目录中的页面资源；manifest、主进程入口、插件根部文件及隐藏/凭据文件不在服务范围。测试 HTML 引用的 CSS/JS/图片/字体可加载，跨插件资源不可读取。图标另走下述受限入口。
- 主 renderer 图标用单独受限入口：IPC 只接收 pluginId/viewId，由 main 在已注册定义中查出 icon，不能接收 renderer 传来的任意文件路径。main 确认图标真实路径仍在插件真实根目录内，再读取 SVG/PNG，限制大小并净化 SVG（禁止脚本、外链和活动内容，或栅格化），返回数据供 `maskImage` 使用；图标失败回退 `IconPlugins`。不要在默认 session 开放完整插件文件协议。

### `src/main/index.ts` webview 闸

- `will-attach-webview` 插件分支要求 `partition === pluginviews:${pluginId}`。普通面板初始 URL 必须等于已注册视图入口；弹窗 URL 带 main 签发、限时、单次消费的 `dialogId` 参数，且与待挂载记录的窗口/pluginId/viewId/入口逐项匹配。由此确定 guest 的 panel/dialog 身份，不能仅凭 URL 相同或 renderer 声明推断。**main 强制指定官方 plugin-view preload 的打包绝对路径**，renderer 不提供 preload。强制 sandbox、contextIsolation、webSecurity 为 true，nodeIntegration 为 false。
- `did-attach-webview` 建立 `webContents.id → {pluginId, viewId, kind, ownerWindowId}`，销毁时清理。不得信任 renderer 自报 guest ID。主框架导航、重定向、子框架导航、`window.open` 及资源请求均限制在同一插件允许的资源域；拒绝其他插件及外部协议。
- `src/main/plugin/view-bridge.ts` 在**每次** guest IPC 核对 `event.sender` 登记、`event.senderFrame` 为主 frame、当前 URL 与 pluginId 一致、插件仍 enabled、权限仍有效。参数在 `src/main/ipc/validation.ts` 检查类型、长度、数量、URL 和路径。guest 不得调用主 renderer 专用 IPC。
- 插件 partition 拒绝非必要权限请求（媒体、通知、下载、外部协议）。HTML 响应默认 CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。插件 JS 放在 `views/` 下的外部脚本文件；不依赖内联或远程脚本。若实际 Electron 28 对自定义 scheme 的 `'self'` 解释不同，先用开发版探针验证，再做最小调整并保留禁止远程脚本的边界。

## 四、页面桥、动作与弹窗

`src/preload/plugin-view.ts` 用 contextBridge 暴露；在 `electron.vite.config.ts` 增加第二个 preload 入口，并核对开发版和打包版的输出路径：

```ts
window.lyshellView = {
  bootstrap(), callApi(tool, args),
  openTerminal({sessionId}), openWebTab({url}), openDoc({path}),
  openDialog({viewId, title, width, height}), closeDialog(result),
  onEvent(callback) // 返回 unsubscribe
}
```

- 公开结果类型固定为 `ActionResult = { ok: true } | { ok: false; error: string }`；`onEvent` 至少区分 `{ type: 'dialogResult', dialogId, result }` 与 `{ type: 'dialogCancelled', dialogId, reason }`。`ok: true` 表示终端创建请求被接受、网页页签已挂载或文档页签已成功读入，**不保证 SSH 最终连通或外站最终加载成功**。错误消息可展示，但不包含 token 或完整本地文件内容。`openDialog` 成功返回 `{ dialogId }`，失败直接拒绝 Promise。
- `bootstrap()` 的 pluginId/viewId/kind 由 main 已登记的 guest 身份派生，不接收页面自报身份。所有输入有尺寸上限；`closeDialog` 仅允许 dialog guest，结果限制为定长可序列化 JSON。
- `openTerminal` 要求 `uiControl` 和 `sessionControl`。main 验证真实 saved session，并复用或抽取 HTTP server 的会话允许/拒绝名单校验逻辑，再令 renderer 调 `connectSession(config)`；不能在页面动作路径另写一套不一致的名单判断。现有 `connectSession` 捕获错误并返回 `void`，须改为返回可判定结果或增加共用的结果型包装，并检查 `connection:connect` 返回的 `ERROR` 状态，不能无条件回 `ok: true`。
- `openWebTab` 要求 `uiControl`，URL 只接受 http/https，renderer 经 `usePaneStore.openWebTab` 返回真实执行结果。
- `openDoc` 要求 `uiControl` **和** `read`；main 用 `docKindFromPath`/`isDocPath` 加 `assertSafeLocalPath(...,{write:false})` 预检，renderer 调 `openLocalDoc`。现有 `openLocalDoc` 在读取失败时仍挂错误页签且返回 `void`，须增加结果返回或共用包装，明确失败回 `ok: false`；不把文档内容返回插件页。
- `openDialog` 要求 `uiControl` 且目标 `viewId` 属本插件。main 生成一次性 `dialogId`，先记录 `dialogId → 发起 guest、目标插件/视图、所属窗口、到期时间`，再让 renderer 用带该参数的入口 URL 挂载弹窗并钳制尺寸；attach 成功后补记目标 guest。只有该目标 guest 可 `closeDialog`，结果只发送给发起 guest。挂载失败、超时、发起者/弹窗销毁、注销视图或禁用插件时清理并通知取消。
- main→renderer 动作请求包含 requestId、所属窗口和已授权参数；renderer 回传实际成功/失败。main 只接受目标窗口的 `webContents` 对**仍待处理** requestId 的首次回执，忽略其他窗口、重复和过期回执。窗口关闭、超时或目标丢失返回确定错误，不能把 `{dispatched:true}` 当成功。审计记录插件 ID、动作及允许/拒绝，避免敏感全文。

## 五、renderer：初始化、轨道和保活

- `MainWindow` 初始化时调用 `plugin-store.load()`，订阅 `PLUGIN_VIEWS_CHANGED` 重拉；并发响应仅采纳最新一次。不能依赖 `PluginPanel` 首次挂载。
- `ActivityRail` 每个 `PluginViewMeta` 一个槽位，固定项之后稳定排序；轨道能滚动，底部设置槽始终可达。title 用 manifest 值，图标用受限图标数据。
- 保存的 `activeNav` 为复合键。加载插件列表后才恢复插件页；该视图不存在、被禁用或注销时回退 `sessions` 并修正本地存储。
- 保活 Map 以复合键为键。首次激活挂载一个 `PluginViewPanel`；切走隐藏且不可聚焦/交互；注销、禁用、卸载时卸载 guest 并关相关弹窗。崩溃和加载失败显示可重试状态。
- `PluginViewPanel` 仅使用 main 校验后的 URL 与该插件的 `partition='pluginviews:${pluginId}'`；`PluginViewDialog` 复用同一插件的 guest 安全设置但不保活。renderer 不传 preload 路径。
- 动作分发放在一个 `MainWindow` 订阅器，按 requestId 向 main 回执；卸载时解除订阅。避免 `sendToAllWindows` 导致多窗口重复执行。

## IPC 清单与实施顺序

建议通道：`PLUGIN_VIEWS_CHANGED`、`PLUGIN_VIEW_BOOTSTRAP`、`PLUGIN_VIEW_CALL_API`、`PLUGIN_VIEW_ACTION_INVOKE`、`PLUGIN_VIEW_DIALOG_CLOSE`、`PLUGIN_VIEW_ACTION_REQUEST`、`PLUGIN_VIEW_ACTION_RESULT`。实现时为每个通道写清发送者、接收者及请求/响应类型，同步共享常量、main handler/validator、两个 preload 和消费端。guest 与主 renderer 不能共用一个无身份检查的 handler。

启动顺序：ready 前注册 privileged scheme；ready 后先启动 HTTP server，再初始化视图注册表/UI token，并为当前 enabled 插件安装各自的协议 handler；随后启动 plugin host，注册 IPC handlers，最后创建主窗口。现有 `src/main/index.ts` 在创建窗口后才注册 IPC handlers，此处应调整，避免新窗口首屏的 `plugin:list` 早于 handler。运行时首次注册视图时也须先准备 UI token/partition handler，再广播变更。窗口可能错过启动阶段广播，因此初次 `plugin:list` 必须给出完整快照。

1. 共享类型、视图校验、复合键及纯逻辑测试。
2. 注册表、UI token 生命周期、插件状态通知；先验证无 `main`、oneshot 的声明式视图可列出。
3. 协议、图标入口、webview attach/导航/IPC 身份闸；先通过隔离测试再接动作。
4. `callApi` 路由复用、运行时注册 HTTP 路由、插件 SDK。
5. guest preload、renderer 启动加载、轨道、保活、弹窗与动作回执。
6. 示例、双语文档、capability 文案及打包验证。

## 验收条件

### 自动测试

- 定义校验：重复 ID、超过 8 项、非法扩展名、编码遍历、Windows 路径、空字段、声明式与运行时冲突。
- 协议：正常 HTML/CSS/JS/图片、禁用拒服、跨插件、symlink/junction 越界、敏感文件拒服、MIME/`nosniff`。
- 凭据：无 `main` 与 oneshot 的声明式视图可按授权 `callApi`；host/UI token 共存；禁用、卸载、权限变更后旧 token 即刻失效。
- 桥：伪造 guest ID、子 frame、跨插件导航、缺权限动作、guest 销毁、并发弹窗及取消回传；CSP 阻断内联/远程脚本而允许同插件外部 JS。
- renderer：同插件双视图各占一槽，启动恢复、注销回退、切换保活、禁用卸载清理、动作失败回执。
- 运行 `npm run typecheck`、`npm run lint`、`npx vitest run`、`npm run build`。

### 手动全链路

在 `npm run dev` 下安装示例：验证双视图、切换保活、无 `main` 页面只读 `callApi`、Node persistent 插件动态注册/注销、终端/网页/文档动作、弹窗结果与并发弹窗；另用 Python persistent 的 HTTP 请求验证动态注册/注销。禁用/卸载后槽位和弹窗即时消失，旧页面动作失败；重新启用及重启后声明式视图恢复，运行时视图由插件进程重新注册。再用打包版核对协议和 preload 路径。Electron 28 guest 行为不能仅凭纯函数测试确认。

## 示例与文档

- `examples/my-view-plugin/` 提供无 `main` 的纯声明式示例；另提供 persistent `main` 的运行时示例，使用 `activationEvents: ['onStartup']` 以保证启动重注册。演示四种动作的插件须声明并获批 `read`、`uiControl`、`sessionControl`，同时覆盖两个视图、`callApi` 和弹窗结果。
- 更新 `src/renderer/docs/manual.zh-CN.md`、`manual.en-US.md`：manifest 字段、权限含义、页面 API、Node SDK 与 Python HTTP 注册方式、运行时限制、资源路径和错误返回。补齐 ActivityRail、面板及授权卡的中英文文案。
- PR 描述列出新增 IPC 通道、共享类型、自定义协议和开发版/打包版的手动验证结果。
