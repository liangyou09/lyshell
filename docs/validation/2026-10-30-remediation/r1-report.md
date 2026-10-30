# R1 隔离匹配服务（pattern matcher）实施与验证报告

- worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`
- 分支：`codex/complete-remediation-20261030`
- git HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`（未提交、未推送；主目录 `D:/workspace/claude/LyShell/src` 未触碰）
- 依赖：`node_modules` 经 junction 复用主目录，未执行 `npm install`/`npm ci`
- 接口先行文档：`tmp/remediation-r1-interface.md`（含第 7 节"落地补充"，为主代理的接线契约）
- 结论：R1 的隔离匹配服务、`SessionManager.sendAndWait` 接入、`WaitForPattern` 只读等待入口与回归测试已实现；本次改动范围内 typecheck / lint / 构建 / 测试全部通过。**唯一未完成的接线是 `src/main/index.ts` 的两行 holder 赋值**（该文件属主代理），以及安装包内 Worker 加载无法在本机验证。

## 1. 动作

1. 先做**修复前失败复现**：用外部看门狗跑主线程同步正则（旧 `new RegExp` 写法），证明主线程一旦进入灾难性回溯，没有任何 timeout/abort 能介入（见 3.1）。
2. 新增隔离匹配三件套：`pattern-contract.ts`（纯契约/预算/错误映射）、`pattern-worker.ts`（唯一构造与执行外部正则的地方）、`pattern-matcher.ts`（有界池、期限、terminate-确认退出、预算、迟到消息、shutdown）。
3. 重写 `SessionManager.sendAndWait`：异步 Worker 校验 → 重新确认 → 写输入 → 按游标/epoch 观察；新增只读 `SessionManager.waitForPattern`（`wait_for_prompt`/`tail_until` 共用）。
4. `electron.vite.config.ts` 增加 `patternWorker` 构建入口 → `dist/main/patternWorker.js`。
5. 用探针核对真实时序，修掉"Worker 启动出错后槽位永久占位"的容量泄漏（`onWorkerError` 现在会 terminate 并在 exit 确认后归还容量）。
6. 新增 4 个测试文件（46 个用例），覆盖计划 3.6 的逐条验收；其中灾难性回溯用例在**独立子进程 + 外部看门狗**中验证。
7. 写本报告与 `tmp/remediation-r1-interface.md`。

## 2. 改动文件（我的所有权范围内）

| 文件（绝对路径） | 规模 | 说明 |
| --- | --- | --- |
| `C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell/src/main/terminal/pattern-contract.ts` | 321 行（新） | MatchMode/PatternSpec、`PATTERN_LIMITS`、固定错误表 `FAILURE_SPECS`、`PatternMatchError`、`validatePatternSpec`（同步、不编译）、`validateMatchInputs`、Worker 协议与 `isPatternWorkerResponse` |
| `.../src/main/terminal/pattern-worker.ts` | 107 行（新） | Worker 内 `new RegExp`（无 flags，避免 g/y lastIndex）、compile/match、错误帧，`ready{protocol:1}` |
| `.../src/main/terminal/pattern-matcher.ts` | 617 行（新） | 有界池：2 Worker / 16 排队 / 每主体 4 / 全局 16 waiter / 16Mi 输入预留、100ms 执行期限（从派发起算）、2000ms 启动期限、terminate 后确认 exit 才归还容量、迟到帧计数、`shutdown`、单例 `patternMatcher`、退出挂接 `stopPatternMatcher` |
| `.../src/main/terminal/session-manager.ts` | +343/−52 | `SendAndWaitOptions` 增 `waitForPatternMode`/`callerKey`/`signal`；`Session.pendingWaitOwner` 锁 owner；`sendAndWait` 按 3.4 顺序重写；新增 `waitForPattern`（`new-output`/`recent` 两种观察域、`checkHistoryFirst`、`authorizeObservation`）；`assertSendAndWaitReady`/`assertSendAndWaitLive`/`waitPatternBases`/`matchOnce`/`delay` |
| `.../electron.vite.config.ts` | +4/−1 | `main.rollupOptions.input.patternWorker = src/main/terminal/pattern-worker.ts` |
| `.../src/main/terminal/pattern-test-support.ts` | 62 行（新） | 测试用 esbuild 打包**真实源码**为 CJS（禁止生产用 eval 字符串） |
| `.../src/main/terminal/pattern-contract.test.ts` | 13 用例 | 契约/预算/错误码/帧校验 |
| `.../src/main/terminal/pattern-matcher.test.ts` | 16 用例 | 真实 Worker 语义 + 敌意回溯 + 队列/配额/公平性/超时/启动失败/迟到消息/shutdown |
| `.../src/main/terminal/pattern-isolation.test.ts` | 2 用例 | 子进程 + 外部看门狗验收；源码级隔离断言 |
| `.../src/main/terminal/session-manager.wait-pattern.test.ts` | 15 用例 | 锁 owner、游标/epoch、授权、代际、历史预检、缺口、断连、迟到结果丢弃 |

