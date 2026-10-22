import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn(async () => {}) }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../plugin/process-cleanup', () => ({ terminatePluginProcess: mocks.terminate }))
import { executeLocalCommandStream } from './local-command-stream'

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  mocks.spawn.mockReturnValue(child)
  return child
}
beforeEach(() => { vi.clearAllMocks() })

it('本地流式输出 32 MiB 在 1 Mi 字符处拒绝，关闭管道并回收进程树', async () => {
  const child = fixture()
  let sent = 0
  const pending = executeLocalCommandStream('fixture', undefined, undefined, 1000, c => { sent += c.length })
  const rejection = expect(pending).rejects.toThrow('output limit')
  for (let i = 0; i < 512; i++) child.stdout.emit('data', Buffer.alloc(65536, 120))
  await rejection
  expect(sent).toBe(1024 * 1024)
  expect(child.stdout.destroyed).toBe(true)
  expect(mocks.terminate).toHaveBeenCalledOnce()
})

it('预取消不 spawn；执行期间取消回收且丢弃迟到输出', async () => {
  await expect(executeLocalCommandStream('fixture', undefined, undefined, 1000, vi.fn(), AbortSignal.abort())).rejects.toThrow('aborted')
  expect(mocks.spawn).not.toHaveBeenCalled()
  const child = fixture()
  const abort = new AbortController()
  const onData = vi.fn()
  const pending = executeLocalCommandStream('fixture', undefined, undefined, 1000, onData, abort.signal)
  abort.abort()
  child.stdout.emit('data', Buffer.from('late'))
  await expect(pending).rejects.toThrow('aborted')
  expect(onData).not.toHaveBeenCalled()
  expect(mocks.terminate).toHaveBeenCalledOnce()
})

it('分片 UTF-8、stderr 和真实退出码保留', async () => {
  const child = fixture()
  const pending = executeLocalCommandStream('fixture', undefined, undefined, 1000, () => {})
  const bytes = Buffer.from('中文')
  child.stdout.emit('data', bytes.subarray(0, 1)); child.stdout.emit('data', bytes.subarray(1))
  child.stderr.emit('data', Buffer.from('err'))
  child.emit('close', 7)
  expect(await pending).toEqual({ output: '中文err', exitCode: 7 })
})
