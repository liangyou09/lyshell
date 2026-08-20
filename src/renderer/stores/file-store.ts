import { create } from 'zustand'
import type { FileInfo } from '@shared/types'
import { FileConnectorType } from '@shared/types'

/**
 * 文件节点（用于文件树展示）
 */
export interface FileNode {
  path: string
  name: string
  isDir: boolean
  size: number
  modifyTime: Date
  permissions?: string
  children?: FileNode[]      // 子节点（目录才有）
  loaded: boolean            // 是否已加载子节点
  expanded: boolean          // 是否展开（目录才有）
}

/**
 * 文件状态
 */
interface FileState {
  // 每个会话的文件树根节点
  fileTrees: Record<string, FileNode>

  // 每个会话的当前路径
  currentPaths: Record<string, string>

  // 每个会话的连接器类型
  connectorTypes: Record<string, FileConnectorType | null>

  // 加载状态
  loading: Record<string, boolean>

  // 错误信息
  errors: Record<string, string>

  // 选中的文件路径
  selectedPaths: Record<string, string | null>

  // ========== 操作方法 ==========

  // 初始化文件树
  initFileTree: (sessionId: string, rootPath: string) => Promise<void>

  // 加载目录内容
  loadDir: (sessionId: string, path: string) => Promise<void>

  // 刷新目录
  refreshDir: (sessionId: string, path: string) => Promise<void>

  // 展开/折叠目录
  toggleExpand: (sessionId: string, path: string) => void

  // 设置选中文件
  setSelected: (sessionId: string, path: string | null) => void

  // 设置当前路径
  setCurrentPath: (sessionId: string, path: string) => void

  // 获取连接器类型
  fetchConnectorType: (sessionId: string) => Promise<void>

  // 清除会话的文件状态
  clearSession: (sessionId: string) => void

  // 设置错误
  setError: (sessionId: string, error: string) => void

  // 清除错误
  clearError: (sessionId: string) => void
}

/**
 * 文件状态 Store
 */
