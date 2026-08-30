// @vitest-environment jsdom
/**
 * HtmlDoc 安全属性回归守卫 —— sandbox 必须恰好是 allow-same-origin。
 * allow-scripts 一旦被追加，同源令牌立即变成宿主 DOM / preload 桥的完整
 * 逃逸面（见 HtmlDoc.tsx 文件头「安全不变量」）。严格相等断言意味着
 * sandbox 标志集的任何改动都必须有意识地同步更新本守卫。
 * jsdom 不加载 srcdoc，仅验证 DOM 属性；onLoad 导航拦截器不在此范围。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import HtmlDoc from './HtmlDoc'

afterEach(cleanup)

describe('HtmlDoc：沙箱安全属性（回归守卫）', () => {
  it('sandbox 恰为 allow-same-origin，绝无 allow-scripts', () => {
    const { container } = render(<HtmlDoc content="<p>hi</p>" title="t" />)
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})
