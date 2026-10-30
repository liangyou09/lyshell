import { EventEmitter } from 'events'
import type { Client, ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { SSHCommandExecutor } from './ssh-command-executor'
import { SSHCommandShell } from './ssh-command-shell'
import type { SSHFileClient } from './ssh-file-client'
import type { CommandExecutionHandle } from '../commands/types'

type Kind = 'exec' | 'shell'
type OpenCallback = (error: Error | undefined, stream: ClientChannel) => void

function fixture(kind: Kind, enterCommands = '') {
  const stream = new EventEmitter() as ClientChannel
  Object.assign(stream, {
    stderr: new EventEmitter(),
    // destroy 是请求，测试必须另外显式发出 close 才能证明已关闭。
    destroy: vi.fn(() => stream),
    write: vi.fn((_text: string) => true)
  })
  let openCallback: OpenCallback | undefined
  const exec = vi.fn((_command: string, callback: OpenCallback) => { openCallback = callback })
  const shell = vi.fn((callback: OpenCallback) => { openCallback = callback })
  const client = { exec, shell }
  const getClient = vi.fn(async () => client as unknown as Client)
  const file = { getClient } as unknown as SSHFileClient
  const connector = kind === 'exec' ? new SSHCommandExecutor(file) : new SSHCommandShell(file, enterCommands)
  return {
    connector, stream, exec, shell, getClient, client,
    start: (command = 'fixture-command') => connector.executeCommand({ command, timeoutMs: 1000 }),
    requested: () => kind === 'exec' ? exec : shell,
    open: () => { if (!openCallback) throw new Error('No channel open was requested'); openCallback(undefined, stream) },
    openFailed: () => { if (!openCallback) throw new Error('No channel open was requested'); openCallback(new Error('fixture transport failed'), undefined as unknown as ClientChannel) },
    cleanup: () => connector instanceof SSHCommandShell ? connector.cleanup() : Promise.resolve()
  }
}

async function tick() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

function observeClose(handle: CommandExecutionHandle) {
  const closed = vi.fn()
  void handle.resourceClosed.then(closed)
  return closed
}

describe('SSH 命令资源关闭的独立确认', () => {
  it.each(['exec', 'shell'] as const)('%s 已打开通道取消后结果先失败，destroy 不代替实际 close', async kind => {
    const f = fixture(kind)
    const handle = f.start()
    const rejected = expect(handle.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    const closed = observeClose(handle)
    await vi.waitFor(() => expect(f.requested()).toHaveBeenCalledOnce())
    f.open()
    if (kind === 'shell') await vi.waitFor(() => expect(f.stream.write).toHaveBeenCalledOnce())
    handle.cancel('client')
    await rejected
    await tick()
    expect(f.stream.destroy).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
    f.stream.emit('close')
    await expect(handle.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    expect(closed).toHaveBeenCalledOnce()
    handle.cancel('client')
    expect(f.stream.destroy).toHaveBeenCalledOnce()
  })

  it.each(['exec', 'shell'] as const)('%s 打开回调尚未返回时取消，迟到 stream 必须 destroy 后再等 close', async kind => {
    const f = fixture(kind)
    const handle = f.start()
    const rejected = expect(handle.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    const closed = observeClose(handle)
    await vi.waitFor(() => expect(f.requested()).toHaveBeenCalledOnce())
    handle.cancel('client')
    await rejected
    await tick()
    expect(closed).not.toHaveBeenCalled()
    expect(f.stream.destroy).not.toHaveBeenCalled()
    f.open()
    await tick()
    expect(f.stream.destroy).toHaveBeenCalledOnce()
    expect(f.stream.write).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    f.stream.emit('close')
    await expect(handle.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
  })

  it('exec 请求已发出后回调失败，结果仍是远端 unknown，不能改称未派发', async () => {
    const f = fixture('exec')
    const handle = f.start()
    const rejected = expect(handle.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    await vi.waitFor(() => expect(f.exec).toHaveBeenCalledOnce())
    f.openFailed()
    await rejected
    await expect(handle.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    expect(f.exec).toHaveBeenCalledOnce()
  })

  it('shell 初始化已写但用户命令未写时取消，也保留 unknown 并等待实际 close', async () => {
    const f = fixture('shell', 'enter-context')
    const handle = f.start('business-command')
    const rejected = expect(handle.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    const closed = observeClose(handle)
    vi.mocked(f.stream.write).mockImplementation(text => {
      if (text === 'enter-context\n') handle.cancel('client')
      return true
    })
    await vi.waitFor(() => expect(f.shell).toHaveBeenCalledOnce())
    f.open()
    await rejected
    await tick()
    expect(f.stream.write).toHaveBeenCalledOnce()
    expect(f.stream.write).toHaveBeenCalledWith('enter-context\n')
    expect(JSON.stringify(vi.mocked(f.stream.write).mock.calls)).not.toContain('business-command')
    expect(f.stream.destroy).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
    f.stream.emit('close')
    await expect(handle.resourceClosed).resolves.toMatchObject({ state: 'closed', remoteTerminated: 'unknown' })
  })

  it('shell 队列中从未派发的命令取消仍明确 not-dispatched，不触及活动项', async () => {
    const f = fixture('shell')
    let connected!: (client: Client) => void
    const connection = new Promise<Client>(resolve => { connected = resolve })
    f.getClient.mockImplementation(() => connection)
    const active = f.start('first')
    const activeResult = expect(active.result).rejects.toThrow('Command aborted')
    const queued = f.start('never-dispatched')
    const queuedResult = expect(queued.result).rejects.toThrow('Command aborted')
    queued.cancel('client')
    await queuedResult
    await expect(queued.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
    expect(f.getClient).toHaveBeenCalledOnce()
    expect(f.shell).not.toHaveBeenCalled()
    expect(f.stream.write).not.toHaveBeenCalled()
    // 活动项尚在 getClient 的 await 之前，取消它也无终端输入副作用。
    active.cancel('client')
    await activeResult
    await expect(active.resourceClosed).resolves.toMatchObject({ remoteTerminated: 'not-dispatched' })
    connected(f.client as unknown as Client)
    await tick()
    expect(f.shell).not.toHaveBeenCalled()
  })

  it.each(['exec', 'shell'] as const)('%s 正常前台结果保留真实退出码，仍不承诺远端进程树终止', async kind => {
    const f = fixture(kind)
    const handle = f.start()
    await vi.waitFor(() => expect(f.requested()).toHaveBeenCalledOnce())
    f.open()
    if (kind === 'exec') {
      f.stream.emit('data', Buffer.from('fixture output'))
      f.stream.emit('exit', 7)
      f.stream.emit('close')
    } else {
      await vi.waitFor(() => expect(f.stream.write).toHaveBeenCalledOnce())
      const text = String(vi.mocked(f.stream.write).mock.calls[0][0])
      const marker = /(___END_MARKER_UUID_[\w-]+___)/.exec(text)?.[1]
      expect(marker).toBeTruthy()
      f.stream.emit('data', Buffer.from(`fixture output\n${marker}:7\n`))
    }
    await expect(handle.result).resolves.toEqual({ output: 'fixture output', exitCode: 7 })
    await expect(handle.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    await f.cleanup()
    f.stream.emit('close')
  })
})
