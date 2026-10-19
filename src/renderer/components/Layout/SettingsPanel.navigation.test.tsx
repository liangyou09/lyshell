// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser-settings'
import { useBrowserSettingsStore } from '@/stores/browser-settings-store'
import SettingsPanel from './SettingsPanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: { setting?: string }) => options?.setting ? `${key}:${options.setting}` : key })
}))
vi.stubGlobal('__APP_VERSION__', '2.0.2')

beforeEach(() => {
  useBrowserSettingsStore.setState({ settings: structuredClone(DEFAULT_BROWSER_SETTINGS), loaded: true, encryptionAvailable: true, error: null })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    getDownloadConfig: async () => ({ success: true, data: { defaultDir: 'D:/Downloads' } }),
    getConfig: async () => ({ width: 1200, height: 800 }),
    listEnvProfiles: async () => ({ profiles: [], activeProfileId: null, usage: {} }),
    browserRequest: async () => ({ success: true, settings: structuredClone(DEFAULT_BROWSER_SETTINGS), passwords: [], encryptionAvailable: true })
  } })
})
afterEach(cleanup)

describe('设置分类导航', () => {
  it('环境配置在栏内编辑，列表与编辑共用一条返回栏', async () => {
    const view = render(<SettingsPanel requestedView={{ key: 'env', nonce: 1 }} />)
    fireEvent.click(await view.findByRole('button', { name: 'env.addTitle' }))
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.getByRole('region', { name: 'env.addTitle' })).toBeTruthy()
    expect(view.container.querySelectorAll('.settings-category-header')).toHaveLength(1)
    expect(view.getByRole('button', { name: 'env.backToList' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'settings.backToCategories' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'env.backToList' }))
    expect(view.container.querySelectorAll('.settings-category-header')).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'settings.backToCategories' }))
    expect(view.getByRole('navigation', { name: 'settings.section' })).toBeTruthy()
  })

  it('环境变量在设置分类内，引用入口直达该分类并可返回来源页', async () => {
    const back = vi.fn()
    const view = render(<SettingsPanel />)
    fireEvent.click(view.getByRole('button', { name: 'env.title' }))
    expect(await view.findByRole('button', { name: 'env.addTitle' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'settings.returnPage' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'settings.backToCategories' }))
    view.rerender(<SettingsPanel requestedView={{ key: 'env', nonce: 1, returnTo: 'codex' }} onReturnPage={back} />)
    expect(await view.findByRole('button', { name: 'env.addTitle' })).toBeTruthy()
    expect(view.queryByRole('navigation', { name: 'settings.section' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'settings.returnPage' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('终端配置集中在一个入口，浏览器设置独立，并可返回分类', async () => {
    const view = render(<SettingsPanel />)
    await act(async () => {})
    expect(view.queryByLabelText('settings.font')).toBeNull()
    expect(view.queryByRole('button', { name: 'settings.sections.appearance' })).toBeNull()
    expect(view.queryByRole('button', { name: 'settings.windowSize' })).toBeNull()
    expect(view.queryByRole('button', { name: 'settings.download' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'settings.terminalSettings' }))
    expect(view.getByLabelText('settings.font')).toBeTruthy()
    expect(view.getByRole('group', { name: 'settings.theme' })).toBeTruthy()
    expect(view.getByRole('group', { name: 'settings.language' })).toBeTruthy()
    expect(view.getByLabelText('settings.windowSize')).toBeTruthy()
    expect(view.getByText('D:/Downloads')).toBeTruthy()
    expect(view.queryByRole('navigation', { name: 'settings.section' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'settings.backToCategories' }))
    fireEvent.click(view.getByRole('button', { name: 'browser.title' }))
    expect(view.getByRole('navigation', { name: 'browser.category' })).toBeTruthy()
    expect(view.queryByLabelText('settings.font')).toBeNull()
    expect(view.queryByRole('group', { name: 'settings.theme' })).toBeNull()
    expect(view.queryByRole('button', { name: 'settings.returnBrowser' })).toBeNull()
  })

  it('浏览器入口显示返回操作，切换主分类保留浏览器草稿', async () => {
    const back = vi.fn()
    const view = render(<SettingsPanel requestedView={{ key: 'browser', nonce: 1, returnTo: 'web' }} onReturnBrowser={back} />)
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: 'browser.general' }))
    fireEvent.change(view.getByLabelText('browser.homePage'), { target: { value: 'https://draft.example.com' } })
    fireEvent.click(view.getByRole('button', { name: 'browser.backToCategories' }))
    fireEvent.click(view.getByRole('button', { name: 'settings.backToCategories' }))
    fireEvent.click(view.getByRole('button', { name: 'settings.terminalSettings' }))
    expect(view.container.querySelector('.settings-browser-content')?.hasAttribute('hidden')).toBe(true)
    expect(view.getByLabelText('settings.font')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'settings.backToCategories' }))
    fireEvent.click(view.getByRole('button', { name: 'browser.title' }))
    fireEvent.click(view.getByRole('button', { name: 'browser.general' }))
    expect((view.getByLabelText('browser.homePage') as HTMLInputElement).value).toBe('https://draft.example.com')
    fireEvent.click(view.getByRole('button', { name: 'settings.returnBrowser' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('数值步进支持边界禁用、持久化和终端字号通知', async () => {
    localStorage.setItem('terminalFontSize', '30')
    localStorage.setItem('terminalScrollback', '100000')
    const fontChanged = vi.fn()
    window.addEventListener('terminalFontSizeChanged', fontChanged)
    try {
      const view = render(<SettingsPanel />)
      await act(async () => {})
      fireEvent.click(view.getByRole('button', { name: 'settings.terminalSettings' }))
      const font = within(view.getByLabelText('settings.font').parentElement!)
      const buffer = within(view.getByLabelText('settings.buffer').parentElement!)
      const fontUp = font.getByRole('button', { name: 'settings.increaseValue:settings.font' }) as HTMLButtonElement
      const bufferUp = buffer.getByRole('button', { name: 'settings.increaseValue:settings.buffer' }) as HTMLButtonElement
      expect(fontUp.disabled).toBe(true)
      expect(bufferUp.disabled).toBe(true)
      fireEvent.click(font.getByRole('button', { name: 'settings.decreaseValue:settings.font' }))
      expect(localStorage.getItem('terminalFontSize')).toBe('29')
      expect((fontChanged.mock.calls.at(-1)![0] as CustomEvent<number>).detail).toBe(29)
      fireEvent.click(fontUp)
      expect(localStorage.getItem('terminalFontSize')).toBe('30')
      expect(fontUp.disabled).toBe(true)
      fireEvent.click(buffer.getByRole('button', { name: 'settings.decreaseValue:settings.buffer' }))
      expect(localStorage.getItem('terminalScrollback')).toBe('99000')
      fireEvent.click(bufferUp)
      expect(localStorage.getItem('terminalScrollback')).toBe('100000')
      expect(bufferUp.disabled).toBe(true)
      fireEvent.change(view.getByLabelText('settings.font'), { target: { value: '10' } })
      fireEvent.change(view.getByLabelText('settings.buffer'), { target: { value: '1000' } })
      expect((font.getByRole('button', { name: 'settings.decreaseValue:settings.font' }) as HTMLButtonElement).disabled).toBe(true)
      expect((buffer.getByRole('button', { name: 'settings.decreaseValue:settings.buffer' }) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      window.removeEventListener('terminalFontSizeChanged', fontChanged)
      localStorage.removeItem('terminalFontSize')
      localStorage.removeItem('terminalScrollback')
    }
  })

  it('缓冲行数允许完整编辑，提交时校正范围和指数输入', async () => {
    localStorage.setItem('terminalScrollback', '10000')
    try {
      const view = render(<SettingsPanel />)
      await act(async () => {})
      fireEvent.click(view.getByRole('button', { name: 'settings.terminalSettings' }))
      const input = view.getByLabelText('settings.buffer') as HTMLInputElement
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.change(input, { target: { value: '5' } })
      expect(input.value).toBe('5')
      expect(localStorage.getItem('terminalScrollback')).toBe('10000')
      fireEvent.change(input, { target: { value: '5000' } })
      expect(localStorage.getItem('terminalScrollback')).toBe('5000')
      fireEvent.blur(input)
      expect(localStorage.getItem('terminalScrollback')).toBe('5000')
      for (const [value, expected] of [['-1', '1000'], ['999999', '100000'], ['1e4', '10000'], ['', '1000']]) {
        fireEvent.change(input, { target: { value } })
        fireEvent.blur(input)
        expect(input.value).toBe(expected)
        expect(localStorage.getItem('terminalScrollback')).toBe(expected)
      }
    } finally {
      localStorage.removeItem('terminalScrollback')
    }
  })
})
