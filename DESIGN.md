---
name: LyShell — Codex / Claude 工作区面板
description: 项目索引式工作区启动面板：全宽条目、章节色标、常显启动列
colors:
  launcher-ground: "var(--bg-base)"
  launcher-surface: "var(--bg-rack)"
  launcher-hover: "var(--bg-slot)"
  launcher-selection: "color-mix(in srgb, var(--amber) 12%, var(--bg-base))"
  launcher-ink: "var(--text-rack)"
  launcher-secondary: "color-mix(in srgb, var(--text-rack) 76%, var(--launcher-ground))"
  launcher-accent: "var(--amber)"
  project-color: "color-mix(in srgb, hsl(var(--project-hue) 36% 56%) 65%, var(--launcher-ink))"
  project-color-light: "color-mix(in srgb, hsl(var(--project-hue) 30% 36%) 75%, var(--launcher-ink))"
typography:
  system:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei', sans-serif"
  project-label:
    fontSize: "16px"
    fontWeight: 700
    lineHeight: "20px"
  workspace-name:
    fontSize: "13px"
    lineHeight: "20px"
  workspace-summary:
    fontSize: "11px"
    lineHeight: "16px"
  controls:
    fontSize: "12px"
  permission:
    fontSize: "10px"
  dsh-launch-label:
    fontFamily: "'Dsh Launch', 'KaiTi', 'STKaiti', cursive"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: "28px"
  dsh-launch-script:
    fontFamily: "'Dsh Launch Script', 'Dsh Launch', cursive"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: "36px"
  notification-heading:
    fontSize: "18px"
    fontWeight: 650
  notification-project:
    fontSize: "14px"
    fontWeight: 650
  notification-status:
    fontSize: "15px"
    lineHeight: "20px"
    fontWeight: 650
  notification-badge:
    fontSize: "9px"
    fontWeight: 600
rounded:
  sm: "3px"
  md: "4px"
  lg: "5px"
  shelf-grip: "2px"
  shelf-overlay: "8px"
  notification: "16px"
  notification-control: "6px"
  notification-badge: "7px"
components:
  workspace-row:
    height: "52px"
    textColor: "{colors.launcher-ink}"
  workspace-row-hover:
    backgroundColor: "{colors.launcher-hover}"
  workspace-row-expanded:
    backgroundColor: "{colors.launcher-selection}"
  launch-button:
    backgroundColor: "{colors.launcher-surface}"
    textColor: "{colors.launcher-ink}"
    rounded: "{rounded.lg}"
    height: "30px"
    padding: "5px 8px"
  launch-button-hover:
    backgroundColor: "{colors.launcher-hover}"
    textColor: "color-mix(in srgb, var(--amber) 45%, var(--text-rack))"
---

# Design System: LyShell — Codex / Claude 工作区面板

## 任务保存区局部补充

右侧任务区沿用全局 rack／slot／rule／amber 与系统字体。普通窗口不占内容宽度，在离右缘 18px 处保留 3×36px 中性灰细柄（默认 #8b929c，白底对比度约 3.14:1；悬停 #747d89），28×72px 透明热区居中于页签行下的内容区，避开最右滚动条。靠近时细柄只略微拉长、加深，不显示浮动图标或白色按钮；悬停约 300ms 后直接滑出面板，移到软件主区约 450ms 后收起，鼠标或焦点在内部时保持展开；鼠标移出整个软件窗口或切换软件时暂停自动收起，返回侧栏继续保持，返回主区后重新等待 450ms。点击立即保持展开；键盘聚焦只显示细柄焦点环，Enter／Space 打开并移焦面板，收起时将内部焦点还给入口。拖页签到边缘立即展开落区。隐藏面板设为 inert，不参与键盘导航。覆盖态使用 8px 左圆角与轻柔左投影，展开 360ms、收起 340ms 位移动画，遵循减少动态效果偏好，不改变终端尺寸；停靠态保持直角且不动画。顶端控制簇继续位于窗口右上角，任务区从 36px 页签行下方开始。宽窗口停靠展开，给主工作区保留约 1100px；窗口收窄回退覆盖，自动切换有 80px 回差。显式收起停靠面板立即释放全部宽度并切换悬停模式。面板宽度可调 240～640px，提供自动、悬停和常驻三种偏好。

