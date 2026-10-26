// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import type { WebviewTag } from 'electron'
import type { PluginListItem } from '@shared/plugin-types'
import type { PaneLeaf, PaneNode, SessionConfig } from '@shared/types'
import { ConnectionStatus } from '@shared/types'
import PaneTabBar from './PaneTabBar'
import { usePaneStore } from '../../stores/pane-store'
import { usePluginStore } from '../../stores/plugin-store'
import { useSessionStore } from '../../stores/session-store'
import { registerWebview, unregisterWebview, registerMiniWebview, unregisterMiniWebview } from './web-tab-controls'
import { resetWebTabPopupGateForTest } from './web-tab-popup-gate'
import { openWebTabPopup } from './web-tab-popup'
import '../../i18n'

const mini = { getWebContentsId: () => 8 } as WebviewTag
let id: string
const popup = { url: 'https://popup.example.com/', sourceUrl: 'https://chat.example.com/', sourceWebContentsId: 7 }
beforeEach(() => {
  resetWebTabPopupGateForTest()
  const plugin: PluginListItem = {
    id: 'plugin', name: 'plugin', version: '1.0.0', path: 'plugin', dev: true, enabled: true,
    source: 'dev', installedAt: '', grantedCapabilities: ['uiControl'], runtime: 'node', lifecycle: 'persistent',
    activationEvents: ['onStartup'], capabilities: ['uiControl'], views: []
  }
  usePluginStore.setState({ items: [plugin], loaded: true })
  usePaneStore.setState({ layout: { root: { id: 'pane', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'pane' }, overlayPayloads: {} })
  usePaneStore.getState().openWebTab(popup.sourceUrl, undefined, { ownerPluginId: 'plugin' })
  id = Object.keys(usePaneStore.getState().overlayPayloads)[0]
  registerWebview(id, { getWebContentsId: () => 7 } as WebviewTag)
})
afterEach(() => { cleanup(); unregisterWebview(id); unregisterMiniWebview(mini) })

// ===== 落位断言工具 =====
const leafById = (node: PaneNode, paneId: string): PaneLeaf | null => {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return leafById(node.firstChild, paneId) ?? leafById(node.secondChild, paneId)
}
const rootLeaf = (): PaneLeaf => {
  const root = usePaneStore.getState().layout.root
  if (root.type !== 'leaf') throw new Error('Expected one pane')
  return root
}
/** overlays 数组序 = 页签条可见序（同槽按数组序） */
const overlayIds = (pane: PaneLeaf): string[] => pane.overlays.map(ref => ref.id)
const activeOverlayId = (pane: PaneLeaf): string | null => pane.overlays.find(ref => ref.active)?.id ?? null
/** 本次弹窗新增的页签 id（overlayPayloads 的键差集） */
const addedTabId = (before: Iterable<string>): string => {
  const known = new Set(before)
  const fresh = Object.keys(usePaneStore.getState().overlayPayloads).filter(key => !known.has(key))
  expect(fresh).toHaveLength(1)
  return fresh[0]
}
const overlayUrl = (tabId: string): string | undefined => {
  const payload = usePaneStore.getState().overlayPayloads[tabId]
  return payload?.kind === 'web' ? payload.url : undefined
}
const makeSession = (sessionId: string) => ({
  id: sessionId,
  config: { id: sessionId, name: sessionId, type: 'ssh' } as unknown as SessionConfig,
  status: ConnectionStatus.CONNECTED
})
/** 二分屏：活动分屏 pane-active 在左、来源页签所在的非活动分屏 pane-source 在右 */
const setupSplitPanes = (): void => {
  const source = usePaneStore.getState().overlayPayloads[id]!
  usePaneStore.setState({
    layout: {
      root: {
        id: 'split',
        type: 'split',
        direction: 'horizontal',
        splitRatio: 0.5,
        firstChild: {
          id: 'pane-active', type: 'leaf', sessions: [], activeSessionId: null,
          overlays: [{ id: 'web-active', kind: 'web', active: true, slot: null }]
        },
        secondChild: {
          id: 'pane-source', type: 'leaf', sessions: [], activeSessionId: null,
          overlays: [{ id, kind: 'web', active: true, slot: null }]
        }
      },
      activePaneId: 'pane-active'
    },
    overlayPayloads: {
      'web-active': { kind: 'web', url: 'https://active.example/', title: 'active' },
      [id]: source
    }
  })
}

describe('弹窗页签落位（紧邻来源右侧、留在来源所在 pane）', () => {
  it('来源不在 pane 末尾：前台弹窗紧贴来源右侧，原来源仍存活且让位激活', () => {
    // 先追加一个后台页签，把来源挤到数组中间（来源仍是活动页签）
    usePaneStore.getState().openWebTab('https://after.example/', undefined, { background: true })
    const before = overlayIds(rootLeaf())
    expect(before).toEqual([id, expect.any(String)])
    expect(activeOverlayId(rootLeaf())).toBe(id)

    expect(openWebTabPopup(popup)).toBe(true)

    const added = addedTabId(before)
    const pane = rootLeaf()
    // 紧邻：插在来源与原本的后继页签之间，而不是追加到末尾
    expect(overlayIds(pane)).toEqual([id, added, before[1]])
    expect(overlayUrl(added)).toBe(popup.url)
    // 原来源页签仍存活、内容未变
    expect(overlayUrl(id)).toBe(popup.sourceUrl)
    // 前台弹窗接管本 pane 激活；活动 pane 不变
    expect(activeOverlayId(pane)).toBe(added)
    expect(usePaneStore.getState().layout.activePaneId).toBe('pane')
  })

  it('来源不在 pane 末尾：后台弹窗紧贴来源右侧，但不抢页签激活', () => {
    usePaneStore.getState().openWebTab('https://after.example/', undefined, { background: true })
    const before = overlayIds(rootLeaf())
    expect(activeOverlayId(rootLeaf())).toBe(id)

    expect(openWebTabPopup({ ...popup, background: true })).toBe(true)

    const added = addedTabId(before)
    const pane = rootLeaf()
    expect(overlayIds(pane)).toEqual([id, added, before[1]])
    expect(overlayUrl(added)).toBe(popup.url)
    // 焦点留在来源页签：新页签挂在来源右侧但不激活
    expect(activeOverlayId(pane)).toBe(id)
    expect(pane.overlays.find(ref => ref.id === added)?.active).toBe(false)
    expect(usePaneStore.getState().layout.activePaneId).toBe('pane')
    expect(overlayUrl(id)).toBe(popup.sourceUrl)
  })

  it('来源在非活动分屏：后台弹窗进来源 pane，不抢活动 pane 与页签', () => {
    setupSplitPanes()
    const beforeIds = leafById(usePaneStore.getState().layout.root, 'pane-source')!.overlays.map(ref => ref.id)
    expect(openWebTabPopup({ ...popup, background: true })).toBe(true)

    const layout = usePaneStore.getState().layout
    // 后台语义：活动 pane 原地不动，活动分屏内容一个字节都没变
    expect(layout.activePaneId).toBe('pane-active')
    const sourcePane = leafById(layout.root, 'pane-source')!
    const activePane = leafById(layout.root, 'pane-active')!
    const added = addedTabId(['web-active', ...beforeIds])
    // 新页签落在来源所在 pane（紧邻来源），不落到活动分屏
    expect(overlayIds(sourcePane)).toEqual([id, added])
    expect(overlayIds(activePane)).toEqual(['web-active'])
    expect(overlayUrl(added)).toBe(popup.url)
    // 来源仍是来源 pane 的活动页
    expect(activeOverlayId(sourcePane)).toBe(id)
    expect(activeOverlayId(activePane)).toBe('web-active')
    expect(overlayUrl(id)).toBe(popup.sourceUrl)
  })

  it('来源在非活动分屏：前台弹窗同样落在来源分屏，活动分屏内容不受损', () => {
    setupSplitPanes()
    expect(openWebTabPopup(popup)).toBe(true)

    const layout = usePaneStore.getState().layout
    const sourcePane = leafById(layout.root, 'pane-source')!
    const activePane = leafById(layout.root, 'pane-active')!
    const added = addedTabId(['web-active', id])
    expect(overlayIds(sourcePane)).toEqual([id, added])
    expect(overlayIds(activePane)).toEqual(['web-active'])
    // 前台弹窗把活动 pane 切到来源分屏（弹窗焦点跟随新页签）
    expect(layout.activePaneId).toBe('pane-source')
    expect(activeOverlayId(sourcePane)).toBe(added)
    expect(activeOverlayId(activePane)).toBe('web-active')
  })

  it('来源页签夹在终端页签中间（带 slot）时，新页签排在来源右侧且不隔开终端', () => {
    useSessionStore.setState({ sessions: [makeSession('s0'), makeSession('s1'), makeSession('s2')] })
    const source = usePaneStore.getState().overlayPayloads[id]!
    usePaneStore.setState({
      layout: {
        root: {
          id: 'pane', type: 'leaf', sessions: ['s0', 's1', 's2'], activeSessionId: 's0',
          overlays: [{ id, kind: 'web', active: true, slot: 2 }]
        },
        activePaneId: 'pane'
      },
      overlayPayloads: { [id]: source }
    })
    expect(openWebTabPopup({ ...popup, background: true })).toBe(true)

    const added = addedTabId([id])
    const pane = rootLeaf()
    expect(overlayIds(pane)).toEqual([id, added])
    const { container, unmount } = render(createElement(PaneTabBar, { pane, isTop: true }))
    // 页签条实际可见序：来源 slot=2 → 落在 s1 与 s2 之间；新页签必须紧贴其右
    const order = Array.from(container.querySelectorAll('[data-tab-id]'))
      .map(el => el.getAttribute('data-tab-id'))
    expect(order).toEqual(['s0', 's1', id, added, 's2'])
    // 来源页签元素仍在（未被新页替换）
    expect(container.querySelector(`[data-tab-id="${id}"]`)).toBeTruthy()
    unmount()
  })
})

describe('搜索结果连续打开', () => {
  it.each([false, true])('同一链接重复点击会创建不同页签，后台打开=%s', background => {
    const freshIds: string[] = []
    for (let i = 0; i < 3; i++) {
      expect(openWebTabPopup({ ...popup, background })).toBe(true)
      const tabId = addedTabId([id, ...freshIds])
      freshIds.push(tabId)
      expect(overlayUrl(tabId)).toBe(popup.url)
    }
    expect(new Set(freshIds).size).toBe(3)
    expect(rootLeaf().overlays).toHaveLength(4)
  })

  it('同一路径不同目标的 Bing 跳转链接可连续打开，首个结果无需关闭', () => {
    const search = 'https://www.bing.com/search?q=lyshell'
    const first = 'https://www.bing.com/ck/a?p=shared&u=a1first&ntb=1'
    const second = 'https://www.bing.com/ck/a?p=shared&u=a1second&ntb=1'
    const st = usePaneStore.getState()
    st.setWebTabNav(id, { url: search })
    expect(openWebTabPopup({ ...popup, sourceUrl: search, url: first })).toBe(true)
    const firstId = addedTabId([id])
    // 模拟首个搜索结果已跳到目标网站，原始跳转 URL 仍留在页签 payload 中。
    st.setWebTabNav(firstId, { url: 'https://first.example/article' })
    st.activateOverlay(id)
    expect(openWebTabPopup({ ...popup, sourceUrl: search, url: second })).toBe(true)
    const secondId = addedTabId([id, firstId])
    expect(overlayUrl(firstId)).toBe(first)
    expect(overlayUrl(secondId)).toBe(second)
    expect(rootLeaf().overlays).toHaveLength(3)
    // 同一结果也可再次打开，无需关闭前一次的页签。
    expect(openWebTabPopup({ ...popup, sourceUrl: search, url: second })).toBe(true)
    const repeatId = addedTabId([id, firstId, secondId])
    expect(overlayUrl(repeatId)).toBe(second)
  })
})

describe('弹出页签来源生命周期', () => {
  it('存活的插件来源保持归属，禁用连同弹窗回收', () => {
    expect(openWebTabPopup(popup)).toBe(true)
    expect(Object.values(usePaneStore.getState().overlayPayloads).every(p => p.ownerPluginId === 'plugin')).toBe(true)
    usePluginStore.getState().markResourcesReleased('plugin')
    usePaneStore.getState().closePluginOverlays('plugin')
    expect(usePaneStore.getState().overlayPayloads).toEqual({})
  })
  it.each([false, true])('禁用后已注销来源=%s，迟到弹窗被拒绝', unmounted => {
    usePluginStore.getState().markResourcesReleased('plugin')
    usePaneStore.getState().closePluginOverlays('plugin')
    if (unmounted) unregisterWebview(id)
    expect(openWebTabPopup(popup)).toBe(false)
    expect(usePaneStore.getState().overlayPayloads).toEqual({})
  })
  it('小窗仍可弹出页签，关闭后同一来源的迟到事件被拒绝', () => {
    registerMiniWebview(mini)
    expect(openWebTabPopup({ ...popup, sourceWebContentsId: 8 })).toBe(true)
    unregisterMiniWebview(mini)
    expect(openWebTabPopup({ ...popup, sourceWebContentsId: 8, url: 'https://late.example.com/' })).toBe(false)
  })
  it('未知和缺失来源均被拒绝', () => {
    expect(openWebTabPopup({ ...popup, sourceWebContentsId: 99 })).toBe(false)
    expect(openWebTabPopup({ ...popup, sourceWebContentsId: undefined })).toBe(false)
  })
})
