import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { requestCancellableGuestClose } from './shelf-cancellable-close'
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture() {
  const guest = new EventEmitter() as EventEmitter & { getURL: () => string; isDestroyed: () => boolean; isLoadingMainFrame: () => boolean; loadURL: ReturnType<typeof vi.fn<[], Promise<void>>>; close: ReturnType<typeof vi.fn> }
  let url = 'https://fixture.test/read'
  let resolve!: () => void, reject!: () => void
  const navigation = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('ERR_ABORTED')) })
  guest.getURL = () => url
  guest.isDestroyed = () => false
  guest.isLoadingMainFrame = () => false
  guest.loadURL = vi.fn(() => navigation)
  guest.close = vi.fn()
  const callbacks = { isCurrent: vi.fn(() => true), refused: vi.fn(), unconfirmed: vi.fn() }
  const start = () => requestCancellableGuestClose(guest as unknown as WebContents, callbacks)
  const commit = () => { url = 'about:blank'; guest.emit('did-navigate', {}, url); resolve() }
  return { guest, callbacks, start, commit, resolve, reject }
}

describe('先受保护导航再关闭确切 guest', () => {
  it('卸载拒绝时不 preventDefault、不关闭，保留 guest', async () => {
    const f = fixture(); f.start()
    const event = { preventDefault: vi.fn() }
    f.guest.emit('will-prevent-unload', event); f.reject()
    await settle()
    expect(f.callbacks.refused).toHaveBeenCalledOnce()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(f.guest.close).not.toHaveBeenCalled()
    expect(f.guest.getURL()).toBe('https://fixture.test/read')
  })
  it('导航 Promise 完成但没有对应空白提交不能关闭', async () => {
    const f = fixture(); f.start(); f.resolve(); await settle()
    expect(f.callbacks.unconfirmed).toHaveBeenCalledOnce()
    expect(f.guest.close).not.toHaveBeenCalled()
  })
  it('空白提交后只请求关闭原 guest 一次', async () => {
    const f = fixture(); f.start(); f.commit(); await settle()
    expect(f.guest.close).toHaveBeenCalledOnce()
    expect(f.guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: true })
    f.guest.emit('destroyed')
    expect(f.guest.listenerCount('did-navigate')).toBe(0)
  })
  it('事务过代时不能开始导航或关闭', () => {
    const f = fixture(); f.callbacks.isCurrent.mockReturnValue(false); f.start()
    expect(f.guest.loadURL).not.toHaveBeenCalled()
    expect(f.guest.close).not.toHaveBeenCalled()
  })
  it('空白提交期间事务失去归属时保留未确认句柄', async () => {
    const f = fixture(); f.start(); f.callbacks.isCurrent.mockReturnValue(false); f.commit(); await settle()
    expect(f.guest.close).not.toHaveBeenCalled()
    expect(f.callbacks.unconfirmed).toHaveBeenCalledOnce()
  })
  it('导航明确中止后不销毁原页面', async () => {
    const f = fixture(); f.start(); f.reject(); await settle()
    expect(f.callbacks.refused).toHaveBeenCalledOnce()
    expect(f.guest.close).not.toHaveBeenCalled()
  })
})