按用户后续指定，任务区及其右键菜单使用固定纯白背景（#fff）、深色正文（#202020）、浅灰边线和悬停态；独立于全局深色主题。强调色沿用主题色相并收深，输入控件使用 light color-scheme。常驻只占首行下方的内容宽度，第一行最右页签条延伸到窗口右缘，窗口控制簇留白继续对齐窗口；左右、上下及嵌套分屏均沿此规则。顶部“任务”短标题与自动／悬停／常驻按钮同排。顶部使用系统无衬线字体，15px 标题、分段式自动／悬停／常驻按钮和左对齐的任务／归档／提醒页签，数量以独立小标记显示。任务卡随栏宽每排 1～5 格，常用宽度每排 2～4 格，按约 132px 可读宽度分列，只显示实际任务，不补空位；每格展示真实缩影或类型、13px 两行名称及状态，已保存但无实时绑定时明确标注已保存。没有实时小窗时保留连续白色画布，任务、归档和提醒为空时提供对应说明。360px 起下层排列显式打开的实时任务小窗；任务默认只显示保活方块，单击打开小窗，小窗放大进入主区，再次点击方块收回小窗或主区视图，仅保留方块。终端保持同一 xterm／PTY，网页保持同一 webview，通过原位固定定位改变几何，显式裁到滚动区；收起后保留最后尺寸并隐藏／inert，避免反复 resize。网页具有地址、后退、前进、刷新／停止工具条。520px 起直接在原终端或网页中输入，窄栏只读；MCP 锁定、插件归属及工作台只读限制优先。键盘只归真正聚焦且仍可交互的小窗，隐藏或撤销交互后释放归属；原生端面中的焦点和悬停保持面板展开。格子缩影仅在可见时约每 500ms 更新，不重放导航或命令。铃铛定位对应任务小窗，状态只依据新鲜官方事件，不自动回答审批。关闭已收纳页签只收起，保存失败保留现场；重启后没有实时绑定的记录仍可归档或取消保存。具体范围见 `docs/task-shelf-plan.md`。

任务生命周期（2026-10-28 更新）：Tasks 中的运行实例只属于本次 LyShell。应用退出前把任务记录整体移入归档并结束本地进程、断开连接；启动时先补归档上次未成功迁移的记录，归档条目不自动恢复运行。原有归档记录的时间与版本保留。界面不再承诺本地进程跨应用退出存活。归档页右上角提供“全部移回任务区”，逐条恢复实例并移回 Tasks，已有活动实例复用；失败项保留在归档，允许重试恢复，空归档禁用。

## 项目现场局部补充（P0-A）

仅无可见页签的首页底部显示紧凑项目栏：可读项目名、保存时间、继续上次工作、保存、历史与短状态。有终端、文档、网页或待启动入口时隐藏，全部关闭后重现；全局命令面板打开时也隐藏。项目名打开可搜索的浮层，历史默认按项目 / worktree 隔离；完整路径、范围说明及逐项提示按需展开。Agent / Codex / Claude 的实际项目列表同步提供继续、保存与历史入口；同一目录内的共享项目和 worktree 分别标明名称。底栏隐藏不影响项目旁的历史浮层。

沿用 rack / slot / rule / amber 主题令牌、系统字体与焦点样式；宽窗口底栏 43px，窄容器隐藏次要时间信息并允许状态换行，浮层限制在窗口内。恢复后的目录 / Agent 为可读名称的待启动页签，启动按钮固定于顶部，说明正文独立滚动。普通启动和 CLI 历史选择器明确分开；显式启动后实际终端替换原入口。具体行为见 `docs/project-scene.md`。

## 会话与任务局部补充（P0-B）

