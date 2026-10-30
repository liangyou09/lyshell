import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Client, Server, type Connection } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { connectTransferSSH } from './ssh-transfer-connection'
import { computeSshHostKeyFingerprint } from '../security/ssh-host-key'

const log = vi.fn()

const makeHostKey = (): string =>
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

const startServer = (): Promise<{ server: Server; port: number; connections: Set<Connection>; seen: Connection[] }> =>
  new Promise((resolve, reject) => {
    const connections = new Set<Connection>()
    const seen: Connection[] = []
    const server = new Server({ hostKeys: [makeHostKey()] }, connection => {
      seen.push(connection)
      connections.add(connection)
      connection.on('error', () => {})
      connection.on('authentication', ctx => ctx.accept())
      connection.on('close', () => connections.delete(connection))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, connections, seen })
    })
  })

const stopServer = async (fixture: { server: Server; connections: Set<Connection> }): Promise<void> => {
  for (const connection of fixture.connections) connection.end()
  await new Promise<void>(resolve => fixture.server.close(() => resolve()))
}

/** 取服务端真实主机公钥指纹（探针只观察，随后主动拒绝握手） */
const probeFingerprint = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const probe = new Client()
    probe.once('error', reject)
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

describe('connectTransferSSH 真实握手的主机密钥固定匹配', () => {
  it('指纹一致时握手成功（文件 Worker 使用的同一路径）', async () => {
    const fixture = await startServer()
    try {
      const fingerprint = await probeFingerprint(fixture.port)
      const client = await connectTransferSSH(
        { host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'transfer-secret' },
        log,
        { endpoint: `127.0.0.1:${fixture.port}`, fingerprint }
      )
      expect(client).toBeInstanceOf(Client)
      client.end()
    } finally {
      await stopServer(fixture)
    }
  })

  it('指纹不一致时握手被拒，且不当作临时网络故障重试', async () => {
    const fixture = await startServer()
    try {
      const fingerprint = await probeFingerprint(fixture.port)
      const connectionsBefore = fixture.seen.length
      await expect(
        connectTransferSSH(
          { host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'transfer-secret' },
          log,
          { endpoint: `127.0.0.1:${fixture.port}`, fingerprint: `SHA256:${'Z'.repeat(43)}` }
        )
      ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_CHANGED' })
      // 只尝试一次：主机密钥结论不是可重试的网络错误
      expect(fixture.seen.length - connectionsBefore).toBe(1)
      // 探针得到的真实指纹没有被写进日志之外的地方，凭据也不会进日志
      expect(log.mock.calls.flat().join(' ')).not.toContain('transfer-secret')
      expect(fingerprint).toMatch(/^SHA256:/)
    } finally {
      await stopServer(fixture)
    }
  })

  it('注入的 endpoint 与目标不一致 → 建 TCP 前就拒绝', async () => {
    const fixture = await startServer()
    try {
      const connectionsBefore = fixture.seen.length
      await expect(
        connectTransferSSH(
          { host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'transfer-secret' },
          log,
          { endpoint: 'elsewhere:22', fingerprint: `SHA256:${'A'.repeat(43)}` }
        )
      ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_INVALID' })
      expect(fixture.seen.length).toBe(connectionsBefore)
    } finally {
      await stopServer(fixture)
    }
  })
})
