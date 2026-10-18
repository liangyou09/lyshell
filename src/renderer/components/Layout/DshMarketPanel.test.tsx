// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { DshMarketResult } from '@shared/dsh-market'
import DshMarketPanel from './DshMarketPanel'

const locale = vi.hoisted(() => ({ language: 'zh', zh: (key: string) => `zh:${key}`, en: (key: string) => `en:${key}` }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: locale.language === 'en' ? locale.en : locale.zh }) }))
vi.mock('./PanelHeader', () => ({ PanelHeader: ({ actions }: { actions?: ReactNode }) => <header>{actions}</header> }))

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  vi.unstubAllGlobals()
  locale.language = 'zh'
})

describe('市场连接生命周期', () => {
  it('忽略未就绪 guest 的同步异常，颜色请求按最新结果生效且重连清空旧表面', async () => {
    vi.stubGlobal('electronAPI', { requestDshMarket: vi.fn().mockResolvedValue({ success: true, url: 'http://127.0.0.1:1234/' }) })
    const view = render(<DshMarketPanel onOpenWeb={vi.fn()} />)
    await act(async () => {})
    const guest = view.container.querySelector('webview')! as HTMLElement & { executeJavaScript: () => unknown }
    guest.executeJavaScript = vi.fn(() => { throw new Error('guest not ready') })
    await act(async () => { guest.dispatchEvent(new Event('did-stop-loading')) })
    expect(view.container.querySelector('section')!.style.getPropertyValue('--dsh-market-surface')).toBe('')
    let resolveOld!: (surface: { background: string; color: string }) => void
    guest.executeJavaScript = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ background: 'rgb(20, 30, 40)', color: 'rgb(250, 250, 250)' })
    await act(async () => {
      guest.dispatchEvent(new Event('dom-ready'))
      guest.dispatchEvent(new Event('did-stop-loading'))
    })
    await act(async () => { resolveOld({ background: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' }) })
    expect(view.container.querySelector('section')!.style.getPropertyValue('--dsh-market-surface')).toBe('rgb(20, 30, 40)')
    await act(async () => { view.getByRole('button', { name: /dshMarket.reconnect/ }).click() })
    expect(view.container.querySelector('section')!.style.getPropertyValue('--dsh-market-surface')).toBe('')
  })

  it('语言切换后丢弃旧 effect 的在途颜色读取', async () => {
    vi.stubGlobal('electronAPI', { requestDshMarket: vi.fn().mockResolvedValue({ success: true, url: 'http://127.0.0.1:1234/' }) })
    const props = { onOpenWeb: vi.fn() }
    const view = render(<DshMarketPanel {...props} />)
    await act(async () => {})
    const guest = view.container.querySelector('webview')! as HTMLElement & { executeJavaScript: () => unknown }
    let resolve!: (surface: { background: string; color: string }) => void
    guest.executeJavaScript = vi.fn(() => new Promise(done => { resolve = done }))
    await act(async () => { guest.dispatchEvent(new Event('dom-ready')) })
    locale.language = 'en'
    view.rerender(<DshMarketPanel {...props} />)
    await act(async () => { resolve({ background: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' }) })
    expect(view.container.querySelector('section')!.style.getPropertyValue('--dsh-market-surface')).toBe('')
  })

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
