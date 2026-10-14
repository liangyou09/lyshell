# PetLink 宿主设置与聊天入口：LyShell 侧交付

2026-10-14。宿主侧源码修改在 `D:/workspace/claude/LyShell`，未修改 AIPet 源码、未替换或重启用户现有正式实例。接口以 [双方契约](petlink-host-settings-contract.md) 为准。

## 已实施行为

- `POST /api/plugins/ui/open` 接收 `{target:'chat2'|'settings',pluginId:'aipet'}`。只接受匹配插件的有效 host token，逐次核对当前启用状态、当前安装授权与 token 的 `uiControl`。UI/global/session/dshBridge token、冒充 ID、额外 URL/未知字段均拒绝；成功响应只返回目标与插件 ID。
- 恢复、显示并聚焦 LyShell 主窗口，经过既有同窗口动作回执链定位目标。Chat2 使用本插件已注册 `chat2` 视图；保活集复用原 guest，重复点击不产生第二个窗口/guest。设置入口选择本插件第一个注册设置视图；用户返回通用设置后再次请求仍会重新定位。动作成功表示目标面板已提交，不代表 PetLink 后台页面已加载完成。
- `contributes.settings` 通用声明式贡献。与普通视图合计最多 8 项、跨组 ID/HTML entry 唯一，走现有文件真实路径包围、资源协议、partition、guest/preload 和权限检查。`plugin:list` 返回设置元数据 `surface:'settings'`。设置项只显示在设置分类选择器，不增加机柜轨槽位。禁用/卸载立即销毁对应设置及聊天 guest。
- `frameOrigins` 可选属性仅允许唯一、规范的 loopback HTTP(S) origin，最多 8 项。默认 `frame-src 'none'`；有声明时仅放宽 frame-src。主 frame 保持本插件资源协议导航，子 frame/重定向只允许当前视图已声明来源；关闭子 frame Node integration，preload 仅主 frame 暴露 `lyshellView`，main 再以 senderFrame 主框架身份拒绝子 frame IPC。
- 正常禁用/卸载/重启/应用退出前先经 host IPC 等待 async `deactivate()`：每插件 host 限时 7s，main 限时 7.5s，多插件并行。此阶段保留插件 enabled、host token、HTTP 与共享工作台后台，供 PetLink 完成 release；随后撤权并沿用进程树清理。Windows 不再依赖无法可靠执行 JS handler 的 SIGTERM。异常退出仍立即撤权；并发 restart/stop 的代次检查防旧操作复活宿主。Windows/Linux 主窗口关闭的 DSH 清理移到此优雅退出之后。
- `/api/exclusive-control/*` 的工作台打开与鉴权契约保持原有行为。PetLink 无托盘/插件模式、本地 React 页面、配置 adapter、owner 退出，由父会话负责 AIPet 侧实施。

## 修改文件

共享契约与校验：

- `src/shared/plugin-types.ts`、`src/shared/plugin-types.test.ts`
- `src/shared/plugin-host-ui.ts`

HTTP、宿主和 IPC：

- `src/main/mcp/http-server.ts`
- `src/main/plugin/host-ui.ts`、`src/main/plugin/host-ui.test.ts`
- `src/main/plugin/view-registry.ts`、`src/main/plugin/view-registry.test.ts`
- `src/main/plugin/view-protocol.ts`、`src/main/plugin/view-protocol-core.ts`、`src/main/plugin/view-protocol-core.test.ts`
- `src/main/plugin/view-actions.ts`、`src/main/plugin/view-actions.test.ts`、`src/main/plugin/view-bridge.ts`
- `src/main/plugin/host-mgr.ts`、`src/main/plugin/host-mgr.restart.test.ts`、`src/main/plugin-host/index.ts`
- `src/main/plugin-host/index.lifecycle.test.ts`（真实子进程启动/停机竞态回归）
- `src/main/ipc/handlers.ts`、`src/main/ipc/validation.ts`、`src/main/ipc/plugin-uninstall.cleanup.test.ts`
- `src/main/index.ts`
- `src/preload/index.ts`、`src/preload/plugin-view.ts`

宿主 UI：

- `src/renderer/components/Layout/MainWindow.tsx`
- `src/renderer/components/Layout/SettingsPanel.tsx`、`SettingsPanel.css`、`SettingsPanel.plugins.test.tsx`
- `src/renderer/locales/zh.json`、`src/renderer/locales/en.json`

文档：本报告与 `docs/petlink-host-settings-contract.md`。

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过。保留既有 dynamic/static import 与大 chunk 警告，无构建错误。
- `npm run test -- --maxWorkers=4 --minWorkers=1`：最终复审后 147 个测试文件通过，1 个跳过；2192 项通过、5 项跳过。最终日志为 `tmp/review2-tests-final.log`。
- 修改的 TS/TSX 文件 ESLint：0 错误、51 个既有 `no-explicit-any` 警告。新引入的 hook dependency 警告已修复。
- `git diff --check`：通过。
- impeccable detector 对实际改动 UI：`[]`。保留现有侧栏/主题/设置排版；实际 900px 窗口截图显示分类选择器、设置内容和通用设置无挤压。隐藏 Electron 实例的首次 1200px guest 合成截图未及时绘制 iframe，不能当作真实内容截图；功能验证使用实际 iframe DOM/加载/桥权限断言。

完整日志与脚本保存于本 checkout 的 `tmp/petlink-host-ui/`（被 Git 忽略的 QA 证据，不随发布打包）：

