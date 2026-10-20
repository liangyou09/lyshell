// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserDownloadsSnapshot } from '@shared/browser-downloads'
import type { BrowserRequest } from '@shared/browser-settings'
import { useBrowserDownloadsStore } from '../../stores/browser-downloads-store'
import BrowserDownloads from './BrowserDownloads'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const api = vi.fn()
const removeListener = vi.fn()
const choose = vi.fn()
const save = vi.fn()
let listener: (snapshot: BrowserDownloadsSnapshot) => void
const snapshot = (patch: Partial<BrowserDownloadsSnapshot['downloads'][number]> = {}): BrowserDownloadsSnapshot => ({
  downloadDirectory: 'D:/Downloads', downloads: [{ id: 'one', fileName: 'report.zip', savePath: 'D:/Downloads/report.zip', receivedBytes: 1024, totalBytes: 2048, state: 'progressing', active: true, startTime: 1, ...patch }]
})
beforeEach(() => {
  vi.clearAllMocks()
  useBrowserDownloadsStore.setState({ downloads: [], downloadDirectory: '', loaded: false, error: false })
  api.mockImplementation(async (request: BrowserRequest) => ({ success: true, ...(request.kind === 'downloads' ? { downloadSnapshot: snapshot() } : {}) }))
  choose.mockResolvedValue('D:/NewDownloads'); save.mockResolvedValue({ success: true })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    browserRequest: api, selectDirectory: choose, setDownloadConfig: save,
    onBrowserDownloadsChanged: vi.fn(callback => { listener = callback; return removeListener })
  } })
})
afterEach(cleanup)

describe('浏览器下载列表', () => {
  it('显示目录、百分比和实际路径；实时完成后提供定位操作并清理订阅', async () => {
    const view = render(<BrowserDownloads />)
    await waitFor(() => expect(view.getByText(/50%/)).toBeTruthy())
    expect(view.queryByRole('button', { name: 'browser.chooseDownloadDirectory' })).toBeNull()
    expect(view.getByTitle('D:/Downloads/report.zip')).toBeTruthy()
    expect(view.getByRole('progressbar').getAttribute('value')).toBe('50')
    const completed = snapshot({ state: 'completed', active: false, receivedBytes: 2048 })
    api.mockResolvedValue({ success: true, downloadSnapshot: completed })
    act(() => listener(completed))
    expect(view.queryByRole('progressbar')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'browser.openDownload' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'downloadAction', id: 'one', action: 'open' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'browser.revealDownload' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(view.getByRole('button', { name: 'browser.revealDownload' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'downloadAction', id: 'one', action: 'reveal' }))
    view.unmount(); expect(removeListener).toHaveBeenCalledOnce()
  })
  it('总大小未知时使用不定进度；取消只传登记 ID', async () => {
    api.mockResolvedValue({ success: true, downloadSnapshot: snapshot({ totalBytes: 0 }) })
    const view = render(<BrowserDownloads />)
    await waitFor(() => expect(view.getByRole('progressbar')).toBeTruthy())
    expect(view.getByRole('progressbar').hasAttribute('value')).toBe(false)
    expect(view.getByText(/browser.downloadSizeUnknown/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'browser.cancelDownload' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'downloadAction', id: 'one', action: 'cancel' }))
  })
  it('初始快照晚于实时事件时不能回退进度', async () => {
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const view = render(<BrowserDownloads />)
    act(() => listener(snapshot({ receivedBytes: 1536 })))
    expect(view.getByText(/75%/)).toBeTruthy()
    await act(async () => resolve({ success: true, downloadSnapshot: snapshot() }))
    expect(view.getByText(/75%/)).toBeTruthy()
  })
  it('选择目录持久化后刷新；保存失败保留原目录并显示错误', async () => {
    const view = render(<BrowserDownloads showDirectorySettings />)
    await waitFor(() => expect(view.getByTitle('D:/Downloads')).toBeTruthy())
    save.mockResolvedValueOnce({ success: false })
    fireEvent.click(view.getByRole('button', { name: 'browser.chooseDownloadDirectory' }))
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy())
    expect(view.getByTitle('D:/Downloads')).toBeTruthy()
    api.mockResolvedValue({ success: true, downloadSnapshot: { downloads: [], downloadDirectory: 'D:/NewDownloads' } })
    fireEvent.click(view.getByRole('button', { name: 'browser.chooseDownloadDirectory' }))
    await waitFor(() => expect(view.getByText('D:/NewDownloads')).toBeTruthy())
    expect(save).toHaveBeenCalledWith({ defaultDir: 'D:/NewDownloads' })
    expect(view.getByText('browser.noDownloads')).toBeTruthy()
  })
  it('接口失败可重试，打开目录走专用主进程请求', async () => {
    api.mockResolvedValueOnce({ success: false })
    const view = render(<BrowserDownloads showDirectorySettings />)
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'browser.retryDownloadList' }))
    await waitFor(() => expect(view.getByTitle('D:/Downloads')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'browser.openDownloadDirectory' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'openDownloadDirectory' }))
  })
})
