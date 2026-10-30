# R2 生命周期与退出整改报告

- 日期：2026-10-30
- worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`
- 基线提交：`36739a6deb32bc45bf7dcbf29635cce9c306230c`（branch `codex/complete-remediation-20261030`）
- 运行环境：Windows，Node v24.15.0；`node_modules` 为指向 `D:/workspace/claude/LyShell/node_modules` 的 junction（未改动主工作区源码）
- 工作包：`docs/lyshell-complete-remediation-plan-2026-10-30.md` 4.1–4.5
- 模式：实施与定向验证；未改 HTTP/IPC/命令服务/storage 文件，未提交/推送，未改运行实例或权限

## 1. 动作与文件

### 新增（R2 独占）

| 文件 | 内容 |
| --- | --- |
| `src/main/lifecycle/app-lifecycle.ts` | 生命周期状态机（`running → draining → stopped`，任阶段可 `fatal`）、`BusinessGate` 窄接口（`accepts` / `assertAcceptsBusiness` / `runBusiness` / `wrap`）、退出步骤注册表（`prepare` / `revoke` / `final`）、一次性总期限编排、`LifecycleRejectedError`（`code = 'LIFECYCLE_REJECTED'`）、进程单例 `appLifecycle` / `businessGate`。内部清理权限由 `AsyncLocalStorage` 令牌授予，外部无任何 `cleanup:true` 之类开关。不依赖 electron。 |
| `src/main/lifecycle/fatal-error.ts` | 最小致命面：`buildFatalReport` / `serializeFatalReport`（定长、脱敏）、`redactDiagnosticText`、`createFatalHandlers`（幂等，`finally` 必退出）、`installFatalHandlers`（注册 `uncaughtException` / `unhandledRejection`）。诊断落盘/日志/同步失效各自 try/catch，任何一步失败都不阻止非零退出。 |
| `src/main/lifecycle/lifecycle-state.ts` | `userData/lifecycle/fatal-last.json` 与 `last-shutdown.json` 固定大小退出标记：同步写、原子 rename、失败返回 `false` 不抛；`readLastExitState` 取较新者，损坏/缺失返回 null。仅用于区分致命/正常退出与保守恢复，不写业务仓库。 |
| `src/main/lifecycle/app-lifecycle.test.ts` | 15 用例：gate、内部清理令牌、期限幂等、prepare→revoke→final 顺序、准备阶段永久不返回仍达总期限、单项失败隔离、并发 `runShutdown` 只清理一次、fatal 不执行正常清理、未确认项。 |
| `src/main/lifecycle/fatal-error.test.ts` | 13 用例：脱敏/定长/序列化降级、处理器顺序与幂等、落盘/日志/置位失败仍退出；**致命退出行为全部在子进程验证**（esbuild 打包 fixture 后 `spawnSync(process.execPath, …)`）。 |
| `src/main/lifecycle/lifecycle-state.test.ts` | 7 用例：写入/读取、定长、未确认上限、取较新者、损坏数据、不可写目录不抛。 |
| `src/main/lifecycle/__fixtures__/fatal-exit.ts` | 仅测试用子进程夹具：按 `FATAL_FIXTURE_MODE` 触发未捕获异常/未处理 rejection/日志失败/落盘失败；注册一个 `final` 步骤写文件，用于证明致命退出**没有**执行正常清理。 |

### 修改（R2 独占）

| 文件 | 变化 |
| --- | --- |
| `src/main/quit-cleanup.ts` | 新增 `ShutdownDeadline`、`createShutdownDeadline`、`shutdownRemainingMs`、`clampDeadline`、`describeShutdownError`、`runBoundedStep`、`runBoundedSteps`；`waitForQuitCleanup` 原语义保留（现有 3 个回归用例不变）。 |
| `src/main/quit-cleanup.test.ts` | 原 3 用例保留，扩到 12 用例覆盖期限、有界步骤、预算耗尽、迟到拒绝接管、并行隔离。 |
| `src/main/index.ts` | 删除按 message 关键词吞 `uncaughtException`/`unhandledRejection` 的策略；接线致命处理器与生命周期步骤；`will-quit` 改为 `drain → runShutdown → app.exit(0)`。 |
| `tmp/remediation-r2-interface.md` | 交给主代理的 HTTP/IPC gate 与 shutdown 接线接口（189 行）。 |

### 明确未改

`src/main/ipc/application-ipc.ts`、`src/main/mcp/http-server.ts`、命令服务、storage 仓库均非本任务改动。收尾巡检时确认主代理已按 `tmp/remediation-r2-interface.md` 完成接线：`application-ipc.ts:6/13/15/29`（handle/on 双 gate）、`http-server.ts:47/338-343/444/894`（503 投影 + 路由内二次 gate），另新增 `src/main/mcp/shutdown-request-policy.ts` 用 `businessGate.phase` 允许插件 deactivate 所需的受控放行。R2 只交付说明，未改这些文件。

## 2. 新旧行为对照

1. **异常分类（4.2）**
   - 旧：`uncaughtException`/`unhandledRejection` 按 message 含 `handshake|SSH|connection|timeout|EPIPE|EOF|ECONNRESET|authentication` 直接吞掉继续服务；其余仅 dev 退出，生产继续运行。
   - 新：不再看错误字符串。预期业务失败仍在 Connector/会话边界局部收尾（`session-manager.ts:612`、`:1030` 已有 `connector.on('error')`）；未捕获异常/未处理 rejection 一律进入致命路径。
2. **致命路径（4.3）**
   - 幂等 guard → `enterFatal`（关闭新业务）→ 定长脱敏诊断同步落盘 → 日志 → 预先定义的最小同步失效（仅 `shelfBrowserRuntime.hostBoundary(true)`）→ `finally` 非零退出。
   - 不调用 `app.quit()` 绕回正常清理；不批量保存业务仓库；不覆盖磁盘；日志/落盘失败仍退出。子进程测试断言 `business-shutdown-ran` 副作用文件不存在。
3. **正常退出（4.4）**
   - 状态 `running → draining → stopped`；`drain` 后 gate 拒绝新业务，只有生命周期内部 `runInternalCleanup` 令牌可继续清理。
   - 总期限 `18_000ms` 从 `beginDrain` 一次性起算，**覆盖 `prepareShutdown()`**（旧实现是等 `prepareShutdown()` 完成后才起 8s 计时器）。
   - 阶段：`prepare`（顺序：终端输入撤销/归档 → 插件 release，此时 HTTP/token 仍存活）→ `revoke`（顺序：`await stopMcpHttpServer()` → matcher shutdown → 插件 host stop/撤 token → 审计写入 barrier）→ `final`（并行：传输、终端、DSH web、TUI、插件进程、退出历史 flush、审计 flush、reachability）。
   - 每步只能消费剩余预算；单项失败/超时只进 `unconfirmed`，不阻断其他项；重复 `will-quit` 不会重复清理。
   - 5 项预算：`SHUTDOWN_TOTAL_BUDGET_MS = 18_000`、`SHUTDOWN_PREPARE_BUDGET_MS = 7_500`（对齐 plugin-host 内部 7500ms 硬期限）、`SHUTDOWN_REVOKE_BUDGET_MS = 2_000`、final 消费剩余（prepare 用满时仍 ≥ 8s）。
4. **退出可区分（4.5）**
   - 致命退出写 `lifecycle/fatal-last.json`（含来源/阶段/pid/脱敏原因），正常退出写 `lifecycle/last-shutdown.json`（含 elapsed/timedOut/未确认步骤）。
   - 下次启动只读取并记录 `[lifecycle] previous run ended fatally (...); recovering conservatively`，不重放副作用。

## 3. 真实验证（cwd = worktree 根）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run src/main/lifecycle src/main/quit-cleanup.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=15000` | 0 | 4 文件 / 47 用例全过（日志 `docs/validation/2026-10-30-remediation/r2-tests.log`） |
| `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit` | 2 | 唯一错误 `src/main/terminal/session-manager.wait-pattern.test.ts(9,10) TS6133 'ConnectionStatus' is declared but its value is never read`（并行工作者文件，非 R2；R2 文件无错误；日志 `r2-typecheck-node.log`） |
| `node node_modules/eslint/bin/eslint.js src/main/lifecycle/*.ts src/main/lifecycle/__fixtures__/*.ts src/main/quit-cleanup.ts src/main/quit-cleanup.test.ts src/main/index.ts` | 0 | 无输出（日志 `r2-lint.log`） |

