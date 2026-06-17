import { create } from 'zustand'
import type { PaneNode, PaneLeaf, PaneSplit, PaneLayout, SplitDirection } from '@shared/types'

// 布局持久化 key
const LAYOUT_STORAGE_KEY = 'lyshell_pane_layout'

// 自动保存布局的订阅函数
const subscribeToLayoutChanges = (store: any) => {
  store.subscribe((state: PaneStore, prevState: PaneStore) => {
    // 只在布局变化时保存
    if (state.layout !== prevState.layout) {
      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state.layout))
      } catch (e) {
        console.warn('Failed to save pane layout:', e)
      }
    }
  })
}

/**
 * 分屏状态管理
 */
interface PaneStore {
  // 布局状态
  layout: PaneLayout

  // 操作方法
  splitPane: (paneId: string, direction: SplitDirection, sessionId?: string) => void
  splitPaneWithPosition: (paneId: string, direction: SplitDirection, sessionId: string, position: 'first' | 'second') => void
  closePane: (paneId: string) => void
  setActivePane: (paneId: string) => void
  setSplitRatio: (paneId: string, ratio: number) => void
  addSessionToPane: (paneId: string, sessionId: string) => void
  removeSessionFromPane: (paneId: string, sessionId: string) => void
  setActiveSessionInPane: (paneId: string, sessionId: string | null) => void
  reorderSessionsInPane: (paneId: string, fromIndex: number, toIndex: number) => void
  swapPanePosition: (paneId: string) => void  // 交换分屏位置
  changeSplitDirection: (paneId: string) => void  // 改变分屏方向
  saveLayout: () => void  // 保存布局
  loadLayout: (validSessionIds: string[]) => void  // 加载布局（过滤无效 session）

  // 查询方法
  getPaneById: (paneId: string) => PaneNode | undefined
  getAllLeafPanes: () => PaneLeaf[]
  getParentPane: (paneId: string) => PaneSplit | undefined
  getPaneBySessionId: (sessionId: string) => PaneLeaf | undefined
  getPanePositionInParent: (paneId: string) => 'first' | 'second' | null
}

// 生成唯一ID
const generateId = () => Date.now().toString() + Math.random().toString(36).slice(2, 6)

// 初始布局 - 单个叶子节点，空会话列表
const createInitialLayout = (): PaneLayout => ({
  root: {
    id: generateId(),
    type: 'leaf',
    sessions: [],
    activeSessionId: null
  },
  activePaneId: ''
})

// 查找分屏节点
const findPane = (node: PaneNode, paneId: string): PaneNode | undefined => {
  if (node.id === paneId) return node
  if (node.type === 'split') {
    const found = findPane(node.firstChild, paneId) || findPane(node.secondChild, paneId)
    return found
  }
  return undefined
}

// 查找父节点
const findParent = (node: PaneNode, paneId: string, parent?: PaneSplit): PaneSplit | undefined => {
  if (node.id === paneId) return parent
  if (node.type === 'split') {
    return findParent(node.firstChild, paneId, node) || findParent(node.secondChild, paneId, node)
  }
  return undefined
}

// 收集所有叶子节点
const collectLeaves = (node: PaneNode): PaneLeaf[] => {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.firstChild), ...collectLeaves(node.secondChild)]
}

// 替换节点（用于树更新）
const replacePane = (node: PaneNode, paneId: string, newPane: PaneNode): PaneNode => {
  if (node.id === paneId) return newPane
  if (node.type === 'split') {
    return {
      ...node,
      firstChild: replacePane(node.firstChild, paneId, newPane),
      secondChild: replacePane(node.secondChild, paneId, newPane)
    }
  }
  return node
}

