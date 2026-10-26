import { describe, it, expect } from 'vitest'
import {
  WORKBENCH_APPROVAL_OPTIONS, isWorkbenchApprovalOption, workbenchActivityKey
} from './workbench-activity'

describe('工作台活动快照契约', () => {
  it('条目 key 只由后台身份、会话与任务组成', () => {
    expect(workbenchActivityKey({ instanceId: 'backend-1', instanceEpoch: 7 }, 's1', 't1'))
      .toBe('["backend-1",7,"s1","t1"]')
    expect(workbenchActivityKey({ instanceId: 'backend-1', instanceEpoch: 7 }, 's1', null))
      .toBe('["backend-1",7,"s1",null]')
  })

  it('key 不携带 owner、token 或身份对象里的额外字段', () => {
    const identity = { instanceId: 'backend-1', instanceEpoch: 7, owner: 'a'.repeat(64), token: 'secret' }
    const key = workbenchActivityKey(identity, 's1', 't1')
    expect(JSON.parse(key)).toEqual(['backend-1', 7, 's1', 't1'])
    expect(key).not.toContain('secret')
    expect(key).not.toContain('owner')
    expect(key).not.toContain('a'.repeat(64))
  })

  it('同一会话的不同任务或不同后台代际不会共用 key', () => {
    const key = workbenchActivityKey({ instanceId: 'b', instanceEpoch: 1 }, 's1', 't1')
    expect(key).not.toBe(workbenchActivityKey({ instanceId: 'b', instanceEpoch: 1 }, 's1', 't2'))
    expect(key).not.toBe(workbenchActivityKey({ instanceId: 'b', instanceEpoch: 2 }, 's1', 't1'))
    expect(key).not.toBe(workbenchActivityKey({ instanceId: 'c', instanceEpoch: 1 }, 's1', 't1'))
    expect(key).not.toBe(workbenchActivityKey({ instanceId: 'b', instanceEpoch: 1 }, 's2', 't1'))
  })

  it('审批选项只接受官方三种取值', () => {
    expect(WORKBENCH_APPROVAL_OPTIONS).toEqual(['allowed-once', 'rejected', 'cancelled'])
    for (const option of WORKBENCH_APPROVAL_OPTIONS) expect(isWorkbenchApprovalOption(option)).toBe(true)
    for (const value of ['always', '', null, undefined, ['rejected'], 1]) {
      expect(isWorkbenchApprovalOption(value)).toBe(false)
    }
  })
})
