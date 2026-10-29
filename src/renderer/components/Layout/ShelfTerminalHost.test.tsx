// @vitest-environment jsdom
/**
 * 任务架迷你终端宿主（ShelfTerminalHost）回归：
 * 同一个 TerminalView 实例必须始终挂在这一个 DOM 位置上 —— 主分屏 ↔ 侧栏迷你 ↔
 * 侧栏收起 往返还是一次挂载，不重建 xterm/PTY/输出订阅。
 *
 * 覆盖：
 *  - 主视图可见时：absolute inset0 + visible + z1，不挂 data-shelf-native
 *    （主视图的可见性由父级 PaneView 决定，注册表里残留的迷你矩形一律不作数）
 *  - 迷你态：用 registry 快照经真实 shelfSurfaceStyle 贴几何（fixed/left/top/
 *    width/height/zIndex），可见可交互时才挂 marker 并传 shelfHost 交互额度
 *  - 迷你态但不可见 / 未登记可交互：隐藏 + pointer-events:none + inert，
 *    既不挂 marker 也不认领焦点
 *  - 登记注销而主视图仍不可见：沿用最后一帧迷你几何并保持隐藏/inert
 *  - 只有交互态才认领焦点（focusShelfSurface）与通报悬停进出
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { ShelfSurfaceSnapshot } from './task-shelf-surfaces'
import ShelfTerminalHost from './ShelfTerminalHost'

const h = vi.hoisted(() => ({
  surface: { current: null as ShelfSurfaceSnapshot | null },
  focus: vi.fn(),
  leave: vi.fn(),
  listeners: new Set<() => void>(),
  mounts: { current: 0 }
}))

// 只替换 registry 的读口与副作用口，shelfSurfaceStyle 保留真实实现：
// 迷你几何的换算正是被测行为，不能一起打桩。
vi.mock('./task-shelf-surfaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-shelf-surfaces')>()
  return {
    ...actual,
    getShelfSurface: () => h.surface.current,
    useShelfSurfaceMode: () => h.surface.current ? 1 : 0,
    subscribeShelfSurfaces: (listener: () => void) => { h.listeners.add(listener); return () => { h.listeners.delete(listener) } },
    focusShelfSurface: (...args: unknown[]) => h.focus(...args),
    leaveShelfSurface: () => h.leave()
  }
})

// 终端本体打桩：本测试关心宿主容器与传给终端的交互额度，xterm 由 TerminalView 自己的测试覆盖。
vi.mock('../Terminal/TerminalView', async () => {
  const React = await import('react')
  const MockTerminalView = ({
    sessionId,
    shelfHost
  }: {
    sessionId: string
    shelfHost?: { active: boolean; interactive: boolean }
  }) => {
    React.useEffect(() => {
      h.mounts.current += 1
      return () => {
        h.mounts.current -= 1
      }
    }, [])
    return React.createElement('div', {
      'data-testid': 'terminal-view',
      'data-session-id': sessionId,
      'data-shelf-host': shelfHost ? `${shelfHost.active}:${shelfHost.interactive}` : 'none'
    })
  }
  return { default: MockTerminalView }
})

const RECT = { left: 1200, top: 240, width: 320, height: 200 }

function snapshot(over: Partial<ShelfSurfaceSnapshot> = {}): ShelfSurfaceSnapshot {
  return {
    rect: RECT,
    clipPath: 'inset(0px 0px 0px 0px)',
    visible: true,
    interactive: true,
    active: true,
    ...over
  }
}

function hostOf(container: HTMLElement): HTMLElement {
  const host = container.firstElementChild
  if (!(host instanceof HTMLElement)) throw new Error('host element missing')
  return host
}

beforeEach(() => {
  h.surface.current = null
  h.focus.mockClear()
  h.leave.mockClear()
  h.mounts.current = 0
  h.listeners.clear()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => cleanup())

describe('ShelfTerminalHost', () => {
  it('首次挂载且小窗矩形未就绪时，主区占位完全透明、裁空且 inert', () => {
    h.surface.current = null
    const { container, rerender } = render(<ShelfTerminalHost sessionId="s1" mainVisible={false} />)
    const host = hostOf(container)
    expect(host.style.visibility).toBe('hidden')
    expect(host.style.opacity).toBe('0')
    expect(host.style.clipPath).toBe('inset(100%)')
    expect(host.hasAttribute('inert')).toBe(true)
    h.surface.current = snapshot()
    h.listeners.forEach(listener => listener())
    rerender(<ShelfTerminalHost sessionId="s1" mainVisible={false} />)
    expect(host.style.position).toBe('fixed')
    expect(host.style.left).toBe('1200px')
    expect(host.style.width).toBe('320px')
    expect(host.style.opacity).toBe('1')
    expect(h.mounts.current).toBe(1)
  })
  it('没有有效矩形的可见标记不能把终端露到默认坐标', () => {
    h.surface.current = snapshot({ rect: null })
    const { container } = render(<ShelfTerminalHost sessionId="s1" mainVisible={false} />)
    const host = hostOf(container)
    expect(host.style.opacity).toBe('0')
    expect(host.style.visibility).toBe('hidden')
    expect(host.style.clipPath).toBe('inset(100%)')
    expect(host.hasAttribute('data-shelf-native')).toBe(false)
    expect(host.hasAttribute('inert')).toBe(true)
  })
  it('矩形订阅当帧追平位置，注销后保留最新尺寸', () => {
    h.surface.current = snapshot()
    const { container, rerender } = render(<ShelfTerminalHost sessionId="s1" mainVisible={false} />)
    const host = hostOf(container)
    h.surface.current = snapshot({ rect: { left: 900, top: 100, width: 500, height: 280 } })
    h.listeners.forEach(listener => listener())
    expect(host.style.left).toBe('900px')
    expect(host.style.width).toBe('500px')
    h.surface.current = null
    h.listeners.forEach(listener => listener())
    rerender(<ShelfTerminalHost sessionId="s1" mainVisible={false} />)
    expect(host.style.width).toBe('500px')
    expect(host.style.visibility).toBe('hidden')
    expect(h.mounts.current).toBe(1)
  })
  it('主视图可见：absolute inset0 + visible + z1，不挂迷你标记', () => {
    h.surface.current = snapshot()
    const { container } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible />)
    const host = hostOf(container)

    expect(host.className).toBe('absolute inset-0')
    expect(host.style.position).toBe('absolute')
    expect(host.style.visibility).toBe('visible')
    expect(host.style.zIndex).toBe('1')
    expect(host.getAttribute('style')).toContain('inset')
    expect(host.hasAttribute('data-shelf-native')).toBe(false)
    expect(host.hasAttribute('inert')).toBe(false)
    // 主视图由分屏决定键盘归属，不给终端传迷你额度
    expect(container.querySelector('[data-shelf-host]')?.getAttribute('data-shelf-host')).toBe('none')
  })

  it('迷你态：贴 registry 登记的矩形，挂 marker 并传交互额度', () => {
    h.surface.current = snapshot()
    const { container } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)

    expect(host.className).toBe('shelf-terminal-host')
    expect(host.style.position).toBe('fixed')
    expect(host.style.left).toBe('1200px')
    expect(host.style.top).toBe('240px')
    expect(host.style.width).toBe('320px')
    expect(host.style.height).toBe('200px')
    expect(host.style.zIndex).toBe('46')
    expect(host.style.visibility).toBe('visible')
    expect(host.style.pointerEvents).toBe('auto')
    expect(host.style.clipPath).toBe('inset(0px 0px 0px 0px)')
    expect(host.hasAttribute('data-shelf-native')).toBe(true)
    expect(host.hasAttribute('inert')).toBe(false)
    expect(container.querySelector('[data-shelf-host]')?.getAttribute('data-shelf-host')).toBe('true:true')
  })

  it('迷你态但登记为不可见：隐藏、不挂 marker、inert 且不认领焦点', () => {
    h.surface.current = snapshot({ visible: false, interactive: false, active: false })
    const { container } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)

    expect(host.style.visibility).toBe('hidden')
    expect(host.style.pointerEvents).toBe('none')
    expect(host.style.clipPath).toBe('inset(100%)')
    expect(host.hasAttribute('data-shelf-native')).toBe(false)
    expect(host.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('[data-shelf-host]')?.getAttribute('data-shelf-host')).toBe('false:false')

    fireEvent.mouseDown(host)
    fireEvent.focus(host)
    expect(h.focus).not.toHaveBeenCalled()
  })

  it('迷你态可见但不可交互：仍然 inert，键盘额度为 false', () => {
    h.surface.current = snapshot({ interactive: false })
    const { container } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)

    expect(host.hasAttribute('data-shelf-native')).toBe(true)
    expect(host.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('[data-shelf-host]')?.getAttribute('data-shelf-host')).toBe('true:false')
  })

  it('主视图可见压过残留的迷你登记', () => {
    h.surface.current = snapshot()
    const { container, rerender } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)
    expect(host.style.position).toBe('fixed')

    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible />)
    expect(hostOf(container)).toBe(host)
    expect(host.style.position).toBe('absolute')
    expect(host.style.visibility).toBe('visible')
    expect(host.style.zIndex).toBe('1')
    expect(host.hasAttribute('data-shelf-native')).toBe(false)
    expect(host.hasAttribute('inert')).toBe(false)
    expect(container.querySelector('[data-shelf-host]')?.getAttribute('data-shelf-host')).toBe('none')
  })

  it('登记注销而主视图仍不可见：保留最后一帧几何，隐藏并 inert', () => {
    h.surface.current = snapshot()
    const { container, rerender } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)

    h.surface.current = null
    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)

    // 几何沿用，避免回落成大尺寸触发一次 ConPTY 整屏重印
    expect(host.style.position).toBe('fixed')
    expect(host.style.left).toBe('1200px')
    expect(host.style.top).toBe('240px')
    expect(host.style.width).toBe('320px')
    expect(host.style.height).toBe('200px')
    expect(host.style.visibility).toBe('hidden')
    expect(host.style.pointerEvents).toBe('none')
    expect(host.style.clipPath).toBe('inset(100%)')
    expect(host.hasAttribute('data-shelf-native')).toBe(false)
    expect(host.hasAttribute('inert')).toBe(true)
    // 最后一帧的 active 原样留着（它只在 interactive 为真时才影响键盘归属），键盘额度必须是 false
    expect(container.querySelector('[data-shelf-host]')?.getAttribute('data-shelf-host')).toBe('true:false')

    // 主视图恢复后清掉残留几何
    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible />)
    expect(host.style.position).toBe('absolute')
    expect(host.style.visibility).toBe('visible')
    expect(host.hasAttribute('inert')).toBe(false)

    h.surface.current = null
    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    expect(host.style.visibility).toBe('hidden')
  })

  it('主分屏 → 迷你 → 收起 → 主分屏 全程只挂载一次终端，且只有一个终端节点', () => {
    h.surface.current = snapshot()
    const { container, rerender } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible />)
    expect(h.mounts.current).toBe(1)

    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    expect(h.mounts.current).toBe(1)

    h.surface.current = null
    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    expect(h.mounts.current).toBe(1)

    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible />)
    expect(h.mounts.current).toBe(1)

    expect(container.querySelectorAll('[data-testid="terminal-view"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-session-id="s1"]')).toHaveLength(1)
  })

  it('交互态点击/聚焦认领该面；悬停进出通报 registry', () => {
    h.surface.current = snapshot()
    const { container } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)

    fireEvent.mouseDown(host)
    expect(h.focus).toHaveBeenCalledWith('terminal', 's1')

    h.focus.mockClear()
    fireEvent.focus(host)
    expect(h.focus).toHaveBeenCalledWith('terminal', 's1')

    let entered = 0
    const onEnter = () => { entered += 1 }
    window.addEventListener('task-shelf:surface-enter', onEnter)
    fireEvent.mouseEnter(host)
    expect(entered).toBe(1)
    fireEvent.mouseLeave(host)
    expect(h.leave).toHaveBeenCalledTimes(1)
    window.removeEventListener('task-shelf:surface-enter', onEnter)
  })

  it('不可交互时点击与悬停都不越权', () => {
    h.surface.current = snapshot({ interactive: false })
    const { container } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" mainVisible={false} />)
    const host = hostOf(container)

    let entered = 0
    const onEnter = () => { entered += 1 }
    window.addEventListener('task-shelf:surface-enter', onEnter)
    fireEvent.mouseDown(host)
    fireEvent.focus(host)
    fireEvent.mouseEnter(host)
    fireEvent.mouseLeave(host)
    window.removeEventListener('task-shelf:surface-enter', onEnter)

    expect(h.focus).not.toHaveBeenCalled()
    expect(entered).toBe(0)
    expect(h.leave).not.toHaveBeenCalled()
  })

  it('mainVisible 与任务书里的 visible 等价', () => {
    h.surface.current = snapshot()
    const { container, rerender } = render(<ShelfTerminalHost sessionId="s1" paneId="p1" visible />)
    const host = hostOf(container)
    expect(host.style.position).toBe('absolute')
    expect(host.hasAttribute('data-shelf-native')).toBe(false)

    rerender(<ShelfTerminalHost sessionId="s1" paneId="p1" visible={false} />)
    expect(host.style.position).toBe('fixed')
    expect(host.hasAttribute('data-shelf-native')).toBe(true)
  })
})
