import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  SSH_FINGERPRINT_PATTERN,
  SshHostKeyError,
  assertHostKeyMatches,
  computeSshHostKeyFingerprint,
  createSsh2HostVerifier,
  describeSshHostKey,
  isSshHostKeyError,
  normalizeSshEndpoint,
  normalizeSshHost,
  normalizeSshPort,
  validateSshTrustFile,
  validateSshTrustRecord
} from './ssh-host-key'

/** 最小 SSH wire-format 公钥：uint32 长度 + 算法名 + 任意密钥字节 */
const wireHostKey = (algorithm = 'ssh-ed25519', material = 'host-key-material'): Buffer => {
  const name = Buffer.from(algorithm)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length, 0)
  return Buffer.concat([length, name, Buffer.from(material)])
}

/** OpenSSH `ssh-keygen -lf` 同款指纹：SHA256 + base64（去掉 padding） */
const opensshFingerprint = (raw: Buffer): string =>
  `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`

const sampleRecord = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  endpoint: 'example.com:22',
  host: 'example.com',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: `SHA256:${'A'.repeat(43)}`,
  trustedAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
  ...overrides
})

describe('endpoint 规范化', () => {
  it('主机去空白、去 IPv6 方括号、统一小写', () => {
    expect(normalizeSshHost('  Example.COM ')).toBe('example.com')
    expect(normalizeSshHost('[::1]')).toBe('::1')
    expect(normalizeSshHost('192.0.2.10')).toBe('192.0.2.10')
  })

  it('空主机拒绝（不退回 localhost 之类的默认值）', () => {
    for (const host of ['', '   ', '\t']) {
      expect(() => normalizeSshHost(host)).toThrowError(SshHostKeyError)
      try {
        normalizeSshHost(host)
      } catch (error) {
        expect((error as SshHostKeyError).code).toBe('SSH_HOST_KEY_INVALID')
      }
    }
  })

  it('端口缺省 22，越界/非整数拒绝', () => {
    expect(normalizeSshPort(undefined)).toBe(22)
    expect(normalizeSshPort(null)).toBe(22)
    expect(normalizeSshPort(2222)).toBe(2222)
    for (const port of [0, -1, 65536, 22.5, Number.NaN]) {
      expect(() => normalizeSshPort(port)).toThrowError(/端口不合法/)
    }
  })

  it('endpoint 为 host:port，IPv6 带方括号', () => {
    expect(normalizeSshEndpoint('Example.COM', 22)).toBe('example.com:22')
    expect(normalizeSshEndpoint('Example.COM')).toBe('example.com:22')
    expect(normalizeSshEndpoint('[::1]', 2222)).toBe('[::1]:2222')
  })
})

describe('describeSshHostKey', () => {
  it('解析算法名并给出与 OpenSSH 一致的 SHA256 指纹', () => {
    const raw = wireHostKey()
    const info = describeSshHostKey(raw)
    expect(info.algorithm).toBe('ssh-ed25519')
    expect(info.fingerprint).toBe(opensshFingerprint(raw))
    expect(SSH_FINGERPRINT_PATTERN.test(info.fingerprint)).toBe(true)
    expect(computeSshHostKeyFingerprint(raw)).toBe(info.fingerprint)
  })

  it('指纹只对原始公钥字节做一次 sha256（不是二次 hash、也不是算法名）', () => {
    const raw = wireHostKey()
    const doubleHashed = `SHA256:${createHash('sha256').update(createHash('sha256').update(raw).digest('hex')).digest('base64').replace(/=+$/, '')}`
    expect(describeSshHostKey(raw).fingerprint).not.toBe(doubleHashed)
    expect(describeSshHostKey(raw).fingerprint).not.toContain('ssh-ed25519')
  })

  it('算法名支持 ecdsa/rsa 等真实写法', () => {
    expect(describeSshHostKey(wireHostKey('ecdsa-sha2-nistp256')).algorithm).toBe('ecdsa-sha2-nistp256')
    expect(describeSshHostKey(wireHostKey('ssh-rsa')).algorithm).toBe('ssh-rsa')
    expect(describeSshHostKey(wireHostKey('rsa-sha2-512')).algorithm).toBe('rsa-sha2-512')
  })

  it('空/截断/非法算法名的公钥拒绝', () => {
    const empty = Buffer.alloc(0)
    const truncated = Buffer.from([0, 0, 0, 20, 0x73])
    const badName = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('\u0000\u0001\u0002', 'latin1')])
    for (const raw of [empty, truncated, badName]) {
      expect(() => describeSshHostKey(raw)).toThrowError(SshHostKeyError)
    }
  })
})

describe('assertHostKeyMatches', () => {
  it('一致时返回算法与指纹', () => {
    const raw = wireHostKey()
    const expected = computeSshHostKeyFingerprint(raw)
    expect(assertHostKeyMatches(raw, 'example.com', 2222, expected)).toEqual({
      algorithm: 'ssh-ed25519',
      fingerprint: expected
    })
  })

  it('缺少/非法可信指纹一律 fail closed', () => {
    const raw = wireHostKey()
    for (const expected of [undefined, null, '', 'SHA256:short', 'md5:aa:bb']) {
      try {
        assertHostKeyMatches(raw, 'example.com', 22, expected)
        throw new Error('应当拒绝')
      } catch (error) {
        expect(isSshHostKeyError(error)).toBe(true)
        expect((error as SshHostKeyError).code).toBe('SSH_HOST_KEY_UNAVAILABLE')
        expect((error as Error).message).toContain('example.com:22')
      }
    }
  })

  it('不一致时报 CHANGED 并带双方指纹与 endpoint，且不含密钥字节', () => {
    const raw = wireHostKey()
    const actual = computeSshHostKeyFingerprint(raw)
    const previous = `SHA256:${'B'.repeat(43)}`
    try {
      assertHostKeyMatches(raw, 'Example.COM', 22, previous)
      throw new Error('应当拒绝')
    } catch (error) {
      const typed = error as SshHostKeyError
      expect(typed.code).toBe('SSH_HOST_KEY_CHANGED')
      expect(typed.endpoint).toBe('example.com:22')
      expect(typed.fingerprint).toBe(actual)
      expect(typed.previousFingerprint).toBe(previous)
      expect(typed.message).toContain(previous)
      expect(typed.message).toContain(actual)
      expect(typed.message).not.toContain('host-key-material')
    }
  })
})