按用户指定的 macOS 通知方向，取消底部常驻状态栏；标题栏窗口控制前保留一个 28px 铃铛，未读角标不改变按钮宽度，实测控制簇宽度继续为页签预留空间。右上角通知距页签行底部 12px、距窗口右侧 14px，宽 360px（窄窗口限制在视口内），最小高 82px，16px 圆角、柔和下投影和轻透材质；继续使用 rack / slot / rule / amber 及系统字体，不改其他侧栏。只保留两行：第一行突出完成／失败／需要审批的结果及时间；第二行显示项目名与查看入口。worktree 标签同时带项目名，完整目录及会话／任务身份放在悬停提示与详情中。最多三条可见，审批优先。完成与失败停留 8 秒，悬停、键盘焦点或查看详情时暂停；审批保持到处理、关闭或可靠状态失效。自动提醒不抢输入焦点，关闭卡片与超时均保留历史。

铃铛展开右上角非模态通知中心，使用“提醒／会话”页签，支持键盘切换、项目筛选、静音、已读与清空。提醒点击定位对应项目和会话；会话详情仍分别展示进程、任务、连接、来源与最近检查，审批参数单独滚动。审批卡片只提供查看请求，实际操作与后端选项在详情中由用户确认。项目现场旁的会话图标入口继续可用。具体能力边界见 `docs/workbench-activity.md`。

配色收尾：浅色通知与通知中心使用 90% 白色混入 10% 当前主题 base 的柔白面，控件使用更浅的主题灰，投影从 20% 黑减为约 13%。深色继续使用石墨面。完成图标复用 live 绿色、失败图标复用 error 红色；浅色下与主题正文混色收深，保证图标对比度，审批沿用主题琥珀。颜色仅辅助已有图标与文字，不铺大面积状态色，不改全应用主题。

## Overview

**Creative North Star: "项目索引（The Project Index）"**

项目是一级索引：先识别项目，再读工作区名称与模型、变量组，点击始终可见的启动按钮。工作区是可直接启动的全宽条目，取消树线与深缩进。本设计仅适用于 Codex 与 Claude 两个工作区面板，不替代 DeepSeek 面板或其他页面的设计规范。

**Key Characteristics:** 项目为一等索引、工作区全宽可启动；无树线、无深缩进，章节色标作识别；常显启动列，底色与强调色均沿用全局主题；系统无衬线三级，无卡片外框与图标底座。

## Colors

面板直接使用全局主题色（`--bg-base` / `--bg-rack` / `--bg-slot` / `--text-rack`），不叠加独立的青色染层。操作焦点沿用 `--amber`，随用户选定主题变化。

- **操作强调（launcher-accent）**：沿用 `--amber`；用于焦点、选中态及按钮悬停描边，按钮默认文字使用主题主文字色。
- **项目色标（project-color）**：按项目 hue 派生，亮色使用 frontmatter 中的 `project-color-light` 配方，用作章节 2px 顶边与标题 hover。
- **面板底色（launcher-ground / surface / hover）**：分别映射到 `--bg-base` / `--bg-rack` / `--bg-slot`，与其他侧栏共用同一套层次。
- **文字（launcher-ink / launcher-secondary）**：主文字 `var(--text-rack)`；辅助文字 `color-mix(in srgb, var(--text-rack) 76%, var(--launcher-ground))`，用于目录、模型、变量组、权限。

## Typography

**System Font:** 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei', sans-serif

系统无衬线，三级字号：项目标题 16px/700，工作区名称 13px（branch 550、展开 650），辅助摘要 11px，权限标记 10px；项目计数用等宽数字（tabular-nums）。

## Layout

内容外框与设置页一致：外距 8px 6px 6px、淡绢色 1px 边框、3px 圆角。分组标题使用 --bg-rack 中性底色，成员区域使用全部可用宽度，不增加容器缩进或竖线。工作区行高 52px（点击区 50px），名称/辅助在左、启动按钮在右常显。章节间距 16px，正文内边距 12px 8px 24px；容器窄于 260px 时收窄内边距、启动按钮（文字按钮改为 30px 图标按钮）。编辑器在选中成员行下方展开，以独立的启动配置标题栏、表单底色和分隔线区分层次。

