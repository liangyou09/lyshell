# 独立验收 F1–F3 修复交付

日期：2026-10-22（Asia/Shanghai）。工作目录：`D:/workspace/claude/LyShell`。

后续全量复审另发现的 C1/C2 已修复，最终结果见 [提交前复审记录](resource-audit-final-20261022.md)；本说明保留 F1–F3 修复阶段的事实和日志。

本轮修复了独立验收确认的三个问题，精确反例及相关回归验证通过。范围仅为当前源码 checkout 与本地 `dist/` 构建产物；未替换、验收或重启 `D:/tool/lyshell/LyShell.exe` 安装版，未重启共享 DSH，未提交或发布。独立验收原报告、脚本和证据保留原件；此前终端与 R01–R10 的未提交修改保留。

## 修复行为

| 问题 | 实现与行为 | 验证结果 |
| --- | --- | --- |
| F1 / R09：单次 glob 高回溯绕过时间预算 | `glob.ts` 改用无回溯 NFA 动态规划，保留 `*`、`**/`、`?`、字符类、UTF-16、分隔符及换行语义。匹配时间上界为 O(模式长度 × 路径长度)，空间 O(模式长度)。生产遍历使用 `matchAsync`，每 4096 次状态推进让出事件循环，并复核截止/取消；短匹配也每 64 条让出。 | 原精确反例在可终止 Worker 中正常完成：Node 4ms，checkout Electron 7ms。更大单次匹配中真实取消约 19/20ms，真实截止均约 5001ms，期间 2ms 心跳持续推进。两个引擎各完成 60,000 组与修复前算法的兼容对照。 |
| F2 / R09：根目录失败伪装为空目录 | 根目录 `listDir` 失败向真实 handler 抛出，返回 HTTP 500 / `success:false` / 原错误信息；对非递归、递归和 glob 路径一致处理。递归子目录维持跳过并继续访问兄弟目录的策略，但以 `truncated:true`、`reason:'directory read error'` 明示结果不完整。真正空目录仍为成功且不截断。 | 执行 AST 提取的真实 `handleListFiles` + 实际遍历器，仅替换授权、文件连接器和响应 IO；四种根目录组合均返回 500。持久回归覆盖空目录及响应关闭后不回写。 |
| F3 / R10：prepare 写盘失败留下 run 目录 | 准备完成内存内容后再创建目录。默认先创建父目录，再以非递归 mkdir 独占创建 run；默认以 `wx` 写文件，拒绝覆盖。owner/patch 写入失败时，核对本代 owner 和本次尝试写入的完整/部分内容，再删除已确认自有文件，最后仅 `rmdir` 空目录，并原样抛出原错误。owner 已被替换、外来/改写文件、不可读归属或 EEXIST 均保守保留；删除失败不继续移除归属证据。 | 真实磁盘对 owner / patch 各自的写前、部分写后、完整写后三种 EIO，每种连续 5 次，共 30 次，正常 prepare/cleanup 后均为 0 个自有残留 run。故障期间 owner 接管保留两份资源。测试另覆盖同名碰撞、活动代、迟到 cleanup、外来文件、旧版无标记目录及改写 patch。 |

F1 的危险精确输入从未送入正式主进程。Node/Electron 验收均使用父级可终止 Worker；Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行，未创建应用窗口。引擎版本为 Electron 43.7.11 / Node 24.21.0 / V8 15.0.245.31-electron.0。

## 本轮文件

修改的现有文件：

- `src/main/mcp/glob.ts`、`glob.test.ts`：匹配算法、协作匹配接口及语义回归。
- `src/main/mcp/list-files.ts`、`list-files.test.ts`：预算执行、目录错误策略及取消/截止回归。
- `src/main/mcp/http-server.ts`：仅更新本轮目录错误策略的接口注释；已有 handler 接线保留。
- `src/main/dsh/bridge.ts`、`bridge.test.ts`：失败回滚、独占创建及磁盘生命周期回归。

