/**
 * IPC 通道常量
 */
export const IPC_CHANNELS = {
  // 连接管理
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_RECONNECT: 'connection:reconnect',
  CONNECTION_STATUS: 'connection:status',

  // 会话管理
  SESSION_CREATE: 'session:create',
  SESSION_UPDATE: 'session:update',
  SESSION_DELETE: 'session:delete',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',

  // 终端操作
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',

  // Python 执行
  PYTHON_EXECUTE: 'python:execute',
  PYTHON_SCRIPT: 'python:script',
  PYTHON_TERMINATE: 'python:terminate',
  PYTHON_OUTPUT: 'python:output',

  // AI 功能
  AI_QUERY: 'ai:query',
  AI_STREAM: 'ai:stream',
  AI_CANCEL: 'ai:cancel',

  // 配置管理
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_RESET: 'config:reset',

  // 浮窗
  FLOAT_SHOW: 'float:show',
  FLOAT_HIDE: 'float:hide',
  FLOAT_TOGGLE: 'float:toggle',

  // 网页页签快捷键（main → renderer 单向推送：焦点在 webview 内时宿主收不到
  // keydown，由主进程 before-input-event 拦截后经此通道转发渲染层路由）
  WEB_TAB_SHORTCUT: 'web-tab:shortcut',

  // 窗口
  WINDOW_GET_BOUNDS: 'window:get-bounds'
}

/**
 * 默认终端主题 - 深色
 */
export const DEFAULT_THEME_DARK = {
  foreground: '#CCCCCC',
  background: '#0C0C0C',
  cursor: '#FFFFFF',
  cursorAccent: '#0C0C0C',
  selectionBackground: '#F8C156',         // 鲜黄底 + 下方黑字,统一搜索命中与鼠标划选样式
  selectionInactiveBackground: '#C9A04A', // 终端失焦时的暗黄
  selectionForeground: '#000000',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  magenta: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightMagenta: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2'
}

/**
 * 默认终端主题 - 浅色
 */
export const DEFAULT_THEME_LIGHT = {
  foreground: '#333333',
  background: '#FFFFFF',
  cursor: '#333333',
  cursorAccent: '#FFFFFF',
  selectionBackground: '#ADD6FF',
  selectionInactiveBackground: '#C9DDF2',
  black: '#333333',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  magenta: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightMagenta: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2'
}

/**
 * 终端主字体的 family 名 —— 单一事实来源。
 * 该名字在三处使用，必须保持一致：
 *   1. 本文件 DEFAULT_FONT_FAMILY 的首项（xterm fontFamily 栈）；
 *   2. main.tsx 挂载前的 fonts.load 预热（写错则静默命中 0 个 face，预热形同虚设）；
 *   3. index.html 的两段 @font-face 声明（HTML 是静态资源，没法引本常量 ——
 *      漂移由 main.tsx 的空数组告警 + TerminalView 的 loadingdone 过滤兜底发现）。
 * 改名时改这里 + index.html，别处全部跟着常量走。
 */
export const TERMINAL_WEBFONT_FAMILY = 'Maple Mono NF CN'

/**
 * 终端编码取值表（type 见 @shared/types 的 TerminalEncoding）—— 单一事实来源。
 * 消费方：IPC 校验(handlers assertEnum)、状态栏编码选择菜单、SessionDialog
 * 的 Charset 选择器。加新编码(如 big5)只改这里 + TerminalEncoding 类型,
 * 三处消费方自动跟进 —— 漏改任意一处会出现"菜单有值但 IPC 拒收"或反向的静默 no-op。
 * connector 配置接口(SSHConfig 等)只引 TerminalEncoding 类型,不再复制字面量联合。
 */
export const TERMINAL_ENCODINGS = ['utf-8', 'gbk', 'gb2312'] as const

