import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client, ClientChannel } from 'ssh2'
import { SSHCommandExecutor } from './ssh-command-executor'
import { SSHCommandShell } from './ssh-command-shell'
import type { SSHFileClient } from './ssh-file-client'

function channel() {
  const stream = new EventEmitter() as ClientChannel
  Object.assign(stream, { stderr: new EventEmitter(), write: vi.fn(), destroy: vi.fn(() => stream.emit('close')) })
  return stream
}

function fixture() {
  const stream = channel()
  const client = { exec: vi.fn((_command, callback) => callback(undefined, stream)), shell: vi.fn(callback => callback(undefined, stream)) }
  const file = { getClient: vi.fn(async () => client as unknown as Client) } as unknown as SSHFileClient
  return { stream, client, file }
}

function finishShell(stream: ClientChannel, code = 0) {
  const writes = vi.mocked(stream.write).mock.calls.map(call => String(call[0])).join('')
  const markers = [...writes.matchAll(/(___END_MARKER_UUID_[\w-]+___):%s/g)]
  stream.emit('data', Buffer.from(`result\n${markers.at(-1)![1]}:${code}\n`))
}

afterEach(() => { vi.useRealTimers() })

describe('SSH 命令执行生命周期', () => {
  it('预先取消不连接 SSH', async () => {
    const { file } = fixture()
    const signal = AbortSignal.abort()
    await expect(new SSHCommandExecutor(file).execStream('side-effect', 1000, () => {}, signal)).rejects.toThrow('aborted')
    expect(file.getClient).not.toHaveBeenCalled()
  })

  it('连接等待期间取消，不再下发命令', async () => {
    const { file, client } = fixture()
    let ready!: (client: Client) => void
    vi.mocked(file.getClient).mockReturnValue(new Promise(resolve => { ready = resolve }))
    const abort = new AbortController()
    const pending = new SSHCommandExecutor(file).execStream('side-effect', 1000, () => {}, abort.signal)
    abort.abort()
    await expect(pending).rejects.toThrow('aborted')
    ready(client as unknown as Client)
    await Promise.resolve()
    expect(client.exec).not.toHaveBeenCalled()
  })

  it('超时后销毁迟到的 exec 通道，不输出数据', async () => {
    vi.useFakeTimers()
    const { file, client, stream } = fixture()
    let opened!: (error: undefined, stream: ClientChannel) => void
    client.exec.mockImplementation((_command, callback) => { opened = callback })
    const onData = vi.fn()
    const pending = new SSHCommandExecutor(file).execStream('hang', 20, onData)
    const rejection = expect(pending).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(20)
    await rejection
    opened(undefined, stream)
    stream.emit('data', Buffer.from('late'))
    expect(stream.destroy).toHaveBeenCalledOnce()
    expect(onData).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('分片 UTF-8 保真，保留非零退出码', async () => {
    const { file, client, stream } = fixture()
    const chunks: string[] = []
    const pending = new SSHCommandExecutor(file).execStream('command', 1000, chunk => chunks.push(chunk))
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalled())
    const bytes = Buffer.from('中文')
    stream.emit('data', bytes.subarray(0, 1))
    stream.emit('data', bytes.subarray(1))
    stream.emit('exit', 7)
    stream.emit('close')
    expect(await pending).toEqual({ output: '中文', exitCode: 7 })
    expect(chunks.join('')).toBe('中文')
  })

  it('持久 shell 返回实际退出码，且命令注释不会吞掉标记', async () => {
    const { file, stream } = fixture()
    const shell = new SSHCommandShell(file, 'enter')
    const pending = shell.execStream('false # comment', 1000, () => {})
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(2))
    expect(vi.mocked(stream.write).mock.calls[1][0]).toContain('false # comment\nprintf')
    finishShell(stream, 7)
    expect(await pending).toEqual({ output: 'result', exitCode: 7 })
    await shell.cleanup()
  })

  it('取消排队命令不干扰正在执行的命令', async () => {
    const { file, stream } = fixture()
    const shell = new SSHCommandShell(file, 'enter')
    const active = shell.execRaw('first', 1000)
    const abort = new AbortController()
    const queued = shell.execStream('second', 1000, () => {}, abort.signal)
    abort.abort()
    await expect(queued).rejects.toThrow('aborted')
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(2))
    finishShell(stream)
    expect(await active).toBe('result')
    expect(stream.destroy).not.toHaveBeenCalled()
    expect(vi.mocked(stream.write).mock.calls.join('')).not.toContain('second')
    await shell.cleanup()
  })

  it('初始化期间超时，迟到的 shell 被销毁且不发送进入命令', async () => {
    vi.useFakeTimers()
    const { file, client, stream } = fixture()
    let opened!: (error: undefined, stream: ClientChannel) => void
    client.shell.mockImplementation(callback => { opened = callback })
    const shell = new SSHCommandShell(file, 'enter')
    const pending = shell.execRaw('side-effect', 20)
    const rejection = expect(pending).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(20)
    await rejection
    opened(undefined, stream)
    await Promise.resolve()
    expect(stream.destroy).toHaveBeenCalledOnce()
    expect(stream.write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
