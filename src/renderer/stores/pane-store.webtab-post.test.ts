// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { usePaneStore } from './pane-store'
import type { PaneLeaf } from '@shared/types'

describe('POST 弹窗页签', () => {
  it('只存一次性令牌，后台挂载不切换当前页签', () => {
    usePaneStore.setState({
      layout: {
        root: { id: 'pane-1', type: 'leaf', sessions: ['terminal-1'], activeSessionId: 'terminal-1', overlays: [] },
        activePaneId: 'pane-1'
      },
      overlayPayloads: {}
    })
    const result = usePaneStore.getState().openWebTab('https://example.com/submit', undefined, {
      background: true,
      postToken: 'token-1'
    })
    expect(result.ok).toBe(true)
    const state = usePaneStore.getState()
    const leaf = state.layout.root as PaneLeaf
    expect(leaf.overlays).toHaveLength(1)
    expect(leaf.overlays[0].active).toBe(false)
    expect(state.layout.activePaneId).toBe('pane-1')
    expect(state.overlayPayloads[leaf.overlays[0].id]).toMatchObject({
      kind: 'web', url: 'https://example.com/submit', postToken: 'token-1'
    })
  })

  // 重挂兜底路径：settleWebTabPost 在首航落定（did-navigate）时摘除令牌并把
  // payload.url 改写为落点。常态下页签挂 WebTabLayer 常驻层不随拖动重挂，此处
  // 只为异常重挂（如开发期 StrictMode）兜底 —— url 保持 POST 目标，按 GET 回落；
  // 正文重放已否决（取走即毁，见 @shared/types WebTabPopupRequest 注）
  describe('settleWebTabPost', () => {
    const openWithToken = (): string => {
      usePaneStore.setState({
        layout: {
          root: { id: 'pane-1', type: 'leaf', sessions: ['terminal-1'], activeSessionId: 'terminal-1', overlays: [] },
          activePaneId: 'pane-1'
        },
        overlayPayloads: {}
      })
      const result = usePaneStore.getState().openWebTab('https://example.com/submit', undefined, { postToken: 'token-1' })
      expect(result.ok).toBe(true)
      return (usePaneStore.getState().layout.root as PaneLeaf).overlays[0].id
    }

    it('落点已知：摘除令牌并把 url 改写为落点', () => {
      const id = openWithToken()
      usePaneStore.getState().settleWebTabPost(id, 'https://example.com/callback?code=1')
      const payload = usePaneStore.getState().overlayPayloads[id]
      expect(payload).toMatchObject({ kind: 'web', url: 'https://example.com/callback?code=1' })
      expect(payload.kind === 'web' && payload.postToken).toBeUndefined()
    })

    it('落点未知（认领被拒）：只摘令牌，url 保持 POST 目标', () => {
      const id = openWithToken()
      usePaneStore.getState().settleWebTabPost(id)
      const payload = usePaneStore.getState().overlayPayloads[id]
      expect(payload).toMatchObject({ kind: 'web', url: 'https://example.com/submit' })
      expect(payload.kind === 'web' && payload.postToken).toBeUndefined()
    })

    it('落点非 http/https：不改写 url，仍摘令牌', () => {
      const id = openWithToken()
      usePaneStore.getState().settleWebTabPost(id, 'javascript:alert(1)')
      const payload = usePaneStore.getState().overlayPayloads[id]
      expect(payload).toMatchObject({ kind: 'web', url: 'https://example.com/submit' })
      expect(payload.kind === 'web' && payload.postToken).toBeUndefined()
    })

    it('重复调用是 no-op（令牌已摘即无事可做，不换 state 引用）', () => {
      const id = openWithToken()
      usePaneStore.getState().settleWebTabPost(id, 'https://example.com/callback')
      const afterFirst = usePaneStore.getState().overlayPayloads[id]
      usePaneStore.getState().settleWebTabPost(id, 'https://example.com/other')
      expect(usePaneStore.getState().overlayPayloads[id]).toBe(afterFirst)
    })

    it('对无令牌页签 / 未知 id 是 no-op（不换 state 引用）', () => {
      usePaneStore.setState({
        layout: {
          root: { id: 'pane-1', type: 'leaf', sessions: ['terminal-1'], activeSessionId: 'terminal-1', overlays: [] },
          activePaneId: 'pane-1'
        },
        overlayPayloads: {}
      })
      usePaneStore.getState().openWebTab('https://example.com/plain')
      const id = (usePaneStore.getState().layout.root as PaneLeaf).overlays[0].id
      const beforePayload = usePaneStore.getState().overlayPayloads[id]
      const beforeDict = usePaneStore.getState().overlayPayloads
      usePaneStore.getState().settleWebTabPost(id, 'https://example.com/other')
      usePaneStore.getState().settleWebTabPost('no-such-id')
      expect(usePaneStore.getState().overlayPayloads[id]).toBe(beforePayload)
      expect(usePaneStore.getState().overlayPayloads).toBe(beforeDict)
    })
  })
})
