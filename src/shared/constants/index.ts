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
 * 默认字体
 * 顺序关键：Maple Mono NF CN 排最前 —— 圆角等宽字体，中文严格 2:1 且自带 Nerd Font 图标，
 * 能让中文/符号在 xterm 的固定列网格里对齐不漂移（见 TerminalView 的 convertEol 与
 * globals.css 的 .xterm-screen 高度修复，本字体栈解决的是第三条根因：行内宽字符列宽不对齐）。
 * 未安装 Maple 时依次回退：Cascadia Mono(拉丁,Win11 自带) → Consolas → NSimSun(等宽 CJK 兜底)。
 */
export const DEFAULT_FONT_FAMILY = "'Maple Mono NF CN', 'Cascadia Mono', 'Consolas', 'NSimSun', 'Courier New', monospace"

/**
 * 终端字号 —— 只允许 Maple Mono 渲染稳定的字号。
 * Maple Mono NF CN 的前进宽是 0.6em(600/1000),字号必须是 5 的整数倍时每格像素宽才是整数
 * (15px→9px、20px→12px、25px→15px…)。非整数格宽会触发 xterm DOM renderer 的亚像素
 * letter-spacing 补偿(见 TerminalView 的 patchXtermFloatMeasure),放大成第一列漂移。
 * 故把字号钉死在 10/15/20/25/30 五档,禁止落到 16/17 这类「有问题」的档位。
 */
export const DEFAULT_TERMINAL_FONT_SIZE = 15
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 30
export const TERMINAL_FONT_SIZE_STEP = 5

/**
 * 把任意字号吸附到最近的合法档位(5 的整数倍),并夹到 [min,max]。
 * 用于设置输入框、Ctrl+滚轮、以及从 localStorage 恢复旧值时兜底。
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