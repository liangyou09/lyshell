// @vitest-environment jsdom
/**
 * 只读工作台详情面状态机（S4 审查修正 2 + 复测发现的换代地址问题）回归。
 *
 * 锁的全是「用户已经看到过的坑」：
 *   - 用户关掉详情页签后，同一身份的重复推送 / 10s 兜底对账**不得**再把它挂回来；
 *   - 主进程在 `dsh:web:detail` 返回前就 force 广播 detail-changed ⇒ 同一身份的在飞请求必须去重，
 *     否则每次广播都会递归重进一次 open；
 *   - 旧 promise 在目标变化 / 释放 / 用户关闭之后落地时，**不得**挂载或覆盖新页签；
 *   - 页签已存在时只原位刷新 payload（含**真实 URL/cwd**：后台换代后端口会变），
 *     重挂 = mountOverlay 抢激活 = 把用户从当前视图拽回工作台；url 不变则不触发重载；
 *   - 打开失败不得假标「已应用」（否则该身份再也不会被尝试）；
 *   - 新一轮控制（相位离开 held）解除关闭记录，同一身份可以重新打开。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createWorkbenchDetailController,
  type WorkbenchDetailDeps,
  type WorkbenchDetailOpenResult,
  type WorkbenchDetailPayload
} from './workbench-detail'
import { DSH_WEB_OVERLAY_ID } from './overlay-kinds'
import { usePaneStore } from './pane-store'
import type { PaneLeaf } from '@shared/types'

interface PatchRecord {
  id: string
  patch: {
    url?: string
    cwd?: string
    readOnly?: boolean
    petSessionId?: string | null
    workbenchKey?: string | null
  }
}

interface Harness {
  deps: WorkbenchDetailDeps
  mounts: WorkbenchDetailPayload[]
  patches: PatchRecord[]
  /** 当前页签上的真实 payload（模拟 pane-store 里那条 dshWeb payload） */
  tabPayload: () => WorkbenchDetailPayload | null
  /** 让测试自己控制 openDetail 何时 resolve（模拟「广播已经来了，回包还没到」） */
  openDetail: WorkbenchDetailDeps['openDetail']
  /** 现有页签（null = 用户关掉了 / 还没开） */
  setTab: (id: string | null) => void
  resolveOpen: (result: Awaited<ReturnType<WorkbenchDetailDeps['openDetail']>>) => void
  pendingOpens: number
}

function makeHarness(): Harness {
  const mounts: WorkbenchDetailPayload[] = []
  const patches: PatchRecord[] = []
  let tab: string | null = null
  /** 页签上的 payload：mount 写入、patch 合并 —— 与 pane-store 的 updateDshWebInPane 同语义 */
  let payload: WorkbenchDetailPayload | null = null
  const pending: Array<(value: Awaited<ReturnType<WorkbenchDetailDeps['openDetail']>>) => void> = []
  const openDetail = vi.fn((_target: { sessionId?: string; name?: string }) => {
    return new Promise<Awaited<ReturnType<WorkbenchDetailDeps['openDetail']>>>((resolve) => {
      pending.push(resolve)
    })
  })
  const deps: WorkbenchDetailDeps = {
    openDetail,
    findTab: () => (tab ? { id: tab } : null),
    patchTab: (id, patch) => {
      patches.push({ id, patch })
      if (payload && id === tab) payload = { ...payload, ...patch }
    },
    mountTab: (next) => {
      mounts.push(next)
      tab = DSH_WEB_OVERLAY_ID
      payload = next
    }
  }
  return {
    deps,
    mounts,
    patches,
    tabPayload: () => payload,
    openDetail: openDetail as unknown as WorkbenchDetailDeps['openDetail'],
    setTab: (id) => { tab = id },
    resolveOpen: (result) => {
      const next = pending.shift()
      if (!next) throw new Error('no pending open to resolve')
      next(result)
    },
    get pendingOpens() { return pending.length }
  }
}

const OPEN_OK = { success: true as const, url: 'http://127.0.0.1:3080', cwd: '/tmp', readOnly: true, petSessionId: 's-1' }

