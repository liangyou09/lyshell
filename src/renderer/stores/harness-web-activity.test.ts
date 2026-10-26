// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { HarnessWebActivitySnapshot } from '@shared/harness-web-activity'
import { collectWebNotices, webActivityFresh, useWorkbenchActivity } from './workbench-activity'
const web = (): HarnessWebActivitySnapshot => ({ observedAt: Date.now(), connection: 'connected', identity: { instanceId: 'web-backend', instanceEpoch: 1 }, revision: 1,
  sessions: [{ sessionId: 'web-a', workspace: 'D:/project', turnId: 'turn-1', state: 'turn-ended', updatedAt: Date.now(), approvalIds: [] }],
  events: [{ id: 'end-a', sessionId: 'web-a', workspace: 'D:/project', turnId: 'turn-1', kind: 'turn-ended', at: Date.now() }] })

describe('内置聊天通知去重与归属', () => {
  it('初读建立基线，新会话快速完成仍提醒，重复轮询不重放', () => {
    const current = web(), seen = new Set<string>()
    expect(collectWebNotices(current, undefined, seen)).toEqual([])
    const next = { ...current, revision: 2, events: [...current.events, { ...current.events[0], id: 'end-b', sessionId: 'web-b' }] }
    expect(collectWebNotices(next, current, seen)).toMatchObject([{ source: 'harness-web', kind: 'turn-ended', sessionId: 'web-b' }])
    expect(collectWebNotices(next, next, seen)).toEqual([])
    expect(collectWebNotices({ ...next, identity: { instanceId: 'restart', instanceEpoch: 2 } }, next, new Set())).toEqual([])
  })
  it('首次待审批可提示；只关联同一会话、回合和当前审批，过期不提醒', () => {
    const current = web()
    current.events = [{ ...current.events[0], id: 'approval-a', kind: 'approval' }]
    current.sessions[0] = { ...current.sessions[0], state: 'waiting-approval', approvalIds: ['approval-a'] }
    expect(collectWebNotices(current, undefined, new Set())).toMatchObject([{ kind: 'approval', webEventId: 'approval-a' }])
    expect(collectWebNotices({ ...current, sessions: [{ ...current.sessions[0], turnId: 'other' }] }, undefined, new Set())).toEqual([])
    expect(collectWebNotices({ ...current, connection: 'stale' }, undefined, new Set())).toEqual([])
    expect(webActivityFresh({ ...current, observedAt: Date.now() - 12001 })).toBe(false)
  })
  it('native离线不屏蔽Web通知，连续快照去重且清空历史不重播', async () => {
    let current = web()
    current.events = []
    const request = vi.fn(async () => ({ observedAt: Date.now(), connection: 'offline', identity: null, sessions: [], web: current }))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', workbenchActivityRequest: request } })
    useWorkbenchActivity.setState({ snapshot: null, notices: [], unreadNoticeIds: [], muted: [] })
    await useWorkbenchActivity.getState().refresh()
    current = { ...web(), revision: 2 }
    await useWorkbenchActivity.getState().refresh()
    await useWorkbenchActivity.getState().refresh()
    expect(useWorkbenchActivity.getState().notices).toHaveLength(1)
    expect(useWorkbenchActivity.getState().notices[0].kind).toBe('turn-ended')
    useWorkbenchActivity.getState().dismiss()
    await useWorkbenchActivity.getState().refresh()
    expect(useWorkbenchActivity.getState().notices).toEqual([])
  })
})
