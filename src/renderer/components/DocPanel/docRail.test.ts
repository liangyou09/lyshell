/**
 * docRail 状态模块测试 —— 默认开/持久化/事件广播约定（对齐 docZoom 模式）。
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { readDocRailOpen, setDocRailOpen, toggleDocRail, useDocRailOpen } from './docRail'

describe('readDocRailOpen / setDocRailOpen / toggleDocRail', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('无存储默认开；仅 "0" 视为收起（历史垃圾值不误伤）', () => {
    expect(readDocRailOpen()).toBe(true)
    localStorage.setItem('docRailOpen', '0')
    expect(readDocRailOpen()).toBe(false)
    localStorage.setItem('docRailOpen', '1')
    expect(readDocRailOpen()).toBe(true)
  })

  it('set：写存储并广播 docRailOpenChanged（detail=新值）', () => {
    let received = true
    const h = (e: Event) => { received = (e as CustomEvent<boolean>).detail }
    window.addEventListener('docRailOpenChanged', h as EventListener)
    setDocRailOpen(false)
    expect(received).toBe(false)
    expect(localStorage.getItem('docRailOpen')).toBe('0')
    window.removeEventListener('docRailOpenChanged', h as EventListener)
  })

  it('toggle 翻转当前值', () => {
    toggleDocRail()
    expect(readDocRailOpen()).toBe(false)
    toggleDocRail()
    expect(readDocRailOpen()).toBe(true)
  })
})

describe('useDocRailOpen：订阅事件实时更新', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('初值读存储；事件到达即更新', () => {
    localStorage.setItem('docRailOpen', '0')
    const { result } = renderHook(() => useDocRailOpen())
    expect(result.current).toBe(false)
    act(() => { window.dispatchEvent(new CustomEvent('docRailOpenChanged', { detail: true })) })
    expect(result.current).toBe(true)
  })
})
