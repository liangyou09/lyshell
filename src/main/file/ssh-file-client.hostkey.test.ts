import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Server, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSHFileClient } from './ssh-file-client'
import { computeSshHostKeyFingerprint, type SshHostKeyError } from '../security/ssh-host-key'
import { SshTrustStore, setSshTrustStoreForTests } from '../security/ssh-trust'

vi.mock('electron-log', () => ({
  default: { info() {}, debug() {}, warn() {}, error() {} }
}))

const makeHostKey = (): string =>
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

interface Fixture {
  server: Server
  port: number
  connections: Set<Connection>
}

const startServer = (port: number, hostKey: string): Promise<Fixture> =>
  new Promise((resolve, reject) => {
    const connections = new Set<Connection>()
    const server = new Server({ hostKeys: [hostKey] }, connection => {
      connections.add(connection)
      connection.on('error', () => {})
      connection.on('authentication', ctx => ctx.accept())
      connection.on('close', () => connections.delete(connection))
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, connections })
    })
  })

const stopServer = async (fixture: Fixture): Promise<void> => {
  for (const connection of fixture.connections) connection.end()
  await new Promise<void>(resolve => fixture.server.close(() => resolve()))
}

/** 通过一次「只观察不放行」之外的探针连接取得服务端真实主机公钥指纹 */
const probeFingerprint = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const probe = new Client()
    probe.once('error', reject)
    probe.once('ready', () => probe.end())
    probe.connect({
      host: '127.0.0.1',
      port,
      username: 'fixture',
      password: 'probe-secret',
      readyTimeout: 10000,
      hostVerifier: (key: Buffer, verify: (permitted: boolean) => void) => {
        resolve(computeSshHostKeyFingerprint(key))
        verify(false)
        return undefined
      }
    })
  })

let dir: string
let store: SshTrustStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-ssh-file-trust-'))
  store = new SshTrustStore({ filePath: join(dir, 'ssh-trusted-hosts.json') })
  setSshTrustStoreForTests(store)
})

afterEach(() => {
  setSshTrustStoreForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

const connectFileClient = async (port: number) => {
  const client = new SSHFileClient('host-key-session', {
    host: '127.0.0.1',
    port,
    username: 'fixture',
    password: 'file-secret'
  })
  try {
    await client.getClient()
  } finally {
    await client.disconnect()
  }
}

describe('SSHFileClient（独立 SFTP 连接）主机密钥校验', () => {
  it('未知主机直接拒绝，不弹窗、不写可信记录', async () => {
    const fixture = await startServer(0, makeHostKey())
    try {
      await expect(connectFileClient(fixture.port)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_UNKNOWN' })
      expect(store.list()).toEqual([])
    } finally {
      await stopServer(fixture)
    }
  })

  it('可信记录命中时连接成功', async () => {
    const fixture = await startServer(0, makeHostKey())
    try {
      const fingerprint = await probeFingerprint(fixture.port)
      store.trust({ host: '127.0.0.1', port: fixture.port, fingerprint, algorithm: 'ssh-rsa' })
      await expect(connectFileClient(fixture.port)).resolves.toBeUndefined()
    } finally {
      await stopServer(fixture)
    }
  })

  it('同一地址换成另一把真实主机密钥 → 拒绝变化，旧记录不变', async () => {
    const first = await startServer(0, makeHostKey())
    const port = first.port
    const firstFingerprint = await probeFingerprint(port)
    store.trust({ host: '127.0.0.1', port, fingerprint: firstFingerprint, algorithm: 'ssh-rsa' })
    // 第一把密钥可以正常连接
    await expect(connectFileClient(port)).resolves.toBeUndefined()
    await stopServer(first)

    // 同一 host:port 换第二把真实密钥
    const second = await startServer(port, makeHostKey())
    try {
      let failure: SshHostKeyError | undefined
      try {
        await connectFileClient(port)
      } catch (error) {
        failure = error as SshHostKeyError
      }
      expect(failure?.code).toBe('SSH_HOST_KEY_CHANGED')
      expect(failure?.previousFingerprint).toBe(firstFingerprint)
      expect(failure?.fingerprint).not.toBe(firstFingerprint)
      expect(failure?.message).toContain('已拒绝连接')
      // 拒绝后不得覆盖可信记录
      expect(store.get('127.0.0.1', port)?.fingerprint).toBe(firstFingerprint)
    } finally {
      await stopServer(second)
    }
  })

  it('可信记录损坏 → fail closed', async () => {
    const fixture = await startServer(0, makeHostKey())
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(store.path, 'corrupted', 'utf-8')
      await expect(connectFileClient(fixture.port)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_STORE_CORRUPT' })
    } finally {
      await stopServer(fixture)
    }
  })
})
