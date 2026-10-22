# 资源修复提交前复审

日期：2026-10-22（Asia/Shanghai）。工作目录：`D:/workspace/claude/LyShell`。

结论：已修复本次复审确认的 C1/C2，并对全部未提交源码、测试、新文件和相关调用链再次审查，未发现尚未解决的可操作缺陷。此前终端、R01–R10、F1–F3 的修改和历史资料保留。该判断针对已审路径与本地验收，不能作为不存在任何潜在缺陷或长期泄漏的保证。

## C1：持久 SSH shell 的输出与完成标记

原实现用 stdout 中的标记位置截取 stdout/stderr 合并缓冲；标记分片之间收到 stderr 时，实际 ssh2 回环连接返回 `hello\n___END_` 且退出码为 0，预期为 `hello\nwarning`。

新增 `src/main/file/shell-command-output.ts`，仅保留可能成为标记的 stdout 后缀，并将其位置映射到合并缓冲。识别标记后移除其 stdout 片段，保留穿插的 stderr；增量回调只发布已确认的业务输出。沿用 1 Mi UTF-16 字符总捕获上限，超限失败并清理通道。`ssh-command-shell.ts` 接入该解析器，并防止增量回调触发取消后继续完成旧命令。

回归覆盖多个分片位置、逐字符标记与 stderr 交错、真实退出码 7、行中相似文本、下一条排队命令和增量输出。真实安装的 ssh2 Server/Client 在临时回环端口再次执行原反例，返回 `hello\nwarning`、exitCode=0，无内部标记泄露。仅使用本机 fixture，通道、客户端与服务端已关闭。

## C2：glob 编译阶段的内存预算

原实现的无回溯匹配预算不能约束编译前的 token/闭包分配。一次性 128 MiB old-heap Worker 中，10 万字符模式增长约 14.2 MB 堆，100 万字符模式触发 `ERR_WORKER_OUT_OF_MEMORY`。

`src/main/mcp/glob.ts` 现于分配 token 前限制模式为 4096 个 UTF-16 码元。HTTP 入口对原始字符串限长，超长返回 400，仅报告长度；遍历器对预取消请求在编译与创建计时器之前返回。正常根目录错误仍为 500，没有被改成输入错误。

相同隔离条件下，10 万、100 万字符及百万字符类立即拒绝；实测约 0.088/0.029/0.025ms，额外堆约 166 KB/2.8 KB/2.9 KB，未发生 OOM。4096 字符仍可编译。持久回归覆盖 4096/4097 边界、HTTP 状态、预取消、编译内存、高回溯、匹配中取消和截止预算。

## 全部差异复审

代码审查全部由 Codex 完成，没有委派。检查包括：

- 终端连接与共享 SSH transport 的归属、连接失败和迟到事件、输出缓冲回收、xterm 消费 ACK、窗口/会话销毁与暂停恢复。
- SSH 命令捕获、SSE 背压、慢消费与本地进程树取消；文件连接/SFTP 单在途和代次隔离；上传/下载调度、同路径串行、各阶段取消及 Worker exit 后释放额度。
- 下载历史归档、分页、迁移、原子写入及退出 flush；异步 PATH 的缓存与所有生产调用点；高亮预算、搜索 Worker 和 UI 取消；连通性共享轮次与 Socket 回收。
- MCP 目录遍历的输入、工作量和错误语义；DSH bridge 独占创建、失败回滚、owner 接管和保守清理；相关 IPC/preload/renderer 接线与回归测试。

复审还清理了一处错误缩进、一条测试中的无效表达式，以及抽取本地流式执行后遗留的过时注释。最终 ESLint 发现的隔离测试 `prefer-const` 错误已修正，再次复审及相关测试通过。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| `npm run test -- --maxWorkers=2 --minWorkers=1 --testTimeout=15000` | 238 文件通过、1 跳过；3002 项通过、5 跳过，退出 0 |
| 最后测试整理后的 SSH file-client / 隔离 glob 回归 | 2 文件、12 项通过，退出 0 |
| C1/C2 集成专项 | 5 文件、60 项通过，退出 0 |
| `npm run typecheck` | 通过，退出 0 |
| `npm run build` | 通过，退出 0 |
| `npm run lint` | 修正新增测试声明后通过；0 错误，115 警告 |
| `git diff --check` | 通过；CRLF/LF 提示不计为代码错误 |

本地证据在 `tmp/module-resource-audit/`，不提交夹具、日志或构建产物：`precommit-powershell-tests.log`、`precommit-final-edge-tests.log`、`precommit-typecheck.log`、`precommit-build.log`、`precommit-lint-final.log`、`c1c2-integration-tests.log`、`c1-after-shell-output.json`、`c1c2-memory-probe.json`。原始失败反例和前序报告保留，未改写为成功记录。

C2 的限定实现和定向测试由原生 Harness 协助，Codex 亲自检查实际交付并完成集成、复现与复审。提交前全量验证曾交给新的原生会话，首轮不完整退出（127）；随后自行启动重复测试，故取消并核对同实例、同会话和同任务的正式终态 `cancelled`，检查副作用后释放空闲租约。该任务不算验证成功；最终完整结果来自 Codex 当前 PowerShell，没有修改测试断言或跳过失败用例来取得通过。

## 保留边界

保留 [原审查报告](resource-audit.md) 与 [F1–F3 交付说明](resource-audit-followup-20261022.md) 中已声明的限制：历史/下载/worktree 的业务保留、初次旧历史整体解析、异常退出可能留下未引用归档、单次底层 SFTP listDir 可先构造完整数组，以及不确定归属资源的保守保留。超过输出或 glob 限额的请求现在明确失败。lint 仍有类型与 React Hook 等警告，没有把零错误描述成零警告。

本次未替换或重启正式安装版与共享 DSH 后台；未验证正式实例或真实远端的长期工作集曲线。源码提交和 push 不代表已部署安装版。
