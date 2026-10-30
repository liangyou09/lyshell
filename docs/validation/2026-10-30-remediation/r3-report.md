# R3 全局命令调度、输出/发送预算与资源关闭契约 — 实施报告

- 工作树：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`
- 基线：`git rev-parse HEAD` = `36739a6deb32bc45bf7dcbf29635cce9c306230c`（分支 `codex/complete-remediation-20261030`）
- 执行模式：实施与定向验证；未提交、未推送、未改运行实例/设置/权限
- 计划依据：`docs/lyshell-complete-remediation-plan-2026-10-30.md` 第 5 节（R3，5.1–5.7）与 15.2
- 接口交接文档：`tmp/remediation-r3-interface.md`（已随主代理 HTTP 接入更新为一致状态）

## 1. 改动清单

### 1.1 新增（本工作者独占）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `src/main/commands/types.ts` | 152 | `CommandExecutionHandle`/`CommandResult`/`ResourceCloseResult`/`CommandTargetOutcome` 契约、`COMMAND_LIMITS` 默认限额 |
| `src/main/commands/output-budget.ts` | 144 | 保留额度（批次/全局）与发送额度（64 MiB）账本、UTF-8 与 JSON 转义字节估算 |
| `src/main/commands/command-scheduler.ts` | 390 | 全局 16 / 调用者 4 / 端点 2 活动名额，全局 128 / 调用者 50 有界队列，按调用者轮转 + 端点无队头阻塞 |
| `src/main/commands/command-service.ts` | 340 | 批次编排：固定目标顺序、总期限（默认 55 s）、结果汇总、保留/发送预算入口、`release()` |
| `src/main/commands/local-command-core.ts` | 177 | 本地命令执行核心，带 `resourceClosed`（先结果失败、后进程树回收确认） |
| `src/main/commands/index.ts` | 9 | 统一导出 |
| `src/main/file/command-output.ts`（重写） | 128 | `CommandOutputCollector`：stdout/stderr 独立增量 UTF-8 解码、字符上限 + 字节额度、`partialOutput` |
| `src/main/file/command-output.test.ts` | — | 7 项收集器/预算测试 |
| `src/main/commands/output-budget.test.ts` | — | 9 项预算/转义测试 |
| `src/main/commands/command-scheduler.test.ts` | — | 10 项名额/公平/队满/座位保持测试 |
| `src/main/commands/command-service.test.ts` | — | 10 项批次/总期限/预算/双调用者 50 目标测试 |
| `src/main/commands/local-command-core.test.ts` | — | 7 项本地句柄/终止失败/超时/取消测试 |
| `src/main/file/ssh-command-handle.test.ts` | — | 5 项 SSH 句柄 `resourceClosed` 语义测试 |

### 1.2 修改（行为变化）

- `src/main/file/ssh-command-executor.ts`
  - 新增 `executeCommand(options: SSHCommandOptions): CommandExecutionHandle`；`execRaw`/`execStream` 保留并委托其结果，签名不变。
  - 旧行为：超时/取消/错误时销毁通道后立即 reject，调用方无法区分“本地已关闭、远端未知”。
  - 新行为：结果可先失败；`resourceClosed` 在本地通道关闭后 resolve，`remoteTerminated` 区分 `confirmed`/`unknown`/`not-dispatched`；取消/超时包装为 `OUTCOME_UNKNOWN`（`reconcile-first`）；权限类错误与输出上限错误保留原始 code。
- `src/main/file/ssh-command-shell.ts`
  - 新增 `executeCommand`；持久 shell 的每条命令有独立 `CommandOutputCollector` 与关闭回执；活动命令取消/超时/通道 reset 时按 `commandWritten` 标记远端 `unknown`，未写出的排队命令标记 `not-dispatched`；正常 marker 完成后先确认关闭、再结算结果。
- `src/main/file/shell-command-output.ts`
  - 改为注入 `CommandOutputCollector`（可选参数，旧构造签名仍可用），marker 捕获/尾部分片/位置映射逻辑不变。
- `src/main/file/command-output.ts`
  - 保留 `MAX_COMMAND_OUTPUT_CHARS` 与 `appendCommandOutput` 原错误文本；新增收集器与 `CommandOutputLimitError`（`RESOURCE_LIMIT` + `partialOutput`）。
- `src/main/mcp/local-command-stream.ts`
  - 由 55 行执行实现变为 21 行兼容包装：`executeLocalCommandStream(...)` 委托 `createLocalCommandExecution(...).result`，导出名/签名不变；早先“先 reject 再异步 terminate”的座位提前释放问题消除。

未触碰：`src/main/mcp/http-server.ts`、`src/main/mcp/api-routes.ts`、`src/main/mcp/types.ts`、`src/main/index.ts`、`src/shared/*`、`D:/workspace/claude/LyShell/src`。

## 2. 契约与限额

```ts
interface CommandExecutionHandle {
  result: Promise<CommandResult>            // { output, exitCode }；可先于 resourceClosed 失败
  resourceClosed: Promise<ResourceCloseResult>
  cancel(reason: CancelReason): void        // 幂等
}
type ResourceCloseResult = {
  state: 'closed' | 'unconfirmed' | 'failed'
  localClosed: boolean
  remoteTerminated: 'confirmed' | 'unknown' | 'not-dispatched'
  detail?: string
}
```

限额（`COMMAND_LIMITS`）：

| 项 | 值 |
| --- | --- |
| 全局活动 / 调用者活动 / 端点活动 | 16 / 4 / 2 |
| 全局排队 / 调用者排队 | 128 / 50 |
| 批次保留 / 全局保留 / 全局发送 | 8 MiB / 32 MiB / 64 MiB |
| 批次总期限默认 | 55 000 ms（上限 600 000） |
| 单命令输出字符上限 | 1 048 576（沿用旧值，错误文本不变） |

关键语义：

- **座位只在本地资源关闭确认后归还**：`result` 拒绝/reject 不释放调度名额；`resourceClosed.state === 'closed'` 才释放。`failed`（如进程树回收失败）保留名额并计入 `unconfirmed`，需显式 `reclaim()`。
- **总期限先结算结果、后等资源关闭**：到 `totalTimeoutMs` 时立即把未结算目标标为 `outcome-unknown`/`OUTCOME_UNKNOWN`/`reconcile-first`，同时 `cancel('total-timeout')`；调度名额仍等真实关闭，绝不提前复用。
- **队列满显式拒绝**：`RESOURCE_LIMIT`，消息含 `Command queue is full (caller max 50)` / `(global max 128)`，不静默丢弃、不自动重试。
- **公平性**：按调用者轮转（记录 `lastCallerKey`），同一调用者内部 FIFO；端点饱和时跳到该调用者下一个可运行端点，避免队头阻塞。
- **输出预算**：按 `Buffer.byteLength` 计真实 UTF-8 字节；超限目标得到 `state: 'not-started'`（未写出）或 `error/code: RESOURCE_LIMIT`，`partialOutput` 单独返回（≤4096 字符），**绝不写入 `output`**。
- **发送预算**按 JSON 转义后的字节估算（引号/反斜杠 2、`\n` 等 2、其他控制符 6、代理对 4），在 `JSON.stringify` 前 reserve，响应 `finish`/`close` 后 release。
- **release 时机**：`CommandBatchExecution.release()` 必须在响应写完、客户端断开或结果被丢弃后调用；幂等；未调用会持续占用全局保留额度（不随 result 落定自动释放）。

## 3. 真实验证（工作树 cwd，全部绝对命令）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run typecheck` | EXIT 0（`tsc --noEmit` + `tsc -p tsconfig.node.json --noEmit`） |
| 2 | `node node_modules/vitest/vitest.mjs run src/main/commands src/main/file/ssh-command.test.ts src/main/file/ssh-command-authorization.test.ts src/main/file/ssh-command-handle.test.ts src/main/file/command-output.test.ts src/main/mcp/local-command-stream.test.ts src/main/mcp/command-dispatch-authorization.test.ts` | EXIT 0，10 文件 / 95 测试通过 |
| 3 | `node node_modules/vitest/vitest.mjs run src/main/file/ssh-command-handle.test.ts` | EXIT 0，5 测试通过 |
| 4 | `node node_modules/vitest/vitest.mjs run src/main/commands/command-service.test.ts` | EXIT 0，10 测试通过（含双调用者各 50 目标） |
| 5 | `node node_modules/vitest/vitest.mjs run`（全量） | **EXIT 1**：3 文件失败，见 4.1；其余 421 文件 / 5373 测试通过 |
| 6 | `npx eslint --max-warnings=0 src/main/commands src/main/file/ssh-command-executor.ts src/main/file/ssh-command-shell.ts src/main/file/shell-command-output.ts src/main/file/command-output.ts src/main/mcp/local-command-stream.ts` | EXIT 0（无告警） |

全量日志：`tmp/r3-full-test.log`（本地临时文件，未入库）。

### 3.1 全量失败归因（均非 R3 改动引起）

- `src/main/mcp/confirmation-authorization.test.ts`（稳定复现）：该测试把 `http-server.ts` 中的函数裁剪到 `vm.runInNewContext` 执行，主代理新增的 `allowsShutdownRelease` 未加入裁剪名单/上下文，运行期 `ReferenceError: allowsShutdownRelease is not defined`。属 `src/main/mcp/` 所有权（主代理）。修复：把新 helper 加入测试的 `names` 裁剪列表并在 `context` 提供其依赖（或改为注入式 seam）。
- `src/main/harness/worktree.test.ts`、`src/main/python/engine.test.ts`：并行全量下超时/时序抖动；单独运行 `node node_modules/vitest/vitest.mjs run src/main/harness/worktree.test.ts src/main/python/engine.test.ts` ⇒ EXIT 0（34 测试通过）。与 R3 无调用关系。

## 4. 验收对照（R3 5.1–5.7）

| 条款 | 状态 | 证据 |
| --- | --- | --- |
| 5.1 有界内存 | 已实现 | 单命令 1 Mi 字符硬上限 + 批次 8 MiB / 全局 32 MiB 字节账本；`command-service.test.ts` 双调用者 50 目标断言 active=8、queued=92、retained=8 KiB、activeByEndpoint ≤ 2 |
| 5.2 模块拆分 | 已实现 | `src/main/commands/{types,output-budget,command-scheduler,command-service,local-command-core}.ts`；`local-command-stream.ts` 保留兼容包装 |
| 5.3 限额/公平/队满 | 已实现 | `command-scheduler.test.ts`：调用者/全局/端点上限、轮转顺序 `['a0','b0','a1']`、队满消息、排队取消不派发 |
| 5.4 资源关闭契约 | 已实现 | `command-scheduler.test.ts` 结果先失败仍占座；`local-command-core.test.ts` terminate 未完成时 `resourceClosed` 挂起、terminate 失败 `failed` 保留座位；`ssh-command-handle.test.ts` 正常 `confirmed`、取消 `unknown`、预取消 `not-dispatched`、缺退出码 `-1` |
| 5.5 输出语义 | 已实现 | `command-output.test.ts`：分片中文、stderr 交错顺序、超限 `RESOURCE_LIMIT`+`partialOutput` 不写入 `output`、`onData` 仅在限额检查后；`ssh-command.test.ts` 32 MiB 上限、真实 exit 7 |
| 5.6 身份/队列后复核 | 已实现（服务层） | 目标在批次构建时固定 `endpointKey`；`revalidate()` 在出队后、`dispatch` 前 `await`，失败按 `not-started`；`command-service.test.ts` FORBIDDEN 不派发。HTTP 侧 `scheduledCommandTarget`/`commandDispatchGuard` 由主代理接线 |
| 5.7 异常路径 | 已覆盖（服务/执行层） | 慢客户端/断开/请求超时/显式取消/应用退出中的 HTTP 生命周期属主代理接线；本层覆盖取消、总期限、队列满、spawn 失败、terminate 失败、缺退出码、远端未知 |

## 5. 兼容性与回滚

- 兼容：`SSHCommandExecutor.execRaw/execStream`、`SSHCommandShell.execRaw/execStream`、`executeLocalCommandStream`、`ShellCommandOutput(marker, onData?)`、`cleanCommandOutput`、`CommandDispatchGuard`、`MAX_COMMAND_OUTPUT_CHARS`、`appendCommandOutput` 全部保留原签名/错误文本。
- 行为差异（有意）：取消/超时/通道错误现在以 `OUTCOME_UNKNOWN` 失败（此前是裸 `Error`/超时消息）；调用方若依赖旧错误文本需改为按 `code` 判断。HTTP 映射由主代理完成（409/429）。
- 回滚：`git checkout -- src/main/file/command-output.ts src/main/file/shell-command-output.ts src/main/file/ssh-command-executor.ts src/main/file/ssh-command-shell.ts src/main/mcp/local-command-stream.ts`，删除 `src/main/commands/`、`src/main/file/command-output.test.ts`、`src/main/file/ssh-command-handle.test.ts`；HTTP 侧需同步移除对 `@main/commands` 的引用。

## 6. 未执行 / 已知限制

- HTTP 单条/流式/批量接线由主代理完成，本工作者只读核对（`http-server.ts` 已使用 `commandService.runBatch`、`retainCommandResponse`、`scheduledCommandTarget`）；未做真实 HTTP 端到端（不启动/不改运行实例）。
- SSH 远端进程是否真正终止不可观测：本地通道关闭只确认本地释放，结果标记 `remoteTerminated: 'unknown'`；不自动重发。
- 本地 terminate 失败时座位持续占用，需运维/上层 `reclaim()`；没有自动强杀重试。
- 单命令 1 Mi 字符上限早于批次 8 MiB 触发（中文约 3 MiB 字节），因此批次预算主要约束多目标聚合；如需单命令可用满 8 MiB，需另行放宽 `MAX_COMMAND_OUTPUT_CHARS`（会改变既有错误契约）。
- 保留/发送预算是内容字节/JSON 转义字节，不是进程 RSS；流式响应依赖 `CommandStreamWriter` 的 256 KiB 队列与 5 s drain 上限（主代理既有实现）。
- 全量 `npm run test` 仍有 3 个外部失败（见 3.1），其中 `confirmation-authorization.test.ts` 需主代理更新裁剪名单。

## 7. 交接

- 接口与接线：`tmp/remediation-r3-interface.md`（含单条/流式/批次映射、发送预算 reserve/release 时机、共享类型建议）。
- 新增测试可直接作为回归：`src/main/commands/*.test.ts`、`src/main/file/command-output.test.ts`、`src/main/file/ssh-command-handle.test.ts`。