// 从所有分屏中移除指定会话
const removeSessionFromAllPanes = (root: PaneNode, sessionId: string): PaneNode => {
  if (root.type === 'leaf') {
    const newSessions = root.sessions.filter(s => s !== sessionId)
    const newActiveId = root.activeSessionId === sessionId
      ? (newSessions.length > 0 ? newSessions[0] : null)
      : root.activeSessionId
    return {
      ...root,
      sessions: newSessions,
      activeSessionId: newActiveId
    }
  }
  return {
    ...root,
    firstChild: removeSessionFromAllPanes(root.firstChild, sessionId),
    secondChild: removeSessionFromAllPanes(root.secondChild, sessionId)
  }
}

// 移除所有空分屏并合并
const removeEmptyPanes = (root: PaneNode): PaneNode => {
  // 先递归处理子节点
  if (root.type === 'split') {
    const newFirstChild = removeEmptyPanes(root.firstChild)
    const newSecondChild = removeEmptyPanes(root.secondChild)

    // 检查子节点是否是空叶子
    const firstEmpty = newFirstChild.type === 'leaf' && newFirstChild.sessions.length === 0
    const secondEmpty = newSecondChild.type === 'leaf' && newSecondChild.sessions.length === 0

    // 如果两个都空，返回空叶子
    if (firstEmpty && secondEmpty) {
      return {
        id: root.id,
        type: 'leaf',
        sessions: [],
        activeSessionId: null
      }
    }

    // 如果第一个空，用第二个替换
    if (firstEmpty) {
      return newSecondChild
    }

    // 如果第二个空，用第一个替换
    if (secondEmpty) {
      return newFirstChild
    }

    // 都不空，保持 split
    return {
      ...root,
      firstChild: newFirstChild,
      secondChild: newSecondChild
    }
  }

  return root
}

// 查找包含指定会话的分屏
const findPaneBySessionId = (node: PaneNode, sessionId: string): PaneLeaf | undefined => {
  if (node.type === 'leaf') {
    if (node.sessions.includes(sessionId)) return node
    return undefined
  }
  return findPaneBySessionId(node.firstChild, sessionId) || findPaneBySessionId(node.secondChild, sessionId)
}

// 交换分屏位置（交换兄弟分屏）
const swapSplitChildren = (root: PaneNode, splitPaneId: string): PaneNode => {
  if (root.type === 'leaf') return root

  if (root.id === splitPaneId) {
    return {
      ...root,
      firstChild: root.secondChild,
      secondChild: root.firstChild,
      splitRatio: 1 - root.splitRatio  // 反转比例
    }
  }

  return {
    ...root,
    firstChild: swapSplitChildren(root.firstChild, splitPaneId),
    secondChild: swapSplitChildren(root.secondChild, splitPaneId)
  }
}

// 判断分屏在父节点中的位置
const getPanePositionInParent = (root: PaneNode, paneId: string): 'first' | 'second' | null => {
  if (root.type === 'leaf') return null

  if (root.firstChild.id === paneId ||
      (root.firstChild.type === 'split' && findPane(root.firstChild, paneId))) {
    return 'first'
  }
  if (root.secondChild.id === paneId ||
      (root.secondChild.type === 'split' && findPane(root.secondChild, paneId))) {
    return 'second'
  }

  return null
}

// 删除节点并合并父节点 - 递归合并空分屏
const removePaneAndMerge = (root: PaneNode, paneId: string): PaneNode => {
  // 先删除目标节点
  let newRoot = root

  // 递归查找并合并
  const merge = (node: PaneNode, targetId: string): PaneNode => {
    const parent = findParent(node, targetId)
    if (!parent) {
      // 删除的是根节点，返回新的空叶子
      return {
        id: generateId(),
        type: 'leaf',
        sessions: [],
        activeSessionId: null
      }
    }

    // 找到另一个子节点
    const otherChild = parent.firstChild.id === targetId ? parent.secondChild : parent.firstChild

    // 用另一个子节点替换父节点
    newRoot = replacePane(node, parent.id, otherChild)

    // 检查合并后的节点是否是空的叶子，如果是，继续向上合并
    if (otherChild.type === 'leaf' && otherChild.sessions.length === 0) {
      // 继续向上合并
      return merge(newRoot, otherChild.id)
    }

    return newRoot
  }

  return merge(root, paneId)
}

