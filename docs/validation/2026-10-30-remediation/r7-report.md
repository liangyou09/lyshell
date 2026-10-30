# R7 测试平台、持续验证与示例实施记录

日期：2026-10-30（北京时间）。Worktree：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`，基线 HEAD：`36739a6deb32bc45bf7dcbf29635cce9c306230c`。环境：Windows x64，Node v24.15.0、npm 11.12.1。根依赖通过 junction 复用，未运行根 npm install/ci，未改共享依赖；Web SSH 在自己的目录安装 129 个包并同步独立锁文件。

## 实施范围

1. `ProcDeps.platform` 将平台决策与 IO 一起注入，默认使用真实平台。既有 Windows 树杀/恢复夹具显式选择 win32，移除单个 POSIX 用例对全局 process.platform 的替换。新增 Linux/macOS 的 ps 查询、逐个身份核对、TERM/KILL 顺序和拒绝复用 PID 测试。没有改变生产默认平台或放宽身份检查。
2. Local Host 假 launcher 捕获异步启动失败并转成真实 child 对应的 onError；PTY 仅在 ptyFactory 被调用时计数。分开测试目录初始化失败与 ready/attach 后的描述加密失败。disconnect 测试消费先到的 exit 事件，避免 FIFO 在 Linux 的先 exit 后 close 时被未订阅的 exit 挡住。Unix 测试 profile 使用短临时目录，避免 macOS tmpdir 超过 socket 长度限制。
3. Worker 夹具的 pipe 从实际 userDataDir 推导；增加伪造 hostId 描述文件不会被清理的回归。未修改 Host 的生产 pipe ownership/fence 校验。
4. 根 Vitest 只新增排除独立 Web SSH 子包，仍默认收集其余 examples 与 scripts；同提交新增独立示例 CI job、vitest 配置、网页测试依赖和两文件 typecheck/test 脚本。原 10 个 src 外 Vitest 文件中 8 个仍由根收集，Web SSH 的 2 个由独立 job 收集。
5. 增加 `test:node` 明确运行两份 shelf-memory-p0 Node 测试；增加 `check:architecture` 调用 R4 AST 门禁和 `lint:changed` 扫描本地改动或 CI base SHA 之后的源码。
6. CI 逻辑与 Web SSH 都使用 Windows/Linux/macOS × Node 22.12.0/24。独立 native job 在三平台正常安装、rebuild、Electron ABI 原生模块检查、build、跨平台 Electron 冒烟；Windows 另运行既有 DPAPI/PTY architecture 冒烟。只缓存 npm 下载，不缓存跨平台 ABI 产物。工作流已落地，尚未在 GitHub 执行。
7. `api-error.integration.test.ts` 用真实本机动态端口夹具验证 MCP HTTP 客户端普通响应、非 200 流和 SSE error 保留 code/retryDisposition/reason/requestId，并使 partial chunk 与完整结果区分。
8. `remediation-electron-smoke.cjs` 准备独立 profile 的真实 Electron renderer/preload 和构建匹配 Worker 加载验收：literal、invalid pattern、29 码元高回溯输入、100ms 后 terminate 并等待退出、主循环心跳。包装器使用 60s 外部看门狗、核对新生成报告。可由 `LYSHELL_SMOKE_APP_ROOT` 指向候选应用资源根；源码/构建冒烟不代替安装器验收。

## 实际执行

以下日志来自实施中的工作区，最终集成提交需要主代理再运行必要全局检查。

| 命令/集合 | 实际结果 | 日志 |
| --- | --- | --- |
| 基线 local-host-client/worker | 49 项通过、退出 0 | `r7-baseline.log` |
| 基线 proc + TerminalView search | 132 项通过、退出 0 | `r6-r7-baseline-extra.log` |
| 修复后 proc + client + worker + TerminalView | 191 项通过、退出 0（随后额外增加 1 项 worker 保护回归） | `r6-r7-targeted.log` |
| 最新 client + worker | 51 项通过、退出 0 | `r7-local-host.log` |
| 独立 Web SSH npm install | 成功、退出 0、129 包 | `r7-web-ssh-install.log` |
| 独立 Web SSH typecheck | 通过 | `r7-web-ssh-typecheck.log` |
| 独立 Web SSH tests | 2 文件、22 项通过、退出 0 | `r7-web-ssh-tests.log` |
| 两份 Node runner tests | 25 项通过、退出 0 | `r7-node-tests.log` |
| API error 真实回环测试 | 3 项通过、退出 0 | `r7-api-error.log` |
| 本工作包拥有 TS 文件 ESLint | 退出 0；0 error、11 既有 warning | `r6-r7-lint.log` |
| 实施中全局 typecheck | 退出 2：并行 R1/R2/HTTP 接线尚未完整，已向 root 报告 | `r7-typecheck.log` |
| 实施中 lint:changed | 退出 1：并行生产源码有 7 个未完成接线 error，已向 root 报告 | `r7-lint-changed.log` |

最初对 proc/Local Host 的 Windows 基线没有复现计划中 Linux 失败；报告将这些结果与既有 Linux 结果分开。平台注入测试是在 Windows 上运行 POSIX 决策与模拟 IO，不能等同真实 Linux/macOS 进程集成。

## 未执行与交接

- 全量根 Vitest、最终 typecheck/build、原生模块和新 Electron smoke 等待所有工作包集成后由主代理执行，避免将中途源码状态当最终结果。
- 未执行 GitHub CI、真实 Linux/macOS 平台集成、安装/覆盖升级/便携启动、物理串口、真实远端长负载、IME/DPI 与 GUI 人工验收。
- 未通过 skip、删除断言、放宽安全校验或延长 timeout 修复失败。atomic-json 测试修复由 R5 负责，本工作者未改动。
- 未进行代码审查，未提交或推送；最终代码审查、集成、分包提交和发布结论由主代理负责。
