# LyShell 保存区与内存方案实施记录

日期：2026-10-28。工作分支：`codex/shelf-memory-p0`。工作目录：`C:/Users/69534/.codex/worktrees/shelf-memory-p0/LyShell`。基线为 `34d64dc3eed8bc7c53a03775475808545340d72e`；输入为 [完整实施方案](LyShell_完整实施方案_v1_20261028.md)。修改仅在独立 worktree，尚未合入原目录或打包发布。

## 已落地的行为

| 范围 | 实现与约束 |
| --- | --- |
| P0 | 实际 Electron/xterm/Node 能力、分进程内存基线、20/100 条保存记录、固定日志语义与容量对照，见 [冻结基线记录](shelf-memory-p0/README.md) |
| 启动与分类 | 主进程生成 bootId/scopeId，固定启动快照并原子归入 Archive；renderer 重载不重新归档。本次新建任务不并入旧批次。保存失败保留真实分类并进入 blocked，提供权威重试。首次读取损坏时也保留启动标识用于恢复 |
| 单个／全部激活 | 固定点击时 ID 与 revision，最多 100 条；只修改分类及必要排序。逐项 moved/alreadyTasks/conflict/missing/failed，原子写失败全部待改项 failed。256 项请求去重；去重淘汰后仍校验版本。分类重试只读取并重试失败项 |
| 界面意图 | 分类结果始终同步；切栏、选择或关闭后的迟到结果不回抢界面。单个激活定位目标；全部激活不逐页聚焦，布局后只对本批当时可见网页产生一次需求。滚动、缺图和组件挂载不补发恢复 |
| 侧栏 | Archive 静态；实时策略仅 Tasks / Static。点击保持展开，区域外 350ms 收起，保护编辑、IME 事件、键盘导航、拖动及菜单。固定模式不自动收起；显式关闭不改变模式偏好。100 张卡片独立于缓存和真实实例，均可滚动访问 |
| 展示所有权 | 延续常驻终端与 webview，主区优先；主区有需求时侧栏不接管该实体。窗口隐藏立即撤销侧栏需求；侧栏撤权不取消主区需求。插件和 Harness 不接管其私有生命周期 |
| 恢复 | 应用级真实导航并发 1、待处理 16、自动恢复驻留 4。显式主区打开可越过自动驻留数，但仍排队。超时只结束 UI 等待，不归还实际创建／导航许可。同资源合并需求；已产生实体失败后仍复用，不另建 guest。主区显式打开先显示加载状态，再完成交接 |
| 创建许可 | WebTabLayer 先向 main 申请一次性 permit，再挂载 webview。main 校验宿主、保存记录和地址，在 will-attach 消费许可；强制 sandbox preload 的 nonce 握手与原生 did-attach guest 配对，拒绝裸 webContents ID、跨窗口与重复许可。仅原生 destroyed 证据释放实例，未知创建保留槽位 |
| 首帧 | 尺寸、导航与需求代际校验；确认画面前禁止原生元素的指针和键盘输入。5 秒呈现超时提供“显示当前页面”，不重复导航。主区回退入口靠左，侧栏仍展开时也可访问 |
| 预览 | 一个 500ms 可见时钟；原生采集并发 1、队列 16、5 秒看门狗。看门狗不提前释放底层在途。原图预检上限 4,194,304 像素，输出最大 960×600；不调整网页视口来补图。尺寸变化稳定 200ms 后采集，旧显示租约保留；持续失败退避至最多 30 秒 |
| 图片／Canvas | 编码软目标 16MiB、准入 24MiB；解码与终端 Canvas 共用软目标 64MiB、准入 96MiB；临时预留 64MiB，最多 100 帧。计入新旧帧同时存在的峰值；离屏停止绘制并归还显示租约、清零 Canvas。绘图异常也释放真实像素。兼容截图 API 不再用已完成 Promise 另存 DataURL |

以上预算是应用可管理分配的记账和准入阈值，不是操作系统进程内存的硬上限。分类成功、导航成功和画面可交接分别表达，不推断 shell 或 Agent 已完成。

保存文件仍为 version 1，复用 `revision` / `archivedAt`；没有新增数据库、磁盘图片缓存或 Rust 依赖。没有扩大终端历史保留量，没有自动重放 shell、POST、Agent 或审批。

## 安全门槛与停止条件

