# LyShell 资源使用审查

审查日期：2026-10-21。工作目录：`D:/workspace/claude/LyShell`。

2026-10-22 后续：F1–F3 与 C1/C2 已补修并验收；全部未提交代码的最终复审与验证见 [提交前复审记录](resource-audit-final-20261022.md)。下方保留各阶段当时的结果与限制。

本清单按用户功能和资源所有权拆分，而非仅按目录拆分。审查与最终集成由 Codex 完成；原生 Harness 按明确范围实施 R02/R03 并执行指定测试，不参与代码审查。检查内存、CPU、磁盘、进程、连接、定时器、监听器及取消/退出路径。

## 模块与顺序

| 顺序 | 功能模块 | 主要代码 | 状态 |
| --- | --- | --- | --- |
| 0 | 终端与连接（SSH/Telnet/串口/PTY、xterm 输出） | `main/connectors`、`main/terminal`、`renderer/components/Terminal` | 前序修复本轮回归通过 |
| 1 | Work Launcher（Agent/Codex/Claude、目录预设、worktree） | `main/harness`、`main/codex`、`Layout/WorkspaceLauncherTree`、`HarnessPanel` | R05 已修复 |
| 2 | DSH 工作后台、原生任务与市场 | `main/dsh`、`resources/dsh-bridge` | R10 已修复 |
| 3 | 文件管理与上传下载 | `main/file`、`FileManager` | R01/R02/R03 已修复 |
| 4 | 插件安装、宿主、视图和资源回收 | `main/plugin`、`main/plugin-host`、plugin store | 首轮完成；已审路径未确认新增缺陷 |
| 5 | Python 执行引擎 | `main/python` | 首轮完成；已审路径未确认新增缺陷 |
| 6 | 内置浏览器、下载和凭据 | `main/browser`、`Layout/Web*`、browser stores | 首轮完成；保活成本见下文 |
| 7 | 文档预览与导出入口 | `DocPanel`、对应 IPC | R06 已修复 |
| 8 | MCP HTTP/stdio、终端流与截图 | `main/mcp`、`main/mcp-server`、preload/IPC 边界 | R01/R09 已修复 |
| 9 | 配置、历史、审计与持久化 | `main/storage`、配置导入导出 | R04 已修复 |
| 10 | 搜索、快捷命令与命令屏 | `Search`、`QuickCommands`、`CommandScreen` | R07 已修复 |
| 11 | 布局、标签页、浮动窗口与前端状态 | `Layout`、`FloatWindow`、pane/ui/session stores | 首轮完成；已审路径未确认新增缺陷 |
| 12 | 连通性探测、环境检测与 Explorer 集成 | `main/reachability`、`main/env`、`explorer-*` | R08/R05 已修复 |
| 13 | 应用启动/退出、日志及更新入口核对 | `main/index.ts`、`quit-cleanup.ts` | 首轮完成；已审退出路径未确认新增缺陷 |

## 判断标准

- “发现问题”须给出触发路径、实际资源影响与源代码证据；缺少长期运行数据时不声称已量化泄漏速率。
- “未发现新增问题”仅代表已审查路径；测试通过不代表没有泄漏。
- worktree、用户下载和 Chromium 持久化数据有业务保留用途，不能直接当作泄漏删除。
- 不重启/替换用户正在运行的 LyShell，不修改真实连接、权限或后台配置。源码验证与正式实例运行观测分开记录。

## 验证材料

- 前序终端：`tmp/terminal-resource-audit/fix-verification-report.md`、`tmp/terminal-followup-audit/followup-report.md`。
- 本轮命令、复现数据和测试：`tmp/module-resource-audit/`（本地审查材料，忽略打包）。
- 修复前基线最终复跑：`tmp/module-resource-audit/final-vitest.log`，226 文件通过、1 文件跳过；2899 用例通过、5 用例跳过。类型检查通过，见 `baseline-typecheck.log`。
- 原生 Harness 首跑有 1 个 `market-process.test.ts` 的 spawn 失败；Codex 在 PowerShell 中单独复跑通过，再完整复跑通过。未改动源码/测试来规避失败；首跑日志保留，具体环境差异尚未定位。

## 首轮结论

确认新增 **10 项**资源问题：1 项 P1、8 项 P2、1 项 P3。P1 优先处理可能耗尽主进程内存的路径，P2 为有实际触发条件的卡顿、资源增长或取消失效，P3 为影响较小的磁盘残留。

