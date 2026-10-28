// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskShelf from './TaskShelf'
import { useTaskShelf } from '../../stores/task-shelf'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { DEFAULT_TASK_SHELF_PREFERENCES, type TaskShelfEntry, type TaskShelfRequest, type TaskShelfResult } from '@shared/task-shelf'
import '../../i18n'
import { ConnectionType } from '@shared/types'
import { useWorkbenchActivity } from '../../stores/workbench-activity'

const entry: TaskShelfEntry = { id: 'page', resourceKey: 'web:w', title: 'Saved reference', createdAt: 1, updatedAt: 1, revision: 1, capability: 'web', recovery: { kind: 'web', url: 'https://example.org/' } }
let listEntries: TaskShelfEntry[]
// mount 时 initializeTaskShelf 会先发 list，失败回执不能按调用序号注入，只能按 kind 指定。
let archiveResponse: TaskShelfResult | null = null
const request = vi.fn<[TaskShelfRequest], Promise<TaskShelfResult>>()
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); listEntries = [entry]; archiveResponse = null
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  request.mockReset(); request.mockImplementation(async input => {
    if (input.kind === 'archive') {
      if (archiveResponse) return archiveResponse
      const entries = listEntries.map(item => {
        if (item.id !== input.id) return item
        const next = { ...item }
        if (input.archived) next.archivedAt = 100
        else delete next.archivedAt
        return next
      })
      listEntries = entries
      return { success: true, entries }
    }
    if (input.kind === 'capture') return { success: true, entries: listEntries, entry: listEntries[0] }
    if (input.kind === 'remove') { listEntries = []; return { success: true, entries: [] } }
    return { success: true, entries: listEntries }
  })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: request } })
  useTaskShelf.setState({ entries: [entry], bindings: { page: { kind: 'web', id: 'w' } }, loaded: true, error: null, busy: {}, saveErrors: {}, panelVisible: false, viewRequest: null, preferences: { ...DEFAULT_TASK_SHELF_PREFERENCES } })
  useSessionStore.setState({ sessions: [] })
  useWorkbenchActivity.setState({ snapshot: null, notices: [], unreadNoticeIds: [], open: false })
  usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: [], activeSessionId: null, overlays: [{ kind: 'web', id: 'w', active: false, shelved: true, retained: true, slot: null }] }, activePaneId: 'p' }, overlayPayloads: { w: { kind: 'web', url: 'https://example.org/', title: entry.title } }, draggingOverlayId: null, draggingSessionId: null, hiddenTabSessions: {} })
})
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const openPanel = (view: ReturnType<typeof render>) => { fireEvent.click(view.getByRole('button', { name: /Toggle saved tasks/ })) }

