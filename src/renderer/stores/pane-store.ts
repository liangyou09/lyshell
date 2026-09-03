import { create } from 'zustand'
import type {
  PaneNode, PaneLeaf, PaneSplit, PaneLayout, SplitDirection,
  OverlayKind, OverlayRef, OverlayPayload, DocOverlayPayload
} from '@shared/types'
import { OVERLAY_KINDS, MCP_AUDIT_OVERLAY_ID } from './overlay-kinds'

/**
 * 分屏状态管理 —— 归一化覆盖层模型
 *
 * 「占据 pane 的东西」共五种：终端会话 + 四种覆盖层（web / doc / dshWeb / mcpAudit）。
 * 覆盖层拆成两半：
 *   - 挂载态（OverlayRef：id/kind/active/slot）挂在 pane 树叶子上，随树操作自然迁移；
 *   - 内容（OverlayPayload）按 id 存在本 store 的 overlayPayloads 字典。
 * 种类行为（单例 / 关闭回落 / 自动激活优先级 / 关闭副作用）查 overlay-kinds 注册表。
 * 新增一种覆盖层不再需要逐触点手工枚举 —— 树函数与通用操作按 refs 数组统一迭代。
 *
 * 覆盖层全部瞬态：持久化只存剥离 overlays 的布局树，重启即回收。
 */

// 布局持久化 key
const LAYOUT_STORAGE_KEY = 'lyshell_pane_layout'

// 网页访问栏历史持久化 key + 封顶条数（去重后按最近优先，超量截尾）
const WEB_TAB_HISTORY_KEY = 'lyshell.webTabHistory.v1'
const WEB_TAB_HISTORY_MAX = 30

// 「最近访问」各 URL 的 favicon data URI 映射（key=URL）。随历史同生命周期：保存时
// 裁剪到当前历史键，删除/清空历史同步移除，不会无限增长。
const WEB_TAB_FAVICON_KEY = 'lyshell.webTabFavicons.v1'

// favicon data URI 字符上限：主进程侧限制原始图 ≤512KB，base64 后 ≈683k 字符，取整
// 700k。读取（loadWebTabFavicons）与写入（setWebTabFavicon）两侧都卡这道闸——坏/被
// 注入的 localStorage 超长字符串不至于直写 DOM。
const WEB_TAB_FAVICON_MAX_CHARS = 700_000

