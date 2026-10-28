// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskShelf from './TaskShelf'
import { useTaskShelf } from '../../stores/task-shelf'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { DEFAULT_TASK_SHELF_PREFERENCES, type TaskShelfEntry, type TaskShelfRequest, type TaskShelfResult } from '@shared/task-shelf'
import '../../i18n'

const entry: TaskShelfEntry = { id: 'page', resourceKey: 'web:w', title: 'Saved reference', createdAt: 1, updatedAt: 1, revision: 1, capability: 'web', recovery: { kind: 'web', url: 'https://example.org/' } }
const request = vi.fn<[TaskShelfRequest], Promise<TaskShelfResult>>()

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  request.mockReset(); request.mockImplementation(async input => {
    if (input.kind === 'capture') return { success: true, entries: [entry], entry }
    if (input.kind === 'remove') return { success: true, entries: [] }
    return { success: true, entries: [entry] }
  })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: request } })
  useTaskShelf.setState({ entries: [entry], bindings: { page: { kind: 'web', id: 'w' } }, loaded: true, error: null, busy: {}, saveErrors: {}, preferences: { ...DEFAULT_TASK_SHELF_PREFERENCES } })
  useSessionStore.setState({ sessions: [] })
  usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: [], activeSessionId: null, overlays: [{ kind: 'web', id: 'w', active: false, shelved: true, retained: true, slot: null }] }, activePaneId: 'p' }, overlayPayloads: { w: { kind: 'web', url: 'https://example.org/', title: entry.title } }, draggingOverlayId: null, draggingSessionId: null, hiddenTabSessions: {} })
})
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

/** 展开保存区，分别从窄栏卡片和宽栏小窗标题打开菜单。 */
const setup = async (width: number) => {
  vi.stubGlobal('innerWidth', 1800)
  localStorage.setItem('lyshell.taskShelf.view.v1', JSON.stringify({ mode: 'hover', width }))
  const view = render(<TaskShelf />)
  fireEvent.click(view.getByRole('button', { name: /Toggle saved tasks/ }))
  const openItem = view.getByRole('button', { name: width >= 360 ? /Saved reference/ : 'Task slot 1' })
  openItem.focus()
  fireEvent.contextMenu(openItem.closest('.task-shelf-item') ?? openItem, { clientX: 120, clientY: 80 })
  const menu = view.getByRole('menu', { name: 'Task actions' })
  return { view, openItem, menu }
}

describe.each([240, 600])('任务保存区右键菜单（宽度 %s）', width => {
  it('悬停展开时，焦点移入 portal 右键菜单仍保持面板展开', async () => {
    const view = render(<TaskShelf />)
    fireEvent.mouseEnter(view.getByRole('button', { name: /Toggle saved tasks/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    const panel = view.getByRole('complementary')
    const tile = view.getByRole('button', { name: 'Task slot 1' })
    tile.focus()
    fireEvent.contextMenu(tile, { clientX: 120, clientY: 80 })
    const menu = view.getByRole('menu', { name: 'Task actions' })
    fireEvent.mouseLeave(panel)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(view.getByRole('complementary').getAttribute('aria-hidden')).toBe('false')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(document.activeElement).toBe(tile)
  })
  it('重启后没有实时绑定的保存记录仍能归档和移除，不必先恢复', async () => {
    useTaskShelf.setState({ bindings: {} })
    usePaneStore.setState({ overlayPayloads: {} })
    const view = render(<TaskShelf />)
    fireEvent.click(view.getByRole('button', { name: /Toggle saved tasks/ }))
    const tile = view.getByRole('button', { name: 'Task slot 1' })
    fireEvent.contextMenu(tile, { clientX: 120, clientY: 80 })
    let menu = view.getByRole('menu', { name: 'Task actions' })
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive and keep running' })) })
    expect(request.mock.calls.map(([r]) => r)).toContainEqual({ kind: 'archive', id: 'page', archived: true })
    fireEvent.contextMenu(tile, { clientX: 120, clientY: 80 })
    menu = view.getByRole('menu', { name: 'Task actions' })
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop saving' })) })
    expect(request.mock.calls.map(([r]) => r)).toContainEqual({ kind: 'remove', id: 'page' })
    expect(request.mock.calls.some(([r]) => r.kind === 'restore' || r.kind === 'capture')).toBe(false)
  })

  it('右键已保存条目提供收起/归档/移除，并把焦点放到首个菜单项', async () => {
    const { menu } = await setup(width)
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Put back in saved tasks', 'Archive and keep running', 'Stop saving'])
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Put back in saved tasks' }))
  })

  // 菜单的 Escape 必须阻止冒泡：否则 TaskShelf.tsx 的 window keydown 会把保存区整体收起，
  // 触发元素随面板卸载，焦点落到 <body>。
  it('Escape 关闭菜单并把焦点还原到右键时的条目', async () => {
    const { view, openItem, menu } = await setup(width)
    fireEvent.keyDown(menu, { key: 'Escape' })
    await act(async () => {})
    expect(view.queryByRole('menu', { name: 'Task actions' })).toBeNull()
    expect(document.activeElement).toBe(openItem)
  })

  it('右键收纳只提交一次保存并收起原页签，不重建实例', async () => {
    const { view, menu } = await setup(width)
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Put back in saved tasks' })) })
    const captures = request.mock.calls.map(([r]) => r).filter(r => r.kind === 'capture')
    expect(captures).toEqual([{ kind: 'capture', resource: { kind: 'web', id: 'w', url: 'https://example.org/', title: 'Saved reference', post: false }, entryId: 'page' }])
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: false, shelved: true, retained: true })
    expect(usePaneStore.getState().overlayPayloads.w).toBeDefined()
    expect(view.queryByRole('menu', { name: 'Task actions' })).toBeNull()
  })

  it('右键移除停止保存但保留运行页签', async () => {
    const { view, menu } = await setup(width)
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop saving' })) })
    expect(request.mock.calls.map(([r]) => r)).toContainEqual({ kind: 'remove', id: 'page' })
    expect(useTaskShelf.getState().entries).toEqual([])
    expect(useTaskShelf.getState().bindings).toEqual({})
    // 移除只停止保存：原网页实例仍存活，并回到前台
    expect(usePaneStore.getState().overlayPayloads.w).toBeDefined()
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'w', active: true, retained: false })
    expect(view.queryByRole('menu', { name: 'Task actions' })).toBeNull()
  })
})
