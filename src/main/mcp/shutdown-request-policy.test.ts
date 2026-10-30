import { describe, expect, it, vi } from 'vitest'
import { allowsShutdownRelease } from './shutdown-request-policy'
import type { TokenBinding } from './auth'

describe('退出期间的插件释放通道', () => {
  const host: TokenBinding = { kind: 'plugin', pluginId: 'aipet', tokenSource: 'host' }
  const release = '/api/exclusive-control/release'

  it('只保留已经由生命周期协调器发起的 host deactivate release', () => {
    const deactivating = vi.fn(() => true)
    expect(allowsShutdownRelease('draining', 'POST', release, host, deactivating)).toBe(true)
    expect(deactivating).toHaveBeenCalledWith('aipet')
    expect(allowsShutdownRelease('draining', 'POST', release, host, () => false)).toBe(false)
  })

  it.each<TokenBinding | null>([null, { kind: 'global' }, { kind: 'session' },
    { kind: 'plugin', pluginId: 'aipet', tokenSource: 'ui' }, { kind: 'plugin', tokenSource: 'host' }])('不允许非host身份 %j', binding => {
    expect(allowsShutdownRelease('draining', 'POST', release, binding, () => true)).toBe(false)
  })

  it('不扩大到新工作、普通变更或致命退出', () => {
    for (const phase of ['running', 'fatal', 'stopped']) expect(allowsShutdownRelease(phase, 'POST', release, host, () => true)).toBe(false)
    for (const route of ['/api/exclusive-control/submit', '/api/send-input', '/api/execute', `${release}?cleanup=true`]) {
      expect(allowsShutdownRelease('draining', 'POST', route, host, () => true)).toBe(false)
    }
    expect(allowsShutdownRelease('draining', 'GET', release, host, () => true)).toBe(false)
  })
})
