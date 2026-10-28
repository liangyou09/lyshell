import { describe, expect, it } from 'vitest'
import { validateShelfBrowserRequest } from './validation'
describe('保存区网页控制输入', () => {
  it('只接受固定白名单、有限标识和匹配保存记录的恢复请求', () => {
    expect(validateShelfBrowserRequest({ kind: 'permit', resourceId: 'saved:a', taskId: 'a', url: 'https://fixture.test/', source: 'bulkVisible' })).toMatchObject({ taskId: 'a' })
    for (const bad of [
      { kind: 'permit', resourceId: 'saved:a', taskId: 'b', url: 'https://fixture.test/', source: 'bulkVisible' },
      { kind: 'permit', resourceId: 'tab:a', url: 'file:///secret', source: 'explicitMain' },
      { kind: 'inspect', resourceId: 'tab:a', guestId: 1 },
      { kind: 'demand', resourceId: 'tab:a', main: 'true', shelf: false },
      { kind: 'inspect', resourceId: 'tab:' + 'a'.repeat(257) }
    ]) expect(() => validateShelfBrowserRequest(bad)).toThrow()
  })
})
