import { describe, it, expect, vi } from 'vitest'

// electron-log 在 Node 测试环境不存在，mock 掉（对齐 dsh-workspace-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import { parseReadyUrl, validateLoopbackUrl, parseSetCookieEntry, toCookieDetails, type ParsedCookie } from './web'

describe('parseReadyUrl', () => {
  it('解析 dsh web 回显的 http URL', () => {
    expect(parseReadyUrl('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
  })

  it('解析 https URL', () => {
    expect(parseReadyUrl('dsh web: https://127.0.0.1:4443')).toBe('https://127.0.0.1:4443')
  })

  it('无匹配返回 null', () => {
    expect(parseReadyUrl('loading plugins...')).toBeNull()
  })
})

describe('validateLoopbackUrl', () => {
  it('放行并归一化 127.0.0.1 + 端口', () => {
    expect(validateLoopbackUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080/')
  })

  it('放行 localhost 并剥离 path/query/hash', () => {
    expect(validateLoopbackUrl('http://localhost:8080/foo?x=1#h')).toBe('http://localhost:8080/')
  })

  it('放行 IPv6 回环', () => {
    expect(validateLoopbackUrl('http://[::1]:8080')).toBe('http://[::1]:8080/')
  })

  it('拒绝外站域名', () => {
    expect(validateLoopbackUrl('http://evil.com:443')).toBeNull()
  })

  it('拒绝无端口', () => {
    expect(validateLoopbackUrl('http://127.0.0.1')).toBeNull()
  })

  it('拒绝非 http(s) 协议', () => {
    expect(validateLoopbackUrl('ftp://127.0.0.1:21')).toBeNull()
  })

  it('拒绝内嵌凭证', () => {
    expect(validateLoopbackUrl('http://user:pass@127.0.0.1:80')).toBeNull()
  })

  it('拒绝畸形字符串', () => {
    expect(validateLoopbackUrl('not a url')).toBeNull()
  })
})

describe('parseSetCookieEntry', () => {
  it('解析 dsh web 的典型 set-cookie（Max-Age / Path / HttpOnly / SameSite）', () => {
    const r = parseSetCookieEntry(
      'dsh-auth-abc=v1.xyz; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
    )
    expect(r).not.toBeNull()
    expect(r!.name).toBe('dsh-auth-abc')
    expect(r!.value).toBe('v1.xyz')
    expect(r!.maxAge).toBe(2592000)
    expect(r!.path).toBe('/')
    expect(r!.httpOnly).toBe(true)
    expect(r!.sameSite).toBe('strict')
  })

  it('只有 name=value 的最小 cookie', () => {
    const r = parseSetCookieEntry('session=abc123')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('session')
    expect(r!.value).toBe('abc123')
    expect(r!.path).toBe('/')
    expect(r!.httpOnly).toBe(false)
    expect(r!.sameSite).toBe('strict')
    expect(r!.maxAge).toBeUndefined()
  })

  it('SameSite=Lax 识别', () => {
    const r = parseSetCookieEntry('k=v; SameSite=Lax')
    expect(r!.sameSite).toBe('lax')
  })

  it('SameSite=None 映射为 no_restriction', () => {
    const r = parseSetCookieEntry('k=v; SameSite=None')
    expect(r!.sameSite).toBe('no_restriction')
  })

  it('大小写不敏感', () => {
    const r = parseSetCookieEntry('k=v; PATH=/app; HTTPONLY; MAX-AGE=3600')
    expect(r!.path).toBe('/app')
    expect(r!.httpOnly).toBe(true)
    expect(r!.maxAge).toBe(3600)
  })

  it('空字符串返回 null', () => {
    expect(parseSetCookieEntry('')).toBeNull()
  })

  it('无等号返回 null', () => {
    expect(parseSetCookieEntry('justaname')).toBeNull()
  })

  it('name 为空（=val）返回 null', () => {
    expect(parseSetCookieEntry('=value')).toBeNull()
  })

  it('值可含等号', () => {
    const r = parseSetCookieEntry('key=val=ue; Path=/')
    expect(r!.name).toBe('key')
    expect(r!.value).toBe('val=ue')
  })
})

describe('toCookieDetails', () => {
  const baseEntry = {
    name: 'dsh-auth-abc',
    value: 'v1.xyz',
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    maxAge: 2592000
  }
  const origin = 'http://127.0.0.1:3080'
  const nowSec = 1727000000

  it('origin + path 拼接为 url', () => {
    const r = toCookieDetails(baseEntry, origin, false, nowSec)
    expect(r.url).toBe('http://127.0.0.1:3080/')
  })

  it('非 "/" path 正确拼接在 origin 后', () => {
    const e = { ...baseEntry, path: '/app/api' }
    const r = toCookieDetails(e, origin, false, nowSec)
    expect(r.url).toBe('http://127.0.0.1:3080/app/api')
  })

  it('path 不含前导斜杠时自动补 "/"', () => {
    const e = { ...baseEntry, path: 'relative' }
    const r = toCookieDetails(e, origin, false, nowSec)
    expect(r.url).toBe('http://127.0.0.1:3080/relative')
  })

  it('Max-Age → expirationDate = nowSec + maxAge', () => {
    const r = toCookieDetails(baseEntry, origin, false, nowSec)
    expect(r.expirationDate).toBe(nowSec + 2592000)
  })

  it('Max-Age=0 → expirationDate = nowSec（立过过期）', () => {
    const r = toCookieDetails({ ...baseEntry, maxAge: 0 }, origin, false, nowSec)
    expect(r.expirationDate).toBe(nowSec)
  })

  it('无 maxAge → 不设 expirationDate', () => {
    const noMaxAge: ParsedCookie = { ...baseEntry, maxAge: undefined }
    const r = toCookieDetails(noMaxAge, origin, false, nowSec)
    expect(r.expirationDate).toBeUndefined()
  })

  it('secure 直通（https 为 true）', () => {
    const r = toCookieDetails(baseEntry, origin, true, nowSec)
    expect(r.secure).toBe(true)
  })

  it('secure 直通（http 为 false）', () => {
    const r = toCookieDetails(baseEntry, origin, false, nowSec)
    expect(r.secure).toBe(false)
  })

  it('httpOnly / sameSite 原样透传', () => {
    const e = { ...baseEntry, httpOnly: false, sameSite: 'no_restriction' as const }
    const r = toCookieDetails(e, origin, false, nowSec)
    expect(r.httpOnly).toBe(false)
    expect(r.sameSite).toBe('no_restriction')
  })

  it('name / value / path 原样透传', () => {
    const r = toCookieDetails(baseEntry, origin, false, nowSec)
    expect(r.name).toBe('dsh-auth-abc')
    expect(r.value).toBe('v1.xyz')
    expect(r.path).toBe('/')
  })
})
