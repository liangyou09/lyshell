// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WebTabOverlay } from './WebTabLayer'
import { usePaneStore } from '../../stores/pane-store'
import { webLoadFailureFromEvent, webLoadFailureReason } from './web-load-error'
import '../../i18n'

vi.mock('../Search/SearchableTab', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
afterEach(cleanup)

function fail(element: Element, fields: object): void {
  act(() => { element.dispatchEvent(Object.assign(new Event('did-fail-load'), fields)) })
}

describe('网页失败页', () => {
  it('标题关联导航后的地址，动态更新不重记访问，新导航不沿用旧标题', () => {
    const record = vi.spyOn(usePaneStore.getState(), 'recordWebTabVisit').mockImplementation(() => undefined)
    const update = vi.spyOn(usePaneStore.getState(), 'updateWebTabHistoryTitle').mockImplementation(() => undefined)
    try {
      render(<WebTabOverlay id="title-history" url="https://first.example/" />)
      const el = document.querySelector('webview')!
      act(() => {
        el.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://redirect.example/docs', isMainFrame: true }))
        el.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: '网页使用文档' }))
        el.dispatchEvent(new Event('did-finish-load'))
      })
      expect(record).toHaveBeenLastCalledWith('https://redirect.example/docs', '网页使用文档')
      act(() => { el.dispatchEvent(new CustomEvent('page-title-updated', { detail: { title: '动态标题' } })) })
      expect(update).toHaveBeenLastCalledWith('https://redirect.example/docs', '动态标题')
      expect(record).toHaveBeenCalledOnce()
      act(() => {
        el.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://next.example/', isMainFrame: true }))
        el.dispatchEvent(new Event('did-finish-load'))
      })
      expect(record).toHaveBeenLastCalledWith('https://next.example/', '')
    } finally { record.mockRestore(); update.mockRestore() }
  })

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
    // 重试期间保留失败画面，不先揭开尚未渲染的 guest。
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeTruthy()
    act(() => { el.dispatchEvent(new Event('dom-ready')) })
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull()
  })

  it('子资源加载不反复遮住已经显示的页面', () => {
    render(<WebTabOverlay id="steady-page" url="https://first.example/" />)
    const el = document.querySelector('webview')!
    act(() => { el.dispatchEvent(new Event('dom-ready')) })
    act(() => { el.dispatchEvent(new Event('did-start-loading')) })
    expect(screen.queryByText('Loading…')).toBeNull()
    act(() => { el.dispatchEvent(new Event('did-stop-loading')) })
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('文档完成事件能补收初始占位，但失败文档完成不能撤掉错误页', () => {
    render(<WebTabOverlay id="finished-document" url="https://first.example/" />)
    const el = document.querySelector('webview')!
    act(() => { el.dispatchEvent(new Event('did-finish-load')) })
    expect(screen.queryByText('Loading…')).toBeNull()
    fail(el, { errorCode: -102, isMainFrame: true })
    act(() => { el.dispatchEvent(new Event('did-finish-load')) })
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('失败文档和崩溃后的完成事件不写访问历史，恢复后只记录成功页面', () => {
    const record = vi.spyOn(usePaneStore.getState(), 'recordWebTabVisit').mockImplementation(() => undefined)
    try {
      render(<WebTabOverlay id="failed-history" url="https://failed.example/" />)
      const el = document.querySelector('webview')!
      fail(el, { errorCode: -102, isMainFrame: true })
      act(() => { el.dispatchEvent(new Event('did-finish-load')) })
      expect(record).not.toHaveBeenCalled()
      act(() => {
        el.dispatchEvent(new Event('render-process-gone'))
        el.dispatchEvent(new Event('did-finish-load'))
      })
      expect(record).not.toHaveBeenCalled()
      act(() => {
        el.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: false }))
        el.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://recovered.example/', isMainFrame: true }))
        el.dispatchEvent(new Event('did-finish-load'))
      })
      expect(record).toHaveBeenCalledOnce()
      expect(record).toHaveBeenCalledWith('https://recovered.example/', '')
    } finally { record.mockRestore() }
  })

  it('加载停止但文档未就绪时保留占位，失败页dom-ready不揭开错误页', () => {
    render(<WebTabOverlay id="never-ready" url="https://first.example/" />)
    const el = document.querySelector<HTMLElement>('webview')!
    act(() => { el.dispatchEvent(new Event('did-stop-loading')) })
    expect(screen.getByText('Loading…')).toBeTruthy()
    fail(el, { errorCode: -102, isMainFrame: true })
    act(() => { el.dispatchEvent(new Event('dom-ready')); el.dispatchEvent(new Event('did-start-loading')); el.dispatchEvent(new Event('did-stop-loading')) })
    expect(screen.getByRole('status')).toBeTruthy()
    expect(el.style.visibility).toBe('hidden')
  })

  it('渲染器崩溃后保持静止错误页，真实新导航成功后恢复', () => {
    render(<WebTabOverlay id="crashed-page" url="https://first.example/" />)
    const el = document.querySelector<HTMLElement>('webview')!
    act(() => { el.dispatchEvent(new Event('dom-ready')); el.dispatchEvent(new Event('render-process-gone')) })
    expect(screen.getByRole('status').textContent).toContain('renderer has stopped')
    expect(el.style.visibility).toBe('hidden')
    act(() => { el.dispatchEvent(new Event('did-start-loading')); el.dispatchEvent(new Event('dom-ready')) })
    expect(screen.getByRole('status')).toBeTruthy()
    act(() => {
      el.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: false }))
      el.dispatchEvent(new Event('dom-ready'))
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(el.style.visibility).toBe('')
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
