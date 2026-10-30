# 架构改造循环代码复审

2026-10-29，Codex 负责问题判断、全部代码复审、修复验收与最终集成。范围为目标 worktree 中相对基础 HEAD 的全部未提交改动，以及非 ignored 的新增源码、测试和文档；保留已有改动，没有提交、推送、安装或发布。

- 工作区：`C:/Users/69534/.codex/worktrees/architecture-optimization/LyShell`
- 分支：`codex/architecture-optimization`
- 基础 HEAD：`32d6e2c611aa614d9ad3320fa68581115d809e91`
- 依据：[架构方案](lyshell-architecture-optimization.md)、[实施记录](architecture-implementation.md)、[native 工作契约](native-harness-work.md)、`mcp-config.md`、`CLAUDE.md` 和适用 `AGENTS.md`。
- 最终完整文件清单：`tmp/architecture/review-final-snapshot.json`。每项含路径、字节数、SHA-256，包含 tracked 与非 ignored untracked 文件；`digest` 是排序文件条目的聚合摘要。最终报告本身也在清单内，因此报告不嵌入自身摘要。下一评审者应逐项核对文件内容及清单中的分支、HEAD、状态。

## 发现、修复与回归证据

以下均为已复现并修复的问题。P1 表示秘密、安全或任务正确性边界问题，P2 表示状态、数据一致性或资源限制问题。每项先以行为回归复现失败，再修复并运行相关验证；日志位于工作区的 `tmp/architecture/`。

| 编号 | 严重度 | 触发及原行为 | 修复位置与验证 |
| --- | --- | --- | --- |
| R01 | P1 | GUI 调用会话去重，返回的 kept 使用运行时 SessionConfig，包含 SSH 密码、私钥和口令 | `ipc/handlers.ts` 改用公开 DTO；`session-deduplicate.secrets.test.ts` 执行实际注册回调并检查三种秘密均掩码 |
| R02 | P2 | 去重合并 pinned/order 后保存失败；回滚 map 仍引用已被修改的对象 | `storage/repository.ts` 在合并前克隆记录；保存失败回归比较内存、revision 与原始磁盘 |
| R03 | P2 | 调度器同步授予名额但 await 尚未恢复时取消传输，没有 Worker，也没有终态回执 | 上传/下载 manager 为该 admission 发送一次未派发取消回执；resource 测试覆盖两种方向及名额释放 |
| R04 | P1 | 传输排队后用户忘记主机，旧可信指纹仍可启动新 Worker | 两种 manager 在真实派发前重新解析信任，并固定 SSH 配置快照；排队撤销信任回归确认没有第二个 Worker |
| R05 | P1 | 幂等键命中早于 requestId 冲突检查，可把已有调用关联到另一任务；新 requestId 的同键重试未登记，稍后省略键可再次执行 | bridge 先核对调用 ID，为重试登记同步预留、可持久恢复的别名；并发、终态、请求退役、重启、损坏记录与 10000 预算回归 |
| R06 | P1 | TaskShelf 首次读损坏文件报错后仍标记 loaded，后续写入可用空默认值覆盖原件 | `task-shelf-repository.ts` 仅在成功/不存在时完成加载，失败保持保护；重复写拒绝、原件不变、显式修复后重读验证 |
| R07 | P2 | 两次异步下载配置修改在同一旧快照上保存，目录映射丢失；expectedRevision 检查发生在排队前 | `download-history.ts` 串行执行最新读取、版本检查和提交；并发合并及同版本竞争回归 |
| R08 | P2 | 下载分页及部分写操作返回内部记录/Date；调用方可绕过提交修改仓储 | 所有这些返回路径统一 hydrate 克隆；修改返回字段和 startTime 不改变内部或磁盘记录 |
| R09 | P2 | cloneChannel 绕过 256 会话上限及停止接收新工作的退出状态，等待 shell 时仍可在退出后连入 | `session-manager.ts` 在入口与异步恢复后检查限制/closing；满额拒绝和退出竞态回归 |
| R10 | P1 | HTTP 请求 aborted 清理后移除唯一 error 监听；Node 随后的 error 可成为未处理错误 | `http-server.ts` 保留 error 保护至 close，预算仍只释放一次；真实 loopback 半包 socket 中断验证 aborted → error → close |
| R11 | P1 | HTTP 上传/下载通过入口确认后在队列等待，撤权或连接被替换仍可启动 Worker | HTTP 传入服务器授权闭包，manager 于实际派发时复核凭据、fileWrite、资源范围、同一 Session/Connector/connectionInstance；403、无 Worker 与额度释放回归 |
| R12 | P2 | 插件卸载的注册表删除写盘失败返回 false，IPC 忽略结果，仍可删目录并报告成功 | `ipc/handlers.ts` 在删除状态保存失败时返回错误，保留禁用项供重试；执行实际回调的回归先复现 success:true，再验证失败保留与成功重试 |

