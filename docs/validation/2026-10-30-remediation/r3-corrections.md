# R3 修正轮报告（2026-10-30）

- worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`
- 基线 HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`（分支 `codex/complete-remediation-20261030`）
- 模式：实施 + 定向验证；未提交、未推送；未触碰 `D:/workspace/claude/LyShell/src`、`http-server.ts`、`api-routes.ts`、`mcp/types.ts`、`index.ts`。

本轮只处理 `tmp/remediation-root-integration-notes.md` 的 R3 条目（用户 m00485 第 1–5 项）。上一轮 `r3-report.md` 仍适用，本文件记录修正后的差异与证据。

## 1. 逐项修正

### 1.1 本地进程关闭不再把 terminate resolve 当 closed

文件：`src/main/commands/local-command-core.ts`

- 新增独立探测 `probeTreeGone(pid, child)`、`terminationConfirmMs`（默认 3000ms，轮询 50ms）、`treeSettleMs`（默认 500ms）。
- 失败路径：先 `collector.discard()` 丢弃完整输出 → reject 结果 → `terminatePluginProcess` resolve 后再轮询探测；
  只有“PID 仍是本次 spawn 且进程组消失”才 `settleClose({state:'closed',localClosed:true,remoteTerminated:'confirmed'})`；
  超窗未消失 ⇒ `{state:'unconfirmed',localClosed:true,remoteTerminated:'unknown',detail:'Local process tree was still present 3000ms after termination'}`，调度名额继续占用。
- 正常 `close` 路径：根进程 close 立即返回真实 `exitCode`，但整树关闭要再确认后台组（默认 500ms）；
  仍有存活成员 ⇒ `unconfirmed` + `detail:'Background processes were still alive 500ms after the command exited'`，不伪报整树 confirmed。
- PID 身份保护：`targetPidMatches` 要求 `child.pid === 派发时记录的 pid`；未用命令行/进程名匹配。
- 默认探测：POSIX `process.kill(-pid, 0)` 成功=仍存活、`ESRCH`=已消失；Windows 以根进程 close/退出为准。
- 测试注入：`probeTreeGone`、`treeSettleMs`、`terminationConfirmMs`；生产默认值不变。未修改 `src/main/plugin/process-cleanup.ts`。

### 1.2 失败诊断片段计入预算；关闭不明升级 OUTCOME_UNKNOWN

文件：`src/main/commands/command-service.ts`、`src/main/commands/types.ts`、`src/main/file/command-output.ts`

- `CommandTargetOutcome.reason?: string` 新增；失败升级时保留 `reason:'OUTPUT_LIMIT'`（FORBIDDEN 保留 `'FORBIDDEN'`）。
- 结果失败结算时先归还该目标旧预留（`releaseTargetBytes`），再由 `retainPartial(index, partial)` 按
  `Buffer.byteLength(partial)` 重新预留；预留失败则省略 `partialOutput`，不超卖。
- `CommandOutputCollector.discard()`：失败后立即释放完整输出占用（`text=''`/`bytes=0`，保留 `sanitized` 状态）。
- `failureOutcome` 语义：
  - 未派发（`!handle.dispatched` 或 `remoteTerminated==='not-dispatched'`）⇒ `state:'not-started'`，`retryDisposition:'safe'`（FORBIDDEN 仍 `never`）；
  - 已派发但 `close.state !== 'closed' || close.remoteTerminated !== 'confirmed'` ⇒ `state:'outcome-unknown'`、`code:'OUTCOME_UNKNOWN'`、`retryDisposition:'reconcile-first'`，`reason` 保留原始诱因；
  - 关闭已确认 ⇒ 保留原 `OperationError.code`/`retryDisposition`（输出限制为 `RESOURCE_LIMIT`/`never`，`reason:'OUTPUT_LIMIT'`）。
- `execution.release()` 后迟到预留会抛 `RESOURCE_LIMIT: Command batch no longer accepts output (results already settled)`，不再增长批次/全局额度。

### 1.3 shutdown 接口与发送预算

