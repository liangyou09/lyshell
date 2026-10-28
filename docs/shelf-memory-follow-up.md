# 保存区内存优化：后续工作与审查交接

日期：2026-10-28。本页记录下一步路线和本次审查任务，未完成项不等于已发布能力。

## 当前状态

- 审查对象：`C:/Users/69534/.codex/worktrees/shelf-memory-p0/LyShell`，分支 `codex/shelf-memory-p0`，基线 `34d64dc3eed8bc7c53a03775475808545340d72e`。
- **改动尚未提交。** 必须同时检查 tracked diff、全部 untracked 源码／测试／脚本／文档；仅运行 `git diff` 会漏掉新增模块。
- 主 worktree：`D:/workspace/claude/LyShell`，分支 `main`。交接时 HEAD 为 `70683eaf4fd7c377a9b8dd8a788ad523d0189365`，工作区干净；进入集成阶段必须重新核对，不能假定仍无其他改动。
- 主分支跟踪 **`lyshell/main`**，该 remote 是 `https://github.com/liangyou09/lyshell.git`。`origin` 指向另一个仓库 `https://github.com/liangyou09/LyShellMain.git`，不要误推。
- main 在本 worktree 分出后新增了 `70683ea`，与保存区、快捷键、网页终端和恢复边界重叠。必须看它的实际差异并保留其合法新行为，不能用旧 worktree 整文件覆盖 main。
- [实施记录](shelf-memory-implementation.md)、[完整方案](LyShell_完整实施方案_v1_20261028.md)、[P0 基线](shelf-memory-p0/README.md)、[应用验收](shelf-memory-acceptance/results.json)、[预览前后对照](shelf-memory-p0/preview-compare-report.md)提供背景；报告与通过的测试都不能代替新的代码审查。

已实现启动快照归档、单个／全部激活、界面意图隔离、主区优先的实例复用、创建许可和原生附着核验、恢复队列、首帧输入保护、预览时钟／预算／退避及回退开关。自动网页深睡和 Rust 均未启用。当前没有显著总内存收益的结论。

## 后续优先级

| 顺序 | 工作 | 完成依据 |
| --- | --- | --- |
| 1 | 独立审查现有未提交改动，修正并复审；与最新 main 整合后再审 | Codex 亲自逐轮审查；无已知可操作问题，必要测试通过；主 worktree 集成正确，提交并正常 push |
| 2 | 补真实交互与长时间运行验收 | 操作系统中文 IME、键盘／菜单／拖动／原生 guest 边界；多显示器、缩放和混合 DPI；锁屏／休眠唤醒；至少 100 轮开合与恢复，实例、租约、队列和引用回稳 |
| 3 | 补真实业务和混合负载 | 终端持续输出、ACK／背压、后台 Agent 与审批、POST、登录变化、离线、上传、音视频／通话、DevTools；验证零重复执行、零误销毁，错误层级正确 |
| 4 | 确认瓶颈并补性能证据 | 同场景、同成功工作量，至少三轮；实际输入／恢复 p50/p95、长任务和帧时间、进程总私有内存稳态与峰值；低内存设备及采样器开销；分类耗时与可交互耗时分开 |
| 5 | 继续普通网页生命周期能力 | 先验证尊重 beforeunload 的可撤销关闭路径；再做应用受控保护适配器、安全覆盖率、保存后复检、销毁证据、恢复元数据和有界滚动恢复。安全路径无法证明时继续保活 |
| 6 | 依据数据优化预览与诊断 | 评估受校验 main IPC 的 stayHidden 路径、事件驱动采集、Blob/Object URL 的 CSP／IPC／revoke 成本；补所有者产生的有界原因／预算诊断。达到瓶颈再实施，不放宽截图像素和队列上限 |
| 7 | 条件性历史后端／Rust 原型 | 先解决下节数据来源和调用契约；用相同负载比较优化 TS/Node、Node 异步压缩和 Rust。只有证明额外净收益才考虑生产迁移 |
| 8 | 发布验收 | 实际安装包的加载与升级回退、功能开关、未覆盖平台和支持页面范围写清楚；不能把源码构建通过描述成安装包已验证 |

这些是后续路线；本次新审查会话的直接目标是审查、修复、整合和推送现有改动，不自动扩张为实现全部后续功能。已知缺陷和虚假的完成声明必须在合入前修正。

## 网页深睡的前置条件

P0 在 Electron 43.7.11 实测：调用 `close({waitForBeforeUnload:true})` 后，拒绝关闭的 guest 仍被销毁。因此生产 `safeCloseSupported=false`，没有受控 safe 提供方，不得为了降低内存而强杀、React 先卸载、强制放行 beforeunload 或将 GET 当作安全证明。

后续需验证安全关闭和取消的真实能力；保护提供方必须可信且绑定实例／导航／保护版本。保存 taskId、resourceId、最终 URL、原 partition、zoom、尽力获取的滚动位置、格式版本及时间，提交成功后复检，再等原生 destroyed。恢复只重建合格的 GET 页面；表单、sessionStorage、POST、令牌、WebSocket 不承诺通用复活。

