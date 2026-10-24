# 项目现场与继续工作（P0-A）

实现日期：2026-10-23。当前保留 LyShell 名称，仅覆盖 P0-A。

## 使用

1. 在设置中维护现有共享目录 / worktree 预设；本功能不会创建第二套项目配置。
2. 打开项目文档、网页和终端，调整标签及分屏。在底部项目栏，或 Agent / Codex / Claude 列表的项目旁，点击 **保存现场**。
3. 下次启动，点击项目旁的 **继续上次工作**，直接打开这个项目最新的保存点；底部项目名可搜索切换项目。**历史** 默认只列出所选项目 / worktree 的保存点，需要时可切换全部项目。
4. 文档和安全网页重新打开；终端与 Agent 变为 **待启动** 入口。点击目录终端、普通启动或 CLI 历史选择器后才会启动进程。

现场手动保存，全局最多保留最近 30 个保存点。浏览、切换项目、恢复或关闭应用不会自动覆盖保存点。现有全局分屏形状仍按原规则自动保存，与手动项目现场分开。

恢复优先定位已经打开的匹配资源，重复点击、保存后立即继续、或同一保存点的并发恢复不会复制页签与分屏，也不会重复启动进程。已打开的终端保持原位置和状态；恢复入口显式启动后，实际终端替换原入口。启动已接受但定位失败时，只重试定位同一个终端。

若只关闭了部分已恢复页签，继续会定位仍打开的资源；全部关闭后可以重新恢复。此前读取失败的资源修复后可再次恢复补齐。只有需要新增的有效资源才加入布局：当前已有内容时放在右侧，空界面直接使用保存布局。恢复本身不关闭当前进程。

底部栏仅在无可见页签的首页显示；打开终端、文档、网页或待启动入口后隐藏，全部关闭后重现，全局命令面板打开时也隐藏。工作中的保存、继续与历史操作使用项目列表旁的入口，历史浮层仍可打开并查看提示。首页底栏默认只显示项目名、最近保存时间、操作和简短状态。完整路径、启动项引用、逐项失效提示和恢复范围说明按需展开；待启动页签与正文显示当前配置中的可读名称。启动按钮固定在入口顶部，正文独立滚动，上下分屏仍可操作。

## 身份与恢复范围

项目引用 = 共享目录预设 ID + 规范化目录目标 + isolation / worktreeKey。主进程复用 `codeWorkspaceTargetKey`、`resolveWorkspaceCwd` 和 `listWorktreeKeys`；renderer 复用启动树的 `workLauncherTargetKey`。Windows 路径忽略大小写并统一分隔符。worktree 通过现有 Git 登记定位，恢复不会创建或迁移 worktree / 分支。

保存内容：

- 所选目录的本地终端和 Agent 启动项引用。依据终端的启动目录匹配，保存类型与 ID，不保存命令或会话配置；恢复后始终为待启动入口。
- 所选项目实际目录内的本地只读文档路径。恢复时重新读取，主进程检查扩展名和真实路径边界，现有文件读取 IPC 继续执行敏感路径与大小限制。
- 当前尚未归属项目或属于本项目的安全网页入口。首次保存后为这些页签记住运行期项目归属，保存另一项目时不带走它们；恢复的页签同样带归属。
- 各叶子的标签顺序、活动标签、活动分屏、分屏方向与比例。终端引用和文档 / 网页按原混合标签顺序保存。

不保存终端缓冲区、进程状态、任务、历史命令、SSH / SFTP 连接、文档内容或编辑状态、网页标题、表单、cookie 或完整网页运行状态。远端 / 内置文档、插件专属页签、MCP 审计和 DeepSeek 官方工作台不纳入项目现场。

网页采取保守白名单：仅 HTTP(S)，拒绝 userinfo、任何查询参数或 hash、本机回环后台、常见认证 / 回调 / 一次性入口及长随机路径段；POST 入口不保存。被跳过的网页逐项给出不含敏感 URL 的提示。普通网页仅重新访问入口，登录或页面内容仍取决于当前浏览器环境。

## 数据与失效规则

主进程原子写入 `{userData}/config/project-scenes.json`。文件和每条现场均带 `version: 1`；现场含 `id`、`savedAt`、`target`、保存时解析的 `directory`、`root` 和 `activeLeaf`。共享解析器逐字段构造白名单对象，拒绝超限布局、非法 worktreeKey、未知版本及不安全网页。损坏或未来版本的文件报错并保留，不静默清空覆盖。