describe('保存区交互入口', () => {
  it('方格显示所有任务缩影，下方同时显示多个原生窗口，选择只改变定位', async () => {
    const second: TaskShelfEntry = { ...entry, id: 'second', resourceKey: 'web:w2', title: 'Second task' }
    listEntries = [entry, second]
    useTaskShelf.setState({ entries: listEntries, bindings: { page: { kind: 'web', id: 'w' }, second: { kind: 'web', id: 'w2' } } })
    usePaneStore.setState(state => ({ overlayPayloads: { ...state.overlayPayloads, w2: { kind: 'web', url: 'https://example.com/', title: second.title } } }))
    localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'hover', width: 400 }))
    const available = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    try {
      const view = render(<TaskShelf />)
      openPanel(view)
      expect(view.container.querySelectorAll('.task-shelf-tile .task-shelf-preview')).toHaveLength(2)
      expect(view.container.querySelectorAll('.task-shelf-item')).toHaveLength(2)
      expect(view.container.querySelectorAll('[data-shelf-surface=web]')).toHaveLength(2)
      expect(view.container.querySelector('[data-shelf-entry=page]')?.textContent).toContain(entry.title)
      fireEvent.click(view.getByRole('button', { name: 'Task slot 2' }))
      expect(view.container.querySelector('[data-shelf-entry=second]')?.textContent).toContain(second.title)
      expect(view.container.querySelectorAll('.task-shelf-item')).toHaveLength(2)
      expect(view.getByRole('button', { name: 'Task slot 2' }).className).toContain('is-selected')
      expect(request.mock.calls.some(([r]) => r.kind === 'restore')).toBe(false)
      await tick(0)
    } finally { available.mockRestore() }
  })
  it('顶部格子固定排满末行，无任务时只保留空白格', async () => {
    const view = render(<TaskShelf />)
    openPanel(view)
    expect(view.container.querySelectorAll('.task-shelf-tile')).toHaveLength(2)
    expect(view.container.querySelectorAll('.task-shelf-tile.is-empty')).toHaveLength(1)
    listEntries = []
    act(() => useTaskShelf.setState({ entries: [], bindings: {} }))
    expect(view.container.querySelectorAll('.task-shelf-tile.is-empty')).toHaveLength(2)
    expect(view.container.querySelector('.task-shelf-item')).toBeNull()
    expect(view.queryByText('Keep your work close')).toBeNull()
    await tick(0)
  })
  it('回到大窗口的任务只保留顶部格子，再点格子召回同一实例', async () => {
    localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'hover', width: 400 }))
    const available = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    try {
      const view = render(<TaskShelf />)
      openPanel(view)
      expect(view.container.querySelector('.task-shelf-preview')).toBeTruthy()
      await act(async () => { fireEvent.click(view.getByRole('button', { name: /Saved reference/ })) })
      openPanel(view)
      expect(view.container.querySelector('.task-shelf-window-content .task-shelf-live-surface')).toBeNull()
      expect(view.getByRole('button', { name: 'Task slot 1' }).className).toContain('is-in-main')
      await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Task slot 1' })) })
      expect(usePaneStore.getState().getAllLeafPanes()[0].overlays).toHaveLength(1)
      expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: true, shelved: false })
      expect(request.mock.calls.some(([r]) => r.kind === 'restore')).toBe(false)
    } finally { available.mockRestore() }
  })
  it('SSH 的历史上下文只读展示，不将文本解释为页面或发送为命令', async () => {
    const saved: TaskShelfEntry = { ...entry, title: 'Saved SSH', resourceKey: 'terminal:ssh', recovery: { kind: 'terminal', sessionId: 'ssh', type: ConnectionType.SSH, cwd: '/srv/work' }, capability: 'reconnect', context: { text: 'result\n<script>command</script>', capturedAt: 1 } }
    listEntries = [saved]
    useTaskShelf.setState({ entries: [saved], bindings: {} })
    const view = render(<TaskShelf />)
    openPanel(view)
    fireEvent.focus(view.getByRole('button', { name: /Saved SSH/ }))
    expect(view.getByText('Remote directory: /srv/work')).toBeTruthy()
    const context = view.getByLabelText('Local history context')
    expect(context.tagName).toBe('PRE')
    expect(context.textContent).toBe('result\n<script>command</script>')
    expect(context.querySelector('script')).toBeNull()
    expect(request.mock.calls.filter(([r]) => r.kind === 'restore')).toHaveLength(0)
  })
  it('隐藏时零占位且面板不可交互，右边缘悬停展开，移出收起且不改变终端尺寸', async () => {
    const view = render(<TaskShelf />)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    expect(useTaskShelf.getState().reservedWidth).toBe(0)
    const panel = view.getByRole('complementary', { hidden: true })
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(view.container.querySelector('.task-shelf-rail')).toBeNull()
    const edge = view.getByRole('button', { name: /Toggle saved tasks/ })
    fireEvent.mouseEnter(edge); await tick(200)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    await tick(100)
    expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    expect(panel.hasAttribute('inert')).toBe(false)
    expect(useTaskShelf.getState().reservedWidth).toBe(0)
    fireEvent.mouseLeave(edge); fireEvent.mouseEnter(panel); await tick(400)
    expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    fireEvent.mouseLeave(panel); await tick(400)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(useTaskShelf.getState().reservedWidth).toBe(0)
  })
  it('快速掠过边缘不展开，Esc 关闭后不会被残留悬停定时器重新打开', async () => {
    const view = render(<TaskShelf />)
    const edge = view.getByRole('button', { name: /Toggle saved tasks/ })
    fireEvent.mouseEnter(edge); await tick(100); fireEvent.mouseLeave(edge); await tick(300)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    openPanel(view)
    fireEvent.mouseEnter(view.getByRole('complementary'))
    fireEvent.keyDown(window, { key: 'Escape' }); await tick(500)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
  })
  it('拖动页签到透明边缘立即展开，离开落区收起，再投放保存', async () => {
    const view = render(<TaskShelf />)
    await act(async () => { usePaneStore.getState().setDraggingOverlay('w') })
    const edge = view.getByRole('button', { name: /Toggle saved tasks/ })
    const dataTransfer = { dropEffect: '' }
    fireEvent.dragOver(edge, { dataTransfer })
    expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    expect(dataTransfer.dropEffect).toBe('move')
    expect(request.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(0)
    fireEvent.dragLeave(view.getByRole('complementary')); await tick(400)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    fireEvent.dragOver(edge, { dataTransfer })
    await act(async () => { fireEvent.drop(view.getByRole('complementary'), { dataTransfer }) })
    expect(request.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(1)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    expect(useTaskShelf.getState().reservedWidth).toBe(0)
  })
  it('宽屏停靠仍预留面板宽度，显式收起后释放全部空间', async () => {
    localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'fixed', width: 320 }))
    const available = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(2000)
    try {
      const view = render(<TaskShelf />)
      await tick(200)
      expect(useTaskShelf.getState().reservedWidth).toBe(320)
      expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
      fireEvent.click(view.getByRole('button', { name: 'Collapse saved tasks' }))
      expect(useTaskShelf.getState().reservedWidth).toBe(0)
      await tick(500)
      expect(useTaskShelf.getState().reservedWidth).toBe(0)
      expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    } finally { available.mockRestore() }
  })
  it('点击任务展开原网页并收起临时面板，记录继续保留', async () => {
    const view = render(<TaskShelf />)
    openPanel(view)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Saved reference/ })) })
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: true, shelved: false, retained: true })
    expect(useTaskShelf.getState().entries).toHaveLength(1)
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
  })
  it('模式选择可访问并保存用户偏好', async () => {
    const view = render(<TaskShelf />)
    openPanel(view)
    fireEvent.click(view.getByRole('button', { name: 'Hover' }))
    await tick(200)
    expect(view.getByRole('button', { name: 'Hover' }).getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('lyshell.taskShelf.view.v1')!).mode).toBe('hover')
  })
  it('标题与显示模式位于同一行，省去重复说明', () => {
    const view = render(<TaskShelf />)
    openPanel(view)
    const header = view.getByRole('heading', { name: 'Tasks' }).closest('header')!
    expect(header.contains(view.getByRole('group', { name: 'Task panel display' }))).toBe(true)
    expect(view.queryByText('Put it aside. Keep it running.')).toBeNull()
    expect(view.container.querySelector('.task-shelf-footer')).toBeNull()
    fireEvent.mouseEnter(view.container.querySelector('.task-shelf-item')!)
    expect(view.queryByText('Recovery')).toBeNull()
  })
  it('拖宽越过阈值显示预览，收窄或关闭后停止预览且不打开任务', async () => {
    localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'hover', width: 352 }))
    const available = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    try {
      const view = render(<TaskShelf />)
      openPanel(view)
      expect(view.container.querySelector('.task-shelf-window-content .task-shelf-live-surface')).toBeNull()
      const separator = view.getByRole('separator', { name: 'Resize saved tasks' })
      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      expect(view.container.querySelector('.task-shelf-window-content .task-shelf-live-surface')).toBeTruthy()
      expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0].shelved).toBe(true)
      expect(request.mock.calls.filter(([r]) => r.kind === 'restore')).toHaveLength(0)
      fireEvent.keyDown(separator, { key: 'ArrowRight' })
      expect(view.container.querySelector('.task-shelf-window-content .task-shelf-live-surface')).toBeNull()
      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      fireEvent.click(view.getByRole('button', { name: 'Collapse saved tasks' }))
      expect(view.container.querySelector('.task-shelf-preview')).toBeNull()
      await tick(500)
    } finally { available.mockRestore() }
  })
})

