// @vitest-environment jsdom
/**
 * readDoc 管线测试 —— 刷新版本守卫 + 并发打开去重（都走真实 openRemoteDoc /
 * refreshDocTab 路径）。electronAPI 用可控 deferred promise 模拟，精确编排
 * 响应乱序与慢响应到达时机。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { refreshDocTab, openRemoteDoc } from './readDoc'
import { usePaneStore } from '../../stores/pane-store'
import type { DocTabEntry } from '@shared/types'

type Envelope = { success: boolean; data?: unknown; error?: string }
const ok = (content: string): Envelope => ({
  success: true,
  data: { content, size: content.length, mtime: 1, encoding: 'utf-8' }
})

/** 每次调用入队一个 resolve —— 测试按需乱序放行，模拟网络/读取完成时机 */
const deferred: Array<(v: Envelope) => void> = []

const freshTab = (): DocTabEntry => ({
  id: 'doc-1',
  paneId: 'pane-1',
  active: true,
  source: 'remote',
  kind: 'markdown',
  path: '/srv/a.md',
  title: 'a.md',
  sessionId: 'sess-1',
  size: 1,
  mtime: 1,
  content: '# old'
})

beforeEach(() => {
  deferred.length = 0
  usePaneStore.setState({
    layout: {
      root: { id: 'pane-1', type: 'leaf', sessions: ['s-a'], activeSessionId: 's-a' },
      activePaneId: 'pane-1'
    },
    docTabs: []
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
    const tabs = usePaneStore.getState().docTabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].content).toBe('# v2') // 后落盘者按刷新语义覆盖
  })

  it('失败后重开同一路径成功：复用页签且旧 loadError 被抹掉', async () => {
    const fail = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    deferred[0]({ success: false, error: 'connection lost' })
    await fail
    let tab = usePaneStore.getState().docTabs[0]
    expect(tab.loadError).toBe('connection lost')
    expect(tab.content).toBe('')

    const retry = openRemoteDoc('sess-1', '/srv/a.md', 'pane-1')
    deferred[1](ok('# recovered'))
    await retry
    const tabs = usePaneStore.getState().docTabs
    expect(tabs).toHaveLength(1) // 仍复用同一页签
    tab = tabs[0]
    expect(tab.loadError).toBeUndefined()
    expect(tab.content).toBe('# recovered')
  })
})

describe('refreshDocTab：版本守卫', () => {
  it('快速连点刷新：慢响应被丢弃，不覆盖快响应的新内容', async () => {
    usePaneStore.setState({ docTabs: [freshTab()] })
    const tab = usePaneStore.getState().docTabs[0]
    const r1 = refreshDocTab(tab) // 版本 1（慢）
    const r2 = refreshDocTab(tab) // 版本 2（快）
    // 版本号在刷新发起时即同步自增（不等响应）：两次连点必得不同版本
    expect(usePaneStore.getState().docTabs[0].readVersion).toBe(2)
    deferred[1](ok('# fast'))
    await r2
    deferred[0](ok('# slow'))
    await r1
    expect(usePaneStore.getState().docTabs[0].content).toBe('# fast')
    expect(usePaneStore.getState().docTabs[0].readVersion).toBe(2)
  })

  it('慢的失败响应同样被丢弃（不把 loadError 盖到新内容上）', async () => {
    usePaneStore.setState({ docTabs: [freshTab()] })
    const tab = usePaneStore.getState().docTabs[0]
    const r1 = refreshDocTab(tab)
    const r2 = refreshDocTab(tab)
    deferred[1](ok('# fast'))
    await r2
    deferred[0]({ success: false, error: 'boom' })
    await r1
    const t = usePaneStore.getState().docTabs[0]
    expect(t.content).toBe('# fast')
    expect(t.loadError).toBeUndefined()
  })

  it('刷新在途时关闭页签：迟到的响应不复活页签', async () => {
    usePaneStore.setState({ docTabs: [freshTab()] })
    const tab = usePaneStore.getState().docTabs[0]
    const r = refreshDocTab(tab)
    usePaneStore.getState().closeDocTab(tab.id)
    deferred[0](ok('# late'))
    await r
    // 页签已关闭：迟到响应不得写回或复活条目
    expect(usePaneStore.getState().docTabs).toHaveLength(0)
  })
})
