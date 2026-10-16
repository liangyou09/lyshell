import { create } from 'zustand'
import { DEFAULT_BROWSER_SETTINGS, type BrowserRequest, type BrowserResult, type BrowserSettings } from '@shared/browser-settings'

export async function requestBrowser(request: BrowserRequest): Promise<BrowserResult> {
  try {
    const api = window.electronAPI?.browserRequest
    return api ? await api(request) : { success: false, error: 'browserUnavailable' }
  } catch { return { success: false, error: 'browserOperationFailed' } }
}

interface BrowserSettingsStore {
  settings: BrowserSettings
  loaded: boolean
  encryptionAvailable: boolean
  error: string | null
  load: () => Promise<void>
  save: (settings: BrowserSettings) => Promise<BrowserResult>
}
let loading: Promise<void> | null = null
export const useBrowserSettingsStore = create<BrowserSettingsStore>((set) => ({
  settings: structuredClone(DEFAULT_BROWSER_SETTINGS),
  loaded: typeof window === 'undefined' || !window.electronAPI?.browserRequest,
  encryptionAvailable: false,
  error: null,
  load: async () => {
    if (loading) return loading
    loading = (async () => {
      const result = await requestBrowser({ kind: 'get' })
      set({ ...(result.settings ? { settings: result.settings } : {}), loaded: true, encryptionAvailable: result.encryptionAvailable ?? false, error: result.success ? null : result.error ?? 'browserOperationFailed' })
    })()
    try { await loading } finally { loading = null }
  },
  save: async settings => {
    const result = await requestBrowser({ kind: 'save', settings })
    if (result.success && result.settings) set({ settings: result.settings, error: null })
    return result
  }
}))
