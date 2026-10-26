// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityNotifications, activityProjectName } from './ActivityNotifications'
import { useWorkbenchActivity, type ActivityNotice } from '../../stores/workbench-activity'
import type { WorkbenchActivitySnapshot } from '@shared/workbench-activity'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh' } }) }))

let snapshot: WorkbenchActivitySnapshot
function notice(kind: ActivityNotice['kind'] = 'completed', suffix = kind): ActivityNotice {
  return { id: JSON.stringify([snapshot.identity, 'session-a', 'task-a', kind, suffix]), workspace: 'C:/projects/LyShell', sessionId: 'session-a', taskId: 'task-a', kind, at: Date.now() }
}
function deliver(value: ActivityNotice) {
  act(() => useWorkbenchActivity.setState(state => ({ notices: [value, ...state.notices], unreadNoticeIds: [value.id, ...state.unreadNoticeIds] })))
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T03:00:00Z'))
  snapshot = { observedAt: Date.now(), identity: { instanceId: 'backend-a', instanceEpoch: 1 }, connection: 'connected', sessions: [{ key: 'session-a', sessionId: 'session-a', taskId: 'task-a', workspace: 'C:/projects/LyShell', taskState: 'running', source: 'native-harness', updatedAt: Date.now(), stale: false, approvals: [{ id: 'approval', toolName: 'shell', options: ['allowed-once', 'rejected'], reason: '', askedAt: Date.now() }] }] }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32' } })
  useWorkbenchActivity.setState({ notices: [], unreadNoticeIds: [], muted: [], open: false, snapshot, actionError: null, panelView: 'sessions' })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('右上角任务通知', () => {
  it('TUI 回合结束不显示任务完成，审批独立于原生后台并只引导回终端', () => {
    snapshot = { ...snapshot, identity: null, connection: 'offline', sessions: [], tui: { observedAt: Date.now(), sessions: [{ terminalId: 'session-a', launchId: 'launch-a', source: 'codex', workspace: 'C:/projects/LyShell', cliSessionId: 'cli-a', turnId: 'task-a', state: 'waiting-approval', event: 'PermissionRequest', updatedAt: Date.now(), active: true, approvalEventId: 'tui-approval' }], events: [] } }
    useWorkbenchActivity.setState({ snapshot })
    const view = render(<ActivityNotifications />)
    deliver({ ...notice('turn-ended'), source: 'codex', launchId: 'launch-a' })
    expect(view.getByText('Codex · 本轮结束', { selector: 'strong' })).toBeTruthy()
    expect(view.queryByText('任务已完成', { selector: 'strong' })).toBeNull()
    act(() => vi.advanceTimersByTime(8000))
    expect(view.queryByRole('article')).toBeNull()
    deliver({ ...notice('approval'), source: 'codex', launchId: 'launch-a', tuiEventId: 'tui-approval' })
    expect(view.getByText('Codex · 需要你的审批', { selector: 'strong' })).toBeTruthy()
    expect(view.queryByRole('button', { name: /允许/ })).toBeNull()
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, tui: { ...snapshot.tui!, sessions: [{ ...snapshot.tui!.sessions[0], state: 'running', approvalEventId: undefined }] } } }))
    expect(view.queryByRole('article')).toBeNull()
  })
  it('worktree 同时显示项目名与分支目录，完整路径保留在悬停提示中', () => {
    expect(activityProjectName('D:\\projects\\LyShell\\.lyshell-worktrees\\feature')).toBe('LyShell / feature')
    expect(activityProjectName('/projects/LyShell/.lyshell-worktrees/feature')).toBe('LyShell / feature')
    const view = render(<ActivityNotifications/>)
    const event = notice()
    deliver(event)
    expect(view.getByRole('button', { name: '查看会话 · LyShell' }).getAttribute('title')).toContain(event.workspace)
    expect(view.queryByText(event.workspace)).toBeNull()
    expect(view.getByText('任务已完成', { selector: 'strong' })).toBeTruthy()
  })
  it('完成提醒8秒后收起，保留记录与未读，不因轮询重现', () => {
    const view = render(<ActivityNotifications/>)
    const event = notice()
    deliver(event)
    expect(view.getByRole('button', { name: '查看会话 · LyShell' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(7999))
    expect(view.queryByRole('button', { name: '查看会话 · LyShell' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(view.queryByRole('button', { name: '查看会话 · LyShell' })).toBeNull()
    expect(useWorkbenchActivity.getState().unreadNoticeIds).toContain(event.id)
    act(() => useWorkbenchActivity.setState({ notices: [event] }))
    expect(view.queryByRole('button', { name: '查看会话 · LyShell' })).toBeNull()
    expect(useWorkbenchActivity.getState().notices).toHaveLength(1)
  })
  it('鼠标悬停暂停剩余时长，离开后继续计时', () => {
    const view = render(<ActivityNotifications/>)
    deliver(notice('failed'))
    act(() => vi.advanceTimersByTime(2000))
    const card = view.getByRole('article')
    fireEvent.mouseEnter(card)
    act(() => vi.advanceTimersByTime(15000))
    expect(view.getByRole('button', { name: '查看会话 · LyShell' })).toBeTruthy()
    fireEvent.mouseLeave(card)
    act(() => vi.advanceTimersByTime(5999))
    expect(view.queryByRole('button', { name: '查看会话 · LyShell' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(view.queryByRole('button', { name: '查看会话 · LyShell' })).toBeNull()
  })
  it('审批不自动收起、没有允许按钮，连接过期后卡片消失', () => {
    const view = render(<ActivityNotifications/>)
    deliver(notice('approval'))
    act(() => vi.advanceTimersByTime(9000))
    expect(view.getByRole('button', { name: '查看请求 · LyShell' })).toBeTruthy()
    expect(view.queryByRole('button', { name: /允许/ })).toBeNull()
    act(() => useWorkbenchActivity.setState({ snapshot: { ...snapshot, connection: 'stale' } }))
    expect(view.queryByRole('button', { name: '查看请求 · LyShell' })).toBeNull()
  })
  it('点击通知定位所属会话并标记已读；关闭通知保留历史', () => {
    const view = render(<ActivityNotifications/>)
    const event = notice()
    deliver(event)
    fireEvent.click(view.getByRole('button', { name: '查看会话 · LyShell' }))
    expect(useWorkbenchActivity.getState()).toMatchObject({ open: true, workspace: event.workspace, selectedSessionId: event.sessionId, panelView: 'sessions', unreadNoticeIds: [] })
    act(() => useWorkbenchActivity.setState({ open: false }))
    deliver(notice('failed'))
    fireEvent.click(view.getByRole('button', { name: '关闭任务失败提醒' }))
    expect(useWorkbenchActivity.getState().notices).toHaveLength(2)
    expect(useWorkbenchActivity.getState().unreadNoticeIds).toEqual([])
  })
  it('静音项目没有浮层，界面重挂不重播旧提醒，通知不抢输入焦点', () => {
    const input = document.createElement('input')
    document.body.append(input); input.focus()
    const event = notice()
    useWorkbenchActivity.setState({ notices: [event], unreadNoticeIds: [event.id] })
    const view = render(<ActivityNotifications/>)
    expect(view.queryByRole('article')).toBeNull()
    deliver(notice('failed'))
    expect(document.activeElement).toBe(input)
    act(() => useWorkbenchActivity.getState().mute(event.workspace))
    expect(view.queryByRole('article')).toBeNull()
    input.remove()
  })
  it('同项目连续两个完成事件也提供不同的屏幕阅读器通知', () => {
    const view = render(<ActivityNotifications/>)
    deliver(notice())
    const first = view.getByRole('status').textContent
    deliver({ ...notice(), id: 'another-completion', taskId: 'task-b' })
    expect(view.getByRole('status').textContent).not.toBe(first)
    expect(view.getByRole('status').textContent).toContain('task-b')
  })
})
