// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserDownload, BrowserDownloadsSnapshot } from '@shared/browser-downloads'
import { useBrowserDownloadsStore } from '../../stores/browser-downloads-store'
import BrowserDownloadPopup from './BrowserDownloadPopup'
import { useEscDismiss } from '../../hooks/useDismiss'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let publish: (snapshot: BrowserDownloadsSnapshot) => void
const unsubscribe = vi.fn()
const entry = (id: string, patch: Partial<BrowserDownload> = {}): BrowserDownload => ({
  id, fileName: `${id}.zip`, savePath: `D:/Downloads/${id}.zip`, receivedBytes: 0, totalBytes: 2048, active: true, state: 'progressing', startTime: 1, ...patch
})
const push = (downloads: BrowserDownload[], notice?: BrowserDownloadsSnapshot['notice']) => act(() => publish({ downloadDirectory: 'D:/Downloads', downloads, notice }))
beforeEach(() => {
  vi.clearAllMocks()
  useBrowserDownloadsStore.setState({ downloads: [], downloadDirectory: '', loaded: false, error: false, popupRequest: 0, popupDownloadIds: [], notice: undefined })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    browserRequest: async () => ({ success: true, downloadSnapshot: { downloads: [entry('history', { active: false, state: 'completed' })], downloadDirectory: 'D:/Downloads' } }),
    onBrowserDownloadsChanged: (callback: typeof publish) => { publish = callback; return unsubscribe }
  } })
})
afterEach(cleanup)

describe('浏览器右上角下载浮窗', () => {
  it('浮窗持有焦点时先消费 Esc，自动提醒不占用外层编辑器的 Esc', async () => {
    const dismissEditor = vi.fn()
    const Editor = () => { useEscDismiss(true, dismissEditor); return <input aria-label="editor" /> }
    const view = render(<><Editor /><BrowserDownloadPopup /></>)
    await waitFor(() => expect(useBrowserDownloadsStore.getState().loaded).toBe(true))
    act(() => view.getByRole('textbox').focus())
    push([entry('one')], { downloadId: 'one', kind: 'started' })
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' })
    expect(dismissEditor).toHaveBeenCalledOnce()
    expect(view.getByRole('complementary')).toBeTruthy()
    const close = view.getByRole('button', { name: 'common.close' })
    act(() => close.focus())
    fireEvent.keyDown(close, { key: 'Escape', isComposing: true })
    expect(view.getByRole('complementary')).toBeTruthy()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(view.queryByRole('complementary')).toBeNull()
    expect(dismissEditor).toHaveBeenCalledOnce()
  })

  it('查询旧记录不弹窗；开始时显示，不抢当前输入焦点', async () => {
    const view = render(<><input aria-label="current-work" /><BrowserDownloadPopup /></>)
    await waitFor(() => expect(useBrowserDownloadsStore.getState().loaded).toBe(true))
    expect(view.queryByRole('complementary')).toBeNull()
    const input = view.getByRole('textbox'); input.focus()
    push([entry('one')], { downloadId: 'one', kind: 'started' })
    expect(view.getByRole('complementary', { name: 'browser.downloadPopup' })).toBeTruthy()
    expect(view.getByRole('progressbar')).toBeTruthy()
    expect(document.activeElement).toBe(input)
    expect(view.queryByRole('button', { name: 'browser.chooseDownloadDirectory' })).toBeNull()
  })
  it('关闭后进度与图标更新不重新弹出；完成时再次提醒并提供打开操作', async () => {
    const view = render(<BrowserDownloadPopup />)
    await waitFor(() => expect(useBrowserDownloadsStore.getState().loaded).toBe(true))
    push([entry('one')], { downloadId: 'one', kind: 'started' })
    fireEvent.click(view.getByRole('button', { name: 'common.close' }))
    push([entry('one', { receivedBytes: 1024 })])
    expect(view.queryByRole('complementary')).toBeNull()
    const completed = entry('one', { active: false, state: 'completed', receivedBytes: 2048 })
    push([completed], { downloadId: 'one', kind: 'completed' })
    expect(view.getByRole('button', { name: 'browser.openDownload' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'common.close' }))
    push([{ ...completed, iconDataUrl: 'data:image/png;base64,fixture' }])
    expect(view.queryByRole('complementary')).toBeNull()
  })
  it('仅显示最近提醒的三个任务，失败也可提醒并用 Escape 关闭', async () => {
    const view = render(<BrowserDownloadPopup />)
    await waitFor(() => expect(useBrowserDownloadsStore.getState().loaded).toBe(true))
    let downloads: BrowserDownload[] = []
    for (const id of ['one', 'two', 'three', 'four']) {
      downloads = [entry(id), ...downloads]
      push(downloads, { downloadId: id, kind: 'started' })
    }
    expect(view.getAllByRole('article')).toHaveLength(3)
    expect(view.queryByRole('article', { name: 'one.zip' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'common.close' }))
    push(downloads.map(item => item.id === 'two' ? { ...item, state: 'interrupted', active: false } : item), { downloadId: 'two', kind: 'interrupted' })
    expect(view.getByRole('article', { name: 'two.zip' }).textContent).toContain('browser.downloadStates.interrupted')
    const close = view.getByRole('button', { name: 'common.close' })
    act(() => close.focus())
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(view.queryByRole('complementary')).toBeNull()
  })
})