describe('归档交互', () => {
  it('打开归档条目时先移回任务区，再展开原网页并收起面板', async () => {
    const archived: TaskShelfEntry = { ...entry, title: 'Archived reference', archivedAt: 100 }
    listEntries = [archived]
    useTaskShelf.setState({ entries: [archived] })
    const view = render(<TaskShelf />)
    openPanel(view)
    await act(async () => { fireEvent.click(view.getByRole('tab', { name: /Archive/ })) })
    expect(view.getByRole('button', { name: /Archived reference/ })).toBeTruthy()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Archived reference/ })) })
    expect(request.mock.calls.map(([r]) => r).find(r => r.kind === 'archive')).toEqual({ kind: 'archive', id: 'page', archived: false })
    expect(useTaskShelf.getState().entries[0].archivedAt).toBeUndefined()
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: true, shelved: false, retained: true })
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
  })
  it('归档失败留在原视图：任务仍在列表，页签保持展开并显示错误', async () => {
    usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: [], activeSessionId: null, overlays: [{ kind: 'web', id: 'w', active: true, shelved: false, retained: true, slot: null }] }, activePaneId: 'p' } })
    archiveResponse = { success: false, error: 'disk full' }
    const view = render(<TaskShelf />)
    openPanel(view)
    fireEvent.contextMenu(view.getByRole('button', { name: 'Task slot 1' }))
    await act(async () => { fireEvent.click(view.getByRole('menuitem', { name: 'Archive and keep running' })) })
    expect(view.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('disk full'))
    expect(view.getByRole('button', { name: 'Task slot 1' }).getAttribute('title')).toContain('Saved reference')
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: true, shelved: false, retained: true })
    expect(useTaskShelf.getState().entries[0].archivedAt).toBeUndefined()
    expect(request.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(0)
  })
  it('归档成功后任务进入归档页签，运行页签仍保留', async () => {
    usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: [], activeSessionId: null, overlays: [{ kind: 'web', id: 'w', active: true, shelved: false, retained: true, slot: null }] }, activePaneId: 'p' } })
    const view = render(<TaskShelf />)
    openPanel(view)
    fireEvent.contextMenu(view.getByRole('button', { name: 'Task slot 1' }))
    await act(async () => { fireEvent.click(view.getByRole('menuitem', { name: 'Archive and keep running' })) })
    expect(request.mock.calls.map(([r]) => r).find(r => r.kind === 'archive')).toEqual({ kind: 'archive', id: 'page', archived: true })
    expect(useTaskShelf.getState().entries[0].archivedAt).toBe(100)
    expect(usePaneStore.getState().overlayPayloads.w).toBeDefined()
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: false, shelved: true, retained: true })
    // 归档页签计数更新；任务页签不再列出该条目
    expect(view.getByRole('tab', { name: /Archive/ })).toHaveProperty('textContent', expect.stringContaining('1'))
    expect(view.queryByRole('button', { name: /Saved reference/ })).toBeNull()
  })
})