- **普通网页自动深睡保持禁用。** P0 在 Electron 43.7.11 真实验证中，`close({waitForBeforeUnload:true})` 仍销毁拒绝关闭的 guest。生产 `safeCloseSupported=false`，没有安全适配器白名单；unknown/blocked 均保活。生命周期内核实现了两阶段保存、复检、拒绝关闭／超时、迟到销毁和新需求撤销，但没有通过不安全的 close 路径实际释放用户网页。不能把 GET 视为 safe。
- **Rust P3/P4 未进入生产。** OutputBuffer 的同步读取及原上限仍被既有接口使用，未确认可独立迁移的冷历史。按方案停止门槛保留 TypeScript 路径；固定语料 431172 次语义检查无不一致，不能将派生缓存 heap 差值当作应用总内存收益。
- **不宣称显著内存收益。** [真实预览前后对照](shelf-memory-p0/preview-compare-report.md) 固定本地页面、操作数、原生采集数及输出图摘要。总私有内存与采样峰值单列，JS heap 不叠加；小幅轮间差异不足以证明收益。

## 验收证据

- `npx vitest run src --maxWorkers=4 --minWorkers=1 --testTimeout=15000`：334 文件通过、1 文件跳过；4194 项通过、6 项跳过。后续相关领域回归 32 文件／369 项通过，取消保存后的驻留、别名和错误引用清理又补测 18 项通过；首帧、尺寸稳定、代际防 ABA 与未确认创建关闭许可均有回归。`examples/` 依赖真实外部服务，不作为源码单元回归。
- `node --test scripts/shelf-memory-p0/history-benchmark.node-test.cjs scripts/shelf-memory-p0/history-fixtures.node-test.cjs`：25 项通过；采用 `.node-test.cjs` 避免被 Vitest 误收集。
- `npm run typecheck`、`npm run build` 通过；全部修改及新增 TypeScript 文件 ESLint 0 错误，13 条已有 handlers.ts 的 `no-explicit-any` 警告；`git diff --check` 通过。
- [完整应用结果](shelf-memory-acceptance/results.json)：20、100 条记录各 3 个独立档案进程。每轮验证启动全 Archive、重载同 boot 不重新归档、全部激活、自动驻留 4、显式打开后 5 个 guest、滚动与 Static 不预加载、原生附着握手、主区复用、视口吻合和中文／emoji 输入内容保留。每轮 100 次 list 与 100 次 activate IPC。原始分进程采样为同目录 gzip。
- 截图由 Codex 检查：百张 Archive 卡片、Tasks 真实页面、深色主题、900px 窗口；保留原白色保存区设计。图在 `tmp/shelf-memory-acceptance/{archive,tasks,dark,narrow}-100-1.png`。
- LyShell 原生工作任务提供后端、预览与生命周期实现／测试辅助；Codex 亲自检查所有代码、修正边界、接入、GUI 截图与最终验证。断线前任务没有被冒称完成；恢复后依据新后台身份、实际文件和新任务终态核实。

完整应用测试使用独立 appData/userData、测试专属直连 partition、回环 fixture 与固定测试可见性；没有读取用户账号、表单或正式浏览档案。启动与全部激活每规模仅 3 个样本；IPC 各 100 样本不等于鼠标输入延迟的 100 样本。

## 回退

| 开关 | 关闭方式与效果 |
| --- | --- |
| 启动归档 | 启动进程前设 `LYSHELL_SHELF_STARTUP_ARCHIVE=0`，不再执行新启动归档；不反转已提交分类 |
| 原生创建协调器 | 启动进程前设 `LYSHELL_SHELF_BROWSER_LIFECYCLE=0`，退回原 webview 创建方式；不会自动关闭既有实例 |
| 预览 | renderer 启动前将 localStorage 的 `lyshell.taskShelf.features.v1` 设为 `{"previews":false}`；保留静态卡片及主区入口 |
| 侧栏自动恢复 | 同一开关对象设 `{"sidebarRestore":false}`；单个／全部分类仍可用，保留主区显式打开 |
| 本次运行静态展示 | 保存区的 Live view 选择 Static；不要求重启，也不反转分类 |
| 深睡／Rust | 当前没有生产开启入口，保持禁用 |

以上仅记录可用关闭路径，没有改动用户当前进程的设置、模式或共享后台。

## 尚未覆盖的发布验证

真实操作系统中文 IME、多显示器／混合 DPI、真实上传／通话等站点流程未人工验证；现有自动化覆盖 composition 保护事件及中文／emoji 文本保留。30 秒／5 分钟、保护 TTL 和关闭竞态主要由可控时钟单元测试覆盖，没有宣称实测过真实站点五分钟后的安全关闭。设计上下文工具提示 `.impeccable/design.json` 与 DESIGN 有既有漂移，本次没有修改设计侧车。

因此本记录确认独立 worktree 中的代码实现和上述自动化结果，不将其描述为已发布安装包或通用网页休眠能力。
