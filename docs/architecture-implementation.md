# 架构优化实施与验收记录

本记录对应 [架构优化方案](lyshell-architecture-optimization.md)，用于说明当前分支的实现、证据和发布前仍需验证的范围。基础版本为 `32d6e2c611aa614d9ad3320fa68581115d809e91`；修改位于 `codex/architecture-optimization`，没有发布、安装或迁移正式用户档案。

## 架构决策

保留 Electron main / preload / React renderer，以及已有 PTY 宿主、传输 Worker、插件子进程和官方 dsh agent loop。此次通过执行入口、状态拥有者和提交边界收口，未整体搬移目录或增加通用 RPC 框架。仓储继续使用 JSON；原子写和损坏保护先解决当前可靠性问题。

实际依赖为 Electron **43.7.11**、React 18、TypeScript 5.9.3、node-pty 1.1.0、ssh2、serialport 12；不能按早期文档中的 Electron 28 推断 ABI。开发测试 Node 为 24.15.0，Electron 内置 Node 为 24.21.0 / modules 148。

## 入口与状态拥有者

| 路径 | 身份与授权 | 最后执行边界 / 状态拥有者 |
| --- | --- | --- |
| 主应用 GUI → preload → IPC | main 登记的 WebContents、当前应用文档、顶层 frame；普通 BrowserWindow 也不自动受信 | `application-ipc.ts`、`application-caller.ts`；连接与输入归 SessionManager / InputControlService |
| HTTP / stdio MCP / CLI 桥 | 随机回环端口、token binding、资源可见性、操作 capability、异步确认后复核 | `mcp/auth.ts`、`operation-policy.ts`、`http-server.ts`；PTY 输入需独立租约 |
| 插件 UI / host | 既有插件凭据、资源归属及 generation；不能调用 native work API | 插件管理器负责能力与回收；Node/Python 插件代码属于操作系统用户信任域 |
| local PTY | main 内部可信 CallContext；宿主认证连接及 fence | 独立 PTY host 在 `pty.write` 前检查 mainInstanceId、connectionId、epoch、leaseId、到期时间 |
| SSH terminal / file client / SFTP Worker | endpoint 与实际服务器公钥匹配；未知/变化默认拒绝 | main 信任仓储；Worker 只接收派发时固定的可信指纹，不能自己首次信任 |
| native Harness | 当前 credential 创建的 session、官方 turn 与 task/attempt/backend identity | LyShell work service 与 dsh bridge journal；PetLink 与 native ownership 独立 |
| 文件上传/下载 | 调度名额、固定 endpoint 指纹、taskId + attemptId | Worker 提交协议；管理器一直持有名额到实际线程 exit |

列表只返回相应的公开信息；机器独立执行与交互 Shell 输入都有执行权限门控。Shell 输入同时要求 interactiveWrite 与对应本地/远程执行能力；读权限不能获得输入能力。凭据/设置在异步确认后及每块输入前再次核对。PTY 输入结果未知时，调用者必须核对现场，不能自动补 Enter、Ctrl+C 或重放输入。

## 实施矩阵

