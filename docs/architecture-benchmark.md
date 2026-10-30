# OPT-14 合成混合负载基线

为架构计划 OPT-14 提供可复现的单进程合成基线。脚本
`scripts/architecture-benchmark.ts` 直接引用已实现的 `OutputBuffer`、
`OutputHistoryBudget`、`TerminalOutputDispatcher` 和 `atomic-json`，不复制也不修改
生产模块；约 350 行，硬上限 400 行。

> 只测量**单个 Node 主进程内的合成输出与本地 IO 竞争**。不启动 LyShell，不含真实
> xterm/PTY/SSH/网络/插件/渲染进程，也不接触生产数据。参数为在 3 秒窗口内触发回收与
> 超时而缩放，**不能当作生产 SLO、容量结论或跨平台基线**。

## 被测模块

| 模块 | 在基准中的角色 |
| --- | --- |
| `src/main/terminal/output-buffer.ts` | 32 个会话缓冲，承接假输出并触发容量回收 |
| `src/main/terminal/output-budget.ts` | 全局历史预算，按 LRU 回收并统计 evictions |
| `src/main/terminal/output-dispatcher.ts` | 4 个 GUI 窗口的队列、ACK、超时与重订阅 |
| `src/main/storage/atomic-json.ts` | 每秒一对同步/异步原子 JSON 提交 |

## 运行

要求 Node.js 22.12+（实测 v24.15.0），仓库依赖已安装且 `node_modules/.bin/esbuild`
存在；不安装新依赖，不修改 `package.json`。

```bash
node_modules/.bin/esbuild scripts/architecture-benchmark.ts \
  --bundle --platform=node --format=cjs --target=node22 \
  --tsconfig=tsconfig.node.json \
  --outfile=tmp/architecture/benchmark-build/architecture-benchmark.cjs

node tmp/architecture/benchmark-build/architecture-benchmark.cjs
```

必须在仓库根执行（脚本会校验 `package.json` 与 `src/main/terminal/output-buffer.ts`）。
全程约 17 秒。输出位置固定并会被覆盖：

- `tmp/architecture/benchmark-results.json`：环境、配置、逐轮数值、汇总、16 条断言、清理结果。
- `tmp/architecture/benchmark-report.md`：人读报告，约 35 行。
- `tmp/architecture/benchmark-build/architecture-benchmark.cjs`：esbuild 产物。

退出码：全部断言通过且无致命错误为 `0`，否则为 `1`。断言失败仍会写结果文件；若初始化
阶段失败（如无法创建临时目录），结果文件可能不存在。

## 负载

5 轮 × 3000 ms，每轮重置计数器和 event loop 直方图，结束后等待 300 ms 结算。

- **输出**：32 个会话每 25 ms 各追加 8192 个 UTF-16 码元（含 ANSI 样例），制造约
  8.5 Mi chars/s 的合成产出。
- **历史预算**：总 8 Mi chars、每缓冲 1 Mi chars，故意低于生产默认 32 Mi，使 3 秒内
  稳定触发 LRU 回收。
- **GUI 消费者**：4 个窗口 × 8 个会话。窗口 101/102/103 分别在 1/30/150 ms 后 ACK；
  窗口 104 永不 ACK。ACK 超时 250 ms（生产默认 15000 ms），200 ms 看门狗只重订阅
  已失败的订阅。
- **磁盘 IO**：2 个 worker 从 4 MiB 源文件反复 `pipeline(read → write)` 到临时目录，
  256 KiB 流缓冲，直到本轮结束。
- **原子 JSON**：每 1000 ms 对约 2 KiB 的 state/audit 各提交一次（同步 + 异步），
  3 秒轮次边界处通常为 2 对，偶尔 3 对。
- **预算检查**：每次追加批次（25 ms）和每次 50 ms 内存采样后都检查历史 `usedChars`
  与 GUI `totalPending`，并更新高水位。

## 指标与单位

- **产出/ACK 吞吐**：UTF-16 码元（chars）/秒，报告用 **Mi chars/s**（2^20 chars/s）。
  输出和历史**不是** MiB；只有文件拷贝才用字节（MiB/s）。
- **RSS/heap 峰值**：`process.memoryUsage()` 每 50 ms 采样的最大值。
- **CPU**：`process.cpuUsage()` 的 user+system 增量 / 活跃时长。文件 IO 线程池可使其
  超过单核 100%；跨轮波动大，只作量级参考。
