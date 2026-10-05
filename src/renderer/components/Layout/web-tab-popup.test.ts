// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebviewTag } from 'electron'
import type { PluginListItem } from '@shared/plugin-types'
import { usePaneStore } from '../../stores/pane-store'
import { usePluginStore } from '../../stores/plugin-store'
import { registerWebview, unregisterWebview, registerMiniWebview, unregisterMiniWebview } from './web-tab-controls'
import { resetWebTabPopupGateForTest } from './web-tab-popup-gate'
import { openWebTabPopup } from './web-tab-popup'

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
afterEach(() => { unregisterWebview(id); unregisterMiniWebview(mini) })

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
