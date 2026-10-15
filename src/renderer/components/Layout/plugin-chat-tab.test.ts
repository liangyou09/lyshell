// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { usePaneStore } from '../../stores/pane-store'
import { usePluginStore } from '../../stores/plugin-store'
import type { PluginViewMeta } from '@shared/plugin-types'
import { openPluginChatTab } from './plugin-chat-tab'

const view: PluginViewMeta = {
  pluginId: 'aipet', source: 'manifest', id: 'pets', title: 'PetLink 宠物', entry: 'views/pets.html',
  connectOrigins: ['ws://127.0.0.1:31517', 'http://127.0.0.1:31517']
}
beforeEach(() => {
  usePluginStore.setState({ items: [], loaded: false })
  usePaneStore.setState({
    layout: { root: { id: 'pane-1', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'pane-1' },
    overlayPayloads: {}
  })
})
describe('插件聊天终端页签', () => {
  it('打开聊天页签，重复点击聚焦原页签并保留页面状态，关闭后可重开', () => {
    expect(openPluginChatTab(view)).toEqual({ ok: true })
    const panes = usePaneStore.getState()
    const [id, payload] = Object.entries(panes.overlayPayloads)[0]
    expect(payload).toMatchObject({ kind: 'web', url: 'http://127.0.0.1:31517/ui/chat/', ownerPluginId: 'aipet' })
    panes.deactivateOverlay(id)
    expect(openPluginChatTab(view)).toEqual({ ok: true })
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual([id])
    expect(usePaneStore.getState().overlayPayloads[id]).toBe(payload)
    expect(usePaneStore.getState().isOverlayActive(id)).toBe(true)
    panes.closeOverlay(id)
    expect(openPluginChatTab(view)).toEqual({ ok: true })
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(1)
  })
  it('不打开清单未声明或远程的聊天来源', () => {
    expect(openPluginChatTab({ ...view, connectOrigins: [] }).ok).toBe(false)
    expect(openPluginChatTab({ ...view, connectOrigins: ['https://example.com'] }).ok).toBe(false)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
  })
})
