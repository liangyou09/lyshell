// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { DshMarketResult } from '@shared/dsh-market'
import DshMarketPanel from './DshMarketPanel'

const locale = vi.hoisted(() => ({ language: 'zh' }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `${locale.language}:${key}` }) }))
vi.mock('./PanelHeader', () => ({ PanelHeader: () => <header /> }))

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  vi.unstubAllGlobals()
})

describe('市场连接生命周期', () => {
  it('语言切换保留 guest 和租约，真实卸载才释放', async () => {
    const request = vi.fn().mockResolvedValue({ success: true, url: 'http://127.0.0.1:1234/?lyshellView=market' })
    vi.stubGlobal('electronAPI', { requestDshMarket: request })
    const props = { onOpenWeb: vi.fn() }
    const view = render(<DshMarketPanel {...props} />)
    await act(async () => {})
    const guest = view.container.querySelector('webview')
    expect(guest).toBeTruthy()
    locale.language = 'en'
    view.rerender(<DshMarketPanel {...props} />)
    await act(async () => {})
    expect(view.container.querySelector('webview')).toBe(guest)
    expect(request.mock.calls).toEqual([['open']])
    view.unmount()
    await Promise.resolve()
    expect(request.mock.calls).toEqual([['open'], ['release']])
  })

  it('StrictMode 重挂不释放在途请求，忽略子框架加载失败', async () => {
    let finish!: (result: DshMarketResult) => void
    const request = vi.fn(() => new Promise<DshMarketResult>(resolve => { finish = resolve }))
    vi.stubGlobal('electronAPI', { requestDshMarket: request })
    const view = render(<StrictMode><DshMarketPanel onOpenWeb={vi.fn()} /></StrictMode>)
    await act(async () => { finish({ success: true, url: 'http://127.0.0.1:1234/' }) })
    expect(request.mock.calls).toEqual([['open']])
    const guest = view.container.querySelector('webview')!
    await act(async () => {
      guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -105, isMainFrame: false }))
    })
    expect(view.queryByRole('alert')).toBeNull()
    await act(async () => {
      guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -105, isMainFrame: true }))
    })
    expect(view.queryByRole('alert')).toBeTruthy()
  })
})
