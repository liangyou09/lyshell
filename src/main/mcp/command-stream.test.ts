import { EventEmitter } from 'events'
import type { ServerResponse } from 'http'
import { afterEach, expect, it, vi } from 'vitest'
import { CommandStreamWriter } from './command-stream'

function fixture() {
  const res = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn(), destroy: vi.fn(), destroyed: false, writableEnded: false })
  const abort = new AbortController()
  return { res, abort, writer: new CommandStreamWriter(res as unknown as ServerResponse, abort) }
}
afterEach(() => { vi.useRealTimers() })

it('背压后暂停写入，drain 后恢复并完成，移除监听器', async () => {
  const { res, writer, abort } = fixture()
  res.write.mockReturnValueOnce(false)
  writer.chunk('first'); writer.chunk('second')
  expect(res.write).toHaveBeenCalledTimes(1)
  const done = writer.finish({ type: 'done', exitCode: 7, output: 'firstsecond' })
  expect(res.end).not.toHaveBeenCalled()
  res.emit('drain')
  await done
  expect(res.write).toHaveBeenCalledTimes(2)
  expect(res.end).toHaveBeenCalledOnce()
  expect(abort.signal.aborted).toBe(false)
  expect(res.listenerCount('drain')).toBe(0)
})

it('慢消费者队列有硬上限并取消命令', () => {
  const { res, writer, abort } = fixture()
  res.write.mockReturnValue(false)
  expect(() => { for (let i = 0; i < 512; i++) writer.chunk('x'.repeat(65536)) }).toThrow('too slow')
  expect(res.write).toHaveBeenCalledOnce()
  expect(abort.signal.aborted).toBe(true)
  expect(res.destroy).toHaveBeenCalledOnce()
})

it('drain 回调的 socket 写入异常也回收队列并取消执行', async () => {
  const { res, writer, abort } = fixture()
  res.write.mockReturnValueOnce(false)
  writer.chunk('first'); writer.chunk('second')
  const pending = expect(writer.finish({ type: 'done' })).rejects.toThrow('socket closed')
  res.write.mockImplementation(() => { throw new Error('socket closed') })
  expect(() => res.emit('drain')).not.toThrow()
  await pending
  expect(abort.signal.aborted).toBe(true)
  expect(res.listenerCount('drain')).toBe(0)
})

it('无 drain 时五秒内终止；客户端关闭立即取消', async () => {
  vi.useFakeTimers()
  const { res, writer, abort } = fixture()
  res.write.mockReturnValue(false)
  writer.chunk('x')
  const pending = expect(writer.finish({ type: 'done' })).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(5000)
  await pending
  expect(abort.signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  const other = fixture()
  other.res.emit('close')
  expect(other.abort.signal.aborted).toBe(true)
})