| 工作包 / 步骤 | 本次实现 | 主要证据入口 |
| --- | --- | --- |
| OPT-01 / 01 | 入口、运行时、状态拥有者和工作区基线 | 本文入口表、`package.json`、`electron.vite.config.ts` |
| OPT-02 / 02–03 | CallContext、稳定 OperationError / retryDisposition、统一 Shell 操作权限分类；保留既有资源过滤 | `shared/operation.ts`、`mcp/operation-policy.test.ts`、`terminal-control-authorization.test.ts` |
| OPT-03 / 07 | 单控制者租约、人工接管、滚动续租、逐块复核、有界顺序队列、宿主 ACK 后发租约；重连/撤权/锁屏/休眠/退出失效 | `input-control.test.ts`、`local-host-control.test.ts`、`session-manager.failure.test.ts` |
| OPT-04 / 08 | 会话独占名额、请求摘要、可选幂等键、dispatch 前持久登记；保留未知名额，禁止自动重发 | `native-work-concurrency.test.ts`、`native-work-recovery.test.ts`、`resources/dsh-bridge/work-state.mjs` |
| OPT-05 / 09 | 提交事实、观测状态、最后确认状态分开；取消意图单独记录；只认所属 attempt 的官方终态；迟到事件不能回退终态 | 同上及 native work 合约；后台 identity 变化需显式恢复与副作用核对 |
| OPT-06 / 05 | 统一主机密钥验证、可信 GUI 确认、先保存再接受、信任库损坏拒绝写 | `security/ssh-host-key*.test.ts`、`security/ssh-trust.test.ts`、各 connector / file `*.hostkey.test.ts` |
| OPT-07 / 06 | 当前文档与 frame 校验、Host/Origin、请求/执行/连接/体积/JSON 深度预算、超时、中断释放 | `security/application-caller.test.ts`、`mcp/local-request.test.ts`、`mcp/http-body.test.ts` |
| OPT-08 / 13–14 | OS safeStorage vault、普通配置 secretRef、公开 DTO 掩码、同记录占位符回填；子进程 allowlist env；明确插件 OS 权限 | `secret-store.test.ts`、`secret-migration.test.ts`、`repository-*-secrets.test.ts`、`env/child-environment.test.ts` |
| OPT-09 / 10 | xterm write callback 后 ACK、有界 GUI 队列、history 全局预算、游标/epoch/gap、重订阅与 RIS 后重放 | `output-buffer.test.ts`、`output-dispatcher.test.ts`、`output-budget.test.ts`、renderer `terminal-output.test.ts` |
| OPT-10 / 04 | 唯一同目录临时文件、完整写/fsync/rename、内存回滚、可选 revision 冲突、备份、损坏只读、克隆 getter | `storage/atomic-json.test.ts` 及仓储测试；健康状态由设置页展示 |
| OPT-11 / 12 | 唯一 0600 临时文件、源/目标快照、字节计数、提交阶段与未知结果、取消确认、attempt 隔离、真实 exit 才释放 | `transfer-commit*.test.ts`、`worker-manager.attempt.test.ts`、`worker-manager.resource.test.ts` |
| OPT-12 / 11 | 先撤销输入，再等待终端/Worker/插件等清理；视图销毁只退订；既有共享 backend 租约保留独立生命周期 | `session-manager.failure.test.ts`、`local-host*.test.ts`、既有 quit cleanup / plugin uninstall 测试 |
| OPT-13 / 15 | 有界白名单事件、IPC/HTTP requestId、跨异步 main / PTY RPC 关联、手动本地诊断导出、日志轮转 | `diagnostics/*.test.ts`；导出不包含原始异常、正文、命令、env 或配置文件 |
| OPT-14 / 16 | 可复现 5 轮合成混合负载与预算断言 | [基准说明](architecture-benchmark.md)、`scripts/architecture-benchmark.ts` |
| OPT-15 / 17 | local-host v2 + input-fence-v1 必选，拒绝 v1；journal schema 超前版本拒绝；当前 Windows Electron 原生 PTY 验证 | 协议/恢复测试；安装包、平台验收见下节 |
| OPT-16 / 18 | 记录条件决策；保留可审查 worktree，提供迁移/回退边界 | 下文；发布操作尚未执行 |

## 明确的容量与单位

- GUI 队列总计 8 Mi chars、单消费者 1 Mi chars、最多 64 消费者，ACK 超时 15 秒。慢消费者退订并释放暂停；可见页面恢复时重新订阅。
- 历史每 buffer 至多 1 Mi chars，所有受管 buffer 合计 32 Mi chars，收纳历史保持更小上限。这里的 chars 是 **UTF-16 码元**，不是内存字节；派生缓存、对象、renderer/PTY 内存另计。
- 增量输出默认 64 Ki chars，硬上限 1 Mi chars；返回 epoch、cursor、gap 和截断信息。重启/替换输出源会换 epoch。ANSI 历史不等于完整屏幕快照；超长控制序列可能为保证前进被切分。缺口后的 RIS/有限重放不能恢复完整 TUI 状态。
- 输入单请求 1 Mi chars、每会话排队 2 Mi chars、全局 8 Mi chars；32 Ki chars 一块并保护代理对。已确认部分输入后发生接管/失联，返回 OUTCOME_UNKNOWN；旧队列停止。
- HTTP 请求 64 全局/16 凭据，连接 128；普通 POST 的实际 handler 执行名额 16 全局/4 凭据，响应断开不释放仍在执行的操作；body 单次 10 MiB、累计缓冲 32 MiB。JSON 深度 32、节点 100000。native Harness 与既有 exclusive 路由使用各自名额，不纳入普通 POST 执行池。
- vault 最多 1024 条秘密，每值最多 65536 字符；SSH 信任最多 4096 endpoint、文件 4 MiB；诊断事件环 256 条；会话管理器最多 256 个现场。

预算是明确的保护阈值，不是已证明的生产 SLO。默认值需结合真实多窗口/多主机负载继续测量。

## 秘密迁移与兼容

