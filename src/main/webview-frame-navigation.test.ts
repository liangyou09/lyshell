import { describe, expect, it, vi } from 'vitest'
import { decideWebviewFrameNavigation, gateWebviewSubframeNavigation } from './webview-frame-navigation'

const handled = new Set(['bytedance', 'aweme'])

describe('webview 框架导航', () => {
  it('正常网页导航放行', () => {
    expect(decideWebviewFrameNavigation('https://www.douyin.com/user/self', true, true, handled)).toBe('allow')
    expect(decideWebviewFrameNavigation('https://example.com/frame', false, false, handled)).toBe('allow')
  })

  it('已接管的抖音心跳子框架深链仍取消导航，但不重复告警', () => {
    expect(decideWebviewFrameNavigation('bytedance://dispatch_message/', false, true, handled)).toBe('cancel-silent')
    expect(decideWebviewFrameNavigation('bytedance://dispatch_message/', true, true, handled)).toBe('cancel')
  })

  it('其他已接管深链仍取消并告警', () => {
    expect(decideWebviewFrameNavigation('bytedance://open/', false, true, handled)).toBe('cancel')
    expect(decideWebviewFrameNavigation('aweme://dispatch_message/', false, true, handled)).toBe('cancel')
    expect(decideWebviewFrameNavigation('bytedance://dispatch_message/other', false, true, handled)).toBe('cancel')
    expect(decideWebviewFrameNavigation('bytedance://dispatch_message/?unexpected=1', false, true, handled)).toBe('cancel')
    expect(decideWebviewFrameNavigation('bytedance://dispatch_message/', false, true, new Set())).toBe('cancel')
  })

  it('未接管协议和畸形 URL 均取消并告警', () => {
    expect(decideWebviewFrameNavigation('unknown://open/', false, true, handled)).toBe('cancel')
    expect(decideWebviewFrameNavigation('bytedance://dispatch_message/', false, false, handled)).toBe('cancel')
    expect(decideWebviewFrameNavigation('not a url', false, true, handled)).toBe('cancel')
  })

  it('iframe 重定向到已接管深链时取消导航且不交给主框架流程', () => {
    const event = { url: 'bytedance://dispatch_message/', isMainFrame: false, preventDefault: vi.fn() }
    const warn = vi.fn()
    expect(gateWebviewSubframeNavigation(event, true, handled, warn)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
  })

  it('iframe 未接管协议告警，正常网页重定向放行；主框架交还主导航闸', () => {
    const event = { url: 'otherapp://open/', isMainFrame: false, preventDefault: vi.fn() }
    const warn = vi.fn()
    expect(gateWebviewSubframeNavigation(event, true, handled, warn)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(event.url)

    event.url = 'https://example.com/frame'
    event.preventDefault.mockClear()
    expect(gateWebviewSubframeNavigation(event, true, handled, warn)).toBe(true)
    expect(event.preventDefault).not.toHaveBeenCalled()

    event.isMainFrame = true
    expect(gateWebviewSubframeNavigation(event, true, handled, warn)).toBe(false)
  })
})