- 预设被删除：不会按名称猜测、重新绑定或落到默认目录。
- 目录移动、预设改绑、worktree 改变：视为原引用失效，不恢复为另一个项目；用户可修复原配置后重试，或对新目标另存现场。
- 文档缺失、读取失败、启动项删除或改绑、CLI 不在 PATH：分别显示失效项，恢复其余有效资源；保存点保持不变，可在修复后再次恢复。
- 即使目录预设失效，原保存目录中仍存在且符合边界的文档及安全网页仍可恢复。
- 目录与启动项在显式启动前再次校验，恢复接口不调用启动器。

新增 `project-scene:request` IPC，包含 list / inspect / save / restore / describe / launch。describe 只读取当前项目与启动项名称，不持久化名称或配置；launch 返回新终端标识供原入口定位，重试定位不再次调用启动器。仅主窗口主 frame 可用；handler、validator、preload、共享类型及 renderer 消费端同步实现。renderer 不导入 Node API。

## CLI 续接边界

本机核实：Codex `0.163.0`、Claude Code `2.1.309`、dsh `0.2.1-rc.2`、dsh-tui `0.14.0`。依据本地 `--help` 和安装包文档，未读取对话内容。原始文字盘点在 `tmp/project-scene/cli-capabilities.md`。

| 启动项 | 本阶段入口 | 边界 |
| --- | --- | --- |
| Codex | `codex resume` 历史选择器 | 默认按 cwd 过滤；不加 `--last` / `--all`，不自动选定旧对话。 |
| Claude | `claude --resume` 历史选择器 | 由 CLI 显示并由用户选择历史；选择器作用域未由本机帮助确证，不宣称仅含本项目。 |
| DeepSeek | 普通启动；历史在官方界面选择 | `dsh-tui --resume` 不带 ID 使用全局历史，故本阶段不提供；原生控制权不跨后台重启恢复。本机 TUI 与 dsh 存在版本不兼容，命令在 PATH 不代表可正常使用。 |
| 自定义 Agent | 普通启动 | 未声明可靠续接协议，不猜测参数，不把任意命令解释为对话续接。 |

本阶段不采集 / 保存 CLI 会话 ID，不承诺准确绑定特定旧对话。明确区分恢复界面、打开 CLI 历史选择器和真正选中续接。普通启动创建新进程，真实进程状态仍由现有连接管线管理。

## 验收记录

2026-10-24 提交前复审：Codex 亲自审查全部未提交实现，并修复三项启动边界问题。启动中状态和已接受回执改为跟随运行期入口，拖分屏重挂组件后不会再次启动；IPC 回执丢失视为结果未知，先检查终端列表，不盲目重发；配置读取期间先到的退出/错误状态暂存并在建终端条目时消费，避免已退出进程被补成连接中。回执和状态缓存均不写入项目现场；终端删除时清理缓存。新增回归覆盖重挂、在途请求、未知回执、快速退出及清理。

本轮冻结源码后的全量验证：`npm run test -- --testTimeout=15000 --maxWorkers=4 --minWorkers=1` 通过，**270 个文件通过、1 个跳过；3421 项通过、5 项跳过，退出码 0**。类型检查、构建、全量 lint（0 错误、115 条既有警告）和差异检查通过。默认并发的一次测试运行进程异常退出，限制 worker 后完整重跑成功。原始日志为 `tmp/review-final-tests-bounded.log`、`tmp/review-final-build.log`、`tmp/review-final-lint.log`。LyShell 原生 Harness 独立执行后端 93 项基线测试，已核对原实例/会话/任务的 completed 终态及实际日志后断开；全部代码审查仍由 Codex 完成。本轮没有重复下述历史 GUI 和真实 CLI 续接验收。

2026-10-24：按用户反馈将底栏限制在无可见页签的首页。33 项相关 UI 测试、类型检查、构建及修改文件 lint 通过；独立构建应用验证首页显示、打开现场后底栏消失且工作区伸展到底部、项目旁历史仍可打开及回焦、关闭全部页签后底栏恢复。本次为局部显示调整，未重跑上一轮全量测试。

Codex 亲自检查全部代码和真实 GUI；原生 Harness 承担 CLI 文字盘点、测试执行及重复恢复机制的实现，各任务均以同一后台实例 / 原会话 / 原 taskId 确认 completed 后 disconnect，未自动批准操作。Codex 审查实现后补齐边界修正，并独立完成最终全量测试。