// 过滤无效的 sessionId，清理空分屏
const filterValidSessions = (root: PaneNode, validSessionIds: Set<string>): PaneNode => {
  if (root.type === 'leaf') {
    const validSessions = root.sessions.filter(s => validSessionIds.has(s))
    const validActiveId = root.activeSessionId && validSessionIds.has(root.activeSessionId)
      ? root.activeSessionId
      : (validSessions.length > 0 ? validSessions[0] : null)
    return {
      ...root,
      sessions: validSessions,
      activeSessionId: validActiveId
    }
  }
  return {
    ...root,
    firstChild: filterValidSessions(root.firstChild, validSessionIds),
    secondChild: filterValidSessions(root.secondChild, validSessionIds)
  }
}

// 在应用启动时加载保存的布局
const loadSavedLayout = (validSessionIds: string[]) => {
  try {
    const saved = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!saved) return null

    const parsed = JSON.parse(saved) as PaneLayout
    if (!parsed || !parsed.root) return null

    // 过滤无效的 sessionId
    const validSet = new Set(validSessionIds)
    let filteredRoot = filterValidSessions(parsed.root, validSet)

    // 清理空分屏
    filteredRoot = removeEmptyPanes(filteredRoot)

    // 如果过滤后没有有效分屏，返回 null
    const leaves = collectLeaves(filteredRoot)
    if (leaves.length === 0 || leaves.every(l => l.sessions.length === 0)) {
      return null
    }

    return {
      root: filteredRoot,
      activePaneId: leaves.find(l => l.sessions.length > 0)?.id || parsed.activePaneId || ''
    }
  } catch (e) {
    console.warn('Failed to load pane layout:', e)
    return null
  }
}