文件：`src/main/commands/command-scheduler.ts`、`src/main/commands/command-service.ts`、`src/main/commands/types.ts`、`src/main/commands/index.ts`

```ts
interface CommandShutdownResult { state: 'closed' | 'unconfirmed'; reason: CancelReason; cancelled: number; unconfirmed: number }
interface CommandServiceShutdownResult extends CommandShutdownResult { batches: number }
```

- `CommandScheduler.shutdown(reason='shutdown', timeoutMs=10000)`：设置 `shuttingDown`，同步拒绝新 `schedule`
  （`CONTROL_CONFLICT: Command scheduler is shutting down`）；排队项 `abort` + `not-started` 结算；
  在途项 `cancel(reason)`；等待真实 `entry.closed`，超时/未确认计入 `unconfirmed`。
- `CommandService.shutdown(reason='shutdown')`：同步拒绝新 `runBatch`（`CONTROL_CONFLICT: Command service is shutting down`）；
  先同步启动 `scheduler.shutdown`（防止释放名额时把排队项放出去），再 `abandon` 各批次（停止收集、取消、结算
  `outcome-unknown`），最后等待调度器关闭并释放批次保留预算；返回 `{...schedulerResult, batches}`。
- 关闭结果：排队目标 `not-started`；在途目标 `outcome-unknown`/`unconfirmed`；`state:'unconfirmed'` 时名额不提前归还。绝不以伪造 `closed` 结束。
- `estimateSendBytes(outcome)` 现包含 `sessionId`、`reason`、`output`、`partialOutput`、`error` 的 JSON 转义字节 + 256；
  `estimateBatchSendBytes` 逐项和 + 512。接线仍是：发送前 `reserveSendBytes`，`finish`/`close` 时
  `releaseSendBytes` + `execution.release()`（幂等）。

### 1.4 取消后丢弃后续收集、保持资源位

文件：`src/main/commands/local-command-core.ts`、`src/main/file/ssh-command-executor.ts`、`src/main/file/ssh-command-shell.ts`、`src/main/file/shell-command-output.ts`

- 本地核心失败即 `discard()`；后续 stdout/stderr 因 `resultSettled` 直接丢弃；关闭确认期间名额仍由调度器持有。
- SSH executor 的 `fail`/`settleNotDispatched` 丢弃 collector；关闭回执仍分 `unknown`/`not-dispatched`。
- SSH shell `reset()` 丢弃当前 `ShellCommandOutput`，迟到数据不再计入预算；在途命令按 `commandWritten` 标记
  `remoteTerminated:'unknown'`，排队命令 `not-dispatched`。
- 批次 `settleDeadline` 设置 `accepting=false`；未知结果返回后迟到 settle 不再新增预算。

## 2. 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/main/commands/local-command-core.ts` | 进程树独立探测、终止确认、根 close 后台组确认、discard、注入选项 |
| `src/main/commands/command-scheduler.ts` | `shutdown`、`activeEntries`、关闭期间拒绝新任务、关闭统计 |
| `src/main/commands/command-service.ts` | 批次 shutdown、accepting/released 守卫、partial 预算、OUTCOME_UNKNOWN 升级、发送估算含 sessionId |
| `src/main/commands/types.ts` | `CommandTargetOutcome.reason`、`CommandShutdownResult` |
| `src/main/commands/index.ts` | 导出 `CommandServiceShutdownResult` |
| `src/main/file/command-output.ts` | `CommandOutputCollector.discard()` |
| `src/main/file/shell-command-output.ts` | `discard()` 委托 |
| `src/main/file/ssh-command-executor.ts` | 失败/未派发路径 discard |
| `src/main/file/ssh-command-shell.ts` | `reset()` discard 当前输出 |
| `src/main/commands/*.test.ts`、`src/main/file/command-output.test.ts`、`src/main/file/ssh-command-handle.test.ts` | 新增/更新回归测试 |

`src/main/mcp/local-command-stream.ts` 本轮无新增改动（仍是核心的兼容包装）。
`tmp/remediation-r3-interface.md` 增加第 7 节：shutdown 接线、发送预算、关闭确认说明。