describe('只读工作台详情面：同身份去重与关闭持久化', () => {
  it.each(['failure', 'throw'])('显式重开后旧请求 %s 不得清除新代际状态或关闭记录', async outcome => {
    const h = makeHarness()
    let finishOld!: () => void
    const openDetail = vi.fn(h.deps.openDetail).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishOld = () => outcome === 'throw' ? reject(new Error('old request')) : resolve({ success: false })
    }))
    const c = createWorkbenchDetailController({ ...h.deps, openDetail })
    const target = { key: 'held:1:-:s-1', sessionId: 's-1' }
    const old = c.ensure(target)
    c.noteClosed(target.key)
    const reopened = c.ensure({ ...target, reopen: true })
    finishOld()
    await old
    expect(c.appliedKey()).toBe(target.key)
    h.resolveOpen(OPEN_OK)
    await reopened
    c.noteClosed(target.key)
    h.setTab(null)
    await c.ensure(target)
    expect(openDetail).toHaveBeenCalledTimes(2)
    expect(c.isClosed(target.key)).toBe(true)
  })
  it('关闭后普通推送不重开，显式打开重建页签并合并重复请求', async () => {
    const h = makeHarness()
    const activateTab = vi.fn()
    const c = createWorkbenchDetailController({ ...h.deps, activateTab })
    const target = { key: 'held:1:-:s-1', sessionId: 's-1' }
    const first = c.ensure(target)
    h.resolveOpen(OPEN_OK)
    await first
    c.noteClosed(target.key)
    h.setTab(null)
    await c.ensure(target)
    expect(h.openDetail).toHaveBeenCalledTimes(1)
    const reopened = c.ensure({ ...target, reopen: true })
    const duplicate = c.ensure({ ...target, reopen: true })
    expect(h.openDetail).toHaveBeenCalledTimes(2)
    expect(c.isClosed(target.key)).toBe(false)
    h.resolveOpen(OPEN_OK)
    await Promise.all([reopened, duplicate])
    expect(h.mounts).toHaveLength(2)
    await c.ensure({ ...target, reopen: true })
    expect(activateTab).toHaveBeenCalledWith(DSH_WEB_OVERLAY_ID)
    expect(h.openDetail).toHaveBeenCalledTimes(2)
  })

  it('关闭在飞页签后显式重开，旧回包不得阻止新页签挂载', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const target = { key: 'held:1:-:s-1', sessionId: 's-1' }
    const old = c.ensure(target)
    c.noteClosed(target.key)
    const reopened = c.ensure({ ...target, reopen: true })
    expect(h.openDetail).toHaveBeenCalledTimes(2)
    h.resolveOpen(OPEN_OK)
    await old
    expect(h.mounts).toHaveLength(0)
    h.resolveOpen(OPEN_OK)
    await reopened
    expect(h.mounts).toHaveLength(1)
  })
  it('用户在飞期间重复推送同一身份：只发一次 openDetail（主进程会 force 广播，去的重就在这里）', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    // 广播带来的重入（此时第一次 open 还没回）
    const second = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(1)
    expect(h.pendingOpens).toBe(1)
    expect(second).toBe(first)

    h.resolveOpen(OPEN_OK)
    await first
    expect(h.mounts).toHaveLength(1)
    expect(h.mounts[0]).toMatchObject({ kind: 'dshWeb', detail: true, workbenchKey: 'held:1:-:s-1', petSessionId: 's-1' })
  })

  it('用户关掉同身份页签后：重复推送与兜底对账都不再挂载（关闭是持久决定）', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen(OPEN_OK)
    await first
    expect(h.mounts).toHaveLength(1)

    // 用户关掉页签（PaneView 侧上报身份后，overlay-kinds 的 closeSideEffect 记这一笔）
    c.noteKey('held:1:-:s-1')
    c.noteClosed(null)
    h.setTab(null)
    expect(c.isClosed('held:1:-:s-1')).toBe(true)

    // 同身份再来多少次都不重开
    await c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    await c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(1)
    expect(h.mounts).toHaveLength(1)
  })

  it('在飞期间用户关掉页签：旧 promise 落地也不挂载（不把页签弹回来）', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const inflight = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    c.noteClosed('held:1:-:s-1')
    h.resolveOpen(OPEN_OK)
    await inflight
    expect(h.mounts).toHaveLength(0)
  })

  it('释放/换代后在飞的旧身份：落地时被代际挡下（不覆盖新目标）', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const stale = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    // 释放：作废在飞落地
    c.release()
    h.resolveOpen(OPEN_OK)
    await stale
    expect(h.mounts).toHaveLength(0)

    // 新身份照常打开
    const fresh = c.ensure({ key: 'held:2:t-9:s-9', sessionId: 's-9' })
    h.resolveOpen({ ...OPEN_OK, petSessionId: 's-9' })
    await fresh
    expect(h.mounts).toHaveLength(1)
    expect(h.mounts[0].workbenchKey).toBe('held:2:t-9:s-9')
  })

  it('页签已存在且身份未变：只原位刷新 payload，绝不重挂（重挂会抢激活）', async () => {
    const h = makeHarness()
    h.setTab(DSH_WEB_OVERLAY_ID)
    const c = createWorkbenchDetailController(h.deps)
    // 第一次（新身份）必须问主进程：那一次调用既拿 URL，也负责下发冻结的只读导航
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen(OPEN_OK)
    await first
    expect(h.openDetail).toHaveBeenCalledTimes(1)
    expect(h.mounts).toHaveLength(0)
    // patch 里同时带真实地址（url/cwd）与身份：后台换代时页签才能换到新实例
    expect(h.patches.at(-1)).toMatchObject({
      id: DSH_WEB_OVERLAY_ID,
      patch: {
        url: OPEN_OK.url,
        cwd: OPEN_OK.cwd,
        readOnly: true,
        petSessionId: 's-1',
        workbenchKey: 'held:1:-:s-1'
      }
    })

    // 同身份的重复推送：不再问主进程，只刷新（force 广播 / 10s 对账都会走这条）
    await c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(1)
    expect(h.mounts).toHaveLength(0)
  })

  it('新身份（epoch/任务/会话变）解除关闭记录；页签还在就地换身份，不在则重新打开', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen(OPEN_OK)
    await first
    expect(h.mounts).toHaveLength(1)

    // 换代（同后台、页签还在，用户没关）：仍问主进程（要下发新目标的导航），但只原位换身份
    const nextTab = c.ensure({ key: 'held:2:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(2)
    h.resolveOpen(OPEN_OK)
    await nextTab
    expect(h.mounts).toHaveLength(1)
    expect(h.patches.at(-1)?.patch).toMatchObject({ workbenchKey: 'held:2:-:s-1' })

    // 用户关掉页签 ⇒ 该身份持久关闭
    c.noteClosed('held:2:-:s-1')
    h.setTab(null)
    await c.ensure({ key: 'held:2:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(2)
    expect(h.mounts).toHaveLength(1)

    // 再换代 ⇒ 新身份，页签不在 ⇒ 重新挂载
    const next = c.ensure({ key: 'held:3:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(3)
    h.resolveOpen(OPEN_OK)
    await next
    expect(h.mounts).toHaveLength(2)
    expect(h.mounts.at(-1)?.workbenchKey).toBe('held:3:-:s-1')
  })

  it('新一轮控制（用户关掉 + 释放归位）：同一身份可再次打开', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen(OPEN_OK)
    await first
    // 用户关掉页签 → 主进程释放独占（推送 key 变 null → release）
    c.noteClosed('held:1:-:s-1')
    h.setTab(null)
    c.notePhase('held')
    c.release()
    c.notePhase('free')
    expect(c.isClosed('held:1:-:s-1')).toBe(false)

    // 新一轮控制拿到同一身份：应当能重新打开（关闭记录已随控制轮次解除）
    const again = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen(OPEN_OK)
    await again
    expect(h.openDetail).toHaveBeenCalledTimes(2)
    expect(h.mounts).toHaveLength(2)
    expect(h.mounts.at(-1)).toMatchObject({ petSessionId: 's-1' })
  })

  it('打开失败：不假标成功（显式恢复可用），同身份低频对账能再试', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const failed = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen({ success: false, error: 'bridge/unavailable' })
    await failed
    expect(h.mounts).toHaveLength(0)
    // 关键：失败不得留下「已应用」的假象，否则这一身份再也不会被尝试
    expect(c.appliedKey()).toBeNull()

    // 同一身份的重复推送 ⇒ 重新尝试（低频事件驱动，不会刷屏）
    const retry = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(2)
    h.resolveOpen(OPEN_OK)
    await retry
    expect(h.mounts).toHaveLength(1)
    expect(h.mounts[0].url).toBe(OPEN_OK.url)
  })

  it('openDetail 抛错：同样不假标成功并恢复可用（不毒死后续身份）', async () => {
    const h = makeHarness()
    const deps: WorkbenchDetailDeps = { ...h.deps, openDetail: () => Promise.reject(new Error('boom')) }
    const c = createWorkbenchDetailController(deps)
    await c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(h.mounts).toHaveLength(0)
    expect(c.appliedKey()).toBeNull()
    expect(c.inflightCount()).toBe(0)
  })

  it('后台换代：现有页签原位换到新实例的 URL/cwd（不新增页签、不重挂）', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen({ ...OPEN_OK, url: 'http://127.0.0.1:3080', cwd: '/old/dsh-web' })
    await first
    expect(h.tabPayload()?.url).toBe('http://127.0.0.1:3080')

    // 后台换代（同 key 之外的新身份）：端口变了 ⇒ 页签必须跟着换地址，否则一直指向旧实例
    const next = c.ensure({ key: 'held:2:-:s-1', sessionId: 's-1' })
    h.resolveOpen({ ...OPEN_OK, url: 'http://127.0.0.1:41234', cwd: '/new/dsh-web' })
    await next
    expect(h.mounts).toHaveLength(1) // 没有第二次挂载
    expect(h.tabPayload()?.url).toBe('http://127.0.0.1:41234')
    expect(h.tabPayload()?.cwd).toBe('/new/dsh-web')
    expect(h.tabPayload()?.workbenchKey).toBe('held:2:-:s-1')
  })

  it('同一实例 URL 不变：patch 传的就是同一个 url，不因换代产生新地址', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    h.resolveOpen({ ...OPEN_OK, url: 'http://127.0.0.1:3080' })
    await first

    const next = c.ensure({ key: 'held:2:-:s-1', sessionId: 's-1' })
    h.resolveOpen({ ...OPEN_OK, url: 'http://127.0.0.1:3080' })
    await next
    const lastPatch = h.patches.at(-1)
    expect(lastPatch?.patch.url).toBe('http://127.0.0.1:3080')
    expect(h.tabPayload()?.url).toBe('http://127.0.0.1:3080')
    expect(h.mounts).toHaveLength(1)
  })

  it('在飞记录在落地后清空（同一身份之后能再次打开）', async () => {
    const h = makeHarness()
    const c = createWorkbenchDetailController(h.deps)
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(c.inflightCount()).toBe(1)
    h.resolveOpen(OPEN_OK)
    await first
    expect(c.inflightCount()).toBe(0)
    // 同身份但页签已不在（用户关过 / 被清掉）：不重挂，且不再是「在飞」
    h.setTab(null)
    await c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    expect(h.openDetail).toHaveBeenCalledTimes(1)
  })
})

