import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ session: {} }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
vi.mock('./launch-resolve', () => ({ createDshWebLaunchResolver: () => ({}), buildChildEnv: vi.fn() }))
vi.mock('./web', () => ({ dshWebManager: {} }))
import { createMarketService, marketViewUrl, type MarketDependencies } from './market'

function dependencies(overrides: Partial<MarketDependencies> = {}): MarketDependencies {
  return {
    running: () => false, installed: async () => true,
    open: vi.fn(async () => 'http://127.0.0.1:12345/'),
    install: vi.fn(async () => {}), release: vi.fn(), ...overrides
  }
}

describe('DSH sidebar market', () => {
  it('只接受回环 origin，清除 token、会话和 hash', () => {
    expect(marketViewUrl('http://127.0.0.1:12345/?token=private#session')).toBe('http://127.0.0.1:12345/?lyshellView=market')
    for (const url of ['https://example.com:443/', 'http://evil.com:1234', 'file:///tmp/x', 'http://user:pass@127.0.0.1:1234/']) {
      expect(() => marketViewUrl(url)).toThrow()
    }
  })
  it('缺失市场时不提前启动后台', async () => {
    const deps = dependencies({ installed: async () => false })
    expect(await createMarketService(deps)('open')).toEqual({ success: true, needsInstall: true })
    expect(deps.open).not.toHaveBeenCalled()
  })
  it('后台运行时拒绝安装，不重启也不写 profile', async () => {
    const deps = dependencies({ running: () => true })
    expect(await createMarketService(deps)('install')).toEqual({ success: true, restartRequired: true })
    expect(deps.install).not.toHaveBeenCalled()
    expect(deps.open).not.toHaveBeenCalled()
  })
  it('安装成功才打开市场', async () => {
    const deps = dependencies()
    expect(await createMarketService(deps)('install')).toMatchObject({ success: true, url: expect.stringContaining('lyshellView=market') })
    expect(deps.install).toHaveBeenCalledOnce()
    expect(deps.open).toHaveBeenCalledOnce()
  })
  it('后台退出后先释放侧栏旧连接，再安装，不残留自己的 holder', async () => {
    let held = true
    const deps = dependencies({
      release: () => { held = false },
      install: async () => { expect(held).toBe(false) }
    })
    expect(await createMarketService(deps)('install')).toMatchObject({ success: true, url: expect.any(String) })
  })
  it('卸载等待在途 open 并释放租约；重复提交不会双开', async () => {
    let finish!: (url: string) => void
    const deps = dependencies({ open: () => new Promise(resolve => { finish = resolve }) })
    const request = createMarketService(deps)
    const opening = request('open')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(await request('open')).toMatchObject({ success: false })
    const releasing = request('release')
    expect(deps.release).not.toHaveBeenCalled()
    finish('http://127.0.0.1:12345/')
    await opening
    await releasing
    expect(deps.release).toHaveBeenCalledOnce()
  })
  it('连接失败清理自己的租约', async () => {
    const deps = dependencies({ open: async () => { throw new Error('offline') } })
    expect(await createMarketService(deps)('open')).toEqual({ success: false, error: 'offline' })
    expect(deps.release).toHaveBeenCalledOnce()
  })
})
