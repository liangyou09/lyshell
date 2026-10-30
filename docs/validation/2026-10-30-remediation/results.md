# 完整修复实施与本地验收记录

日期：2026-10-30，北京时间。分支：`codex/complete-remediation-20261030`。

工作树：`C:/Users/69534/.codex/worktrees/complete-remediation-20261030/LyShell`。
原目录 `D:/workspace/claude/LyShell` 的未提交源码、测试与计划文件均保留，没有复制其中的源码修改。

## 版本与证据口径

计划原基线为 a1800ae，实际从 `36739a6deb32bc45bf7dcbf29635cce9c306230c` 建立工作树，没有回退已存在的任务架修复。
源代码集成提交为 `bd9009c42738d265b660ca6bb09c497ce381d26f`；后续提交归档烟测脚本、文档及日志。
最终整套 Vitest、类型、lint、架构与构建均记录该集成提交的精确 HEAD。每条 `*.json` 保留真实命令、起止时间和退出码，同名 `*.log` 为完整 stdout/stderr。

交付构建另在归档提交 `6d3bb3e05c6079ac73bac5f28ac304ba874de01c` 上通过（delivery-build），包含最新变更日志。已核对该提交的 src、构建配置与根依赖清单和上述已通过全量测试的集成提交没有差异；后续提交只补验证记录与报告格式。

早期 `r1-report` 至 `r8-report` 与 corrections 是委派当时的阶段记录，里面“尚未接线”等内容不代表最终状态，以本文和后续代码为准。早期失败日志保留，不覆盖成成功。

本地环境为 Windows x64，系统 Node 24.15.0、npm 11.12.1；Electron 43.7.11 内置 Node 24.21.0、ABI 148。工作树使用原目录依赖的 junction，未对共享 node_modules 执行重建或 npm ci。Web SSH 使用独立依赖和锁文件。

## 实施范围

| 包 | 实际交付 | 验证要点 |
| --- | --- | --- |
| R0 | 独立 worktree、基线、分包提交与日志 | 原工作区修改保留；没有降级到计划旧基线 |
| R1 | 统一隔离匹配池；sendAndWait、waitForPattern、tail_until 等入口接入 | 默认 regex、显式 literal；编译在写前完成；授权/cursor/epoch/锁保持；执行与队列超时均停止 Worker，exit 前保留容量 |
| R2 | running/draining/fatal/stopped、业务门控与退出协调 | 未知故障非零退出、固定有界诊断且不保存业务快照；18s 含 prepare；matcher/命令/HTTP/插件/审计/Host/View 纳入收尾 |
| R3 | 公平调度、批次/全局输出和发送预算、流式背压 | 16/4/2 活动配额、128/50 排队、8/32/64MiB；queued 总期限明确未派发；取消结果与真实资源关闭独立 |
| R3 本地/SSH | Windows 先 Job 后命令；POSIX 独立进程组探测；SSH 等实际 close | Job 不可验证时拒绝执行；空 Job 和句柄关闭才确认；SSH 不宣称远端进程树已停止；partialOutput 不冒充完整结果 |
| R4 | 通知、会话策略、客户端配置、存储路径、文档契约抽取 | 生产模块扫描 488 文件，0 边界违反、0 运行时循环；动态导入单独列出 |
| R5 | 审计异步单写入者、revision/clear/flush、UI 回执 | 唯一临时文件；主提交和备份失败区分；碰撞不删除他人临时文件；退出不发生同步/异步双写 |
| R6 | 终端标量 selector 与稳定动作订阅 | 1/10/30 会话实际同步对象重建下，无关变化不提交终端主体；实例、输入门控、搜索与 ACK 保留 |
| R7 | 平台可注入夹具、完整测试分层、CI 矩阵与原生烟测 | 默认 Vitest timeout 未加长；Web SSH 单独执行；平台 skip 如实保留 |
| R8 | 指定 webview 入口代理和单只读 WebContentsView 试点 | 默认关闭；owner/frame/document/generation 严格校验；单截图占位、两次有界捕获、detach 与 destroyed 分别确认 |

R8 是受限试点；尚未迁移的插件、dsh、任务架截图、账号与休眠路径见 [browser-host.md](../../browser-host.md)。没有据此启用全应用迁移或宣称节省内存。

## 最终检查

