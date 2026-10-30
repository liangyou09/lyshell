import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSHConnector } from './ssh'
import type { SshHostKeyChallenge } from '../security/ssh-host-key'
import { SshTrustStore, setSshTrustStoreForTests } from '../security/ssh-trust'

vi.mock('electron-log', () => ({ default: { info() {}, debug() {}, warn() {}, error() {} } }))

const makeHostKey = (): string =>
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

interface Fixture {
  server: Server
  port: number
  connections: Set<Connection>
}

/** 真实 ssh2 server：accept 任意认证，提供最小 shell 会话（连接器建连后会开 shell） */
const startServer = (port: number, hostKey: string): Promise<Fixture> =>
  new Promise((resolve, reject) => {
    const connections = new Set<Connection>()
    const server = new Server({ hostKeys: [hostKey] }, connection => {
      connections.add(connection)
      connection.on('error', () => {})
      connection.on('close', () => connections.delete(connection))
      connection.on('authentication', ctx => ctx.accept())
      connection.on('ready', () => connection.on('session', accept => {
        const session = accept()
        session.on('pty', acceptPty => acceptPty?.())
        session.on('exec', (acceptExec) => {
          const channel = acceptExec()
          channel.exit(1)
          channel.end()
        })
        session.on('shell', acceptShell => {
          const channel = acceptShell()
          channel.write('fixture ready\r\n')
          channel.on('data', () => {})
        })
      }))
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

let dir: string
let store: SshTrustStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-ssh-connector-trust-'))
  store = new SshTrustStore({ filePath: join(dir, 'ssh-trusted-hosts.json') })
  setSshTrustStoreForTests(store)
})

afterEach(() => {
  setSshTrustStoreForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

const makeConnector = (
  port: number,
  options: { confirmHostKey?: (challenge: SshHostKeyChallenge) => Promise<boolean> } = {}
): { connector: SSHConnector; challenges: SshHostKeyChallenge[]; errors: Error[] } => {
  const challenges: SshHostKeyChallenge[] = []
  const errors: Error[] = []
  const runtimeOptions = options.confirmHostKey
    ? {
        confirmHostKey: (challenge: SshHostKeyChallenge) => {
          challenges.push(challenge)
          return options.confirmHostKey!(challenge)
        }
      }
    : {}
  const connector = new SSHConnector(
    'host-key-connector',
    { host: '127.0.0.1', port, username: 'fixture', readyTimeout: 5000 },
    runtimeOptions
  )
  connector.on('error', error => { errors.push(error) })
  connector.on('data', () => {})
  return { connector, challenges, errors }
}

describe('SSHConnector 主机密钥校验（真实握手）', () => {
  it('未知主机默认拒绝（不弹窗、不首次即信任）', async () => {
    const fixture = await startServer(0, makeHostKey())
    const { connector } = makeConnector(fixture.port)
    try {
      await expect(connector.connect()).rejects.toMatchObject({ code: 'SSH_HOST_KEY_UNKNOWN' })
      expect(connector.isConnected()).toBe(false)
      expect(store.list()).toEqual([])
    } finally {
      await connector.disconnect()
      await stopServer(fixture)
    }
  })

  it('人工确认后先保存再放行；再次连接直接命中可信记录', async () => {
    const fixture = await startServer(0, makeHostKey())
    try {
      const first = makeConnector(fixture.port, { confirmHostKey: async () => true })
      await first.connector.connect()
      expect(first.connector.isConnected()).toBe(true)
      expect(first.challenges).toHaveLength(1)
      expect(first.challenges[0]).toMatchObject({ host: '127.0.0.1', port: fixture.port, changed: false })
      const records = store.list()
      expect(records).toHaveLength(1)
      expect(records[0].endpoint).toBe(`127.0.0.1:${fixture.port}`)
      expect(records[0].fingerprint).toBe(first.challenges[0].fingerprint)
      await first.connector.disconnect()

      // 第二次连接：没有任何确认回调也必须成功（已受信任）
      const second = makeConnector(fixture.port)
      await second.connector.connect()
      expect(second.connector.isConnected()).toBe(true)
      await second.connector.disconnect()
    } finally {
      await stopServer(fixture)
    }
  })

  it('同一地址换成另一把真实主机密钥 → 无确认时拒绝并保留旧记录', async () => {
    const firstServer = await startServer(0, makeHostKey())
    const port = firstServer.port
    const first = makeConnector(port, { confirmHostKey: async () => true })
    await first.connector.connect()
    const trusted = store.get('127.0.0.1', port)?.fingerprint
    await first.connector.disconnect()
    await stopServer(firstServer)
    expect(trusted).toBeTruthy()

    const secondServer = await startServer(port, makeHostKey())
    const second = makeConnector(port)
    try {
      let failure: { code?: string; previousFingerprint?: string } | undefined
      try {
        await second.connector.connect()
      } catch (error) {
        failure = error as { code?: string; previousFingerprint?: string }
      }
      expect(failure?.code).toBe('SSH_HOST_KEY_CHANGED')
      expect(failure?.previousFingerprint).toBe(trusted)
      expect(second.connector.isConnected()).toBe(false)
      expect(store.get('127.0.0.1', port)?.fingerprint).toBe(trusted)
    } finally {
      await second.connector.disconnect()
      await stopServer(secondServer)
    }
  })

  it('密钥变化经人工确认后替换可信记录', async () => {
    const firstServer = await startServer(0, makeHostKey())
    const port = firstServer.port
    const first = makeConnector(port, { confirmHostKey: async () => true })
    await first.connector.connect()
    const trustedBefore = store.get('127.0.0.1', port)!
    await first.connector.disconnect()
    await stopServer(firstServer)

    const secondServer = await startServer(port, makeHostKey())
    const second = makeConnector(port, { confirmHostKey: async () => true })
    try {
      await second.connector.connect()
      expect(second.challenges[0]).toMatchObject({ changed: true, previousFingerprint: trustedBefore.fingerprint })
      const trustedAfter = store.get('127.0.0.1', port)!
      expect(trustedAfter.fingerprint).toBe(second.challenges[0].fingerprint)
      expect(trustedAfter.fingerprint).not.toBe(trustedBefore.fingerprint)
      await second.connector.disconnect()
    } finally {
      await stopServer(secondServer)
    }
  })

  it('关闭连接后晚到的确认作废：不继续认证、不写可信记录', async () => {
    const fixture = await startServer(0, makeHostKey())
    let release: ((value: boolean) => void) | undefined
    const { connector, challenges } = makeConnector(fixture.port, {
      confirmHostKey: () => new Promise<boolean>(resolve => { release = resolve })
    })
    try {
      const connecting = connector.connect()
      connecting.catch(() => {})
      await vi.waitFor(() => expect(challenges).toHaveLength(1))
      await connector.disconnect()
      release?.(true)
      await expect(connecting).rejects.toThrow()
      // 晚到的确认不得落盘，也不得让连接变成已连接
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(connector.isConnected()).toBe(false)
      expect(store.list()).toEqual([])
    } finally {
      await connector.disconnect()
      await stopServer(fixture)
    }
  })

  it('确认通过但保存失败 → 拒绝连接，不显示为已永久信任', async () => {
    const { writeFileSync } = await import('node:fs')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not-a-directory', 'utf-8')
    const broken = new SshTrustStore({ filePath: join(blocker, 'nested', 'ssh-trusted-hosts.json') })
    setSshTrustStoreForTests(broken)

    const fixture = await startServer(0, makeHostKey())
    const { connector } = makeConnector(fixture.port, { confirmHostKey: async () => true })
    try {
      await expect(connector.connect()).rejects.toMatchObject({ code: 'SSH_HOST_KEY_SAVE_FAILED' })
      expect(connector.isConnected()).toBe(false)
      expect(broken.list()).toEqual([])
    } finally {
      await connector.disconnect()
      await stopServer(fixture)
    }
  })
})
