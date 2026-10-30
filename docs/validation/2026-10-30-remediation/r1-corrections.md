# R1 定点修正报告（2026-10-30，第二轮）

- worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`
- git HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`（branch `codex/complete-remediation-20261030`）
- 执行模式：定点修正与验证（未做代码审查、未委派、未改运行实例/设置/权限、未提交/推送）
- 依据：用户 6 条定点修正指令 + `tmp/remediation-root-integration-notes.md` 的 R1 条目（13/14/15/21/22 等）
- 边界：仅改本 worktree 内我属主范围；`src/main/mcp/http-server.ts`、`src/shared/api-routes.ts`、`src/main/mcp/types.ts`、`src/main/index.ts` 未改动（root 已接线）

## 1. 逐条修正对照

### 1.1 只向 ready 且健康的 Worker 派发；100ms 从 ready 后起算；冷启动独立 2s

- `src/main/terminal/pattern-matcher.ts:430` `acquireReadySlot()` 只返回 `ready && !stopping && !exited && job === null` 的槽位；
  未 ready 的槽位不会被派发，任务留在队列。
- `:394` `pump()` 每次循环先取 ready 槽位再出队，冷启动完成后 `onMessage` 的 `ready` 分支显式 `this.pump()`。
- `:523` 执行期限在 `dispatch()` 里从 postMessage 起算；`matchDeadlineMs`（100ms）与 `workerStartDeadlineMs`（2000ms）
  是两条独立期限，冷启动时间不计入执行期限。
- `:40` `WORKER_START_COOLDOWN_MS = 1000` + `:488` `onStartFailure()`：启动失败后 1s 内不重建；
  `:435` 冷却期内若没有仍在启动的 Worker，直接返回 `failed`，由 `:544` `failQueueIfStartupBlocked()` 以
  `MATCH_WORKER_START_FAILED` 快速失败，避免“反复失败在队列期限内无界重建”或误报 `MATCH_QUEUE_TIMEOUT`。
- 证据：`src/main/terminal/pattern-matcher.test.ts` 新增 describe「有界池：冷启动、终止重入与启动失败退避」——
  400ms 延迟 ready（>100ms 且 <2000ms）仍 `matched:true` 且 `{timeouts:0, terminations:0, startFailures:0}`；
  缺失脚本连续 3 次均 `RESOURCE_LIMIT`，`spawned <= 3`、`startFailures >= 1`、总耗时 <5s。

### 1.2 先禁止派发再 terminate 再 finish；终止预算保留到 exit；清理 race timer/listener；迟到 exit 幂等

- `:531` `stopAndFinish()`：`const startupFailure = !slot.ready; slot.stopping = true; if (job) this.finish(job, {error}); this.terminateSlot(slot)`。
  `finish` 内部 `pump()` 因此不可能把新 job 交给仍在跑旧正则的槽位（`acquireReadySlot` 排除 `stopping`）。
- 超时 `:523`、启动期限 `:612`、Worker error `:622`、取消、`shutdown()` 全部走同一顺序。
- `:737` `finish()`：若 `slot.stopping && !slot.exited`，把 `job.inputChars` 记入 `slot.retainedChars`，
  `reservedChars` 不立即归还；`:695` `releaseSlot()`（仅在确认 `exit` 后由 `exitPromise` 调用）归还。
  未确认 exit 的槽位保留在 `slots` 中并计 `unavailableSlots`，不会以“已 terminate”代替释放。
- `:649` `terminateSlot()`：`released || terminating` 直接返回（幂等/重入安全）；清 `startTimer`/`exitTimer`，
  `removeAllListeners('message')` 后再 terminate；迟到 `exit` 经 `releaseSlot` 幂等。
- Worker 构造设 `resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }`
  （注释说明不是 RSS 上限；队列/输入边界仍由 matcher 保证）。
- 证据：同一 describe 的“终止重入”用例——超时后 `terminations:1`，连续两次 `shutdown()` 得到
  `confirmedExits 1` / `0`、`terminations` 仍为 1，100ms 后 diagnostics 收敛
  `{terminations:1, workers:0, queued:0, waiters:0, reservedChars:0, unavailableSlots:0}`。

### 1.3 waiter 配额覆盖整个 sendAndWait / waitForPattern

