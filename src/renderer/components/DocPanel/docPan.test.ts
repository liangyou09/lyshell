/**
 * docPan 状态模块测试 —— 全局瞬态开关 + 事件广播（不持久化）。
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { isPanMode, setPanMode, togglePanMode, usePanMode } from './docPan'

describe('setPanMode / togglePanMode：状态与广播', () => {
  beforeEach(() => {
    setPanMode(false)
  })

  it('切换触发 docPanModeChanged（detail=新值）；重复设同值不广播', () => {
    let received: boolean | null = null
    const h = (e: Event) => { received = (e as CustomEvent<boolean>).detail }
    window.addEventListener('docPanModeChanged', h)
    setPanMode(true)
    expect(received).toBe(true)
    expect(isPanMode()).toBe(true)

    received = null
    setPanMode(true) // 同值 no-op
    expect(received).toBeNull()

    togglePanMode()
    expect(received).toBe(false)
    expect(isPanMode()).toBe(false)
    window.removeEventListener('docPanModeChanged', h)
  })
})

describe('usePanMode：订阅事件实时更新', () => {
  beforeEach(() => {
    setPanMode(false)
  })

  it('事件到达即更新', () => {
    const { result } = renderHook(() => usePanMode())
    expect(result.current).toBe(false)
    act(() => { setPanMode(true) })
    expect(result.current).toBe(true)
    act(() => { togglePanMode() })
    expect(result.current).toBe(false)
  })
})
