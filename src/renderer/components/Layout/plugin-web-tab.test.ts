// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import type { PluginListItem } from '@shared/plugin-types'
import { usePaneStore } from '../../stores/pane-store'
import { usePluginStore } from '../../stores/plugin-store'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import { openPluginWebTab } from './plugin-web-tab'

const url = 'http://127.0.0.1:31540/ui/console.html'
const plugin = (id: string): PluginListItem => ({
  id, name: id, version: '1', path: id, dev: true, enabled: true, source: 'dev', installedAt: '',
  grantedCapabilities: ['uiControl'], capabilities: ['uiControl'], runtime: 'node', lifecycle: 'persistent', activationEvents: [], views: []
})

beforeEach(() => {
  for (const id of Object.keys(usePaneStore.getState().overlayPayloads)) unregisterWebview(id)
  usePluginStore.setState({ items: [plugin('console'), plugin('other')], loaded: true })
  usePaneStore.setState({ layout: { root: { id: 'pane', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'pane' }, overlayPayloads: {} })
})

describe('插件工作台显式复用', () => {
  it('多次打开只留一个页签，隐藏后再次打开会激活原页签', () => {
    expect(openPluginWebTab('console', url, true).ok).toBe(true)
    const id = Object.keys(usePaneStore.getState().overlayPayloads)[0]
    usePaneStore.getState().deactivateOverlay(id)
    expect(openPluginWebTab('console', url, true).ok).toBe(true)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual([id])
    expect(usePaneStore.getState().isOverlayActive(id)).toBe(true)
    usePaneStore.getState().closeOverlay(id)
    expect(openPluginWebTab('console', url, true).ok).toBe(true)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(1)
    expect(usePaneStore.getState().overlayPayloads[id]).toBeUndefined()
  })

  it('快捷入口在原 webview 内导航，普通打开不刷新页面', () => {
    openPluginWebTab('console', url, true)
    const id = Object.keys(usePaneStore.getState().overlayPayloads)[0]
    const loadURL = vi.fn().mockResolvedValue(undefined)
    registerWebview(id, { loadURL } as unknown as WebviewTag)
    expect(openPluginWebTab('console', url + '#history?entry=1', true).ok).toBe(true)
    expect(loadURL).toHaveBeenCalledTimes(1)
    expect(loadURL).toHaveBeenCalledWith(url + '#history?entry=1')
    openPluginWebTab('console', url, true)
    expect(loadURL).toHaveBeenCalledTimes(1)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual([id])
  })

  it('初始挂载期间不重复打开，也不把未投递的快捷操作报成成功', () => {
    openPluginWebTab('console', url, true)
    expect(openPluginWebTab('console', url + '#free?entry=2', true).ok).toBe(false)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(1)
  })

  it('插件归属、查询参数和当前导航目标不相同则不复用', () => {
    openPluginWebTab('other', url, true)
    openPluginWebTab('console', url, true)
    openPluginWebTab('console', url + '?workspace=other', true)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(3)
    const id = Object.entries(usePaneStore.getState().overlayPayloads).find(([, p]) => p.ownerPluginId === 'console' && p.kind === 'web' && p.url === url)![0]
    usePaneStore.getState().setWebTabNav(id, { url: 'https://elsewhere.invalid/' })
    openPluginWebTab('console', url, true)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(4)
  })

  it('未请求复用时仍可多开；禁用插件不激活已有页面', () => {
    openPluginWebTab('console', url)
    openPluginWebTab('console', url)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(2)
    const id = Object.keys(usePaneStore.getState().overlayPayloads)[0]
    usePaneStore.getState().deactivateOverlay(id)
    usePluginStore.setState({ items: [{ ...plugin('console'), enabled: false }] })
    expect(openPluginWebTab('console', url, true).ok).toBe(false)
    expect(usePaneStore.getState().isOverlayActive(id)).toBe(false)
  })
})
