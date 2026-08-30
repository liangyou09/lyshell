/**
 * docZoom 状态模块测试 —— 夹取/持久化/事件广播约定（对齐终端 terminalFontSize 模式）。
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { snapDocZoom, readDocZoom, adjustDocZoom, resetDocZoom, useDocZoom, DOC_ZOOM_MIN, DOC_ZOOM_MAX } from './docZoom'

describe('snapDocZoom：夹取与百分位圆整', () => {
  it('超界夹到 [0.5, 3]', () => {
    expect(snapDocZoom(0.1)).toBe(DOC_ZOOM_MIN)
    expect(snapDocZoom(9)).toBe(DOC_ZOOM_MAX)
  })

  it('0.1 步进的浮点尾差圆整（0.30000000000000004 → 0.3）', () => {
    expect(snapDocZoom(1 + 0.1 + 0.1 + 0.1)).toBe(1.3)
  })
})

describe('readDocZoom / adjustDocZoom / resetDocZoom', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('无存储回落 1；存了就读回', () => {
    expect(readDocZoom()).toBe(1)
    localStorage.setItem('docZoom', '1.4')
    expect(readDocZoom()).toBe(1.4)
  })

  it('adjust：写存储并广播 docZoomChanged（detail=新值）', () => {
    let received = 0
    const h = (e: Event) => { received = (e as CustomEvent<number>).detail }
    window.addEventListener('docZoomChanged', h as EventListener)
    adjustDocZoom(0.1)
    expect(received).toBe(1.1)
    expect(localStorage.getItem('docZoom')).toBe('1.1')
    window.removeEventListener('docZoomChanged', h as EventListener)
  })

  it('adjust 到边界 no-op：不广播不写存储', () => {
    localStorage.setItem('docZoom', '0.5')
    const h = vi.fn()
    window.addEventListener('docZoomChanged', h)
    adjustDocZoom(-0.3)
    expect(h).not.toHaveBeenCalled()
    expect(localStorage.getItem('docZoom')).toBe('0.5')
    window.removeEventListener('docZoomChanged', h)
  })

  it('reset 回 1 并广播', () => {
    localStorage.setItem('docZoom', '2')
    let received = 0
    const h = (e: Event) => { received = (e as CustomEvent<number>).detail }
    window.addEventListener('docZoomChanged', h as EventListener)
    resetDocZoom()
    expect(received).toBe(1)
    expect(readDocZoom()).toBe(1)
    window.removeEventListener('docZoomChanged', h as EventListener)
  })
})

describe('useDocZoom：订阅事件实时更新', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('初值读存储；事件到达即更新', () => {
    localStorage.setItem('docZoom', '1.5')
    const { result } = renderHook(() => useDocZoom())
    expect(result.current).toBe(1.5)
    act(() => { window.dispatchEvent(new CustomEvent('docZoomChanged', { detail: 0.8 })) })
    expect(result.current).toBe(0.8)
  })
})