/** 从 localStorage 读 favicon 映射（坏数据容错为空对象；只收 data:image/* 且限长）。纯函数，便于单测。 */
export function loadWebTabFavicons(): Record<string, string> {
  try {
    const raw = localStorage.getItem(WEB_TAB_FAVICON_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.startsWith('data:image/') && v.length <= WEB_TAB_FAVICON_MAX_CHARS) {
        out[k] = v
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 写回 localStorage（失败静默降级为仅内存态，与历史持久化同策略）。纯函数，便于单测。 */
function persistWebTabFavicons(map: Record<string, string>): void {
  try {
    localStorage.setItem(WEB_TAB_FAVICON_KEY, JSON.stringify(map))
  } catch { /* 隐私模式/存储满 */ }
}

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

// zustand store 的最小订阅结构（初始化时 usePaneStore 尚未赋值，只能按结构类型传参）
interface PaneStoreSubscription {
  subscribe: (listener: (state: PaneStore, prevState: PaneStore) => void) => void
}

// 自动保存布局的订阅函数。覆盖层瞬态：存前剥离 refs（树只落终端布局，重启无残留）。
// 尾随去抖（300ms）：拖分屏调宽时 setSplitRatio 每个 pointermove 触发一次 layout 写入，
// 逐次「克隆树 + stringify + 同步 setItem」会卡主线程 —— 去抖后一段连续变更只在
// 停顿 300ms 后落一次盘，拖拽全程零写。pagehide 冲刷兜底关窗/刷新前的最后一次变更。
// 序列化结果缓存比对：覆盖层激活/插槽等只改 refs 的变更剥离后字节级不变，跳过写。
// 缓存只在写成功后更新 —— 若先记后写，一次 setItem 抛异常（配额满/禁存储）会把
// 缓存毒化，之后所有 refs-only 变更都命中「字节级相同」早退，旧布局永远写不回去
const subscribeToLayoutChanges = (store: PaneStoreSubscription) => {
  let lastSerialized: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: PaneLayout | null = null
  const flush = () => {
    timer = null
    if (!latest) return
    const layout = latest
    latest = null
    try {
      const serialized = JSON.stringify({ ...layout, root: stripOverlays(layout.root) })
      if (serialized === lastSerialized) return
      localStorage.setItem(LAYOUT_STORAGE_KEY, serialized)
      lastSerialized = serialized
    } catch (e) {
      console.warn('Failed to save pane layout:', e)
    }
  }
  store.subscribe((state: PaneStore, prevState: PaneStore) => {
    // 只在布局变化时保存（订阅回调直接捕获最新 layout，flush 不依赖 getState）
    if (state.layout !== prevState.layout) {
      latest = state.layout
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, 300)
    }
  })
  window.addEventListener('pagehide', () => {
    if (timer !== null) {
      clearTimeout(timer)
      flush()
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
const subscribeToTerminalOpenSessionsSync = (store: PaneStoreSubscription) => {
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

  // ===== 归一化覆盖层 =====
  // id → payload 字典。瞬态：不随布局持久化；引用（OverlayRef）挂在树叶子上的才是挂载点，
  // 树操作丢掉引用后由 pruneOverlayPayloads 按孤儿回收（含关闭副作用）。
  overlayPayloads: Record<string, OverlayPayload>
  // 拖拽中的覆盖层实例 id（null=无）。拖拽期间 PaneView 挂拖拽盾盖住会吞拖拽事件的
  // webview/iframe 系覆盖层，使 drop 落区暴露。瞬态。
  draggingOverlayId: string | null
  setDraggingOverlay: (id: string | null) => void
  // 拖拽中的会话页签 id（null=无）。与覆盖层标记对称：落区分流按「会话优先」消歧，
  // 同时也是拖拽盾的挂起条件之一 —— 会话拖拽经过 webview 系覆盖层同样被吞事件。
  // 瞬态。（取代原 SplitPaneContainer 模块变量：盾需要响应式订阅，模块变量做不到）
  draggingSessionId: string | null
  setDraggingSession: (id: string | null) => void
  // 通用核心操作 —— 所有种类共用；种类差异全部由 overlay-kinds 注册表驱动
  mountOverlay: (paneId: string | undefined, payload: OverlayPayload, opts?: { id?: string }) => string | null  // 挂载并激活，返回实例 id（无可用 pane 返回 null）
  activateOverlay: (id: string) => void       // 激活（叶子内跨种类 radio + activePaneId 切换）
  deactivateOverlay: (id: string) => void     // 仅隐藏（页签保留）
  closeOverlay: (id: string) => void          // 真正关闭（回落/副作用/纯覆盖层 pane 回并）
  closeOverlaysInPane: (paneId: string, kind?: OverlayKind) => void
  deactivateOverlaysInPane: (paneId: string, kind?: OverlayKind) => void  // 隐藏本 pane 全部（或指定种类）覆盖层
  moveOverlayToPane: (id: string, paneId: string) => void  // 拖到 pane 中心：改挂载（源 pane 空出即回并）
  splitOverlayIntoPane: (id: string, paneId: string, direction: SplitDirection, position: 'first' | 'second') => void  // 拖到 pane 边：拆独立 pane
  setOverlaySlot: (id: string, index: number | null) => void  // 页签条内插槽（RAW 坐标；null=钉尾）
  moveOverlayToSessionTab: (id: string, paneId: string, targetSessionId: string) => void  // 页签拖到普通会话页签上：只写插槽
  insertSessionAtOverlaySlot: (id: string, paneId: string, sessionId: string) => void    // 会话页签拖到覆盖层页签上：插入 + 插槽同步
  // 通用查询
  getOverlayPayload: (id: string) => OverlayPayload | undefined
  getOverlayPaneId: (id: string) => string | null
  isOverlayActive: (id: string) => boolean
  getOverlayByKind: (kind: OverlayKind) => { paneId: string; ref: OverlayRef; payload: OverlayPayload } | null
  activeOverlayInPane: (paneId: string) => OverlayRef | null

  // ===== 有独立语义/生产调用者的种类入口（纯委托门面已删，直接用上方通用操作） =====
  openMcpAuditInPane: (paneId: string) => void
  closeMcpAudit: () => void
  openDshWebInPane: (paneId: string, info: { url: string; name: string; cwd?: string }) => void
  openWebTab: (rawUrl: string, paneId?: string) => { ok: true } | { ok: false; error: string }
  setWebTabTitle: (id: string, title: string) => void
  setWebTabFavicon: (id: string, favicon: string) => void
  openDocTab: (paneId: string | undefined, info: DocOverlayPayload) => string
  updateDocTab: (id: string, patch: Partial<Pick<DocOverlayPayload, 'content' | 'size' | 'mtime' | 'title' | 'loadError'>>) => void
  closeDocTab: (id: string) => void

  // ===== 网页访问栏历史（与挂载无关，localStorage 持久化） =====
  // 实际加载成功（did-finish-load）过的 URL（去重、最近优先、封顶）。页签本身瞬态，
  // 这里只记 URL 供「最近访问」列表与输入框补全。记录时机在 WebTabOverlay 的
  // did-finish-load 回调（recordWebTabVisit），而非 openWebTab —— 打开但没加载出来
  // （DNS 失败/超时）的 URL 不算「访问过」。
  webTabHistory: string[]
  webTabFavicons: Record<string, string>  // 历史 URL → favicon data URI（随历史同生命周期）
  recordWebTabVisit: (url: string) => void
  removeWebTabHistory: (url: string) => void
  clearWebTabHistory: () => void

  // 操作方法
  splitPane: (paneId: string, direction: SplitDirection, sessionId?: string) => void
  splitPaneWithPosition: (paneId: string, direction: SplitDirection, sessionId: string, position: 'first' | 'second') => void
  closePane: (paneId: string) => void
  setActivePane: (paneId: string) => void
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
  swapPanePosition: (paneId: string) => void  // 交换分屏位置

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
    activeSessionId: null,
    overlays: []
  },
  activePaneId: ''
})

// 查找分屏节点
export const findPane = (node: PaneNode, paneId: string): PaneNode | undefined => {
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

// ───────────── 覆盖层树操作（全部纯函数：只吃树、只吐树） ─────────────

// 按实例 id 找覆盖层引用及其所在叶子
export const findOverlayRef = (root: PaneNode, id: string): { leaf: PaneLeaf; ref: OverlayRef } | undefined => {
  for (const leaf of collectLeaves(root)) {
    const ref = leaf.overlays.find(r => r.id === id)
    if (ref) return { leaf, ref }
  }
  return undefined
}

// 按种类找第一个覆盖层引用及其所在叶子（单例查找 / getOverlayByKind 用；无外部导入方）
const findOverlayByKind = (root: PaneNode, kind: OverlayKind): { leaf: PaneLeaf; ref: OverlayRef } | undefined => {
  for (const leaf of collectLeaves(root)) {
    const ref = leaf.overlays.find(r => r.kind === kind)
    if (ref) return { leaf, ref }
  }
  return undefined
}

// 对全部叶子应用变换（fn 须在无改动时返回原对象）
const editLeaves = (root: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode => {
  if (root.type === 'leaf') return fn(root)
  const f = editLeaves(root.firstChild, fn)
  const s = editLeaves(root.secondChild, fn)
  if (f === root.firstChild && s === root.secondChild) return root
  return { ...root, firstChild: f, secondChild: s }
}

// 对指定叶子应用变换 —— editLeaves 的 id 守卫特化（其余叶子原样返回，故整棵树的
// 引用稳定性语义与全量版一致：无改动时各 split 原对象返回，不重建树）
const editLeaf = (root: PaneNode, paneId: string, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode =>
  editLeaves(root, leaf => (leaf.id === paneId ? fn(leaf) : leaf))

// 对某覆盖层引用应用变换（无该 id 时原样返回）
const editRef = (root: PaneNode, id: string, fn: (ref: OverlayRef) => OverlayRef): PaneNode =>
  editLeaves(root, leaf => leaf.overlays.some(r => r.id === id)
    ? { ...leaf, overlays: leaf.overlays.map(r => r.id === id ? fn(r) : r) }
    : leaf)

// 从树上摘除某实例 id 的引用（无则原样返回）
const removeRefFromTree = (root: PaneNode, id: string): PaneNode =>
  editLeaves(root, leaf => leaf.overlays.some(r => r.id === id)
    ? { ...leaf, overlays: leaf.overlays.filter(r => r.id !== id) }
    : leaf)

// ───────────── slotted 插槽不变量（唯一事实源） ─────────────
// 插槽是 pane.sessions 的原始坐标插入位，会话数组的增删/重排必须同步重定基插槽。
// 此前这套不变量在四个调用点各抄一份、已各漂移过一次（「移走页签」漏衰减、
// 「只调目标自身」每操作漂移一位）—— 收敛成两个纯函数，改语义只可能改到一处。

/** 会话从叶子移除后的插槽衰减：被移会话在插槽左侧（原始坐标）→ 插槽减一。
 *  「移走页签」（removeSessionFromAllPanes）与「关闭页签」（removeSessionFromPane）
 *  共用；removedIndex === -1（不在本叶子）时原样返回 */
const decaySlotsAfterRemoval = (overlays: OverlayRef[], removedIndex: number): OverlayRef[] =>
  overlays.map(r => {
    if (r.slot == null || removedIndex === -1 || removedIndex >= r.slot) return r
    const slot = Math.max(r.slot - 1, 0)
    return slot === r.slot ? r : { ...r, slot }
  })

/** 会话「先删后插」移动后的插槽重定基（insertSessionAtOverlaySlot 的兄弟联动 /
 *  reorderSessionsInPane 共用）。fromIndex 是原始坐标删除位，insertAt 是删后坐标
 *  插入位，maxSlot 是插完后的 sessions.length（钳顶用）：
 *  - 删除步：被移会话在插槽左侧（原始坐标）→ 插槽衰减一位
 *  - 插入步：插入点在衰减插槽左侧 → 插槽 +1；右侧 → 不动
 *  - 平局（插入点恰落衰减插槽上，新会话落进覆盖层所在空隙）：判据必须用「插槽曾被
 *    删除步衰减」（fromIndex < r.slot，原始坐标）—— 此时覆盖层在空隙右半，新会话
 *    从左侧来落它前面，插槽 +1 弹回；否则从右侧来落它后面，插槽不动。若误用移动
 *    方向（fromIndex < insertAt），「原地不动」型移动（两者相等）会被误判为左向，
 *    覆盖层左跳一位 */
const rebaseSlotsForMove = (
  overlays: OverlayRef[],
  fromIndex: number,
  insertAt: number,
  maxSlot: number
): OverlayRef[] =>
  overlays.map(r => {
    if (r.slot == null) return r
    const afterRemove = fromIndex < r.slot ? r.slot - 1 : r.slot
    const bumped = insertAt < afterRemove || (insertAt === afterRemove && fromIndex < r.slot)
    const final = Math.min(Math.max(bumped ? afterRemove + 1 : afterRemove, 0), maxSlot)
    // 插槽不变的引用原样返回：OverlayRef 的引用身份是渲染层 React.memo 的
    // 跳过依据（PaneView 注释），全量重建会让整 pane 的文档面板重跑 react-markdown
    return final === r.slot ? r : { ...r, slot: final }
  })

// 持久化时剥离覆盖层引用（瞬态语义：重启即回收，树只存终端布局）
const stripOverlays = (node: PaneNode): PaneNode =>
  node.type === 'leaf'
    ? (node.overlays.length === 0 ? node : { ...node, overlays: [] })
    : {
        ...node,
        firstChild: stripOverlays(node.firstChild),
        secondChild: stripOverlays(node.secondChild)
      }

// ───────────── 空叶判定 / 回并（纯函数，覆盖层保护 = leaf.overlays.length > 0） ─────────────

// 承载覆盖层的 pane 即便没有终端会话也不应被判为空删除 —— 覆盖层不是 session，不占会话位，
// 但 pane 树是它唯一的挂载点。保护判定直接看叶子自身，不读 store（也顺带消掉了旧实现
// 在 store 初始化期读取 usePaneStore 的 TDZ 雷与 dshWebPaneIdOverride 补丁）。
const isEmptyLeaf = (node: PaneNode): node is PaneLeaf =>
  node.type === 'leaf' && node.sessions.length === 0 && node.overlays.length === 0

// 移除所有空分屏并合并。keepId：豁免回收的叶子 id —— 「会话正要落入的目标 pane」
// 此刻必然是空的，但在本次操作内马上承接会话，不能被中途回收（否则目标被合并、
// 会话落进 leaves[0] 兜底：拖进空 pane 变成跨 pane 传送或 drop 被静默吞掉）
const removeEmptyPanes = (root: PaneNode, keepId?: string): PaneNode => {
  if (root.type === 'split') {
    const newFirstChild = removeEmptyPanes(root.firstChild, keepId)
    const newSecondChild = removeEmptyPanes(root.secondChild, keepId)

    // keepId 豁免：被保护叶子即便空也视作不空（承口在本次操作内保留）
    const firstEmpty = isEmptyLeaf(newFirstChild) && newFirstChild.id !== keepId
    const secondEmpty = isEmptyLeaf(newSecondChild) && newSecondChild.id !== keepId

    // 如果两个都空，返回空叶子
    if (firstEmpty && secondEmpty) {
      return {
        id: root.id,
        type: 'leaf',
        sessions: [],
        activeSessionId: null,
        overlays: []
      }
    }
    // 如果第一个空，用第二个替换
    if (firstEmpty) return newSecondChild
    // 如果第二个空，用第一个替换
    if (secondEmpty) return newFirstChild
    // 都不空，保持 split
    return {
      ...root,
      firstChild: newFirstChild,
      secondChild: newSecondChild
    }
  }
  return root
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
        activeSessionId: null,
        overlays: []
      }
    }

    // 找到另一个子节点
    const otherChild = parent.firstChild.id === targetId ? parent.secondChild : parent.firstChild

    // 用另一个子节点替换父节点
    newRoot = replacePane(node, parent.id, otherChild)

    // 检查合并后的节点是否是空的叶子，如果是，继续向上合并
    if (isEmptyLeaf(otherChild)) {
      // 继续向上合并
      return merge(newRoot, otherChild.id)
    }

    return newRoot
  }

  return merge(root, paneId)
}

// 树整体替换 / 删叶后回收悬空 payload：引用不在树中的覆盖层按孤儿回收（含关闭副作用，
// dsh web 由此杀子进程）。返回可直接并入 set() 的 patch；无孤儿时为空对象。
// 被回收的实例若正处于拖拽中，draggingOverlayId 一并清空（对齐 closeOverlay /
// closeOverlaysInPane）—— 否则残留标记会让 webview 系覆盖层卡在拖拽期隐藏态。
const pruneOverlayPayloads = (
  root: PaneNode,
  payloads: Record<string, OverlayPayload>,
  draggingOverlayId?: string | null
): { overlayPayloads?: Record<string, OverlayPayload>; draggingOverlayId?: null } => {
  const ids = new Set<string>()
  const walk = (node: PaneNode): void => {
    if (node.type === 'leaf') node.overlays.forEach(r => ids.add(r.id))
    else { walk(node.firstChild); walk(node.secondChild) }
  }
  walk(root)
  const dangling = Object.entries(payloads).filter(([id]) => !ids.has(id))
  if (dangling.length === 0) return {}
  const next = { ...payloads }
  for (const [id, payload] of dangling) {
    OVERLAY_KINDS[payload.kind].closeSideEffect?.(payload)
    delete next[id]
  }
  return draggingOverlayId && dangling.some(([id]) => id === draggingOverlayId)
    ? { overlayPayloads: next, draggingOverlayId: null }
    : { overlayPayloads: next }
}

// 关闭/移除 pane 后的焦点兜底（settleLayoutAfterPrune / closePane /
// removeSessionFromPane 共用同一语义）：activePaneId 仍有效则保持 —— 此前
// closePane / removeSessionFromPane 无条件重置 leaves[0]，关后台 pane 会把焦点
// 抢到第一个 pane、关中间 pane 焦点不去吸收侧。失效则优先「吸收侧」：closedPaneId
// 在回并前原树里兄弟子树的首个存活叶子（兄弟子树整体接管 closedPaneId 让出的空间，
// 焦点落它身上最近于原地）；再退而求整树首个叶子。activePaneId 悬空会让
// mountOverlay（target 解析到死 id 返回 null）与快捷命令派发（find 不到活动
// pane）静默失效，直到用户手动点某个 pane
const settleActivePaneAfterClose = (
  treeAfterClose: PaneNode,
  treeBeforeClose: PaneNode,
  closedPaneId: string,
  activePaneId: string
): string => {
  if (findPane(treeAfterClose, activePaneId)) return activePaneId
  const parent = findParent(treeBeforeClose, closedPaneId)
  const sibling = parent
    ? (parent.firstChild.id === closedPaneId ? parent.secondChild : parent.firstChild)
    : undefined
  const siblingLeaf = sibling
    ? collectLeaves(sibling).find(l => findPane(treeAfterClose, l.id))
    : undefined
  return siblingLeaf?.id ?? collectLeaves(treeAfterClose)[0]?.id ?? activePaneId
}

// 关闭覆盖层后的空 pane 回并 + 焦点兜底：纯覆盖层 pane（拆屏产物）空出即从树里清掉、
// split 随之回并（分屏还原）。焦点兜底收敛在 settleActivePaneAfterClose —— 无 pane
// 被清时 activePaneId 必然仍有效，由它直接保持
const settleLayoutAfterPrune = (root: PaneNode, closedPaneId: string, activePaneId: string): PaneLayout => {
  const pruned = removeEmptyPanes(root)
  return { root: pruned, activePaneId: settleActivePaneAfterClose(pruned, root, closedPaneId, activePaneId) }
}

// 关闭管线尾部（closeOverlay / closeOverlaysInPane 共享）：回并空 pane → 回收 payload
// + 关闭副作用 → 拖拽标记复位 → 单次 set。此前两入口各抄一份，doomed 谓词曾在
// 复制中反转（留下僵尸 ref / 泄漏孤儿 payload，契约套件混合种类 case 锁死）——
// 收敛成一个函数，关闭生命周期只有一个事实源，后续改动不可能只改到一半。
// payload 回收直接委托 pruneOverlayPayloads：以回并后的树推导悬空集，是 doomed
// 显式名单的超集（顺带兜底清掉任何非预期孤儿），副作用/拖拽复位语义与其一致
const closeRefsTail = (
  st: Pick<PaneStore, 'overlayPayloads' | 'layout' | 'draggingOverlayId'>,
  commit: (patch: Partial<PaneStore>) => void,
  rootAfterRemove: PaneNode,
  prunedLeafId: string
): void => {
  const layout = settleLayoutAfterPrune(rootAfterRemove, prunedLeafId, st.layout.activePaneId)
  commit({ ...pruneOverlayPayloads(layout.root, st.overlayPayloads, st.draggingOverlayId), layout })
}

// ───────────── 会话树操作 ─────────────

// 从所有分屏中移除指定会话（跨 pane 移动路径：addSessionToPane / splitPane*）
const removeSessionFromAllPanes = (root: PaneNode, sessionId: string): PaneNode => {
  if (root.type === 'leaf') {
    const newSessions = root.sessions.filter(s => s !== sessionId)
    const newActiveId = root.activeSessionId === sessionId
      ? (newSessions.length > 0 ? newSessions[0] : null)
      : root.activeSessionId
    // 插槽衰减（decaySlotsAfterRemoval 唯一事实源）：
    // 「移走页签」与「关闭页签」对插槽的语义必须一致 —— 此前纯函数版漏了这步
    const overlays = decaySlotsAfterRemoval(root.overlays, root.sessions.indexOf(sessionId))
    return {
      ...root,
      sessions: newSessions,
      activeSessionId: newActiveId,
      overlays
    }
  }
  return {
    ...root,
    firstChild: removeSessionFromAllPanes(root.firstChild, sessionId),
    secondChild: removeSessionFromAllPanes(root.secondChild, sessionId)
  }
}

// 过滤无效的 sessionId，清理空分屏。持久化读入路径专用：树来自 localStorage，
// 覆盖层瞬态不落盘，这里强制归零 refs（防手改存储注入垃圾引用）
const filterValidSessions = (root: PaneNode, validSessionIds: Set<string>): PaneNode => {
  if (root.type === 'leaf') {
    const validSessions = root.sessions.filter(s => validSessionIds.has(s))
    const validActiveId = root.activeSessionId && validSessionIds.has(root.activeSessionId)
      ? root.activeSessionId
      : (validSessions.length > 0 ? validSessions[0] : null)
    return {
      ...root,
      sessions: validSessions,
      activeSessionId: validActiveId,
      overlays: []
    }
  }
  return {
    ...root,
    firstChild: filterValidSessions(root.firstChild, validSessionIds),
    secondChild: filterValidSessions(root.secondChild, validSessionIds)
  }
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

// 在应用启动时加载保存的布局（纯函数：removeEmptyPanes 已无 store 读取，初始化期调用安全）。
// 导出便于单测（与 loadWebTabHistory 同例）：持久化契约（保存剥离 overlays / 读取
// 强制清空注入的 overlays）由 pane-store.persistence.test 锁定
export const loadSavedLayout = (validSessionIds: string[]) => {
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

  overlayPayloads: {},
  draggingOverlayId: null,
  draggingSessionId: null,

  // 网页访问栏的持久化伴生数据（与挂载无关，保留原顶层形态）
  webTabHistory: loadWebTabHistory(),
  webTabFavicons: loadWebTabFavicons(),

  setDraggingOverlay: (id) => {
    // 同值短路：SplitPaneContainer 的 pointerdown/dragend 兜底每次点击都会清，
    // 无短路会生成新 state 通知全部订阅者，整窗点击变成全量订阅回调重跑
    if (get().draggingOverlayId !== id) set({ draggingOverlayId: id })
  },

  setDraggingSession: (id) => {
    // 同值短路：与 setDraggingOverlay 同因（兜底监听每次点击都清）
    if (get().draggingSessionId !== id) set({ draggingSessionId: id })
  },

  // ===== 通用核心操作 =====
  mountOverlay: (paneId, payload, opts) => {
    const st = get()
    const def = OVERLAY_KINDS[payload.kind]
    const target = paneId || st.layout.activePaneId || st.getAllLeafPanes()[0]?.id
    if (!target) return null
    const targetLeaf = findPane(st.layout.root, target)
    if (!targetLeaf || targetLeaf.type !== 'leaf') return null

    // 实例 id：显式复用（doc 同路径刷新）> 单例既有 id（跨 pane 重挂 / 原位重开）
    // > 单例哨兵（已关闭后重开，保住 data-tab-id/DOM 锚点身份）> 新生成（多开种类）
    const existingSingleton = def.singleton ? findOverlayByKind(st.layout.root, payload.kind)?.ref.id : undefined
    const id = opts?.id ?? existingSingleton ?? def.singletonId ?? `${def.idPrefix ?? `${payload.kind}-`}${generateId()}`

    const existing = findOverlayRef(st.layout.root, id)
    let root: PaneNode
    if (existing && existing.leaf.id === target) {
      // 同 pane 原位重开：保持页签序（remove+append 会把它顶到末尾），只做叶子内 radio 激活。
      // 插槽：单例（dshWeb）重开即复位钉尾（既有语义，契约测试锁定）；多开种类（doc/web）
      // 保留现值 —— 用户拖出来的位置不该被一次「重新打开同一文件/链接」无声抹掉。
      // 引用身份保持：active/slot 没变的 ref 原样返回（渲染层 React.memo 的跳过依据）
      root = editLeaf(st.layout.root, target, leaf => ({
        ...leaf,
        overlays: leaf.overlays.map(r => {
          if (r.id === id) {
            const slot = def.singleton ? null : r.slot
            return r.active && slot === r.slot ? r : { ...r, active: true, slot }
          }
          return r.active ? { ...r, active: false } : r
        })
      }))
    } else {
      // 摘旧引用（单例换 pane / 显式复用迁移）→ 追加到目标叶子（radio 掉既有覆盖层，
      // 互斥：webview 是原生视图，同 z-index 按 DOM 顺序互盖）→ 回并空出的源 pane。
      // 顺序保证目标 pane 在 prune 前已持有新 ref，不会被误清；radio 同样保持
      // 未激活引用的身份（原已是 active:false 的不必新建对象）
      root = removeRefFromTree(st.layout.root, id)
      root = editLeaf(root, target, leaf => ({
        ...leaf,
        overlays: [...leaf.overlays.map(r => r.active ? { ...r, active: false } : r), { id, kind: payload.kind, active: true, slot: null }]
      }))
      root = removeEmptyPanes(root)
    }
    set({
      overlayPayloads: { ...st.overlayPayloads, [id]: payload },
      layout: { root, activePaneId: target }
    })
    return id
  },

  activateOverlay: (id) => {
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found) return
    // 叶子内跨种类 radio（互斥的唯一点）；activePaneId 切到承载 pane，保证分屏高亮环
    // 与状态栏判定一致。身份保持：active 未变的引用原样返回 —— 渲染层 React.memo
    // 靠引用身份跳过重渲染，全量重建会让点一次页签就重跑整 pane 的 react-markdown
    set({
      layout: {
        root: editLeaf(st.layout.root, found.leaf.id, leaf => ({
          ...leaf,
          overlays: leaf.overlays.map(r => {
            if (r.id === id) return r.active ? r : { ...r, active: true }
            return r.active ? { ...r, active: false } : r
          })
        })),
        activePaneId: found.leaf.id
      }
    })
  },

  deactivateOverlay: (id) => {
    const st = get()
    if (!findOverlayRef(st.layout.root, id)) return
    set({
      layout: {
        ...st.layout,
        root: editRef(st.layout.root, id, r => ({ ...r, active: false }))
      }
    })
  },

  closeOverlay: (id) => {
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found) return
    const { leaf, ref } = found
    const remaining = leaf.overlays.filter(r => r.id !== id)
    // 关掉激活页签 → 浏览器惯例：切到同 pane 同种类最后一个；没有则回到终端
    //（activeSessionId 不曾被动过，覆盖层卸载即显示）
    const fallback = ref.active && OVERLAY_KINDS[ref.kind].fallbackToLastInPane
      ? [...remaining].reverse().find(r => r.kind === ref.kind)
      : undefined
    const rootAfterRemove = editLeaf(st.layout.root, leaf.id, l => ({
      ...l,
      overlays: fallback
        ? remaining.map(r => r.id === fallback.id ? { ...r, active: true } : r)
        : remaining
    }))
    // 拆屏产生的纯覆盖层 pane 空出即回并（removeEmptyPanes 的 overlays 保护），
    // payload 回收 / 副作用 / 拖拽复位在共享尾部 closeRefsTail
    closeRefsTail(st, set, rootAfterRemove, leaf.id)
  },

  closeOverlaysInPane: (paneId, kind) => {
    const st = get()
    const leaf = findPane(st.layout.root, paneId)
    if (leaf?.type !== 'leaf') return
    const doomed = leaf.overlays.filter(r => !kind || r.kind === kind)
    if (doomed.length === 0) return
    // 树上保留的是 doomed 的补集（曾把 doomed 谓词原样抄到这里 —— 种类过滤整个反转，
    // 混合 pane 里留下僵尸 ref / 泄漏孤儿 payload；契约套件的混合种类 case 锁死）
    const rootAfterRemove = editLeaf(st.layout.root, paneId, l => ({
      ...l,
      overlays: kind ? l.overlays.filter(r => r.kind !== kind) : []
    }))
    closeRefsTail(st, set, rootAfterRemove, paneId)
  },

  deactivateOverlaysInPane: (paneId, kind) => {
    const st = get()
    const leaf = findPane(st.layout.root, paneId)
    if (leaf?.type !== 'leaf') return
    if (!leaf.overlays.some(r => r.active && (!kind || r.kind === kind))) return
    set({
      layout: {
        ...st.layout,
        root: editLeaf(st.layout.root, paneId, l => ({
          ...l,
          overlays: l.overlays.map(r => (r.active && (!kind || r.kind === kind)) ? { ...r, active: false } : r)
        }))
      }
    })
  },

  moveOverlayToPane: (id, paneId) => {
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found || !paneId || paneId === found.leaf.id) return
    const targetLeaf = findPane(st.layout.root, paneId)
    if (targetLeaf?.type !== 'leaf') return
    const payload = st.overlayPayloads[id]
    if (!payload) return
    // 委托 mountOverlay 的迁移分支（摘旧挂载 → 追加目标 radio → 回并源 pane），
    // 不再手抄一份 —— OverlayRef 只有 {id,kind,active,slot}，原样搬过去等价于
    // 新建 ref，但漂移风险少一处。同 pane 守卫保留：mountOverlay 的同 pane 分支
    // 是「原位重开保序」语义，不是迁移
    get().mountOverlay(paneId, payload, { id })
  },

  splitOverlayIntoPane: (id, paneId, direction, position) => {
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found) return
    const targetLeaf = findPane(st.layout.root, paneId)
    if (targetLeaf?.type !== 'leaf') return

    // 目标 pane 拆出拖拽覆盖层后仍有内容可留（终端会话，或其他覆盖层 —— 纯文档
    // pane 里 a.md/b.md 对拆、文档压着驻留 web 拆都是合法诉求）才拆屏；无可留
    // 内容（无会话且除拖拽项外无覆盖层，含拖回自己所在的纯覆盖层 pane）无屏可
    // 拆，退化为改挂载
    const keepHasContent = targetLeaf.sessions.length > 0 ||
      targetLeaf.overlays.some(r => r.id !== id)
    if (!keepHasContent) {
      get().moveOverlayToPane(id, paneId)
      return
    }

    const keepPaneId = generateId()
    const overlayPaneId = generateId()
    // 会话留在 keep 侧（目标叶子其余覆盖层随迁），拖拽的覆盖层拆到独立侧；
    // 旧 pane id 被 split 节点顶替
    const keepLeaf: PaneLeaf = {
      id: keepPaneId, type: 'leaf',
      sessions: targetLeaf.sessions, activeSessionId: targetLeaf.activeSessionId,
      overlays: targetLeaf.overlays.filter(r => r.id !== id)
    }
    const overlayLeaf: PaneLeaf = {
      id: overlayPaneId, type: 'leaf',
      sessions: [], activeSessionId: null,
      overlays: [{ ...found.ref, active: true, slot: null }]
    }
    const newSplit: PaneSplit = {
      id: targetLeaf.id,
      type: 'split',
      direction,
      splitRatio: 0.5,
      firstChild: position === 'first' ? overlayLeaf : keepLeaf,
      secondChild: position === 'first' ? keepLeaf : overlayLeaf
    }
    // 先从源叶子摘除（源可能是目标自身，也可能是另一 pane 的纯覆盖层 pane），
    // 再替换目标叶子为 split，最后回并空出的源 pane —— 单次 set 完成
    const root = removeEmptyPanes(replacePane(removeRefFromTree(st.layout.root, id), paneId, newSplit))
    set({ layout: { root, activePaneId: overlayPaneId } })
  },

  setOverlaySlot: (id, index) => {
    // 收紧 API：未挂载时索引无意义（重开/关闭路径都直接复位，不走这里）；
    // 挂载时 clamp 到 [0, 承载 pane 会话数]，组件侧传入的坐标不要求自身保证边界
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found) return
    if (index === null) {
      set({ layout: { ...st.layout, root: editRef(st.layout.root, id, r => ({ ...r, slot: null })) } })
      return
    }
    set({
      layout: {
        ...st.layout,
        root: editRef(st.layout.root, id, r => ({ ...r, slot: Math.min(Math.max(index, 0), found.leaf.sessions.length) }))
      }
    })
  },

  // 会话页签拖到覆盖层页签上的落点：把该会话插到覆盖层紧前或紧后并同步插槽。
  // 方向语义与页签重排一致：会话原在覆盖层左侧（往右拖）= 插其后，反之插其前。
  insertSessionAtOverlaySlot: (id, paneId, sessionId) => {
    // 校验覆盖层确实挂在该 pane —— 与 moveOverlayToSessionTab 对齐，作为 store API 自防御
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found || found.leaf.id !== paneId) return

    const fromOrig = found.leaf.sessions.indexOf(sessionId)
    if (fromOrig === -1) return

    const slotOrig = found.ref.slot ?? found.leaf.sessions.length
    const sessions = [...found.leaf.sessions]
    const [removed] = sessions.splice(fromOrig, 1)
    // 与 reorderSessionsInPane 相同的"先删后插"坐标：删后覆盖层原槽位可能左移一位
    const slotAdj = fromOrig < slotOrig ? slotOrig - 1 : slotOrig
    sessions.splice(slotAdj, 0, removed)
    // 插覆盖层后：会话正好落进原槽位，覆盖层顺移到它右侧（槽位不变）；
    // 插覆盖层前：会话占住槽位，覆盖层让到它右侧（槽位 +1）
    const slot = fromOrig < slotOrig ? slotAdj : slotAdj + 1

    set({
      layout: {
        root: editLeaf(st.layout.root, paneId, leaf => ({
          ...leaf,
          sessions,
          // 兄弟 slotted 覆盖层重定基走 rebaseSlotsForMove 唯一事实源（与
          // reorderSessionsInPane 同一「先删后插」不变量）；目标自身的插槽用上方
          // 「落点在覆盖层哪一侧」的定向公式，不属于共享不变量
          overlays: rebaseSlotsForMove(leaf.overlays, fromOrig, slotAdj, sessions.length)
            .map(r => r.id === id ? { ...r, slot: Math.min(slot, sessions.length) } : r)
        })),
        activePaneId: paneId
      }
    })
  },

  // 覆盖层页签拖到普通会话页签上的落点：只写插槽，不动 pane.sessions。
  // 方向语义与 splice 重排对齐：往左拖落某页签 = 插它前面（取目标原坐标）；
  // 往右拖 = 插它后面（原坐标 +1，封顶末尾）—— 若恒为"插前面"，拖到右侧相邻
  // 页签上是 no-op，体感变成只能从右往左排。
  moveOverlayToSessionTab: (id, paneId, targetSessionId) => {
    const st = get()
    const found = findOverlayRef(st.layout.root, id)
    if (!found || found.leaf.id !== paneId) return
    const toOrig = found.leaf.sessions.indexOf(targetSessionId)
    if (toOrig === -1) return
    const slotOrig = found.ref.slot ?? found.leaf.sessions.length
    set({
      layout: {
        ...st.layout,
        root: editRef(st.layout.root, id, r => ({
          ...r,
          slot: toOrig < slotOrig ? toOrig : Math.min(toOrig + 1, found.leaf.sessions.length)
        }))
      }
    })
  },

  // ===== 通用查询 =====
  getOverlayPayload: (id) => get().overlayPayloads[id],
  getOverlayPaneId: (id) => findOverlayRef(get().layout.root, id)?.leaf.id ?? null,
  isOverlayActive: (id) => findOverlayRef(get().layout.root, id)?.ref.active ?? false,
  getOverlayByKind: (kind) => {
    const st = get()
    const found = findOverlayByKind(st.layout.root, kind)
    const payload = found ? st.overlayPayloads[found.ref.id] : undefined
    return found && payload ? { paneId: found.leaf.id, ref: found.ref, payload } : null
  },
  activeOverlayInPane: (paneId) => {
    const pane = findPane(get().layout.root, paneId)
    return pane?.type === 'leaf' ? pane.overlays.find(r => r.active) ?? null : null
  },

  // ===== 有独立语义/生产调用者的种类入口（纯委托门面已删，直接用上方通用操作） =====
  openMcpAuditInPane: (paneId) => {
    // 空 paneId 忽略（activePaneId 未就绪时点 chip 无害）；
    // 哨兵 id 由注册表 singletonId 兜底（挂载中沿用既有实例，已关闭则重铸哨兵）
    if (!paneId) return
    get().mountOverlay(paneId, { kind: 'mcpAudit' })
  },
  closeMcpAudit: () => get().closeOverlay(MCP_AUDIT_OVERLAY_ID),

  // dsh Web UI 页签（单例）：打开时指定承载 pane；空 paneId 回落首个叶子 pane。
  // 打开即激活；切到终端标签走 deactivate（隐藏但保留 webview 与子进程），✕ 走 close（真正回收）
  openDshWebInPane: (paneId, info) => {
    const target = paneId || get().getAllLeafPanes()[0]?.id
    if (!target) return
    get().mountOverlay(target, { kind: 'dshWeb', ...info })
  },

  // ===== 网页页签（多开，插件面板 URL 栏 / 终端 Ctrl+点击 URL 入口） =====
  openWebTab: (rawUrl, paneId) => {
    const url = normalizeWebBarUrl(rawUrl)
    if (!url) return { ok: false, error: 'invalid URL' }
    // 历史不在这里记 —— 等 WebTabOverlay 的 did-finish-load 再记（recordWebTabVisit），
    // 打开但加载失败的 URL 不进「最近访问」。
    // paneId：终端 Ctrl+点击的落点（点击终端所在 pane）；未指定回落活动 pane（URL 栏语义）
    const id = get().mountOverlay(paneId, { kind: 'web', url, title: new URL(url).hostname })
    return id ? { ok: true } : { ok: false, error: 'no pane available' }
  },
  setWebTabTitle: (id, title) => {
    if (!title) return
    set(st => {
      const payload = st.overlayPayloads[id]
      if (payload?.kind !== 'web' || payload.title === title) return {}
      return { overlayPayloads: { ...st.overlayPayloads, [id]: { ...payload, title } } }
    })
  },
  setWebTabFavicon: (id, favicon) => {
    // 超长 data URI 视为坏数据整体丢弃（主进程已限 512KB 原始图，这是存储侧第二道闸）
    if (!favicon || favicon.length > WEB_TAB_FAVICON_MAX_CHARS) return
    // 函数式 set 原子更新：多个网页页签的 favicon 异步回写交错时，
    // 各自基于最新 state 计算，不会用陈旧快照覆盖掉先完成者的映射
    set(st => {
      const payload = st.overlayPayloads[id]
      if (payload?.kind !== 'web' || payload.favicon === favicon) return {}
      // 同步落「最近访问」favicon 映射。注意 page-favicon-updated 常先于 did-finish-load
      // （历史记录时机），裁剪键集合须并入该 URL，否则刚捕获的图标会被当孤儿裁掉
      const merged = { ...st.webTabFavicons, [payload.url]: favicon }
      const keep = new Set([...st.webTabHistory, payload.url])
      const pruned: Record<string, string> = {}
      for (const u of keep) {
        if (merged[u]) pruned[u] = merged[u]
      }
      persistWebTabFavicons(pruned)
      return {
        overlayPayloads: { ...st.overlayPayloads, [id]: { ...payload, favicon } },
        webTabFavicons: pruned
      }
    })
  },

  // ===== 文档页签（多开，文件树双击 / 拖放 / Ctrl+Shift+O / 终端 Ctrl+点击入口） =====
  openDocTab: (paneId, info) => {
    const st = get()
    // 挂到指定 pane；未指定时当前活动 pane，未就绪回落首个叶子 pane（openWebTab 同型）
    const target = paneId || st.layout.activePaneId || st.getAllLeafPanes()[0]?.id
    if (!target) return ''
    // 同 pane 同来源同路径复用：刷新内容并激活（mountOverlay 原位覆写 payload），避免重复页签堆积。
    // 远端文档的身份证必须含 sessionId：/etc/os-release 在两台主机上是两份文档，
    // 只按路径匹配会把 A 主机的页签静默改嫁给 B（内容被换、失败路径还会清掉已加载内容）。
    // 复用范围刻意只限目标 pane：跨 pane 同路径各开各的（doctab 测试锁定）——
    // 分屏两侧对照阅读同一文档是正当场景，且「在这个 pane 打开」的落点语义
    // 不该被全局复用劫持成「跳去另一 pane 激活」
    const leaf = findPane(st.layout.root, target)
    const existing = leaf?.type === 'leaf'
      ? leaf.overlays.find(r => {
          const p = st.overlayPayloads[r.id]
          return r.kind === 'doc' && p?.kind === 'doc' && p.source === info.source && p.path === info.path
            && (p.source !== 'remote' || p.sessionId === info.sessionId)
        })
      : undefined
    // 开-开竞态守卫：readVersion 在读取发起时分配（readDoc 的 openVersions）。
    // 同路径并发打开时，后触发先到的响应先落盘，先触发的旧响应（含旧失败）
    // 迟到后只激活页签、不覆写内容 —— 页签不重复，内容始终是最后触发那次
    // 读取的结果。不带版本（直接调用）= 无条件覆写的刷新语义
    if (existing) {
      const p = st.overlayPayloads[existing.id]
      if (info.readVersion !== undefined && p?.kind === 'doc' && (p.readVersion ?? 0) > info.readVersion) {
        get().activateOverlay(existing.id)
        return existing.id
      }
    }
    return get().mountOverlay(target, { kind: 'doc', ...info }, existing ? { id: existing.id } : undefined) ?? ''
  },
  updateDocTab: (id, patch) => {
    // 函数式 set 原子更新：刷新回写与关闭页签并发时不会用陈旧快照
    set(st => {
      const payload = st.overlayPayloads[id]
      if (payload?.kind !== 'doc') return {}
      return { overlayPayloads: { ...st.overlayPayloads, [id]: { ...payload, ...patch } } }
    })
  },
  closeDocTab: (id) => get().closeOverlay(id),

  // ===== 网页访问栏历史 =====
  recordWebTabVisit: (url) => {
    const st = get()
    // 已在顶部（重复 did-finish-load，如页内锚点刷新）直接跳过，少一次 setState
    if (st.webTabHistory[0] === url) return
    const history = recordWebTabUrlToHistory(st.webTabHistory, url)
    try {
      localStorage.setItem(WEB_TAB_HISTORY_KEY, JSON.stringify(history))
    } catch { /* 隐私模式/存储满时静默降级为仅内存态 */ }
    // favicon 映射按截尾后的历史键同步裁剪：被 30 条封顶截掉的历史，其图标一并回收，
    // 否则映射会随时间残留脏键并持续持久化
    const favicons: Record<string, string> = {}
    for (const u of history) {
      if (st.webTabFavicons[u]) favicons[u] = st.webTabFavicons[u]
    }
    // 裁剪只会删键：长度相等即无变化，免一次无谓的 setState/落盘
    if (Object.keys(favicons).length !== Object.keys(st.webTabFavicons).length) {
      persistWebTabFavicons(favicons)
      set({ webTabHistory: history, webTabFavicons: favicons })
    } else {
      set({ webTabHistory: history })
    }
  },
  removeWebTabHistory: (url) => {
    const st = get()
    if (!st.webTabHistory.includes(url)) return
    const history = st.webTabHistory.filter(u => u !== url)
    try {
      localStorage.setItem(WEB_TAB_HISTORY_KEY, JSON.stringify(history))
    } catch { /* 同上：持久化失败仅内存态 */ }
    // favicon 映射随历史同生命周期：条目删了图标也删
    if (st.webTabFavicons[url]) {
      const favicons = { ...st.webTabFavicons }
      delete favicons[url]
      persistWebTabFavicons(favicons)
      set({ webTabHistory: history, webTabFavicons: favicons })
    } else {
      set({ webTabHistory: history })
    }
  },
  clearWebTabHistory: () => {
    try {
      localStorage.removeItem(WEB_TAB_HISTORY_KEY)
      localStorage.removeItem(WEB_TAB_FAVICON_KEY)
    } catch { /* 同上 */ }
    set({ webTabHistory: [], webTabFavicons: {} })
  },

  // ===== 分屏操作 =====
  splitPane: (paneId, direction, sessionId) => {
    const layout = get().layout

    // 如果有 sessionId，先从所有分屏中移除
    let newRoot = layout.root
    if (sessionId) {
      newRoot = removeSessionFromAllPanes(newRoot, sessionId)
      // 移除空分屏（承载覆盖层的 pane 受 overlays 保护不会被误删；目标 pane 传
      // keepId 豁免 —— 空目标正是下方「直接加入会话」分支的承口，不能被中途回收）
      newRoot = removeEmptyPanes(newRoot, paneId)
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

    // （无「目标分屏只有拖拽会话」特殊分支：sessionId 已被上方 removeSessionFromAllPanes
    //  从所有叶子摘除，targetLeaf.sessions.includes(sessionId) 恒为 false，该分支不可达）

    // 如果目标分屏是空的且有 sessionId，直接添加会话（不创建新分屏）。
    // 同时去活本 pane 覆盖层：新会话自动激活，覆盖层若仍 active 会以更高 zIndex
    // 盖住刚连上的终端（对齐 handleTabClick 的去活语义）
    if (targetLeaf.sessions.length === 0 && sessionId) {
      const leafWithSession: PaneLeaf = {
        ...targetLeaf,
        sessions: [sessionId],
        activeSessionId: sessionId,
        // 插槽不变/本就 inactive 的引用原样返回（OverlayRef 引用身份是渲染层
        // React.memo 的跳过依据，见 PaneView 注释）
        overlays: targetLeaf.overlays.map(r => (r.active ? { ...r, active: false } : r))
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
      // 覆盖层随构造迁到继承原会话列表的第一子叶子（插槽引用 pane.sessions 坐标；
      // removeSessionFromAllPanes 已按删位衰减，与继承侧的 sessions 对齐）
      firstChild: {
        id: newPaneId1,
        type: 'leaf',
        sessions: targetLeaf.sessions,  // 保持原分屏的会话列表
        activeSessionId: targetLeaf.activeSessionId,
        overlays: targetLeaf.overlays
      },
      secondChild: {
        id: newPaneId2,
        type: 'leaf',
        sessions: sessionId ? [sessionId] : [],  // 新分屏只有拖拽的会话
        activeSessionId: sessionId || null,
        overlays: []
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
      // 目标 pane 传 keepId 豁免（同 splitPane：空目标是合法承口，不能被中途回收）
      newRoot = removeEmptyPanes(newRoot, paneId)
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

    // （无「目标分屏只有拖拽会话」特殊分支：sessionId 已被上方 removeSessionFromAllPanes
    //  从所有叶子摘除，targetLeaf.sessions.includes(sessionId) 恒为 false，该分支不可达）

    // 如果目标分屏是空的，直接添加会话。同时去活本 pane 覆盖层（新会话自动激活，
    // 覆盖层若仍 active 会盖住刚连上的终端，对齐 handleTabClick 的去活语义）
    if (targetLeaf.sessions.length === 0 && sessionId) {
      const leafWithSession: PaneLeaf = {
        ...targetLeaf,
        sessions: [sessionId],
        activeSessionId: sessionId,
        // 插槽不变/本就 inactive 的引用原样返回（OverlayRef 引用身份是渲染层
        // React.memo 的跳过依据，见 PaneView 注释）
        overlays: targetLeaf.overlays.map(r => (r.active ? { ...r, active: false } : r))
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
      // 覆盖层随构造迁到继承原会话列表的子叶子（position 反侧）
      firstChild: {
        id: newPaneId1,
        type: 'leaf',
        sessions: firstChildSessions,
        activeSessionId: firstChildActiveId,
        overlays: position === 'first' ? [] : targetLeaf.overlays
      },
      secondChild: {
        id: newPaneId2,
        type: 'leaf',
        sessions: secondChildSessions,
        activeSessionId: secondChildActiveId,
        overlays: position === 'second' ? [] : targetLeaf.overlays
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

    // 收集该分屏内的所有 session —— closePane 不走 removeSessionFromPane,
    // 需在此一并清理 hiddenTabSessions 残留,保持与 removeSessionFromPane 一致
    const sessionIdsToClean = (pane?.type === 'leaf' ? pane.sessions : []) ?? []

    const newRoot = removePaneAndMerge(layout.root, paneId)
    // pane 连同其覆盖层引用一起被删：悬空 payload 按孤儿回收（dsh web 由此杀子进程）
    const payloadPatch = pruneOverlayPayloads(newRoot, get().overlayPayloads, get().draggingOverlayId)

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
      ...payloadPatch,
      ...(hiddenChanged ? { hiddenTabSessions: nextHidden } : {}),
      layout: {
        root: newRoot,
        // 焦点兜底：active 仍有效保持（关后台 pane 不抢焦点）；关的是活动 pane
        // 则落到吸收侧兄弟首个存活叶子（而非无条件 leaves[0]）
        activePaneId: settleActivePaneAfterClose(newRoot, layout.root, paneId, layout.activePaneId)
      }
    })
  },

  // 设置活动分屏
  setActivePane: (paneId) => {
    set(state => ({
      layout: { ...state.layout, activePaneId: paneId }
    }))
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

    // 移除空分屏并合并（承载覆盖层的 pane 受 overlays 保护不会被误删；目标 pane
    // 传 keepId 豁免 —— 拖会话进空 pane 是合法落点，中途回收会让会话落进
    // leaves[0] 兜底、目标 pane 凭空消失）
    newRoot = removeEmptyPanes(newRoot, paneId)

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

    // 插槽同步：slotted 覆盖层钉在末尾（显式末位索引 == 追加前长度）时，新页签追加后应
    // 跟着保持在末尾，否则它会跳到新页签之前；中段插槽无需动 —— 新页签本就落在其
    // 之后的末位，插槽所指的相邻关系不变。
    // 同时去活本 pane 覆盖层：新会话自动激活（下方 activeSessionId），覆盖层若仍
    // active 会以更高 zIndex 盖住刚连上的终端（对齐 handleTabClick 的去活语义）。
    // 字段实际不变的引用原样返回（OverlayRef 引用身份是渲染层 React.memo 的跳过依据）
    const overlays = targetPane.overlays.map(r => {
      if (r.slot != null && r.slot >= targetPane.sessions.length) {
        const slot = newSessions.length
        return slot === r.slot && !r.active ? r : { ...r, slot, active: false }
      }
      return r.active ? { ...r, active: false } : r
    })

    const leafWithSession: PaneLeaf = {
      ...targetPane,
      sessions: newSessions,
      activeSessionId: sessionId,  // 自动激活新会话
      overlays
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

    // 插槽衰减（decaySlotsAfterRemoval 唯一事实源）：被关会话在插槽左侧时插槽减一，
    // 否则 slotted 覆盖层随左侧会话逐个关闭向右漂移（隐藏页签被关同理，索引是原始坐标）
    const adjustedOverlays = decaySlotsAfterRemoval(pane.overlays, pane.sessions.indexOf(sessionId))

    const updatedPane: PaneLeaf = {
      ...pane,
      sessions: newSessions,
      activeSessionId: newActiveId,
      overlays: adjustedOverlays
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

    // 如果分屏没有会话了也不承载覆盖层，关闭该分屏；仍承载覆盖层则保留（覆盖层不是 session，不占会话位）
    if (newSessions.length === 0 && updatedPane.overlays.length === 0) {
      newRoot = removePaneAndMerge(newRoot, paneId)
      set({
        ...(hiddenChanged ? { hiddenTabSessions: nextHidden } : {}),
        layout: {
          root: newRoot,
          // 焦点兜底：active 仍有效保持（关后台 pane 的最后一个页签不抢焦点）；
          // 关的是活动 pane 则落到吸收侧兄弟首个存活叶子
          activePaneId: settleActivePaneAfterClose(newRoot, layout.root, paneId, layout.activePaneId)
        }
      })
    } else {
      // 终端页签清空、pane 因承载覆盖层而保留：若此刻没有任何覆盖层在显示（刚关的是
      // 最后一个终端），按种类优先级（注册表 activatePriority）自动切到剩余覆盖层 ——
      // 否则窗格只剩空态占位，页签悬着要手动点。同种类多个时切到最后打开的一个。
      let overlays = updatedPane.overlays
      if (newSessions.length === 0 && overlays.length > 0 && !overlays.some(r => r.active)) {
        const byKind = new Map<OverlayKind, OverlayRef>()
        for (const r of overlays) byKind.set(r.kind, r)  // 后写覆盖 → 每种类取最后一个
        const candidates = [...byKind.values()].sort((a, b) =>
          OVERLAY_KINDS[a.kind].activatePriority - OVERLAY_KINDS[b.kind].activatePriority)
        const pick = candidates[0]
        if (pick) {
          overlays = overlays.map(r => r.id === pick.id ? { ...r, active: true } : r)
        }
      }
      set({
        ...(hiddenChanged ? { hiddenTabSessions: nextHidden } : {}),
        layout: {
          root: replacePane(layout.root, paneId, { ...updatedPane, overlays }),
          // pane 因承载覆盖层保留：active 仍有效保持（关后台 pane 的最后一个终端
          // 页签不抢焦点），无效则落本 pane（自动激活的覆盖层就在这里）
          activePaneId: findPane(layout.root, layout.activePaneId) ? layout.activePaneId : paneId
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

    // 插槽重定基（rebaseSlotsForMove 唯一事实源，与 insertSessionAtOverlaySlot 的
    // 兄弟联动同一「先删后插」不变量）：左侧会话移走 → 插槽左移；插入点在插槽左侧
    // → 插槽右移；插入点恰落插槽空隙 → 覆盖层在空隙右半才 +1（见共享纯函数注释）
    const overlays = rebaseSlotsForMove(pane.overlays, fromIndex, toIndex, sessions.length)

    const updatedPane: PaneLeaf = {
      ...pane,
      sessions,
      overlays
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

  getPanePositionInParent: (paneId) => {
    return getPanePositionInParent(get().layout.root, paneId)
  }
}))

// 自动保存布局变化
subscribeToLayoutChanges(usePaneStore)

// 自动同步终端打开会话集合到主进程
subscribeToTerminalOpenSessionsSync(usePaneStore)
