// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import type { PaneLeaf, SessionConfig } from '@shared/types'
import { usePaneStore } from '../stores/pane-store'
import { useSessionStore } from '../stores/session-store'

vi.mock('./command-registry', () => ({ COMMANDS: [] }))
vi.mock('../components/DocPanel/readDoc', () => ({ openBuiltinHelpDoc: vi.fn() }))
import './demo-stage'

const leaf = (id: string, sessions: string[] = []): PaneLeaf => ({
  id, type: 'leaf', sessions, activeSessionId: sessions[0] ?? null, overlays: []
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
  usePaneStore.setState({
    layout: { root: leaf('target'), activePaneId: 'target' },
    overlayPayloads: {}, hiddenTabSessions: {}
  })
  useSessionStore.setState({ sessions: [], savedSessions: [] })
  delete document.body.dataset.demoScene
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('演示场景就绪', () => {
  it.each([false, true])('复用终端并撤下手册覆盖层（其他分屏=%s）', async (otherPane) => {
    const config = { id: 'local', type: ConnectionType.LOCAL } as SessionConfig
    useSessionStore.setState({ sessions: [{ id: 'local', config, status: ConnectionStatus.CONNECTED }] })
    const target = leaf('target', otherPane ? [] : ['local'])
    usePaneStore.setState({
      layout: {
        root: otherPane ? {
          id: 'split', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: target, secondChild: leaf('source', ['local'])
        } : target,
        activePaneId: 'target'
      },
      hiddenTabSessions: { local: true }
    })
    const docId = usePaneStore.getState().openDocTab('target', {
      source: 'builtin', docKind: 'markdown', path: 'lyshell://help.md',
      title: '手册', content: '# 手册', size: 4, mtime: 0
    })
    const scene = window.lyshellDemoScene(2)
    await vi.advanceTimersByTimeAsync(1300)
    expect(await scene).toBe(2)
    const result = usePaneStore.getState().getPaneById('target') as PaneLeaf
    expect(result.sessions).toContain('local')
    expect(result.activeSessionId).toBe('local')
    expect(usePaneStore.getState().isOverlayActive(docId)).toBe(false)
    expect(usePaneStore.getState().hiddenTabSessions.local).toBeUndefined()
  })

  it.each([4, 6])('场景 %s 等待慢速清单 IPC 完成后再返回', async (index) => {
    let resolveAgents!: (value: unknown[]) => void
    const agents = new Promise<unknown[]>(resolve => { resolveAgents = resolve })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      listAgents: () => agents,
      listEnvProfiles: async () => ({ profiles: [] }),
      listPlugins: async () => [],
      listDshWorkspaces: async () => [],
      listCodexWorkspaces: async () => [],
      listClaudeWorkspaces: async () => []
    }
    let ready = false
    const scene = window.lyshellDemoScene(index).then(result => { ready = true; return result })
    await vi.advanceTimersByTimeAsync(2000)
    expect(ready).toBe(false)
    expect(document.body.dataset.demoScene).toBeUndefined()
    resolveAgents([])
    await vi.advanceTimersByTimeAsync(1400)
    expect(await scene).toBe(index)
    const doc = Object.values(usePaneStore.getState().overlayPayloads).find(payload => payload.kind === 'doc')
    expect(doc?.kind === 'doc' && doc.size > 0).toBe(true)
  })
})
