// @vitest-environment jsdom
/**
 * 网页页签控制层测试 —— webview 注册表 + 「活动网页页签」解析与操作落点。
 *
 * 控制层是 WebPanel 按钮 / 宿主快捷键 / 主进程 IPC 转发三方共用的唯一指令通道，
 * 这里锁住三件事：
 * 1) activeWebTabId 只认「活动 pane 的活动 web 覆盖层」（终端/doc/dsh 活动时为 null）；
 * 2) 各操作落点为注册表里该页签的 webview 元素，方法与参数正确；
 * 3) 守卫语义：非法 URL 返回 false；无活动页签/未注册实例静默 no-op 不抛错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import type { OverlayPayload, OverlayRef, PaneLayout } from '@shared/types'
import { usePaneStore } from '../../stores/pane-store'
import {
  registerWebview, unregisterWebview,
  activeWebTabId, navigateActiveWebTab, reloadActiveWebTab, stopActiveWebTab,
  activeWebTabGoBack, activeWebTabGoForward
} from './web-tab-controls'

const webRef = (active: boolean): OverlayRef => ({ id: 'web-1', kind: 'web', active, slot: null })
const docRef = (active: boolean): OverlayRef => ({ id: 'doc-1', kind: 'doc', active, slot: null })

const setLayout = (overlays: OverlayRef[], payloads: Record<string, OverlayPayload>): void => {
  usePaneStore.setState({
    layout: {
      root: { id: 'pane-1', type: 'leaf', sessions: [], activeSessionId: null, overlays },
      activePaneId: 'pane-1'
    } satisfies PaneLayout,
    overlayPayloads: payloads,
    draggingOverlayId: null,
    hiddenTabSessions: {}
  })
}

const webTabActive = (): void =>
  setLayout([webRef(false), webRef(true)], {
    'web-1': { kind: 'web', url: 'https://example.com/', title: 'example' },
    'doc-1': { kind: 'doc' } as OverlayPayload
  })

const makeWebview = (): { loadURL: ReturnType<typeof vi.fn>; goBack: ReturnType<typeof vi.fn>; goForward: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>; reloadIgnoringCache: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => ({
  loadURL: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  reloadIgnoringCache: vi.fn(),
  stop: vi.fn()
})

describe('activeWebTabId：活动网页页签解析', () => {
  beforeEach(() => { unregisterWebview('web-1') })

  it('活动 pane 的活动覆盖层是 web → 返回其 id', () => {
    webTabActive()
    expect(activeWebTabId()).toBe('web-1')
  })

  it('活动覆盖层是 doc → null（浏览器态判定不认其他种类）', () => {
    setLayout([webRef(false), docRef(true)], {
      'web-1': { kind: 'web', url: 'https://example.com/', title: 'example' },
      'doc-1': { kind: 'doc' } as OverlayPayload
    })
    expect(activeWebTabId()).toBeNull()
  })

  it('无活动覆盖层（终端可见）→ null', () => {
    setLayout([webRef(false)], {
      'web-1': { kind: 'web', url: 'https://example.com/', title: 'example' }
    })
    expect(activeWebTabId()).toBeNull()
  })
})

describe('控制操作：落点与守卫', () => {
  beforeEach(() => { unregisterWebview('web-1') })

  it('navigateActiveWebTab：合法 URL 归一化后 loadURL 到活动页签', () => {
    webTabActive()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    expect(navigateActiveWebTab('example.com/path')).toBe(true)
    expect(el.loadURL).toHaveBeenCalledWith('https://example.com/path')
  })

  it('navigateActiveWebTab：非 http/https URL 返回 false 且不调用', () => {
    webTabActive()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    expect(navigateActiveWebTab('ftp://example.com/')).toBe(false)
    expect(el.loadURL).not.toHaveBeenCalled()
  })

  it('navigateActiveWebTab：无活动网页页签按已导航返回 true 且不调用（挂载竞态语义）', () => {
    setLayout([webRef(false)], {
      'web-1': { kind: 'web', url: 'https://example.com/', title: 'example' }
    })
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    expect(navigateActiveWebTab('https://example.com/')).toBe(true)
    expect(el.loadURL).not.toHaveBeenCalled()
  })

  it('reloadActiveWebTab：hard 分派 reloadIgnoringCache，普通分派 reload', () => {
    webTabActive()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    reloadActiveWebTab(false)
    expect(el.reload).toHaveBeenCalledTimes(1)
    reloadActiveWebTab(true)
    expect(el.reloadIgnoringCache).toHaveBeenCalledTimes(1)
  })

  it('stop / goBack / goForward 落到活动页签', () => {
    webTabActive()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    stopActiveWebTab()
    activeWebTabGoBack()
    activeWebTabGoForward()
    expect(el.stop).toHaveBeenCalledTimes(1)
    expect(el.goBack).toHaveBeenCalledTimes(1)
    expect(el.goForward).toHaveBeenCalledTimes(1)
  })

  it('活动 id 存在但 webview 未注册（挂载竞态）→ 静默 no-op 不抛错', () => {
    webTabActive()
    expect(() => {
      reloadActiveWebTab(false)
      stopActiveWebTab()
      activeWebTabGoBack()
      activeWebTabGoForward()
    }).not.toThrow()
  })

  it('无活动网页页签 → 全部 no-op', () => {
    setLayout([webRef(false)], {
      'web-1': { kind: 'web', url: 'https://example.com/', title: 'example' }
    })
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    reloadActiveWebTab(false)
    stopActiveWebTab()
    activeWebTabGoBack()
    activeWebTabGoForward()
    expect(el.reload).not.toHaveBeenCalled()
    expect(el.stop).not.toHaveBeenCalled()
    expect(el.goBack).not.toHaveBeenCalled()
    expect(el.goForward).not.toHaveBeenCalled()
  })
})