## Rust 实际需要引入什么

当前既没有 Rust 生产依赖，也没有完成 Rust 原型；TS 的预览对照不能证明 Rust 有无收益。

1. **先明确冷历史范围。** 封块不等于冷数据。OutputBuffer 仍被 getRecentLines/getOutputSince/sendAndWait 等同步链读取；需要找到独立冷范围，或单独设计内部异步调用链，保持 MCP 字段、UTF-16 游标和原保留边界。不能同步等待 Worker，也不能扩大保留量制造压缩对象。
2. **引入有界 history-store 契约。** 主进程持有权威块；接口覆盖 open、appendSealedBlock、readRange、trimBefore、clear、stats、close。epoch、seq、watermark、内容身份与读取快照控制迟到提交；trim/clear/close 不复活旧数据，不影响 PTY。
3. **引入一个共享 codec Worker。** Rust addon 只在 Worker 加载，首轮并发 1、描述符从 16 起；按条目及字节限制工作区、输入、输出、索引、解码缓存、读快照和临时副本。实时终端输出不等待压缩，队列满退化为 raw。
4. **引入可独立解码的块格式。** 原始 UTF-16LE 码元，初始块 64KiB 字节；头部含版本、codec/参数、epoch/seq、起始码元、码元数、原长、编码长、checksum。保留孤立代理项，校验整数边界、原长和解压上限；无压缩收益保存 raw。
5. **先做隔离原型和公平对照。** 比较原实现、优化 TS/Node、Node 异步压缩、Rust，固定算法／级别／块大小／保留量／队列／缓存。原型不连生产 PTY、xterm 或持久任务；测应用总私有内存、峰值、延迟、固定成本、Worker 故障和 Electron 安装包加载。
6. **再决定依赖与生产迁移。** 原型范围确认后再安装工具链、引入原生构建及分发配置。每种生产编码都有不依赖 Rust addon 的兼容解码；关闭新编码后旧块仍可读，迁回须有界。若需要原生崩溃隔离，使用进程边界并重新测成本，Worker 不能保证隔离进程级崩溃／OOM。

未确认冷数据来源时停止 P4；Node 已达到目标且 Rust 无额外净收益时结束试点。Rust 长期持有唯一历史、搜索／ANSI 清洗和新增磁盘历史均属后续独立范围。

## 新会话审查与交付要求

用户已明确授权：审查该 worktree 尚未提交的代码，有问题就改，改后再次审查，直到没有已知问题，合入主 worktree，再提交并 push。正常整合、解决冲突、提交与 push 不需要再次请求相同授权。

1. 使用 Codex 亲自做全部代码审查，禁止交给 LyShell、PetLink、子代理或第三方。按 AGENTS 可使用原生助手执行限定实现修正／测试，但发现、核验问题和最终判断属于 Codex。遵守真实审批，不代答待审批操作。
2. 新会话默认项目目录是主 worktree；**审查阶段每个目录相关命令必须显式设置 workdir 为上述现有 worktree**。不要新建空 worktree、切分支、reset/clean、丢弃未提交文件或转移／归档现有 worktree。
3. 检查完整 tracked/untracked 改动、调用链、所有权、并发／取消／超时、代际防 ABA、原生附着信任、截图及 Canvas 分配释放、真实输入保护、分类原子性／去重／重试、回退和现有行为兼容。修正后从最新差异重新审查，不以测试通过等同无问题。
4. 每轮记录具体问题、证据、修改及验证。持续迭代到新一轮无已知可操作问题；不能将发现的问题写入“以后再做”然后合入，也不能宣称数学上证明零缺陷。
5. 集成前重新核对 main、upstream、工作区及在途其他工作。若有无关未提交改动，保留并隔离，禁止清理或顺手提交。检查 main 新增提交，解决语义冲突，并复审集成结果。
6. 可用已审查的 feature 分支提交作为 Git 合并载体；最终主 worktree 的提交／push 在集成复审及验证后执行。提交采用仓库中文 Conventional Commit，正常推送配置的主分支上游；禁止 force push 或绕过权限。远端变化则先整合并复核。
7. 有针对性验证、typecheck、ESLint、build 和必要真实 Electron 验收；现有核心参考命令与结果见实施记录。未做的 IME／DPI／安全关闭等人工门槛如实注明，保持相关危险能力关闭。
8. 输出审查轮次／修正摘要、最终主分支 commit、实际 push remote/ref 及确认结果、剩余不阻碍合入的验证限制。提交后核对内容，push 后读回远端 ref；没有实际确认不能称已推送。

`tmp/` 为忽略的交接／实验区，不默认加入提交；需要保留的基线、原始结果和复现脚本已放 docs/scripts。检查可复现性、敏感信息及提交范围，不能把私密连接包、凭据、个人浏览档案、node_modules junction、dist/release 或原生任务回执顺手提交。
