# 浏览器宿主接口与只读试点

## 宿主边界

公共契约在 src/shared/browser-host.ts。renderer/browser/browser-host.ts 的 WebviewBrowserHost 与 ReadonlyViewBrowserHost 实现相同的 BrowserHostClient 导航、状态、焦点、截图和关闭接口。

默认继续使用原 webview。React/常驻层仍拥有 DOM 创建与最终卸载，注册表只复用代理；常驻层通过 applyBrowserHostPresentation 同步原 CSS 布局和 bounds/visibility 观测，未改 shelf 的许可、原生身份、休眠或恢复协议。renderer 移除 DOM 后只能得到 close-unconfirmed，既有 main shelf runtime 的 destroyed 证据仍是原生资源关闭事实。

原生试点由 main/browser/browser-host.ts 的 BrowserHostService 管理，实际 Electron 适配在 readonly-view-pilot.ts。IPC 使用 browser-host:request，输入由 browser-host-validation.ts 拒绝未知字段和越界值。owner 的 WebContents、顶层 frame、当前文档均由主进程核对，不接收 renderer 自报 owner/分区/preload 路径。

## Stage A 当前迁移范围

这次是指定入口的渐进迁移，尚未完成全应用 webview 调用替换。

| 目标 | 已经过代理的调用 |
| --- | --- |
| components/Layout/web-tab-controls.ts | 活动普通网页页签的导航、后退/前进、刷新/强刷、停止；注册时复用同一元素的代理 |
| components/Layout/TaskShelfBrowserBar.tsx | 地址提交、后退/前进能力读取及动作、刷新/停止 |
| components/Layout/WebTabLayer.tsx | 文档是否加载的 URL/加载态读取、程序性 focus、导航可用性读取、错误页后退/重试；常驻层 CSS 布局经 applyBrowserHostPresentation 写入并观测 bounds/visibility |
| components/Layout/WebPanel.tsx | 活动页签导航可用性读取；迷你浏览器的 URL/导航可用性读取、导航、后退/前进、刷新/强刷、停止及错误页重试 |

这些组件仍由 React 创建和移除真实 webview；dom-ready、导航、标题、加载、崩溃等事件监听仍直接绑定 DOM 元素，guest WebContents ID、POST 首航认领、迷你窗口登记和部分 JSX 显隐仍沿用原生调用。代理的 bounds/visibility 观测没有接管整套 DOM 布局或全部显隐状态。

下列范围尚未迁移：

- plugin-web-tab.ts 的插件网页就地导航仍直接 loadURL；getWebview() 仍保留原始元素导出，供这些既有调用者使用。
- task-shelf-web-frame.ts 的既有网页截图/预览仍直接 capturePage；WebTabDevTools.tsx、WebTerminalTools.tsx 的 guest 身份和专用工具链，以及 commands/demo-updates.ts 的 URL/加载态/guest ID 查询仍走原路径。
- PaneView.tsx 的 dsh/共享工作台 webview，以及 PluginViewPanel.tsx/PluginViewDialog.tsx 的插件 webview，仍使用各自创建、事件、权限与资源生命周期。
- 已有 main 的网页/登录/弹层宿主、安全许可、账号 partition、shelf 休眠/恢复和插件页面协议没有整体搬进 BrowserHostService。新增服务只管理独立的只读 WebContentsView 试点。


## 默认关闭的单只读场景

只有启动隔离验证实例时显式设置 LYSHELL_READONLY_VIEW_PILOT=1 才启用 create-readonly-pilot。没有设置时 capabilities 返回 pilotEnabled:false，不创建 View，也不改变现有页签实现。

试点是独立的只读文档预览入口，不接管 Tasks/shelf、插件或已登录页签。全局同时最多一个原生 host，包括 closing/close-unconfirmed 的实例。每实例使用新的 shelf-readonly-v1:<随机UUID> 内存分区，复用 initializeReadonlySession、applyReadonlyPreferences、readonlyProtection 以及打包的 shelfReadonly preload。只允许无凭据、无 query/hash 的 HTTP(S) 文档；脚本、表单、权限、下载和非允许资源仍由既有契约阻断。不会迁移用户账号或放宽 partition/preload/导航权限。

### 组合根接线

主入口在 registerIPCHandlers 相邻位置调用：

    const browserHosts = registerBrowserHostIpc()

正常退出将 browserHosts.shutdown() 登记到现有总期限内。它返回各实例关闭快照；只有 phase:closed 代表 view 已从父容器移除，且 WebContents 已确认 destroyed。close-unconfirmed 必须保留原句柄与容量用于核对，不代表已经停止。

### 隔离验证示例

在已登记的可信应用顶层文档中，调用 preload 的 browserHostRequest。不要在用户生产实例上切换环境或权限。

    const created = await window.electronAPI.browserHostRequest({
      kind: 'create-readonly-pilot', url: 'http://127.0.0.1:<fixture-port>/'
    })
    // 成功后保存 created.snapshot.handle；后续请求始终携带该句柄。
    await api({ kind: 'attach', host })
    await api({ kind: 'bounds', host, bounds: { x: 20, y: 80, width: 640, height: 480 } })
    await api({ kind: 'visibility', host, visible: true })
    await api({ kind: 'focus', host })
    const preview = await api({ kind: 'capture', host })
    const closed = await api({ kind: 'close', host })
    // 核对 closed.snapshot.phase === 'closed'，否则保留为未确认。

bounds 使用应用窗口内容区坐标，原生适配将矩形限制在该 owner 窗口内。hostId 为随机标识，generation 必须精确匹配。关闭、owner 导航/销毁、代际变化后，迟到操作和截图结果不能回写新实例。每个原生 host 最多一项在途截图，第二项立即 RESOURCE_LIMIT；成功、失败与撤权都在 finally 归还占位。截图响应内容上限为 8MiB；这不是 RSS 承诺。

ReadonlyViewBrowserHost 的 subscribe 以 500ms 周期读取快照，最多一个 inspect 在途；最后一个订阅注销、close 发起或 dispose 都会清理定时器与监听器。并发 close 复用同一 Promise，确认 closed 后拒绝新动作和订阅，但保留 snapshot 与重复 close 的完成回执。旧 poll/动作回执在 close/dispose 后不再推送。close-unconfirmed 或失败后可显式 inspect/再次 close，不自动恢复旧订阅。dispose 只清理代理观察，原生资源必须显式 close，或由 owner 失效/应用 shutdown 清理。

## 验收边界

自动回归验证 owner/frame/文档拒绝、随机句柄代际、迟到结果、单实例容量、分离的 detach/destroyed 证据、关闭未确认、截图并发与失败回收、默认禁用、只读原生适配、webview 保活与导航行为。

GUI 覆盖层/z-order、分屏拖动、中文 IME、混合 DPI、截图观感、安装产物和完整进程内存对比必须由主代理独立执行。自动测试和开发产物加载不代替这些验收。试点尚未据此扩大迁移。