未触碰：`src/main/mcp/http-server.ts`、`src/shared/api-routes.ts`、`src/main/mcp/types.ts`、`src/main/index.ts`、`src/main/terminal/local-host-*.test.ts`（他人并行改动）。`dist/` 为构建产物，`tmp/` 与 `docs/` 不参与构建/类型检查。

## 3. 真实验证（cwd 均为 worktree 根）

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 3.1 修复前复现 | `node tmp/r1-watchdog.mjs 6000 tmp/r1-prefix-mainthread-repro.mjs` | **3** | `{"verdict":"WATCHDOG_TIMEOUT","timeoutMs":6000,"wallMs":6385}`，stdout 停在 `{"phase":"compiled"}`：主线程同步 `^(a+)+$`.test(29 字符) 6 秒不可打断，看门狗强杀。日志 `r1-prefix-repro.log` |
| 3.2 定向测试 | `node node_modules/vitest/vitest.mjs run src/main/terminal/pattern-contract.test.ts src/main/terminal/pattern-matcher.test.ts src/main/terminal/pattern-isolation.test.ts src/main/terminal/session-manager.wait-pattern.test.ts` | **0** | 4 files / **46 tests passed**（contract 13、matcher 16、isolation 2、wait-pattern 15）。日志 `r1-focused-tests.log` |
| 3.3 终端回归 | `node node_modules/vitest/vitest.mjs run src/main/terminal` | **0** | 20 files / **315 tests passed**（含既有 `session-manager.failure.test.ts` 9 passed，未被我重写破坏）。日志 `r1-terminal-tests.log` |
| 3.4 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` / `... -p tsconfig.node.json --noEmit` | **0 / 0** | 两个配置均无输出。日志 `r1-typecheck-renderer.log`、`r1-typecheck-node.log` |
| 3.5 lint | `node node_modules/eslint/bin/eslint.js <9 个改动文件>` | **0** | 无告警（日志为空文件 `r1-lint.log`） |
| 3.6 构建 | `node node_modules/electron-vite/bin/electron-vite.js build` | **0** | 产出 `dist/main/patternWorker.js`（2805 B）+ `dist/main/chunks/pattern-contract.js`（5477 B）。日志 `r1-build.log` |
| 3.7 构建产物加载 | `node tmp/r1-watchdog.mjs 8000 tmp/r1-built-worker-check.mjs` | **0** | `{"verdict":"COMPLETED","wallMs":112}`：加载 `dist/main/patternWorker.js`，`ready{protocol:1}`，literal/regex/内置提示符三帧均 `matched:true`，非法 `(` 返回 `INVALID_PATTERN`。日志 `r1-built-worker.json` |
| 3.8 失败路径探针 | `node tmp/r1-missing-worker-probe.mjs` | **0** | 缺失脚本 → `MATCH_WORKER_FAILED`（31 ms，`terminations:1`，退出确认 `confirmedExits:1`）；非法正则 → `INVALID_PATTERN`（28 ms，Worker 保持可用）。日志 `r1-missing-worker-probe.log` |
| 3.9 邻近回归（他人所有权） | `node node_modules/vitest/vitest.mjs run src/main/mcp` | **1** | 27 files / 286 tests，**1 failed**：`confirmation-authorization.test.ts`（`ReferenceError: allowsShutdownRelease is not defined`）。属 §5 外部失败，与 R1 无关。日志 `r1-mcp-regression.log` |

## 4. 关键实现要点（与计划 3.1–3.6 对照）

### 3.1 修复入口

- `src/main/mcp/http-server.ts` 三处 `new RegExp`（旧 3123/3331/1138）已由主代理移除；本 worktree 实测 `grep -rn "new RegExp(" src --include=*.ts`（排除测试）：`session-manager.ts`、`mcp/http-server.ts` 均为 0；`src/main` 中唯一**由外部输入**构造正则的地方是 `src/main/terminal/pattern-worker.ts:33`（其余为固定/生成式用法：`file/shell-command-output.ts:17`、`i18n.ts:87`、`mcp/destructive-check.ts:335`、`mcp/glob.ts:78`、`mcp-server/index.ts:428`、renderer 各处）。
- `pattern-isolation.test.ts` 增加源码级断言：`session-manager.ts` 与 `mcp/http-server.ts` 源码中不得出现 `new RegExp(`，`pattern-worker.ts` 必须出现——以后任何"图省事在主线程编译"的回归会直接失败。
- 没有主线程回退：Worker 启动失败/超时/异常退出一律返回 `RESOURCE_LIMIT`，槽位在 exit 确认前不归还，绝不改走主线程执行。

### 3.2 API 兼容与观察域

- `waitForPattern`/`sendAndWait` 的 `pattern`/`waitForPattern` 默认仍是 **regex**；新增 `mode`/`waitForPatternMode: 'regex' | 'literal'`；无 pattern 时用 `BUILTIN_PROMPT_PATTERN = '[$#>%]\\s*$'`，此时显式给 mode → `INVALID_ARGUMENT`/`PATTERN_MODE_WITHOUT_PATTERN`（测试覆盖）。
- 不使用任何 flags（`new RegExp(pattern)` 无 `g`/`y`），避免 `lastIndex` 状态。
- 观察域：`wait_for_prompt` = `scope:'new-output', checkHistoryFirst:true, historyLines:1000`（先查最近历史，再只看新输出）；`send_and_wait` = 记录 `getWriteCursor()` 后只看该游标之后；`tail_until` = `scope:'recent', historyLines:500`（每轮最近行）。每次都同时匹配 **raw 与 ANSI 清洗**两份基底（`matchedIndex` 标明命中哪份）。
- 缺口/纪元：`getOutputEpoch()` 变化或 `getEarliestCursor() > 记录游标` → `OUTCOME_UNKNOWN` + `reconcile-first`，不静默只匹配最后一段。

### 3.3 池与期限

`PATTERN_LIMITS`：pattern ≤ 2048 UTF-16、单基底 ≤ 1,048,576、单任务 ≤ 2,097,152、Worker 2、排队 16、每主体 waiter 4、全局 waiter 16、全局预留输入 16,777,216、单次匹配 100 ms（从派发起算，含编译）、启动期限 2000 ms、退出确认期限 5000 ms。

- 入队前置检查顺序：已关闭 → 已 abort → 每主体上限 → 全局上限 → 预留输入预算 → 队列长度；排队超时（`MATCH_QUEUE_TIMEOUT`）与执行超时（`MATCH_EXECUTION_TIMEOUT`）用单调时钟分别计算。
- 超时/取消 → `worker.terminate()`，`Promise.race(exitPromise, workerExitDeadlineMs)`；**只有 `exit` 确认后** `releaseSlot`，否则 `unavailableSlots++` 且槽位保持占用（不无限补充 Worker）。
- 迟到/畸形/generation 不匹配的帧只计 `lateMessages` 并丢弃；`slot.job` 已结算的帧不会污染下一个任务。
- `shutdown()`：拒绝新任务（`MATCH_SERVICE_SHUTDOWN`）、拒结排队、terminate 在途、与退出期限赛跑，返回 `{confirmedExits, unconfirmedExits}`；`stopPatternMatcher()` 把未确认退出转成 reject，供退出协调器记入 unconfirmed。

### 3.4 sendAndWait 顺序（严格保持）

同步形态校验 → 连接/缓冲/并发锁 → `patternMatcher.validate`（同步、不编译）→ 取会话等待锁（`pendingWaitOwner = Symbol('sendAndWait')`）→ `await patternMatcher.compile()`（Worker 内验证；失败不写终端、释放锁）→ `assertSendAndWaitReady`（同 session 实例、connector 代际、`authorizeInput()`、`inputControl.assertInput(control)` 围栏）→ 挂 `data` 监听 + 记 `startCursor`/`outputEpoch` → `writeToSession`（既有受控写入路径）→ 循环内 `assertSendAndWaitLive` + 重新授权 + 缺口检查，仅在快照游标变化时才重新派发匹配 → 命中后**再确认**才接受 → 任何出口都只释放自己的锁、摘监听、归还快照预算。

### 3.5 错误

沿用 `OperationError`。固定公共消息（不含正则源/终端输出/堆栈），`code`/`retryDisposition` 见 `tmp/remediation-r1-interface.md` §3 + §7.1：非法正则/不支持模式/无 pattern 给 mode → `INVALID_ARGUMENT` 且无输入副作用；预算与超时 → `RESOURCE_LIMIT`；会话被替换 → `STALE_GENERATION`；输入已写出后观察失败 → `OUTCOME_UNKNOWN`（reconcile-first）；读等待到期是正常结果（`matched:false, settled:false, reason:'timeout'`）。

### 3.6 验收覆盖（测试对应关系）

| 验收项 | 覆盖用例 |
| --- | --- |
| literal / 默认 regex / 内置提示符 / 合法复杂正则 / 非法正则 | `pattern-matcher.test.ts` 前 4 例、`pattern-contract.test.ts`、`wait-pattern.test.ts`（默认 regex、literal 传参） |
| 29 字符灾难性回溯（隔离子进程 + 外部看门狗） | `pattern-isolation.test.ts`：spawn 子进程跑打包后的真实 `pattern-matcher.ts`，外部看门狗 12 s 强杀；断言 `verdict REJECTED / MATCH_EXECUTION_TIMEOUT / RESOURCE_LIMIT / <5 s` |
| 主线程保持响应 | `pattern-matcher.test.ts`：敌意匹配进行中 20 ms 心跳 <150 ms，且另一调用方的 literal 匹配在 2 s 内完成 |
| raw/clean 双基底、跨块、历史预检、新输出游标、clear/trim 缺口 | `pattern-matcher.test.ts` matchedIndex 0/1；`wait-pattern.test.ts` 跨两块 `foo`+`bar`、`checkHistoryFirst`、游标不误判旧输出、`buffer.clear()` 与 1.2 MB 溢出 → `OUTCOME_UNKNOWN` |
| 编译等待期间撤销/重连/删除/接管 | `wait-pattern.test.ts`：编译期断连 → `STALE_GENERATION`（旧 connector 未写）、他人接管 → `CONTROL_CONFLICT`、`authorizeObservation=false` → `FORBIDDEN` |
| Worker 启动失败 / 执行超时 / 异常退出 / 迟到消息 / shutdown | `pattern-matcher.test.ts` 有界池 8 例（含 `HOLD` 迟到帧、脚本缺失、永不 ready、shutdown 计数归零） |
| 多调用方排队/公平/容量恢复/无锁泄漏 | 公平性断言 `order === ['A1','B1','A2']`；超时后容量恢复；`wait-pattern.test.ts` 并发第二个 `sendAndWait` → `CONTROL_CONFLICT` 且锁可重入 |
| dev build / unpacked / 安装包加载 Worker | 已验 3.6 构建 + 3.7 用 `worker_threads` 直接加载 `dist/main/patternWorker.js`；**安装包（asar 内）加载未本地验证**（见 §6） |

## 5. 观察到的外部失败（不属 R1，未修改）

`src/main/mcp/confirmation-authorization.test.ts`（主代理所有权）失败：`ReferenceError: allowsShutdownRelease is not defined`。原因与 `r3-report.md:97` 记录一致——该测试把 `http-server.ts` 的函数裁剪到 `vm.runInNewContext`，主代理新增的 `allowsShutdownRelease` 未进入裁剪名单/上下文。R1 不涉及该文件。

## 6. 遗留与无法本地验证

1. **`src/main/index.ts` 两行接线未做**（该文件属主代理，按指令不改）：holder 与 `registerStep('revoke','pattern-matcher', ...)` 已在位，但 `current` 从未赋值，matcher 不会在退出时关闭。所需接线见 `tmp/remediation-r1-interface.md` §7.3：

   ```ts
   import { stopPatternMatcher } from './terminal/pattern-matcher'
   patternMatcherShutdown.current = stopPatternMatcher
   ```
2. **安装包（asar 内）Worker 加载未本地验证**：`dist/main/patternWorker.js` 在 dev/unpacked 布局下已实测可加载；`electron-builder.yml` 把 `dist/**` 打进 asar（与既有 `worker.js`/`uploadWorker.js` 相同形态），asar 内 `new Worker(path)` 依赖 Electron 的 asar 补丁，本机未构建安装包，未验证。
3. **真实 Electron 运行时未验证**：所有 Worker 测试跑在 Node 24 + vitest 下（`worker_threads` 行为一致），未在 `npm run dev` 起的 Electron 主进程里跑敌意正则；渲染/主进程交互不属于 R1 范围。
4. **100 ms 执行期限与 CPU 争抢**：期限从派发起算（含编译+匹配）。本机并行跑多个构建/测试时，曾观察到 3 个"瞬时"用例偶发 `MATCH_EXECUTION_TIMEOUT`（随后单独重跑与全量重跑均通过）。这是计划规定的硬期限在有界池上的预期取舍（宁可失败也不上主线程），但若 CI 长期高负载导致抖动，需要在计划层面决定是否放宽 `matchDeadlineMs`，而不是加主线程回退。
5. 探针与复现脚本保留在 `tmp/`（`r1-watchdog.mjs`、`r1-prefix-mainthread-repro.mjs`、`r1-probe-backtracking.mjs`、`r1-built-worker-check.mjs`、`r1-missing-worker-probe.mjs`），不参与构建与类型检查。

## 7. 给主代理的接线摘要

- `wait_for_prompt` → `sessionManager.waitForPattern(id, { pattern: data.pattern, mode: data.patternMode, scope: 'new-output', checkHistoryFirst: true, historyLines: 1000, timeoutMs, idleMs, callerKey, signal, authorizeObservation })`。
- `tail_until` → `waitForPattern(id, { ..., scope: 'recent', historyLines: 500, idleMs: 0, pollMs })`；结果 `reason === 'disconnected'` 时映射为既有 `reason: 'session disconnected'`。
- `send_and_wait` → 透传 `waitForPatternMode`/`callerKey`/`signal`；`OperationError` 用 `sendOperationError`（`reason` 透出）。
- 退出路径 → `patternMatcherShutdown.current = stopPatternMatcher`（`revoke` 阶段，`stopMcpHttpServer()` 之后）。
- 契约字段 `patternMode`/`waitForPatternMode`（`'regex'|'literal'`）已在 `src/shared/api-routes.ts`、`src/main/mcp/types.ts` 就位（只读核对，未修改）。