- `:201` 新增 `acquireWaiter(callerKey): WaiterLease`：全局 16 / 单主体 4，超限 `MATCH_QUEUE_FULL`；
  返回幂等 `release()`。`enqueue`/`finish` 不再计 waiters/callers，避免“队列与在途匹配双扣”。
- `src/main/terminal/session-manager.ts:1171` `sendAndWait`：进入等待前 `patternMatcher.acquireWaiter(callerKey)`，
  `finally` 中 `waiter.release()`；`:1368` `waitForPattern` 同样（含无 pattern 的默认提示符等待）。
- 证据：wait-pattern 测试「等待器租约覆盖整个等待」——`waitForPattern` 仅 1 次 match，跨 120ms 轮询后
  `acquireWaiter` 仍为 1 次且未 release，结束后 release 1 次；`sendAndWait` 异常路径同样 1 次租约并释放。

### 1.4 sendAndWait：非 string pattern、总期限、await 后再核对、已写入后统一 OUTCOME_UNKNOWN

- `session-manager.ts:1171` 同步校验：`waitForPattern !== undefined && typeof !== 'string'` →
  `PATTERN_NOT_A_STRING`（`INVALID_ARGUMENT`，never），不再当作“未提供 pattern”继续写终端。
- 总期限：`startedAt = performance.now()`（编译前），`deadline = startedAt + maxWaitMs`；
  `compile` 的 timeout = `min(5000, deadline - now)`；编译后 `now() >= deadline` → `MATCH_QUEUE_TIMEOUT`（写前失败）。
- `:1550` `assertSendAndWaitReady(..., buffer, options)`：`await this.inputControl.assertInput(...)` 之后**再次**
  核对 session/connector/status/`connectionInstanceId`/`session.outputBuffer === buffer`/`control.sessionId`/`authorizeInput`。
- `:1592` `assertSendAndWaitLive(..., buffer)` 每次 match await 返回（true/false 均）后与 `signal`、`authorizeInput`、
  `:1614` `assertOutputGapFree` 一起重跑，再决定 finalize / idle / 超时。
- 已写入（`inputAttempted = true`）后的所有观察期错误经 `asOutcomeUnknownError` 统一为
  `OUTCOME_UNKNOWN` + `reconcile-first`（保留 `PatternFailureReason`），不会出现 `RESOURCE_LIMIT` + `safe` 诱使客户端重发；
  未写入前的错误保留原 code。
- 证据：wait-pattern 新增用例「非 string pattern」「compile 消耗总期限」「已写入后匹配超时 → OUTCOME_UNKNOWN+reason」
  「match false 后撤权 → FORBIDDEN」。

### 1.5 waitForPattern：返回实际匹配快照、固定 buffer 身份、每次 await 后复核

- `session-manager.ts:1368`：`sameTerminal()` / `disconnected()` / `bufferCurrent()` / `recheck()`；
  `recheck()` 顺序 = 同一终端 → `authorizeObservation()` → 断连（返回 `{matched:false, reason:'disconnected'}`，
  不读 buffer）→ `session.outputBuffer === buffer`（否则 `STALE_GENERATION` 'Terminal changed while waiting for output'，`safe`）
  → 输出缺口（`OUTCOME_UNKNOWN`，reconcile-first）。
- 命中路径 `resultFrom(bases, true, true, 'matched')` 返回**真正被匹配的 bases**：历史预检命中时 output 不再为空。
- `elapsedMs` 全部改用 `performance.now()`（单调时钟）。
- 证据：wait-pattern 用例「历史预检命中返回非空 output」（先 `emit('old banner\r\nuser@host:~$ ')`，结果含 `user@host`）。

