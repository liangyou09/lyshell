/**
 * 窗口第一行(顶置页签条)与左列共享度量 -- 单一真相源,对齐 ActivityRail.tsx 的 RAIL_WIDTH 模式。
 *
 * 终端页签条提顶后,窗口第一行 = 最顶排 pane 的 PaneTabBar + 左上侧栏开关 pill +
 * 右上控制簇(MCP 状态片/浮窗键/窗口控制)。pill 与控制簇是 absolute 浮层,
 * 对应 pane 的页签条做 padding 留白防页签滚入浮层下方:左端 pill 宽固定,
 * 浮层挂载宽与页签条留白两端引用 TOP_LEFT_RESERVE 同一常量;右端控制簇宽随
 * chip 文案伸缩,不走常量(见下方 --top-right-reserve 说明)。
 */

/** 第一行高度 -- 页签条(含空态条)/pill/控制簇浮层/会话浮窗挂载点共用 */
export const TOPBAR_HEIGHT = 36

/** 左上侧栏开关 pill 预留宽 -- MainWindow 浮层挂载 / PaneTabBar 左留白共用 */
export const TOP_LEFT_RESERVE = 32

/** 收起态展开 pill 的高度 -- 与 TOPBAR_HEIGHT 同值:32×36 方块恰好填满第一行左端,
 *  不探进终端画布;顶左角按窗口圆角 8px 收圆(镜像 edge-frame 左下角的做法)。
 *  刻意保留独立常量而非直接引用:行高与 pill 高是两个语义,允许再次分叉 */
export const SIDEBAR_PILL_HEIGHT = 36

/** 右上控制簇的右留白不在此定义 -- 控制簇宽度随 chip 文案(语言/审计条数)伸缩,
 *  由 TopRightControls 实测发布到 CSS 变量 --top-right-reserve(globals.css :root
 *  有 252px 首帧兜底),PaneTabBar 读 var() 做右留白。 */

/** 侧栏调宽条宽(含命中热区) -- 左列总宽 = RAIL_WIDTH + sidebarWidth + 此值,调宽条本体同宽 */
export const SIDEBAR_DIVIDER_WIDTH = 4
