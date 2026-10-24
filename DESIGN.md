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
rounded:
  sm: "3px"
  md: "4px"
  lg: "5px"
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

## 项目现场局部补充（P0-A）

仅无可见页签的首页底部显示紧凑项目栏：可读项目名、保存时间、继续上次工作、保存、历史与短状态。有终端、文档、网页或待启动入口时隐藏，全部关闭后重现；全局命令面板打开时也隐藏。项目名打开可搜索的浮层，历史默认按项目 / worktree 隔离；完整路径、范围说明及逐项提示按需展开。Agent / Codex / Claude 的实际项目列表同步提供继续、保存与历史入口；同一目录内的共享项目和 worktree 分别标明名称。底栏隐藏不影响项目旁的历史浮层。

沿用 rack / slot / rule / amber 主题令牌、系统字体与焦点样式；宽窗口底栏 43px，窄容器隐藏次要时间信息并允许状态换行，浮层限制在窗口内。恢复后的目录 / Agent 为可读名称的待启动页签，启动按钮固定于顶部，说明正文独立滚动。普通启动和 CLI 历史选择器明确分开；显式启动后实际终端替换原入口。具体行为见 `docs/project-scene.md`。

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