| 检查 | 实际结果 | 日志/元数据前缀 |
| --- | --- | --- |
| 整套根 Vitest | **430 文件通过、1 文件原有跳过；5473 项通过、8 项原有跳过；退出 0，无未处理异常报告** | r7-committed-root-tests |
| Renderer 类型 | 退出 0 | committed-typecheck |
| Main 类型 | 退出 0 | committed-main-typecheck |
| 全部变更 TS/TSX lint | 退出 0，0 错误、66 警告 | committed-lint |
| 架构门禁 | 488 生产源文件，0 违反、0 运行时/静态循环 | committed-architecture |
| Electron/renderer 构建 | 退出 0；patternWorker 与 localCommandWorker 均进入 dist/main | committed-build |
| 包含最新变更日志的交付构建 | 退出 0 | delivery-build |
| Node 测试层 | 25 项通过，退出 0 | committed-node-tests |
| 独立 Web SSH | 类型退出 0、2 文件 22 项通过；源文件未在后续变更 | r7-final-web-ssh-typecheck、r7-final-web-ssh-tests-corrected |
| Electron ABI | 真实 Electron 中 PTY、serialport、koffi 加载成功 | native-abi |
| 真实应用烟测 | sandbox/preload、literal、非法模式、恶劣正则中断与心跳、正常退出通过 | committed-electron、electron-result.json |
| Windows Job 实测 | 中文双流/退出 7；超时后 3 代 PID 均消失；预取消无 marker | committed-windows-job、windows-job-result.json |
| 真实浏览器试点 | 导航/后退前进、截图、只读保护、detach/destroy 通过；主代理已看图 | committed-browser-host、browser-host-result.json、readonly-pilot.png |
| Windows 打包目录 | electron-builder --dir 退出 0；未签名、未安装 | committed-package |
| 物理依赖打包目录 | 280 包/557 依赖边核实；无依赖路径缺失警告；所有关键原生文件存在 | physical-package-source、physical-package-builder、physical-package-inventory |
| 真实打包应用 | **isPackaged:true；asar 主入口、sandbox renderer/preload、五个外部依赖、asar Worker 的普通/非法/恶劣模式和正常退出 0 均通过** | physical-package-complete、packaged-result.json |

首轮全量只有 confirmation-authorization 的 VM 夹具缺少新引入的真实策略依赖失败，保留在 r7-final-root-tests；补齐上下文后定向 16 项通过，随后最终提交上的整套测试通过。未删除用例、放宽授权或延长全局超时。Web SSH 首次命令的配置路径拼接错误也单独保留，纠正命令后正常通过。

66 条 lint 警告为受影响文件的现有 any 与 Hooks 依赖告警，本轮未扩展为全仓清理。

打包检查另发现两个环境问题，均保留了失败证据：

1. builder 从当前 node_modules junction 收集时漏掉 Koffi、serialport、ssh2 的传递依赖，即使退出 0 也不可用。改用全新物理副本，递归复核 280 包、557 条依赖边后打包，关键依赖和原生模块实测全部可加载。没有更改原始 node_modules、安装新依赖或重建共享 ABI。
2. 在 Codex 托管 worktree 目录执行该包会在 inspector 前以 `2147483651` 退出；只读 ACL 对照记录为 145 条 deny 与 Low Mandatory Level，而正常项目临时目录副本为 0 条 deny。同一包复制到 `D:/workspace/claude/LyShell/tmp/remediation-package-runtime-YIBou9` 后完整验收通过。没有修改 ACL、关闭沙箱或修改 app.asar；不能仅凭该差异确定原生失败的唯一原因。官方也记录了目录 ACL 造成 Electron 启动失败的相关问题，供后续环境调查参考：[electron/electron#51761](https://github.com/electron/electron/issues/51761)。

最终打包烟测使用实际 exe 与 asar，预启动时将 userData、sessionData、Downloads 等标准目录全部指向私有 fixture，并隐藏窗口；源码构建目录没有代替 asar。最初 inspector 求值顺序、空 HOME 缺标准目录和 Worker 继承 QA 断点参数造成的夹具失败也保留，修正后通过。正常退出记录 7ms、0 个未确认步骤。

当前 worktree 的 node_modules 仍是原目录的 junction。不要直接在该链接上执行 npm ci/rebuild；正式构建应采用独立物理依赖安装。物理包生成、库存和源目录清单位于本目录；辅助准备脚本在工作树的 `tmp/remediation-physical-package.cjs`，未混入产品代码。

## 性能与边界

R5 合成记录：5000 条/2.31MB 的 stringify p50/p95 为 4.07/7.39ms；20000 条/9.25MB 为 17.68/29.69ms。异步 I/O 心跳最大间隔约 15–16ms，对照同步为 36–42ms。20k 快照 Worker clone 派发约 18.83ms，往返约 76.20ms；因此保留主线程 stringify 并明确残留，不将同步序列化包装为“零阻塞”。详见 r5-performance.json，不能推导整桌面性能保证。

原生 View 测得额外 Tab 进程随关闭消失；完整进程内存采样存于 browser-host-result.json。对照 webview 被既有附着安全策略拒绝，内存对比未完成，没有放宽安全策略来得到数字。

## 协作与复现

R1–R3 使用 LyShell 原生 Harness 的独立会话；root 亲自审阅与集成。Windows 补强任务中后端身份变化，官方状态为 cancelled；没有重发该任务，root 检查副作用后接手并实测。另在新后端新会话委派独立兼容文档，核对 completed 与实际文件后，确认所有本凭据任务终态并 disconnect；没有批准任何待审批操作或停止共享后端。其他并行工作只负责实现、补测和执行，未委派代码评审或图像检查。

可重复运行：

```text
npm run typecheck
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1
npm run test:node
npm --prefix examples/web-ssh run typecheck
npm --prefix examples/web-ssh test
npm run check:architecture
npm run build
node scripts/run-native-check.cjs
node scripts/run-electron-smoke.cjs
node scripts/run-windows-command-smoke.cjs
node scripts/run-browser-host-smoke.cjs
node scripts/remediation-package-smoke.cjs <仓库临时目录内的win-unpacked路径>
```

`scripts/remediation-validation.cjs <label> <Node脚本> [参数...]` 可归档单条命令；只运行可信命令，日志不得包含凭据。兼容行为与回退规则见 [兼容说明](../../remediation-compatibility-2026-10-30.md)。发布前剩余验收见 [remaining.md](remaining.md)。
