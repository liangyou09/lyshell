// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchActivity, WorkbenchActivityMonitor } from './WorkbenchActivity'
import { useWorkbenchActivity } from '../../stores/workbench-activity'
import { useSessionStore } from '../../stores/session-store'
import { useTaskShelf } from '../../stores/task-shelf'
import type { WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'
import i18n from '../../i18n'

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ i18n: { language: 'zh' }, t: (key: string) => i18n.t(key, { lng: 'zh' }) }) }))
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
  it('状态灯随当前 CLI 事件更新，失活或过期后撤销旧审批，断开不当作完成', async () => {
    const tuiRow = { terminalId: 'local-a', launchId: 'launch-a', source: 'codex' as const, workspace: 'C:/project', cliSessionId: 'cli-a', turnId: 'turn-a', state: 'running' as const, event: 'UserPromptSubmit', updatedAt: Date.now(), active: true }
    snapshot = { ...snapshot, sessions: [], tui: { observedAt: Date.now(), events: [], sessions: [tuiRow] } }
    useWorkbenchActivity.setState({ snapshot })
    const view = render(<WorkbenchActivity />)
    const light = () => view.container.querySelector('[data-session-id="local-a"] [data-task-status]')!
    const visibleStatus = () => view.container.querySelector('[data-session-id="local-a"] .activity-session-state')!
    expect(light().getAttribute('data-task-status')).toBe('running')
    expect(visibleStatus().textContent).toBe('执行中')
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, tui: { ...snapshot.tui!, sessions: [{ ...tuiRow, state: 'waiting-approval' }] } } }))
    expect(light().getAttribute('data-task-status')).toBe('approval')
    expect(light().getAttribute('aria-label')).toBe('等待审批 · 请在终端处理')
    expect(visibleStatus().textContent).toBe('待确认')
    expect(visibleStatus().getAttribute('title')).toBe('等待审批 · 请在终端处理')
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, tui: { ...snapshot.tui!, sessions: [{ ...tuiRow, state: 'waiting-approval', active: false }] } } }))
    expect(light().getAttribute('data-task-status')).toBe('unknown')
    expect(visibleStatus().textContent).toBe('未知')
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, tui: { ...snapshot.tui!, observedAt: Date.now() - 12001 } } }))
    expect(light().getAttribute('data-task-status')).toBe('unknown')
    act(() => useSessionStore.setState(state => ({ sessions: state.sessions.map(row => ({ ...row, status: ConnectionStatus.DISCONNECTED })) })))
    expect(light().getAttribute('data-task-status')).toBe('disconnected')
    expect(light().getAttribute('aria-label')).toContain('任务结果未知')
    expect(visibleStatus().textContent).toBe('已断开')
    expect(visibleStatus().getAttribute('title')).toContain('任务结果未知')
  })
  it.each([
    ['accepted', '待运行'], ['running', '执行中'], ['completed', '已完成'], ['failed', '异常'],
    ['cancelled', '已中断'], ['unconfirmed', '未知'], ['unknown', '未知']
  ] as const)('原生任务 %s 的简短状态无需展开详情即可查看，过期后撤销旧状态', (taskState, label) => {
    snapshot = { ...snapshot, sessions: [{ ...snapshot.sessions[0], taskState, approvals: [] }] }
    useWorkbenchActivity.setState({ snapshot })
    useSessionStore.setState({ sessions: [] })
    const view = render(<WorkbenchActivity />)
    const row = view.container.querySelector<HTMLElement>('[data-session-id="native-a"]')!
    const visibleStatus = () => row.querySelector('.activity-session-state')!
    expect(visibleStatus().textContent).toBe(label)
    expect(row.querySelector('details')?.open).toBe(false)
    expect(within(row).getByRole('button', { name: /^打开工作台/ }).contains(visibleStatus())).toBe(true)
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, connection: 'stale' } }))
    expect(visibleStatus().textContent).toBe('未知')
    expect(visibleStatus().getAttribute('title')).toBe('未知 · 状态已过期')
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
    fireEvent.click(view.getByRole('button', { name: /^打开工作台/ }))
    await act(async () => {})
    expect(navigate).toHaveBeenCalledWith({ kind: 'open', identity: snapshot.web!.identity, sessionId: 'web-a' })
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, web: { ...snapshot.web!, connection: 'stale' } } }))
    expect(view.getByRole('button', { name: /^打开工作台/ }).hasAttribute('disabled')).toBe(true)
  })
  it('TUI 官方事件显示回合语义，审批只提供原终端定位', async () => {
    snapshot = { ...snapshot, identity: null, connection: 'offline', sessions: [], tui: { observedAt: Date.now(), events: [], sessions: [{ terminalId: 'local-a', launchId: 'launch-a', source: 'codex', workspace: 'C:/project', cliSessionId: 'cli-a', turnId: 'turn-a', state: 'turn-ended', event: 'Stop', updatedAt: Date.now(), active: true }] } }
    request.mockResolvedValue(snapshot)
    useWorkbenchActivity.setState({ snapshot })
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    expect(view.getByText('本轮结束 · 不代表整个目标完成')).toBeTruthy()
    expect(view.container.querySelector('[data-session-id="local-a"] .activity-session-state')?.textContent).toBe('本轮结束')
    expect(within(view.getByText('Codex terminal').closest('article')!).queryByText('已完成', { exact: true })).toBeNull()
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, tui: { ...snapshot.tui!, sessions: [{ ...snapshot.tui!.sessions[0], state: 'waiting-approval' }] } } }))
    expect(view.getByText('等待审批 · 请在终端处理')).toBeTruthy()
    expect(view.getByRole('button', { name: /^定位终端/ })).toBeTruthy()
    expect(view.queryByRole('button', { name: '仅允许一次' })).toBeNull()
  })
  it('存活终端不显示任务执行中；原生任务使用权威审批状态', async () => {
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    const terminal = view.getByText('Codex terminal').closest('article')!
    const details = terminal.querySelector('details')!
    expect(details.open).toBe(false)
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
    expect(within(terminal).getByText('存活')).toBeTruthy()
    expect(within(terminal).getByText('未知 · CLI 未提供可靠状态')).toBeTruthy()
    expect(view.getByText('等待审批')).toBeTruthy()
    expect(view.container.querySelector<HTMLDetailsElement>('.workbench-activity-approval')?.open).toBe(false)
    fireEvent.click(view.container.querySelector('.workbench-activity-approval>summary')!)
    expect(view.getByRole('button', { name: '仅允许一次' }).hasAttribute('disabled')).toBe(true)
  })
  it('按实际 worktree 目录过滤，主目录不会混入', async () => {
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'c:/project/.lyshell-worktrees/feature' } })
    expect(view.queryByText('Codex terminal')).toBeNull()
    expect(view.getByText('project / feature')).toBeTruthy()
    expect(view.getByText('native-a')).toBeTruthy()
  })
  it('断线禁用全部审批，完整参数仅在用户点击时提交同一任务身份', async () => {
    snapshot.sessions[0].approvals[0].operation = '{"command":"pwd"}'
    const view = render(<WorkbenchActivity />)
    await act(async () => {})
    expect(request.mock.calls.every(([arg]) => arg.kind === 'snapshot')).toBe(true)
    fireEvent.click(view.container.querySelector('.workbench-activity-approval>summary')!)
    fireEvent.click(view.getByRole('button', { name: '仅允许一次' }))
    await act(async () => {})
    expect(request).toHaveBeenCalledWith({ kind: 'approve', identity: snapshot.identity, sessionId: 'native-a', taskId: 'task-a', approvalId: 'approval-a', optionId: 'allowed-once' })
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, connection: 'stale' } }))
    expect(view.getByRole('button', { name: '仅允许一次' }).hasAttribute('disabled')).toBe(true)
    expect(view.getByText('未知 · 状态已过期')).toBeTruthy()
  })
  it('提醒内嵌内容保留项目筛选和静音，不产生独立浮窗', async () => {
    useWorkbenchActivity.setState({ panelView: 'notices', notices: [{ id: 'notice-a', workspace: 'C:/other', sessionId: 'other-s', taskId: 'other-t', kind: 'completed', at: Date.now() }], unreadNoticeIds: ['notice-a'] })
    const view = render(<WorkbenchActivity view="notices" />)
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: /other.*任务已完成/ }))
    expect(useWorkbenchActivity.getState().workspace).toBe('C:/other')
    expect(useWorkbenchActivity.getState().selectedSessionId).toBe('other-s')
    fireEvent.click(view.getByRole('button', { name: '静音此项目' }))
    expect(useWorkbenchActivity.getState().muted).toContain('c:/other')
    expect(view.queryByRole('dialog')).toBeNull()
  })
  it('旧项目入口和提醒历史统一请求侧栏页签，监视器不创建浮窗', async () => {
    useWorkbenchActivity.setState({ open: false })
    const view = render(<WorkbenchActivityMonitor />)
    await act(async () => {})
    act(() => useWorkbenchActivity.getState().show('C:/project', 'local-a'))
    expect(useTaskShelf.getState().viewRequest).toMatchObject({ open: true, view: 'sessions' })
    expect(useWorkbenchActivity.getState()).toMatchObject({ open: false, workspace: 'C:/project', selectedSessionId: 'local-a' })
    act(() => useWorkbenchActivity.getState().showNotifications())
    expect(useTaskShelf.getState().viewRequest).toMatchObject({ open: true, view: 'notices' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.workbench-activity-panel')).toBeNull()
  })
})
