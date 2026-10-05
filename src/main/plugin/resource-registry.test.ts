import { describe, expect, it, vi } from 'vitest'
import { PluginResourceRegistry, releasePluginSessions } from './resource-registry'

describe('插件资源归属', () => {
  it('一个关闭失败仍等待其他资源完成，失败的借用运行时保留归属供再次回收', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'borrowed', 0)
    registry.track('a', 'saved', 0, true)
    let finish!: () => void
    const deleteSaved = vi.fn()
    const deleteLive = vi.fn(async (id: string) => {
      if (id === 'borrowed') throw new Error('close failed')
      await new Promise<void>(resolve => { finish = resolve })
    })
    const hooks = { notifyReleased() {}, listSessions: () => [], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive }
    let finished = false
    const result = releasePluginSessions(registry, 'a', hooks).catch(error => { finished = true; return error as Error })
    await vi.waitFor(() => expect(registry.owner('borrowed')).toBe('a'))
    expect(finished).toBe(false)
    finish()
    expect(await result).toMatchObject({ message: expect.stringContaining('borrowed: Error: close failed') })
    expect(registry.owner('saved')).toBeUndefined()
    deleteLive.mockImplementation(async () => {})
    await releasePluginSessions(registry, 'a', hooks)
    expect(deleteSaved.mock.calls).toEqual([['saved']])
    expect(deleteLive.mock.calls).toEqual([['borrowed'], ['saved'], ['borrowed']])
    expect(registry.owner('borrowed')).toBeUndefined()
    expect(registry.track('a', 'late', 0)).toBe(false)
  })

  it('清理中和失败的资源都不允许其他插件抢占，成功回收后才解除归属', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'live', 0)
    let fail!: (error: Error) => void
    const result = releasePluginSessions(registry, 'a', {
      notifyReleased() {}, listSessions: () => [], deleteSaved() {}, notifySessionDeleted() {}, notifyChanged() {},
      deleteLive: () => new Promise<void>((_resolve, reject) => { fail = reject })
    }).catch(error => error as Error)
    expect(registry.owner('live')).toBe('a')
    expect(registry.track('b', 'live', 0)).toBe(false)
    fail(new Error('close failed'))
    expect(await result).toBeInstanceOf(Error)
    expect(registry.owner('live')).toBe('a')
    expect(registry.track('b', 'live', 0)).toBe(false)
    await releasePluginSessions(registry, 'a', {
      notifyReleased() {}, listSessions: () => [], deleteSaved() {}, notifySessionDeleted() {}, notifyChanged() {},
      deleteLive: async () => {}
    })
    expect(registry.track('b', 'live', 0)).toBe(true)
  })

  it.each([undefined, 'b'])('借用归属为 %s 的保存项，并发回收共享关闭且所有调用都等待', async ownerPluginId => {
    const registry = new PluginResourceRegistry()
    registry.trackSavedConnection('a', { id: 'borrowed', ownerPluginId }, 0)
    let finish!: () => void
    const deleteLive = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const deleteSaved = vi.fn()
    const hooks = { notifyReleased() {}, listSessions: () => [{ id: 'borrowed', ownerPluginId }], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive }
    const finished: number[] = []
    const first = releasePluginSessions(registry, 'a', hooks).then(() => { finished.push(1) })
    const second = releasePluginSessions(registry, 'a', hooks).then(() => { finished.push(2) })
    const third = releasePluginSessions(registry, 'a', hooks).then(() => { finished.push(3) })
    await Promise.resolve()
    expect(finished).toEqual([])
    expect(deleteLive).toHaveBeenCalledOnce()
    expect(deleteSaved).not.toHaveBeenCalled()
    expect(registry.owner('borrowed')).toBe('a')
    expect(registry.track('a', 'late', 0)).toBe(false)
    finish()
    await Promise.all([first, second, third])
    expect(finished.sort()).toEqual([1, 2, 3])
    expect(registry.owner('borrowed')).toBeUndefined()
  })

  it('并发回收共享失败，下一轮共享重试，不回滚代次也不重复关闭', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'borrowed', 0)
    let finish!: () => void
    let fail!: (error: Error) => void
    const deleteLive = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject }))
    const hooks = { notifyReleased() {}, listSessions: () => [], deleteSaved() {},
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive }
    const first = releasePluginSessions(registry, 'a', hooks).catch(error => error as Error)
    const second = releasePluginSessions(registry, 'a', hooks).catch(error => error as Error)
    fail(new Error('close failed'))
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ message: expect.stringContaining('close failed') }),
      expect.objectContaining({ message: expect.stringContaining('close failed') })
    ])
    expect(deleteLive).toHaveBeenCalledOnce()
    expect(registry.owner('borrowed')).toBe('a')
    const third = releasePluginSessions(registry, 'a', hooks)
    const fourth = releasePluginSessions(registry, 'a', hooks)
    expect(deleteLive).toHaveBeenCalledTimes(2)
    finish()
    await Promise.all([third, fourth])
    expect(registry.owner('borrowed')).toBeUndefined()
    expect(registry.generation('a')).toBe(4)
  })

  it('重新启用后新增资源，下一次回收等待旧关闭也清理新资源，其他插件仍独立', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'old', 0)
    let finishOld!: () => void
    let finishNew!: () => void
    const deleteLive = vi.fn((id: string) => new Promise<void>(resolve => {
      if (id === 'old') finishOld = resolve
      else finishNew = resolve
    }))
    const hooks = { notifyReleased() {}, listSessions: () => [], deleteSaved() {},
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive }
    const first = releasePluginSessions(registry, 'a', hooks)
    expect(registry.track('a', 'new', registry.generation('a'))).toBe(true)
    registry.track('b', 'independent', 0)
    let finished = false
    const second = releasePluginSessions(registry, 'a', hooks).then(() => { finished = true })
    finishNew()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(deleteLive.mock.calls).toEqual([['old'], ['new']])
    expect(registry.owner('independent')).toBe('b')
    finishOld()
    await Promise.all([first, second])
    expect(registry.owner('old')).toBeUndefined()
    expect(registry.owner('new')).toBeUndefined()
  })

  it('通知同步重入回收时先登记任务，保存项删除完成后才关闭，且只关闭一次', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'saved', 0, true)
    let nested: Promise<void> | undefined
    const events: string[] = []
    const hooks = { notifyReleased: vi.fn(), listSessions: () => [],
      deleteSaved: () => { events.push('saved') }, notifySessionDeleted() {}, notifyChanged() {},
      deleteLive: vi.fn(async () => { events.push('closed') }) }
    hooks.notifyReleased.mockImplementationOnce(() => { nested = releasePluginSessions(registry, 'a', hooks) })
    await releasePluginSessions(registry, 'a', hooks)
    await nested
    expect(events).toEqual(['saved', 'closed'])
    expect(hooks.deleteLive).toHaveBeenCalledOnce()
    expect(registry.owner('saved')).toBeUndefined()
  })

  it.each(['notifyReleased', 'notifySessionDeleted', 'notifyChanged'])('%s 抛错仍完成关闭，并向调用方报告失败', async hook => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'live', 0)
    const hooks = { notifyReleased: vi.fn(), listSessions: () => [], deleteSaved() {},
      notifySessionDeleted: vi.fn(), notifyChanged: vi.fn(), deleteLive: vi.fn(async () => {}) }
    hooks[hook as 'notifyReleased' | 'notifySessionDeleted' | 'notifyChanged'].mockImplementationOnce(() => { throw new Error('notification failed') })
    await expect(releasePluginSessions(registry, 'a', hooks)).rejects.toThrow('notification failed')
    expect(hooks.deleteLive).toHaveBeenCalledOnce()
    expect(registry.owner('live')).toBeUndefined()
    await releasePluginSessions(registry, 'a', hooks)
    expect(hooks.deleteLive).toHaveBeenCalledOnce()
  })

  it('保存项删除失败仍关闭运行时，并保留保存项归属供下次补完', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'saved', 0, true)
    const hooks = { notifyReleased() {}, listSessions: () => [], deleteSaved: vi.fn(),
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive: vi.fn(async () => {}) }
    hooks.deleteSaved.mockImplementationOnce(() => { throw new Error('save failed') })
    await expect(releasePluginSessions(registry, 'a', hooks)).rejects.toThrow('save failed')
    expect(hooks.deleteLive).toHaveBeenCalledOnce()
    expect(registry.owner('saved')).toBe('a')
    await releasePluginSessions(registry, 'a', hooks)
    expect(hooks.deleteSaved).toHaveBeenCalledTimes(2)
    expect(registry.owner('saved')).toBeUndefined()
  })

  it.each([false, true])('并发调用共享保存项状态，再次删除成功=%s，回执覆盖配置与关闭两部分', async retrySaved => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'saved', 0, true)
    let finish!: () => void
    const deleteSaved = vi.fn((): void => { throw new Error('save failed') })
    if (retrySaved) {
      deleteSaved.mockImplementation(() => {})
      deleteSaved.mockImplementationOnce(() => { throw new Error('save failed') })
    }
    const deleteLive = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const hooks = { notifyReleased() {}, listSessions: () => [], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive }
    const first = releasePluginSessions(registry, 'a', hooks).catch(error => error as Error)
    const second = releasePluginSessions(registry, 'a', hooks).catch(error => error as Error)
    expect(deleteSaved).toHaveBeenCalledTimes(2)
    expect(deleteLive).toHaveBeenCalledOnce()
    finish()
    const results = await Promise.all([first, second])
    if (retrySaved) {
      expect(results).toEqual([undefined, undefined])
      expect(registry.owner('saved')).toBeUndefined()
    } else {
      expect(results.every(result => result instanceof Error && result.message.includes('save failed'))).toBe(true)
      expect(registry.owner('saved')).toBe('a')
      deleteSaved.mockImplementation(() => {})
      deleteLive.mockImplementation(async () => {})
      await releasePluginSessions(registry, 'a', hooks)
      expect(registry.owner('saved')).toBeUndefined()
    }
  })

  it('枚举运行时抛错仍关闭已经登记的资源，不遗留无人启动的预登记任务', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'live', 0)
    const hooks = { notifyReleased() {}, listSessions: vi.fn<[], Array<{ id: string }>>(), deleteSaved() {},
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive: vi.fn(async () => {}) }
    hooks.listSessions.mockImplementationOnce(() => { throw new Error('list failed') })
    hooks.listSessions.mockReturnValue([])
    await expect(releasePluginSessions(registry, 'a', hooks)).rejects.toThrow('list failed')
    expect(hooks.deleteLive).toHaveBeenCalledOnce()
    expect(registry.owner('live')).toBeUndefined()
    await releasePluginSessions(registry, 'a', hooks)
    expect(hooks.deleteLive).toHaveBeenCalledOnce()
  })


  it.each([undefined, 'other'])('重复连接归属为 %s 的保存项，禁用只回收借用的运行时', async ownerPluginId => {
    const registry = new PluginResourceRegistry()
    const config = { id: 'saved', ownerPluginId }
    const saved = new Map([[config.id, config]])
    const live = new Set([config.id])
    registry.track('a', config.id, 0)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(registry.trackSavedConnection('a', saved.get(config.id)!, 0)).toBe(true)
    }
    const deleteSaved = vi.fn((id: string) => { saved.delete(id) })
    await releasePluginSessions(registry, 'a', {
      notifyReleased() {}, listSessions: () => [...live].map(id => ({ id })), deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive: async id => { live.delete(id) }
    })
    expect(deleteSaved).not.toHaveBeenCalled()
    expect(saved.get(config.id)).toBe(config)
    expect(live.size).toBe(0)
  })

  it('插件自有保存项重复连接，禁用仍回收配置和终端', async () => {
    const registry = new PluginResourceRegistry()
    const config = { id: 'saved', ownerPluginId: 'a' }
    expect(registry.trackSavedConnection('a', config, 0)).toBe(true)
    expect(registry.trackSavedConnection('a', config, 0)).toBe(true)
    const deleteSaved = vi.fn()
    const deleteLive = vi.fn(async (_id: string) => {})
    await releasePluginSessions(registry, 'a', {
      notifyReleased() {}, listSessions: () => [{ id: config.id }], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive
    })
    expect(deleteSaved.mock.calls).toEqual([[config.id]])
    expect(deleteLive.mock.calls).toEqual([[config.id]])
  })

  it('保存项连接登记仍拒绝旧代次和已有的其他运行时归属', () => {
    const registry = new PluginResourceRegistry()
    const config = { id: 'saved', ownerPluginId: 'a' }
    registry.release('a')
    expect(registry.trackSavedConnection('a', config, 0)).toBe(false)
    registry.track('b', config.id, 0)
    expect(registry.trackSavedConnection('a', config, registry.generation('a'))).toBe(false)
    expect(registry.owner(config.id)).toBe('b')
    expect(registry.release('a')).toEqual([])
  })

  it('禁用只取出本插件资源，重复回收为空', () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'saved-a', 0, true)
    registry.track('a', 'live-a', 0)
    registry.track('b', 'live-b', 0)
    expect(registry.release('a')).toEqual([
      { sessionId: 'saved-a', saved: true }, { sessionId: 'live-a', saved: false }
    ])
    expect(registry.owner('live-b')).toBe('b')
    expect(registry.owner('live-a')).toBeUndefined()
    expect(registry.release('a')).toEqual([])
  })

  it('禁用后重启也不接受旧在途操作，但接受新一轮资源', () => {
    const registry = new PluginResourceRegistry()
    const oldGeneration = registry.generation('a')
    registry.release('a')
    expect(registry.track('a', 'late', oldGeneration)).toBe(false)
    expect(registry.track('a', 'new', registry.generation('a'))).toBe(true)
    expect(registry.release('a')).toEqual([{ sessionId: 'new', saved: false }])
  })

  it('终端提前关闭时仍保留保存项归属，普通运行时归属立即移除', () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'saved', 0, true)
    registry.track('a', 'saved', 0)
    registry.track('a', 'live', 0)
    registry.forgetLiveSession('saved')
    registry.forgetLiveSession('live')
    expect(registry.release('a')).toEqual([{ sessionId: 'saved', saved: true }])
  })

  it('复用其他插件资源不会改变归属', () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'shared', 0, true)
    expect(registry.track('b', 'shared', 0)).toBe(false)
    expect(registry.owner('shared')).toBe('a')
    expect(registry.release('b')).toEqual([])
  })

  it('按显式归属回收来自用户保存项和无 origin 的克隆，保留其他插件及用户渠道', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'saved-a', 0, true)
    const deleteLive = vi.fn(async (_id: string) => {})
    await releasePluginSessions(registry, 'a', {
      notifyReleased() {}, deleteSaved() {}, notifySessionDeleted() {}, notifyChanged() {}, deleteLive,
      listSessions: () => [
        { id: 'user-target-clone', ownerPluginId: 'a', originSavedSessionId: 'user-saved' },
        { id: 'mcp-clone', ownerPluginId: 'a' },
        { id: 'other-clone', ownerPluginId: 'b', originSavedSessionId: 'saved-a' },
        { id: 'user-clone', originSavedSessionId: 'user-saved' }
      ]
    })
    expect(deleteLive.mock.calls.map(call => call[0])).toEqual(['saved-a', 'user-target-clone', 'mcp-clone'])
  })

  it('完整回收插件新建配置和克隆终端，复用用户配置只关运行时，等待所有断开完成', async () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'plugin-saved', 0, true)
    registry.track('a', 'user-saved', 0)
    registry.track('b', 'other-live', 0)
    const callbacks: Array<() => void> = []
    const hooks = {
      notifyReleased: vi.fn(),
      listSessions: () => [
        { id: 'clone', originSavedSessionId: 'plugin-saved' },
        { id: 'user-clone', originSavedSessionId: 'user-saved' }
      ],
      deleteSaved: vi.fn(), notifySessionDeleted: vi.fn(), notifyChanged: vi.fn(),
      deleteLive: vi.fn((_id: string) => new Promise<void>(resolve => callbacks.push(resolve)))
    }
    let finished = false
    const cleanup = releasePluginSessions(registry, 'a', hooks).then(() => { finished = true })
    expect(hooks.notifyReleased).toHaveBeenCalledOnce()
    expect(registry.track('a', 'late', 0)).toBe(false)
    expect(hooks.deleteSaved.mock.calls).toEqual([['plugin-saved']])
    expect(hooks.deleteLive.mock.calls).toEqual([['plugin-saved'], ['user-saved'], ['clone']])
    expect(hooks.notifySessionDeleted.mock.calls).toEqual(hooks.deleteLive.mock.calls)
    expect(hooks.notifyChanged).toHaveBeenCalledOnce()
    expect(registry.owner('other-live')).toBe('b')
    expect(finished).toBe(false)
    callbacks.forEach(resolve => resolve())
    await cleanup
    expect(finished).toBe(true)
  })
})
