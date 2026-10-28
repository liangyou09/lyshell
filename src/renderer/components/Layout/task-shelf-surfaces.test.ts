// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { focusShelfSurface, getShelfSurface, measureShelfSurface, refreshShelfSurfaces, registerShelfSurface, updateShelfSurfaceInteraction, useShelfKeyboardFocus } from './task-shelf-surfaces'

const releases: Array<() => void> = []
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })
function target(left = 500, top = 180) {
  const aside = document.createElement('aside'), list = document.createElement('div'), slot = document.createElement('div')
  aside.className = 'task-shelf'; list.className = 'task-shelf-list'
  aside.getBoundingClientRect = () => rect(480, 20, 500, 700)
  list.getBoundingClientRect = () => rect(490, 160, 480, 400)
  slot.getBoundingClientRect = () => rect(left, top, 460, 260)
  aside.append(list); list.append(slot); document.body.append(aside)
  return { aside, slot }
}
// 可控时钟与帧队列：模块内的刷新循环只能靠手工推帧推进，便于断言循环是否继续。
let clock = 0
let pendingFrames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
function scheduleFrame(callback: FrameRequestCallback): number {
  const id = nextFrameId++
  pendingFrames.set(id, callback)
  return id
}
function flushFrames(): void {
  const batch = [...pendingFrames]
  pendingFrames.clear()
  for (const [, callback] of batch) callback(clock)
}
const transitionEvent = (type: 'transitionrun' | 'transitionend' | 'transitioncancel', propertyName: string): Event =>
  Object.assign(new Event(type, { bubbles: true }), { propertyName })

beforeEach(() => {
  clock = 0; pendingFrames = new Map(); nextFrameId = 1
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', scheduleFrame)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pendingFrames.delete(id) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); releases.splice(0).forEach(release => release()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('原生小窗口位置和输入归属', () => {
  it('原生面隐藏或失去交互权限后释放键盘，不依赖另一次 focusin', () => {
    const { aside, slot } = target()
    releases.push(registerShelfSurface('terminal', 't', slot, true))
    const { result } = renderHook(() => useShelfKeyboardFocus())
    act(() => focusShelfSurface('terminal', 't'))
    expect(result.current).toBe('terminal:t')
    act(() => { aside.setAttribute('aria-hidden', 'true'); refreshShelfSurfaces() })
    expect(result.current).toBeNull()
    act(() => { aside.removeAttribute('aria-hidden'); refreshShelfSurfaces(); focusShelfSurface('terminal', 't') })
    expect(result.current).toBe('terminal:t')
    act(() => { releases.push(registerShelfSurface('terminal', 't', slot, false)) })
    expect(result.current).toBeNull()
  })
  it('裁掉滚动区之外的内容，零尺寸与非有限值不能露出旧矩形', () => {
    expect(measureShelfSurface(rect(500, 100, 460, 260), rect(490, 160, 480, 400))).toEqual({ visible: true, clipPath: 'inset(60px 0px 0px 0px)' })
    expect(measureShelfSurface(rect(500, 700, 460, 260), rect(490, 160, 480, 400)).visible).toBe(false)
    expect(measureShelfSurface(rect(NaN, 100, 460, 260), rect(490, 160, 480, 400)).visible).toBe(false)
  })
  it('多个原生端面独立可见，只有真正聚焦的一项认领键盘，移开焦点后释放', () => {
    const first = target(), second = target(500, 400)
    releases.push(registerShelfSurface('terminal', 't', first.slot, true), registerShelfSurface('web', 'w', second.slot, true))
    expect(getShelfSurface('terminal', 't')?.visible).toBe(true)
    expect(getShelfSurface('web', 'w')?.clipPath).toBe('inset(0px 0px 100px 0px)')
    focusShelfSurface('terminal', 't')
    expect(getShelfSurface('terminal', 't')?.active).toBe(true)
    expect(getShelfSurface('web', 'w')?.active).toBe(false)
    const input = document.createElement('input'); document.body.append(input); input.focus()
    expect(getShelfSurface('terminal', 't')?.active).toBe(false)
  })
  it('侧栏隐藏就取消输入，滚动移位会更新裁剪且保持原尺寸', () => {
    const { aside, slot } = target()
    releases.push(registerShelfSurface('web', 'w', slot, true))
    aside.setAttribute('aria-hidden', 'true'); refreshShelfSurfaces()
    expect(getShelfSurface('web', 'w')).toMatchObject({ visible: false, interactive: false })
    aside.removeAttribute('aria-hidden'); slot.getBoundingClientRect = () => rect(500, 100, 460, 260); refreshShelfSurfaces()
    expect(getShelfSurface('web', 'w')).toMatchObject({ visible: true, interactive: true, clipPath: 'inset(60px 0px 0px 0px)', rect: { width: 460, height: 260 } })
  })
  it('替换同一端面后，旧组件的迟到清理不能注销新的登记', () => {
    const first = target(), second = target(500, 300)
    const old = registerShelfSurface('web', 'w', first.slot, true)
    releases.push(old, registerShelfSurface('web', 'w', second.slot, false))
    old()
    expect(getShelfSurface('web', 'w')).toMatchObject({ rect: { top: 300 }, visible: true, interactive: false })
  })
  it('共享裁剪祖先每轮只测一次，无关控件过渡不启动几何动画循环', () => {
    const { aside, slot } = target()
    const second = slot.cloneNode() as HTMLElement
    second.getBoundingClientRect = () => rect(500, 400, 460, 260)
    slot.parentElement!.append(second)
    const asideRead = vi.spyOn(aside, 'getBoundingClientRect')
    const listRead = vi.spyOn(slot.parentElement!, 'getBoundingClientRect')
    releases.push(registerShelfSurface('terminal', 't', slot, true), registerShelfSurface('web', 'w', second, true))
    asideRead.mockClear(); listRead.mockClear()
    refreshShelfSurfaces()
    expect(asideRead).toHaveBeenCalledTimes(1)
    expect(listRead).toHaveBeenCalledTimes(1)
    const raf = vi.fn(() => 2)
    vi.stubGlobal('requestAnimationFrame', raf)
    slot.dispatchEvent(transitionEvent('transitionrun', 'background-color'))
    expect(raf).not.toHaveBeenCalled()
  })
  it('权限变化保留登记和几何，立即撤销输入归属', () => {
    const { slot } = target()
    releases.push(registerShelfSurface('terminal', 't', slot, true))
    focusShelfSurface('terminal', 't')
    const before = getShelfSurface('terminal', 't')!.rect
    updateShelfSurfaceInteraction('terminal', 't', false)
    expect(getShelfSurface('terminal', 't')).toMatchObject({ rect: before, visible: true, active: false, interactive: false })
    updateShelfSurfaceInteraction('terminal', 't', true)
    expect(getShelfSurface('terminal', 't')).toMatchObject({ rect: before, visible: true, active: false, interactive: true })
  })
})

