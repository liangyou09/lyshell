import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshTrustStore, setSshTrustStoreForTests } from '../security/ssh-trust'
import { SSHConnector, type SshHostKeyChallenge } from './ssh'

vi.mock('electron-log', () => ({ default: { info() {}, debug() {}, warn() {}, error() {} } }))

// 每个用例独立的可信记录文件：验证真实握手时确实走「确认 → 落盘 → 放行」
let trustDir: string
let trustStore: SshTrustStore
beforeEach(() => {
  trustDir = mkdtempSync(join(tmpdir(), 'lyshell-ssh-trust-'))
  trustStore = new SshTrustStore({ filePath: join(trustDir, 'ssh-trusted-hosts.json') })
  setSshTrustStoreForTests(trustStore)
})
afterEach(() => {
  setSshTrustStoreForTests(null)
  rmSync(trustDir, { recursive: true, force: true })
})

describe('SSH 本机协议回环验收', () => {
  it('普通 shell 接收一次 cd，目录失败仍保持连接，不执行 tmux 或 exec', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
    const connections = new Set<Connection>()
    const received: string[] = [], execs: string[] = [], challenges: SshHostKeyChallenge[] = []
    const server = new Server({ hostKeys: [key] }, connection => {
      connections.add(connection)
      connection.on('error', () => {})
      connection.on('authentication', context => context.accept())
      connection.on('ready', () => connection.on('session', accept => {
        const session = accept()
        session.on('pty', acceptPty => acceptPty?.())
        session.on('exec', (acceptExec, _reject, info) => {
          execs.push(info.command)
          const channel = acceptExec(); channel.exit(1); channel.end()
        })
        session.on('shell', acceptShell => {
          const channel = acceptShell()
          channel.write('fixture ready\r\n')
          channel.on('data', (chunk: Buffer) => {
            received.push(chunk.toString())
            channel.write('cd: directory unavailable\r\n$ ')
          })
        })
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const connector = new SSHConnector(
      'ssh-context-protocol',
      { host: '127.0.0.1', port, username: 'fixture', resumeDirectory: "/srv/a'b" },
      {
        confirmHostKey: async (challenge: SshHostKeyChallenge) => {
          challenges.push(challenge)
          return true
        }
      }
    )
    let output = ''
    connector.on('data', text => { output += text })
    connector.on('error', () => {})
    try {
      await connector.connect()
      await vi.waitFor(() => expect(output).toContain('directory unavailable'))
      expect(received.join('')).toBe("cd -- '/srv/a'\\''b' || :\r")
      expect(execs).toEqual([])
      expect(connector.isConnected()).toBe(true)
      // 首次连接：未知密钥需人工确认，确认后必须先落盘再放行
      expect(challenges).toHaveLength(1)
      expect(challenges[0]).toMatchObject({ host: '127.0.0.1', port, changed: false })
      expect(challenges[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
      const records = trustStore.list()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        endpoint: `127.0.0.1:${port}`,
        host: '127.0.0.1',
        port,
        fingerprint: challenges[0].fingerprint
      })
      expect(records[0].schemaVersion).toBe(1)
    } finally {
      await connector.disconnect()
      for (const connection of connections) connection.end()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