## 2. 真实验证（cwd = worktree，日志同目录）

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run src/main/terminal/pattern-contract.test.ts src/main/terminal/pattern-matcher.test.ts src/main/terminal/pattern-isolation.test.ts src/main/terminal/session-manager.wait-pattern.test.ts src/main/terminal/session-manager.failure.test.ts` | 0 | `r1-corrections-focused-tests.log` |
| `node node_modules/vitest/vitest.mjs run src/main/terminal` | 0（20 files / 325 tests） | `r1-corrections-terminal-tests.log` |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | `r1-corrections-typecheck.log` |
| `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit` | 0 | 同上（`tsc-node=0`） |
| `node node_modules/eslint/bin/eslint.js`（8 个改动文件） | 0 | `r1-corrections-lint.log`（空） |
| `node node_modules/electron-vite/bin/electron-vite.js build` | 0 | `r1-corrections-build.log` |
| `node tmp/r1-watchdog.mjs 8000 tmp/r1-built-worker-check.mjs` | 0（`COMPLETED`，155ms） | `r1-corrections-built-worker.log` |

补充事实：

- `dist/main/patternWorker.js` 2805 bytes，`grep -c "new RegExp"` = 1（动态正则只在 Worker 内构造）。
- 构建产物协议校验：`ready{protocol:1}`、literal/regex/prompt 三帧 `matched:true`、非法 `(` →
  `{"reason":"INVALID_PATTERN","message":"Invalid regular expression: /(/: Unterminated group"}`。
- 测试计数：pattern-matcher 19、wait-pattern 22、pattern-contract 13、pattern-isolation 2、session-manager.failure 9。
- 变更新增用例初跑失败并已修正：① 参数错误路径 `pendingWaitLock` 从未赋值（断言改 `toBeFalsy()`）；
  ② 等待器用例原先等待“≥2 次 match”，但同一快照不重复匹配（改为 1 次 match + `delay(120)`）；
  ③ 启动冷却期新任务原会被拖到 `MATCH_QUEUE_TIMEOUT`（改为无启动中 Worker 时快速 `MATCH_WORKER_START_FAILED`）。

## 3. 文件清单（本 worktree）

改动：

- `src/main/terminal/pattern-matcher.ts`（有界池、等待器租约、ready 派发、终止/预算/幂等、轮转公平、诊断）
- `src/main/terminal/pattern-contract.ts`（`PATTERN_NOT_A_STRING`、`MATCH_AUTHORIZATION_REVOKED`、`PatternOutcomeUnknownError`、`asOutcomeUnknownError`）
- `src/main/terminal/session-manager.ts`（sendAndWait 重写、waitForPattern 新增、helper 改造、`pendingWaitOwner`）
- `electron.vite.config.ts`（`patternWorker` 构建入口，唯一共享文件改动）

新增：

- `src/main/terminal/pattern-worker.ts`（唯一的动态正则编译/执行点）
- `src/main/terminal/pattern-test-support.ts`（esbuild 打包真实源码供测试用）
- `src/main/terminal/pattern-contract.test.ts`、`pattern-matcher.test.ts`、`pattern-isolation.test.ts`、`session-manager.wait-pattern.test.ts`
- `tmp/remediation-r1-interface.md`（§7.5 第二轮修正）、`tmp/r1-*.mjs`、`tmp/r1-splice.mjs`、`tmp/r1-sendandwait.txt`、`tmp/r1-waitforpattern.txt`
- 本报告与 `r1-corrections-*.log`

## 4. 遗留问题

1. `src/main/index.ts` 的两行接线仍未落（属主代理）：`import { stopPatternMatcher } from './terminal/pattern-matcher'` +
   `patternMatcherShutdown.current = stopPatternMatcher`（`revoke` 阶段、`stopMcpHttpServer()` 之后、勿放 `final`）。
   在接线前，退出流程不会关闭 matcher 池（`registerStep` 存在但 `current` 为空）。详见 `tmp/remediation-r1-interface.md` §7.3。
2. 安装包（asar）内的 Worker 加载无法在本机验证：只验证到 `electron-vite build` 产物 `dist/main/patternWorker.js`
   可被 `worker_threads` 加载并跑完整协议；`electron-builder` 打包与真实安装目录运行需在打包/安装环境复核。
3. “Worker 迟迟不退、槽位长期不可用”这条路径只有单测级证据（`unavailableSlots` 计数的代码路径），
   没有构造一个拒绝退出的真实 Worker 端到端验证（Node 的 `terminate()` 通常立即生效）。
4. 100ms 硬期限在机器高负载或冷启动抖动下会让正常复杂正则偶发 `MATCH_EXECUTION_TIMEOUT`（计划既定行为，
   客户端应按 `retryDisposition='never'` 不重试同一表达式）。
5. 未执行全量 `npm run test`：本 worktree 有多个并行工作者同时改动，全量结果不代表 R1 状态；
   已按指令只跑受影响测试（terminal 目录 + 两个 tsconfig + lint + build + 构建产物校验）。
