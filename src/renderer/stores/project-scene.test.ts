// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayPayload, PaneLayout, PaneNode } from '@shared/types'
import { ConnectionType } from '@shared/types'
import type { ProjectScene, SceneNode, SceneTarget } from '@shared/project-scene'
import type { SessionState } from './session-store'
import {
  captureProjectScene,
  registerSceneSession,
  resetProjectSceneRuntime,
  restoreProjectScene,
  saveCurrentProjectScene,
  sceneTargetKey
} from './project-scene'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'

const target: SceneTarget = { presetId: 'a', cwd: 'C:\\A', isolation: 'shared' }
const otherTarget: SceneTarget = { presetId: 'b', cwd: 'C:\\B', isolation: 'shared' }
const worktreeTarget: SceneTarget = { presetId: 'a', cwd: 'C:\\A', isolation: 'worktree', worktreeKey: 'feat' }

const readDoc = vi.fn()
const request = vi.fn()

const leaf = (id: string, extra: Partial<Extract<PaneNode, { type: 'leaf' }>> = {}): PaneNode =>
  ({ id, type: 'leaf', sessions: [], activeSessionId: null, overlays: [], ...extra })
const firstLeafId = (node: PaneNode): string => node.type === 'leaf' ? node.id : firstLeafId(node.firstChild)
const session = (id: string, cwd: string, tag: string | undefined = 'codex:launcher-a'): SessionState => ({
  id,
  status: 'disconnected' as SessionState['status'],
  cwd,
  config: {
    id,
    name: id,
    type: ConnectionType.LOCAL,
    tags: tag ? [tag] : [],
    terminal: {} as SessionState['config']['terminal'],
    startupCommands: ['deploy secret'],
    local: { cwd, env: { API_KEY: 'secret' } },
    createdAt: new Date(),
    updatedAt: new Date()
  }
})
const docPayload = (path: string, extra: { projectSceneKey?: string; projectSceneId?: string } = {}): OverlayPayload =>
  ({ kind: 'doc', source: 'local', docKind: 'markdown', path, title: 'README', content: '# cached', size: 8, mtime: 1, ...extra }) as OverlayPayload
const sceneOf = (id: string, root: SceneNode, tg: SceneTarget = target, activeLeaf = 0): ProjectScene =>
  ({ version: 1, id, savedAt: 1, target: tg, directory: tg.cwd, activeLeaf, root })
const leafScene = (...entries: Extract<SceneNode, { type: 'leaf' }>['entries']): SceneNode =>
  ({ type: 'leaf', active: 0, entries })

function mount(root: PaneNode, options: { payloads?: Record<string, OverlayPayload>; sessions?: SessionState[]; activePaneId?: string; hidden?: Record<string, boolean> } = {}) {
  usePaneStore.setState({
    layout: { activePaneId: options.activePaneId ?? firstLeafId(root), root },
    overlayPayloads: options.payloads ?? {},
    hiddenTabSessions: options.hidden ?? {}
  })
  useSessionStore.setState({ sessions: options.sessions ?? [] })
}

beforeEach(() => {
  resetProjectSceneRuntime()
  readDoc.mockReset()
  readDoc.mockImplementation(async () => ({ success: false, error: 'missing' }))
  request.mockReset()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', fileReadLocalDoc: readDoc, projectSceneRequest: request } })
  mount(leaf('empty'))
})