- 定向测试覆盖：白名单与敏感 URL 排除、真实文件落盘与重新实例化、跨项目引用、真实 Git 的两个 worktree、目录移动、预设删除、失效文档 / CLI、混合标签顺序、布局合并、历史选择器命令和禁止恢复时启动。
- 独立 Electron 档案真实流程：保存 Agent / 网页 / 文档与上下分屏，正常退出、重开同一档案，再触发真实 React 按钮回调恢复。恢复后有效资源顺序和布局一致，进程数为 0；现场磁盘文件不含模拟 token、文档内容或命令。
- 显式打开 Codex 历史选择器：实际启动命令为 `codex resume`，连接状态 connected；主动停止后为 disconnected。未选择真实旧对话、未发送模型任务，不宣称已完成对话续接验证。
- 独立档案删除文档与目录预设后，逐项报告失效，网页仍恢复；显式启动已删除项目被拒绝，没有串用 Project B。
- 桌面辅助工具能截图，输入动作在本环境未生效；按钮行为由真实应用内集成脚本触发并断言，GUI 由 Codex 亲自查看。记录此限制，不将其写成鼠标点击验收通过。

最终构建的 `file://` renderer 已独立重开并通过相同恢复按钮检查，文档重新读取、待启动入口和 CLI 边界说明均可见；截图在 `tmp/project-scene/restored-built.png`。首次构建验收脚本因未等待文档延迟渲染而过早断言，补齐等待后检查通过，未为此修改产品代码。

体验改进后冻结源码完整重跑：**268 个文件通过、1 个跳过；3351 项通过、5 项跳过，退出码 0**。`npm run typecheck`、`npm run build`、修改文件 lint 与 `git diff --check` 通过；lint 有 13 个既有 `no-explicit-any` 警告，新增文件无告警。最终报告及原始日志在 `tmp/project-scene-refine/verified-report.md`、`verified-full-tests.log`；第一轮功能验收仍保留在 `tmp/project-scene/`。

改进验收覆盖同一保存点并发、反复继续、保存后继续、已关闭资源、修复缺失资源、网页导航后的原入口归属、隐藏标签定位、终端替换原入口，以及启动接受后只重试定位。Codex / Claude 实际面板均有共享项目及 worktree 的独立入口。真实构建应用的 1200×800 浅色、920×660 深色界面均已查看；后者菜单完整位于窗口内，启动按钮仍在分屏顶部。项目切换、worktree 精确恢复、第二项目终端的实际目录和原分屏位置均通过应用内脚本验证，停止后标签显示空闲、无连接中指示。

过程中的原生执行环境曾出现既有 Market 进程测试失败，PowerShell 独立重跑及最终完整运行均通过；另一轮运行与新增 URL 测试重叠，缓存旧实现产生过渡失败，冻结源码后的完整重跑已排除。原始失败日志保留，未改无关 Market 代码。CLI 真实旧对话续接、DeepSeek TUI 正常启动及跨平台 GUI 仍未验证。

## 改动文件索引

| 层级 | 文件 |
| --- | --- |
| 数据与校验 | `src/shared/project-scene.ts`、`src/shared/types/pane.ts` |
| 持久化 / 资源检查 / 显式启动 | `src/main/storage/project-scene-repository.ts`、`src/main/harness/project-scene.ts`、`src/main/harness/project-scene-launcher.ts` |
| IPC 全链路 | `src/main/ipc/handlers.ts`、`src/main/ipc/validation.ts`、`src/preload/index.ts` |
| 捕获与恢复 | `src/renderer/stores/project-scene.ts`、`project-scene-ui.ts`、`project-entry-launch.ts`、`pane-store.ts`（仅注释）、`overlay-kinds.ts` |
| UI | `src/renderer/components/Layout/ProjectSceneBar.tsx`、`ProjectEntry.tsx`、`ProjectScene.css`、`useSceneEntryLabel.ts`，同目录 `MainWindow.tsx`、`PaneView.tsx`、`PaneTabBar.tsx`、`WorkspaceLauncherTree.tsx`、`HarnessPanel.tsx` |
| 测试 | `src/shared/project-scene.test.ts`、main 的 `project-scene.test.ts` / `project-scene-launcher.test.ts`、renderer 的 `project-scene.test.ts` / `project-entry-launch.test.ts` / `pane-store.overlay-contract.test.ts`、`ProjectSceneBar.test.tsx` / `ProjectEntry.test.tsx` / `HarnessPanel.test.tsx` |
| 说明 | 本文、`docs/ai-development-workbench-plan.md`、`DESIGN.md` 的局部补充 |

`tmp/project-scene/` 与 `tmp/project-scene-refine/` 仅为本地验收脚本、独立档案、截图和日志，不随应用发布。计划文档随实现保留并更新。
