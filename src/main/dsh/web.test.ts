import { describe, it, expect, vi } from 'vitest'

// electron-log 在 Node 测试环境不存在，mock 掉（对齐 dsh-workspace-repository.test.ts）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import { parseReadyUrl, validateLoopbackUrl } from './web'

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
