import { create } from 'zustand'
import type { QuickCommand, QuickCommandGroup } from '@shared/types'

/**
 * 快捷命令数据 store
 *
 * 数据从 StatusBar.tsx 上移：快捷命令 UI 合入会话栏（SessionsPanel）后，
 * SessionsPanel 只在 activeNav === 'sessions' 且侧栏展开时挂载，
 * 而 Ctrl+F1-F12 直发（MainWindow 常驻监听）与导出/导入刷新都依赖这份数据，
 * 因此状态必须放在常驻的 store 里，面板只是它的一个视图。
 *
 * CRUD（增删改命令、批量存分组）由面板组件直接调 electronAPI 后 loadAll()，
 * store 只负责读态与选中分组。
 */
interface QuickCommandsState {
  /** 全部命令（含 order，未按分组过滤） */
  commands: QuickCommand[]
  /** 用户分组（不含 default，加载时已过滤无效项） */
  groups: QuickCommandGroup[]
  /** 默认分组颜色（持久化在偏好设置 quickCommand.defaultGroupColor） */
  defaultGroupColor: string
  /** 当前选中分组 id（'default' | 用户分组 id） */
  selectedGroupId: string
  /** 加载命令 + 分组 + 默认分组颜色（含过滤与兜底，对齐原 StatusBar 逻辑） */
  loadAll: () => Promise<void>
  setSelectedGroupId: (id: string) => void
}

export const useQuickCommandsStore = create<QuickCommandsState>((set) => ({
  commands: [],
  groups: [],
  defaultGroupColor: '',
  selectedGroupId: 'default',

  loadAll: async () => {
    try {
      const [commandsResult, groupsResult, colorResult] = await Promise.all([
        window.electronAPI?.getQuickCommands(),
        window.electronAPI?.commandGroupList(),
        window.electronAPI?.getConfig?.('quickCommand.defaultGroupColor')
      ])

      // 命令：过滤无效项、补 id/order（对齐原 StatusBar.loadCommands）
      let commands: QuickCommand[] = []
      if (Array.isArray(commandsResult)) {
        commands = (commandsResult as QuickCommand[])
          .filter(cmd => cmd && cmd.name && cmd.content)
          .map((cmd, index) => ({
            ...cmd,
            id: cmd.id || Date.now().toString() + Math.random().toString(36).slice(2),
            groupId: cmd.groupId || undefined,
            order: cmd.order ?? index
          }))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      }

      // 分组：过滤无效 id，排除 default（避免与常驻默认分组重复）
      let groups: QuickCommandGroup[] = []
      if (Array.isArray(groupsResult)) {
        groups = (groupsResult as QuickCommandGroup[])
          .filter(g => g && g.id && g.id !== 'default')
      }

      // 默认分组颜色：未设置时兜底蓝
      const defaultGroupColor =
        typeof colorResult === 'string' && colorResult ? colorResult : '#0078D4'

      set({ commands, groups, defaultGroupColor })
    } catch (err) {
      console.error('Failed to load quick commands state:', err)
    }
  },

  setSelectedGroupId: (id) => set({ selectedGroupId: id })
}))