2026-10-21 专项修复：**R01–R10 全部完成修复和专项反向验收**。最终完整回归、类型检查与构建通过。下方保留原发现与复现证据，并逐项追加修复行为、文件和边界。前序终端未提交修复保留；没有提交、发布、重启正式实例或删除用户下载/worktree/已有历史。

### R01 · P1 · 命令输出缺少总量上限和 SSE 背压

- 修复状态：**专项验收通过**。`src/main/file/command-output.ts` 将 SSH exec、持久 shell、本地流式命令结果/增量输出共用上限设为 1,048,576 UTF-16 字符；超限明确失败，不返回伪成功截断结果。`ssh-command-executor.ts` / `ssh-command-shell.ts` 取消并销毁通道；shell 每次只扫描最多 128 字符尾部加新块，完成时保留真实退出码。
- SSE：新增 `src/main/mcp/command-stream.ts`，4 Ki 字符分帧，`write(false)` 后等待 drain；待发送队列最多 256 KiB，5 秒无 drain 或队列溢出便关闭响应并取消命令。最终 done 保留兼容 output，但受命令硬上限约束。`local-command-stream.ts` 关闭管道并调用现有进程树回收；`mcp-server/http-client.ts` 使用 StringDecoder 与 7 Mi 字符帧上限。
- 反证：32 MiB 输入仅发送 1,048,576 字符后拒绝、通道销毁 1 次；模拟永不 drain 的响应只调用 write 1 次，观测队列 260,253 字节后取消。SSH/本地输出、UTF-8 分片、取消、退出码、drain 恢复/超时/异常见 `ssh-command.test.ts`、`local-command-stream.test.ts`、`command-stream.test.ts`。
- 边界：超过上限的命令现在失败，需调用方缩小输出或写入文件；慢消费关闭会表现为连接错误。本地树回收失败会记日志，不声称已验证正式实例或远端进程的停止。

- 位置：`src/main/file/ssh-command-executor.ts:56`、`ssh-command-shell.ts:92`；`src/main/mcp/http-server.ts:1162`、`:3237`；stdio 消费方见 `src/main/mcp-server/http-client.ts:299`。
- 触发：MCP 执行大量输出的 SSH 命令或本地流式命令，尤其客户端读取缓慢时。它们与已修复的 xterm 交互式输出是不同管线。
- 问题：即使增量发送，每个输出块仍追加到完整字符串；结束时又发送完整结果。SSE `res.write()` 返回 false 被忽略，慢客户端还会增加发送队列。SSH 持久命令 shell 还在每块到达时扫描不断增长的完整输出寻找结束标记。
- 证据：实际 `SSHCommandExecutor` 接收 32 MiB 模拟通道输出后，完整保留 33,554,432 字符；没有截断或拒绝。此复现使用真实源码和模拟 SSH 通道，不是正式实例的堆快照。
- 处理方向：明确结果上限/截断语义，流与最终结果分别限额；背压时暂停上游或取消慢消费者；完成标记只扫描有限尾部。验收须覆盖大输出、慢消费、取消和真实退出码。

### R02 · P2 · 文件 SSH 连接的等待者可在断开后重新建连

- 修复状态：**专项验收通过**。`src/main/file/ssh-file-client.ts` 用单一连接 Promise 和 SFTP Promise 代替轮询；拆除推进代次并拒绝所有等待者，ready/close/error/SFTP 回调核对实例和代次。同步连接失败也销毁 transport，旧 error 保留吸收监听，重连退避复核代次。
- 反证：两个等待者在 disconnect 后均拒绝，80ms 后仍只有 1 个 transport（修复前 2 个）；40 并发连接只建 1 个，迟到事件/并发 SFTP/空闲断开重连见 `ssh-file-client.resource.test.ts`（10 项，模拟 ssh2）。
- 边界：disconnect 取消旧等待者；其后显式的新请求仍可建连，保持原有懒连接/空闲断开的语义。没有连接真实 SSH 服务器。

- 位置：`src/main/file/ssh-file-client.ts:173`、`:180`、`:224`；实际入口为 `src/main/file/manager.ts` 的独立文件/命令连接。
- 触发：同一会话两个请求同时等待文件连接，连接期间关闭会话或移除文件连接器。
- 问题：等待者用 50ms 定时轮询；`disconnect()` 清掉 `connecting` 后，等待者将其当作连接失败并调用 `connect()`。等待任务没有生命周期代次或取消信号；旧 ready/close 回调同样缺少实例核对。
- 证据：模拟 ssh2 Client 的确定性时序中，断开前 1 个 transport，断开后等待者又创建第 2 个。夹具最终收尾全部 Promise；没有连接真实服务器。
- 处理方向：单一在途连接 Promise、代次/关闭标记、明确取消等待者；并发 SFTP 初始化也应复用在途请求。关闭后的迟到事件不得改变新连接状态。

