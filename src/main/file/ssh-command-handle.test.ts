import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
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

describe('SSH 命令句柄的资源关闭契约', () => {
  it('正常关闭确认本地通道释放，远端进程树仍未知，并保留真实退出码', async () => {
    const { file, client, stream } = fixture()
    const handle = new SSHCommandExecutor(file).executeCommand({ command: 'command', timeoutMs: 1000 })
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledOnce())
    stream.emit('data', Buffer.from('ok'))
    stream.emit('exit', 7)
    stream.emit('close')
    expect(await handle.result).toEqual({ output: 'ok', exitCode: 7 })
    expect(await handle.resourceClosed).toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
  })

  it('缺少退出码事件时使用 -1，不伪造成功码', async () => {
    const { file, client, stream } = fixture()
    const handle = new SSHCommandExecutor(file).executeCommand({ command: 'command', timeoutMs: 1000 })
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledOnce())
    stream.emit('data', Buffer.from('done'))
    stream.emit('close')
    expect(await handle.result).toEqual({ output: 'done', exitCode: -1 })
    expect((await handle.resourceClosed).state).toBe('closed')
  })

  it('取消后只确认本地通道关闭，远端结果标记为未知且不重复销毁', async () => {
    const { file, client, stream } = fixture()
    const handle = new SSHCommandExecutor(file).executeCommand({ command: 'command', timeoutMs: 1000 })
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledOnce())
    handle.cancel('client')
    await expect(handle.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    expect(await handle.resourceClosed).toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    expect(stream.destroy).toHaveBeenCalledOnce()
    handle.cancel('client')
    expect(stream.destroy).toHaveBeenCalledOnce()
  })

  it('预先取消不连接，句柄标记命令未下发', async () => {
    const { file } = fixture()
    const handle = new SSHCommandExecutor(file).executeCommand({ command: 'command', timeoutMs: 1000, signal: AbortSignal.abort() })
    await expect(handle.result).rejects.toThrow('aborted')
    expect(await handle.resourceClosed).toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
    expect(file.getClient).not.toHaveBeenCalled()
  })

  it('持久 shell 中取消排队命令只关闭该命令，活动命令仍正常完成', async () => {
    const { file, stream } = fixture()
    const shell = new SSHCommandShell(file, 'enter')
    const first = shell.executeCommand({ command: 'first', timeoutMs: 1000 })
    const second = shell.executeCommand({ command: 'second', timeoutMs: 1000 })
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(2))
    second.cancel('client')
    await expect(second.result).rejects.toThrow('aborted')
    expect(await second.resourceClosed).toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
    finishShell(stream, 0)
    expect(await first.result).toEqual({ output: 'result', exitCode: 0 })
    expect(await first.resourceClosed).toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    await shell.cleanup()
  })
})
