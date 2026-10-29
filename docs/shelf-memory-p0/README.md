# 小窗口内存优化 P0 实施记录

最新普通页逐网址闲置重载与只读副本深睡范围见 [契约说明](../shelf-memory-deep-sleep.md)。[普通页三轮对照](reloadable-report.md)已完成102次恢复，长循环后私有内存中位数1171.24→487.84MiB。[只读副本对照](deep-sleep-report.md)保留历史构建，数据不混用。本页其余内容仍是历史 P0 基线。

> 本页为冻结的 P0 基线记录。后续实现、最终验收和条件阶段停止决定见 [完整实施记录](../shelf-memory-implementation.md)；下文的“本轮”仅指当时的基线阶段。

日期：2026-10-28。分支：`codex/shelf-memory-p0`。实际 worktree 与测量基线提交：`34d64dc3eed8bc7c53a03775475808545340d72e`，源码哈希见 `source-manifest.json`。

依据 `../LyShell_完整实施方案_v1_20261028.md` 第 17 章，本轮实施 P0；未修改生产功能或持久化格式。当前为**基线工具、组件和现有应用 API 测量完成，P0 的安全及可见交互门槛尚未通过**。P1–P5、自动深睡和 Rust 生产迁移均未放行。

## 工作区与协作边界

独立 worktree：`C:/Users/69534/.codex/worktrees/shelf-memory-p0/LyShell`。最初查看原目录时 HEAD 是 `920d389`，DESIGN.md、docs/task-shelf-plan.md、TaskShelf.css、TaskShelf.test.tsx、TaskShelf.tsx 有未提交改动；创建 worktree 期间原分支新增提交 `34d64dc`，实际创建结果基于此提交，已包含其中提交的界面修改。本任务没有覆盖原目录文件，也没有手工复制这些改动。方案作为输入复制进本分支。依赖通过本机 node_modules 目录联接复用；没有安装依赖、改变共享 Harness 设置、启动 shell/Agent 业务任务或读取用户网页档案。

LyShell 原生 work API 的独立新会话负责固定日志与 OutputBuffer 基准初稿。Codex 负责 Electron 探针、源码核对、脚本审查、汇总和验证。不存在委托代码审查。旧原生任务运行期间端口文件消失，连接被拒绝；旧任务终态未知，没有将其记作完成。

用户重新打开应用并要求获取新句柄后，确认旧任务精确查询409、旧基准进程不存在，新后台 identity 为 `26ef656c-67aa-444a-b895-2e93e880ca8c` / `1793169611888`，新会话 `session-9439fc87-1f96-4cef-b1b7-c407e9a40fd4`、续做任务 `71bbe92b-cd73-42b3-909f-f2edacad9e27`。Codex审查发现CLI子进程入口缺失导致嵌套启动，先取消任务并精确确认 `cancelled`、核验无残留基准进程，再接管文件完成局部修正与最终运行；加入禁止子进程再启动子进程的独立保护。三轮使用同一语料，修正增量长度统计并限制子进程时间/stdout/stderr；全部history-*脚本、实际数据和报告最终由Codex检查。没有重发旧任务或切换PetLink，未改变共享后台设置。

恢复跟踪定位（均非凭据）：backend instanceId `1b0c993e-08b1-4404-bf2d-65ce947ee1fd`、instanceEpoch `1793157103174`；sessionId `session-6552eb1d-e733-4ca0-b656-600f67a5fe81`；acceptedTaskId `85dae57e-0b93-450f-9610-c84bc70f4aa1`。重连先按原 identity/session/task 精确查询；后台换代不能映射原任务，须核实执行与副作用后另行处理。不得仅凭断线自动重提。请求与回执存放本 worktree 的 `tmp/shelf-memory-p0/`，不含 token。

## 已执行的隔离测量

运行 `node scripts/shelf-memory-p0/electron-baseline.cjs`，然后运行 `node scripts/shelf-memory-p0/summarize-electron.cjs`。三轮分别启动新 Electron 进程、随机临时 userData 和只绑定回环地址的 fixture 服务。使用真实 `<webview>`、实际 xterm 包与生产 `captureShelfWebFrame` 函数；没有启动完整 LyShell UI。窗口隐藏，固定 1280×800，页面 960×600，xterm 100×24、scrollback 10000；实际 DPR、CPU、内存和运行时版本见 JSON。