### R03 · P2 · 文件传输没有全局 Worker 并发上限

- 修复状态：**专项验收通过**。新增 `src/main/file/transfer-scheduler.ts`；上传和下载共用全局 4、每 host:port 2 的额度，活动加等待任务最多 64，超出给 UI/MCP 明确失败。两个 worker manager 保留原同路径串行器，额度一直占到 Worker exit，complete/error 消息不提前释放。
- Codex 集成修正：首个 await 前登记 admission，覆盖额度已发放但 Worker 尚未登记的取消间隙；按方向撤销本管理器任务，取消后丢弃迟到消息、清下载 meta，重复 taskId 拒绝。会话取消与全清理覆盖入口、路径队列、调度队列和活动线程。
- 反证：40 个不同路径混合传输峰值全局 4、每 endpoint ≤2（修复前 40）；70 个提交仅接受 64，剩余 6 个明确失败；complete 未 exit 不启动超限线程；首个微任务前取消不创建 Worker。`transfer-scheduler.test.ts` 9 项、`worker-manager.resource.test.ts` 13 项及现有串行/安全测试通过。
- 边界：测试使用模拟 Worker/SSH。额度包含同路径队列等待者，实际活线程可少于 4；host 别名未做 DNS 归并。队列容量含活动任务，不是额外 64 个等待项。

- 位置：`src/main/file/upload-worker-manager.ts:67`、`:78`、`:100`，下载侧 `download-worker-manager.ts:92`、`:129`；界面批量上传入口 `src/renderer/components/FileManager/FileManagerPanel.tsx`。
- 触发：一次选择/拖入大量不同目标文件。界面的 await 等待的是“已启动”回执，随后立即开始下一个文件。
- 问题：串行链只约束同一路径，不同路径立即创建 Worker，每个 Worker 又建立独立 SSH/SFTP 连接。总线程、V8 实例、连接和 SFTP 请求会随所选文件数增长。
- 证据：执行实际管理器/串行器，以模拟 Worker 按界面顺序提交 40 个不同文件，在第一个完成前已登记 40 个活动 Worker。完成后归零，因此问题是峰值并发缺少约束，不是本次证明了 Worker 永久泄漏。
- 处理方向：全局及每主机并发队列；排队项可取消、会话关闭可批量撤销；保持同路径互斥。不得限制总并发后破坏队列取消与进度回执。

### R04 · P2 · 下载历史无保留上限，逐次全量重写

- 修复状态：**专项验收通过**。`src/main/storage/download-history.ts` 改为 v2 manifest + 每块最多 1000 条的不可变归档，内存中最多 1000 条完整热记录，所有历史保留且可分页访问；旧 `download-history.json` 只读迁移后原样保留。正常更新 250ms 合并写入，串行原子 rename，退出在 `src/main/index.ts` 等待 flush。
- IPC/界面：`handlers.ts`、`validation.ts`、`preload/index.ts`、`DownloadHistoryList.tsx` 同时更新：校验偏移、每页最多 100 条、前后翻页、旧回复版本隔离；旧调用无 offset 时仍返回 data 数组（第一页），并增加 hasMore。老同步内部 getter 仅返回热记录，完整历史用 getPage。
- 反证：相同 2000 条固定记录由 2000 次整库保存、累计 652,615,495 待写字节，变成 2 次写入、497,012 字节；热记录 1000、20 页可恢复全部 2000 条。真实临时目录验证 2100 条旧数据原文保留、归档 MD5 更新/删除、筛选分页、显式清空、rename 失败重试与损坏文件隔离。`download-history.test.ts` 5 项；浏览器验证 1–100 → 101–200 → 201–205，末页按钮禁用。
- 保留策略和限制：不按年龄/条数自动删除历史或下载文件；归档及其轻量索引仍随保留历史增长。首次旧 JSON 迁移仍需一次整体解析；归档筛选/极旧 MD5 更新需要逐块读取。250ms 内未 flush 的热更新在崩溃时可能丢失，正常退出等待 flush；原子替换不等于断电 fsync 保证。异常退出可能留下尚未引用的自有归档/临时文件，本轮没有擅自扫描删除它们。