相关日志：`review-dedup-{red,green}.log`、`review-transfer-{red,green}.log`、`review-idempotency-{red,green}.log`、`review-idempotency-recovery.log`、`review-storage-{red,green}.log`、`review-history-return-{red,green}.log`、`review-clone-{red,green}.log`、`review-http-abort-{red,green}.log`、`review-transfer-auth-{red,green}.log`、`review-transfer-auth-wiring.log`、`review-alias-validation.log`、`review-uninstall-{red,green}.log`。red 日志中的失败是修复前复现，不是交付版本失败。

## 复审轮次与最终调用链核对

第一轮覆盖全部变更与依赖执行链，发现 R01–R08；修复后继续核对资源与异步边界，发现 R09–R11。再审发现 R12，修复后重新冻结源码并完成完整测试及复审。最终一轮重新覆盖以下主题，没有留下已确认、未修复的可操作问题：

| 主题 | 核对内容 |
| --- | --- |
| 身份与授权 | GUI 登记文档及顶层 frame、导航/销毁失效、特殊确认桥、HTTP token binding、Host/Origin、资源可见性、Shell 权限等价性、异步确认与派发复核 |
| 终端输入 | acquire/renew/takeover/release、连接与控制代际、逐块复核、宿主 v2 最终写入验证、旧队列拒绝、未知输入不重放、GUI 明确接管和当前几何 |
| Harness | backend/session/task/attempt 归属、原子活动名额、请求 ID/键/别名、dispatch 前 journal、恢复冷读、取消意图与真实终态、审批一次消费及共享后台边界 |
| SSH 与秘密 | 终端、独立 SFTP 与 Worker 主机验证；确认保存顺序；vault/旧 SSH 密文、损坏保护、迁移、公开 DTO、占位符保留/清空/目标绑定、导出导入票据与最小子进程环境 |
| 输出与资源 | xterm 回调 ACK、订阅归属、游标/epoch/gap、ANSI 缺口恢复、单消费者/全局预算、无 GUI 消费、重连旧事件、克隆/关闭/退出与实际 Worker exit |
| 持久化 | 临时文件/fsync/rename、primary 提交与 backup 失败语义、revision、内存回滚、克隆所有权、配置串行化、损坏只读和显式恢复 |
| 文件提交 | 任务/attempt、源/目标元数据、唯一临时对象、取消/提交竞态、rename 扩展、结果未知、目标串行队列、额度释放与回执 |
| 兼容与交付 | 共享类型、validator/preload/consumer、文案与状态一致性、协议必需能力、资源打包、原生模块与隔离运行证据 |

R12 后的冻结清单 `review-source-freeze-r12.json` 含 1352 个文件，聚合 SHA-256 为 `f1191e7c2de7166abdf804cbe0d64c147b520d574db42620f9b154e5da820ba4`。与起始清单比较，21 个源码/回归路径的变化均属于上述 Codex 修复，另补交付文档，没有文件删除；此后仅更新交付文档。最终完整清单在文档写完后重新生成，含全部新增文件，供独立评审核实。

## 当前验证

