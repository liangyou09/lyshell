// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from './theme-store'
import { DEFAULT_SCROLL_MATERIAL, SCROLL_MATERIAL_STORAGE_KEY } from '../styles/scroll-materials'

beforeEach(() => {
  localStorage.clear()
  useThemeStore.getState().initFromStorage()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('唯一玉雕画轴与旧材质迁移', () => {
  it('切换预设与自定义主题时始终保留玉雕画轴', () => {
    const store = useThemeStore.getState()
    store.setTheme('rack-paper')
    store.setTheme('rack-custom')
    store.setCustomColors({ base: '#F0EEE8' })
    expect(document.documentElement.dataset.scrollMaterial).toBe('jade')
    expect(useThemeStore.getState().scrollMaterial).toBe('jade')
  })

  it.each(['walnut', 'lacquer', 'porcelain', 'unknown-material'])('旧存档 %s 自动迁移并保存为玉雕材质', material => {
    localStorage.setItem(SCROLL_MATERIAL_STORAGE_KEY, material)
    document.documentElement.dataset.scrollMaterial = material
    useThemeStore.getState().initFromStorage()
    expect(useThemeStore.getState().scrollMaterial).toBe('jade')
    expect(document.documentElement.dataset.scrollMaterial).toBe('jade')
    expect(localStorage.getItem(SCROLL_MATERIAL_STORAGE_KEY)).toBe('jade')
  })

  it('存储被禁用时仍正常启用玉雕画轴', () => {
    localStorage.setItem(SCROLL_MATERIAL_STORAGE_KEY, 'walnut')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => useThemeStore.getState().initFromStorage()).not.toThrow()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => useThemeStore.getState().initFromStorage()).not.toThrow()
    expect(useThemeStore.getState().scrollMaterial).toBe(DEFAULT_SCROLL_MATERIAL)
    expect(document.documentElement.dataset.scrollMaterial).toBe('jade')
  })

  it('React 挂载前就将旧材质统一为玉雕，避免旧外观闪现', async () => {
    localStorage.setItem(SCROLL_MATERIAL_STORAGE_KEY, 'porcelain')
    document.documentElement.dataset.scrollMaterial = 'walnut'
    vi.resetModules()
    await import('../theme-init')
    expect(document.documentElement.dataset.scrollMaterial).toBe('jade')
  })
})