- 位置：`src/main/storage/download-history.ts:92`、`:131`、`:152`；界面 `src/renderer/components/FileManager/DownloadHistoryList.tsx` 全量拉取并渲染。
- 触发：长期下载大量文件或频繁补写 MD5。
- 问题：所有历史保留在内存及单个 JSON 文件；每次新增/更新整库 stringify 和 writeFile。加载与界面也消费整库，没有分页。写入还没有统一串行/原子保存管线。
- 证据：2000 条固定样例新增产生 2000 次保存，最终 JSON 为 652,892 字节，累计序列化待写数据 652,615,495 字节，约为最终文件的 999.6 倍。复现拦截磁盘写入，**未实际向磁盘写入这 652 MB，也未声称实测了写盘耗时或文件损坏**。
- 处理方向：确定保留策略/分页，批量合并更新，串行原子落盘或增量存储；保留策略须明确，不能默默删除用户需要的历史。

### R05 · P2 · Work Launcher/环境检测同步阻塞主进程

- 修复状态：**专项验收通过**。`src/main/env/refresh.ts` 用异步 execFile 读取 PATH，同轮 single-flight、5 秒 TTL；显式 detect 强制刷新但复用在途。`LocalConnector`、IPC 检测/启动、DSH resolver/web 等异步等待；同步市场工具环境物化只读已确认快照，不再启动 PowerShell。LocalConnector 等待期间断开会作废代次，防止迟到 PTY。
- 反证：真实只读查询三路请求合并为 1 个 PowerShell，耗时约 354.9ms，期间 10ms 定时器执行 22 次（原连续同步三次约 1068ms，定时器 0 次）。TTL、显式刷新、取消见 `refresh.resource.test.ts` 与 `local.test.ts`；DSH 启动/后台/市场相关测试通过。
- 边界：实际查询最多 5 秒，读取失败回落进程 PATH；TTL 内普通启动可使用短暂缓存，检测按钮可刷新。Explorer 的另一条目录查询同步 PowerShell 观察不在本确认项范围。

- 位置：`src/main/env/refresh.ts:57`、`:68`；`src/main/ipc/handlers.ts:2394`；前端启动预热 `src/renderer/components/Layout/harness-detect.ts`。
- 触发：Windows 启动时预热 dsh/codex/claude 检测，手动重检或启动本地终端/Launcher。
- 问题：主进程用 `execFileSync` 启动 PowerShell。三个预热 IPC 虽在 renderer 并发发出，main 仍连续同步阻塞；每次最坏允许 5 秒。缓存阻止了切页重复检测，但没有消除首次三次进程启动。
- 证据：本机真实只读 PATH 查询分别约 394/336/339ms，连续三次阻塞约 1068ms；0ms 定时器期间未执行。该值是本次本机测量，不是所有机器的固定开销。
- 处理方向：异步读取并合并同轮在途请求，使用短 TTL 与显式刷新；检测和实际 spawn 共用已确认的 PATH 快照。

### R06 · P2 · 大代码块同步高亮可卡住文档页

- 修复状态：**专项验收通过**。`src/renderer/components/DocPanel/hljsToReact.ts` 在 highlight.js 前限制 16 Ki 字符/400 行；高亮 HTML 最多 256 Ki 字符，转换共用 2048 节点和 32 层深度预算，超限纯文本降级，保留原文与复制。
- 反证：原 983,040 字符输入产生 262,144 顶层节点、隔离转换约 3743ms；修复后 Node/JSDOM 约 0.06ms、真实浏览器约 0.2ms，均只有 1 个文本节点。10 MiB 单块也降级，门限内 token 放大同样降级；`hljsToReact.test.ts` 8 项。
- 边界：以上是算法/独立浏览器夹具测量，不是正式 Electron 帧率；小块仍同步高亮，整体 Markdown 解析与大量普通文档 DOM 不在该高亮预算内。

- 位置：`src/renderer/components/DocPanel/hljsToReact.ts:83`；`MarkdownDoc.tsx` 的 CodeBlock/useMemo；本地读取允许 10 MiB 文档。
- 触发：打开含大量带语言标记代码的 Markdown 文档。
- 问题：highlight.js、HTML DOMParser、递归转换 React 节点全部同步执行；没有按代码块大小/节点数降级的门限。useMemo 避免重复计算，但首次渲染仍承担全部成本。
- 证据：983,040 字符（960 KiB）的 JavaScript 代码输入，在 Node/JSDOM 隔离夹具中转换耗时约 3743ms，产生 262,144 个顶层 React 子项。这**不是 Electron 实际帧耗时**；它验证的是生产同一同步算法的成本与节点放大。
- 处理方向：大块降级纯文本/按需高亮、限制节点数量，必要时后台预处理或虚拟化；不得让最大合法文档在首次打开时生成海量 React 节点。

### R07 · P2 · 正则搜索没有执行预算

