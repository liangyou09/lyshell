# 帧同步与拖动流畅度验证（2026-10-28）

本次将视觉布局与 PTY 通知分开：终端在拖动过程中持续 fit，PTY 在尺寸事件停止 150ms 后接收最终尺寸。保留 DOM renderer、既有 IME 补丁、同一 xterm/PTY/webview 的生命周期，以及此前任务架功能改动。

## 实现

- 左侧栏、右侧任务栏和 SplitDivider 的指针事件按显示帧合并，只保留最新位置；pointerup、cancel、lost capture 提交最后位置，卸载取消排队更新。
- 拖动期间不写 localStorage 或后端宽度偏好；释放后持久化。任务栏不再因 reservedWidth 自身写入重复渲染，也不在每次宽度变动清零再恢复预留宽度。
- 终端的 ResizeObserver、window resize、pane-resize 共用调度器；本地 fit 每帧最多一次，PTY 尾部合并、同尺寸跳过。字体和页签恢复的直接通知同步比较基线，避免漏发或重复通知。
- 小窗几何先统一读取，再更新宿主。每轮共享侧栏和滚动区边界，不再对每个窗口重复测量祖先或 JSON 序列化比较。
- 终端宿主与网页常驻层直接订阅几何写样式；React 只处理显隐、输入权限和焦点归属等语义变化。交互宽度阈值改变时保留 surface 登记，不反复卸载/注册。
- 网页占位和实体按 ID 建索引，全部读完矩形再写样式；缩放和实例保留行为延续原实现。IME 位置锁在尺寸请求和实际 fit 前解除。

## 测量条件和口径

- Windows 11（10.0.26200），Intel i5-10505；Electron 43.7.11 / Chromium 150.0.7871.250。
- 3440×1440 显示器，缩放 100%，系统报告 59Hz；隔离窗口 1800×1080。GPU compositing、rasterization 启用，xterm 继续使用 DOM renderer。
- 独立档案、串行运行、生产模式打包的 React fixture。7 个真实 xterm 实例和 1 个真实 webview；性能场景的终端使用合成输出，网页每 200ms 更新时钟。另用真实 ConPTY 验证尺寸和输入输出。
- 每场景约 2.4 秒，4ms 定时器请求指针/滚动更新。实际事件数受主线程负荷影响，拖宽前/后为 326/430 次；轨迹均按经过时间计算。分屏场景使用真实 SplitDivider 和 pane-store。
- 帧率来自 Chromium trace 的 `Display::FrameDisplayed`（平台呈现反馈），不是 rAF 调用次数。持续动作使用窗口内呈现数/持续时间。收展仅统计各次 180ms 动画区间内的呈现间隔，排除面板静止时段；这两种统计口径分别标注，不能直接混比。
- 网页首航完成并等待 600ms 后开始，避免将导航阻塞算成拖动本身。早期并行启动污染的试跑已排除，正式结果为 `final-baseline` / `final-optimized`。
- 对照源码保存在 `tmp/frame-sync/baseline-source/`：从 HEAD 加回任务开始时既有功能差异，或从当前文件撤销本次性能改动；不回退当前工作区。两组共享相同 fixture、CSS、依赖和此前功能。

## 正式结果

| 场景 | 优化前窗口呈现/秒 | 优化后窗口呈现/秒 | 前/后 P95 呈现间隔 | 前/后最长间隔 |
| --- | ---: | ---: | ---: | ---: |
| 8 小窗持续拖宽 | 56.07 | 58.71 | 33.35 / 16.76ms | 33.41 / 33.36ms |
| 小窗列表持续滚动 | 59.04 | 59.53 | 16.78 / 16.87ms | 33.37 / 16.93ms |
| 真实分屏持续缩放 | 58.69 | 58.97 | 16.80 / 16.85ms | 66.73 / 16.97ms |

收展的**动画区间呈现间隔速率**为 57.71 → 59.95 帧/秒，最长区间内间隔 66.72 → 33.29ms。整段平均仅约 27 帧/秒，因为包含约 270ms 的静止等待，不能把这个数字解读为动画只有 27fps。每组 6 次收展。

| 同一拖宽场景 | 优化前 | 优化后 |
| --- | ---: | ---: |
| getBoundingClientRect 调用 | 17,067 | 1,863（下降约 89%） |
| 偏好存储写入 | 326 | 1 |
| 拖动期间本地 fit | 0 | 147 |
| 拖动期间终端列数变化次数 | 0 | 102 |
| 拖动期间 PTY 通知 | 0 | 0 |
| 停止后最终 PTY 通知 | 7（含隐藏终端） | 1（可见终端） |

滚动的矩形读取 3,773 → 1,744；真实分屏缩放时本地 fit 1 → 144、列数变化 1 → 120。分屏场景的前 1 次为召回/字号恢复，原实现随后等到停止才 fit。可见窗口持续呈现不等于终端内容跟手，因此列数变化与呈现数据分别记录。

这台机器上持续动作接近 60Hz；仍有零星 33ms 呈现间隔，不能承诺所有场景始终锁定 60fps。这里没有测量鼠标输入到屏幕像素变化的端到端延迟。

## 功能与工程验证