按 PID 去重采集主进程、renderer、guest、GPU 与 utility 的 `app.getAppMetrics()`，100ms 定时采样，主进程另记 `process.memoryUsage()`。Electron MemoryInfo 的 KiB 转为 MiB；Node 字段保持 byte，external 与 ArrayBuffer 不相加。shell/Agent 未启动，无须估算其占用。原始样本含采样耗时；未执行无采样对照，所以尚未量化采样器引入的扰动。结果为轮询观测峰值，不能解释为绝对峰值。

| 顺序场景 | 三轮总私有内存采样中位数范围 | 三轮观测峰值最大值 |
| --- | --- | --- |
| 1 个本地 webview | 173–178 MiB | 178 MiB |
| 10 个本地 webview | 464–476 MiB | 559 MiB |
| 30 个本地 webview | 1108–1113 MiB | 1189 MiB |
| guest 全部关闭后的宿主 | 200–205 MiB | 209 MiB |
| 1 个 xterm，10000 行 | 227–232 MiB | 232 MiB |
| 10 个 xterm，10000 行 | 395–400 MiB | 410 MiB |
| 30 个 xterm，10000 行 | 792–803 MiB | 803 MiB |

这些为同轮顺序增量工作负载，包含前阶段保留及分配器高水位，**不能将行差直接归因于某个对象**。20/100 张卡片是合成元数据 DOM，不是 TaskShelf React 布局；xterm 没有连接 PTY。dispose 后只等待 1 秒且未强制 renderer GC，观察到私有内存未立即回落不能证明泄漏。数据仅支持优先测量 guest 与终端长期驻留的方向，不能证明任何优化已节省内存。

原始数据：`electron-round-{1,2,3}.json.gz`（gzip 压缩 JSON，包含逐进程指标）；汇总：`electron-results.json`。临时档案和失败尝试保留在 worktree 的 `tmp/shelf-memory-p0/electron/`，不打包发布。脚本只创建新档案，不复用正式 partition。

### 重新连接后补测的完整应用基线

审查勘误：下述冻结应用基线隔离了 appData/userData 与网页 partition，但当时没有独立 DSH_HOME，启动器可能自动扫描本机用量日志，因此不能称完整运行环境完全隔离。这部分额外负载也是数据限制；归档的原始指标不含会话日志正文。现有 app-baseline/app-acceptance 脚本已为每个子进程补独立 DSH_HOME，最终集成验收另行重跑。冻结数值不冒称修正后重新测得的结果。

本 worktree 执行 `npm run build` 成功后，运行 `node scripts/shelf-memory-p0/app-baseline.cjs` 和 `node scripts/shelf-memory-p0/summarize-app.cjs`。探针加载真实 dist/main/index.js、preload 和 renderer，不改生产源码。每轮创建全新临时 appData 与 userData；开发模式固定的 lyshell-dev 也落在该临时 appData 下，不播种正式配置。合成保存文件各含 20/100 条记录，一半 Tasks、一半 Archive；没有调用 restore 或导航保存地址。

两种规模各三轮：全部保持 0 个 guest。Tasks 页实际挂载卡片分别为 10/50，Archive 的另外一半不在当前列表；没有把总记录数误记为当前挂载量。每轮读取列表 100 次，交替归档/取消归档同一条合成记录 100 次，均通过真实 preload→IPC→仓库原子保存。此处是既有单项分类 IPC 的基线，尚不是拟新增的启动归档或批量激活。

| 保存记录数 | 主页面 did-finish-load，三轮范围 | 侧栏入口可用，三轮范围 | 现有分类 IPC p50 / p95 的三轮范围 | settled 总私有内存中位数范围 |
| --- | --- | --- | --- | --- |
| 20 | 1254–1361 ms | 1371–1470 ms | 2.3–2.7 / 21.3–41.8 ms | 384–399 MiB |
| 100 | 1299–1465 ms | 1425–1584 ms | 6.8–9.7 / 51.6–56.7 ms | 419–436 MiB |

原始结果为 `app-{20,100}-{1,2,3}.json.gz`，精确统计和窗口尺寸/DPR 在 `app-results.json`。启动样本每规模仅 3 个，不能据此声称具有 100 次启动的 p95；100 次覆盖的是每轮两种现有 IPC。窗口隐藏，did-finish-load/DOM 入口就绪不是屏幕首帧或真实输入延迟；该结果不替代 IME、DPI、可见交互和现有帧同步任务验收。CPU 及系统活动未隔离，不能把不同轮的波动解释为代码收益。该阶段短时稳态仍不代表五分钟运行后的稳态。

## 当前版本的实际能力与阻断项