/**
 * 默认字体
 * 顺序关键：Maple Mono NF CN 排最前 —— 圆角等宽字体，中文严格 2:1 且自带 Nerd Font 图标，
 * 能让中文/符号在 xterm 的固定列网格里对齐不漂移（见 TerminalView 的 convertEol 与
 * globals.css 的 .xterm-screen 高度修复，本字体栈解决的是第三条根因：行内宽字符列宽不对齐）。
 * 未安装 Maple 时依次回退：Cascadia Mono(拉丁,Win11 自带) → Consolas → NSimSun(等宽 CJK 兜底)。
 */
export const DEFAULT_FONT_FAMILY = `'${TERMINAL_WEBFONT_FAMILY}', 'Cascadia Mono', 'Consolas', 'NSimSun', 'Courier New', monospace`

/**
 * 终端字号 —— 整数 px,1 步进,夹取 [10,30]。
 * Maple Mono NF CN 的前进宽是 0.6em(600/1000),仅 5 的整数倍字号才有整数格宽
 * (15px→9px、20px→12px…),其余字号格宽带小数,xterm DOM renderer 会用
 * letter-spacing 补偿(defaultSpacing=格宽-字宽,约 ±0.004px/字符)。
 * 历史上曾因此把字号钉死在 10/15/20/25/30 五档 —— 那是 patchXtermFloatMeasure
 * 之前的结论:整数 offsetWidth 与浮点 canvas 度量不一致,补偿值每行每字符各不相同,
 * 放大成第一列漂移。浮点补丁落地后两侧度量同源,补偿在任意字号下都均匀且精确落格
 * (2026-09 实测 10-30 逐 1px 扫描:ASCII/CJK 行网格误差 ≤0.011px,半/全角字距各只有一个值),
 * 故放开为 1px 步进;5 的倍数仍是「零补偿」的特殊档位,默认值 15 保留在其中。
 */
export const DEFAULT_TERMINAL_FONT_SIZE = 15
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 30
export const TERMINAL_FONT_SIZE_STEP = 1

/**
 * 把任意字号取整到合法档位(整数 px),并夹到 [min,max]。
 * 用于设置输入框失焦、Ctrl+滚轮步进、以及从 localStorage 恢复旧值时兜底。
 */
export function snapTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE
  const snapped = Math.round(size / TERMINAL_FONT_SIZE_STEP) * TERMINAL_FONT_SIZE_STEP
  return Math.max(TERMINAL_FONT_SIZE_MIN, Math.min(TERMINAL_FONT_SIZE_MAX, snapped))
}

/**
 * 默认光标闪烁设置：关闭。减少持续输出时的光标闪烁，用户可在设置面板中手动开启
 */
export const DEFAULT_CURSOR_BLINK = false

export function isCursorBlinkEnabled(): boolean {
  if (typeof localStorage === 'undefined') return DEFAULT_CURSOR_BLINK
  const saved = localStorage.getItem('terminalCursorBlink')
  if (saved === null) return DEFAULT_CURSOR_BLINK
  return saved === 'true'
}

/**
 * 预置命令分组
 */
export const DEFAULT_COMMAND_GROUPS = [
  {
    id: 'system',
    name: '系统管理',
    icon: '📂',
    commands: [
      { name: '查看系统信息', content: 'uname -a' },
      { name: '查看磁盘空间', content: 'df -h' },
      { name: '查看内存使用', content: 'free -m' },
      { name: '查看CPU信息', content: 'cat /proc/cpuinfo | grep "model name"' }
    ]
  },
  {
    id: 'network',
    name: '网络工具',
    icon: '📂',
    commands: [
      { name: '查看网络连接', content: 'netstat -tuln' },
      { name: '查看IP地址', content: 'ip addr show' },
      { name: '测试端口连通', content: 'nc -zv ${host} ${port}' }
    ]
  },
  {
    id: 'log',
    name: '日志查看',
    icon: '📂',
    commands: [
      { name: '实时系统日志', content: 'tail -f /var/log/syslog' },
      { name: '查看最近日志', content: 'tail -100 /var/log/syslog' }
    ]
  }
]

/**
 * 常用波特率
 */
export const COMMON_BAUD_RATES = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600
]