## Elevation & Depth

无阴影、平面体系；深度使用全局主题的 base / rack / slot 三档面色表达。

## Shapes

无卡片外框、无图标底座。标题与编辑面直角（0），工作区点击区 3px，编辑图标 4px，启动按钮与输入框 5px。

## Components

- **项目章节头**：顶部 2px 实线项目色标，主题 rack 底色；内容为项目名（16px/700）、目录（11px 辅助色）、计数与 90° 旋转折叠箭头。分组标题左对齐，成员名称通过自身图标形成自然的文字层次。标题 hover 变项目色，箭头 150ms 旋转。
- **工作区行**：全宽 52px 行，底部 1px 分隔线（ink 12%），无树线；左为名称（前缀 38% 截断 + 分支 550 权重）与摘要（模型·变量组·权限），右为启动按钮。hover/focus 用悬停层；展开态编辑面底色且图标变项目色；危险态图标 error；启动中 65% 不透明度。
- **启动按钮**：5px 圆角、30px 高、min-width 60px（窄容器为 30px 图标按钮）；主题 rule 描边 + rack 底 + 主文字色（11px/600）；hover 使用主题强调色，150ms 过渡。
- **内联编辑器**：独立标题栏使用 --bg-slot，表单区使用 --bg-rack；选中成员行使用 --launcher-hover，与配置面分开；输入 34px 高、5px 圆角、`--bg-slot` 底、`--rule` 描边，聚焦强调色 outline。

## Do's and Don'ts

### Do:
- **Do** 工作区行用 52px 全宽条目，启动按钮常显在右列。
- **Do** 面板底色与操作强调沿用全局主题，不添加固定色相染层。
- **Do** 章节用 2px 项目色标顶边区分，无树线。
- **Do** 状态变化 150ms ease-out，并尊重 prefers-reduced-motion。

### Don't:
- **Don't** 引入树线、深缩进或卡片外框/图标底座。
- **Don't** 用脱离主题的固定面板色。
- **Don't** 把这些规则套用到 DeepSeek 面板或其他页面——本设计仅约束 Codex / Claude 两个面板。

## DeepSeek Launcher 局部补充

此节仅定义用户指定的鲸鱼启动区，不将上面的 Codex / Claude 项目索引布局扩展到 DeepSeek。

- 鲸鱼宽 144px，窄栏随按钮可用宽度收缩；默认使用主题主文字混色（78%），启动完成使用浅色黑 / 深色白。按钮沿用原有 6px 圆角。
- 大鲸鱼使用 `0 6 50 38` 紧边界视区去掉方形图标内置的上下空白，和正下方启动语保持 12px 布局间距；图文组合居中落在统计区上方的剩余空间中。侧栏等小图标继续使用原方形视区。
- 中文启动状态语使用本地 `Dsh Launch` 字体（ZCOOL KuaiLe 子集），20px / 28px / 400；英文使用 `Dsh Launch Script`（Great Vibes 连笔花体子集），28px / 36px / 400。两者仅用于鲸鱼下方的文字；统计和导航沿用现有系统字体。字体来源及许可见 `src/renderer/fonts/README-ZCOOLKuaiLe.md`。
- 鲸鱼与状态语同步以 2 秒从左向右揭开端点色，填满后轻微呼吸直至启动返回。这是等待动效，不对应实际进度；减少动画偏好下直接显示完整变色层。
- 启动区居中占用剩余空间，下方统计区至少 132px，支持「本次会话 / 今日累计」切换；未接入的 Token 与费用显示「—」并说明未接入。矮窗口整体纵向滚动，区域互不覆盖。

右上角旧会话浮窗及专用路由、快捷键与 IPC 已移除。右侧任务区默认用 Ctrl+反引号切换，终端设置的恢复默认按钮立即保存默认绑定。

