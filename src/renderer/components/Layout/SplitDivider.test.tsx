// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { PaneLeaf, PaneSplit, SplitDirection } from '@shared/types'
import { usePaneStore } from '../../stores/pane-store'
import SplitDivider from './SplitDivider'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const frame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)) })

const leaf = (id: string): PaneLeaf => ({
  id, type: 'leaf', sessions: [], activeSessionId: null, overlays: []
})

// jsdom 不提供 PointerEvent，显式携带真实拖拽需要的坐标和指针字段。
const pointer = (element: Element, type: string, x: number, y: number): void => {
  fireEvent(element, Object.assign(new Event(type, { bubbles: true }), {
    pointerId: 1, clientX: x, clientY: y
  }))
}

const setup = (direction: SplitDirection, nested = false): HTMLElement => {
  const split: PaneSplit = {
    id: 'split', type: 'split', direction, splitRatio: 0.5,
    firstChild: leaf('first'), secondChild: leaf('second')
  }
  usePaneStore.setState({ layout: {
    root: nested ? {
      id: 'root', type: 'split', direction, splitRatio: 0.5,
      firstChild: split, secondChild: leaf('third')
    } : split,
    activePaneId: 'first'
  } })
  const { container } = render(<div><SplitDivider paneId="split" direction={direction} /></div>)
  const parent = container.firstElementChild as HTMLElement
  vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 500 } as DOMRect)
  const divider = parent.firstElementChild as HTMLElement
  Object.assign(divider, { setPointerCapture: vi.fn() })
  return divider
}

const ratio = (): number => {
  const pane = usePaneStore.getState().getPaneById('split')
  if (pane?.type !== 'split') throw new Error('测试分屏不存在')
  return pane.splitRatio
}

describe.each<SplitDirection>(['horizontal', 'vertical'])('分屏拖拽：%s', direction => {
  it.each([false, true])('按容器尺寸调整比例（嵌套=%s），释放后停止调整', nested => {
    const divider = setup(direction, nested)
    // 未按下时不改变比例。
    pointer(divider, 'pointermove', 300, 200)
    expect(ratio()).toBe(0.5)
    pointer(divider, 'pointerdown', 100, 100)
    expect(divider.setPointerCapture).toHaveBeenCalledWith(1)
    pointer(divider, 'pointermove', 300, 200)
    expect(ratio()).toBe(0.5)
    frame()
    expect(ratio()).toBeCloseTo(0.7)
    pointer(divider, 'pointerup', 300, 200)
    pointer(divider, 'pointermove', 400, 300)
    expect(ratio()).toBeCloseTo(0.7)
  })

  it('两分屏拖到边界时保留两侧最小比例', () => {
    const divider = setup(direction)
    pointer(divider, 'pointerdown', 100, 100)
    pointer(divider, 'pointermove', 2000, 2000)
    frame()
    expect(ratio()).toBe(0.9)
    pointer(divider, 'pointermove', -2000, -2000)
    frame()
    expect(ratio()).toBe(0.1)
  })
  it('一帧仅提交最新位置，丢失捕获也保留最后位移，卸载撤销未执行更新', () => {
    const divider = setup(direction)
    pointer(divider, 'pointerdown', 100, 100)
    pointer(divider, 'pointermove', 150, 125)
    pointer(divider, 'pointermove', 300, 200)
    expect(frames.size).toBe(1)
    expect(ratio()).toBe(0.5)
    pointer(divider, 'lostpointercapture', 300, 200)
    expect(ratio()).toBeCloseTo(0.7)
    expect(frames.size).toBe(0)
    pointer(divider, 'pointerdown', 300, 200)
    pointer(divider, 'pointermove', 400, 250)
    cleanup(); frame()
    expect(ratio()).toBeCloseTo(0.7)
  })
})