Agent、变量组、工作区及本地会话 env 的秘密先写 vault、回读验证，再原子提交引用。SSH 密码/私钥/口令保留既有 `safe:v1:` 磁盘格式。迁移失败保留原字节并拒绝后续危险保存；可能留下可诊断的孤儿 vault 条目，不会通过明文降级继续写。Linux `basic_text` 视为弱后端并拒绝新秘密写入。设置页显示仓储损坏只读及安全存储不可用状态。

公开 DTO 使用固定 `__LYSHELL_SECRET_UNCHANGED__`，只表示保留本记录原值；空串表示明确清除。SSH 目标 host/port/user 改变时不能沿用旧秘密。解密失败的密文保留；锁定状态下改名可成功，明确清空会删除对应密文。引用不可复制到另一条记录获得解密权。未命名为秘密且未显式声明 `secretEnvKeys` 的 env 值仍视为普通配置。

加密配置导出包含加密后的 SSH/local env 秘密，去掉 vault 引用；普通导出删除秘密。导入解密后的会话只暂存在 main，预览返回掩码；可信 GUI 通过限时、绑定窗口、一次性票据提交选择。票据提交部分失败时不自动重试，重新预览前应核对已保存条目。

子进程只继承 OS/PATH/临时目录/home/locale/proxy/CA 等允许项，显式 env 覆盖最后生效；不再隐式继承宿主所有 provider key、MCP token 或 NODE_OPTIONS。以前依赖隐式环境的启动器需要明确配置变量组。Node/Python 插件拥有当前用户的 OS 权限；API capability、renderer sandbox 和 env 过滤不能构成 OS 沙箱，共享插件宿主属于一个信任域。

## 传输与退出边界

进度 100% 仅表示数据阶段结束。完成必须经过校验、rename 提交和明确结果；提交已派发却没有可靠回执时返回 outcome-unknown。已有远端目标必须支持 `posix-rename@openssh.com`，否则保留旧文件并拒绝覆盖。只删除本 attempt 创建的临时文件，不先删除最终目标。取消请求与取消完成分开；强制终止超时仍占资源，直到实际 exit。

源/目标校验使用类型、大小、mtime 等元数据，不是内容哈希或服务器 CAS；SFTP 时间戳粒度有限，最后 stat 与 rename 间仍存在竞态。新目标的普通 SFTP rename 依赖服务器语义。Windows 目录 fsync 不支持时如实记录，不能宣称断电持久性。当前协议不提供断点续传，失败或未知提交不自动续传/重试。

正常退出先阻断新输入并撤销 fence，随后等待终端、传输 terminate、插件进程、TUI/dsh 清理和历史 flush；总等待预算用既有 bounded quit helper。超时意味着清理未被确认，不能视作外部副作用已回滚。退出预算到期最终由 app.exit 结束本进程，外部共享 backend 不由此重启或关闭。

## 验证记录

完整日志保存在工作区 `tmp/architecture/`，该目录为本地证据，不加入发行包。源码审查与集成由 Codex 完成；LyShell 原生 Harness 承担独立实现和测试执行，所有委派任务均已核对官方终态并释放本凭据租约，未重启共享后台。

- `npm run typecheck`
- `npx vitest run --minWorkers=1 --maxWorkers=4 --testTimeout=15000`
- 对所有修改/新增 src 文件运行 ESLint；`git diff --check`
- `npm run build`；隔离 Electron 档案的真实 preload → IPC、safeStorage、PTY 与未登记窗口拒绝验证
- 真实 named-pipe 宿主协议、ssh2 回环服务器与 SFTP 夹具；没有连接外部 SSH 主机

| 最终检查 | 结果 |
| --- | --- |
| 完整 Vitest（393 文件） | 392 通过、1 跳过；5036 测试通过、8 跳过，176.04 秒，退出码 0 |
| 终端 UI / 收纳回归（控制权就绪后同步当前几何） | 7 文件 / 85 测试通过；不会重放键盘输入 |
| TypeScript / build / diff check | 均退出码 0 |
| 修改及新增 src 的 ESLint | 0 错误、115 警告；警告仍需后续逐步治理 |
| 原生 Electron / vault / PTY / 未登记窗口 | 9/9 断言，正常退出 |
| Windows 解包运行时 / 内容一致性 | 30 依赖可加载、包内 PTY 可退出；8 项关键文件与当前 dist/bridge 一致 |

最终整套日志为 `complete-final-tests.log`，另有 `terminal-ui-final.log`、`typecheck-delivery.log`、`lint-final.log`、`build-final.log`、`package-smoke-result.json`、`package-integrity.json`；更早失败日志保留用于核对，不能替代最终结论。

