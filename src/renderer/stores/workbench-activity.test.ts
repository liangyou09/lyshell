// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import { activityDirectoryKey, activityFresh, collectActivityNotices, useWorkbenchActivity } from './workbench-activity'

function snapshot(state: 'running' | 'completed' | 'failed' = 'running'): WorkbenchActivitySnapshot {
  return { observedAt: Date.now(), identity: { instanceId: 'backend-a', instanceEpoch: 1 }, connection: 'connected', sessions: [{ key: 'row-a', sessionId: 'session-a', workspace: 'C:/project', taskId: 'task-a', taskState: state, source: 'native-harness', updatedAt: Date.now(), stale: false, approvals: [] }] }
}
beforeEach(() => {
  useWorkbenchActivity.setState({ snapshot: null, notices: [], unreadNoticeIds: [], open: false, panelView: 'sessions', workspace: null, muted: [], error: null, busy: false, actionError: null })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', workbenchActivityRequest: vi.fn() } })
})
describe('可信状态与提醒', () => {
  it('按平台匹配完整目录，不把 worktree 或子目录归入主项目', () => {
    expect(activityDirectoryKey('C:\\Project\\', 'win32')).toBe(activityDirectoryKey('c:/project', 'win32'))
    expect(activityDirectoryKey('C:/project/.lyshell-worktrees/a', 'win32')).not.toBe(activityDirectoryKey('C:/project', 'win32'))
    expect(activityDirectoryKey('/Project', 'linux')).not.toBe(activityDirectoryKey('/project', 'linux'))
    expect(activityDirectoryKey('C:\\', 'win32')).toBe('c:/')
    expect(activityDirectoryKey('C:', 'win32')).not.toBe(activityDirectoryKey('C:/', 'win32'))
  })
  it('离线、过期与未来时钟均不产生完成提醒', () => {
    const current = snapshot('completed')
    for (const changed of [{ ...current, connection: 'offline' as const }, { ...current, observedAt: Date.now() - 15000 }, { ...current, observedAt: Date.now() + 15000 }]) {
      expect(activityFresh(changed)).toBe(false)
      expect(collectActivityNotices(changed, snapshot(), new Set())).toEqual([])
    }
  })
  it('同一终态只提醒一次，新任务身份可单独提醒', () => {
    const current = snapshot('completed'), seen = new Set<string>()
    expect(collectActivityNotices(current, snapshot(), seen)).toHaveLength(1)
    expect(collectActivityNotices(current, current, seen)).toEqual([])
    current.sessions[0].taskId = 'task-b'
    expect(collectActivityNotices(current, snapshot(), seen)[0]).toMatchObject({ taskId: 'task-b', workspace: 'C:/project', kind: 'completed' })
  })
  it('第一次连接和后台重启不会把历史完成当作新事件', () => {
    const current = snapshot('completed')
    expect(collectActivityNotices(current, null, new Set())).toEqual([])
    expect(collectActivityNotices({ ...current, identity: { instanceId: 'backend-b', instanceEpoch: 2 } }, snapshot(), new Set())).toEqual([])
  })
  it('已有其他会话时，新接入会话的历史终态也不作为新提醒', () => {
    const current = snapshot('completed')
    current.sessions[0].sessionId = 'newly-observed-session'
    const seen = new Set<string>()
    expect(collectActivityNotices(current, snapshot(), seen)).toEqual([])
    expect(collectActivityNotices(current, current, seen)).toEqual([])
  })
  it('初次待审批可提醒，审批 ID 去重且过期条目不提醒', () => {
    const current = snapshot()
    current.sessions[0].approvals = [{ id: 'approval-a', toolName: 'shell', reason: '', options: ['allowed-once', 'rejected'], askedAt: Date.now() }]
    const seen = new Set<string>()
    expect(collectActivityNotices(current, null, seen)[0].kind).toBe('approval')
    expect(collectActivityNotices(current, current, seen)).toEqual([])
    current.sessions[0].stale = true
    expect(collectActivityNotices(current, null, new Set())).toEqual([])
  })
  it('重复刷新共用一次请求，失败不把任务改成完成', async () => {
    const current = snapshot()
    useWorkbenchActivity.setState({ snapshot: current })
    const request = vi.mocked(window.electronAPI.workbenchActivityRequest).mockRejectedValue(new Error('timeout'))
    await Promise.all([useWorkbenchActivity.getState().refresh(), useWorkbenchActivity.getState().refresh()])
    expect(request).toHaveBeenCalledTimes(1)
    expect(useWorkbenchActivity.getState().snapshot).toMatchObject({ connection: 'stale', sessions: [{ taskState: 'running' }] })
  })
  it('静音项目使用规范目录身份且持久化；过期审批不调用后端', async () => {
    useWorkbenchActivity.getState().mute('C:\\Project')
    expect(useWorkbenchActivity.getState().muted).toContain('c:/project')
    const current = snapshot()
    current.connection = 'stale'
    useWorkbenchActivity.setState({ snapshot: current })
    await useWorkbenchActivity.getState().approve(current.sessions[0], { id: 'a', toolName: 'shell', reason: '', options: ['allowed-once'], askedAt: Date.now() }, 'allowed-once')
    expect(window.electronAPI.workbenchActivityRequest).not.toHaveBeenCalled()
  })
  it('项目目录失效不会保留先前项目筛选，错误也不会被后台轮询抹掉', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      platform: 'win32', projectSceneRequest: vi.fn().mockResolvedValue({ success: false, error: '项目目录已删除' }),
      workbenchActivityRequest: vi.fn().mockResolvedValue(snapshot())
    } })
    useWorkbenchActivity.getState().show('C:/previous', 'previous-session')
    await useWorkbenchActivity.getState().showProject({ presetId: 'removed', cwd: 'C:/removed', isolation: 'shared' })
    await useWorkbenchActivity.getState().refresh()
    expect(useWorkbenchActivity.getState()).toMatchObject({ workspace: null, selectedSessionId: null, actionError: '项目目录已删除' })
  })
  it('提醒超时或已读不删除历史，也不因重复读取重新产生未读', async () => {
    const current = snapshot('completed')
    current.sessions[0].taskId = 'unread-state-test'
    useWorkbenchActivity.setState({ snapshot: snapshot() })
    vi.mocked(window.electronAPI.workbenchActivityRequest).mockResolvedValue(current)
    await useWorkbenchActivity.getState().refresh()
    const state = useWorkbenchActivity.getState()
    expect(state.unreadNoticeIds).toHaveLength(1)
    state.markRead(state.unreadNoticeIds[0])
    await useWorkbenchActivity.getState().refresh()
    expect(useWorkbenchActivity.getState().unreadNoticeIds).toEqual([])
    expect(useWorkbenchActivity.getState().notices).toHaveLength(1)
    useWorkbenchActivity.getState().dismiss()
    expect(useWorkbenchActivity.getState()).toMatchObject({ unreadNoticeIds: [], notices: [] })
  })
})
