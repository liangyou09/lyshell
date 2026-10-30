# 修复交付兼容性与运维说明（2026-10-30）

本文只描述已完成修复带来的**兼容性变化、硬限制、新接口、操作员行为、回滚规则与验证边界**。它不包含代码评审结论，也不代表发布就绪；集成、打包与最终验收由 Root 负责。基线取值以当前工作树和 `docs/validation/2026-10-30-remediation/` 的记录为准。

## 1. 兼容性变化总览

### R1 等待模式匹配移出主线程

| 项 | 当前值 | 兼容性说明 |
| --- | --- | --- |
| 默认模式 | `regex` | 未传 `patternMode` / `waitForPatternMode` 时与旧行为一致 |
| 显式模式 | `literal` | 纯子串匹配，不编译正则；新增可选字段 |
| 任意 flags | 不接受 | 只允许上述两种模式，避免 `g`/`y` 造成跨轮询 `lastIndex` 残留 |
| pattern 长度 | 2048 UTF-16 码元 | 超限同步失败，不进入 Worker |
| 全局排队任务 | 16 | 满则明确拒绝，不无界排队 |
| 全局等待调用 | 16 | 覆盖排队与在途匹配 |
| 单主体等待调用 | 4 | 防止单调用者占满 |
| 单次匹配硬超时 | 100 ms | 从 Worker 就绪后起算，覆盖编译与匹配 |
| Worker 启动期限 | 2000 ms | 超时即失败 |
| 预留输入预算 | 16,777,216 码元 | 排队 + 在途快照合计 |
| 主线程兜底 | **无** | 编译与匹配都不回主线程 |

失败语义保留 `code`、`retryDisposition` 与固定 `reason`。非法表达式和匹配硬超时不自动重试同一表达式；只读等待的总期限到达仍返回正常未匹配结果。已发出终端输入后观察失败升级为 `OUTCOME_UNKNOWN` + `reconcile-first`，禁止直接重发输入。

### R2 退出生命周期

- 正常状态机为 `running → draining → stopped`，任意阶段的未知致命故障均进入 `fatal`；内部清理通道不提供外部开关。
- 生产环境不再按错误文本决定“继续服务”：未知 `uncaughtException` / `unhandledRejection` 进入 `fatal`，**非零退出**（退出码 1）。
- 正常退出总预算 **18 s**，从 `beginDrain` 起算并**包含 prepare**；prepare 子预算 7.5 s，revoke 阶段只做同步撤权，final 使用剩余预算。
- 致命路径**不执行业务仓储 flush**，只尽力写入有界、脱敏的 `lifecycle/fatal-last.json`；正常退出另写 `lifecycle/last-shutdown.json`，不将致命退出冒充正常退出。

### R3 统一命令调度与预算

| 预算项 | 值 | 语义 |
| --- | --- | --- |
| 全局活动 | 16 | 同时实际执行的命令数 |
| 单调用者活动 | 4 | 公平轮转 |
| 单端点活动 | 2 | 受控连接身份维度 |
| 全局排队 | 128 | 满则明确拒绝 |
| 单调用者排队 | 50 | 保留 50 目标批次的可用性 |
| 批次保留输出 | 8 MiB | 按结果实际字节预留 |
| 全局保留输出 | 32 MiB | 活动收集 + 待发送结果 |
| 全局发送预算 | 64 MiB | 含 JSON 转义膨胀 |
| 批次总期限 | 默认 55000 ms，范围 100–120000 | `totalTimeoutMs`，包含排队 |
| 单条执行期限 | 默认 30000 ms，最大 120000 | 与批次期限相互独立 |

行为约束：

- 输出触达预算时，`partialOutput` **只作诊断片段**，不冒充 `output`；真实 `exitCode` 仍保留。
- 取消/超时不等于远端已终止：资源真正关闭（`state: 'closed'`）才归还执行位；`unconfirmed` 继续占用容量与名额。
- 客户端断开**不会自动重放**，也不表示命令已取消；已接受的命令按其自身期限继续。
- 慢消费者：输出流暂存上限 **256 KiB**，drain 预算 **5 s**；超限关闭响应并**取消执行**。
- SSH：关闭本地通道只能证明本地流结束，`remoteTerminated: 'unknown'`；成功取得完整输出与真实退出码仍可返回完成结果，取消或失败后的未知副作用按 `OUTCOME_UNKNOWN` + `reconcile-first` 处理。
- Windows 本地命令：先 `spawn` helper → 立即绑定排他 Job（`KILL_ON_JOB_CLOSE`）→ 查询 `ActiveProcesses` 确认绑定 → 才发送 start 让 helper 启动用户 shell。**不存在无 Job 的回退执行**；不支持的架构或 Job 绑定/验证失败在命令派发前拒绝；关闭确认必须同时满足 `ActiveProcesses=0` 与 Job 句柄关闭，否则保留 `unconfirmed`。
- POSIX 本地命令：根进程退出只结算输出与 `exitCode`，进程组是否消失由**独立探测**确认；残留存活进程时 `remoteTerminated: 'unknown'`，不谎报已终止。

