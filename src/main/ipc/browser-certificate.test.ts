import { describe, expect, it, vi } from 'vitest'
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
import { validateBrowserRequest } from './validation'

describe('证书确认 IPC 输入', () => {
  it('只接受有界 HTTPS 地址和有效 guest ID，丢弃 renderer 自报的信任字段', () => {
    expect(validateBrowserRequest({ kind: 'trustCertificate', guestId: 12, url: 'https://10.5.20.36:8072', certificateId: 'actual-failure', fingerprint: 'forged', allowed: true })).toEqual({ kind: 'trustCertificate', guestId: 12, url: 'https://10.5.20.36:8072/', certificateId: 'actual-failure' })
    expect(validateBrowserRequest({ kind: 'certificateInfo', guestId: 12, url: 'https://example.com' })).toEqual({ kind: 'certificateInfo', guestId: 12, url: 'https://example.com/' })
  })
  it.each([
    { guestId: 0 }, { guestId: -1 }, { guestId: 1.5 }, { guestId: NaN }, { guestId: '12' },
    { url: 'http://10.5.20.36:8072/' }, { url: 'file:///tmp/a' }, { url: 'https://user:password@example.com/' },
    { url: 'not a URL' }, { url: 'https://example.com/' + 'x'.repeat(16384) }
  ])('拒绝异常参数 %j', patch => {
    expect(() => validateBrowserRequest({ kind: 'trustCertificate', guestId: 12, url: 'https://example.com/', certificateId: 'actual-failure', ...patch })).toThrow()
  })
})
