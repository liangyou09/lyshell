import { afterEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mock.exec }))
afterEach(() => { vi.restoreAllMocks(); mock.exec.mockReset(); vi.resetModules() })

it.skipIf(process.platform !== 'win32')('三路检测合并异步读取，TTL 命中缓存，显式刷新共享在途请求', async () => {
  const { readSystemPath, getCachedSystemPath } = await import('./refresh')
  let complete!: (error: Error | null, stdout: string) => void
  mock.exec.mockImplementation((_file, _args, _options, cb) => { complete = cb })
  const requests = [readSystemPath(), readSystemPath(), readSystemPath()]
  expect(mock.exec).toHaveBeenCalledOnce()
  let tick = false
  await new Promise<void>(resolve => setTimeout(() => { tick = true; resolve() }, 0))
  expect(tick).toBe(true)
  complete(null, '{"user":"user-bin","machine":"system-bin"}')
  expect(await Promise.all(requests)).toEqual(Array(3).fill('user-bin;system-bin'))
  expect(getCachedSystemPath()).toBe('user-bin;system-bin')
  expect(await readSystemPath()).toBe('user-bin;system-bin')
  expect(mock.exec).toHaveBeenCalledOnce()
  const refresh = readSystemPath(true)
  const coalesced = readSystemPath(true)
  expect(mock.exec).toHaveBeenCalledTimes(2)
  complete(null, '{"user":"new","machine":""}')
  expect(await refresh).toBe('new')
  expect(await coalesced).toBe('new')
})
