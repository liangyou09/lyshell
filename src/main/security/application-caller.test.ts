import { EventEmitter } from 'events'
import type { WebContents, WebFrameMain } from 'electron'
import { describe, expect, it } from 'vitest'
import { ApplicationCallerRegistry } from './application-caller'

function windowFixture(id = 1) {
  const events = new EventEmitter()
  const frame = { url: 'file:///app/index.html' }
  const sender = Object.assign(events, { id, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url }) as unknown as WebContents
  return { sender, frame, events, event: { sender, senderFrame: frame as WebFrameMain } }
}

describe('主应用调用身份', () => {
  it('只接受已登记主窗口的当前主frame与精确文档地址', () => {
    const registry = new ApplicationCallerRegistry(), fixture = windowFixture()
    const revoke = registry.register(fixture.sender, fixture.frame.url)
    expect(() => registry.context(fixture.event)).toThrow('current application window')
    fixture.events.emit('did-navigate')
    expect(registry.context(fixture.event)).toMatchObject({ principalId: 'gui:1', source: 'gui' })
    expect(() => registry.context({ ...fixture.event, senderFrame: { url: fixture.frame.url } as WebFrameMain })).toThrow()
    expect(() => registry.context(windowFixture(2).event)).toThrow()
    revoke()
    expect(() => registry.context(fixture.event)).toThrow()
  })

  it('导航、崩溃和销毁撤销页面身份，不信任相同前缀地址或复用id的新对象', () => {
    const registry = new ApplicationCallerRegistry(), fixture = windowFixture()
    registry.register(fixture.sender, fixture.frame.url)
    fixture.events.emit('did-navigate')
    fixture.events.emit('did-start-navigation', {}, fixture.frame.url, false, true)
    expect(registry.isTrusted(fixture.sender)).toBe(false)
    fixture.events.emit('did-navigate')
    fixture.frame.url = 'file:///app/index.html.evil'
    expect(() => registry.context(fixture.event)).toThrow()
    fixture.frame.url = 'file:///app/index.html'
    fixture.events.emit('render-process-gone')
    expect(registry.isTrusted(fixture.sender)).toBe(false)
    fixture.events.emit('did-finish-load')
    expect(() => registry.context(windowFixture().event)).toThrow()
    fixture.events.emit('destroyed')
    expect(registry.isTrusted(fixture.sender)).toBe(false)
    expect(fixture.events.listenerCount('did-navigate')).toBe(0)
  })
})