## 3. 真实验证

工作目录：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | EXIT 0（tsc --noEmit + tsconfig.node.json） |
| `node node_modules/vitest/vitest.mjs run src/main/commands src/main/file/ssh-command.test.ts src/main/file/ssh-command-authorization.test.ts src/main/file/ssh-command-handle.test.ts src/main/file/command-output.test.ts src/main/mcp/local-command-stream.test.ts` | EXIT 0，9 文件 / 83 tests passed（日志 `tmp/r3-corrections-targeted.log`） |
| `npx eslint --max-warnings=0 src/main/commands src/main/file/ssh-command-executor.ts src/main/file/ssh-command-shell.ts src/main/file/shell-command-output.ts src/main/file/command-output.ts src/main/mcp/local-command-stream.ts src/main/file/ssh-command-handle.test.ts src/main/file/command-output.test.ts` | EXIT 0 |
| `node node_modules/vitest/vitest.mjs run src/main/mcp/confirmation-authorization.test.ts` | EXIT 1，外部阻塞（见第 4 节） |

新增/更新的关键断言：

- `local-command-core.test.ts`（10）：terminate resolve 但探测未确认 ⇒ 不 closed，确认后才 closed；探测持续 false ⇒ `unconfirmed` 且保留名额；根 close 后后台组仍存活 ⇒ 结果可用但整树 `unconfirmed`；超时/取消/输出限制仅在注入探测为 true 时 closed。
- `command-scheduler.test.ts`（12）：关闭后新任务 `CONTROL_CONFLICT`；排队项取消、在途等待关闭；未确认时 `state:'unconfirmed'` 且 active 仍为 1，迟到关闭后才归零。
- `command-service.test.ts`（15）：partialOutput 计入 `retainedBytes`（中文 6 字节）；容量不足省略 partial；关闭不明升级 `OUTCOME_UNKNOWN` + `reason:'OUTPUT_LIMIT'`；关闭确认保留 `RESOURCE_LIMIT`/`never`；shutdown 取消排队+在途、释放预算、`batches:2`；release 后迟到预留抛错且额度为 0；发送估算随 sessionId 增长。

## 4. 遗留问题

1. **外部测试阻塞（非 R3 所有权）**：`src/main/mcp/confirmation-authorization.test.ts` 的 `vm.runInNewContext`
   裁剪名单缺少主代理新增的 `allowsShutdownRelease`，稳定报
   `ReferenceError: allowsShutdownRelease is not defined`（1 failed / 8 passed）。修复：把该 helper 及依赖加入测试
   `names`/`context`，或改为注入 seam。`src/main/mcp/command-dispatch-authorization.test.ts` 同类 VM 测试此前也因
   新增 helper 未入名单失败，需一并补充 `commandService`/`commandCaller`/`scheduledCommandTarget`/
   `retainCommandResponse`/`sendCommandFailure` 及 `bindingCredentialIds`。
2. **root 接线未执行（按要求）**：`http-server.ts` 需导出
   `stopCommandExecutions()`（调用现有 `commandService.shutdown('shutdown')`）并在 `src/main/index.ts` quit 流程 await；
   结果发送仍按接口文档 `reserveSendBytes` → `finish/close` → `releaseSendBytes` + `execution.release()`。
3. **共享类型可选补充**：`BatchCommandResult` 目前无 `reason?`；若 UI 要显示 `OUTPUT_LIMIT`，主代理可在
   `src/main/mcp/types.ts` 增加只读可选字段（本模块已输出 `CommandTargetOutcome.reason`）。
4. **语义限制**：SSH 远端退出仍不可观测，`remoteTerminated` 只到 `unknown`/`confirmed`（通道级）；本地探测在
   Windows 以根进程退出为准，无进程组等价探测；保留预算是 UTF-8 内容量而非 RSS。
5. **未执行**：未跑全量 `npm run test`（并行工作者的 `confirmation-authorization.test.ts` 已知失败会污染结果）；
   未做 Electron 端到端 smoke（本轮为纯主进程逻辑）。
