import { describe, expect, it } from 'vitest'
import { validateShelfBrowserRequest } from './validation'
describe('保存区网页控制输入', () => {
  it('普通页重载策略只接受布尔意图与当前 URL，不能从 permit 或 safe 上报伪造同意', () => {
    expect(validateShelfBrowserRequest({ kind: 'reloadPolicy', resourceId: 'tab:a', enabled: true, url: 'https://fixture.test/read' })).toEqual({ kind: 'reloadPolicy', resourceId: 'tab:a', enabled: true, url: 'https://fixture.test/read' })
    for (const raw of [
      { kind: 'reloadPolicy', resourceId: 'tab:a', enabled: 'true', url: 'https://fixture.test/read' },
      { kind: 'reloadPolicy', resourceId: 'tab:a', enabled: true, url: 'https://fixture.test/read', protection: 'safe' },
      { kind: 'reloadPolicy', resourceId: 'tab:a', enabled: true },
      { kind: 'permit', resourceId: 'tab:a', source: 'explicitMain', url: 'https://fixture.test/read', reloadableMode: true },
    ]) expect(() => validateShelfBrowserRequest(raw)).toThrow()
  })
  it('只读模式仅是布尔创建意图，wake 仅允许固定需求来源，不能上报 safe', () => {
    expect(validateShelfBrowserRequest({ kind: 'permit', resourceId: 'tab:a', url: 'https://fixture.test/', source: 'explicitMain', readonlyMode: true })).toMatchObject({ readonlyMode: true })
    expect(validateShelfBrowserRequest({ kind: 'wake', resourceId: 'saved:a', source: 'explicitShelf' })).toEqual({ kind: 'wake', resourceId: 'saved:a', source: 'explicitShelf' })
    for (const bad of [
      { kind: 'permit', resourceId: 'tab:a', url: 'https://fixture.test/', source: 'explicitMain', readonlyMode: 'true' },
      { kind: 'wake', resourceId: 'saved:a', source: 'scroll' },
      { kind: 'inspect', resourceId: 'tab:a', protection: 'safe' }
    ]) expect(() => validateShelfBrowserRequest(bad)).toThrow()
  })
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
