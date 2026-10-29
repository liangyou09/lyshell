import { EventEmitter } from 'node:events'
import type { Session, WebContents, WebPreferences } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShelfWebSleep, TaskShelfEntry } from '@shared/task-shelf'
import { ShelfBrowserRuntime } from './shelf-browser-runtime'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture(savedResource = false, earlyRedirect = false) {
  let clock = 1000, permission = false, url = 'https://fixture.test/read', nonce = '', destroyed = false
  const owner = Object.assign(new EventEmitter(), { id: 1 }) as unknown as WebContents
  const ses = Object.assign(new EventEmitter(), { isPersistent: () => true, webRequest: { onBeforeRequest: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() }, serviceWorkers: { getAllRunning: () => ({}) } }) as unknown as Session
  const runtime = new ShelfBrowserRuntime(true, { now: () => clock, deepSleepAfterMs: 10, manualTick: true })
  runtime.configureReloadableSupport(ses, () => permission)
  let entry: TaskShelfEntry = { id: 'a', title: 'fixture', resourceKey: 'web:a', revision: 1, createdAt: 1, updatedAt: 1, capability: 'web', recovery: { kind: 'web', url } }
  const save = vi.fn((_id: string, revision: number, metadata: ShelfWebSleep) => {
    expect(revision).toBe(entry.revision)
    entry = { ...entry, revision: revision + 1, recovery: { kind: 'web', url: metadata.url, reloadableMode: true, sleep: metadata } }
  })
  runtime.configurePersistence({ read: () => entry, save, setReloadable: (_id, currentUrl, enabled) => {
    expect(entry.recovery).toMatchObject({ url: currentUrl })
    entry = { ...entry, revision: entry.revision + 1, recovery: { kind: 'web', url: currentUrl, ...(enabled ? { reloadableMode: true } : {}) } }
  } })
  const resourceId = savedResource ? 'saved:a' : 'tab:a'
  if (earlyRedirect) entry.recovery = { kind: 'web', url, reloadableMode: true }
  const grant = runtime.request(owner, { kind: 'permit', resourceId, taskId: 'a', url, source: 'explicitMain' })
  if (!grant.success || !grant.permitId) throw Error('permit missing')
  expect(runtime.willAttach(owner, { lyshellCreatePermit: grant.permitId } as WebPreferences, url, ses)).toBe(true)
  const guest = Object.assign(new EventEmitter(), {
    id: 7, hostWebContents: owner, session: ses, mainFrame: { framesInSubtree: [{}] },
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
    getURL: () => url, isDestroyed: () => destroyed, isLoadingMainFrame: () => false, isCrashed: () => false, isCurrentlyAudible: () => false, isDevToolsOpened: () => false,
    getZoomFactor: () => 1.25, setZoomFactor: vi.fn(), send: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(async (_id: number, scripts: Array<{ code: string }>) => {
      const match = /const NONCE = '([a-f0-9]{32})'/.exec(scripts[0].code)
      if (match) { nonce = match[1]; return undefined }
      return { ok: true, nonce, readyState: 'complete', top: true, activation: true, scrollY: 600, observer: true, shadow: false, reasons: [] }
    }),
    loadURL: vi.fn(async (next: string) => { guest.emit('did-start-navigation', {}, next, false, true); url = next; guest.emit('did-navigate', {}, next) }),
    close: vi.fn(() => { destroyed = true; guest.emit('destroyed') }),
  })
  if (earlyRedirect) {
    runtime.observeGuest(guest as unknown as WebContents)
    guest.emit('did-start-navigation', {}, url, false, true)
    url = 'https://fixture.test/redirected'
  }
  runtime.didAttach(owner, guest as unknown as WebContents)
  if (!savedResource) runtime.bindTask(owner, 'a', 'a')
  runtime.request(owner, { kind: 'demand', resourceId, main: false, shelf: false })
  const policy = (enabled: boolean, expectedUrl = url) => runtime.request(owner, { kind: 'reloadPolicy', resourceId, enabled, url: expectedUrl })
  const inspect = () => runtime.request(owner, { kind: 'inspect', resourceId })
  cleanup.push(() => { if (!destroyed) { destroyed = true; guest.emit('destroyed') } owner.emit('destroyed') })
  return { runtime, owner, guest, ses, policy, inspect, save, entry: () => entry, elapse: () => { clock += 11 }, requirePermission: () => { permission = true }, redirectCommit: (next: string) => { url = next; guest.emit('did-navigate', {}, next) }, navigate: (next: string, inPlace = false) => { url = next; guest.emit('did-start-navigation', {}, next, inPlace, true); if (!inPlace) guest.emit('dom-ready') } }
}

