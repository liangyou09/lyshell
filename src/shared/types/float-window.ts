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
 * 快速命令
 */
export interface QuickCommand {
  id: string
  name: string
  content: string
  group: string
  variables?: Record<string, string>
  createdAt: Date
  isFavorite: boolean
}

/**
 * 命令分组
 */
export interface CommandGroup {
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