describe('project scene capture', () => {
  const layout: PaneLayout = { activePaneId: 'pane', root: { id: 'pane', type: 'leaf', sessions: ['a', 'b'], activeSessionId: 'a', overlays: [{ id: 'doc', kind: 'doc', active: true, slot: 1 }, { id: 'web', kind: 'web', active: false, slot: null }, { id: 'auth', kind: 'web', active: false, slot: null }] } }

  it('captures mixed tab order while excluding other projects and secret fields', () => {
    const payloads: Record<string, OverlayPayload> = {
      doc: { kind: 'doc', source: 'local', docKind: 'markdown', path: 'C:\\A\\README.md', title: 'README', content: 'secret', size: 6, mtime: 1 },
      web: { kind: 'web', url: 'https://example.com/docs', title: 'secret title' },
      auth: { kind: 'web', url: 'https://example.com/?token=secret', title: 'auth' }
    }
    const result = captureProjectScene(target, 'C:\\A', layout, payloads, [session('a', 'c:/a/'), session('b', 'C:\\B')])
    expect(result.root).toEqual({ type: 'leaf', active: 1, entries: [{ kind: 'agent', agentKind: 'codex', agentId: 'launcher-a' }, { kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'web', url: 'https://example.com/docs' }] })
    expect(JSON.stringify(result.root)).not.toMatch(/secret|deploy|content|env|status/)
    expect(result.issues).toHaveLength(1)
    payloads.web.projectSceneKey = sceneTargetKey({ ...target, cwd: 'C:\\B', presetId: 'b' })
    const other = captureProjectScene(target, 'C:\\A', layout, payloads, [])
    expect(JSON.stringify(other.root)).not.toContain('example.com/docs')
  })

  it('preserves sorted overflow slots and excludes hidden terminals and sibling worktree docs', () => {
    const payloads: Record<string, OverlayPayload> = {
      late: { kind: 'web', url: 'https://example.com/late', title: '' },
      early: { kind: 'web', url: 'https://example.com/early', title: '' },
      tree: { kind: 'doc', source: 'local', path: 'C:\\A\\.lyshell-worktrees\\other\\README.md', docKind: 'markdown', title: '', content: '', size: 0, mtime: 0 }
    }
    const mixed: PaneLayout = { activePaneId: 'p', root: { id: 'p', type: 'leaf', sessions: ['a'], activeSessionId: 'a', overlays: [{ id: 'late', kind: 'web', active: false, slot: 5 }, { id: 'early', kind: 'web', active: true, slot: 3 }, { id: 'tree', kind: 'doc', active: false, slot: null }] } }
    const result = captureProjectScene(target, target.cwd, mixed, payloads, [session('a', target.cwd)], { a: true })
    expect(result.root).toEqual({ type: 'leaf', active: 0, entries: [{ kind: 'web', url: 'https://example.com/early' }, { kind: 'web', url: 'https://example.com/late' }] })
  })
})

