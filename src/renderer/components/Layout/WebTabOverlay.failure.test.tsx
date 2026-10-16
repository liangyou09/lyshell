// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WebTabOverlay } from './WebTabLayer'
import { webLoadFailureFromEvent, webLoadFailureReason } from './web-load-error'
import '../../i18n'

vi.mock('../Search/SearchableTab', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
afterEach(cleanup)

function fail(element: Element, fields: object): void {
  act(() => { element.dispatchEvent(Object.assign(new Event('did-fail-load'), fields)) })
}

describe('网页失败页', () => {
  it('完整页签以实际 guest 和失败 URL 确认证书，获准后重试', async () => {
    const request = vi.fn().mockImplementation(async raw => raw.kind === 'certificateInfo' ? { success: true, certificate: { certificateId: 'actual-failure', subject: '', issuer: '', validFrom: '', validTo: '', fingerprint: '' } } : { success: true, certificateTrusted: true })
    const oldApi = window.electronAPI
    window.electronAPI = { ...oldApi, browserRequest: request }
    try {
      render(<WebTabOverlay id="certificate-test" url="https://first.example/" />)
      const el = document.querySelector('webview')!
      const loadURL = vi.fn().mockResolvedValue(undefined)
      Object.assign(el, { loadURL, getWebContentsId: () => 1234 })
      const url = 'https://10.5.20.36:8072/'
      fail(el, { errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID', validatedURL: url, isMainFrame: true })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Advanced' })) })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Proceed to/ })) })
      expect(request).toHaveBeenCalledWith({ kind: 'trustCertificate', guestId: 1234, url, certificateId: 'actual-failure' })
      expect(loadURL).toHaveBeenCalledWith(url)
    } finally { window.electronAPI = oldApi }
  })

  it('显示实际失败地址与原因，重试该地址并在成功后恢复页面', () => {
    render(<WebTabOverlay id="failure-test" url="https://first.example/" />)
    const el = document.querySelector('webview')!
    const loadURL = vi.fn().mockResolvedValue(undefined)
    Object.assign(el, { loadURL })
    const failedUrl = 'http://localhost:8765/very/long/path?query=test'
    fail(el, { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: failedUrl, isMainFrame: true })
    act(() => { el.dispatchEvent(new Event('did-stop-loading')) })
    expect(screen.getByRole('status').textContent).toContain('service is running')
    expect(screen.getByText('localhost:8765').getAttribute('title')).toBe(failedUrl)
    expect(screen.getByText('ERR_CONNECTION_REFUSED (-102)')).toBeTruthy()
    expect(screen.getByText(failedUrl)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }))
    expect(loadURL).toHaveBeenCalledWith(failedUrl)
    act(() => { el.dispatchEvent(new Event('did-start-loading')) })
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull()
    act(() => { el.dispatchEvent(new Event('dom-ready')) })
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('忽略子框架失败与取消导航，兼容 detail 事件参数', () => {
    render(<WebTabOverlay id="failure-test" url="https://first.example/" />)
    const el = document.querySelector('webview')!
    fail(el, { errorCode: -105, isMainFrame: false })
    fail(el, { detail: { errorCode: -3, isMainFrame: true } })
    expect(screen.queryByRole('status')).toBeNull()
    fail(el, { detail: { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://missing.example/' } })
    expect(screen.getByRole('status').textContent).toContain('DNS settings')
    expect(screen.getByText('missing.example')).toBeTruthy()
  })

  it.each([
    [-106, 'offline'], [-105, 'dns'], [-102, 'refused'], [-7, 'timeout'],
    [-118, 'timeout'], [-202, 'certificate'], [-2, 'generic']
  ])('按错误码 %s 提供对应恢复建议', (code, reason) => {
    expect(webLoadFailureReason({ code: code as number, description: '', url: '' })).toBe(reason)
  })

  it('优先读取 Electron 事件自身参数并保留缺省地址', () => {
    const event = Object.assign(new Event('did-fail-load'), { errorCode: -106, detail: { errorCode: -105, isMainFrame: false }, isMainFrame: true })
    expect(webLoadFailureFromEvent(event, 'https://fallback.example/')).toEqual({
      code: -106, description: 'ERR_-106', url: 'https://fallback.example/'
    })
  })
})