- 修复状态：**专项验收通过**。新增 `Search/text-search.ts`、`regex-search.worker.ts`、`regex-search-client.ts`，正则 exec 仅在可终止 Worker 里执行，500ms 超时、换查询/DOM 改动/隐藏/卸载均 terminate；超时/容量失败有中英反馈。`dom-search.ts` 收集最多 2 Mi 字符/20,000 DOM 节点，按约 8ms 分片让出界面；query 最多 4096 字符，匹配仍最多 1000。
- 反证：`(a+)+$` 对 35 个 a 加 !，修复前超过 1500ms 未返回；真实浏览器现在约 501ms 明确超时，期间 20ms UI 定时器运行 24–25 次。异步 Range 映射保留跨 inline、Unicode 全词、零宽推进、段落分隔；搜索与 Worker 生命周期测试通过。
- 复跑修正：首轮全套测试暴露冷 JSDOM 下 100ms 整体 DOM 门限误拒绝合法小文档，已替换为分片让出，未放松 Worker 的 500ms 预算；相关失败复跑通过。
- 边界：Worker 启动成本包含在 500ms 内，复杂合法正则也可能超时；大于内容门限会提示缩小范围。网页 guest 的 findInPage 仍沿用 Chromium 路径。

- 位置：`src/renderer/components/Search/dom-search.ts:45`、`:50`；`SearchableTab.tsx` 同步调用。
- 触发：文档搜索启用正则，输入嵌套量词等高回溯表达式。
- 问题：合法语法直接进入 UI 线程 `RegExp.exec()`；1000 匹配上限只在完成匹配后检查，无法限制单次匹配时间；120ms 防抖也不能中断正在执行的正则。
- 证据：文本 `'a'.repeat(35) + '!'`，查询 `(a+)+$`，实际 `findTextRanges` 在隔离线程中超过 1500ms 未返回；夹具终止的是自身 Worker，没有在正式界面执行危险搜索。
- 处理方向：隔离可终止搜索、限制表达式能力/采用可控算法，并给出明确超时反馈。单纯增加结果数量上限不能解决此问题。

### R08 · P2 · 连通性探测的并发/停止约束未覆盖整轮

- 修复状态：**专项验收通过**。`src/main/reachability/reachability-prober.ts` 共用在途轮次；stop/setTargets 推进代次，取消活动 Socket 与首次/周期定时器，旧结果不回写、不继续排队调度。
- 反证：并发配置 2、同时三轮由峰值 6 变成 2；stop 后启动数由 4 变成 0。`reachability-prober.test.ts` 3 项覆盖 Socket destroy、换目标、初次 timer 清理；未发出真实网络流量。
- 边界：probeNow 仍是可显式调用的手动轮次；stop 取消已有轮次，不禁止未来明确的新调用。目标替换后的新请求等待旧轮退出，以避免代际并发叠加。

- 位置：`src/main/reachability/reachability-prober.ts:79`、`:97`、`:105`。
- 触发：定时轮次未结束又手动触发探测，或探测过程中 stop/更换目标。
- 问题：每次 probeAll 单独创建 concurrency 个执行者；inflight 只去重相同目标，不限制全局 Socket 总数。stop 只清周期定时器，当前批次仍继续调度剩余目标。
- 证据：并发配置设为 2，三轮同时 probeNow 的峰值为 6；stop 时已开始 6 个，stop 后又启动余下 4 个目标。模拟 probeOne，不产生实际网络流量。
- 处理方向：共享轮次或全局限流，停止/替换目标时作废代次、取消活动 Socket，防止旧结果回写。

### R09 · P2 · MCP 目录遍历只限制匹配结果，不限制工作量

- 修复状态：**专项验收通过**。新增 `src/main/mcp/list-files.ts`，目录扫描最多 256 个（含待访问队列）、检查条目最多 10,000、时间最多 5 秒，返回最多 5000；所有路径包括非递归均执行上限，响应携带 truncated/reason/计数。HTTP handler 监听 response close 并取消。
- 反证：原已断开 + 无匹配 glob 仍调用 501 次 listDir，现在调用 0 次；500 子目录的无匹配树遇目录队列预算后明确截断；长链最多 256 次 listDir，巨目录最多检查 10,000 条，普通返回页/迟到读取/5 秒挂起覆盖于 `list-files.test.ts` 5 项。
- 边界：SFTP listDir 本身仍会先取得一次完整目录数组；取消立即停止等待和后续遍历，但最多一个已发出的共享 SFTP 请求可能继续落定。本轮不为取消单个读取而断开其他文件操作共用的 SSH 连接。

