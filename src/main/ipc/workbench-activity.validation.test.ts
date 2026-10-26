import { describe, expect, it } from 'vitest'
import { validateWorkbenchActivityRequest, validateActivityNavigationRequest } from './validation'

describe('工作台状态 IPC 校验', () => {
  const request = { kind: 'approve', identity: { instanceId: 'instance-a', instanceEpoch: 1 }, sessionId: 's', taskId: 't', approvalId: 'a', optionId: 'rejected' }
  it('只允许只读快照与明确审批选项', () => {
    expect(validateWorkbenchActivityRequest({ kind: 'snapshot' })).toEqual({ kind: 'snapshot' })
    expect(validateWorkbenchActivityRequest(request)).toEqual(request)
  })
  it.each([{ ...request, kind: 'submit' }, { ...request, owner: 'other' }, { ...request, identity: { instanceId: 'a', instanceEpoch: 0 } }, { ...request, identity: { instanceId: 'a', instanceEpoch: 1, key: 'secret' } }, { ...request, optionId: 'always' }, { ...request, taskId: '' }, { kind: 'snapshot', owner: 'other' }])('拒绝伪造身份或越权请求 %#', raw => {
    expect(() => validateWorkbenchActivityRequest(raw)).toThrow()
  })
  it('导航必须使用后台身份，不接受额外控制字段', () => {
    const input = { kind: 'open', identity: request.identity, sessionId: 's' }
    expect(validateActivityNavigationRequest(input)).toEqual(input)
    expect(() => validateActivityNavigationRequest({ ...input, owner: 'other' })).toThrow()
    expect(() => validateActivityNavigationRequest({ ...input, requestId: 'extra' })).toThrow()
    expect(() => validateActivityNavigationRequest({ ...input, kind: 'navigation' })).toThrow()
  })
})