describe('project scene restore idempotency', () => {
  it('locates already-mounted resources on repeat continue instead of reading or splitting again', async () => {
    readDoc.mockImplementation(async () => ({ success: true, data: { content: '# readme', size: 8, mtime: 1 } }))
    const scene = sceneOf('repeat', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'web', url: 'https://example.com/docs' }))

    const first = await restoreProjectScene(scene)
    expect(first.restored).toBe(2)
    expect(first.focused).toBe(false)
    expect(readDoc).toHaveBeenCalledTimes(1)
    const mounted = usePaneStore.getState()
    const mountedLayout = mounted.layout
    const mountedIds = Object.keys(mounted.overlayPayloads).sort()
    expect(mountedIds).toHaveLength(2)

    const second = await restoreProjectScene(scene)
    expect(second.restored).toBe(0)
    expect(second.focused).toBe(true)
    expect(readDoc).toHaveBeenCalledTimes(1)
    const after = usePaneStore.getState()
    expect(after.layout).toBe(mountedLayout)
    expect(Object.keys(after.overlayPayloads).sort()).toEqual(mountedIds)
  })

  it('shares one in-flight materialization for concurrent continue of the same scene', async () => {
    let release: (() => void) | undefined
    readDoc.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ success: true, data: { content: '# readme', size: 8, mtime: 1 } }) }))
    const scene = sceneOf('race', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }))

    const first = restoreProjectScene(scene)
    const second = restoreProjectScene(scene)
    release?.()
    const [a, b] = await Promise.all([first, second])
    expect(readDoc).toHaveBeenCalledTimes(1)
    expect(a.restored).toBe(1)
    expect(b.restored).toBe(a.restored)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(1)
  })

  it('focuses surviving content when only part of the scene is still open', async () => {
    const key = sceneTargetKey(target)
    const root: PaneNode = {
      id: 'split', type: 'split', direction: 'vertical', splitRatio: .5,
      firstChild: leaf('p1', { overlays: [{ id: 'doc', kind: 'doc', active: true, slot: null }] }),
      secondChild: leaf('p2', { sessions: ['term'], activeSessionId: 'term' })
    }
    mount(root, { payloads: { doc: docPayload('C:\\A\\README.md', { projectSceneKey: key }) }, sessions: [session('term', 'C:\\A', 'codex:launcher-a')] })
    const mounted = usePaneStore.getState().layout
    const scene = sceneOf('partial', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'agent', agentKind: 'codex', agentId: 'launcher-a' }))

    const result = await restoreProjectScene(scene)
    expect(result.restored).toBe(0)
    expect(result.focused).toBe(true)
    const after = usePaneStore.getState()
    // 只定位：分屏树、页签与终端全部保留，覆盖层不复制。
    expect(after.layout.root).toBe(mounted.root)
    expect(after.layout.activePaneId).toBe('p1')
    expect(Object.keys(after.overlayPayloads)).toEqual(['doc'])
    expect(after.overlayPayloads.doc).toMatchObject({ projectSceneKey: key, projectSceneId: 'partial' })
    expect(after.getAllOpenSessionIds()).toEqual(['term'])
  })

  it('restores again after every scene resource was closed', async () => {
    readDoc.mockImplementation(async () => ({ success: true, data: { content: '# readme', size: 8, mtime: 1 } }))
    const scene = sceneOf('closed', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'web', url: 'https://example.com/docs' }))
    await restoreProjectScene(scene)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(2)

    // 用户把现场资源全部关掉：已实现记录不得阻挡重新恢复。
    mount(leaf('empty'))
    const again = await restoreProjectScene(scene)
    expect(again.restored).toBe(2)
    expect(again.focused).toBe(false)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(2)
  })

  it('fills in entries that became readable without duplicating already mounted ones', async () => {
    let missing = true
    readDoc.mockImplementation(async (path: string) => path.includes('missing') && missing
      ? { success: false, error: 'ENOENT' }
      : { success: true, data: { content: path, size: 8, mtime: 1 } })
    const scene = sceneOf('repair', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'doc', path: 'C:\\A\\missing.md' }))

    const first = await restoreProjectScene(scene)
    expect(first.restored).toBe(1)
    expect(first.issues.join()).toContain('missing')

    missing = false
    const second = await restoreProjectScene(scene)
    expect(second.restored).toBe(1)
    // 修复后只为新增有效项读一次，已有 README 不重读、不复制。
    expect(readDoc.mock.calls.map(call => call[0])).toEqual(['C:\\A\\README.md', 'C:\\A\\missing.md', 'C:\\A\\missing.md'])
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(2)
  })

  it('never reuses scene resources across projects or worktrees', async () => {
    readDoc.mockImplementation(async () => ({ success: true, data: { content: '# readme', size: 8, mtime: 1 } }))
    const otherKey = sceneTargetKey(otherTarget)
    const sharedKey = sceneTargetKey(target)
    mount(leaf('p1', { overlays: [{ id: 'doc', kind: 'doc', active: true, slot: null }, { id: 'entry', kind: 'projectEntry', active: false, slot: null }] }), {
      payloads: {
        doc: docPayload('C:\\A\\README.md', { projectSceneKey: otherKey }),
        entry: { kind: 'projectEntry', target, entry: { kind: 'directory' }, projectSceneKey: sharedKey }
      }
    })
    const entries = leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'directory' })

    const foreign = await restoreProjectScene(sceneOf('iso', entries, worktreeTarget))
    expect(foreign.restored).toBe(2)
    // 原归属不被改写。
    expect(usePaneStore.getState().overlayPayloads.doc.projectSceneKey).toBe(otherKey)
    expect(usePaneStore.getState().overlayPayloads.entry.projectSceneKey).toBe(sharedKey)

    // 反向：共享目录现场只定位自己的目录入口，不借用 worktree 新建的那份。
    const own = await restoreProjectScene(sceneOf('iso', leafScene({ kind: 'directory' }), target))
    expect(own.restored).toBe(0)
    expect(own.focused).toBe(true)
    expect(usePaneStore.getState().overlayPayloads.entry).toMatchObject({ projectSceneKey: sharedKey, projectSceneId: 'iso' })
  })

  it('locates a terminal registered through registerSceneSession and stops after detaching it', async () => {
    readDoc.mockImplementation(async () => ({ success: true, data: { content: 'x', size: 1, mtime: 1 } }))
    mount(leaf('p1', { sessions: ['t1'], activeSessionId: 't1' }), { sessions: [session('t1', 'C:\\ELSEWHERE', 'claude:launcher-x')] })
    const root = leafScene({ kind: 'agent', agentKind: 'claude', agentId: 'launcher-x' })

    // 未注册且目录不一致：只能新建入口（此处用另一个 agent，避免与下面共用身份）。
    const cold = await restoreProjectScene(sceneOf('cold', leafScene({ kind: 'agent', agentKind: 'claude', agentId: 'launcher-other' })))
    expect(cold.restored).toBe(1)

    registerSceneSession('warm', 't1')
    const warm = await restoreProjectScene(sceneOf('warm', root))
    expect(warm.restored).toBe(0)
    expect(warm.focused).toBe(true)

    registerSceneSession(undefined, 't1')
    const detached = await restoreProjectScene(sceneOf('detached', root))
    expect(detached.restored).toBe(1)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(2)
  })

  it('keeps active tabs and processes untouched when continuing only locates content', async () => {
    const key = sceneTargetKey(target)
    const root: PaneNode = leaf('p1', {
      sessions: ['term'],
      activeSessionId: 'term',
      overlays: [{ id: 'entry', kind: 'projectEntry', active: false, slot: null }]
    })
    mount(root, {
      payloads: { entry: { kind: 'projectEntry', target, entry: { kind: 'directory' }, projectSceneKey: key } },
      sessions: [session('term', 'C:\\A', 'codex:launcher-a')]
    })
    const before = usePaneStore.getState().layout
    const result = await restoreProjectScene(sceneOf('tabs', leafScene({ kind: 'agent', agentKind: 'codex', agentId: 'launcher-a' }, { kind: 'directory' })))
    expect(result.restored).toBe(0)
    expect(result.focused).toBe(true)
    const after = usePaneStore.getState()
    expect(after.layout).toBe(before)
    expect(after.layout.root.type === 'leaf' && after.layout.root.activeSessionId).toBe('term')
    expect(after.layout.root.type === 'leaf' && after.layout.root.overlays[0].active).toBe(false)
  })

  it('does not change the current workspace when no valid resource remains', async () => {
    const before = usePaneStore.getState().layout
    const result = await restoreProjectScene(sceneOf('empty', { type: 'leaf', active: -1, entries: [] }))
    expect(result.restored).toBe(0)
    expect(result.focused).toBe(false)
    expect(usePaneStore.getState().layout).toBe(before)
  })
})