- 位置：`src/main/mcp/http-server.ts:2207`、`:2211`、`:2223`、`:2235`。
- 触发：recursive + 不命中的 glob，或客户端在递归中断开；普通单目录请求亦可能返回巨目录。
- 问题：maxEntries 检查 out.length，glob 不命中时可以遍历整个远端目录树；没有访问目录/检查条目总量、持续时间和客户端断开取消预算。非递归无过滤快速路径还完全跳过 maxEntries。
- 证据：抽取并执行生产 `handleListFiles` 源码，虚拟 500 个子目录，maxEntries=1、glob 无匹配、响应已断开，仍完成 501 次 listDir，返回 0 条且 truncated=false。未请求真实远端文件系统。
- 处理方向：分别限制扫描量与返回量，增加时间和取消预算；快速路径遵守返回上限。不能通过缩小返回页大小来假装扫描已被限制。

### R10 · P3 · DSH 桥运行目录只清文件，不清空目录

- 修复状态：**专项验收通过**。`src/main/dsh/bridge.ts` 给本代 run 目录写独立非凭据归属标记；cleanup 核对归属、删除自有 patch/marker 后只 rmdir 空目录，保留外来内容。启动最多检查 256 个候选，只有标记有效、PID 确认不存在、目录没有其他文件时才回收；活 PID、未知归属、被改写 patch、符号链接均保守保留。
- 反证：真实临时夹具 20 次 prepare + cleanup 后剩余目录由 20 变成 0；旧 plan 迟到不删除同路径新代，外来文件/活动 plan 保留、死亡 PID 的自有目录回收见 `bridge.test.ts` 26 项。
- 边界：以前版本未带归属标记的历史空目录不自动删除；PID 被复用为活进程时宁可保留，避免误回收活动资源。

- 位置：`src/main/dsh/bridge.ts:399`、`:409`。
- 触发：多次新启/关闭 DSH 后台。
- 问题：每次生成独立 run-* 目录，但 cleanup 只删除带归属标记的 patch 文件，保留空目录；异常退出还可能留下 patch。代次隔离有必要，但缺少安全的目录回收流程。
- 证据：在本地临时夹具真实执行 20 次 prepare + cleanup，剩余 20 个空目录、0 个 patch。目录只含该夹具自身文件，未操作正式运行目录。
- 处理方向：只在核对本代归属后删除空目录；启动时安全清理已确认过期的自有目录，不碰活动后台和用户文件。

## 其余模块的检查结果与限制