隔离 Electron 测试可用 `scripts/architecture-electron-smoke.cjs` 重现：先 `npm run build`，在 **ELECTRON_RUN_AS_NODE 未设置**的环境下用仓库 Electron 执行该脚本。脚本仅支持当前 Windows cmd/DPAPI 夹具，自动创建 `tmp/architecture/electron-smoke-profile-*`，不使用正式或 dev 档案；验证真实 preload/IPC、掩码修改、vault 磁盘无明文、本地秘密 env、租约输入/输出与未登记窗口拒绝后正常退出。加 `--package-candidate` 会从已验证目录的 app.asar 加载 main / preload / PTY host，仍由开发 Electron 使用隔离档案运行。结果写 `tmp/architecture/electron-integration-result.json`，9/9 断言通过，退出码 0。

Windows x64 **解包目录**构建与其内部运行时加载检查通过：30 个依赖全部可加载，serialport / koffi / node-pty 原生模块可装载；打包内 PTY 启动 cmd、读到标记并正常退出。main、PTY/上传/下载 Worker、preload、renderer 与 asar 外 dsh bridge 都存在。没有启动打包 GUI、执行安装器或修改系统安装。当前 worktree 的 node_modules 是 Junction，直接在该路径打包会漏收集传递依赖；此次在真实依赖根收集模块，仅从本 worktree 取 dist/resources，并核对 manifest 相同。不要分发最初带缺依赖警告的 `package/` 试验产物，其清理被自动审批拒绝（blocked by policy），已加 `DO-NOT-DISTRIBUTE.md`；通过验证的目录是 `tmp/architecture/package-real/win-unpacked`。普通发布应使用完整、非 Junction 的依赖安装并再次验证。

回归期间出现过旧临时文件状态断言及一次夹具 HTTP 空闲连接 `ECONNRESET`。前者按 rename 已消费临时路径修正为 removed；后者将传输夹具请求设为独立连接，未增加提交重试。真实远端传输与客户端网络容错不能据此宣称已经验收。

合成基线 5 × 3 秒、32 buffer / 4 窗口 × 8 订阅，2 路本地流拷贝与同步/异步 JSON 竞争。16/16 断言通过；采样 RSS 145.84–184 MiB，heap 10.43–10.73 MiB，EL p95 20.4–21.7 ms，产出 8.41–8.56 Mi chars/s。为了短时间触发回收/超时，历史预算缩为 8 Mi chars、ACK 超时缩为 250 ms。无强制 GC，非真实 xterm/网络负载。JSON 中 commit 表示基础 HEAD；测量运行在本次未提交 worktree 上。

## 发布与回退

后续 Codex 循环代码复审的修复、当前验证结果和冻结清单见 [代码复审记录](architecture-code-review.md)。上面的 5036 项测试及原始打包记录属于实施阶段基线；交付验收以复审记录为准。复审补齐了秘密 DTO、仓储回滚/并发、排队传输授权与信任复核、Harness 重试别名、HTTP 中断及会话克隆退出边界。Harness 的 10000 去重预算包含退役摘要与别名。

local-host v1 与本次 main 不能安全混用；升级需结束旧终端宿主并重新建立现场，不能降级为无 fence 输入。桥 journal 仍为 schema 1 的可选字段扩展，未来更高 schema 明确拒绝；离线读记录不是当前 backend 已完成的证据。客户端应先升级并使用控制权 API，再发送 PTY 输入。

JSON primary 只有提交成功才更新 revision；backup 刷新失败不把已成功 primary 提交报成失败。损坏原件保留，仓储只读；恢复需要停应用并显式选择、校验备份，不能用默认空库自动覆盖。`recoverJsonFileFromBackupSync` 为低层恢复能力，本次未增加一键图形恢复功能。多实例仍使用现有每 userData 单实例锁；没有为任意外部程序共享 JSON 目录提供跨进程数据库事务。

代码回退与数据回退分开。旧版本不理解 secretRef 和输入 fence；需要在独立档案中验证回退并从用户批准的备份恢复配套配置/vault，不能直接删 vault 或把秘密改回明文。没有自动回退正式配置。Windows 安装/升级、真实远端大文件、macOS/Linux 打包与弱存储环境的实机验收仍是发布门槛；本次不自动发布或修改系统安装。

SQLite、进一步进程隔离、webview 迁移、完整终端 checkpoint 暂不引入：当前没有证据表明新增迁移与兼容成本能解决已测瓶颈。若真实负载出现同步 JSON 阻塞、混合信任插件需求、Electron API 移除或完整 TUI 恢复需求，应单独立项并补齐基线。