- [最终测试日志](../tmp/petlink-host-ui/vitest-final.log)
- [构建日志](../tmp/petlink-host-ui/build.log)、[lint 日志](../tmp/petlink-host-ui/lint.log)
- [宿主端到端结果](../tmp/petlink-host-ui/e2e-results.json)
- [实际 AIPet 壳联测结果](../tmp/petlink-host-ui/real-shells-results.json)、[联测日志](../tmp/petlink-host-ui/real-shells.log)
- [应用退出日志](../tmp/petlink-host-ui/quit.log)、[退出阶段凭据观察](../tmp/petlink-host-ui/grace-observation.json)
- [设置截图 900px](../tmp/petlink-host-ui/settings-900.png)、[通用设置截图](../tmp/petlink-host-ui/settings-general.png)

## Codex 亲自复审与修复

逐项读取全部未提交源码、测试与关联调用链，发现并复现了启动期停机 IPC 丢失：原 handler 在所有 `activate()` 完成之后才注册，启动中的停机请求会被入口 `started` 守卫丢弃。修复前两个真实子进程测试失败，修复后通过。现在 health 回连/清单加载阶段保留请求，激活前就注册停机处理；正在激活的插件等激活落定后清理，未启动的插件收到停机后不再激活，重复请求共享一次清理，等待仍受 7s 预算约束。新增 4 个回归覆盖这些路径和挂住的激活。

修复后亲自再次核对 HTTP 身份/当前权限、同窗口回执、iframe 来源和主 frame 桥隔离、设置切换、禁用/卸载/退出次序，未发现剩余可证明问题。类型检查、构建、全量测试、`git diff --check` 通过；全量 ESLint 0 错误、100 条警告。重跑真实 Electron 宿主入口/禁用测试及应用退出测试均通过；通用设置截图在 DOM 切换和重绘后重新取得并目视确认。证据位于 `tmp/review2-*.log`。联测边界仍如下所述，不代表真实 AIPet 模型任务的完整端到端验证。

最后一轮还复现并修复了禁用等待期间安装记录替换的竞态：旧请求不得禁用同 ID 的新安装。禁用路径增加与卸载一致的记录身份检查；执行实际 IPC 回调的两个新回归分别验证禁用/卸载都拒绝旧请求，保留新插件启用状态。最终重新运行全部检查通过。

## 真实 Electron 联测与边界

`tmp/petlink-host-ui/e2e.cjs` 启动真实构建后的 LyShell 主进程/IPC/HTTP/plugin host/renderer/webview，使用独立 `profile/lyshell-dev` 档案。BrowserWindow 隐藏，未读取用户配置。测试插件用真实 `spawnControlled` 子进程获得 host token，并发起真实 HTTP；token 没有写入结果或输出。

断言覆盖：安装与注册设置元数据、两种目标成功信封、Chat2 重复请求同 guest ID、iframe 的主 frame 有桥而子 frame 无桥、设置重新定位、实际 Chromium CSP 拒绝远程 iframe（`ERR_BLOCKED_BY_CSP`）、3.1s 异步 deactivate 完成前仍通过 host-token HTTP 鉴权、禁用后全部 guest 摘除与子进程回收。

`real-shells-e2e.cjs` 只读复制以下真实 AIPet 文件到测试插件：`lyshell-plugin.json`、`views/` 全部文件、`pets.svg`。清单仅将启动入口替换为受控 QA driver，保留真实 contributes/schema/路径/CSP 声明。实际 `chat2.html`、`settings.html`、`host-page.js/css` 在真实插件资源协议下完成握手、加载固定 `http://127.0.0.1:31517/ui/chat/` 与 `/ui/settings/`、主题 bootstrap、iframe sandbox 与权限隔离检查。

31517 在测试时已有监听者（PID 12496），因此没有运行真实 AIPet `main.js` 去接管该实例。只在测试 LyShell 的独立 `pluginviews:aipet` session 使用 `protocol.handle('http', ...)` 模拟固定来源；用户的 partition/监听端口/进程不受影响。此阶段验证了双方真实清单和页面壳与 LyShell 的一致性，未验证真实 AIPet React 配置表单在宿主窄侧栏中的布局、实际配置保存、真实 PetLink tray/launcher shutdown 或模型任务 release。父会话已另行报告其独立 React 表单/IPC/HTTP/WS/owner 退出验证；双方真实进程全链路验证应在完全隔离且 31517 空闲的环境进行。

`quit-e2e.cjs` 在完成禁用检查后重新启用测试插件，再执行应用退出。主窗口销毁后的 deactivate HTTP 请求返回 503 `main window is unavailable`，不是 401/403：证明此时 HTTP、host 身份、插件 enabled 与 uiControl 仍有效。3.1s 清理完成后才停止 host/HTTP，进程正常结束。它验证宿主退出次序，未模拟真实模型任务。

复现入口为 `node_modules/.bin/electron.cmd tmp/petlink-host-ui/<e2e|real-shells-e2e|quit-e2e>.cjs`。重跑前只清除此 QA 目录的 `command.json` 与 `response-*.json`，避免旧命令/响应参与断言；无需关闭现有应用。所有脚本都是本机独立 fixture，真实 AIPet 启动入口不会被执行。

LyShell 侧实现和验证已完成。未部署/安装新版本；真实双方应用发布与 AIPet 模式行为的最终交付由父会话整合。