1. **终端**：沿用已完成的 SSH/Telnet 生命周期、输出背压、OutputBuffer 修复。最终全量回归包含这些新增用例；此前真实 SSH/xterm 压测材料仍保留。本轮没有把 R01 的独立 exec 管线误算为已经由终端背压覆盖。
2. **Work Launcher**：已检查树构建、依赖缓存/在途去重、预设归并与串行器、启动 IPC、worktree 的 git 超时/1 MiB 输出限制、模型配置写前内容比对。保存项不是每次启动都新增；启动使用瞬态终端。worktree 会保留源码和未提交修改，磁盘增长属于明确的保留行为，不能作为泄漏自动删除。大规模 legacy 启动项匹配有 O(启动项×预设数) 成本：3000 项夹具约 1.33 秒，列为规模优化观察，未将其作为日常规模的已确认故障。
3. **DSH**：检查启动输出尾部上限、ready/握手超时、桥响应上限、租约、Job Object/核对 PID 的退出回收。原生任务有 64 凭据、每凭据 64 会话/256 requestId、256×512 字符 transcript、128 审批的上限；本轮按同实例/会话/任务确认完成后断开原生租约。官方 dsh 历史的长期保留策略不由本轮 LyShell 源码检查证明。
4. **插件**：检查 ZIP 下载/解压限额和流背压、安装临时下载清理、日志限速、弹窗容量/TTL、guest/动作取消、宿主代次、重启风暴限制、进程树清理和资源归属。ZIP 50 MiB、单条解压 200 MiB、总解压 500 MiB，单插件弹窗 8 个。已审路径未确认新增缺陷；未给第三方插件业务代码做性能保证。
5. **Python**：检查 execute/runScript 输出捕获、spawnScript 日志、取消信号和插件宿主接管树回收。stdout/stderr 捕获各有 1,000,000 字符上限；persistent 不累计完整结果。插件 oneshot 传入 onCancel，宿主 stop 跟踪并回收 persistent。当前实际调用路径未确认新增缺陷；未将无调用入口的辅助方法单独升级为用户故障。
6. **内置浏览器**：检查 WebTabLayer 实体寿命、观察器清理、guest 权限/证书/密码弹窗、下载活动项回收、favicon 和历史缓存。关闭页签会卸载实体；切走/收起保持 guest 存活，**隐藏不等于释放内存或停止网站后台工作**。这是保留页面状态的成本；本轮未证明关闭后泄漏。已完成下载仅保留最近 100 条，地址历史 30 条，favicon 请求缓存 200 项；缓存/站点数据有显式清理入口。未做每个网站的长时间运行采样。
7. **文档**：远端文件按块读取、实际累计字节超限即拒绝，并在 finally 关闭句柄；本地 stat 预检 10 MiB。刷新有版本校验，关闭后不回写 payload。`openVersions` 按访问过的文档身份常驻，尚无清理，记录为低量元数据优化观察；内容 DOM 的主要风险是 R06。
8. **MCP/API**：检查请求 body 10 MiB 限额、文件读取 1 MiB 上限、普通终端 SSE 最多 16 订阅且遇背压关闭、截图超时/尺寸/PNG 限额，以及 stdio HTTP/SSE 消费。命令输出 SSE 与普通终端订阅实现不同，R01 不能用后者的限额免责。
9. **存储**：检查 JSON 仓库的读写频率和在内存中的保留方式。MCP 审计 append 有 5000 条上限并防抖 2 秒落盘，启动读盘仍是整体 JSON；Launcher/模型配置具备部分原子写及同内容跳过。下载历史 R04 是明确的持续增长热点。完整配置大库读写、历史并发损坏未在真实用户数据上压测。
10. **搜索/快捷命令/命令屏**：检查搜索监听器与 MutationObserver 清理、隐藏/关闭搜索的高亮和 range 清理、快捷命令反馈定时器与入口。正常功能未确认持续空转；正则执行 R07 为已复现的阻塞点。
11. **布局/标签页/浮窗**：检查 pane store 覆盖层 payload 剪除、webview 注册注销、分屏观察器和窗口尺寸保存。布局 300ms 去抖、窗口尺寸 500ms 去抖；文档内容不随布局写入 localStorage。订阅式正常路径未确认新增资源缺陷；未将浏览器保活状态算作关闭泄漏。
12. **探测/环境/Explorer**：TCP 单探测具有超时并 destroy Socket，但整轮管理存在 R08；PATH 为 R05。Explorer 目录读取也使用最长 5 秒同步 PowerShell，属于同类阻塞观察，未实际操作用户 Explorer。
13. **应用生命周期**：核对关窗引用/resize timer 清理、插件 graceful deactivate、Worker 清理、MCP 停服、审计 flush、DSH 与插件树回收等待/退出预算。未通过实际关闭用户正在运行的程序来验证退出；没有发现本轮可确认的新增退出缺陷。代码中未找到自动更新运行调用，不因存在 electron-updater 依赖就虚构更新进程资源结论。

### 调用入口复核后未计入当前缺陷的项目

- `src/renderer/stores/file-store.ts` 的 initFileTree 在 clearSession 后可被迟到回复恢复（夹具恢复了 1000 个节点），但当前界面入口使用 `FileManagerPanel`，未发现该旧 FilePanel 的挂载入口；不能据此宣称当前文件管理界面存在同一个故障。
- 当前 `FileManagerPanel` 的每服务器文件缓存没有淘汰策略，保留到组件卸载；下载进度组件也保留完成记录。它们是后续规模/长会话验证重点，本轮未测量其实际长期增长率。
- Python 的直接 terminate/runCommand 辅助路径、旧 transfer store 等需先证明可达性，再决定是否作为线上资源问题。

## 运行观测与适用边界

本机同时有安装版 `D:/tool/lyshell/LyShell.exe` 和本 checkout 的 Electron 进程，两者不能混为同一构建。`runtime-snapshot.json` 留存一次约 3 秒的只读进程采样，包含两棵进程树及后代；没有输出命令行或凭据。

工作集可能跨进程共享，不能简单相加当作独占内存；I/O transfer 计数含管道/网络，不是磁盘物理吞吐。短采样没有用户动作标签，不能用来声称某模块在空闲时泄漏。源码问题的可重复证据见各夹具，正式实例未被重启/更新，也没有被注入压力任务。

本次按 R01 → R02/R03 → R05/R06/R07 → R04/R08/R09 → R10 的依赖关系组织，独立路径在不重叠文件的条件下推进。R02/R03 由原生 Harness 实现后，Codex 亲自检查并补上取消间隙；所有判断、代码审查、图形界面验证和最终集成均由 Codex 完成。原始复现材料保留，修复后结果见 `tmp/module-resource-audit/after-probe-results.json`，完整验收见后续章节。


