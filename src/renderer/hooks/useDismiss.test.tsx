// @vitest-environment jsdom
/**
 * ESC 回退栈单测 —— 后进先出 / 截停不穿透 / IME 组合期不触发 / 外点收起。
 * dismissStack 是模块级单例,栈籍的进出完全由挂载效果驱动:close 后 open=false
 * 的重渲染、组件卸载的 cleanup 都会弹栈,用例之间不残留。window 级冒泡监听当
 * 「穿透探针」:栈顶消费时它不该收到按键(截停),无栈消费时它必须收到(证明
 * 探针接线正常)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState, useRef } from 'react'
import type { FC } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useDismiss, useEscDismiss } from './useDismiss'

/** ESC 层探针:挂载即入栈,close 后置 open=false 触发出栈(对齐真实消费方形态) */
const EscProbe: FC<{ onClose: (id: string) => void }> = ({ onClose }) => {
  const [open, setOpen] = useState(true)
  useEscDismiss(open, () => { setOpen(false); onClose('esc') })
  return null
}

/** useDismiss 探针:外点收起语义,ref 内的 mousedown 不算外部 */
const DismissProbe: FC<{ onClose: () => void }> = ({ onClose }) => {
  const [open, setOpen] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => { setOpen(false); onClose() }, [ref])
  if (!open) return null
  return <div ref={ref} data-testid="dismiss-zone" />
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ESC 回退栈顺序', () => {
  it('后挂载的层先收(栈顶优先),一次 ESC 只收一层', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<>
      <EscProbe onClose={first} />
      <EscProbe onClose={second} />
    </>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    // 上层 close 后 open=false,栈籍随 effect cleanup 弹出 —— 第二下才轮到底层
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('卸载弹出栈籍:整树卸载后重挂新层,旧层不残留成「幽灵截停」', () => {
    const ghostA = vi.fn()
    const ghostB = vi.fn()
    const { unmount } = render(<>
      <EscProbe onClose={ghostA} />
      <EscProbe onClose={ghostB} />
    </>)
    unmount()
    const fresh = vi.fn()
    render(<EscProbe onClose={fresh} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(ghostA).not.toHaveBeenCalled()
    expect(ghostB).not.toHaveBeenCalled()
  })
})

describe('ESC 截停与放行', () => {
  it('栈顶消费时 stopPropagation,window 级冒泡监听收不到', () => {
    const windowSpy = vi.fn()
    window.addEventListener('keydown', windowSpy)
    const close = vi.fn()
    render(<EscProbe onClose={close} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(windowSpy).not.toHaveBeenCalled()
  })

  it('非 ESC 按键不消费也不截停', () => {
    const windowSpy = vi.fn()
    window.addEventListener('keydown', windowSpy)
    const close = vi.fn()
    render(<EscProbe onClose={close} />)
    fireEvent.keyDown(document, { key: 'a' })
    expect(close).not.toHaveBeenCalled()
    expect(windowSpy).toHaveBeenCalledTimes(1)
  })

  it('IME 组合中的 ESC 是取消候选词,不当收层键(isComposing / keyCode 229)', () => {
    const windowSpy = vi.fn()
    window.addEventListener('keydown', windowSpy)
    const close = vi.fn()
    render(<EscProbe onClose={close} />)
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 })
    expect(close).not.toHaveBeenCalled()
    // 组合期不截停,穿透照常发生
    expect(windowSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useDismiss 外点收起', () => {
  it('ref 外的 mousedown 收层', () => {
    const close = vi.fn()
    render(<DismissProbe onClose={close} />)
    fireEvent.mouseDown(document.body)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('ref 内的 mousedown 不收(浮层本体点击)', () => {
    const close = vi.fn()
    const { getByTestId } = render(<DismissProbe onClose={close} />)
    fireEvent.mouseDown(getByTestId('dismiss-zone'))
    expect(close).not.toHaveBeenCalled()
  })
})
