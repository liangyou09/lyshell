import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Server, type Connection } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { SSHConnector } from './ssh'

vi.mock('electron-log', () => ({ default: { info() {}, debug() {}, warn() {}, error() {} } }))

describe('SSH 本机协议回环验收', () => {
  it('普通 shell 接收一次 cd，目录失败仍保持连接，不执行 tmux 或 exec', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
    const connections = new Set<Connection>()
    const received: string[] = [], execs: string[] = []
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
    const connector = new SSHConnector('ssh-context-protocol', { host: '127.0.0.1', port, username: 'fixture', resumeDirectory: "/srv/a'b" })
    let output = ''
    connector.on('data', text => { output += text })
    connector.on('error', () => {})
    try {
      await connector.connect()
      await vi.waitFor(() => expect(output).toContain('directory unavailable'))
      expect(received.join('')).toBe("cd -- '/srv/a'\\''b' || :\r")
      expect(execs).toEqual([])
      expect(connector.isConnected()).toBe(true)
    } finally {
      await connector.disconnect()
      for (const connection of connections) connection.end()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
