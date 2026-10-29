import { EventEmitter } from 'node:events'
import type { Session, WebContents, WebPreferences } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { ShelfBrowserRuntime } from './shelf-browser-runtime'
import { initializeReadonlySession } from './shelf-readonly-contract'
import type { ShelfWebSleep, TaskShelfEntry } from '@shared/task-shelf'

function fixture(closeImmediately = true) {
  let now = 1000
  const runtime = new ShelfBrowserRuntime(true, { now: () => now, deepSleepAfterMs: 10, closeTimeoutMs: 5, manualTick: true })
  const owner = Object.assign(new EventEmitter(), { id: 1 }) as unknown as WebContents
  const ses = Object.assign(new EventEmitter(), {
    isPersistent: () => false, webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(), setSpellCheckerEnabled: vi.fn()
  }) as unknown as Session
  initializeReadonlySession(ses)
  const url = 'https://fixture.test/read'
  let entry: TaskShelfEntry | undefined = { id: 'task', resourceKey: 'web:a', title: 'fixture', capability: 'web', revision: 1, createdAt: 1, updatedAt: 1, recovery: { kind: 'web', url, readonlyMode: true } }
  const save = vi.fn(async (_id: string, revision: number, metadata: ShelfWebSleep) => {
    if (!entry || entry.revision !== revision) throw Error('conflict')
    entry = { ...entry, revision: revision + 1, recovery: { kind: 'web', readonlyMode: true, url: metadata.url, sleep: metadata } }
  })
  runtime.configurePersistence({ read: () => entry, save })
  let sequence = 0
  const attach = (readonlyMode = true, lateHandshake = false) => {
    const granted = runtime.request(owner, { kind: 'permit', resourceId: 'tab:a', url, source: 'explicitMain', readonlyMode })
    if (!granted.success || !granted.permitId) throw Error(JSON.stringify(granted))
    const prefs = { lyshellCreatePermit: granted.permitId, partition: granted.partition } as WebPreferences
    expect(runtime.willAttach(owner, prefs, granted.url ?? url, readonlyMode ? ses : undefined)).toBe(true)
    const page = Object.assign(new EventEmitter(), {
      id: ++sequence, hostWebContents: owner, session: ses, mainFrame: {}, getLastWebPreferences: () => prefs,
      getURL: vi.fn(() => url), getZoomFactor: () => 1.25, setZoomFactor: vi.fn(), send: vi.fn(),
      isDestroyed: () => false, isCrashed: () => false, isDevToolsOpened: vi.fn(() => false), isLoadingMainFrame: () => false, isCurrentlyAudible: () => false,
      close: vi.fn(() => { if (closeImmediately) page.emit('destroyed') })
    }) as unknown as WebContents
    runtime.didAttach(owner, page)
    if (lateHandshake) { page.emit('dom-ready'); page.emit('did-finish-load'); page.emit('did-stop-loading') }
    page.emit('ipc-message', { senderFrame: page.mainFrame }, 'shelf-browser:attach', granted.permitId, '0123456789abcdef0123456789abcdef')
    page.emit('dom-ready')
    runtime.bindTask(owner, 'task', 'a')
    runtime.request(owner, { kind: 'demand', resourceId: 'tab:a', main: false, shelf: false })
    return page
  }
  return { runtime, owner, attach, save, elapse: () => { now += 11 }, entry: () => entry, remove: () => { entry = undefined }, inspect: () => runtime.request(owner, { kind: 'inspect', resourceId: 'tab:a' }) }
}

