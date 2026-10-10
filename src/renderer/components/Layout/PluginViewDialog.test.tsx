// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import PluginViewDialog, { type PluginViewDialogSpec } from './PluginViewDialog'
import { useEscDismiss } from '@/hooks/useDismiss'

afterEach(cleanup)

const spec = (dialogId: string): PluginViewDialogSpec => ({
  pluginId: 'p1', viewId: 'dialog', dialogId,
  entryUrl: `lyshell-plugin://p1/dialog.html?dialogId=${dialogId}`
})

describe('插件弹窗宿主 Esc', () => {
  it('多个弹窗只关闭最上层，移除后下一层可继续关闭', () => {
    const closeParent = vi.fn()
    const closeChild = vi.fn()
    const { rerender } = render(<>
      <PluginViewDialog spec={spec('parent')} isTopmost={false} onClose={closeParent} />
      <PluginViewDialog spec={spec('child')} isTopmost onClose={closeChild} />
    </>)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeParent).not.toHaveBeenCalled()
    expect(closeChild).toHaveBeenCalledOnce()

    rerender(<PluginViewDialog spec={spec('parent')} isTopmost onClose={closeParent} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeParent).toHaveBeenCalledOnce()
    expect(closeChild).toHaveBeenCalledOnce()
  })

  it('输入法组合期的 Esc 只取消候选，不关闭弹窗', () => {
    const onClose = vi.fn()
    render(<PluginViewDialog spec={spec('parent')} isTopmost onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('宿主底层已有 Esc 浮层时仍先关闭插件弹窗，按键不穿透', () => {
    const closeBackground = vi.fn()
    const closeDialog = vi.fn()
    const bubbled = vi.fn()
    const Background = () => {
      useEscDismiss(true, closeBackground)
      return null
    }
    render(<>
      <Background />
      <PluginViewDialog spec={spec('dialog')} isTopmost onClose={closeDialog} />
    </>)
    window.addEventListener('keydown', bubbled)
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(closeDialog).toHaveBeenCalledOnce()
      expect(closeBackground).not.toHaveBeenCalled()
      expect(bubbled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', bubbled)
    }
  })
})
