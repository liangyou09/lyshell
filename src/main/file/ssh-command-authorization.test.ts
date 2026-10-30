import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import type { Client, ClientChannel } from 'ssh2'
import { OperationError } from '@shared/operation'
import { SSHCommandExecutor } from './ssh-command-executor'
import { SSHCommandShell } from './ssh-command-shell'
import type { SSHFileClient } from './ssh-file-client'

function fixture() {
  const stream = new EventEmitter() as ClientChannel
  Object.assign(stream, {
    stderr: new EventEmitter(), destroy: vi.fn(() => stream.emit('close')),
    write: vi.fn((text: string) => {
      const marker = text.match(/(___END_MARKER_UUID_[\w-]+___):%s/)?.[1]
      if (marker) queueMicrotask(() => stream.emit('data', Buffer.from(`\n${marker}:0\n`)))
      return true
    })
  })
  const client = {
    exec: vi.fn((_text, callback) => {
      callback(undefined, stream)
      queueMicrotask(() => { stream.emit('exit', 0); stream.emit('close') })
    }),
    shell: vi.fn(callback => callback(undefined, stream))
  }
  const file = { getClient: vi.fn(async () => client as unknown as Client) } as unknown as SSHFileClient
  let current = true
  const guard = () => { if (!current) throw new OperationError('FORBIDDEN', 'Authorization revoked') }
  return { stream, client, file, guard, revoke: () => { current = false } }
}

describe('独立 SSH 命令最终派发授权', () => {
  it('执行入口已撤权时不建立 SSH 连接', async () => {
    const f = fixture()
    f.revoke()
    await expect(new SSHCommandExecutor(f.file).execStream('effect', 1000, () => {}, undefined, f.guard)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(f.file.getClient).not.toHaveBeenCalled()
    expect(f.client.exec).not.toHaveBeenCalled()
  })

  it('exec 等待 getClient 后撤权，不向已就绪的 client 派发', async () => {
    const f = fixture()
    let ready!: (client: Client) => void
    vi.mocked(f.file.getClient).mockReturnValue(new Promise(resolve => { ready = resolve }))
    const pending = new SSHCommandExecutor(f.file).execStream('effect', 1000, () => {}, undefined, f.guard)
    const check = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.revoke()
    ready(f.client as unknown as Client)
    await check
    expect(f.client.exec).not.toHaveBeenCalled()
  })

  it('shell 等待 getClient 后撤权，不创建 shell 或发送初始化命令', async () => {
    const f = fixture()
    let ready!: (client: Client) => void
    vi.mocked(f.file.getClient).mockReturnValue(new Promise(resolve => { ready = resolve }))
    const shell = new SSHCommandShell(f.file, 'enter')
    const pending = shell.execStream('effect', 1000, () => {}, undefined, f.guard)
    const check = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.revoke()
    ready(f.client as unknown as Client)
    await check
    expect(f.client.shell).not.toHaveBeenCalled()
    expect(f.stream.write).not.toHaveBeenCalled()
  })

  it('shell channel-open 等待期间撤权，销毁迟到通道且不发送进入命令', async () => {
    const f = fixture()
    let opened!: (error: undefined, stream: ClientChannel) => void
    f.client.shell.mockImplementation(callback => { opened = callback })
    const pending = new SSHCommandShell(f.file, 'enter').execStream('effect', 1000, () => {}, undefined, f.guard)
    const check = expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    await vi.waitFor(() => expect(f.client.shell).toHaveBeenCalledOnce())
    f.revoke()
    opened(undefined, f.stream)
    await check
    expect(f.stream.write).not.toHaveBeenCalled()
    expect(f.stream.destroy).toHaveBeenCalled()
  })

  it('初始化已部分发送后撤权，停止剩余写入并返回结果未知', async () => {
    const f = fixture()
    f.stream.write = vi.fn(() => { f.revoke(); return true }) as ClientChannel['write']
    const pending = new SSHCommandShell(f.file, 'first-enter\nsecond-enter').execStream('effect', 1000, () => {}, undefined, f.guard)
    await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    expect(f.stream.write).toHaveBeenCalledOnce()
    expect(f.stream.write).toHaveBeenCalledWith('first-enter\n')
  })

  it('等待前一命令时撤权，不向缓存 shell 发送排队命令', async () => {
    const f = fixture()
    f.stream.write = vi.fn(() => true) as ClientChannel['write']
    const shell = new SSHCommandShell(f.file, '')
    const first = shell.execRaw('first', 1000)
    await vi.waitFor(() => expect(f.stream.write).toHaveBeenCalledOnce())
    const queued = shell.execStream('second', 1000, () => {}, undefined, f.guard)
    const check = expect(queued).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.revoke()
    const marker = String(vi.mocked(f.stream.write).mock.calls[0][0]).match(/(___END_MARKER_UUID_[\w-]+___):%s/)![1]
    f.stream.emit('data', Buffer.from(`\n${marker}:0\n`))
    await first
    await check
    expect(f.stream.write).toHaveBeenCalledOnce()
  })

  it('同一缓存 shell 上有效调用可以继续，已派发命令不会被自动重放', async () => {
    const f = fixture()
    const shell = new SSHCommandShell(f.file, 'enter')
    await expect(shell.execStream('first', 1000, () => {}, undefined, f.guard)).resolves.toMatchObject({ exitCode: 0 })
    await expect(shell.execStream('second', 1000, () => {}, undefined, f.guard)).resolves.toMatchObject({ exitCode: 0 })
    expect(f.client.shell).toHaveBeenCalledOnce()
    expect(f.stream.write).toHaveBeenCalledTimes(3)
    await shell.cleanup()
  })
})