describe('生产只读网页深睡事务', () => {
  it('同文档导航不能清除只读副本已经观测到的阻断信号', async () => {
    const f = fixture(), page = f.attach()
    page.emit('ipc-message', { senderFrame: page.mainFrame }, 'shelf-browser:readonly-blocked', { kind: 'input' })
    page.emit('did-start-navigation', {}, 'https://fixture.test/read', true, true)
    f.elapse(); await f.runtime.tick()
    expect(page.close).not.toHaveBeenCalled()
    expect(f.inspect()).toMatchObject({ state: 'live' })
  })
  it('持久提交后才关闭，destroyed 后才 sleeping，恢复沿用保存的原分区和 URL', async () => {
    const f = fixture(), page = f.attach()
    f.elapse(); await f.runtime.tick()
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.entry()?.recovery).toMatchObject({ readonlyMode: true, sleep: { formatVersion: 1, partition: expect.stringMatching(/^shelf-readonly-v1:/), zoom: 1.25, taskId: 'task', resourceId: 'tab:a' } })
    expect(page.close).toHaveBeenCalledWith({ waitForBeforeUnload: true })
    expect(f.inspect()).toMatchObject({ success: true, state: 'sleeping', canRestore: false })
    expect(f.runtime.request(f.owner, { kind: 'permit', resourceId: 'tab:a', url: 'https://wrong.test/', source: 'explicitMain' })).toMatchObject({ success: false, error: 'explicit-demand-required' })
    f.runtime.request(f.owner, { kind: 'wake', resourceId: 'tab:a', source: 'explicitMain' })
    expect(f.runtime.request(f.owner, { kind: 'permit', resourceId: 'tab:a', url: 'https://wrong.test/', source: 'explicitMain' })).toMatchObject({ success: true, url: 'https://fixture.test/read', partition: expect.stringMatching(/^shelf-readonly-v1:/) })
  })
  it.each(['save', 'demand', 'navigation', 'power', 'remove'] as const)('%s 失败或竞态保留原实例', async kind => {
    const f = fixture(), page = f.attach()
    f.save.mockImplementationOnce(async (id, revision, metadata) => {
      if (kind === 'save') throw Error('disk failure')
      if (kind === 'demand') f.runtime.request(f.owner, { kind: 'demand', resourceId: 'tab:a', main: true, shelf: false })
      if (kind === 'navigation') page.emit('did-start-navigation', {}, 'https://fixture.test/new', false, true)
      if (kind === 'power') f.runtime.hostBoundary(true)
      if (kind === 'remove') f.remove()
      void id; void revision; void metadata
    })
    f.elapse(); await f.runtime.tick()
    expect(page.close).not.toHaveBeenCalled()
    expect(f.inspect()).toMatchObject({ state: 'live' })
  })
  it('只有专用只读契约能 safe；动态网页、意外输入和 DevTools 保活', async () => {
    for (const kind of ['dynamic', 'input', 'devtools'] as const) {
      const f = fixture(), page = f.attach(kind !== 'dynamic')
      if (kind === 'input') page.emit('ipc-message', { senderFrame: page.mainFrame }, 'shelf-browser:readonly-blocked', { kind: 'input' })
      if (kind === 'devtools') vi.mocked(page.isDevToolsOpened).mockReturnValue(true)
      f.elapse(); await f.runtime.tick()
      expect(page.close).not.toHaveBeenCalled()
    }
  })
  it('功能回退时拒绝只读请求，不能降级成有脚本的普通网页', () => {
    const f = fixture()
    expect(new ShelfBrowserRuntime(false).request(f.owner, { kind: 'permit', resourceId: 'tab:a', url: 'https://fixture.test/', source: 'explicitMain', readonlyMode: true })).toMatchObject({ success: false })
  })
  it('原分区挑战支持旧 argv/迟到握手，已结束的导航仍恢复缩放和滚动', async () => {
    const f = fixture()
    f.attach(); f.elapse(); await f.runtime.tick()
    f.runtime.request(f.owner, { kind: 'wake', resourceId: 'tab:a', source: 'explicitMain' })
    const page = f.attach(true, true)
    expect(page.setZoomFactor).toHaveBeenCalledWith(1.25)
    expect(page.send).toHaveBeenCalledWith('shelf-browser:challenge', expect.any(String))
    expect(page.send).toHaveBeenCalledWith('shelf-browser:scroll', { navigationNonce: '0123456789abcdef0123456789abcdef', y: 0 })
    expect(f.inspect()).toMatchObject({ state: 'live', restoreStatus: 'ready' })
  })
  it('旧 guest 的迟到事件不能更新同资源的新实例', async () => {
    const f = fixture(), old = f.attach()
    f.elapse(); await f.runtime.tick()
    f.runtime.request(f.owner, { kind: 'wake', resourceId: 'tab:a', source: 'explicitMain' })
    f.attach()
    old.emit('did-fail-load', {}, -105, 'old navigation failed', 'https://fixture.test/old', true)
    old.emit('did-start-navigation', {}, 'https://fixture.test/old', false, true)
    expect(f.inspect()).toMatchObject({ state: 'live', restoreStatus: 'ready' })
  })
  it('错误 frame 和旧文档滚动消息不污染当前快照', async () => {
    const f = fixture(), page = f.attach()
    page.emit('ipc-message', { senderFrame: {} }, 'shelf-browser:readonly-scroll', { y: 800, documentNonce: '0123456789abcdef0123456789abcdef' })
    page.emit('ipc-message', { senderFrame: page.mainFrame }, 'shelf-browser:readonly-scroll', { y: 900, documentNonce: 'stale-document' })
    f.elapse(); await f.runtime.tick()
    expect(f.entry()?.recovery).toMatchObject({ sleep: { scrollY: 0 } })
  })
  it('超时保留句柄和关闭事务，新需求不能创建替身；迟到 destroyed 才提交', async () => {
    const f = fixture(false), page = f.attach()
    f.elapse(); await f.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.inspect()).toMatchObject({ state: 'suspending', sleepReason: 'close-unconfirmed' })
    expect(f.runtime.lifecycle.stats().instances).toBe(1)
    expect(f.runtime.request(f.owner, { kind: 'permit', resourceId: 'tab:a', url: 'https://fixture.test/read', source: 'explicitMain' })).toMatchObject({ success: false })
    page.emit('destroyed')
    expect(f.inspect()).toMatchObject({ state: 'sleeping', canRestore: true })
    expect(f.runtime.lifecycle.stats().instances).toBe(0)
  })
  it('拒绝关闭永久保活到下一次导航，不随定时刷新重试', async () => {
    const f = fixture(false), page = f.attach()
    f.elapse(); await f.runtime.tick()
    page.emit('will-prevent-unload', { preventDefault: () => { throw Error('must not force') } })
    f.elapse(); await f.runtime.tick()
    expect(page.close).toHaveBeenCalledOnce()
    expect(f.inspect()).toMatchObject({ state: 'live', sleepReason: 'blocked' })
  })
  it('唤醒重新计时，100 轮句柄/许可/资源不增长', async () => {
    const f = fixture()
    for (let cycle = 0; cycle < 100; cycle++) {
      if (cycle) f.runtime.request(f.owner, { kind: 'wake', resourceId: 'tab:a', source: 'explicitMain' })
      f.attach()
      f.runtime.hostBoundary(); await f.runtime.tick()
      expect(f.runtime.lifecycle.stats().instances).toBe(1)
      f.elapse(); await f.runtime.tick()
      expect(f.runtime.lifecycle.stats()).toMatchObject({ resources: 1, sleeping: 1, instances: 0, permits: 0 })
    }
    expect(f.runtime.lifecycle.diagnostics().length).toBeLessThanOrEqual(100)
  })
})