describe('原生小窗跟随侧栏的几何过渡', () => {
  it('超过旧 220ms 上限后仍随未结束的过渡更新几何', () => {
    const { aside, slot } = target()
    releases.push(registerShelfSurface('terminal', 't', slot, true))
    flushFrames()
    slot.getBoundingClientRect = () => rect(540, 180, 420, 260)
    aside.dispatchEvent(transitionEvent('transitionrun', 'transform'))
    flushFrames()
    expect(getShelfSurface('terminal', 't')?.rect).toMatchObject({ left: 540, width: 420 })
    expect(pendingFrames.size).toBe(1)
    // 340ms 收起时长已走过 220ms 以上的后半程，仍然必须继续跟随。
    clock = 400
    slot.getBoundingClientRect = () => rect(600, 180, 380, 260)
    flushFrames()
    expect(getShelfSurface('terminal', 't')?.rect).toMatchObject({ left: 600, width: 380 })
    clock = 900
    slot.getBoundingClientRect = () => rect(640, 180, 340, 260)
    flushFrames()
    expect(getShelfSurface('terminal', 't')?.rect).toMatchObject({ left: 640, width: 340 })
    expect(pendingFrames.size).toBe(1)
  })
  it('transitionend 与 transitioncancel 都只结束对应过渡的刷新循环', () => {
    const ended = target()
    releases.push(registerShelfSurface('terminal', 't', ended.slot, true))
    flushFrames()
    ended.aside.dispatchEvent(transitionEvent('transitionrun', 'width'))
    flushFrames()
    expect(pendingFrames.size).toBe(1)
    ended.aside.dispatchEvent(transitionEvent('transitionend', 'width'))
    flushFrames()
    expect(pendingFrames.size).toBe(0)

    const cancelled = target(500, 400)
    releases.push(registerShelfSurface('web', 'w', cancelled.slot, true))
    flushFrames()
    cancelled.aside.dispatchEvent(transitionEvent('transitionrun', 'width'))
    flushFrames()
    expect(pendingFrames.size).toBe(1)
    cancelled.aside.dispatchEvent(transitionEvent('transitioncancel', 'width'))
    flushFrames()
    expect(pendingFrames.size).toBe(0)
  })
  it('重叠的 transform 与 width 分别结束，最后一个结束前不停止循环', () => {
    const { aside, slot } = target()
    releases.push(registerShelfSurface('terminal', 't', slot, true))
    flushFrames()
    aside.dispatchEvent(transitionEvent('transitionrun', 'transform'))
    aside.dispatchEvent(transitionEvent('transitionrun', 'width'))
    flushFrames()
    expect(pendingFrames.size).toBe(1)
    aside.dispatchEvent(transitionEvent('transitionend', 'width'))
    flushFrames()
    expect(pendingFrames.size).toBe(1)
    slot.getBoundingClientRect = () => rect(560, 180, 400, 260)
    flushFrames()
    expect(getShelfSurface('terminal', 't')?.rect).toMatchObject({ left: 560, width: 400 })
    expect(pendingFrames.size).toBe(1)
    aside.dispatchEvent(transitionEvent('transitionend', 'transform'))
    flushFrames()
    expect(pendingFrames.size).toBe(0)
  })
  it('注销最后一个端面清理过渡集与监听，无关过渡和子元素过渡不空转', () => {
    const { aside, slot } = target()
    const release = registerShelfSurface('terminal', 't', slot, true)
    flushFrames()
    const raf = vi.fn(() => 9)
    vi.stubGlobal('requestAnimationFrame', raf)
    aside.dispatchEvent(transitionEvent('transitionrun', 'background-color'))
    slot.dispatchEvent(transitionEvent('transitionrun', 'transform'))
    slot.parentElement!.dispatchEvent(transitionEvent('transitionrun', 'width'))
    expect(raf).not.toHaveBeenCalled()

    vi.stubGlobal('requestAnimationFrame', scheduleFrame)
    aside.dispatchEvent(transitionEvent('transitionrun', 'transform'))
    flushFrames()
    expect(pendingFrames.size).toBe(1)
    release()
    expect(pendingFrames.size).toBe(0)

    // 重新登记后不能因为残留的过渡集合继续空转；隐藏后同样不空转。
    releases.push(registerShelfSurface('terminal', 't', slot, true))
    flushFrames()
    expect(pendingFrames.size).toBe(0)
    aside.setAttribute('aria-hidden', 'true')
    refreshShelfSurfaces()
    expect(pendingFrames.size).toBe(0)
  })
})