- 真实 ConPTY：连续改变宽度后只收到 1 次尾部 resize；xterm、node-pty 与子进程实际 `[Console]::WindowWidth/Height` 一致为 84×19。输入经 xterm paste → terminalWrite 到 cmd，输出返回同一 xterm。
- 终端宿主与占位 left/top/width 误差为 0px。收起后 hidden + inert；窗口隐藏/恢复、任务架收展后仍为同一 xterm 和 webview。
- 召回主区：终端字号 13 → 15，网页缩放 0.85 → 1，webContents ID 保持 2。截图由 Codex 查看，标题单行、16:9 预览和裁剪位置保持正常。
- 16 个相关测试文件、144 项通过，覆盖尺寸调度器、拖动合并/丢失捕获/清理、surface 权限与裁剪、网页几何/保活、任务架布局/交互、终端搜索、主页与项目启动回归。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。相关实现 ESLint 0 错误、11 个既有警告；界面检测器无发现。
- 原生 DeepSeek Harness 在同一后台实例/会话完成尺寸调度器及测试，Codex 亲自检查全部改动并集成验证。完成后释放本凭据租约；未重启用户 LyShell 或更改共享后台/权限。

## 限制与复现资料

未使用 Computer Use。中文输出已检查，真实中文系统输入法的候选框位置、搜狗 Shift 上屏和组合输入期间拖动尚未人工验证；未启用 WebGL。120/144/240Hz、macOS、其他 GPU/缩放比例和繁忙 TUI 输出时的表现尚未实测。左侧栏已采用相同帧合并与存储策略，但此 fixture 未挂载完整 MainWindow，表格不代表完整应用左侧栏的独立帧率实测。

隔离 webview 的预览捕获在前后两组均偶发输出 `UnknownVizError`；已有捕获失败兜底接住，真实页面输入、保活与位置验证通过。本次没有解决这个原生截图问题，也没有把它当作测量成功的证据。

原始数据、trace、截图和复现脚本均在 `tmp/frame-sync/`：

- `final-baseline.json`、`final-optimized.json`、`summary.json`、`toggle-animation-summary.json`。
- `final-*-trace.json`、`final-*.png`、`verify.json`、`verify.png`。
- `fixture.tsx`、`baseline-source.cjs`、`baseline-source/`、`build.cjs`、`server.cjs`、`static.cjs`、`measure.cjs`、`summarize.cjs`、`toggle-summary.cjs`、`verify.cjs`、`preload.cjs`。
- `regression.log`、`typecheck.log`、`app-build.log`、`lint.log`、`detector.json`。

复测时先启动 `node tmp/frame-sync/server.cjs`（4187）和 `node tmp/frame-sync/static.cjs`（4188），用 `node tmp/frame-sync/build.cjs` 打包，然后串行启动 Electron 脚本：`measure.cjs <独立结果标签> baseline|optimized`。PowerShell 应使用 `Start-Process -PassThru -WindowStyle Hidden` 并对返回进程 `WaitForExit()`，不要直接调用 Windows GUI 可执行文件后假定已经等待结束。每次使用独立档案；性能测量期间不并行跑构建或测试。

## 提交前复审补充（2026-10-28）

- 尾部通知前重新 fit 并检查可见性，修复帧完成后隐藏仍发送缓存尺寸，以及外部字号/页签路径更新后被旧尺寸覆盖的问题；两种竞态均先由新增测试复现，再验证修复。
- 覆盖层关闭与批量收纳只合并本次操作所在分屏，保留用户另行拆出的空位与焦点；补充普通与 retained 覆盖层的回归测试。
- 右键菜单测试同时覆盖窄栏卡片与宽栏小窗入口，继续检查收纳、归档、移除和 Escape 焦点恢复。

上表为首次性能测量记录。复审增加了每次尾部的一次状态重测，尚未重新采集性能 trace；不能将原始 fit 次数解释为复审后的计数。

本轮隔离 Electron/ConPTY 验收再次通过：拖宽尾部通知一次，xterm/PTY/控制台均为 84×19，输入输出正常，宿主矩形误差为 0px；收纳与召回保留终端和网页实例，字号 13→15、网页缩放 0.85→1。检查了本轮小窗截图；隐藏窗口的主区截图为空，未作为主区绘制成功的证据。中文系统输入法仍未人工验证。记录位于 `tmp/codex-review-fixture.json` 与 `tmp/codex-review-shelf.png`，实例自行结束，临时 fixture 服务器已关闭。

最终树验证：`vitest run --pool=forks --maxWorkers=2 --minWorkers=1 --testTimeout=15000` 为 332 文件通过、1 文件跳过，4148 项通过、6 项跳过；类型检查、隔离输出目录的完整构建、差异检查通过。变更文件 ESLint 0 错误，TerminalView 保留 11 条既有警告。默认线程池的一次重跑发生原生进程异常退出，子进程池全量重跑正常；LyShell 助手首轮记录的旧树失败与 Windows 命令启动失败已由最终树重跑覆盖。原生助手任务已确认在同一实例/会话/任务完成，并释放本次租约。最终日志为 `tmp/codex-review-final-forks.log`、`tmp/codex-review-build.log`。