- **event loop**：`monitorEventLoopDelay({ resolution: 10 })` 的 p50/p95/p99/max；
  10 ms 分辨率意味着 p50 低于 10 ms 无法分辨。
- **历史/GUI 高水位**：所有检查点上的历史 `usedChars` 与 GUI `totalPending` 最大值，
  同时记录各自硬预算和违规次数。
- **回收/超时**：每轮 `evictions` 增量与 dispatcher 的 `ackTimeouts` 增量。
- **拷贝/原子 JSON**：完成拷贝的字节数、拷贝吞吐；同步/异步提交次数与最大耗时。
- 汇总对每项给出均值、最小值、最大值；逐轮原始值在 JSON 的 `rounds` 中。

## 断言与清理

16 条断言：

1. 轮次/完整性：`rounds-completed`（含 2.5–5 秒时长检查）、`no-fatal-error`。
2. 缓冲与预算：`buffers-managed`、`history-evictions`、`budget-checks`、
   `history-budget-respected`、`gui-budget-respected`。
3. 消费者：`gui-consumers`、`gui-ack-timeouts`、`gui-acked`。
4. 输出与 IO：`output-produced`、`file-copy-ran`、`atomic-json`（含回读 seq 一致）。
5. 清理：`cleanup-modules`、`cleanup-timers`、`cleanup-temp-dir`。

清理顺序：停止脚本定时器与 ACK 定时器 → 中止并等待拷贝 worker → 等待异步写入 →
回读 state/audit → `dispatcher.dispose()` → 释放缓冲租约 → `budget.dispose()` →
删除临时目录。脚本要求 `timersRemaining = 0`、dispatcher/budget 已销毁、缓冲为 0、
临时目录已删除。

临时目录由 `mkdtempSync(join(tmpdir(), 'lyshell-opt14-benchmark-'))` 创建。删除前要求
`realpath(tempDir) === tempDir`、`dirname === realpath(os.tmpdir())`、basename 以
`lyshell-opt14-benchmark-` 开头，然后只 `rmSync` 该路径；**不会递归清理用户目录**。

## 参考结果

2026-10-29，Windows 10.0.26200 / i5-10505 / Node v24.15.0，一次 5 轮运行（16.6 秒，
16/16 断言通过）：

| 指标 | 5 轮均值（范围） |
| --- | --- |
| 产出吞吐 | 8.50 Mi chars/s（8.41–8.56） |
| ACK 有效吞吐 | 6.38 Mi chars/s（6.31–6.42） |
| RSS / heap 峰值 | 166.7 MiB（145.8–184.0）/ 10.55 MiB（10.43–10.73） |
| CPU | 80.4%（63.5–92.1），波动大，仅量级参考 |
| event loop p50/p95/p99/max | 15.47 / 21.22 / 23.17 / 32.10 ms（单轮 max 46.76） |
| 历史高水位 | 8,388,608 / 8,388,608 chars，违规 0 |
| GUI 队列高水位 | 均值 1.53 Mi chars（1.50–1.63），预算 8 Mi chars，违规 0 |
| 回收 / ACK 超时 | 每轮 97.8 次（70–115）/ 57.6 次（56–64） |
| 文件拷贝 | 356.8 MiB/s（341.1–377.7） |
| 同步原子写最大耗时 | 18.81 ms（单次最大 32.86 ms） |

重跑时数值会变，**以新生成的 JSON 与报告为准**。只有相同脚本/config、同一台机器、
相当负载下的结果才适合对比。

## 局限与明确未测

- 只测单进程合成负载：没有 xterm 渲染、真实 PTY/SSH/网络、插件宿主、MCP 子进程或
  渲染进程；历史预算与 ACK 超时是为 3 秒窗口缩放的，不能推断生产默认值下的行为。
- 文件 IO 在本机临时目录，可能命中页缓存；不代表真实磁盘、网络、杀毒软件或跨机器带宽。
- 未强制 GC；heap/RSS 是 50 ms 采样值。CPU 受 JIT、页缓存、GC、调度影响，跨轮可差数十个百分点。
- 未测：GUI 渲染帧率与绘制耗时、ACK 端到端延迟、PTY/SSH 背压、插件/子进程开销、
  其他平台与机型、生产 SLO/容量。

## 维护

修改 CONFIG 或断言后应同步更新本文件并重新生成结果；报告只保留逐轮表、汇总、清理与
限制，详细数据放 JSON。该脚本是验证工具，不属于产品运行时，无需默认接入 CI。