## 专项修复最终验收（2026-10-21）

| 检查 | 结果 | 日志/证据 |
| --- | --- | --- |
| 最终完整 Vitest | **236 文件通过、1 文件跳过；2962 用例通过、5 跳过；退出码 0** | [PowerShell 2 Worker 完整日志](../tmp/module-resource-audit/fix-final-vitest-stable.log) |
| 最终类型检查 | 通过，退出码 0 | [typecheck](../tmp/module-resource-audit/fix-delivery-typecheck.log) |
| 最终生产构建 | 通过，退出码 0；独立 regex Worker 资源已生成 | [build](../tmp/module-resource-audit/fix-delivery-build.log) |
| 修改文件 ESLint | 0 错误、98 警告；警告含已有 any/Hook 项及新增测试 mock 类型 | [ESLint](../tmp/module-resource-audit/fix-eslint.log) |
| 差异空白检查 | git diff --check 通过 | CRLF 转 LF 提示保留在 fix-diff-check-warnings.log，不是代码错误 |
| 反向资源复现 | R01/R02/R04/R05/R06/R08/R09/R10 的同类反例已收敛 | [数值 JSON](../tmp/module-resource-audit/after-probe-results.json)、[脚本](../tmp/module-resource-audit/after-probes.cjs) |
| R03 传输峰值与取消 | 40 混合任务全局峰值 4、每 endpoint ≤2；13 项管理器回归含首个微任务前取消 | [独立传输反证 JSON](../tmp/module-resource-audit/after-transfer-results.json)、[Codex 集成测试](../tmp/module-resource-audit/r02-r03-codex-tests.log)、[Harness 实现报告](../tmp/module-resource-audit/r02-r03-implementation.md) |
| 浏览器真实 Worker / 分页 | 正则约 501ms 超时，UI tick 24–25；960 KiB 高亮降级 1 节点；205 条历史分页正确 | [正则界面证据](../tmp/module-resource-audit/regex-ui-proof.png)、[历史末页](../tmp/module-resource-audit/history-ui-proof.png) |

最后一轮全量命令为 `npm run test -- --maxWorkers=2 --minWorkers=1 --testTimeout=15000`。修复前基线为 2899 个通过用例；此次多出 63 个通过用例。没有跳过或移除失败测试来取得通过。

保留异常与修正轨迹：原生 Harness 首轮完整验证有 2 个失败（市场命令 spawn 和新 DOM 收集时间门限）。市场命令失败与基线出现的 Harness shell 差异相同，PowerShell 单独复跑通过；DOM 门限问题由 Codex 修正为有容量上限的分片收集，相关测试复跑通过。PowerShell 的 4 Worker 复跑另遇 Windows fail-fast（-1073740791），日志保留；改为 2 Worker 后完整通过，没有修改市场源码/测试或降低验收内容。对应日志为 `fix-final-vitest.pass1.log`（原生首次两项失败）、`fix-final-vitest.log`（原生再次复跑，仅市场 spawn 失败）、`final-failure-recheck.log`、`fix-final-vitest-powershell.log` 和最终 stable 日志。

本轮完整测试、typecheck/build、资源夹具及真实浏览器检查均针对 checkout 源码。正式安装版与真实远端未重启、替换或施压；未验证正式 Electron 实例/真实 SSH 的长期工作集曲线。各项已知限制见对应 R 条目，规模观察和旧 file-store 不可达路径没有被扩成修复任务。

前序终端资源修复完整保留。R05 在已有 local 生命周期/背压改动上追加异步 PATH 与取消代次，R04 在已有 IPC/preload/locale 改动上追加历史分页；未 reset、checkout、commit 或发布任何文件。浏览器夹具只含模拟记录；原生 Harness 未发生待批准操作，未切换 PetLink、模式、权限或连接配置。


原生通道收尾：R02/R03 实现任务在同实例/同会话权威确认 completed 后检查交付并 disconnect。后续原生验收任务的两轮测试、类型检查、构建均已结束，日志已核对；其后继续追查已知 shell 差异的额外检查由 Codex 取消，已在同实例确认 taskState=cancelled、status=idle，并 disconnect（不是把取消当作验证成功）。检查未发现剩余匹配的验证进程；无源码修改副作用。正式最终结果由 Codex 的 PowerShell 全量成功复跑与最后 typecheck/build 提供。临时浏览器页签及独立 Vite 夹具服务已关闭，未停止共享后台。