补充说明：typecheck 期间其他工作者的文件在不断变化，先后出现过 `src/main/mcp/http-server.ts`、`src/main/commands/command-service.ts`、`src/main/terminal/pattern-matcher.test.ts` 的错误；任一时刻 R2 文件均无错误。

额外回归（证明预期故障仍在局部处理，不上升为全局致命）：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run src/main/terminal/session-manager.failure.test.ts --maxWorkers=1 --minWorkers=1` | 0 | 9 用例通过（连接器失败/断线在会话边界收尾） |
| `node node_modules/vitest/vitest.mjs run src/main/ipc/application-ipc.test.ts --maxWorkers=1 --minWorkers=1` | 0 | 12 用例通过（主代理接线后的 GUI gate） |
| `node node_modules/vitest/vitest.mjs run src/main/webbar-deeplink.test.ts --maxWorkers=1 --minWorkers=1` | 0 | 2 用例通过（`index.ts` 结构断言未被 R2 改动破坏） |

## 3.1 R2 4.1–4.5 对照

| 计划条目 | 实现与证据 |
| --- | --- |
| 4.1 范围 | 只改 `src/main/index.ts`、`src/main/quit-cleanup.ts` 与新增 `src/main/lifecycle/`；未改 HTTP/IPC/命令服务/storage。 |
| 4.2 三类错误 | 预期失败留在会话/连接器边界（`session-manager.failure.test.ts` 9 用例）；请求内部错误由入口投影（主代理 503/`OperationError`）；未知异常与未处理 rejection 统一进 `installFatalHandlers`，不再有 message 关键词判断（`index.ts` 已无 `uncaughtException` 关键词分支）。 |
| 4.3 致命顺序 | `createFatalHandlers` 顺序 `enterFatal → persist → log → onFatalSync → exit`，`finally` 退出；落盘/日志/置位失败仍退出（`fatal-error.test.ts` 13 用例）；子进程断言不执行正常清理（`business-shutdown-ran` 不存在）；不调用 `app.quit()`。 |
| 4.4 正常退出 | 总期限 18s 自 `beginDrain` 起算并覆盖 `prepareShutdown`（`app-lifecycle.test.ts`「插件准备永久不返回仍达总期限」）；`prepare → revoke → final` 顺序且 release 时 token/HTTP 存活；`await stopMcpHttpServer()`、matcher holder、`pluginHostManager.stop()`、`audit-write-barrier` 均在 revoke；final 并行且单项失败隔离；重复 `will-quit` 由 phase 守卫。 |
| 4.5 验收 | 见上表 4 条命令；致命/正常退出分别写 `fatal-last.json` / `last-shutdown.json`，下次启动只记录不重放（`lifecycle-state.test.ts` 7 用例）；`npm run test` 全量未跑（并行改动多，见遗留）。 |

## 4. 交接：HTTP / IPC 接线（R2 只交付说明）

详见 `tmp/remediation-r2-interface.md`。收尾时已确认主代理按该说明接线，`src/main/ipc/application-ipc.test.ts` 12 用例通过（退出码 0）：

1. `src/main/ipc/application-ipc.ts`
   - `handle` 在取得 `applicationCallers.context(event)` 之后：`if (!businessGate.accepts()) { recordDiagnosticEvent({ …, outcome: 'refused' }); throw new LifecycleRejectedError(channel, businessGate.phase) }`
   - `on` 在入口处：`if (!businessGate.accepts()) return`
2. `src/main/mcp/http-server.ts` `handleRequest`
   - 位置：鉴权、并发预算、requestId、finish 诊断钩子之后，路由分发之前。
   - 规则：`/api/health` 例外；`if (url.pathname !== '/api/health' && !businessGate.accepts() && !shutdownRelease) sendJson(res, 503, { success:false, error:'Application is shutting down', code:'FORBIDDEN', retryDisposition:'never' })`。路由内（第 444 行）与单条操作（第 894 行）另有二次 gate。
   - `shutdownRelease` 由 `src/main/mcp/shutdown-request-policy.ts` 判定：仅 draining 阶段、仅插件自己的 deactivate 释放请求，用于满足 R2「插件 release 期间 token/HTTP 存活」。
3. `revoke` 阶段 `audit-write-barrier`（`mcpAuditRepository.stopAcceptingWrites()`）在 HTTP/token 撤销之后执行；`src/main/mcp/http-server.ts:2476 auditMcpOperation` 对 `append` 仍无 try/catch，barrier 之后到达的请求可能抛到 `handleRequest` 外层，需要主代理收敛（见第 5 节）。
4. matcher shutdown 以 root 追加方式接入：`src/main/index.ts:1173` 的 `patternMatcherShutdown` holder 由 matcher 模块在初始化时写 `patternMatcherShutdown.current = stopPatternMatcher`。

## 5. 遗留与限制

- 未验证：真实 Electron 进程的 `will-quit` 整体路径（需要启动应用；本次只做单元/子进程验证，`npm run dev` 未执行）。
- 未验证：`prepareShutdown()` 永久不返回在真实插件进程上的表现（单元用例用 100ms 级预算覆盖同一代码路径）。
- 已知集成风险：`audit-write-barrier` 与 `src/main/mcp/http-server.ts:2476`（`auditMcpOperation` 无 try/catch）的交互仍需主代理收敛：barrier 之后、进程退出前的少量请求会在审计 `append` 抛错，可能逃逸到 `handleRequest` 外层（未捕获 → 致命退出）。建议在该调用点 catch 后忽略，或让 `append` 在 draining 时静默返回。
- 依赖他人：`tsc -p tsconfig.node.json` 仍因并行工作者文件报错（如 `src/main/terminal/session-manager.wait-pattern.test.ts`）；matcher shutdown 需 R1/主代理写入 holder，未接线前 `pattern-matcher` 步骤是空操作（`current?.()`）。
- 回退：可单独回退 `src/main/index.ts` 的接线与 `src/main/lifecycle/`（业务代码无依赖），`quit-cleanup.ts` 的 `waitForQuitCleanup` 语义保持不变（新 `index.ts` 已不再调用它，导出与 3 个回归用例保留，供旧路径或其他调用方使用）；禁止恢复“未知异常记录后继续服务”。
- 未执行/跳过项：全量 `npm run test`、`npm run typecheck` 全绿、打包验证（均因并行改动与耗时未做）。