describe('普通页逐 URL 重载同意', () => {
  it('同文档导航没有新 dom-ready，也应保留已就绪状态', () => {
    const f = fixture(); f.policy(true)
    expect(f.inspect()).toMatchObject({ restoreStatus: 'ready' })
    f.navigate('https://fixture.test/other', true)
    expect(f.inspect()).toMatchObject({ state: 'live', restoreStatus: 'ready', reloadableMode: false })
  })
  it('卸载期间用户导航到新页面时撤销旧关闭事务，不遗留 suspending 或关闭新页面', async () => {
    const f = fixture(); f.policy(true)
    let finish!: () => void
    f.guest.loadURL.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    f.elapse(); await f.runtime.tick()
    expect(f.inspect()).toMatchObject({ state: 'suspending' })
    f.navigate('https://fixture.test/other')
    expect(f.inspect()).toMatchObject({ state: 'live', reloadableMode: false, url: 'https://fixture.test/other' })
    finish(); await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.guest.close).not.toHaveBeenCalled()
  })
  it('已保存的内部blank提交到destroyed之间，迟到收纳仍认原契约且不能认其他网址', async () => {
    const f = fixture(); f.policy(true)
    f.guest.close.mockImplementation(() => {})
    f.elapse(); await f.runtime.tick()
    expect(f.guest.getURL()).toBe('about:blank')
    expect(f.inspect()).toMatchObject({ state: 'suspending', reloadableMode: true })
    expect(f.entry().recovery).toMatchObject({ reloadableMode: true, sleep: { url: 'https://fixture.test/read' } })
    expect(f.runtime.isReloadableResource(f.owner, 'a', 'https://fixture.test/read')).toBe(true)
    expect(f.runtime.isReloadableResource(f.owner, 'a', 'https://fixture.test/other')).toBe(false)
  })
  it('非关闭事务的空白跳转不能借旧网址许可收纳', () => {
    const f = fixture(); f.policy(true); f.redirectCommit('about:blank')
    expect(f.runtime.isReloadableResource(f.owner, 'a', 'https://fixture.test/read')).toBe(false)
  })
  it('重定向只发提交事件也撤销旧网址同意', async () => {
    const f = fixture(); f.policy(true); f.redirectCommit('https://fixture.test/redirected'); f.elapse(); await f.runtime.tick()
    expect(f.inspect()).toMatchObject({ reloadableMode: false, deepSleepSupported: false })
    expect(f.save).not.toHaveBeenCalled(); expect(f.guest.loadURL).not.toHaveBeenCalled()
  })
  it('首航在 did-attach 前重定向，仍按原生创建时的初始网址绑定而不继承新网址同意', () => {
    const f = fixture(false, true)
    expect(f.inspect()).toMatchObject({ success: true, state: 'live', url: 'https://fixture.test/redirected', reloadableMode: false })
    expect(f.runtime.lifecycle.stats().instances).toBe(1)
    expect(f.runtime.isReloadableResource(f.owner, 'a', 'https://fixture.test/redirected')).toBe(false)
  })
  it('无同意的干净页面不保存、不导航、不销毁', async () => {
    const f = fixture(); f.elapse(); await f.runtime.tick()
    expect(f.save).not.toHaveBeenCalled(); expect(f.guest.loadURL).not.toHaveBeenCalled()
    expect(f.inspect()).toMatchObject({ state: 'live', reloadableMode: false })
  })
  it('同意后保存原分区，原生空白提交后才关闭并确认 sleeping', async () => {
    const f = fixture(); expect(f.policy(true)).toMatchObject({ success: true, reloadableMode: true })
    f.elapse(); await f.runtime.tick(); await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.entry().recovery).toMatchObject({ reloadableMode: true, sleep: { partition: 'persist:webbar', zoom: 1.25, scrollY: 600 } })
    expect(f.guest.loadURL).toHaveBeenCalledWith('about:blank')
    expect(f.guest.close).toHaveBeenCalledOnce()
    expect(f.inspect()).toMatchObject({ state: 'sleeping' })
  })
  it('相同页面存在媒体权限活动时即使有同意也保活', async () => {
    const f = fixture(); f.policy(true); f.requirePermission(); f.elapse(); await f.runtime.tick()
    expect(f.save).not.toHaveBeenCalled(); expect(f.guest.loadURL).not.toHaveBeenCalled()
    expect(f.inspect()).toMatchObject({ state: 'live', sleepReason: 'permission-activity' })
  })
  it('换到其他 URL 撤销运行期同意，不能被保存记录或宿主旧 URL 复用', async () => {
    const f = fixture(); f.policy(true); f.navigate('https://fixture.test/other'); f.elapse(); await f.runtime.tick()
    expect(f.inspect()).toMatchObject({ reloadableMode: false })
    expect(f.policy(true, 'https://fixture.test/read')).toMatchObject({ success: false })
    expect(f.save).not.toHaveBeenCalled(); expect(f.guest.loadURL).not.toHaveBeenCalled()
  })
  it('显式保持运行撤销同意，不能再进入休眠事务', async () => {
    const f = fixture(); f.policy(true); f.policy(false); f.elapse(); await f.runtime.tick()
    expect(f.entry().recovery).toEqual({ kind: 'web', url: 'https://fixture.test/read' })
    expect(f.guest.loadURL).not.toHaveBeenCalled()
  })
  it('另一个宿主不能为该页设置策略', () => {
    const f = fixture(), foreign = Object.assign(new EventEmitter(), { id: 2 }) as unknown as WebContents
    expect(f.runtime.request(foreign, { kind: 'reloadPolicy', resourceId: 'tab:a', enabled: true, url: 'https://fixture.test/read' })).toMatchObject({ success: false })
    expect(f.inspect()).toMatchObject({ reloadableMode: false })
  })
  it('冷恢复的 saved 许可可在落盘前绑定覆盖层，但不能把契约转给不同 URL', () => {
    const f = fixture(true); f.policy(true)
    f.runtime.bindTask(f.owner, 'a', 'shelf-web-a')
    expect(f.runtime.isReloadableResource(f.owner, 'shelf-web-a', 'https://fixture.test/read')).toBe(true)
    expect(f.runtime.isReloadableResource(f.owner, 'shelf-web-a', 'https://fixture.test/other')).toBe(false)
  })
})
