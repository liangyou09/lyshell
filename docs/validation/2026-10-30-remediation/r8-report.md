# R8 浏览器宿主与只读试点实施记录

- 工作区：C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell
- 分支：codex/complete-remediation-20261030
- 实施/验证基线 HEAD：36739a6deb32bc45bf7dcbf29635cce9c306230c；工作区包含其他并行工作包未提交改动。
- 日期：2026-10-30，北京时间
- 模式：实施与自动化验证；未执行 GUI/图像检查、代码审查、提交或推送。

## 已实施

### 阶段 A

- 新增 shared/browser-host.ts 的 BrowserHostHandle/Snapshot/Request/Result 与 BrowserHostClient，renderer 的 webview 与 native 代理实现同一导航、观察、焦点、截图和关闭契约。
- renderer/browser/browser-host.ts 按原 WebviewTag 对象缓存代理；注册/页签移动不重建 guest。代理失效后拒绝迟到导航结果，DOM 移除只报告 close-unconfirmed，重复关闭幂等，不冒充 main 的 destroyed 证据。
- web-tab-controls、TaskShelfBrowserBar、WebTabLayer、WebPanel 的目标导航/前后/刷新/停止/焦点及导航态读取经过代理。常驻层原 CSS 布局写入经过 applyBrowserHostPresentation，同时观测 bounds/visibility；保留原布局、DOM挂载与事件处理。
- 原 shelf-browser-runtime 的许可、身份、partition、休眠与恢复协议未改。

### 阶段 B

- BrowserHostService 通过注入的端口与 owner/document 检查管理原生宿主，不依赖 Electron 窗口或入口注册模块，支持创建、附着、移除、导航、焦点、矩形、显隐、截图、原生崩溃状态与关闭。
- readonly-view-pilot.ts 复用既有 initializeReadonlySession/applyReadonlyPreferences/readonlyProtection 与打包 shelfReadonly preload，只创建全新内存只读分区，不迁移账号、不接管 shelf 或插件实例。
- 仅在内部环境变量 LYSHELL_READONLY_VIEW_PILOT=1 时开放专用只读文档预览入口；默认关闭。全局最多一个原生 host，未确认关闭继续占位。
- 新增 browser-host-ipc.ts、browser-host-validation.ts、preload.browserHostRequest 与 renderer createReadonlyViewPilot 消费者。所有 owner/frame/当前文档事实来自主进程；输入不能指定任意 owner、partition、preload 或 userData 路径。严格拒绝未知字段、伪造句柄代际及越界矩形。
- 关闭分别核对从窗口移除 view 和 WebContents destroyed；未确认保留句柄/容量供显式核对。文档主框架导航、崩溃或 owner 销毁会使旧 owner 失效并清理对应宿主。
- 每 host 原子限制一个在途 capture；并发直接 RESOURCE_LIMIT，成功、错误与旧结果拒绝均经 finally 归还。截图超过 8MiB 响应预算明确失败；关闭/撤权/代际变化后的旧截图不返回。
- 原生代理订阅使用 500ms 单一在途 inspect，取消末个订阅或 dispose 清理定时器；dispose 后不允许新订阅。

## 交付文件

- src/shared/browser-host.ts
- src/main/browser/browser-host.ts / .test.ts
- src/main/browser/browser-host-validation.ts / .test.ts
- src/main/browser/browser-host-ipc.ts / .test.ts
- src/main/browser/readonly-view-pilot.ts / .test.ts
- src/renderer/browser/browser-host.ts / .test.ts
- src/preload/index.ts（仅 browserHostRequest 导入/方法）
- src/renderer/components/Layout/web-tab-controls.ts、TaskShelfBrowserBar.tsx、WebTabLayer.tsx、WebPanel.tsx
- docs/browser-host.md（组合根接线、隔离调用与验收边界）

主入口 index.ts 由主代理接线：registerBrowserHostIpc()，返回的 shutdown() 进入正常退出总期限。未由本工作者覆盖 index.ts。

## 实际验证

日志记录命令、开始/结束 ISO 时间、HEAD、stdout/stderr 和退出码。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 完整本包与保护性回归 | 13 文件、182 项通过，退出 0 | r8-contracts.log |
| 之后按主代理反馈补截图并发/失败恢复/关闭旧图用例，再补代理关闭幂等和 dispose 订阅保护 | 最终相关 core+renderer 2 文件16项通过，退出 0；core含10项、renderer含6项 | r8-supplement.log |
| node/main 类型检查 | 通过，退出 0；最终补验也通过 | r8-typecheck-node.log、r8-supplement.log |
| renderer/preload/shared 类型检查 | 通过，退出 0；最终补验也通过 | r8-typecheck-renderer.log、r8-supplement.log |
| 受影响文件 ESLint | 0错误、0警告，退出 0；最终相关文件补验也通过 | r8-lint.log、r8-supplement.log |
| AST 架构门禁 | 484生产源文件，0违规、0运行时环、0静态环；21项动态导入单列，退出0 | r8-boundaries.log |
| git diff --check | 通过，退出0 | r8-diff-check.log |

182项整组回归发生在截图并发补丁前；补丁后仅重跑受影响的core/renderer回归及两套类型/lint检查，没有将未再次整体运行的184项集合冒充一次全量通过。

## 未验证与限制

- 本工作者没有执行 GUI、截图视觉、中文 IME、混合 DPI、覆盖层/z-order、分屏拖动或安装产物验收。
- 原生适配测试使用 Electron API 桩，不能代替真实 Electron；主代理负责隔离原生试点加载与关闭验证。
- 尚无完整进程内存对比、长期混合负载和已安装应用的证据；试点保持默认关闭，没有据此扩大宿主迁移。
- 专用试点入口不是对全部普通网页、插件页或 shelf 网页的迁移；现有账号与原 webview 继续由原架构管理。

## 原生代理关闭补修（主代理明确反馈后）

核对实际文件后确认此前原生代理 close 未停止订阅；之前实现幂等的是 DOM WebviewBrowserHost。现限定补修 ReadonlyViewBrowserHost：

- 并发 close 返回同一个 Promise；确认 closed 后重复 close 读取同一完成回执，不再发送 IPC。
- close 发起即停止 timer/listeners，并使旧观察回合失效。确认 closed 后拒绝新动作、inspect 和 subscribe；snapshot 与重复 close 仍可读取。
- 旧 poll/动作回执在 close/dispose 后不能覆盖快照或通知监听器；dispose 期间收到已发出 close 的真实 closed 回执可保留证据，但不会恢复通知。
- close-unconfirmed 或请求失败允许调用者显式再次核对，不自动恢复轮询。
- 补充并发关闭/迟到高 revision poll/终态拒绝、close中dispose、未确认后显式核对回归。

Stage A 的具体迁移目标与尚未迁移的调用逐项列于 docs/browser-host.md；没有宣称全应用 webview 已迁移。最终补修验证：代理测试1文件9项通过，renderer/preload/shared类型检查退出0，相关ESLint退出0（0错误、0警告），git diff --check退出0；日志为 r8-close-followup.log。