实际 Electron 为 43.7.11，xterm 5.5.0；精确 Node、Chromium、V8、Node-API 版本在结果的 `versions` 中。仓库总说明中 Electron 28 的文字不作为能力依据。

1. 生产 renderer webview 截图路径三轮均返回 960×600，DataURL 24782 字符。这只说明本 fixture 的调用可行，不代表全应用在途预算成立。
2. 对隐藏宿主中先前 guest 的主进程 `capturePage(undefined, {stayHidden:true})` 三轮均返回 `UnknownVizError`。接口存在不等于本显示条件下可用；P1c 要实现可诊断跳过并专项核验可见/离屏/隐藏路径，不得通过唤醒页面补图。
3. 设置 `window.onbeforeunload=()=>false`，调用 `guest.close({waitForBeforeUnload:true})`，三轮均观察到 `will-prevent-unload`，但 400ms 后 guest 已销毁。探针从未在该事件调用 `preventDefault`。所以此 webview 关闭路径不能满足方案“拒绝即保留”的硬条件；P2b **禁止沿此路径上线**，需要独立受控能力实验和保护协议设计。不能把事件发生认定为成功拦截，也不能通过 React 卸载补救。
4. 本轮退出前实际 guest 计数均为 0；这是 fixture 资源收尾证据，不代表生产卡片卸载可安全释放 guest。