describe('createSsh2HostVerifier（ssh2 语义）', () => {
  it('同步返回 undefined，结论以 verify 回调异步送达', async () => {
    const verify = vi.fn()
    const decide = vi.fn(async () => {})
    const hostVerifier = createSsh2HostVerifier({ host: 'example.com', port: 22, decide })
    expect(hostVerifier(wireHostKey(), verify)).toBeUndefined()
    // 同步返回时还没有结论：ssh2 必须继续等（否则会被当成 true 直接放行）
    expect(verify).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(true))
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('校验失败 → verify(false) 并把原因回传', async () => {
    const verify = vi.fn()
    const failure = new SshHostKeyError('SSH_HOST_KEY_CHANGED', 'fingerprint changed')
    const onReject = vi.fn()
    const hostVerifier = createSsh2HostVerifier({
      host: 'example.com',
      port: 22,
      decide: async () => { throw failure },
      onReject
    })
    expect(hostVerifier(wireHostKey(), verify)).toBeUndefined()
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false))
    expect(onReject).toHaveBeenCalledWith(failure)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('onReject 自身抛错也不能反过来放行', async () => {
    const verify = vi.fn()
    const hostVerifier = createSsh2HostVerifier({
      host: 'example.com',
      port: 22,
      decide: async () => { throw new Error('boom') },
      onReject: () => { throw new Error('log failed') }
    })
    hostVerifier(wireHostKey(), verify)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false))
  })

  it('连接已关闭/取消后不再调用 verify（晚到结论作废）', async () => {
    const verify = vi.fn()
    let active = true
    const hostVerifier = createSsh2HostVerifier({
      host: 'example.com',
      port: 22,
      decide: async () => { active = false },
      isActive: () => active
    })
    hostVerifier(wireHostKey(), verify)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(verify).not.toHaveBeenCalled()
  })

  it('结论只送达一次', async () => {
    const verify = vi.fn()
    const hostVerifier = createSsh2HostVerifier({ host: 'example.com', port: 22, decide: async () => {} })
    hostVerifier(wireHostKey(), verify)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(verify).toHaveBeenCalledTimes(1)
  })
})

describe('isSshHostKeyError 跨 bundle 判定', () => {
  it('识别本实例、同名同前缀形状，拒绝其它错误', () => {
    expect(isSshHostKeyError(new SshHostKeyError('SSH_HOST_KEY_UNKNOWN', 'x'))).toBe(true)
    expect(isSshHostKeyError({ name: 'SshHostKeyError', code: 'SSH_HOST_KEY_UNKNOWN' })).toBe(true)
    expect(isSshHostKeyError(new Error('x'))).toBe(false)
    expect(isSshHostKeyError({ name: 'SshHostKeyError', code: 'OTHER' })).toBe(false)
    expect(isSshHostKeyError(null)).toBe(false)
    expect(isSshHostKeyError('SSH_HOST_KEY_UNKNOWN')).toBe(false)
  })
})

describe('可信记录校验', () => {
  it('合法记录返回规范化后的对象', () => {
    const record = validateSshTrustRecord(sampleRecord())
    expect(record).toMatchObject({ schemaVersion: 1, endpoint: 'example.com:22', host: 'example.com', port: 22 })
  })

  it('schemaVersion 不支持、指纹非法、endpoint 与 host/port 不一致、时间戳缺失都按损坏处理', () => {
    const cases = [
      sampleRecord({ schemaVersion: 2 }),
      sampleRecord({ schemaVersion: undefined }),
      sampleRecord({ fingerprint: 'SHA256:short' }),
      sampleRecord({ fingerprint: undefined }),
      sampleRecord({ port: 0 }),
      sampleRecord({ endpoint: 'example.com:2222' }),
      sampleRecord({ host: '' }),
      sampleRecord({ algorithm: '' }),
      sampleRecord({ trustedAt: '' }),
      sampleRecord({ updatedAt: undefined }),
      null,
      'not-an-object'
    ]
    for (const value of cases) {
      try {
        validateSshTrustRecord(value)
        throw new Error('应当拒绝')
      } catch (error) {
        expect((error as SshHostKeyError).code).toBe('SSH_HOST_KEY_STORE_CORRUPT')
      }
    }
  })

  it('文件级校验拒绝重复 endpoint 与不支持的 schemaVersion', () => {
    expect(validateSshTrustFile({ schemaVersion: 1, records: [sampleRecord()] }).records).toHaveLength(1)
    for (const value of [
      { schemaVersion: 1, records: [sampleRecord(), sampleRecord()] },
      { schemaVersion: 2, records: [] },
      { schemaVersion: 1 },
      { schemaVersion: 1, records: [sampleRecord({ endpoint: 'EXAMPLE.com:22', host: 'EXAMPLE.com' }), sampleRecord()] },
      []
    ]) {
      expect(() => validateSshTrustFile(value)).toThrowError(SshHostKeyError)
    }
  })
})