| 检查 | 结果与证据 |
| --- | --- |
| `npm run typecheck` | 退出码 0；`review-typecheck-final.log` |
| `npx vitest run --minWorkers=1 --maxWorkers=4 --testTimeout=15000` | 394 文件通过、1 文件跳过；5062 项通过、8 项跳过；退出码 0，117.69 秒；`review-final-tests.log` |
| 所有修改/新增 src 的 ESLint（148 文件） | 退出码 0，0 错误、115 警告；`review-lint-final.log`。未用 disable 或修改规则消除警告 |
| `npm run build` | 退出码 0；`review-build-final.log` |
| `git diff --check` | 退出码 0；仅有既有 CRLF 规范化提示，无空白错误；原目录 git status 仍为空 |
| 源构建 Electron 隔离检查 | 新结果 9/9，子进程退出码 0，2.741 秒；`review-electron-final-result.json`。真实 preload/IPC、DPAPI、cmd/PTY、fence 输入输出、磁盘无预设明文、未登记窗口拒绝 |
| Windows 解包重建及完整性 | 退出码 0；`review-package-build.log`。87 个 dist/bridge 文件 SHA-256 与本次产物一致；`review-package-integrity.json` |
| 解包运行时与候选集成 | 30 个依赖可加载，必要资产存在，包内 node-pty 启动 cmd 并退出；`review-package-runtime-result.json`。从候选 app.asar 加载 main/preload/PTY host 后 9/9，退出码 0，3.038 秒；`review-electron-packaged-result.json` |

跳过项为原有平台/环境条件，包含进程清理、路径安全、journal、默认浏览器和本地连接测试；不能将跳过视作已验证。全量日志保留具体分布。

LyShell native Harness 仅承担测试执行，没有进行代码审查。跟踪同一 backend 实例、session、task 与 attempt 至官方 completed 后检查报告和日志，再 disconnect；未批准任何操作、未切换 PetLink、未重启共享后台。其稳定窗口执行得到 394 文件/5056 项通过；随后新增 5 项别名边界测试和 1 项卸载回归后，由 Codex 运行上述完整最终检查。委派期间的多次旧测试因本轮修复仍在进行，只留作基线；不冒充最终版本证据。一轮委派测试曾以 127 中断且无汇总，后续完整重跑通过，原异常日志未保留，原因未独立确定。

一次经 PowerShell 启动的隔离 Electron 检查没有等到 PTY 就绪，并停留在退出阶段；已核实并清理该测试进程树及等待器。未以它宣称通过，也未据此更改产品逻辑。随后使用直接 spawn、PID、真实退出码及结果文件新鲜度核对：诊断运行、未加诊断包装的源构建、候选 app.asar 均正常通过并退出，未复现该次异常。首次原因未确定，`review-electron-stdout.log` / `review-electron-stderr.log` 保留证据；过早读到的旧结果不计入验收。解包检查脚本最初使用非 Windows 原生分隔符调用 asar.extractFile，修正检查脚本后逐文件匹配，实际产物没有缺失该 chunk。

候选集成使用仓库相同版本 Electron 加载解包 app.asar，不是安装器或已安装 lyshell.exe 的完整人工验收；后者仍在发布前验证范围。最终源码自 R12 冻结后没有再修改，只更新本报告和契约说明。

## 保证范围与未验证项

最终结论是本轮没有已确认且未修复的可操作问题，并有上述验证支持；不表示绝对零缺陷，也不表示正式发布验收已经完成。

- Windows 本机验证不能替代 macOS/Linux、安装器/升级、真实串口、远端大文件、真实断网及长时间混合负载实机验收。
- SFTP 大小/mtime 检查不是内容哈希或服务器 CAS，stat 与 rename 间存在外部竞争；无确认的提交不能自动重试。取消不撤回已提交内容，Worker 未 exit 时仍占资源。
- JSON 仓储是当前 userData 单应用实例边界，跨文件/vault 不提供数据库整体事务；失败可能留下孤儿秘密引用。Windows 目录 fsync 不支持时不承诺断电持久性。
- Node/Python 插件属于当前 OS 用户信任域，API 能力和环境过滤不是操作系统沙箱；主进程无法控制 CLI/插件直接产生的所有系统副作用。
- 有界 ANSI 文本历史不是完整终端屏幕检查点；输入已送至 PTY 后无法撤回，未知输入和 Harness 未确认任务不得自动重放。
- 测试中的受控 bridge、ssh2/SFTP 与故障夹具证明对应本地边界，不等于生产付费模型或所有服务器实现均已验收。本轮未调用付费模型。
- `node_modules` 是共享 Junction；不修改或 rebuild 原生依赖。早期缺依赖的 `tmp/architecture/package/` 是禁止分发的失败产物；本轮不删除它、不绕过原自动审批拒绝。

第一阶段通过后，按用户授权启动 fresh Codex 会话「LyShell 最终架构设计独立评审」，先核对最终清单，再独立评审架构取舍并写 `docs/architecture-final-review.md`。其结论由新会话交付，本报告不代替该独立评审。