恢复补充：显式移回 Tasks 会恢复可用实例并收纳到任务区。已确认结束的本地宿主会在保存目录新建普通 shell（包括原 Agent 终端），不重放启动命令或旧请求；探测结果未知时保留错误，避免重复启动。恢复失败记录保留在归档，重试入口重新执行恢复。

任务区页签行右侧：Tasks 显示全部收回按钮，一键收回主区中全部已收纳任务，保留原实例及未收纳页签，Archive 显示全部移回任务区，Alerts 不显示任务操作。按钮不属于 tablist，方向键只在三个页签间移动。窄于 420px 时操作保留图标和完整悬停提示，避免挤压页签；点击任务方格不会主动收起侧栏。

任务栏附着位置：展开后的标题行可拖到内容区四边，靠近目标边缘才吸附；中央松手、Esc 或取消保留原位置。收起细线仅用于展开，不支持拖动或方向键换边。本机记住边缘、宽度与高度。上下附着时左侧 124×124 正方形任务卡按可用高度从上到下填满每列，再从左到右新增列，右侧终端或网页窗口从左到右排列，标题及操作位于小窗上方，窗口主体固定 16:9（包含网页地址栏），浏览器与终端等宽等高；横版按可用高度联动计算窗口宽度，上限为方块区右侧的可用宽度，分别纵向/横向滚动。左右附着沿用竖向面板。停靠留白跟随边缘，首行页签与系统控制继续留在窗口顶端；空间不足回退覆盖。

横向任务栏会测量正文实际宽高（扣除标题、页签及错误提示），重算方块行列。正文空间不足以完整放下顶部标题及 16:9 窗口主体时，不挂载小窗口，仅展示方块；方块使用整栏宽度，继续按列向右扩展。调高后复用原运行实例恢复小窗口，不重放命令。

展开细线四个方向均距内容边缘 6px，热区保留。仅展开后的标题行可拖动换边，横版支持工具栏空白区域；按钮、页签与模式选择不触发拖动。拖动后保留原展开状态，中央松手、Esc 或取消保留原位置。吸附提示为贴边细长区域，当前目标用琥珀色高亮。横版顶部合并为约 45px 单行工具栏：页签、显示模式、批量操作和收起；宽度不足时模式改用下拉框，保留辅助技术名称。


任务区内容优先布局：竖向顶部收为约 80px 的标题与页签两行，横向维持约 44px 工具栏。显示模式与实时显示合并到标题旁的显示设置入口，按需展开设置区；Esc 先关闭设置区并归还焦点。任务收回及归档全部激活位于页签行右侧。成功结果只保留标题旁的完成标记，完整计数可悬停或通过辅助技术读取；失败、冲突与缺失结果继续在内容前显式提示，失败可重试。下方任务与小窗口采用连续白色背景、较轻边线和统一留白，保留两行任务名与状态。标题拖动换边、细线仅展开及四边 6px 边距继续保留。


Tasks 方块负责保活，激活后默认只展示方块。仅方块状态下单击打开小窗口，使用小窗口的放大按钮进入主工作区；小窗或主区正在显示时，再点同一方块即收回到仅方块保活，再点才重新打开小窗。收回不关闭 PTY、断开连接或重建网页实例。窄栏自动扩到预览宽度，横版为显式打开的小窗保留空间。无绑定记录仅在点击后后台恢复，终端不先经过主区；普通网页沿用 explicitShelf 需求及可见性校验。任务详情移入右键菜单，不再默认展示额外终端标题行或打开按钮。


小窗终端首帧：后台恢复期间，连接状态先更新会话状态，自动主区落位等待恢复绑定及隐藏落位完成，避免 connected 早于 restore 回执时先显示到主区。有效小窗矩形就绪前，宿主保持透明、裁空与 inert；普通连接自动打开、克隆手动落位及显式放大继续沿用。回归覆盖早到通知、新旧会话、普通连接并行、失败释放与迟到关闭。