describe('project scene save and continue', () => {
  it('locates the resources already on screen after saving the current scene', async () => {
    readDoc.mockImplementation(async () => ({ success: true, data: { content: '# readme', size: 8, mtime: 1 } }))
    request.mockImplementation(async (input: { kind: string; root?: SceneNode; activeLeaf?: number }) => input.kind === 'inspect'
      ? { success: true, cwd: 'C:\\A', scenes: [], issues: [] }
      : { success: true, scenes: [sceneOf('fresh', input.root!, target, input.activeLeaf ?? 0)], scene: sceneOf('fresh', input.root!, target, input.activeLeaf ?? 0), issues: [] })
    const root = leaf('p1', { sessions: ['t1'], activeSessionId: 't1', overlays: [{ id: 'doc', kind: 'doc', active: false, slot: null }] })
    mount(root, { payloads: { doc: docPayload('C:\\A\\README.md') }, sessions: [session('t1', 'C:\\A', 'codex:launcher-a')] })

    const saved = await saveCurrentProjectScene(target)
    expect(saved.scene?.id).toBe('fresh')
    expect(usePaneStore.getState().overlayPayloads.doc.projectSceneId).toBe('fresh')

    const continued = await restoreProjectScene(saved.scene!)
    expect(continued.restored).toBe(0)
    expect(continued.focused).toBe(true)
    expect(readDoc).not.toHaveBeenCalled()
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual(['doc'])
    expect(usePaneStore.getState().layout.root).toBe(root)
  })

  it('restores a fully closed scene even if an unrelated document from that project is open', async () => {
    readDoc.mockResolvedValue({ success: true, data: { content: '# doc', size: 5, mtime: 1 } })
    const scene = sceneOf('closed-with-other-doc', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }))
    await restoreProjectScene(scene)
    mount(leaf('other', { overlays: [{ id: 'other-doc', kind: 'doc', active: true, slot: null }] }), { payloads: { 'other-doc': docPayload('C:\\A\\other.md') } })
    const result = await restoreProjectScene(scene)
    expect(result.restored).toBe(1)
    expect(result.focused).toBe(false)
    expect(Object.values(usePaneStore.getState().overlayPayloads).map(item => item.kind === 'doc' ? item.path : '')).toEqual(['C:\\A\\other.md', 'C:\\A\\README.md'])
  })

  it('continues a just-saved navigated web tab without opening it a second time', async () => {
    const root = leaf('web-pane', { overlays: [{ id: 'web', kind: 'web', active: true, slot: null }] })
    mount(root, { payloads: { web: { kind: 'web', url: 'https://example.com/start', title: 'Docs', nav: { url: 'https://example.com/docs', canGoBack: true, canGoForward: false, loading: false } } } })
    const scene = sceneOf('navigated-save', leafScene({ kind: 'web', url: 'https://example.com/docs' }))
    request.mockImplementation(async (input: { kind: string }) => input.kind === 'inspect' ? { success: true, scenes: [], issues: [], cwd: target.cwd } : { success: true, scenes: [scene], scene, issues: [] })
    await saveCurrentProjectScene(target)
    const first = await restoreProjectScene(scene)
    expect(first).toMatchObject({ restored: 0, focused: true })
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual(['web'])
    const web = usePaneStore.getState().overlayPayloads.web
    if (web.kind === 'web') usePaneStore.setState({ overlayPayloads: { web: { ...web, nav: { ...web.nav!, url: 'https://example.com/next' } } } })
    const second = await restoreProjectScene(scene)
    expect(second).toMatchObject({ restored: 0, focused: true })
    expect(usePaneStore.getState().layout.root).toBe(root)
  })

  it('shows the existing scene tab when it was hidden behind an unrelated active tab', async () => {
    mount(leaf('p', { overlays: [{ id: 'doc', kind: 'doc', active: false, slot: null }, { id: 'web', kind: 'web', active: true, slot: null }] }), { payloads: { doc: docPayload('C:\\A\\README.md'), web: { kind: 'web', url: 'https://example.com/unrelated', title: '' } } })
    const result = await restoreProjectScene(sceneOf('hidden-doc', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' })))
    expect(result).toMatchObject({ restored: 0, focused: true })
    expect(usePaneStore.getState().isOverlayActive('doc')).toBe(true)
    expect(usePaneStore.getState().isOverlayActive('web')).toBe(false)
    expect(readDoc).not.toHaveBeenCalled()
  })

  it('respects a partially closed just-saved scene on its first continue', async () => {
    mount(leaf('p', { overlays: [{ id: 'readme', kind: 'doc', active: true, slot: null }, { id: 'notes', kind: 'doc', active: false, slot: null }] }), { payloads: { readme: docPayload('C:\\A\\README.md'), notes: docPayload('C:\\A\\notes.md') } })
    const scene = sceneOf('saved-then-closed', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'doc', path: 'C:\\A\\notes.md' }))
    request.mockImplementation(async (input: { kind: string }) => input.kind === 'inspect' ? { success: true, scenes: [], issues: [], cwd: target.cwd } : { success: true, scenes: [scene], scene, issues: [] })
    await saveCurrentProjectScene(target)
    usePaneStore.getState().closeOverlay('notes')
    const result = await restoreProjectScene(scene)
    expect(result).toMatchObject({ restored: 0, focused: true })
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual(['readme'])
    expect(readDoc).not.toHaveBeenCalled()
  })

  it('repairs a failed second occurrence without treating it as an intentionally closed tab', async () => {
    readDoc.mockResolvedValueOnce({ success: true, data: { content: 'x', size: 1, mtime: 1 } }).mockResolvedValueOnce({ success: false, error: 'temporary read failure' }).mockResolvedValue({ success: true, data: { content: 'x', size: 1, mtime: 1 } })
    const scene = sceneOf('two-copies', leafScene({ kind: 'doc', path: 'C:\\A\\README.md' }, { kind: 'doc', path: 'C:\\A\\README.md' }))
    expect((await restoreProjectScene(scene)).restored).toBe(1)
    expect((await restoreProjectScene(scene)).restored).toBe(1)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(2)
  })
})