export const useFileStore = create<FileState>((set, get) => ({
  fileTrees: {},
  currentPaths: {},
  connectorTypes: {},
  loading: {},
  errors: {},
  selectedPaths: {},

  // 初始化文件树
  initFileTree: async (sessionId: string, rootPath: string) => {
    set((state) => ({
      loading: { ...state.loading, [sessionId]: true },
      errors: { ...state.errors, [sessionId]: '' }
    }))

    try {
      const result = await window.electronAPI.fileList(sessionId, rootPath)

      if (!result.success) {
        set((state) => ({
          loading: { ...state.loading, [sessionId]: false },
          errors: { ...state.errors, [sessionId]: result.error }
        }))
        return
      }

      const files = result.data as FileInfo[]
      const children = files.map(f => ({
        path: f.path,
        name: f.name,
        isDir: f.isDir,
        size: f.size,
        modifyTime: f.modifyTime,
        permissions: f.permissions,
        loaded: !f.isDir,  // 文件不需要加载子节点
        expanded: false
      }))

      // 创建根节点
      const rootNode: FileNode = {
        path: rootPath,
        name: rootPath === '/' ? 'Root' : rootPath,
        isDir: true,
        size: 0,
        modifyTime: new Date(),
        loaded: true,
        expanded: true,
        children
      }

      set((state) => ({
        fileTrees: { ...state.fileTrees, [sessionId]: rootNode },
        currentPaths: { ...state.currentPaths, [sessionId]: rootPath },
        loading: { ...state.loading, [sessionId]: false }
      }))
    } catch (error) {
      set((state) => ({
        loading: { ...state.loading, [sessionId]: false },
        errors: { ...state.errors, [sessionId]: (error as Error).message }
      }))
    }
  },

  // 加载目录内容
  loadDir: async (sessionId: string, path: string) => {
    set((state) => ({
      loading: { ...state.loading, [sessionId]: true }
    }))

    try {
      const result = await window.electronAPI.fileList(sessionId, path)

      if (!result.success) {
        set((state) => ({
          loading: { ...state.loading, [sessionId]: false },
          errors: { ...state.errors, [sessionId]: result.error }
        }))
        return
      }

      const files = result.data as FileInfo[]
      const children = files.map(f => ({
        path: f.path,
        name: f.name,
        isDir: f.isDir,
        size: f.size,
        modifyTime: f.modifyTime,
        permissions: f.permissions,
        loaded: !f.isDir,
        expanded: false
      }))

      // 更新树中对应节点
      const updateNode = (node: FileNode): FileNode => {
        if (node.path === path) {
          return { ...node, children, loaded: true }
        }
        if (node.children) {
          return { ...node, children: node.children.map(updateNode) }
        }
        return node
      }

      set((state) => {
        const root = state.fileTrees[sessionId]
        if (!root) return state

        return {
          fileTrees: { ...state.fileTrees, [sessionId]: updateNode(root) },
          loading: { ...state.loading, [sessionId]: false }
        }
      })
    } catch (error) {
      set((state) => ({
        loading: { ...state.loading, [sessionId]: false },
        errors: { ...state.errors, [sessionId]: (error as Error).message }
      }))
    }
  },

  // 刷新目录
  refreshDir: async (sessionId: string, path: string) => {
    // 先标记为未加载
    const markUnloaded = (node: FileNode): FileNode => {
      if (node.path === path) {
        return { ...node, loaded: false, children: undefined }
      }
      if (node.children) {
        return { ...node, children: node.children.map(markUnloaded) }
      }
      return node
    }

    set((state) => {
      const root = state.fileTrees[sessionId]
      if (!root) return state
      return {
        fileTrees: { ...state.fileTrees, [sessionId]: markUnloaded(root) }
      }
    })

    // 然后重新加载
    await get().loadDir(sessionId, path)
  },

  // 展开/折叠目录
  toggleExpand: (sessionId: string, path: string) => {
    const toggle = (node: FileNode): FileNode => {
      if (node.path === path && node.isDir) {
        const newExpanded = !node.expanded
        return { ...node, expanded: newExpanded }
      }
      if (node.children) {
        return { ...node, children: node.children.map(toggle) }
      }
      return node
    }

    set((state) => {
      const root = state.fileTrees[sessionId]
      if (!root) return state
      return {
        fileTrees: { ...state.fileTrees, [sessionId]: toggle(root) }
      }
    })
  },

  // 设置选中文件
  setSelected: (sessionId: string, path: string | null) => {
    set((state) => ({
      selectedPaths: { ...state.selectedPaths, [sessionId]: path }
    }))
  },

  // 设置当前路径
  setCurrentPath: (sessionId: string, path: string) => {
    set((state) => ({
      currentPaths: { ...state.currentPaths, [sessionId]: path }
    }))
  },

  // 获取连接器类型
  fetchConnectorType: async (sessionId: string) => {
    try {
      const result = await window.electronAPI.getFileConnectorType(sessionId)
      if (result.success) {
        set((state) => ({
          connectorTypes: { ...state.connectorTypes, [sessionId]: result.data }
        }))
      }
    } catch (error) {
      console.error('Failed to get connector type:', error)
    }
  },

  // 清除会话的文件状态
  clearSession: (sessionId: string) => {
    set((state) => {
      const newFileTrees = { ...state.fileTrees }
      const newCurrentPaths = { ...state.currentPaths }
      const newConnectorTypes = { ...state.connectorTypes }
      const newLoading = { ...state.loading }
      const newErrors = { ...state.errors }
      const newSelectedPaths = { ...state.selectedPaths }

      delete newFileTrees[sessionId]
      delete newCurrentPaths[sessionId]
      delete newConnectorTypes[sessionId]
      delete newLoading[sessionId]
      delete newErrors[sessionId]
      delete newSelectedPaths[sessionId]

      return {
        fileTrees: newFileTrees,
        currentPaths: newCurrentPaths,
        connectorTypes: newConnectorTypes,
        loading: newLoading,
        errors: newErrors,
        selectedPaths: newSelectedPaths
      }
    })
  },

  // 设置错误
  setError: (sessionId: string, error: string) => {
    set((state) => ({
      errors: { ...state.errors, [sessionId]: error }
    }))
  },

  // 清除错误
  clearError: (sessionId: string) => {
    set((state) => ({
      errors: { ...state.errors, [sessionId]: '' }
    }))
  }
}))