官方能力边界与本机结果分开：[`webContents`](https://www.electronjs.org/docs/latest/api/web-contents)、[`webview`](https://www.electronjs.org/docs/latest/api/webview-tag)、[`MemoryInfo` 单位](https://www.electronjs.org/docs/latest/api/structures/memory-info)。实现应以锁定版本实测为门槛，不能以 latest 文档替代本机测试。

## 数据所有权和调用清单

| 对象 | 当前权威所有者及入口 | 生命周期与需补协议 |
| --- | --- | --- |
| 保存任务 | main/storage/task-shelf-repository.ts，version 1 单文件，最多 100 条 | ensureLoaded 惰性加载；commit 原子写入，失败回滚；archive 单项 revision+1，无 bootId、启动屏障、批量激活或期望版本校验 |
| 分类 UI | renderer/stores/task-shelf.ts，TaskShelf.tsx | renderer Promise 队列串行 IPC，只覆盖本 renderer；不能替代 main 仓库命令队列。归档与 restore 是不同入口 |
| IPC | shared/task-shelf.ts → main/ipc/validation.ts → handlers.ts → preload/index.ts | 现有 sender/mainFrame 检查、长度与 kind 校验；新命令必须同步更新全部点，scope/bootId/revision 不可只信 renderer |
| 终端连接 | main/terminal/session-manager.ts 与 connector | 隐藏与归档不关闭连接，MCP 读取同步缓冲；不能以卡片生命周期管理连接 |
| xterm 与订阅 | renderer/stores/terminal-store.ts，TerminalView.tsx | store 持有 terminal/Fit/Search 与 outputCleanup；注销时清订阅并 dispose。组件卸载不 dispose，scrollback 默认 10000 |
| 真实侧栏终端 | ShelfTerminalHost.tsx，task-shelf-surfaces.ts | 单 TerminalView，主区优先；mini 记忆几何避免隐藏后错误 resize，需要集成验证输入/IME/订阅计数 |
| 普通 guest | WebTabLayer.tsx，web-tab-controls.ts，main/browser/service.ts | 常驻层按 overlay id 复用，主区占位优先；现有 registry 不包含创建许可/销毁确认的全套代际协议；partition persist:webbar |
| 启动网页 | renderer/stores/browser-session.ts | taskShelfRequest 存在时跳过旧网页清单自动恢复；不等于已经实现保存任务启动归档屏障 |
| 截图与贴图 | TaskShelfPreview.tsx，task-shelf-web-frame.ts | 每组件 500ms timer；Webview WeakMap 合并同源 pending/400ms 复用；整图 capture 后缩至 960×600，DataURL 进入组件 state；没有全应用唯一原生许可、字节预算、导航/尺寸代际校验 |
| 后台绘制租约 | task-shelf-preview-sources.ts | Map 按 id 引用计数；最后释放通知订阅者，需纳入统一策略的持有者与代际 |
| 终端预览 | task-shelf-terminal-preview.ts | 读取 xterm buffer 画 Canvas，不增加 PTY 订阅；有单画布尺寸边界，没有全应用 Canvas 总字节预算 |

冷历史候选核对：OutputBuffer 默认 1M **UTF-16 码元**，分块队列和 generation 缓存已存在。同步 getRecentLines/getOutputSince 由 session-manager.readOutput 与 sendAndWait 轮询读取，MCP read_output / send_and_wait / tail/wait 继续依赖这些结果。joined/clean/recent/slice/sinceText 均是派生副本，只能在既有语义下按预算失效，不能视为可随意转移的唯一历史。另有收纳 SSH 的 64K 码元缓冲和持久只读上下文尾部；来源仍受同步查询和独立保留策略约束，未确认可迁移到异步 codec 的冷范围。

结论：没有已脱离同步读取的冷历史候选，停止 P4 生产迁移；P3 只能独立对照实验，不安装 Rust 工具链，不扩大历史保留量。固定日志报告见 `history-report.md`，汇总为 `history-results.json`，三轮原始样本为 `history-round-{1,2,3}.json.gz`。三个独立进程完成431172次语义检查，0不一致，每个主要操作每档300样本；25项脚本测试通过。30缓冲的派生缓存填充进程heapUsed增量中位数约104.26MiB，但原始语料字符串池共享，不能将这个差值认定为应用总收益。

## 后续阶段范围与参数冻结候选

| 阶段 | 实际文件边界与依赖 | 验收/数据变化 |
| --- | --- | --- |
| P1a | task-shelf-repository、main/harness/task-shelf、shared/task-shelf、IPC validation/handlers/preload、renderer task-shelf store 与 TaskShelf 消费入口 | 先主进程启动快照/串行提交，再分类命令；bootId 运行期，不新增数据库；现有 revision 和 archivedAt 复用。T01–T07/T31 保存失败、并发、意图失效测试；静态展示先行 |
| P1b | task-shelf-surfaces、ShelfTerminalHost、WebTabLayer、TaskShelf、pane-store | 保留单实例、主区优先；tasks/none，Archive 静态；350ms 有效区域自动收起。T08–T12 与实际中文 IME/DPI。与原目录帧同步改动合并前重新确认所有权 |
| P1c | preview-sources、web-frame、terminal-preview、TaskShelfPreview；新增应用级调度/缓存 | 并发1、队列16、watchdog5000ms；96MiB解码准入、24MiB编码准入、64MiB临时预留、4194304原图像素、最终960×600；200ms尺寸稳定；T21–T23，悬挂不能归还真实许可 |
| P2a | browser-session、web-tab-controls、WebTabLayer、生命周期/恢复协调器与受校验 IPC | concurrency1/pending16/autoResident4，navigation30000ms/presentation5000ms；仅显式/一次bulkVisible，滚动不恢复；T13–T15/T20。新增恢复元数据须格式兼容后独立提交 |
| P2b | 受控保护适配器、main/browser/service、生命周期协调器 | 30000ms仅标签、300000ms候选；safe有效期2000ms、关闭等待5000ms。目前被 beforeunload 实测阻断，不能放行 |

上述为设计起始参数，尚无完整应用公平对照，不称为已验证最优值或生产默认值。原任务/PTY、SSH 续接范围、审批和插件资源所有权保持原协议。每阶段独立开关；关闭优化不反转用户分类、不杀任务。

## 本轮验证及未完成门槛

已运行相关既有 Vitest：5 文件、58 项全部通过（OutputBuffer、任务仓库、IPC 校验、截图复用、ShelfTerminalHost）；新增工具的25项node:test通过，覆盖语料、语义对照、CLI边界、负长度和子进程模式。组件 Electron 三轮均完成资源收尾；完整应用 20/100 记录各三轮通过，生产构建成功。新增CJS语法检查通过，新文件逐项检查空白，生产源码/依赖文件没有差异。构建结果不替代生命周期实测。

P0 剩余：新启动归档/激活功能的首屏与峰值、完整应用混合终端持续输出、每场景至少100次可见交互延迟、30秒/5分钟时点、采样器无采样对照、分对象 heap/原生保留归因、保护适配器覆盖比例以及中文输入/拖动/DPI视觉验证。生产新分类功能尚不存在，不能报告其实现后的启动/激活时延；既有 IPC 数据已补测。网络/冷缓存/热缓存尚未分别测量；没有运行真实上传/音视频/通话/离线场景。没有用户网站被授权为 safe，自动深睡覆盖按未知处理，而非将 GET 当作安全证明。

本记录不宣称完整方案实施完毕，也不宣称 P0 已满足放行标准。先解决版本能力阻断与补齐完整应用基线，再依阶段推进。
