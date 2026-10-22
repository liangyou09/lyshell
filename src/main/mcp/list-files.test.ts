import { expect, it, vi } from 'vitest'
import type { FileInfo } from '@shared/types'
import { listFilesBounded, LIST_DIRECTORY_LIMIT, LIST_SCAN_LIMIT } from './list-files'
import { GLOB_PATTERN_MAX_LENGTH, GlobPatternTooLongError } from './glob'
const file = (path: string, isDir = false): FileInfo => ({ name: path.split('/').pop()!, path, isDir, size: 1, modifyTime: new Date(0) })
const options = () => ({ recursive: true, glob: '*.never', maxEntries: 1, signal: new AbortController().signal })
const fakeSignal = (aborted: boolean) => {
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()
  return { signal: { aborted, addEventListener, removeEventListener } as unknown as AbortSignal, addEventListener, removeEventListener }
}

it('已断开响应不做任何 listDir', async () => {
  const list = vi.fn(async () => [file('/dir', true)])
  const result = await listFilesBounded('/', list, { ...options(), signal: AbortSignal.abort() })
  expect(list).not.toHaveBeenCalled()
  expect(result.reason).toBe('cancelled')
})

it('预取消在编译前短路：巨长 glob 也返回 cancelled，不 listDir 不登记计时监听', async () => {
  vi.useFakeTimers()
  try {
    const list = vi.fn(async () => [file('/dir', true)])
    const { signal, addEventListener, removeEventListener } = fakeSignal(true)
    const result = await listFilesBounded('/', list, { ...options(), glob: 'a'.repeat(1_000_000), signal })
    expect(result).toEqual({ entries: [], truncated: true, reason: 'cancelled', scannedEntries: 0, visitedDirectories: 0 })
    expect(list).not.toHaveBeenCalled()
    expect(addEventListener).not.toHaveBeenCalled()
    expect(removeEventListener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it.each([GLOB_PATTERN_MAX_LENGTH + 1, 1_000_000])('超长 glob（%i 字符）在编译前拒绝且不 listDir', async length => {
  vi.useFakeTimers()
  try {
    const list = vi.fn(async () => [file('/a')])
    const { signal, addEventListener } = fakeSignal(false)
    await expect(listFilesBounded('/', list, { ...options(), glob: 'a'.repeat(length), signal }))
      .rejects.toBeInstanceOf(GlobPatternTooLongError)
    expect(list).not.toHaveBeenCalled()
    expect(addEventListener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('恰好达到上限的 glob 正常编译并遍历', async () => {
  const list = vi.fn(async () => [])
  const result = await listFilesBounded('/', list, { ...options(), glob: 'a'.repeat(GLOB_PATTERN_MAX_LENGTH) })
  expect(list).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ entries: [], truncated: false, scannedEntries: 0, visitedDirectories: 1 })
})

it('glob 无匹配仍受目录与扫描预算约束', async () => {
  const list = vi.fn(async (dir: string) => [file(`${dir}/dir`, true)])
  const result = await listFilesBounded('/', list, options())
  expect(list).toHaveBeenCalledTimes(LIST_DIRECTORY_LIMIT)
  expect(result).toMatchObject({ entries: [], truncated: true, reason: 'directory limit' })
  const huge = await listFilesBounded('/', async () => Array.from({ length: 15000 }, (_, i) => file('/' + i)), options())
  expect(huge.scannedEntries).toBe(LIST_SCAN_LIMIT)
  expect(huge.reason).toBe('scan limit')
})

it('非递归路径同样遵守返回上限，恰好一页不误报截断', async () => {
  const result = await listFilesBounded('/', async () => [file('/a'), file('/b')], { ...options(), recursive: false, glob: undefined })
  expect(result.entries).toHaveLength(1)
  expect(result.reason).toBe('result limit')
  const exact = await listFilesBounded('/', async () => [file('/a')], { ...options(), recursive: false, glob: undefined })
  expect(exact.truncated).toBe(false)
})

it('在途读取中取消立即结束等待，迟到读取不会继续遍历', async () => {
  const controller = new AbortController()
  let reply!: (files: FileInfo[]) => void
  const list = vi.fn(() => new Promise<FileInfo[]>(resolve => { reply = resolve }))
  const pending = listFilesBounded('/', list, { ...options(), signal: controller.signal })
  controller.abort()
  expect((await pending).reason).toBe('cancelled')
  reply([file('/late', true)])
  await Promise.resolve()
  expect(list).toHaveBeenCalledTimes(1)
})

it('挂起 listDir 五秒超时返回明确原因', async () => {
  vi.useFakeTimers()
  try {
    const pending = listFilesBounded('/', () => new Promise(() => {}), options())
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).reason).toBe('time limit')
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it.each([false, true])('根目录读取失败向调用方抛出（recursive=%s）', async recursive => {
  await expect(listFilesBounded('/missing', async () => { throw new Error('Permission denied fixture') }, {
    ...options(), recursive, glob: undefined
  })).rejects.toThrow('Permission denied fixture')
})

it('递归子目录错误不阻止后续目录，并将结果标记为不完整', async () => {
  const result = await listFilesBounded('/', async dir => {
    if (dir === '/') return [file('/denied', true), file('/ok', true)]
    if (dir === '/denied') throw new Error('Permission denied')
    return [file('/ok/a')]
  }, { ...options(), glob: undefined, maxEntries: 10 })
  expect(result.entries.map(entry => entry.path)).toEqual(['/denied', '/ok', '/ok/a'])
  expect(result).toMatchObject({ truncated: true, reason: 'directory read error', visitedDirectories: 3 })
})

it('单次大量匹配中让出执行，接收真实取消回调', async () => {
  const controller = new AbortController()
  const pending = listFilesBounded('/', async () => [file('/' + 'a'.repeat(10000))], {
    ...options(), recursive: false, glob: '*a'.repeat(1000) + 'b', signal: controller.signal
  })
  setImmediate(() => controller.abort())
  expect(await pending).toMatchObject({ reason: 'cancelled', scannedEntries: 1 })
})

it('大量短匹配也让出执行以接收取消', async () => {
  const controller = new AbortController()
  const pending = listFilesBounded('/', async () => Array.from({ length: 10000 }, (_, i) => file('/' + i)), {
    ...options(), signal: controller.signal
  })
  setImmediate(() => controller.abort())
  const result = await pending
  expect(result.reason).toBe('cancelled')
  expect(result.scannedEntries).toBeLessThan(10000)
})

it('单次匹配未完成时五秒截止仍可结束请求', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const pending = listFilesBounded('/', async () => [file('/' + 'a'.repeat(100000))], {
      ...options(), recursive: false, glob: '*a'.repeat(1000) + 'b'
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ reason: 'time limit', scannedEntries: 1 })
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
