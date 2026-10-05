// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { usePaneStore } from './pane-store'
import { usePluginStore } from './plugin-store'
import { uniquePluginWebOrigins } from '@shared/plugin-web-resources'
import type { PluginListItem, PluginViewMeta } from '@shared/plugin-types'

const origin = 'http://127.0.0.1:31517'
const view = (pluginId: string): PluginViewMeta => ({
  pluginId, id: 'chat', source: 'manifest', title: '聊天', entry: 'views/chat.html', connectOrigins: [origin]
})
const plugin = (id: string): PluginListItem => ({
  id, name: id, version: '1.0.0', path: id, dev: true, enabled: true,
  source: 'dev', installedAt: '', grantedCapabilities: ['uiControl'], runtime: 'node', lifecycle: 'persistent',
  activationEvents: ['onStartup'], capabilities: ['uiControl'], views: [view(id)]
})

beforeEach(() => {
  usePluginStore.setState({ items: [plugin('aipet')], loaded: true })
  usePaneStore.setState({
    layout: { root: { id: 'pane', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'pane' },
    overlayPayloads: {}, draggingOverlayId: null
  })
})

describe('插件聊天页签回收', () => {
  it('聊天从任意网页入口打开都记录归属，隐藏后仍能回收', () => {
    const store = usePaneStore.getState()
    store.openWebTab(`${origin}/ui/chat/`)
    store.openWebTab('https://example.com/')
    const chat = Object.entries(usePaneStore.getState().overlayPayloads).find(([, p]) => p.ownerPluginId === 'aipet')!
    expect(chat).toBeDefined()
    store.deactivateOverlay(chat[0])
    store.setDraggingOverlay(chat[0])
    // 清理只依赖 pane-store 的页签状态，不依赖 MainWindow 的临时登记表。
    usePluginStore.getState().markResourcesReleased('aipet')
    store.closePluginOverlays('aipet', [origin])
    expect(usePaneStore.getState().overlayPayloads[chat[0]]).toBeUndefined()
    expect(usePaneStore.getState().draggingOverlayId).toBeNull()
    expect(Object.values(usePaneStore.getState().overlayPayloads)).toMatchObject([{ url: 'https://example.com/' }])
  })

  it('兼容热更新前没有归属字段的聊天页签，同时清理多个页签', () => {
    const store = usePaneStore.getState()
    const a = store.mountOverlay(undefined, { kind: 'web', url: `${origin}/ui/chat/`, title: '聊天' })!
    const b = store.mountOverlay(undefined, { kind: 'web', url: 'https://example.com/', title: '重定向聊天', nav: {
      url: `${origin}/ui/chat/?session=2`, loading: false, canGoBack: false, canGoForward: false
    } })!
    const other = store.mountOverlay(undefined, { kind: 'web', url: 'http://127.0.0.1:31518/ui/chat/', title: '其他服务' })!
    store.closePluginOverlays('aipet', [origin])
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual([other])
    expect(store.getAllLeafPanes().every(p => p.overlays.every(r => r.id !== a && r.id !== b))).toBe(true)
  })

  it('外站页签和弹出的后代页签按显式插件归属回收，不误删其他插件', () => {
    const store = usePaneStore.getState()
    store.openWebTab('https://chat.example.com/', undefined, { ownerPluginId: 'aipet' })
    store.openWebTab('https://login.example.com/', undefined, { ownerPluginId: 'aipet', background: true })
    const other = store.mountOverlay(undefined, { kind: 'web', url: `${origin}/ui/chat/`, title: '其他插件', ownerPluginId: 'other' })!
    store.closePluginOverlays('aipet', [origin])
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual([other])
  })

  it('文档原位刷新不会丢失已有插件归属，复用用户文档不夺取归属', () => {
    const store = usePaneStore.getState()
    const doc = { source: 'local' as const, docKind: 'markdown' as const, path: 'C:/doc.md', title: '文档', size: 1, mtime: 0, content: 'a' }
    const id = store.openDocTab(undefined, doc)
    store.setOverlayOwner(id, 'aipet')
    expect(store.openDocTab(undefined, { ...doc, content: 'b' })).toBe(id)
    expect(usePaneStore.getState().overlayPayloads[id].ownerPluginId).toBe('aipet')
    store.setOverlayOwner(id, 'other')
    expect(usePaneStore.getState().overlayPayloads[id].ownerPluginId).toBe('aipet')
  })

  it('共用本机服务来源不自动认领，禁用后旧动作不能再创建有归属的页签', () => {
    usePluginStore.setState({ items: [plugin('aipet'), plugin('other')] })
    const origins = uniquePluginWebOrigins(usePluginStore.getState().items.flatMap(p => p.views), 'aipet')
    expect(origins).toEqual([])
    usePaneStore.getState().openWebTab(`${origin}/ui/chat/`)
    expect(Object.values(usePaneStore.getState().overlayPayloads)[0].ownerPluginId).toBeUndefined()
    usePluginStore.getState().markResourcesReleased('aipet')
    expect(usePaneStore.getState().openWebTab('https://chat.example.com/', undefined, { ownerPluginId: 'aipet' }).ok).toBe(false)
    usePluginStore.setState({ items: [] }) // 卸载刷新后列表中已经没有插件。
    expect(usePaneStore.getState().openWebTab('https://chat.example.com/', undefined, { ownerPluginId: 'aipet' }).ok).toBe(false)
  })
})
