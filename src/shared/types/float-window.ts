/**
 * 浮窗状态
 */
export interface FloatWindowState {
  // 显示状态
  isVisible: boolean
  activeTab: FloatTabType

  // 尺寸与位置
  size: {
    width: number
    height: number
  }
  position: {
    x: number
    y: number
  }

  // 搜索状态
  searchQuery: string

  // 列表选择
  selectedItemId: string | null
}

/**
 * 浮窗页签类型
 */
export enum FloatTabType {
  SESSIONS = 'sessions',
  COMMANDS = 'commands',
  HISTORY = 'history'
}

/**
 * 快速命令分组（存储结构）
 */
export interface QuickCommandGroup {
  id: string
  name: string
  color?: string    // 分组颜色
  order: number     // 排序顺序
}

/**
 * 快速命令
 */
export interface QuickCommand {
  id: string
  name: string
  content: string
  groupId?: string  // 所属分组ID
  group?: string    // 兼容旧字段
  variables?: Record<string, string>
  createdAt?: Date
  isFavorite?: boolean
  order?: number    // 显示顺序（用于快捷键绑定）
  escapeSequences?: boolean  // 发送时解析转义字符（\n \r \t \xHH）
}

/**
 * 命令分组显示结构（用于浮窗 UI）
 */
export interface CommandGroupDisplay {
  id: string
  name: string
  icon: string
  commands: QuickCommand[]
  isCollapsed: boolean
  order: number
}

/**
 * 执行历史
 */
export interface ExecutionHistory {
  id: string
  command: string
  sessionId: string
  sessionName: string
  executedAt: Date
  status: ExecutionStatus
  exitCode?: number
  output?: string
  duration?: number
  isFavorite: boolean
}

/**
 * 执行状态
 */
export enum ExecutionStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  WARNING = 'warning',
  RUNNING = 'running'
}

/**
 * 快速输入状态
 */
export interface QuickInputState {
  command: string
  targetSessionId: string | 'current'
  isMultiline: boolean
  historyDropdownVisible: boolean
  autocompleteSuggestions: string[]
}