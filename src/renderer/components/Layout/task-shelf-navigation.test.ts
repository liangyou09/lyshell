// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shelfEntryForNotice, showShelfNotice } from './task-shelf-navigation'
import { useTaskShelf } from '../../stores/task-shelf'
import type { ActivityNotice } from '../../stores/workbench-activity'
import type { TaskShelfEntry } from '@shared/task-shelf'
import { ConnectionType } from '@shared/types'

const backend = { instanceId: 'a', instanceEpoch: 1 }
const terminal: TaskShelfEntry = { id: 'terminal', resourceKey: 'terminal:t', title: 'Codex', createdAt: 1, updatedAt: 1, revision: 1, capability: 'local-live', recovery: { kind: 'terminal', type: ConnectionType.LOCAL, sessionId: 't' } }
const harness: TaskShelfEntry = { ...terminal, id: 'harness', resourceKey: 'harness:h', capability: 'harness-history', recovery: { kind: 'harness', sessionId: 's', taskId: 'turn', identity: backend } }
const notice: ActivityNotice = { id: 'tui', sessionId: 't', taskId: 'turn', workspace: 'D:/project', source: 'codex', kind: 'approval', at: 1 }
beforeEach(() => { useTaskShelf.setState({ entries: [terminal, harness], bindings: { terminal: { kind: 'terminal', id: 't' }, harness: { kind: 'harness', id: 'h' } }, panelVisible: false, viewRequest: null }) })
afterEach(() => { vi.restoreAllMocks() })

describe('铃铛定位对应小窗口', () => {
  it('用户点击时收回同一任务并请求小窗定位，不重启任务', () => {
    const hide = vi.spyOn(useTaskShelf.getState(), 'hide').mockImplementation(() => {})
    const open = vi.spyOn(useTaskShelf.getState(), 'open')
    expect(showShelfNotice(notice)).toBe(true)
    expect(hide).toHaveBeenCalledWith('terminal')
    expect(useTaskShelf.getState().viewRequest).toMatchObject({ open: true, entryId: 'terminal' })
    expect(open).not.toHaveBeenCalled()
  })
  it('同目录的另一个终端不能冒充提醒目标', () => {
    expect(shelfEntryForNotice({ ...notice, sessionId: 'other' })).toBeUndefined()
    expect(showShelfNotice({ ...notice, sessionId: 'other' })).toBe(false)
    expect(useTaskShelf.getState().viewRequest).toBeNull()
  })
  it('Harness 同时核对后台、会话和回合', () => {
    const native: ActivityNotice = { ...notice, id: JSON.stringify([backend, 's', 'turn', 'approval', 'request']), source: undefined, sessionId: 's' }
    expect(shelfEntryForNotice(native)).toBe('harness')
    expect(shelfEntryForNotice({ ...native, taskId: 'other' })).toBeUndefined()
    expect(shelfEntryForNotice({ ...native, id: JSON.stringify([{ ...backend, instanceEpoch: 2 }, 's', 'turn']) })).toBeUndefined()
    expect(shelfEntryForNotice({ ...native, id: 'malformed' })).toBeUndefined()
    expect(shelfEntryForNotice({ ...native, id: JSON.stringify([{}, 's', 'turn']) })).toBeUndefined()
    expect(shelfEntryForNotice({ ...native, source: 'harness-web', id: JSON.stringify(['harness-web', backend, 'request']) })).toBe('harness')
  })
})
