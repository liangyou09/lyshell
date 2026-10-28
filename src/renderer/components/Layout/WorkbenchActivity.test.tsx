// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchActivity } from './WorkbenchActivity'
import { WorkbenchActivityButton } from './WorkbenchActivityButton'
import { useWorkbenchActivity } from '../../stores/workbench-activity'
import { useSessionStore } from '../../stores/session-store'
import { useTaskShelf } from '../../stores/task-shelf'
import type { WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ i18n: { language: 'zh' } }) }))
const request = vi.fn()
let snapshot: WorkbenchActivitySnapshot
beforeEach(() => {
  request.mockReset()
  useTaskShelf.setState({ entries: [], bindings: {}, panelVisible: false, viewRequest: null })
  snapshot = { observedAt: Date.now(), connection: 'connected', identity: { instanceId: 'backend-a', instanceEpoch: 1 }, sessions: [{ key: 'key-a', workspace: 'C:/project/.lyshell-worktrees/feature', sessionId: 'native-a', taskId: 'task-a', taskState: 'running', source: 'native-harness', updatedAt: Date.now(), stale: false, approvals: [{ id: 'approval-a', reason: '执行命令', toolName: 'shell', options: ['allowed-once', 'rejected'], askedAt: Date.now() }] }] }
  request.mockResolvedValue(snapshot)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', workbenchActivityRequest: request } })
  useWorkbenchActivity.setState({ snapshot, open: true, panelView: 'sessions', workspace: null, notices: [], unreadNoticeIds: [], muted: [], busy: false, error: null, actionError: null })
  useSessionStore.setState({ sessions: [{ id: 'local-a', status: ConnectionStatus.CONNECTED, config: { id: 'local-a', name: 'Codex terminal', type: ConnectionType.LOCAL, local: { cwd: 'C:/project' }, tags: ['codex:a'], terminal: {} as SessionConfig['terminal'], createdAt: new Date(), updatedAt: new Date() } }] })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('项目会话与任务面板', () => {
  it('已有未读任务时铃铛收回并定位同一小窗口，面板已展开也不会先关闭', async () => {
    const hidden = vi.spyOn(useTaskShelf.getState(), 'hide').mockImplementation(() => {})
    try {
      useTaskShelf.setState({ panelVisible: true, entries: [{ id: 'saved-terminal', resourceKey: 'terminal:local-a', title: 'Codex', createdAt: 1, updatedAt: 1, revision: 1, capability: 'local-live', recovery: { kind: 'terminal', sessionId: 'local-a', type: ConnectionType.LOCAL } }], bindings: { 'saved-terminal': { kind: 'terminal', id: 'local-a' } } })
      useWorkbenchActivity.setState({ open: false, notices: [{ id: 'cli-notice', source: 'codex', workspace: 'C:/project', sessionId: 'local-a', taskId: 'turn-a', kind: 'approval', at: Date.now() }], unreadNoticeIds: ['cli-notice'] })
      const view = render(<WorkbenchActivityButton />)
      fireEvent.click(view.getByRole('button', { name: '会话与任务 · 1 条未读提醒' }))
      expect(hidden).toHaveBeenCalledWith('saved-terminal')
      expect(useTaskShelf.getState().viewRequest).toMatchObject({ open: true, entryId: 'saved-terminal' })
      expect(useWorkbenchActivity.getState().unreadNoticeIds).toEqual([])
      await act(async () => {})
    } finally { hidden.mockRestore() }
  })
  it('内置聊天支持目录筛选并提供工作台入口，不出现代答审批按钮', async () => {
    snapshot = { ...snapshot, identity: null, connection: 'offline', sessions: [], web: { observedAt: Date.now(), identity: { instanceId: 'web-backend', instanceEpoch: 2 }, connection: 'connected', revision: 1, events: [], sessions: [{ sessionId: 'web-a', workspace: 'D:/web', turnId: 'web-turn', state: 'waiting-approval', updatedAt: Date.now(), approvalIds: ['approval-a'] }] } }
    request.mockResolvedValue(snapshot)
    useWorkbenchActivity.setState({ snapshot })
    const navigate = vi.fn().mockResolvedValue({ success: false, error: '导航测试到此为止' })
    Object.assign(window.electronAPI, { workbenchActivityNavigate: navigate })
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'd:/web' } })
    expect(view.getByText('等待审批 · 请在工作台处理')).toBeTruthy()
    expect(view.queryByText('Codex terminal')).toBeNull()
    expect(view.queryByRole('button', { name: '仅允许一次' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '打开工作台' }))
    await act(async () => {})
    expect(navigate).toHaveBeenCalledWith({ kind: 'open', identity: snapshot.web!.identity, sessionId: 'web-a' })
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, web: { ...snapshot.web!, connection: 'stale' } } }))
    expect(view.getByRole('button', { name: '打开工作台' }).hasAttribute('disabled')).toBe(true)
  })
  it('TUI 官方事件显示回合语义，审批只提供原终端定位', async () => {
    snapshot = { ...snapshot, identity: null, connection: 'offline', sessions: [], tui: { observedAt: Date.now(), events: [], sessions: [{ terminalId: 'local-a', launchId: 'launch-a', source: 'codex', workspace: 'C:/project', cliSessionId: 'cli-a', turnId: 'turn-a', state: 'turn-ended', event: 'Stop', updatedAt: Date.now(), active: true }] } }
    request.mockResolvedValue(snapshot)
    useWorkbenchActivity.setState({ snapshot })
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    expect(view.getByText('本轮结束 · 不代表整个目标完成')).toBeTruthy()
    expect(view.queryByText('已完成', { exact: true })).toBeNull()
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, tui: { ...snapshot.tui!, sessions: [{ ...snapshot.tui!.sessions[0], state: 'waiting-approval' }] } } }))
    expect(view.getByText('等待审批 · 请在终端处理')).toBeTruthy()
    expect(view.getByRole('button', { name: '定位终端' })).toBeTruthy()
    expect(view.queryByRole('button', { name: '仅允许一次' })).toBeNull()
  })
  it('存活终端不显示任务执行中；原生任务使用权威审批状态', async () => {
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    const terminal = view.getByText('Codex terminal').closest('article')!
    expect(within(terminal).getByText('存活')).toBeTruthy()
    expect(within(terminal).getByText('未知 · CLI 未提供可靠状态')).toBeTruthy()
    expect(view.getByText('等待审批')).toBeTruthy()
    expect(view.getByRole('button', { name: '仅允许一次' }).hasAttribute('disabled')).toBe(true)
  })
  it('按实际 worktree 目录过滤，主目录不会混入', async () => {
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'c:/project/.lyshell-worktrees/feature' } })
    expect(view.queryByText('Codex terminal')).toBeNull()
    expect(view.getByText('Harness · native-a')).toBeTruthy()
  })
  it('断线禁用全部审批，完整参数仅在用户点击时提交同一任务身份', async () => {
    snapshot.sessions[0].approvals[0].operation = '{"command":"pwd"}'
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    expect(request.mock.calls.every(([arg]) => arg.kind === 'snapshot')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: '仅允许一次' }))
    await act(async () => {})
    expect(request).toHaveBeenCalledWith({ kind: 'approve', identity: snapshot.identity, sessionId: 'native-a', taskId: 'task-a', approvalId: 'approval-a', optionId: 'allowed-once' })
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, connection: 'stale' } }))
    expect(view.getByRole('button', { name: '仅允许一次' }).hasAttribute('disabled')).toBe(true)
    expect(view.getByText('未知 · 状态已过期')).toBeTruthy()
  })
  it('切换项目保留提醒所属目录，并提供项目静音和关闭键盘入口', async () => {
    useWorkbenchActivity.setState({ panelView: 'notices', notices: [{ id: 'notice-a', workspace: 'C:/other', sessionId: 'other-s', taskId: 'other-t', kind: 'completed', at: Date.now() }], unreadNoticeIds: ['notice-a'] })
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: /other.*任务已完成/ }))
    expect(useWorkbenchActivity.getState().workspace).toBe('C:/other')
    expect(useWorkbenchActivity.getState().selectedSessionId).toBe('other-s')
    fireEvent.click(view.getByRole('button', { name: '静音此项目' }))
    expect(useWorkbenchActivity.getState().muted).toContain('c:/other')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })
  it('标题栏铃铛直接请求打开右侧小窗口提醒，详细面板继续可键盘访问', async () => {
    useWorkbenchActivity.setState({ open: false, unreadNoticeIds: ['unread-a'], notices: [{ id: 'unread-a', workspace: 'C:/other', sessionId: 'other-s', taskId: 'other-t', kind: 'completed', at: Date.now() }] })
    const view = render(<><WorkbenchActivityButton/><WorkbenchActivity/></>)
    await act(async () => {})
    expect(document.querySelector('.workbench-activity-bar')).toBeNull()
    const trigger = view.getByRole('button', { name: '会话与任务 · 1 条未读提醒' })
    fireEvent.click(trigger)
    expect(useTaskShelf.getState().viewRequest).toMatchObject({ open: true, notices: true })
    expect(useWorkbenchActivity.getState().open).toBe(false)
    act(() => useWorkbenchActivity.getState().showNotifications())
    const notifications = view.getByRole('tab', { name: /提醒/ })
    expect(notifications.getAttribute('aria-selected')).toBe('true')
    notifications.focus()
    fireEvent.keyDown(notifications, { key: 'ArrowRight' })
    expect(view.getByRole('tab', { name: /会话/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })
})
