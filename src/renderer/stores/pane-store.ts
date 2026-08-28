import { create } from 'zustand'
import type { PaneNode, PaneLeaf, PaneSplit, PaneLayout, SplitDirection } from '@shared/types'

// 布局持久化 key
const LAYOUT_STORAGE_KEY = 'lyshell_pane_layout'

// 网页访问栏历史持久化 key + 封顶条数（去重后按最近优先，超量截尾）
const WEB_TAB_HISTORY_KEY = 'lyshell.webTabHistory.v1'
const WEB_TAB_HISTORY_MAX = 30

/** 从 localStorage 读历史（坏数据容错为空数组）。纯函数，便于单测。 */
export function loadWebTabHistory(): string[] {
  try {
    const raw = localStorage.getItem(WEB_TAB_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((u): u is string => typeof u === 'string')
  } catch {
    return []
  }
}

/** 去重前置 + 截尾后写回 localStorage。纯函数，便于单测。 */
export function recordWebTabUrlToHistory(history: string[], url: string): string[] {
  return [url, ...history.filter(u => u !== url)].slice(0, WEB_TAB_HISTORY_MAX)
}

/**
 * 网页访问栏页签条目 —— 插件面板 URL 栏打开的通用网页（区别于 dshWeb 单例：多开、无子进程、
 * URL 不受回环锁定）。瞬态：不随布局持久化，webview 随覆盖层卸载即销毁。
 */
export interface WebTabEntry {
  id: string        // 运行时唯一 id
  url: string       // 归一化后的绝对 http(s) URL
  title: string     // 初始取 hostname，后续由 webview page-title-updated 回写
  paneId: string    // 承载 pane
  active: boolean   // 当前在该 pane 中显示（每 pane 至多一个 overlay 激活）
}

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

// 收集当前布局中所有已打开的 sessionId
const collectOpenSessionIds = (layout: PaneLayout): string[] => {
  const ids = new Set<string>()
  const collect = (node: PaneNode) => {
    if (node.type === 'leaf') {
      for (const id of node.sessions) {
        ids.add(id)
      }
    } else {
      collect(node.firstChild)
      collect(node.secondChild)
    }
  }
  collect(layout.root)
  return Array.from(ids)
}

// 自动向主进程同步"当前在终端中打开的会话集合"
const subscribeToTerminalOpenSessionsSync = (store: any) => {
  let lastIds: string | null = null
  store.subscribe((state: PaneStore, prevState: PaneStore) => {
    if (state.layout === prevState.layout) return
    const ids = collectOpenSessionIds(state.layout)
    const idsKey = ids.join('\0')
    if (idsKey === lastIds) return
    lastIds = idsKey
    window.electronAPI?.syncTerminalOpenSessions?.(ids)?.catch((err: unknown) => {
      console.warn('Failed to sync terminal open sessions:', err)
    })
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
  // MCP 活动页签 -- 单例：当前挂着 MCP 审计页签的 paneId（null=未打开）。瞬态，不随布局持久化。
  mcpAuditPaneId: string | null
  // MCP 页签当前是否显示：切到终端/web 页签只隐藏（页签保留，点 MCP 页签切回），对齐 dshWebActive 语义
  mcpAuditActive: boolean
  openMcpAuditInPane: (paneId: string) => void  // 在指定 pane 打开并激活 MCP 页签覆盖层
  deactivateMcpAudit: () => void                 // 隐藏 MCP 覆盖层（页签保留）
  closeMcpAudit: () => void                      // 真正关闭 MCP 页签（✕ / chip / ESC）
  // dsh Web UI 页签 -- 单例：dshWeb 非空即打开，承载在 dshWebPaneId 指定 pane 的页签+覆盖层。瞬态。
  // dshWebActive 区分「打开中」与「当前显示」：切到终端标签只隐藏不回收，点 ✕ 才真正关闭。
  dshWeb: { url: string; name: string; cwd?: string } | null
  dshWebPaneId: string | null
  dshWebActive: boolean
  openDshWebInPane: (paneId: string, info: { url: string; name: string; cwd?: string }) => void
  moveDshWebToPane: (paneId: string) => void  // 拖拽 Web 页签到另一 pane 中心：改挂载 pane（不改树）
  splitDshWebIntoPane: (paneId: string, direction: SplitDirection, position: 'first' | 'second') => void  // 拖拽 Web 页签到边：拆出独立 pane
  activateDshWeb: () => void
  deactivateDshWeb: () => void
  closeDshWeb: () => void
  // web 页签在承载 pane 页签条内的插入序号（pane.sessions 原始坐标；null=钉在末尾）。
  // 页签条内拖动排序时写入；关闭/重排会话时由 store 按删除/插入位置同步修正，否则索引会
  // 随左侧会话关闭而漂移；web 改挂载/重开/关闭时复位。瞬态，不持久化。
  dshWebTabIndex: number | null
  setDshWebTabIndex: (index: number | null) => void
  // Web 页签拖拽标记：拖拽期间隐藏 webview（webview 会吞掉宿主页的 drag 事件），
  // 使 drop 目标区（终端/空 pane）暴露出来可接收 dragover/drop。瞬态，不持久化。
  draggingDshWeb: boolean
  setDraggingDshWeb: (dragging: boolean) => void
  // 网页访问栏页签（多开）—— 插件面板 URL 栏打开的通用网页，每个 URL 一个独立页签。
  // 与 dshWeb/MCP 同为 pane 覆盖层，同 pane 内互斥（激活一个去活其余）。瞬态，不持久化。
  webTabs: WebTabEntry[]
  openWebTab: (rawUrl: string) => { ok: true } | { ok: false; error: string }
  activateWebTab: (id: string) => void
  setWebTabTitle: (id: string, title: string) => void
  closeWebTab: (id: string) => void
  closeWebTabsInPane: (paneId: string) => void
  deactivateWebTabsInPane: (paneId: string) => void  // 隐藏本 pane 的网页页签（页签保留，点页签切回）
  // 网页访问栏历史 —— 实际加载成功（did-finish-load）过的 URL，localStorage 持久化
  // （去重、最近优先、封顶）。页签本身仍是瞬态的，这里只记 URL 供「最近访问」列表
  // 与输入框补全。记录时机在 WebTabOverlay 的 did-finish-load 回调（recordWebTabVisit），
  // 而非 openWebTab —— 打开但没加载出来（DNS 失败/超时）的 URL 不算「访问过」。
  webTabHistory: string[]
  recordWebTabVisit: (url: string) => void
  removeWebTabHistory: (url: string) => void
  clearWebTabHistory: () => void
  // 隐藏的终端页签 —— key 为 runtime sessionId,true 表示该页签(及终端)被折叠隐藏
  // xterm 实例不卸载,连接与输出保留;Sidebar LIVE 段会话标签点击 toggle
  hiddenTabSessions: Record<string, boolean>
  // 批量切换隐藏态;hidden=true 时还会把受影响 pane 的 active 从被隐藏 session 切走
  toggleLiveSessionTabs: (sessionIds: string[], hidden: boolean) => void
  setSplitRatio: (paneId: string, ratio: number) => void
  addSessionToPane: (paneId: string, sessionId: string) => void
  removeSessionFromPane: (paneId: string, sessionId: string) => void
  removeSessionFromAllPanes: (sessionId: string) => void
  setActiveSessionInPane: (paneId: string, sessionId: string | null) => void
  reorderSessionsInPane: (paneId: string, fromIndex: number, toIndex: number) => void
  // 会话页签拖到 web 页签上的落点：把会话插到 web 紧前/紧后并同步 web 插槽（一次 set 完成，
  // 避免组件侧"先 reorder 再改插槽"两步写与 reorder 的插槽自动修正互相打架）
  insertSessionAtWebSlot: (paneId: string, sessionId: string) => void
  // web 页签拖到普通会话页签上的落点：只写 web 插槽，不动 pane.sessions —— 方向推导与
  // splice 重排语义对齐（往左拖 = 插目标前，往右拖 = 插目标后），坐标逻辑与其它插槽
  // 维护路径集中在 store 单点维护
  moveDshWebToSessionTab: (paneId: string, targetSessionId: string) => void
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
  getAllOpenSessionIds: () => string[]
}

// 生成唯一ID
const generateId = () => Date.now().toString() + Math.random().toString(36).slice(2, 6)

/**
 * 网页访问栏 URL 归一化：trim；无 scheme 视为 https；仅放行 http/https 且 hostname 非空。
 * 纯函数，便于单测；通过返回归一化 URL 字符串，失败返回 null（调用方给 i18n 错误文案）。
 */
export function normalizeWebBarUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString()
}

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

// 若 dsh web 承载 pane 已不在新布局树中（被 removeEmptyPanes / removePaneAndMerge 删除），
// 关闭并回收子进程 —— 避免 webview 随 pane 卸载后 dsh 子进程残留成孤儿。
// 每次 layout 树变更后统一调用（见各 action 末尾 removeEmptyPanes/removePaneAndMerge 之后）。
// 同型回收网页访问栏页签：其 pane 不在树中即从 webTabs 移除（无子进程，仅 store 清理）。
const pruneOrphanedDshWeb = (root: PaneNode): void => {
  const { dshWebPaneId, closeDshWeb, webTabs } = usePaneStore.getState()
  if (dshWebPaneId && !findPane(root, dshWebPaneId)) {
    closeDshWeb()
  }
  const orphaned = webTabs.filter(t => !findPane(root, t.paneId))
  if (orphaned.length > 0) {
    usePaneStore.setState({ webTabs: webTabs.filter(t => findPane(root, t.paneId)) })
  }
}

// 拖拽分屏（splitPane / splitPaneWithPosition）会把目标叶子原地替换为 split 节点：叶子 id
// 变成 split id、会话落到新建 id 的子叶子。承载在该叶子上的覆盖层（dsh web / MCP 审计 /
// webTabs）若不随迁会变成僵尸 —— findPane 按 id 仍能找到 split 节点，pruneOrphanedDshWeb
// 不触发，但没有任何叶子渲染它（webview 静默消失、store 条目残留）。
// 迁到继承原会话列表的子叶子：覆盖层语义上跟随原会话留在原半区；dshWebTabIndex 引用的是
// pane.sessions 坐标，继承子叶子的 sessions 原样保留，插槽坐标无需修正。
const migrateOverlaysToPane = (fromPaneId: string, toPaneId: string): void => {
  const { dshWebPaneId, mcpAuditPaneId, webTabs } = usePaneStore.getState()
  const patch: { dshWebPaneId?: string; mcpAuditPaneId?: string; webTabs?: typeof webTabs } = {}
  if (dshWebPaneId === fromPaneId) patch.dshWebPaneId = toPaneId
  if (mcpAuditPaneId === fromPaneId) patch.mcpAuditPaneId = toPaneId
  if (webTabs.some(t => t.paneId === fromPaneId)) {
    patch.webTabs = webTabs.map(t => t.paneId === fromPaneId ? { ...t, paneId: toPaneId } : t)
  }
  if (patch.dshWebPaneId !== undefined || patch.mcpAuditPaneId !== undefined || patch.webTabs !== undefined) {
    usePaneStore.setState(patch)
  }
}

// 承载 dsh web / MCP 审计 / 网页访问栏覆盖层的 pane 即便没有终端会话也不应被判为空删除 ——
// 覆盖层以顶层 store 字段（dshWebPaneId / mcpAuditPaneId / webTabs[].paneId）挂在 pane 上，
// 而非 pane 树的 session；removeEmptyPanes / removePaneAndMerge 只看 sessions.length，会把仍
// 承载覆盖层的 pane 误删，进而触发 pruneOrphanedDshWeb 把 web 一并关闭（关最后一个终端页签
// 连带关 web 的根因）。
const isOverlayPane = (paneId: string): boolean => {
  const { dshWebPaneId, mcpAuditPaneId, webTabs } = usePaneStore.getState()
  return paneId === dshWebPaneId || paneId === mcpAuditPaneId || webTabs.some(t => t.paneId === paneId)
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

// 移除所有空分屏并合并。
// dshWebPaneIdOverride：可选，用于在 store 尚未写入新 dshWebPaneId 时以「新 id」判定覆盖层保护
// （dsh move/split 需在单次 set 前完成 prune，此时 store 里仍是旧 dshWebPaneId，isOverlayPane 会误保护旧 pane）。
const removeEmptyPanes = (root: PaneNode, dshWebPaneIdOverride?: string | null): PaneNode => {
  // 先递归处理子节点
  if (root.type === 'split') {
    const newFirstChild = removeEmptyPanes(root.firstChild, dshWebPaneIdOverride)
    const newSecondChild = removeEmptyPanes(root.secondChild, dshWebPaneIdOverride)

    const { dshWebPaneId, mcpAuditPaneId, webTabs } = usePaneStore.getState()
    const webPaneId = dshWebPaneIdOverride ?? dshWebPaneId
    const isProtected = (id: string) => id === webPaneId || id === mcpAuditPaneId || webTabs.some(t => t.paneId === id)

    // 检查子节点是否是空叶子
    const firstEmpty = newFirstChild.type === 'leaf' && newFirstChild.sessions.length === 0 && !isProtected(newFirstChild.id)
    const secondEmpty = newSecondChild.type === 'leaf' && newSecondChild.sessions.length === 0 && !isProtected(newSecondChild.id)

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
    if (otherChild.type === 'leaf' && otherChild.sessions.length === 0 && !isOverlayPane(otherChild.id)) {
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
      // 移除空分屏；若承载 dsh web 的 pane 因此被删，回收子进程
      newRoot = removeEmptyPanes(newRoot)
      pruneOrphanedDshWeb(newRoot)
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
      // 目标叶子已变成 split：覆盖层迁到继承原会话（这里为空、原会话就是拖拽源）的第一子叶子
      migrateOverlaysToPane(targetPaneId, newPaneId1)
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
    // 目标叶子已变成 split：覆盖层迁到继承原会话列表的第一子叶子
    migrateOverlaysToPane(targetPaneId, newPaneId1)
  },

  // 分屏操作 - 指定新会话的位置（first=左/上，second=右/下）
  splitPaneWithPosition: (paneId, direction, sessionId, position) => {
    const layout = get().layout

    // 先从所有分屏中移除 sessionId
    let newRoot = layout.root
    if (sessionId) {
      newRoot = removeSessionFromAllPanes(newRoot, sessionId)
      newRoot = removeEmptyPanes(newRoot)
      pruneOrphanedDshWeb(newRoot)
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
      // 目标叶子已变成 split：覆盖层迁到未接收拖拽会话（继承原会话残留）的子叶子
      migrateOverlaysToPane(targetPaneId, position === 'first' ? newPaneId2 : newPaneId1)
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
    // 目标叶子已变成 split：覆盖层迁到继承原会话列表的子叶子（position 反侧）
    migrateOverlaysToPane(targetPaneId, position === 'first' ? newPaneId2 : newPaneId1)
  },

  // 关闭分屏
  closePane: (paneId) => {
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined

    // 收集该分屏内的所有 session —— closePane 不走 removeSessionFromPane,
    // 需在此一并清理 hiddenTabSessions 残留,保持与 removeSessionFromPane 一致
    const sessionIdsToClean = (pane?.type === 'leaf' ? pane.sessions : []) ?? []

    const newRoot = removePaneAndMerge(layout.root, paneId)
    // 若删除的 pane 承载 dsh web，合并后该 pane 已不在树中，回收子进程
    pruneOrphanedDshWeb(newRoot)
    const leaves = collectLeaves(newRoot)

    // 清理这些 session 的 hidden 标记
    const nextHidden = { ...get().hiddenTabSessions }
    let hiddenChanged = false
    for (const sid of sessionIdsToClean) {
      if (nextHidden[sid] !== undefined) {
        delete nextHidden[sid]
        hiddenChanged = true
      }
    }

    set({
      ...(hiddenChanged ? { hiddenTabSessions: nextHidden } : {}),
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

  // MCP 活动页签（单例覆盖层）：在指定 pane 打开；空 paneId 忽略（activePaneId 未就绪时点 chip 无害）
  mcpAuditPaneId: null,
  mcpAuditActive: false,
  openMcpAuditInPane: (paneId) => {
    if (!paneId) return
    // 同 pane 的 web 覆盖层与 MCP 覆盖层互斥：webview 是原生视图，同 z-index 时按 DOM 顺序
    // 盖在 MCP 面板上并吞掉其全部点击（面板开了却不可见的根因）。激活 MCP 只隐藏 web
    // （web 页签保留），与 activateDshWeb 隐藏 MCP 对称；web 在其他 pane 则互不影响。
    // 网页访问栏页签同属 webview 覆盖层，一并隐藏（页签保留）。
    const { dshWebPaneId, dshWebActive, webTabs } = get()
    set({
      mcpAuditPaneId: paneId,
      mcpAuditActive: true,
      dshWebActive: dshWebPaneId === paneId ? false : dshWebActive,
      webTabs: webTabs.map(t => t.paneId === paneId ? { ...t, active: false } : t)
    })
  },
  deactivateMcpAudit: () => {
    set({ mcpAuditActive: false })
  },
  closeMcpAudit: () => {
    set({ mcpAuditPaneId: null, mcpAuditActive: false })
  },

  // dsh Web UI 页签（单例覆盖层）：打开时指定承载 pane；空 paneId 回落首个叶子 pane。
  // 打开即激活；切到终端标签走 deactivate（隐藏但保留 webview 与子进程），✕ 走 close（真正回收）。
  dshWeb: null,
  dshWebPaneId: null,
  dshWebActive: false,
  draggingDshWeb: false,
  dshWebTabIndex: null,
  openDshWebInPane: (paneId, info) => {
    const target = paneId || get().getAllLeafPanes()[0]?.id
    if (!target) return
    const { mcpAuditPaneId, mcpAuditActive, webTabs } = get()
    set({
      dshWeb: info, dshWebPaneId: target, dshWebActive: true, dshWebTabIndex: null,
      // 互斥：web 挂到 MCP 页签所在 pane 时隐藏 MCP（页签保留，点 MCP 页签可切回）；
      // 网页访问栏页签同属 webview 覆盖层，同 pane 一并隐藏（页签保留）
      mcpAuditActive: mcpAuditPaneId === target ? false : mcpAuditActive,
      webTabs: webTabs.map(t => t.paneId === target ? { ...t, active: false } : t)
    })
  },
  // 拖拽 Web 页签到某 pane 边缘 → 把 web 拆进独立 pane（左/右/上/下由 position 决定），
  // 原 pane 的终端会话留在另一侧。目标 pane 本就无会话时直接改挂载，不再 split。
  splitDshWebIntoPane: (paneId, direction, position) => {
    const { layout, dshWeb, dshWebPaneId, mcpAuditPaneId, mcpAuditActive } = get()
    if (!dshWeb) return
    const targetLeaf = findPane(layout.root, paneId) as PaneLeaf | undefined
    if (!targetLeaf || targetLeaf.type !== 'leaf') return

    // 目标 pane 无终端会话：web 直接挂上去（若本就是 web 所在 pane，则无事可做）
    if (targetLeaf.sessions.length === 0) {
      if (paneId === dshWebPaneId) return
      // 以新 paneId 覆盖判定：新 web pane 受保护，原 web pane 空出即清理
      const pruned = removeEmptyPanes(layout.root, paneId)
      // 目标 pane 可能挂着 MCP 页签 -- web 激活时隐藏 MCP（互斥，页签保留）
      set({
        dshWebPaneId: paneId, dshWebActive: true, dshWebTabIndex: null,
        mcpAuditActive: mcpAuditPaneId === paneId ? false : mcpAuditActive,
        layout: { root: pruned, activePaneId: paneId }
      })
      return
    }

    const keepPaneId = generateId()
    const webPaneId = generateId()
    const keepLeaf: PaneLeaf = { id: keepPaneId, type: 'leaf', sessions: targetLeaf.sessions, activeSessionId: targetLeaf.activeSessionId }
    const webLeaf: PaneLeaf = { id: webPaneId, type: 'leaf', sessions: [], activeSessionId: null }
    const newSplit: PaneSplit = {
      id: targetLeaf.id,
      type: 'split',
      direction,
      splitRatio: 0.5,
      firstChild: position === 'first' ? webLeaf : keepLeaf,
      secondChild: position === 'first' ? keepLeaf : webLeaf
    }
    // 以新 webPaneId 覆盖判定：新空 leaf 受保护，原 web pane（若存在）空出即清理
    const pruned = removeEmptyPanes(replacePane(layout.root, paneId, newSplit), webPaneId)
    // dshWebTabIndex 是旧 pane sessions 的原始坐标，web 换 pane 后无意义，复位钉尾
    //（与上方空目标分支的 reset 一致；残留旧索引虽然会被追加时的末位同步自愈，但属于无意义状态）
    set({ dshWebPaneId: webPaneId, dshWebActive: true, dshWebTabIndex: null, layout: { root: pruned, activePaneId: webPaneId } })
  },
  // 拖拽 Web 页签到某 pane 中心 → 改挂载 pane（web 仍作覆盖层叠加在该 pane 上），原 pane 空出则清理
  moveDshWebToPane: (paneId) => {
    const { dshWeb, dshWebPaneId, layout, mcpAuditPaneId, mcpAuditActive } = get()
    if (!dshWeb || !paneId || paneId === dshWebPaneId) return
    // 以新 paneId 覆盖判定：新 web pane 受保护，原 web pane 空出即清理
    const pruned = removeEmptyPanes(layout.root, paneId)
    // 目标 pane 可能挂着 MCP 页签 -- web 激活时隐藏 MCP（互斥，页签保留）
    set({
      dshWebPaneId: paneId, dshWebActive: true, dshWebTabIndex: null,
      mcpAuditActive: mcpAuditPaneId === paneId ? false : mcpAuditActive,
      layout: { root: pruned, activePaneId: paneId }
    })
  },
  activateDshWeb: () => {
    if (!get().dshWeb) return
    // 点 web 页签除激活外，还要把 activePaneId 切到承载 pane，
    // 否则 activePaneId 仍停在终端 pane，导致底部状态栏判定（dshWebActiveHere）与分屏高亮环不一致
    set(state => ({
      dshWebActive: true,
      // 反向互斥：MCP 覆盖层若开在本 pane 会被 webview 盖住 -- 只隐藏（页签保留），点 MCP 页签可切回；
      // 网页访问栏页签同属 webview 覆盖层，同 pane 一并隐藏（页签保留，点页签可切回）
      mcpAuditActive: state.mcpAuditPaneId != null && state.mcpAuditPaneId === state.dshWebPaneId
        ? false
        : state.mcpAuditActive,
      webTabs: state.dshWebPaneId != null
        ? state.webTabs.map(t => t.paneId === state.dshWebPaneId ? { ...t, active: false } : t)
        : state.webTabs,
      // 用 state.dshWebPaneId 而非闭包值，与 set 内其它 state 读取一致；空则维持原 activePaneId
      layout: { ...state.layout, activePaneId: state.dshWebPaneId ?? state.layout.activePaneId }
    }))
  },
  deactivateDshWeb: () => {
    set({ dshWebActive: false })
  },
  closeDshWeb: () => {
    set({ dshWeb: null, dshWebPaneId: null, dshWebActive: false, draggingDshWeb: false, dshWebTabIndex: null })
    void window.electronAPI?.closeDshWeb?.()
  },
  setDraggingDshWeb: (dragging) => {
    set({ draggingDshWeb: dragging })
  },
  setDshWebTabIndex: (index) => {
    // 收紧 API：web 未挂载时索引无意义（重开/关闭路径都直接 set 复位，不走这里）；
    // 挂载时 clamp 到 [0, 承载 pane 会话数]，组件侧传入的坐标不要求自身保证边界
    const st = get()
    if (st.dshWeb === null || st.dshWebPaneId === null) return
    if (index === null) {
      set({ dshWebTabIndex: null })
      return
    }
    const pane = findPane(st.layout.root, st.dshWebPaneId) as PaneLeaf | undefined
    if (!pane || pane.type !== 'leaf') return
    set({ dshWebTabIndex: Math.min(Math.max(index, 0), pane.sessions.length) })
  },

  // ===== 网页访问栏页签（多开，插件面板 URL 栏入口） =====
  webTabs: [],
  webTabHistory: loadWebTabHistory(),
  openWebTab: (rawUrl) => {
    const url = normalizeWebBarUrl(rawUrl)
    if (!url) return { ok: false, error: 'invalid URL' }

    const st = get()
    // 挂到当前活动 pane；activePaneId 未就绪时回落首个叶子 pane
    const target = st.layout.activePaneId || st.getAllLeafPanes()[0]?.id
    if (!target) return { ok: false, error: 'no pane available' }

    const entry: WebTabEntry = {
      id: `web-${generateId()}`,
      url,
      title: new URL(url).hostname,
      paneId: target,
      active: true
    }
    // 历史不在这里记 —— 等 WebTabOverlay 的 did-finish-load 再记（recordWebTabVisit），
    // 打开但加载失败的 URL 不进「最近访问」
    set({
      // 同 pane 互斥：webview 同 z-index 按 DOM 顺序互盖，激活新页签先去活旧 overlay（页签保留）
      webTabs: [...st.webTabs.map(t => t.paneId === target ? { ...t, active: false } : t), entry],
      ...(st.dshWebPaneId === target ? { dshWebActive: false } : {}),
      ...(st.mcpAuditPaneId === target ? { mcpAuditActive: false } : {}),
      layout: { ...st.layout, activePaneId: target }
    })
    return { ok: true }
  },
  activateWebTab: (id) => {
    const st = get()
    const tab = st.webTabs.find(t => t.id === id)
    if (!tab) return
    set({
      // 本 pane 内单选：激活目标、去活其余 webTab；其它 pane 不受影响
      webTabs: st.webTabs.map(t => t.paneId === tab.paneId ? { ...t, active: t.id === id } : t),
      ...(st.dshWebPaneId === tab.paneId ? { dshWebActive: false } : {}),
      ...(st.mcpAuditPaneId === tab.paneId ? { mcpAuditActive: false } : {}),
      // 对齐 activateDshWeb：activePaneId 切到承载 pane，保证分屏高亮环与状态栏判定一致
      layout: { ...st.layout, activePaneId: tab.paneId }
    })
  },
  setWebTabTitle: (id, title) => {
    const st = get()
    const tab = st.webTabs.find(t => t.id === id)
    if (!tab || !title || tab.title === title) return
    set({ webTabs: st.webTabs.map(t => t.id === id ? { ...t, title } : t) })
  },
  closeWebTab: (id) => {
    const st = get()
    const tab = st.webTabs.find(t => t.id === id)
    if (!tab) return
    const remaining = st.webTabs.filter(t => t.id !== id)
    // 关掉的是该 pane 当前激活的页签 → 浏览器惯例：切到同 pane 最后一个 webTab；
    // 没有其它 webTab 则回到终端（activeSessionId 不曾被动过，覆盖层卸载即显示）
    if (tab.active) {
      const next = [...remaining].reverse().find(t => t.paneId === tab.paneId)
      if (next) {
        set({ webTabs: remaining.map(t => t.id === next.id ? { ...t, active: true } : t) })
        return
      }
    }
    set({ webTabs: remaining })
  },
  closeWebTabsInPane: (paneId) => {
    const st = get()
    if (!st.webTabs.some(t => t.paneId === paneId)) return
    set({ webTabs: st.webTabs.filter(t => t.paneId !== paneId) })
  },
  deactivateWebTabsInPane: (paneId) => {
    const st = get()
    if (!st.webTabs.some(t => t.paneId === paneId && t.active)) return
    set({ webTabs: st.webTabs.map(t => t.paneId === paneId ? { ...t, active: false } : t) })
  },
  recordWebTabVisit: (url) => {
    const st = get()
    // 已在顶部（重复 did-finish-load，如页内锚点刷新）直接跳过，少一次 setState
    if (st.webTabHistory[0] === url) return
    const history = recordWebTabUrlToHistory(st.webTabHistory, url)
    try {
      localStorage.setItem(WEB_TAB_HISTORY_KEY, JSON.stringify(history))
    } catch { /* 隐私模式/存储满时静默降级为仅内存态 */ }
    set({ webTabHistory: history })
  },
  removeWebTabHistory: (url) => {
    const st = get()
    if (!st.webTabHistory.includes(url)) return
    const history = st.webTabHistory.filter(u => u !== url)
    try {
      localStorage.setItem(WEB_TAB_HISTORY_KEY, JSON.stringify(history))
    } catch { /* 同上：持久化失败仅内存态 */ }
    set({ webTabHistory: history })
  },
  clearWebTabHistory: () => {
    try {
      localStorage.removeItem(WEB_TAB_HISTORY_KEY)
    } catch { /* 同上 */ }
    set({ webTabHistory: [] })
  },

  hiddenTabSessions: {},
  toggleLiveSessionTabs: (sessionIds, hidden) => {
    set(state => {
      const next = { ...state.hiddenTabSessions }
      if (hidden) {
        for (const id of sessionIds) next[id] = true
      } else {
        for (const id of sessionIds) delete next[id]
      }

      // 隐藏/恢复后都要修正 activeSessionId:
      // - 隐藏时:若 active 被隐藏,切到第一个未隐藏的 session;全隐藏则置 null
      // - 恢复时:若 active 为 null(此前全隐藏留下),恢复到第一个 session,避免终端区空白
      const hiddenNow = (sid: string) => next[sid] === true
      const fixActive = (node: PaneNode): PaneNode => {
        if (node.type === 'leaf') {
          if (node.sessions.length === 0) return node
          const activeHidden = node.activeSessionId && hiddenNow(node.activeSessionId)
          const activeMissing = !node.activeSessionId
          if (activeHidden || activeMissing) {
            const fallback = node.sessions.find(s => !hiddenNow(s))
            return { ...node, activeSessionId: fallback ?? null }
          }
          return node
        }
        // branch: 子节点引用都未变就返回原对象,避免无改动时重建整棵树触发多余重渲染
        const f = fixActive(node.firstChild)
        const s = fixActive(node.secondChild)
        if (f === node.firstChild && s === node.secondChild) return node
        return { ...node, firstChild: f, secondChild: s }
      }
      const newRoot = fixActive(state.layout.root)
      return {
        hiddenTabSessions: next,
        layout: { ...state.layout, root: newRoot }
      }
    })
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

    // 移除空分屏并合并；若承载 dsh web 的 pane 因此被删，回收子进程
    newRoot = removeEmptyPanes(newRoot)
    pruneOrphanedDshWeb(newRoot)

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

    // web 插槽同步：web 钉在末尾（显式末位索引 == 追加前长度）时，新页签追加后 web 应
    // 跟着保持在末尾，否则它会跳到新页签与 MCP 页签之前；web 在中段则无需动 —— 新页签
    // 本就落在 web 之后的末位，插槽所指的相邻关系不变
    const st = get()
    const webEndPatch: { dshWebTabIndex?: number } = {}
    if (st.dshWebPaneId === targetPane.id && st.dshWebTabIndex != null &&
        st.dshWebTabIndex >= targetPane.sessions.length) {
      webEndPatch.dshWebTabIndex = newSessions.length
    }

    set({
      ...webEndPatch,
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

    // 该 session 已从其唯一所在 pane 移除(addSessionToPane 保证一个 sessionId 至多在一个 pane),
    // 顺手清理 hiddenTabSessions 残留,避免记录随关闭累积
    const nextHidden = { ...get().hiddenTabSessions }
    let hiddenChanged = false
    if (nextHidden[sessionId] !== undefined) {
      delete nextHidden[sessionId]
      hiddenChanged = true
    }

    // 如果分屏没有会话了，关闭该分屏；但若仍承载 dsh web / MCP 覆盖层则保留（覆盖层不是 session，不占会话位）
    if (newSessions.length === 0 && !isOverlayPane(paneId)) {
      newRoot = removePaneAndMerge(newRoot, paneId)
      // pane 因无会话被合并删除；若它承载 dsh web，一并关闭避免子进程残留
      pruneOrphanedDshWeb(newRoot)
      const leaves = collectLeaves(newRoot)
      set({
        ...(hiddenChanged ? { hiddenTabSessions: nextHidden } : {}),
        layout: {
          root: newRoot,
          activePaneId: leaves.length > 0 ? leaves[0].id : ''
        }
      })
    } else {
      // 终端页签清空、pane 因承载 web/MCP 页签而保留：若此刻没有任何页签在显示（刚关的是
      // 最后一个终端），自动切到剩余的 web/MCP 页签 —— 否则窗格只剩空态占位，页签悬着要手动点。
      // dsh web / 网页访问栏 / MCP 同 pane 时优先 web 系（同 pane 互斥，其余保持未激活的页签态）。
      const st = get()
      let overlayPatch: { dshWebActive?: boolean; mcpAuditActive?: boolean; dshWebTabIndex?: number; webTabs?: WebTabEntry[] } = {}
      if (newSessions.length === 0 &&
          !(st.dshWebPaneId === paneId && st.dshWebActive) &&
          !(st.mcpAuditPaneId === paneId && st.mcpAuditActive) &&
          !st.webTabs.some(t => t.paneId === paneId && t.active)) {
        if (st.dshWebPaneId === paneId) {
          overlayPatch = { dshWebActive: true }
        } else if (st.webTabs.some(t => t.paneId === paneId)) {
          // 切到该 pane 最后打开的网页页签
          const next = [...st.webTabs].reverse().find(t => t.paneId === paneId)
          if (next) overlayPatch = { webTabs: st.webTabs.map(t => t.id === next.id ? { ...t, active: true } : t) }
        } else if (st.mcpAuditPaneId === paneId) {
          overlayPatch = { mcpAuditActive: true }
        }
      }
      // web 插槽同步：被关会话在 web 页签左侧时，pane.sessions 整体左移一位，插槽索引须跟着
      // 减一，否则 web 会随左侧会话逐个关闭而向右漂移（左侧隐藏页签被关同理，索引是原始坐标）
      if (st.dshWebPaneId === paneId && st.dshWebTabIndex != null &&
          pane.sessions.indexOf(sessionId) !== -1 &&
          pane.sessions.indexOf(sessionId) < st.dshWebTabIndex) {
        overlayPatch.dshWebTabIndex = Math.max(st.dshWebTabIndex - 1, 0)
      }
      set({
        ...(hiddenChanged ? { hiddenTabSessions: nextHidden } : {}),
        ...overlayPatch,
        layout: {
          root: newRoot,
          activePaneId: paneId
        }
      })
    }
  },

  // 从所有分屏移除指定 session(批量关闭,Sidebar LIVE 段的关闭按钮用)
  removeSessionFromAllPanes: (sessionId) => {
    // 先收集所有含此 sessionId 的 pane id —— removeSessionFromPane 会改 layout 树,所以不能边遍历边删
    const targetIds = collectLeaves(get().layout.root)
      .filter(p => p.sessions.includes(sessionId))
      .map(p => p.id)
    targetIds.forEach(pid => get().removeSessionFromPane(pid, sessionId))
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

    // web 插槽同步：splice 语义下"先删后插"，插槽索引按同一坐标修正 ——
    // 左侧会话移走 → 插槽左移一位；插入点在插槽左侧 → 插槽右移一位。
    // 插入点恰好落进 web 所在空隙（toIndex==删后插槽）时按拖拽方向消歧：
    // 从左往右拖入空隙 → 新页签落 web 前面，插槽 +1；从右往左拖入 → 落 web 后面，插槽不动。
    // （若一律 +1，从右侧拖到 web 右邻页签上时 web 会被多顶一位，视觉上 web "跳过"了落点页签）
    const st = get()
    const webPatch: { dshWebTabIndex?: number } = {}
    if (st.dshWebPaneId === paneId && st.dshWebTabIndex != null) {
      const afterRemove = fromIndex < st.dshWebTabIndex ? st.dshWebTabIndex - 1 : st.dshWebTabIndex
      const bumped = toIndex < afterRemove || (toIndex === afterRemove && fromIndex < toIndex)
      const final = bumped ? afterRemove + 1 : afterRemove
      webPatch.dshWebTabIndex = Math.min(Math.max(final, 0), sessions.length)
    }

    set({
      ...webPatch,
      layout: {
        root: replacePane(layout.root, paneId, updatedPane),
        activePaneId: paneId
      }
    })
  },

  // 会话页签拖到 web 页签上的落点：把该会话插到 web 紧前或紧后并同步 web 插槽。
  // 方向语义与页签重排一致：会话原在 web 左侧（往右拖）= 插 web 后，反之插 web 前。
  insertSessionAtWebSlot: (paneId, sessionId) => {
    // 校验 web 确实挂在该 pane —— 与 moveDshWebToSessionTab 对齐，作为 store API 自防御
    if (get().dshWebPaneId !== paneId || get().dshWeb === null) return
    const layout = get().layout
    const pane = findPane(layout.root, paneId) as PaneLeaf | undefined
    if (!pane || pane.type !== 'leaf') return

    const fromOrig = pane.sessions.indexOf(sessionId)
    if (fromOrig === -1) return

    const webOrig = get().dshWebTabIndex ?? pane.sessions.length
    const sessions = [...pane.sessions]
    const [removed] = sessions.splice(fromOrig, 1)
    // 与 reorderSessionsInPane 相同的"先删后插"坐标：删后 web 原槽位可能左移一位
    const webOrigAdj = fromOrig < webOrig ? webOrig - 1 : webOrig
    sessions.splice(webOrigAdj, 0, removed)
    // 插 web 后：会话正好落进 web 原槽位，web 顺移到它右侧（槽位不变）；
    // 插 web 前：会话占住 web 槽位，web 让到它右侧（槽位 +1）
    const webIdx = fromOrig < webOrig ? webOrigAdj : webOrigAdj + 1

    set({
      dshWebTabIndex: Math.min(webIdx, sessions.length),
      layout: {
        root: replacePane(layout.root, paneId, { ...pane, sessions }),
        activePaneId: paneId
      }
    })
  },

  // web 页签拖到普通会话页签上的落点：只改 web 插槽，不动 pane.sessions。
  // 方向语义与 splice 重排对齐：往左拖落某页签 = 插它前面（取目标原坐标）；
  // 往右拖 = 插它后面（原坐标 +1，封顶末尾）—— 若恒为"插前面"，拖到右侧相邻
  // 页签上是 no-op，体感变成只能从右往左排。
  moveDshWebToSessionTab: (paneId, targetSessionId) => {
    const st = get()
    if (st.dshWebPaneId !== paneId || st.dshWeb === null) return
    const pane = findPane(st.layout.root, paneId) as PaneLeaf | undefined
    if (!pane || pane.type !== 'leaf') return

    const toOrig = pane.sessions.indexOf(targetSessionId)
    if (toOrig === -1) return

    const webOrig = st.dshWebTabIndex ?? pane.sessions.length
    set({ dshWebTabIndex: toOrig < webOrig ? toOrig : Math.min(toOrig + 1, pane.sessions.length) })
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

  getAllOpenSessionIds: () => {
    return collectOpenSessionIds(get().layout)
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
      // 恢复的树来自持久化存储，pane id 与运行时覆盖层（dshWeb/MCP/webTabs，瞬态）的挂载
      // id 对不上 —— 统一按孤儿回收，避免僵尸条目（不渲染也清不掉）
      pruneOrphanedDshWeb(savedLayout.root)
    }
  }
}))

// 自动保存布局变化
subscribeToLayoutChanges(usePaneStore)

// 自动同步终端打开会话集合到主进程
subscribeToTerminalOpenSessionsSync(usePaneStore)