新增文件：

- `src/main/mcp/glob.isolated.test.ts`：精确高回溯反例的可终止 Worker 回归。
- `src/main/mcp/list-files.handler.test.ts`：真实 handler 的目录错误、空目录及关闭响应回归。
- 本说明。

桥的同一路径测试原先用两次固定 run id 的 prepare 覆盖 owner；现在第二次 prepare 会安全拒绝碰撞，因此测试改为显式改写 owner 来模拟接管，同时保留两代独立目录的真实迟到 cleanup 验证。

## 验证与证据

所有新验收材料位于 `D:/workspace/claude/LyShell/tmp/module-resource-audit/followup-20261022/`：

| 检查 | 结果 | 材料 |
| --- | --- | --- |
| 精确反例、匹配中取消/真实五秒截止、60,000 组兼容及真实 handler | Node / Electron 均通过 | `acceptance.cjs`、`node-results.json`、`electron-results.json`、对应 `*-acceptance.log` |
| 真实磁盘 EIO ×30、正常后续清理、owner 接管保护 | 通过 | `bridge-acceptance.cjs`、`bridge-results.json`、`bridge-acceptance.log`；保留 fixture 目录 |
| MCP + bridge + web 生命周期专项 | 6 文件 / 119 项通过（后续新增隔离和碰撞用例见下行及全量） | `targeted-tests.log` |
| 最终 bridge、handler、隔离 glob | 3 文件 / 41 项通过 | `final-edge-tests.log` |
| `npm run test -- --maxWorkers=2 --minWorkers=1 --testTimeout=15000` | 238 文件通过 / 1 跳过；2985 项通过 / 5 跳过，退出 0 | `full-tests.log` |
| `npm run typecheck` | 通过，退出 0 | `typecheck-final.log` |
| `npm run build`（最终源码） | 通过，退出 0 | `build-final.log` |
| 修改文件 ESLint | 0 错误 / 38 个既有 `http-server.ts` 的 `no-explicit-any` 警告，退出 0 | `eslint.log` |
| `git diff --check` | 通过，退出 0 | `diff-check-final.log` |
| 初始文件完整性 | 812 个初始文件中仅 7 个预期现有文件改变；805 个哈希未变，无缺失/意外改变 | `baseline-sha256.json`、`integrity.json` |

测试编写阶段的 `mcp-tests.log` 是中间输出，最终结果以已通过的专项、边界和全量日志为准。原始独立验收脚本的断言是“旧问题仍存在”，本轮未改写或重新将其退出码解释为修复通过，而是新增了上述修复行为验收。

## 分工、审查与边界

开始前读取 `AGENTS.md` 与原生工作契约，核对实际目录、git status 和权威状态。原生 Harness 在新建并验证的当前 checkout 会话内只负责 F3 初稿与定向测试；同实例 `74c3ed19-1ccf-4af8-9dd8-ea7602b585d0`、同会话 `session-b85f4c33-c6fc-4e70-b535-63c91d066711`、同任务 `9d3224fb-e755-405f-ab8c-9f8efaac0799` 已确认 `completed`，无审批；检查实际交付后释放空闲租约。记录见 `native-task.json`、`native-final-state.json`、`f3-worker-report.md`。

Codex 亲自处理 F1/F2、审查全部本轮代码差异，并在 F3 初稿上收紧原子 mkdir、独占写入、owner 接管检查和保守回滚，移除未使用的注入接口，完成集成、故障夹具及最终验证。委派报告描述的是初稿，其原有“exists + recursive mkdir”等局限已由本轮最终实现修正，以本说明和当前源码为准。

保留既有边界：单次底层 SFTP listDir 可能先构造完整数组，取消不拆除其他操作共用的连接；不确定归属、仍存活 PID、外来文件和不可清理资源继续保守保留。未扩展历史保留策略或独立报告观察项。本轮没有未解决的 F1–F3 失败；安装版尚未部署这些修改。
