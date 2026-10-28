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
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => { cleanup(); releases.splice(0).forEach(release => release()); document.body.replaceChildren(); vi.unstubAllGlobals() })

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
    const transition = Object.assign(new Event('transitionrun', { bubbles: true }), { propertyName: 'background-color' })
    slot.dispatchEvent(transition)
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
