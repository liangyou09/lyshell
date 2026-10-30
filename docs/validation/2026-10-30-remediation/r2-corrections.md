# R2 修正报告（root 复审后 5 项具体修正）

- worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`
- 基线 HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`（未提交、未推送）
- 模式：具体修正与定向验证；未做代码审查、未委派、未改运行实例/设置/权限
- 依据：`tmp/remediation-root-integration-notes.md` 的 R2 条目 + 本轮口头修正 1–5

## 1. revoke 只同步发起/撤权，等待移到 final

旧实现（R2 首轮）：`revoke/mcp-http-stop` 里 `await stopMcpHttpServer()`。活跃 HTTP 请求会让
`server.close()` 挂起，2s revoke 子预算耗尽后 `pattern-matcher` / `plugin-host-stop` /
`audit-write-barrier` 全部没执行，进程带着 plugin token 退出。

修正（`src/main/index.ts`）：

- `1203–1226`：`revoke` 四个步骤全部改为同步启动/撤权：
  - `mcp-http-stop`：`mcpHttpStopPromise = stopMcpHttpServer()`，不 await；先 `void …catch(() => undefined)` 防未处理 rejection（`:1207`）；
  - `pattern-matcher`：`patternMatcherStopPromise = stopPatternMatcher()`，不 await（`:1213`）；
  - `plugin-host-stop`：`pluginHostManager.stop()`（同步撤 plugin token/停子进程）；
  - `audit-write-barrier`：`mcpAuditShutdownRevision = mcpAuditRepository.stopAcceptingWrites()`。
- 实际等待登记到 `final`：`mcp-http-stop-wait`（`:1264`）、`pattern-matcher-wait`（`:1268`），
  与其余 final 步骤并行、消费总期限剩余量。
- `src/main/lifecycle/app-lifecycle.ts`：删除 `SHUTDOWN_REVOKE_BUDGET_MS` 与
  `revokeBudgetMs` 选项（`:38–39` 只剩总/ prepare 预算）；`revoke` 不再建子期限，
  循环调用新增的 `runSyncStep`（`:258`、`:279`）。`runSyncStep` 若发现步骤返回 thenable：
  先挂 `void Promise.resolve(result).catch(() => undefined)`，再抛固定错误
  `Revoke step "<name>" returned a promise; revoke may only revoke synchronously and must register completion for the final phase`，
  该步骤记 `failed` 进 unconfirmed —— 防止有人把 `await` 又写回 revoke。
- 效果：prepare 用满 7500ms 预算后，必要撤权仍全部执行；停服再慢也不会连带挡住 matcher/
  plugin token/审计屏障。

## 2. 分组清理不得「只 log 然后 completed」

新增 `src/main/lifecycle/shutdown-checks.ts`：

- `runSequentialCleanup(label, tasks)`：按序执行**全部**任务，各自捕获，最后若有失败抛
  `"<label> was not confirmed (<names>); first failure: <name>: <detail>"`（失败名截前 8 + `+N more`）。
- `runConcurrentCleanup(label, tasks)`：`Promise.allSettled` 等全部落定后同样聚合抛固定说明。
- `assertBrowserHostsClosed(snapshots)`：任一 `phase !== 'closed'` 抛
  `Browser host shutdown was not confirmed (N host(s) not closed: <phases>)`。

`src/main/index.ts` 接线：

- `prepare/terminal-input-revocation`（`:1192`）= `runSequentialCleanup('Terminal input revocation', [shelf-recycle, input-revocation, shelf-archive])`，
  顺序不变；失败不再被 try/catch 吞掉后记 completed。
- `final/transfers`（`:1234`）= `runConcurrentCleanup('Transfer cleanup', [download-workers, upload-workers])`。
- `final/terminals` = `runConcurrentCleanup('Terminal disconnect', sessions…)`；
  原来混在里面的 `stopRecordedLocalHosts` + 二次 recycle/archive 拆到 `final/local-hosts` =
  `runSequentialCleanup('Terminal cleanup', …)`。
- `final/dialog-and-download-cleanup` = `runSequentialCleanup('Dialog and download cleanup', …)`。
- 于是 `report.unconfirmed` 会真实列出 `transfers`/`terminals`/`local-hosts` 等步骤名，
  而不是只留一行 warn、退出报告却写 completed。

## 3. fatal-error 的有界性、脱敏顺序与 fatal 状态不可回退

`src/main/lifecycle/fatal-error.ts`：

- `sanitizeText(text, max) = redactDiagnosticText(boundText(text, max))`（`:63`）：**先限长再脱敏**，
  不再对超大堆栈/文本跑无界正则。
- `safeStringProperty(value, key)`（`:68`）：只读取已知的 `name`/`message`/`code`/`stack`
  字符串属性，各自 try/catch；getter 抛错按缺失处理（`buildFatalReport` `:105–114`）。
- `describeNonError`（`:81`）删除 `JSON.stringify`：字符串原样、`null`/`undefined`、数组
  `[array length=N]`、number/boolean/bigint `String(value)`、symbol/function/其他 object 固定标签
  `[symbol]`/`[function]`/`[object]`。任意 rejection 对象的 `toJSON` **绝不调用**。
- `createFatalHandlers`（`:161–195`）：报告构造失败时退化为 `Unprintable fatal error`，
  仍执行 `enterFatal`、`onFatalSync` 与 finally 退出；persist/log 各自 try/catch，日志失败照常退出。

