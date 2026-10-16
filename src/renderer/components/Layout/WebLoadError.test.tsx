// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import WebLoadError from './WebLoadError'
import '../../i18n'
afterEach(cleanup)
const failure = { url: 'https://10.5.20.36:8072/', code: -202, description: 'ERR_CERT_AUTHORITY_INVALID' }
const certificate = { certificateId: 'actual-failure', origin: 'https://10.5.20.36:8072', error: failure.description, subject: 'VENUS', issuer: 'VENUS', validFrom: '2024', validTo: '2034', fingerprint: 'AA:BB' }
function api(result: object) {
  const request = vi.fn().mockImplementation(async request => request.kind === 'certificateInfo' ? { success: true, certificate } : result)
  Object.assign(window, { electronAPI: { browserRequest: request } }); return request
}
async function advanced() {
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
  await screen.findByRole('button', { name: 'Proceed to 10.5.20.36:8072 (unsafe)' })
}
describe('浏览器风格证书拦截页', () => {
  it('继续入口默认隐藏；展开高级后核对证书再显式放行，无第二个弹窗', async () => {
    const request = api({ success: true, certificateTrusted: true }); const retry = vi.fn(); const leave = vi.fn()
    render(<WebLoadError failure={failure} onRetry={retry} onLeave={leave} getGuestId={() => 12} />)
    expect(screen.getByText('Your connection is not private')).toBeTruthy()
    expect(screen.queryByText(/Proceed to/)).toBeNull(); expect(request).not.toHaveBeenCalled()
    await advanced()
    expect(request).toHaveBeenCalledWith({ kind: 'certificateInfo', guestId: 12, url: failure.url })
    expect(retry).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Proceed to/ })) })
    expect(request).toHaveBeenCalledWith({ kind: 'trustCertificate', guestId: 12, url: failure.url, certificateId: 'actual-failure' })
    expect(retry).toHaveBeenCalledOnce()
  })
  it('返回安全页面不读取或信任证书；普通网络错误不显示高级入口', () => {
    const request = api({}); const leave = vi.fn()
    const { rerender } = render(<WebLoadError failure={failure} onRetry={vi.fn()} onLeave={leave} getGuestId={() => 12} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to safety' }))
    expect(leave).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled()
    rerender(<WebLoadError failure={{...failure,code:-102,description:'ERR_CONNECTION_REFUSED'}} onRetry={vi.fn()} getGuestId={() => 12} />)
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull()
  })
  it('失效或销毁的证书只显示重新加载提示，不允许放行', async () => {
    api({})
    render(<WebLoadError compact failure={failure} onRetry={vi.fn()} getGuestId={() => { throw new Error('destroyed') }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    await screen.findByRole('alert')
    expect(screen.queryByText(/Proceed to/)).toBeNull()
  })
  it('请求中禁用重复点击，卸载后不重试旧页面', async () => {
    const request = api({}); const retry = vi.fn()
    const { unmount } = render(<WebLoadError failure={failure} onRetry={retry} getGuestId={() => 12} />)
    await advanced()
    let resolve!: (value: object) => void
    request.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    fireEvent.click(screen.getByRole('button', { name: /Proceed to/ }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true))
    unmount(); await act(async () => { resolve({ success: true, certificateTrusted: true }) })
    expect(retry).not.toHaveBeenCalled()
  })
})
