// @vitest-environment jsdom
/**
 * readDoc 管线测试 —— 刷新版本守卫 + 并发打开去重（都走真实 openRemoteDoc /
 * refreshDocTab 路径）。electronAPI 用可控 deferred promise 模拟，精确编排
 * 响应乱序与慢响应到达时机。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { refreshDocTab, openRemoteDoc } from './readDoc'
import { usePaneStore } from '../../stores/pane-store'
import type { DocOverlayPayload, OverlayPayload, OverlayRef, PaneLeaf } from '@shared/types'

type Envelope = { success: boolean; data?: unknown; error?: string }
const ok = (content: string): Envelope => ({
  success: true,
  data: { content, size: content.length, mtime: 1, encoding: 'utf-8' }
})

/** 每次调用入队一个 resolve —— 测试按需乱序放行，模拟网络/读取完成时机 */
const deferred: Array<(v: Envelope) => void> = []

const DOC_ID = 'doc-1'

const freshPayload = (): DocOverlayPayload => ({
  source: 'remote',
  docKind: 'markdown',
  path: '/srv/a.md',
  title: 'a.md',
  sessionId: 'sess-1',
  size: 1,
  mtime: 1,
  content: '# old'
})

const leaf = (sessions: string[], overlays: OverlayRef[] = []): PaneLeaf => ({
  id: 'pane-1',
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null,
  overlays
})

// 单 doc 页签挂 pane-1 的标准形态（refresh 族用例的前置）
const mountDoc = (payload: DocOverlayPayload): void => {
  usePaneStore.setState({
    layout: {
      root: leaf(['s-a'], [{ id: DOC_ID, kind: 'doc', active: true, slot: null }]),
      activePaneId: 'pane-1'
    },
    overlayPayloads: { [DOC_ID]: { kind: 'doc', ...payload } } as Record<string, OverlayPayload>
  })
}

// 当前 doc payload（无页签时 undefined —— 迟到响应不得复活）。
// openRemoteDoc 生成的实例 id 是随机的（doc-<rand>），从树里动态找
const soleDocPayload = (): (OverlayPayload & DocOverlayPayload) | undefined => {
  const st = usePaneStore.getState()
  for (const pane of st.getAllLeafPanes()) {
    for (const r of pane.overlays) {
      const p = st.overlayPayloads[r.id]
      if (r.kind === 'doc' && p?.kind === 'doc') return p
    }
  }
  return undefined
}

// refresh 族用例的页签 id 固定为 DOC_ID（mountDoc 直接构造）
const docPayload = (): (OverlayPayload & DocOverlayPayload) | undefined => {
  const p = usePaneStore.getState().getOverlayPayload(DOC_ID)
  return p?.kind === 'doc' ? p : undefined
}

const docOverlayCount = (): number =>
  usePaneStore.getState().getAllLeafPanes().reduce((n, p) => n + p.overlays.filter(r => r.kind === 'doc').length, 0)

beforeEach(() => {
  deferred.length = 0
  usePaneStore.setState({
    layout: { root: leaf(['s-a']), activePaneId: 'pane-1' },
    overlayPayloads: {}
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    fileReadDoc: (): Promise<Envelope> =>
      new Promise(resolve => { deferred.push(resolve) })
  }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('openRemoteDoc：并发打开', () => {
  it('同路径同 pane 连续两次打开（读取 await 后才落 openDocTab）只建一个页签', async () => {
    const p1 = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    const p2 = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    deferred[0](ok('# v1'))
    deferred[1](ok('# v2'))
    await Promise.all([p1, p2])
    expect(docOverlayCount()).toBe(1)
    expect(soleDocPayload()?.content).toBe('# v2') // 后触发（版本更高）者覆盖
  })

  it('响应乱序：后触发的读取先到建页签，先触发的旧响应迟到不回盖（last-requested-wins）', async () => {
    const p1 = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1') // 版本 1（慢）
    const p2 = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1') // 版本 2（快）
    deferred[1](ok('# v2')) // 后触发先完成 → 建页签
    await p2
    deferred[0](ok('# v1')) // 先触发的旧响应迟到 → 只激活，内容不覆写
    await p1
    expect(docOverlayCount()).toBe(1)
    expect(soleDocPayload()?.content).toBe('# v2')
  })

  it('响应乱序：迟到的旧失败响应不得把 loadError 盖到新内容上', async () => {
    const p1 = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    const p2 = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    deferred[1](ok('# v2'))
    await p2
    deferred[0]({ success: false, error: 'slow failure' })
    await p1
    const tab = soleDocPayload()
    expect(docOverlayCount()).toBe(1)
    expect(tab?.content).toBe('# v2')
    expect(tab?.loadError).toBeUndefined()
  })

  it('失败后重开同一路径成功：复用页签且旧 loadError 被抹掉', async () => {
    const fail = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    deferred[0]({ success: false, error: 'connection lost' })
    await fail
    let tab = soleDocPayload()
    expect(tab?.loadError).toBe('connection lost')
    expect(tab?.content).toBe('')

    const retry = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    deferred[1](ok('# recovered'))
    await retry
    expect(docOverlayCount()).toBe(1) // 仍复用同一页签
    tab = soleDocPayload()
    expect(tab?.loadError).toBeUndefined()
    expect(tab?.content).toBe('# recovered')
  })
})

describe('refreshDocTab：版本守卫', () => {
  it('快速连点刷新：慢响应被丢弃，不覆盖快响应的新内容', async () => {
    mountDoc(freshPayload())
    const r1 = refreshDocTab(DOC_ID) // 版本 1（慢）
    const r2 = refreshDocTab(DOC_ID) // 版本 2（快）
    // 版本表在刷新发起时即同步自增（不等响应）：两次连点必得不同版本
    deferred[1](ok('# fast'))
    await r2
    deferred[0](ok('# slow'))
    await r1
    expect(docPayload()?.content).toBe('# fast')
  })

  it('慢的失败响应同样被丢弃（不把 loadError 盖到新内容上）', async () => {
    mountDoc(freshPayload())
    const r1 = refreshDocTab(DOC_ID)
    const r2 = refreshDocTab(DOC_ID)
    deferred[1](ok('# fast'))
    await r2
    deferred[0]({ success: false, error: 'boom' })
    await r1
    const t = docPayload()
    expect(t?.content).toBe('# fast')
    expect(t?.loadError).toBeUndefined()
  })

  it('刷新在途时关闭页签：迟到的响应不复活页签', async () => {
    mountDoc(freshPayload())
    const r = refreshDocTab(DOC_ID)
    usePaneStore.getState().closeDocTab(DOC_ID)
    deferred[0](ok('# late'))
    await r
    // 页签已关闭：迟到响应不得写回或复活条目
    expect(docPayload()).toBeUndefined()
    expect(docOverlayCount()).toBe(0)
  })

  it('刷新在途时重开同路径：openDocTab 复用页签并 bump 版本，在途刷新的迟到响应被丢弃', async () => {
    mountDoc(freshPayload())
    const r = refreshDocTab(DOC_ID) // 版本 1（慢），deferred[0]
    const reopen = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1') // deferred[1]
    deferred[1](ok('# reopened'))
    await reopen
    expect(docOverlayCount()).toBe(1) // 同路径复用同一页签
    expect(docPayload()?.content).toBe('# reopened')
    deferred[0](ok('# stale-refresh'))
    await r
    // 重开已 bump 版本：在途刷新不得用旧内容盖掉重开的新内容
    expect(docPayload()?.content).toBe('# reopened')
  })
})