### R4 架构边界

- 抽出应用通知、会话策略、MCP 客户端配置、存储路径和文档动作契约，指定依赖循环不再借入口注册模块传递。
- 新增零运行时循环依赖检查器：`npm run check:architecture`（`scripts/check-architecture-boundaries.cjs`）；它是门禁脚本，不改变运行时行为。

### R5 高频持久化

- 审计日志改为**异步单写者**：按 revision 提交，同一路径的主文件与备份共用锁，第二个仓储实例也不能并行 rename。
- `clear` 与 `flush` 等待目标 revision 的**提交屏障**。主提交和备份结果分别记录，备份失败不会倒退已提交 revision，也不会静默报告全链路成功。
- 设置 UI 等待真实回执：设置文件失败时保留旧值；设置已提交但审计裁剪写入失败时显示已确认的实际 `limit`，同时提示保存失败。清空失败保留错误提示，不显示成功。
- 磁盘 JSON 格式保持不变，旧文件可直接读取；不引入数据库或二进制格式。
- `JSON.stringify` 仍在主线程执行，序列化耗时单独计量；**不承诺“零阻塞”**，只承诺有界 debounce + maxWait 与可观测的残留耗时。

### R6 renderer 订阅

- 终端相关订阅改为更窄的标量 selector，避免无关 store 变更触发重渲染。
- 行为上保持：终端实例不重建、attach/detach、搜索、控制按钮与快捷键语义不变；该改动不引入新 UI 状态。

### R7 CI 与跨平台

- `.github/workflows/ci.yml` 配置矩阵：Ubuntu / Windows / macOS × Node `22.12.0` / `24`。
- WebSSH 示例为独立 job，不共享主工程缓存与测试选择。
- 这些只是**配置**；实际 CI 运行、安装包构建/安装与硬件验证不在本次本地交付范围内。

### R8 浏览器宿主

- Stage A 只迁移了指定入口（`web-tab-controls.ts`、`TaskShelfBrowserBar.tsx`、`WebTabLayer.tsx`、`WebPanel.tsx`）到 `BrowserHostClient` 代理；React 仍创建/卸载真实 webview，插件页、任务架截图、dsh/插件 webview 等仍走原路径。
- 新增**默认关闭**的单实例只读原生 `WebContentsView` 试点，仅在启动隔离验证实例时设置 `LYSHELL_READONLY_VIEW_PILOT=1` 才可用；未设置时 capabilities 返回 `pilotEnabled:false`。
- 试点不接管 Tasks/shelf、插件或已登录页签，不迁移账号、partition、preload 或导航权限。
- 未完成全量 webview 迁移，**不声明内存节省**；截图 8 MiB 上限只是响应内容上限，不是 RSS 承诺。

## 2. 新接口

### 2.1 `browser-host:request`

- 通道常量：`BROWSER_HOST_CHANNEL = 'browser-host:request'`（`src/shared/browser-host.ts`）。
- preload 暴露：`window.electronAPI.browserHostRequest(request)`，返回 `Promise<BrowserHostResult>`。
- 请求按 `kind` 区分：`create-readonly-pilot`、`attach`、`bounds`、`visibility`、`focus`、`capture`、`close`、`inspect`（以 `src/shared/browser-host.ts` 类型为准）。
- 校验由 `browser-host-validation.ts` 执行：拒绝未知字段与越界值；owner 的 `WebContents`、顶层 frame、当前文档由主进程核对，不采信 renderer 自报。
- `handle` 为随机标识，`generation` 必须精确匹配；关闭、owner 导航/销毁或代际变化后，迟到操作与截图结果不能回写新实例。
- 每个原生 host 最多一项在途截图，第二项立即 `RESOURCE_LIMIT`；成功、失败与撤权都在 `finally` 归还占位。
- 关闭语义：只有快照 `phase: 'closed'` 表示 view 已移除且 `WebContents` 已销毁；`close-unconfirmed` 保留原句柄与容量，**不代表已停止**，需显式 `inspect` 或再次 `close` 核对。

