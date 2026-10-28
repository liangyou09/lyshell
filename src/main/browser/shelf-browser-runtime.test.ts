import { EventEmitter } from 'node:events'
import type { WebContents, WebPreferences } from 'electron'
import { describe, expect, it } from 'vitest'
import { ShelfBrowserRuntime } from './shelf-browser-runtime'

function host(id = 1) { return Object.assign(new EventEmitter(), { id }) as unknown as WebContents }
function guest(owner: WebContents, preferences: WebPreferences, id = 10) {
  return Object.assign(new EventEmitter(), { id, hostWebContents: owner, getLastWebPreferences: () => preferences }) as unknown as WebContents
}
const input = { kind: 'permit' as const, resourceId: 'tab:a', url: 'https://fixture.test/', source: 'explicitMain' as const }
function permit(runtime: ShelfBrowserRuntime, owner: WebContents) {
  const result = runtime.request(owner, input)
  if (!result.success || !result.permitId) throw new Error('Expected permit')
  return result.permitId
}
describe('保存区原生网页实例许可', () => {
  it('握手前的导航失败不会被错误文档的 dom-ready 覆盖', () => {
    const runtime = new ShelfBrowserRuntime(), owner = host(), id = permit(runtime, owner)
    const preferences = { lyshellCreatePermit: id } as WebPreferences
    runtime.willAttach(owner, preferences, input.url)
    const page = guest(owner, preferences)
    runtime.didAttach(owner, page)
    page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', input.url, true)
    page.emit('dom-ready')
    page.emit('ipc-message', {}, 'shelf-browser:attach', id)
    expect(runtime.request(owner, { kind: 'inspect', resourceId: input.resourceId })).toMatchObject({ success: true, state: 'live', restoreStatus: 'failed' })
    page.emit('destroyed')
  })
  it('相同未消费请求复用许可，附着只消费一次，拒绝跨窗口和第二个实体', () => {
    const runtime = new ShelfBrowserRuntime(), owner = host()
    const id = permit(runtime, owner)
    expect(permit(runtime, owner)).toBe(id)
    const wrong = { lyshellCreatePermit: id } as WebPreferences
    expect(runtime.willAttach(host(2), wrong, input.url)).toBe(false)
    const preferences = { lyshellCreatePermit: id, additionalArguments: ['--lyshell-shelf-permit=forged'] } as WebPreferences
    expect(runtime.willAttach(owner, preferences, input.url)).toBe(true)
    expect(preferences).not.toHaveProperty('lyshellCreatePermit')
    expect(preferences.additionalArguments).toEqual([`--lyshell-shelf-permit=${id}`])
    expect(runtime.willAttach(owner, { lyshellCreatePermit: id } as WebPreferences, input.url)).toBe(false)
    runtime.didAttach(owner, guest(host(3), preferences))
    expect(runtime.lifecycle.stats().instances).toBe(0)
    const page = guest(owner, preferences)
    runtime.didAttach(owner, page)
    page.emit('ipc-message', {}, 'shelf-browser:attach', id)
    expect(runtime.lifecycle.stats().instances).toBe(1)
    expect(runtime.request(owner, input).success).toBe(false)
  })
  it('保存记录别名复用活实例，主区需求优先，销毁证据到达后才可换代', () => {
    const runtime = new ShelfBrowserRuntime(), owner = host(), id = permit(runtime, owner)
    const preferences = { lyshellCreatePermit: id } as WebPreferences
    runtime.willAttach(owner, preferences, input.url)
    const page = guest(owner, preferences)
    runtime.didAttach(owner, page)
    page.emit('ipc-message', {}, 'shelf-browser:attach', id)
    runtime.bindTask(owner, 'saved-a', 'a')
    expect(runtime.request(owner, { ...input, resourceId: 'saved:saved-a', taskId: 'saved-a' }).success).toBe(false)
    runtime.request(owner, { kind: 'demand', resourceId: 'tab:a', main: true, shelf: true })
    const result = runtime.request(owner, { kind: 'inspect', resourceId: 'tab:a' })
    expect(result).toMatchObject({ success: true, state: 'live', presentationOwner: 'main', deepSleepSupported: false })
    page.emit('destroyed')
    expect(runtime.lifecycle.stats().resources).toBe(0)
    expect(permit(runtime, owner)).not.toBe(id)
    owner.emit('destroyed')
    expect(runtime.lifecycle.stats().resources).toBe(0)
  })
})
