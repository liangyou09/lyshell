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
  selection: '#FFFFFF',
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
  selection: '#ADD6FF',
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
 */
export const DEFAULT_FONT_FAMILY = "'Lucida Console', 'Consolas', 'Courier New', monospace"

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