# R5：审计串行异步持久化

实施目录：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`。基线 HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`。验证时间：2026-10-30 北京时间 14:16–14:23。未提交、未推送，未改主目录源码、运行实例或权限。

## 已实施

- 新增 `src/main/storage/serialized-json-writer.ts`：完整 JSON 快照、单调 revision/committedRevision、同目标路径串行主提交与备份、2 秒 debounce/5 秒最大调度等待、明确 flush 屏障、draining、固定失败 DTO 与独立序列化/写入耗时。失败保留 dirty，不启动自动忙重试；新的变更或显式 flush 可重试。
- 审计高频保存改用异步原子写。快照在启动写入时序列化为不可变字符串；后续追加、clear 和裁剪不会修改旧在途快照。clear 等待其 revision 提交，旧提交不能在清空确认之后恢复旧数据。
- 旧目录迁移先异步提交 logs，再在 flush 确认后删除旧文件；失败保留源文件。损坏线上日志始终只读，flush 明确失败。
- `atomic-json.ts` 异步版本与同步版本对齐：排他创建的唯一临时句柄、完整写入、文件同步、关闭、rename；POSIX 尽力目录同步，Windows 不声称目录 fsync/掉电保证。新增异步备份函数。同步与异步实现均只清理本次成功创建的临时文件，EEXIST 碰撞不会删除别人的同名对象。
- 查询返回脱敏 persistence 状态，IPC 过滤验证保持输入有界。clear handler 等到真实提交后才成功；设置 handler 等待日志 flush，失败时返回实际 setting 值，避免声称已提交设置未变。preload 与审计面板同步该契约；面板区分尚未提交、主保存失败与仅备份失败，并在 pending 时有界刷新状态。
- 保留低频 `setRetentionLimit` 设置文件的同步提交；未把设置/vault 等跨文件行为冒充整体事务。设置已提交但日志失败时不进行错误回滚。

## 修改文件

生产文件：

- `src/main/storage/serialized-json-writer.ts`（新增）
- `src/main/storage/mcp-audit-repository.ts`
- `src/main/storage/atomic-json.ts`
- `src/shared/mcp-audit.ts`
- `src/main/ipc/handlers.ts`（仅审计查询/clear/retention 局部与对应 import）
- `src/main/ipc/validation.ts`（仅审计查询验证器与对应 import）
- `src/preload/index.ts`（仅审计结果与 clear 类型）
- `src/renderer/components/Layout/McpAuditPanel.tsx`
- `src/renderer/locales/zh.json`、`src/renderer/locales/en.json`（仅审计状态文案）

回归：`serialized-json-writer.test.ts`（新增9项）、`atomic-json.test.ts`（29项）、`mcp-audit-repository.test.ts`（18项，原迁移/损坏/保留量断言迁为异步提交）、`src/main/ipc/mcp-audit-query.test.ts`（新增10项）、`McpAuditPanel.test.tsx`（7项）。

## 实际验证

`r5-checks.json` 记录每条完整命令、开始结束时间、实际 HEAD 和退出码，stdout/stderr 在同目录 `r5-*.log`。

| 检查 | 实际结果 |
| --- | --- |
| 5 文件定向 Vitest | 73 项通过，退出码 0，无未处理异常；`r5-tests.log` |
| 13 个涉及 TS/TSX 文件 ESLint | 0 错误，14 个既有 handlers no-explicit-any 警告，退出码 0；`r5-lint.log` |
| renderer TypeScript | 退出码 0；`r5-typecheck-renderer.log` |
| main TypeScript | 退出码 2；当时其他工作包仍在写入，错误涉及 command-service、index 的旧 flushSync 接线及尚未完成的 session-manager matcher 接入；没有 R5 文件类型错误。不可称全量 typecheck 通过；`r5-typecheck-main.log` |
| R5 路径 git diff --check | 退出码 0 |

首轮在限制沙箱中的临时目录执行，Windows rename 被系统拒绝，17项失败；同命令在允许真实临时目录文件操作的执行环境复跑全部通过。未修改断言或生产原子性来迁就沙箱。曾有一个测试 `prefer-const` lint 错误，已修正并重新归档通过结果。

## 性能证据与局限

`r5-performance.json` 使用 Node v24.15.0、Windows x64、纯合成数据；单次小规模测量，不能解释成 RSS 上限或多平台性能承诺。QA 脚本在本 worktree `tmp/remediation-r5-benchmark.cjs`，未接入用户日志。

| 保留量 | JSON UTF-8 | stringify p50/p95 | 同步 IO 最大心跳间隔 | 异步 IO 最大心跳间隔 |
| --- | ---: | ---: | ---: | ---: |
| 5,000 条 | 2,308,892 B | 4.07 / 7.39 ms | 36.45 ms | 15.26 ms |
| 20,000 条 | 9,248,892 B | 17.68 / 29.69 ms | 42.04 ms | 15.68 ms |

IO 对比使用预生成 JSON、各3次真实 fsync/rename，所以只描述磁盘路径差异，不包含 stringify。异步写未必缩短总耗时，但让心跳在磁盘等待间继续运行。

20,000 条已超过方案的 16ms 序列化评估阈值，因此另外测量 Worker：structured-clone 派发本身18.83ms、Worker stringify23.59ms、含返回9.25MB字符串的往返76.20ms。直接将整份对象往返 Worker 没有解决主线程复制停顿，首批未增加这条有相同阻塞量级的实现。5,000 条的派发2.75ms、Worker stringify3.90ms、往返13.42ms。需要后续按真实负载评估分片快照/增量记录或持久 Worker 的数据镜像方案，不能宣称所有主线程序列化停顿已消除。

## 集成与未验证项

- 主代理需在 R2 正常退出流程中、外部入口及插件 release 审计结束后调用 `stopAcceptingWrites()`，将 `flush(capturedRevision)` 纳入同一个总期限；删除 index 中旧 `flushSync()`。接线文件：`tmp/remediation-r5-interface.md`。致命路径不得保存业务快照。
- 最终整仓 typecheck、全量测试、Electron 构建和可视检查由主代理统一执行。本任务没有做代码审查，也没有作出整仓/发布通过判断。
- 未实测磁盘耗尽、真实权限恢复、多平台目录 fsync、实际安装器退出及长时间混合负载；定向故障注入覆盖主写/rename/fsync/备份/序列化失败、碰撞保护、损坏保护、clear与旧写交错和持续输入最大等待。
- 20,000 条代表性快照的同步序列化成本仍可能影响事件循环，已提供测量而非隐藏；首批保证消除高频同步磁盘写入、提交顺序和失败状态可核对。