describe('主进程 before-input-event 桥接', () => {
  it('桥接注册后 window keydown 不再本地执行，toggle/collect 各只生效一次', async () => {
    let bridgeHandler: ((action: 'toggle' | 'collect') => void) | undefined
    const off = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: request, onTaskShelfShortcut: (handler: (action: 'toggle' | 'collect') => void) => { bridgeHandler = handler; return off } } })
    const view = render(<TaskShelf />)
    openPanel(view)
    expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    // 主进程已 preventDefault 时页面拿不到 keydown；若仍然收到，桥接模式下不能再次切换。
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true, shiftKey: true, bubbles: true })
    expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    await act(async () => { bridgeHandler!('toggle') })
    expect(view.queryByRole('heading', { name: 'Tasks' })).toBeNull()
    await act(async () => { bridgeHandler!('toggle') })
    expect(view.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    // 同样的重复投递对 collect 也只应产生一次保存。
    usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: [], activeSessionId: null, overlays: [{ kind: 'web', id: 'w', active: true, shelved: false, retained: true, slot: null }] }, activePaneId: 'p' } })
    await act(async () => { bridgeHandler!('collect') })
    expect(request.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, shiftKey: true, bubbles: true })
    expect(request.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(1)
    view.unmount()
    expect(off).toHaveBeenCalled()
  })
})