/**
 * 端到端（真 pane-store）：后台换代时现有页签必须**原位**换到新实例的 URL ——
 * 页签数量与激活态都不许变（不新增、不抢激活、不重挂）。
 */
describe('只读工作台详情面 × 真 pane-store：换代原位置换地址', () => {
  const leaf = (id: string, sessions: string[]): PaneLeaf => ({
    id,
    type: 'leaf',
    sessions,
    activeSessionId: sessions[0] ?? null,
    overlays: []
  })

  const reset = (): void => {
    usePaneStore.setState({
      layout: { root: leaf('pane-1', ['s-a']), activePaneId: 'pane-1' },
      overlayPayloads: {},
      draggingOverlayId: null,
      hiddenTabSessions: {}
    })
  }

  const liveDeps = (): WorkbenchDetailDeps => ({
    openDetail: vi.fn(),
    findTab: () => {
      const found = usePaneStore.getState().getOverlayByKind('dshWeb')
      return found && found.ref.id === DSH_WEB_OVERLAY_ID ? { id: found.ref.id } : null
    },
    patchTab: (id, patch) => usePaneStore.getState().updateDshWebInPane(id, patch),
    mountTab: (payload) => {
      const { openDshWebInPane, layout } = usePaneStore.getState()
      openDshWebInPane(layout.activePaneId, payload)
    }
  })

  const dshTabs = (): number => {
    const pane = usePaneStore.getState().getPaneById('pane-1') as PaneLeaf | null
    return pane ? pane.overlays.filter((r) => r.kind === 'dshWeb').length : 0
  }

  beforeEach(() => reset())

  it('新旧实例 URL 不同：ensure 换代后原位更新 URL/cwd，页签数与激活态不变', async () => {
    let resolveOpen: ((value: WorkbenchDetailOpenResult) => void) | null = null
    const deps: WorkbenchDetailDeps = {
      ...liveDeps(),
      openDetail: () => new Promise<WorkbenchDetailOpenResult>((resolve) => { resolveOpen = resolve })
    }
    const c = createWorkbenchDetailController(deps)

    // 第一次：没有页签 ⇒ 挂载（旧实例端口）
    const first = c.ensure({ key: 'held:1:-:s-1', sessionId: 's-1' })
    resolveOpen!({ success: true, url: 'http://127.0.0.1:3080', cwd: '/old/dsh-web', readOnly: true, petSessionId: 's-1' })
    await first
    expect(dshTabs()).toBe(1)
    const tabId = usePaneStore.getState().getOverlayByKind('dshWeb')!.ref.id
    expect(usePaneStore.getState().isOverlayActive(tabId)).toBe(true)

    // 换代：页签在 ⇒ 必须**原位**换到新实例的地址，不重挂、不抢激活
    const next = c.ensure({ key: 'held:2:-:s-1', sessionId: 's-1' })
    resolveOpen!({ success: true, url: 'http://127.0.0.1:41234', cwd: '/new/dsh-web', readOnly: true, petSessionId: 's-1' })
    await next

    const payload = usePaneStore.getState().getOverlayPayload(tabId) as { url?: string; cwd?: string; workbenchKey?: string }
    expect(payload.url).toBe('http://127.0.0.1:41234')
    expect(payload.cwd).toBe('/new/dsh-web')
    expect(payload.workbenchKey).toBe('held:2:-:s-1')
    expect(dshTabs()).toBe(1)
    expect(usePaneStore.getState().isOverlayActive(tabId)).toBe(true)
    expect(usePaneStore.getState().getOverlayByKind('dshWeb')!.ref.id).toBe(tabId)
  })

  it('URL 相同：同值短路，payload 引用不变（不触发 webview 重载）', () => {
    const deps = liveDeps()
    deps.mountTab({
      kind: 'dshWeb',
      url: 'http://127.0.0.1:3080',
      name: 'DeepSeek Harness',
      detail: true,
      readOnly: true,
      petSessionId: 's-1',
      workbenchKey: 'held:1:-:s-1'
    })
    const tabId = usePaneStore.getState().getOverlayByKind('dshWeb')!.ref.id
    const before = usePaneStore.getState().getOverlayPayload(tabId)
    usePaneStore.getState().updateDshWebInPane(tabId, {
      url: 'http://127.0.0.1:3080',
      readOnly: true,
      petSessionId: 's-1',
      workbenchKey: 'held:1:-:s-1'
    })
    // 一个字段都没变 ⇒ store 不换 payload 引用（PaneView 的 webview src 也就不会动）
    expect(usePaneStore.getState().getOverlayPayload(tabId)).toBe(before)
  })
})