### 2.2 MCP 审计 IPC 的提交回执

preload 的 IPC invoke 原本就返回 Promise。变更重点是 clear/retention-set 等待磁盘提交，并在 list 中增加 persistence；调用方必须等待并检查真实回执。

| 通道 | 返回 |
| --- | --- |
| `mcp-audit:list` | `{ records, total, persistence }` |
| `mcp-audit:facets` | 去重操作名/会话选项 |
| `mcp-audit:clear` | `{ success: boolean, error?: string }` |
| `mcp-audit:retention-get` | 当前保留上限 |
| `mcp-audit:retention-set` | `{ success, limit?, error? }`，成功前已等待提交完成 |

既有 IPC 通道名称保留，没有授予插件或外部调用者额外权限。

## 3. 操作员行为

### 3.1 结果未知（`OUTCOME_UNKNOWN`）

1. 先核对副作用（远端文件、进程、服务状态、Git 工作区），再决定是否重试；不要直接重放命令。
2. 结果中的 `partialOutput` 只是诊断片段，不能当作完整输出或成功证据。
3. `resourceClosed` 为 `unconfirmed` 时，相关执行名额仍在占用；先确认进程组/Job 已消失，再继续大批量命令或退出。
4. SSH 场景默认 `remoteTerminated: 'unknown'`：关闭本地通道不等于远端树已终止。
5. 断电/崩溃后，`lifecycle/last-shutdown.json` 与 `fatal-last.json` 只用于定位；系统不会自动重放任何业务副作用。

### 3.2 保存失败

1. 审计保留设置保存失败时显示失败，以下次回执的实际 `limit` 为准；设置提交成功而后续审计落盘失败时，新设置可能已生效。
2. 清空审计失败时列表保持原样，不显示“已清空”。
3. 失败后不自动忙重试；下一次变更或显式操作才会再次提交。
4. 正常退出最多等待 18 s；超时项计入 `unconfirmed` 并在下次启动记录，不阻塞退出，也不谎报已保存。

## 4. 回滚规则（硬约束）

- **不得**把正则编译/匹配退回主线程作为兜底，包括“临时降级”；没有主线程路径可回滚。
- **不得**在资源关闭未确认（`unconfirmed`）时提前归还执行名额。已经丢弃的输出或已完成发送的响应仍应按各自生命周期释放预算。
- **同一路径不得并发“同步写 + 异步写”**；审计日志只走 `SerializedJsonWriter`，`clear`/`flush` 必须经过同一提交序列。
- 致命状态下**不得**再执行任何业务 flush；回滚也不能恢复“按错误文本继续运行”的旧策略。
- Windows 命令**不得**回退到无 Job 的执行路径；绑定/验证失败只能拒绝执行。
- R8 试点回滚方式为不设置 `LYSHELL_READONLY_VIEW_PILOT`（默认即关闭）；不得借回滚放宽 partition/preload/导航权限或迁移账号。
- 回滚任何预算值时，必须同步更新文档与压力测试，不能只改魔法数字。

## 5. 验证边界

- 本地类型检查、lint、单元/回归测试、架构门禁与 Electron 冒烟记录由集成方保存在 `docs/validation/2026-10-30-remediation/`；本文不复述“通过”结论，也不以其替代验收。
- **未在此环境运行**：真实 GitHub Actions（仅配置矩阵）、NSIS/portable 安装器的生成与安装/升级、跨平台真机、GUI 覆盖层/z-order、分屏拖动、中文 IME、混合 DPI、完整进程 RSS 对比、真实网络下的 SSH 远端进程树终止验证。Windows 未签名打包目录与只读截图的实际验收结果见实施报告。
- 未知结果的处理依赖操作员按 `reconcile-first` 核对，自动化测试不覆盖真实副作用。
- 发布就绪与提交/合并结论由 Root 负责；本文不提供发布判定。

## 6. 交付

- 新增文件：`docs/remediation-compatibility-2026-10-30.md`（本文件）。
- 未修改源码、测试、其他文档、设置、模式或权限。
- 待 Root 完成：集成验证、CI 实跑、安装包/真机验收，以及在发布说明中引用本文的回滚规则。
