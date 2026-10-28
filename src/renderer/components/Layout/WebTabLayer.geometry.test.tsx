// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import WebTabLayer from './WebTabLayer'
import { usePaneStore } from '../../stores/pane-store'
import type { PaneLayout } from '@shared/types'
import '../../i18n'
import { registerShelfSurface } from './task-shelf-surfaces'
import { isShelfWebPreviewing, registerShelfWebPreview } from './task-shelf-preview-sources'
import { BROWSER_NEW_TAB_URL } from '@shared/browser-settings'

vi.mock('../Search/SearchableTab', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../CommandScreen/CommandScreen', () => ({ default: () => <div>command screen</div> }))
let resize!: () => void
const pane = (id: string, active = true): PaneLayout => ({ root: {
  id, type: 'leaf', sessions: ['terminal'], activeSessionId: 'terminal',
  overlays: [{ id: 'web-geometry', kind: 'web', active, slot: null }]
}, activePaneId: id })
const rectangle = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON() {} })
function placeholder(paneId: string, rect = rectangle(100, 30, 400, 500)): HTMLElement {
  const host = document.createElement('div')
  host.dataset.paneId = paneId
  const target = document.createElement('div')
  target.dataset.webtabPlaceholder = 'web-geometry'
  target.getBoundingClientRect = () => rect
  host.append(target); document.body.append(host)
  return target
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rectangle(0, 0, 800, 600))
  usePaneStore.setState({ layout: pane('pane-a'), overlayPayloads: { 'web-geometry': { kind: 'web', url: 'https://page.test/', title: '' } } })
})
afterEach(() => { cleanup(); document.querySelectorAll('[data-pane-id]').forEach(node => node.remove()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('网页覆盖层定位与显示原子性', () => {
  it('命令屏不登记网页需求或占用 guest 许可', () => {
    const oldApi = window.electronAPI
    const request = vi.fn().mockResolvedValue({ success: true, deepSleepSupported: false })
    window.electronAPI = { ...oldApi, shelfBrowserRequest: request }
    try {
      placeholder('pane-a')
      usePaneStore.setState({ overlayPayloads: { 'web-geometry': { kind: 'web', url: BROWSER_NEW_TAB_URL, title: '' } } })
      render(<WebTabLayer />)
      act(() => resize())
      expect(request).not.toHaveBeenCalled()
    } finally { window.electronAPI = oldApi }
  })
  it('找不到占位时不展示旧矩形，正确 pane 就位后才显示', () => {
    const { container } = render(<WebTabLayer />)
    const wrapper = container.querySelector<HTMLElement>('[data-webtab-wrapper]')!
    expect(wrapper.style.visibility).toBe('hidden')
    expect(wrapper.style.pointerEvents).toBe('none')
    placeholder('pane-a')
    act(() => resize())
    expect(wrapper.style.visibility).toBe('visible')
    expect(wrapper.style.left).toBe('100px')
    expect(wrapper.style.top).toBe('30px')
    expect(wrapper.style.width).toBe('400px')
  })
  it('跨分屏移动后旧占位不能提供坐标，guest不重挂', () => {
    placeholder('pane-a')
    const { container } = render(<WebTabLayer />)
    const wrapper = container.querySelector<HTMLElement>('[data-webtab-wrapper]')!
    const guest = wrapper.querySelector('webview')
    expect(wrapper.style.visibility).toBe('visible')
    act(() => usePaneStore.setState({ layout: pane('pane-b') }))
    expect(wrapper.style.visibility).toBe('hidden')
    placeholder('pane-b', rectangle(420, 30, 380, 500))
    act(() => resize())
    expect(wrapper.style.visibility).toBe('visible')
    expect(wrapper.style.left).toBe('420px')
    expect(wrapper.querySelector('webview')).toBe(guest)
  })
  it('零尺寸与越界矩形隐藏，恢复测位后稳定显示', () => {
    const target = placeholder('pane-a')
    const { container } = render(<WebTabLayer />)
    const wrapper = container.querySelector<HTMLElement>('[data-webtab-wrapper]')!
    target.getBoundingClientRect = () => rectangle(100, 30, 0, 0)
    act(() => resize()); expect(wrapper.style.visibility).toBe('hidden')
    target.getBoundingClientRect = () => rectangle(750, 30, 400, 500)
    act(() => resize()); expect(wrapper.style.visibility).toBe('hidden')
    target.getBoundingClientRect = () => rectangle(100, 30, 400, 500)
    act(() => resize()); expect(wrapper.style.visibility).toBe('visible')
  })
  it('去活隐藏实体但保留guest，重新激活追平位置', () => {
    placeholder('pane-a')
    const { container } = render(<WebTabLayer />)
    const wrapper = container.querySelector<HTMLElement>('[data-webtab-wrapper]')!
    const guest = wrapper.querySelector('webview')
    act(() => usePaneStore.setState({ layout: pane('pane-a', false) }))
    expect(wrapper.style.visibility).toBe('hidden')
    expect(getComputedStyle(guest!).visibility).toBe('hidden')
    act(() => usePaneStore.setState({ layout: pane('pane-a', true) }))
    expect(wrapper.style.visibility).toBe('visible')
    expect(wrapper.querySelector('webview')).toBe(guest)
  })
  it('原网页进小窗口后同一 guest 可直接交互，收起保留尺寸且召回回到主位置', () => {
    placeholder('pane-a')
    const { container } = render(<WebTabLayer />)
    const wrapper = container.querySelector<HTMLElement>('[data-webtab-wrapper]')!
    const guest = wrapper.querySelector('webview')
    const slot = document.createElement('div'); document.body.append(slot)
    slot.getBoundingClientRect = () => rectangle(500, 200, 300, 240)
    act(() => usePaneStore.setState({ layout: pane('pane-a', false) }))
    let release!: () => void
    act(() => { release = registerShelfSurface('web', 'web-geometry', slot, true) })
    expect(wrapper.style.position).toBe('fixed')
    expect(wrapper.style.left).toBe('500px')
    expect(wrapper.style.opacity).toBe('1')
    expect(wrapper.style.pointerEvents).toBe('auto')
    expect(wrapper.hasAttribute('inert')).toBe(false)
    expect(wrapper.querySelector('webview')).toBe(guest)
    act(() => release())
    expect(wrapper.style.visibility).toBe('hidden')
    expect(wrapper.style.width).toBe('300px')
    expect(wrapper.hasAttribute('inert')).toBe(true)
    act(() => usePaneStore.setState({ layout: pane('pane-a', true) }))
    expect(wrapper.style.position).toBe('absolute')
    expect(wrapper.style.left).toBe('100px')
    expect(wrapper.style.visibility).toBe('visible')
    expect(wrapper.querySelector('webview')).toBe(guest)
    slot.remove()
  })
  it('可见缩略图让后台网页透明绘制，主画布不接收输入且原实例不重挂', () => {
    placeholder('pane-a')
    const { container } = render(<WebTabLayer />)
    const wrapper = container.querySelector<HTMLElement>('[data-webtab-wrapper]')!
    const guest = wrapper.querySelector('webview')
    act(() => usePaneStore.setState({ layout: pane('pane-a', false) }))
    let release!: () => void
    act(() => { release = registerShelfWebPreview('web-geometry') })
    expect(wrapper.style.visibility).toBe('visible')
    expect(wrapper.style.opacity).toBe('0')
    expect(wrapper.style.pointerEvents).toBe('none')
    expect(wrapper.hasAttribute('inert')).toBe(true)
    expect(wrapper.querySelector('webview')).toBe(guest)
    act(() => usePaneStore.setState({ layout: pane('pane-a', true) }))
    expect(wrapper.style.opacity).toBe('1')
    expect(wrapper.style.pointerEvents).toBe('auto')
    expect(wrapper.hasAttribute('inert')).toBe(false)
    act(() => usePaneStore.setState({ layout: pane('pane-a', false) }))
    act(() => release())
    expect(wrapper.style.visibility).toBe('hidden')
    expect(isShelfWebPreviewing('web-geometry')).toBe(false)
    expect(wrapper.querySelector('webview')).toBe(guest)
  })
})