export const usePaneStore = create<PaneStore>((set, get) => ({
  layout: (() => {
    // 尝试加载保存的布局（空 session 集合，只恢复分屏结构）
    const saved = loadSavedLayout([])
    return saved || createInitialLayout()
  })(),

  // 分屏操作 - 将会话移动到新分屏
  splitPane: (paneId, direction, sessionId) => {
    const layout = get().layout

    // 如果有 sessionId，先从所有分屏中移除
    let newRoot = layout.root
    if (sessionId) {
      newRoot = removeSessionFromAllPanes(newRoot, sessionId)
      // 移除空分屏
      newRoot = removeEmptyPanes(newRoot)
    }

    // 找到目标分屏
    let targetPaneId = paneId
    const targetPane = findPane(newRoot, paneId)
    if (!targetPane || targetPane.type !== 'leaf') {
      // 如果找不到，使用第一个叶子节点
      const leaves = collectLeaves(newRoot)
      if (leaves.length > 0) {
        targetPaneId = leaves[0].id
      }
    }

    const targetLeaf = findPane(newRoot, targetPaneId) as PaneLeaf | undefined
    if (!targetLeaf || targetLeaf.type !== 'leaf') return

    // 如果目标分屏只有一个会话且是拖拽的会话，创建分屏将该会话移到新分屏
    if (targetLeaf.sessions.length === 1 && sessionId && targetLeaf.sessions.includes(sessionId)) {
      const newPaneId1 = generateId()
      const newPaneId2 = generateId()

      const newSplit: PaneSplit = {
        id: targetLeaf.id,
        type: 'split',
        direction,
        splitRatio: 0.5,
        firstChild: {
          id: newPaneId1,
          type: 'leaf',
          sessions: [],
          activeSessionId: null
        },
        secondChild: {
          id: newPaneId2,
          type: 'leaf',
          sessions: [sessionId],
          activeSessionId: sessionId
        }
      }

      set({
        layout: {
          root: replacePane(newRoot, targetPaneId, newSplit),
          activePaneId: newPaneId2
        }
      })
      return
    }

    // 如果目标分屏是空的且有 sessionId，直接添加会话（不创建新分屏）
    if (targetLeaf.sessions.length === 0 && sessionId) {
      const leafWithSession: PaneLeaf = {
        ...targetLeaf,
        sessions: [sessionId],
        activeSessionId: sessionId
      }
      set({
        layout: {
          root: replacePane(newRoot, targetPaneId, leafWithSession),
          activePaneId: targetPaneId
        }
      })
      return
    }

    // 创建新的分屏结构
    const newPaneId1 = generateId()
    const newPaneId2 = generateId()

    const newSplit: PaneSplit = {
      id: targetLeaf.id,
      type: 'split',
      direction,
      splitRatio: 0.5,
      firstChild: {
        id: newPaneId1,
        type: 'leaf',
        sessions: targetLeaf.sessions,  // 保持原分屏的会话列表
        activeSessionId: targetLeaf.activeSessionId
      },
      secondChild: {
        id: newPaneId2,
        type: 'leaf',
        sessions: sessionId ? [sessionId] : [],  // 新分屏只有拖拽的会话
        activeSessionId: sessionId || null
      }
    }

    set({
      layout: {
        root: replacePane(newRoot, targetPaneId, newSplit),
        activePaneId: newPaneId2  // 激活新分屏
      }
    })
  },

  // 分屏操作 - 指定新会话的位置（first=左/上，second=右/下）
  splitPaneWithPosition: (paneId, direction, sessionId, position) => {
    const layout = get().layout

    // 先从所有分屏中移除 sessionId
    let newRoot = layout.root
    if (sessionId) {
      newRoot = removeSessionFromAllPanes(newRoot, sessionId)
      newRoot = removeEmptyPanes(newRoot)
    }

    // 找到目标分屏
    let targetPaneId = paneId
    const targetPane = findPane(newRoot, paneId)
    if (!targetPane || targetPane.type !== 'leaf') {
      const leaves = collectLeaves(newRoot)
      if (leaves.length > 0) {
        targetPaneId = leaves[0].id
      }
    }

    const targetLeaf = findPane(newRoot, targetPaneId) as PaneLeaf | undefined
    if (!targetLeaf || targetLeaf.type !== 'leaf') return

    // 如果目标分屏只有一个会话且是拖拽的会话，需要特殊处理
    if (targetLeaf.sessions.length === 1 && sessionId && targetLeaf.sessions.includes(sessionId)) {
      // 这时移除后 targetLeaf.sessions 是空的
      const newPaneId1 = generateId()
      const newPaneId2 = generateId()

      const newSplit: PaneSplit = {
        id: targetLeaf.id,
        type: 'split',
        direction,
        splitRatio: 0.5,
        firstChild: {
          id: newPaneId1,
          type: 'leaf',
          sessions: position === 'first' ? [sessionId] : [],
          activeSessionId: position === 'first' ? sessionId : null
        },
        secondChild: {
          id: newPaneId2,
          type: 'leaf',
          sessions: position === 'second' ? [sessionId] : [],
          activeSessionId: position === 'second' ? sessionId : null
        }
      }

      set({
        layout: {
          root: replacePane(newRoot, targetPaneId, newSplit),
          activePaneId: position === 'first' ? newPaneId1 : newPaneId2
        }
      })
      return
    }

    // 如果目标分屏是空的，直接添加会话
    if (targetLeaf.sessions.length === 0 && sessionId) {
      const leafWithSession: PaneLeaf = {
        ...targetLeaf,
        sessions: [sessionId],
        activeSessionId: sessionId
      }
      set({
        layout: {
          root: replacePane(newRoot, targetPaneId, leafWithSession),
          activePaneId: targetPaneId
        }
      })
      return
    }

    // 创建新的分屏结构，根据 position 决定新会话的位置
    const newPaneId1 = generateId()
    const newPaneId2 = generateId()

    // position === 'first' 表示新会话在左/上边
    const firstChildSessions = position === 'first' ? [sessionId] : targetLeaf.sessions
    const firstChildActiveId = position === 'first' ? sessionId : targetLeaf.activeSessionId
    const secondChildSessions = position === 'second' ? [sessionId] : targetLeaf.sessions
    const secondChildActiveId = position === 'second' ? sessionId : targetLeaf.activeSessionId

    const newSplit: PaneSplit = {
      id: targetLeaf.id,
      type: 'split',
      direction,
      splitRatio: 0.5,
      firstChild: {
        id: newPaneId1,
        type: 'leaf',
        sessions: firstChildSessions,
        activeSessionId: firstChildActiveId
      },
      secondChild: {
        id: newPaneId2,
        type: 'leaf',
        sessions: secondChildSessions,
        activeSessionId: secondChildActiveId
      }
    }

    set({
      layout: {
        root: replacePane(newRoot, targetPaneId, newSplit),
        activePaneId: position === 'first' ? newPaneId1 : newPaneId2
      }
    })
  },

  // 关闭分屏
  closePane: (paneId) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined

    // 如果分屏还有会话，先断开它们
    if (pane && pane.type === 'leaf' && pane.sessions.length > 0) {
      // 断开所有会话（这里只是从分屏移除，不实际断开连接）
      // 用户需要手动断开
    }

    const newRoot = removePaneAndMerge(layout.root, paneId)
    const leaves = collectLeaves(newRoot)

    set({
      layout: {
        root: newRoot,
        activePaneId: leaves.length > 0 ? leaves[0].id : ''
      }
    })
  },

  // 设置活动分屏
  setActivePane: (paneId) => {
    set(state => ({
      layout: { ...state.layout, activePaneId: paneId }
    }))
  },

  // 设置分屏比例
  setSplitRatio: (paneId, ratio) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId)

    if (!pane || pane.type !== 'split') return

    const clampedRatio = Math.max(0.1, Math.min(0.9, ratio))

    const updatedPane: PaneSplit = {
      ...pane,
      splitRatio: clampedRatio
    }

    set({
      layout: {
        root: replacePane(layout.root, paneId, updatedPane),
        activePaneId: layout.activePaneId
      }
    })
  },

  // 添加会话到分屏
  addSessionToPane: (paneId, sessionId) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined

    if (!pane || pane.type !== 'leaf') return

    // 先从所有分屏中移除该会话
    let newRoot = removeSessionFromAllPanes(layout.root, sessionId)

    // 移除空分屏并合并
    newRoot = removeEmptyPanes(newRoot)

    // 找到目标分屏（可能 id 变了，需要重新查找或保持原位置）
    let targetPane = findPane(newRoot, paneId) as PaneLeaf | undefined

    // 如果目标分屏不存在了（可能被合并），找到第一个叶子
    if (!targetPane || targetPane.type !== 'leaf') {
      const leaves = collectLeaves(newRoot)
      if (leaves.length > 0) {
        targetPane = leaves[0]
      }
    }

    if (!targetPane || targetPane.type !== 'leaf') return

    // 添加会话到该分屏
    const newSessions = [...targetPane.sessions, sessionId]

    const leafWithSession: PaneLeaf = {
      ...targetPane,
      sessions: newSessions,
      activeSessionId: sessionId  // 自动激活新会话
    }

    set({
      layout: {
        root: replacePane(newRoot, targetPane.id, leafWithSession),
        activePaneId: targetPane.id
      }
    })
  },

  // 从分屏移除会话（关闭标签）
  removeSessionFromPane: (paneId, sessionId) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined

    if (!pane || pane.type !== 'leaf') return

    const newSessions = pane.sessions.filter(s => s !== sessionId)
    const newActiveId = pane.activeSessionId === sessionId
      ? (newSessions.length > 0 ? newSessions[0] : null)
      : pane.activeSessionId

    const updatedPane: PaneLeaf = {
      ...pane,
      sessions: newSessions,
      activeSessionId: newActiveId
    }

    let newRoot = replacePane(layout.root, paneId, updatedPane)

    // 如果分屏没有会话了，关闭该分屏
    if (newSessions.length === 0) {
      newRoot = removePaneAndMerge(newRoot, paneId)
      const leaves = collectLeaves(newRoot)
      set({
        layout: {
          root: newRoot,
          activePaneId: leaves.length > 0 ? leaves[0].id : ''
        }
      })
    } else {
      set({
        layout: {
          root: newRoot,
          activePaneId: paneId
        }
      })
    }
  },

  // 设置分屏中的活动会话
  setActiveSessionInPane: (paneId, sessionId) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined

    if (!pane || pane.type !== 'leaf') return

    const updatedPane: PaneLeaf = {
      ...pane,
      activeSessionId: sessionId
    }

    set({
      layout: {
        root: replacePane(layout.root, paneId, updatedPane),
        activePaneId: paneId
      }
    })
  },

  // 重排序分屏中的会话（拖拽排序）
  reorderSessionsInPane: (paneId, fromIndex, toIndex) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined

    if (!pane || pane.type !== 'leaf') return

    const sessions = [...pane.sessions]
    const [removed] = sessions.splice(fromIndex, 1)
    sessions.splice(toIndex, 0, removed)

    const updatedPane: PaneLeaf = {
      ...pane,
      sessions
    }

    set({
      layout: {
        root: replacePane(layout.root, paneId, updatedPane),
        activePaneId: paneId
      }
    })
  },

  // 查询方法
  getPaneById: (paneId) => {
    return findPane(get().layout.root, paneId)
  },

  getAllLeafPanes: () => {
    return collectLeaves(get().layout.root)
  },

  getParentPane: (paneId) => {
    return findParent(get().layout.root, paneId)
  },

  getPaneBySessionId: (sessionId) => {
    return findPaneBySessionId(get().layout.root, sessionId)
  },

  // 交换分屏位置（交换兄弟分屏）
  swapPanePosition: (paneId) => {
    const layout = get().layout
    const parent = findParent(layout.root, paneId)

    if (!parent) return  // 没有父节点，无法交换

    set({
      layout: {
        root: swapSplitChildren(layout.root, parent.id),
        activePaneId: layout.activePaneId
      }
    })
  },

  // 改变分屏方向（水平变垂直，垂直变水平）
  changeSplitDirection: (paneId) => {
    const layout = get().layout
    const parent = findParent(layout.root, paneId)

    if (!parent) return

    const newDirection: SplitDirection = parent.direction === 'horizontal' ? 'vertical' : 'horizontal'

    const updateDirection = (root: PaneNode, parentId: string, direction: SplitDirection): PaneNode => {
      if (root.type === 'leaf') return root
      if (root.id === parentId) {
        return { ...root, direction }
      }
      return {
        ...root,
        firstChild: updateDirection(root.firstChild, parentId, direction),
        secondChild: updateDirection(root.secondChild, parentId, direction)
      }
    }

    set({
      layout: {
        root: updateDirection(layout.root, parent.id, newDirection),
        activePaneId: layout.activePaneId
      }
    })
  },

  getPanePositionInParent: (paneId) => {
    return getPanePositionInParent(get().layout.root, paneId)
  },

  // 保存布局到 localStorage
  saveLayout: () => {
    const layout = get().layout
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
    } catch (e) {
      console.warn('Failed to save pane layout:', e)
    }
  },

  // 从 localStorage 加载布局，过滤无效的 session
  loadLayout: (validSessionIds) => {
    const savedLayout = loadSavedLayout(validSessionIds)
    if (savedLayout) {
      set({ layout: savedLayout })
    }
  }
}))

// 自动保存布局变化
subscribeToLayoutChanges(usePaneStore)