`src/main/lifecycle/app-lifecycle.ts`：

- `accepts()`（`:156`）：`fatal`/`stopped` **先返回 false**（即使处于 `runInternalCleanup`
  令牌内），`draining` 才放行内部清理。
- `executeShutdown`（`:263–267`）：记录 `fatalDuringShutdown = phase === 'fatal'`；为真时
  不把状态覆盖成 `stopped`，报告 `kind: 'fatal'` 并 warn
  `[lifecycle] fatal state entered during shutdown after <n>ms; <k> step(s) unconfirmed`。

## 4. 接 R8 浏览器宿主关闭

`src/main/index.ts`：

- 新增 `import { registerBrowserHostIpc } from './browser/browser-host-ipc'`、
  `import type { BrowserHostSnapshot } from '@shared/browser-host'`。
- 模块级 `let browserHostShutdown: (() => Promise<readonly Pick<BrowserHostSnapshot, 'phase'>[]>) | undefined`。
- ready 时在 `registerIPCHandlers()` 之后（`:1027`）：
  `browserHostShutdown = registerBrowserHostIpc().shutdown as …`，注册失败只 `log.error`，不阻断启动。
- `final/browser-host`（`:1272`）：`if (!browserHostShutdown) return; assertBrowserHostsClosed(await browserHostShutdown())`。
  任一宿主不是 `closed`（含 `close-unconfirmed`/`crashed`）→ 步骤 reject → 进 `unconfirmed`。

未触碰 HTTP（root 已接 gate + 可信 host release 窄通道）、`commandService`（root 随后接）、
R8 文件本身。

## 5. 新增回归测试

| 回归 | 位置 | 断言 |
| --- | --- | --- |
| 活跃 HTTP drain 不阻挡 revoke | `src/main/lifecycle/app-lifecycle.test.ts`（“revoke 只同步发起停止…”） | 挂起的停服 Promise 不再阻塞：四个 revoke 步骤全部执行且 `completed`；挂起等待在 final 记 `unconfirmed`，总耗时受总预算约束 |
| revoke 返回 Promise 记为失败且不 await | 同上（“revoke 步骤返回 Promise…”） | 步骤 `failed`、error 匹配 `returned a promise`、`runShutdown` 立即返回 |
| allSettled 部分失败进 unconfirmed | `src/main/lifecycle/shutdown-checks.test.ts` + 上述 app-lifecycle 用例 | 失败项仍执行其他任务；抛固定说明；`unconfirmed` 含步骤名 |
| 未知 rejection 的 toJSON 绝不调用 | `src/main/lifecycle/fatal-error.test.ts` | `toJSON` 计数为 false，message 为 `[object]`，序列化结果不含 `toJSON` |
| 内部 cleanup 期间 fatal 不接新业务 | `src/main/lifecycle/app-lifecycle.test.ts` | `beginDrain` 后 `runInternalCleanup` 内 `enterFatal`，随后 `accepts()` 为 false |
| fatal 不退回 stopped | 同上（“正常退出途中进入 fatal…”） | `report.kind === 'fatal'` 且 `phase === 'fatal'` |
| 长文本先限长再脱敏 / Error getter 抛错 | `src/main/lifecycle/fatal-error.test.ts` | 消息 ≤ 512+32，截断外凭据不出现；getter 抛错仍生成报告 |
| 入口接线结构 | `src/main/lifecycle/shutdown-wiring.test.ts` | index.ts 无 `await stopMcpHttpServer()`/`await stopPatternMatcher()`、无 matcher holder、有 final wait 步骤与 browser host 确认、无关键词吞异常 |

## 6. 验证（实际执行）

cwd 均为 `C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run src/main/lifecycle src/main/quit-cleanup.test.ts src/main/terminal/session-manager.failure.test.ts src/main/ipc/application-ipc.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=15000` | `0` | 8 files / **85 tests passed**（log：`r2-corrections-tests.log`） |
| `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit` | `2` | 仅并行工作者文件错误：`src/main/commands/local-command-core.ts(242,8): error TS2304: Cannot find name 'targetPidMatches'.`（log：`r2-corrections-typecheck.log`）；R2 文件 0 错误 |
| `node node_modules/eslint/bin/eslint.js --ext .ts src/main/lifecycle src/main/quit-cleanup.ts src/main/quit-cleanup.test.ts src/main/index.ts` | `0` | 无告警（log：`r2-corrections-lint.log`） |

文档同步：`tmp/remediation-r2-interface.md` 第 1/4/5/6 节已更新为「revoke 无子预算、只同步撤权、
final 等待、R8 浏览器宿主、无 matcher holder」；第 3 节 HTTP gate 契约未变（root 已接线）。

## 7. 遗留 / 未做

- `commandService.shutdown()` 由 root 随后接线；R2 未臆造该 API，final 里没有它的步骤。
- `tsc` 全绿仍取决于并行工作者修复 `src/main/commands/*`；R2 独占文件无错误。
- 未运行完整 `npm run test`（全仓）与 `npm run typecheck`（含 renderer）——按要求只跑受影响范围。
- 未在真实 Electron 进程里触发退出（测试用假 `exit`/子进程夹具）；真实 `app.exit(0)` 时序仍由
  手工退出验证。
- 审计 barrier 的 keep-alive 尾部窗口仍按上一份报告的风险说明处理（不改 http-server）。
