import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), acquire: vi.fn(), retainBackend: vi.fn(), unretainBackend: vi.fn(),
  release: vi.fn(), close: vi.fn(), reused: false, isManaged: false, leaseCount: 0
}))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: mocks.fetch }) } }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
vi.mock('./launch-resolve', () => ({ createDshWebLaunchResolver: () => ({}), buildChildEnv: vi.fn() }))
vi.mock('./web', () => ({ dshWebManager: {
  running: true,
  get isManaged() { return mocks.isManaged },
  get leaseCount() { return mocks.leaseCount },
  acquire: mocks.acquire, retainBackend: mocks.retainBackend, unretainBackend: mocks.unretainBackend,
  release: mocks.release, close: mocks.close
} }))
import { requestDshMarket } from './market'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.reused = false; mocks.isManaged = false; mocks.leaseCount = 0
  mocks.acquire.mockImplementation(async () => ({ ok: true, reused: mocks.reused, url: 'http://127.0.0.1:1234/' }))
})

describe('市场可用性探测失败的清理', () => {
  it.each(['network', 'http'])('%s 失败回收侧栏新开的空后台', async kind => {
    if (kind === 'network') mocks.fetch.mockRejectedValue(new Error('offline'))
    else mocks.fetch.mockResolvedValue({ ok: false })
    expect(await requestDshMarket('open')).toMatchObject({ success: false })
    expect(mocks.unretainBackend).toHaveBeenCalledWith('sidebar:dsh-market')
    expect(mocks.release).toHaveBeenCalledWith('sidebar:dsh-market')
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it.each(['reused', 'isManaged', 'leaseCount'])('%s 后台探测失败时只释放侧栏自身', async owner => {
    if (owner === 'reused') mocks.reused = true
    if (owner === 'isManaged') mocks.isManaged = true
    if (owner === 'leaseCount') mocks.leaseCount = 1
    mocks.fetch.mockRejectedValue(new Error('offline'))
    expect(await requestDshMarket('open')).toMatchObject({ success: false })
    expect(mocks.close).not.toHaveBeenCalled()
  })
})
