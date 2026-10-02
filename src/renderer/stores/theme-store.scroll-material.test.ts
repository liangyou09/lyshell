// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from './theme-store'
import { SCROLL_MATERIAL_STORAGE_KEY } from '../styles/scroll-materials'

beforeEach(() => {
  localStorage.clear()
  useThemeStore.getState().initFromStorage()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('轴头材质持久化', () => {
  it('切换预设与自定义主题不改材质，再次初始化恢复上次选择', () => {
    const store = useThemeStore.getState()
    store.setScrollMaterial('jade')
    store.setTheme('rack-paper')
    store.setTheme('rack-custom')
    store.setCustomColors({ base: '#F0EEE8' })
    expect(document.documentElement.dataset.scrollMaterial).toBe('jade')
    expect(localStorage.getItem(SCROLL_MATERIAL_STORAGE_KEY)).toBe('jade')

    useThemeStore.setState({ scrollMaterial: 'walnut' })
    document.documentElement.dataset.scrollMaterial = 'walnut'
    store.initFromStorage()
    expect(useThemeStore.getState().scrollMaterial).toBe('jade')
    expect(document.documentElement.dataset.scrollMaterial).toBe('jade')
  })

  it('无法识别的旧存档恢复为默认木轴头', () => {
    localStorage.setItem(SCROLL_MATERIAL_STORAGE_KEY, 'unknown-material')
    useThemeStore.getState().initFromStorage()
    expect(useThemeStore.getState().scrollMaterial).toBe('walnut')
    expect(document.documentElement.dataset.scrollMaterial).toBe('walnut')
  })

  it('存储被禁用时选择仍即时生效，恢复时安全回到默认', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => useThemeStore.getState().setScrollMaterial('lacquer')).not.toThrow()
    expect(document.documentElement.dataset.scrollMaterial).toBe('lacquer')
    expect(useThemeStore.getState().scrollMaterial).toBe('lacquer')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => useThemeStore.getState().initFromStorage()).not.toThrow()
    expect(useThemeStore.getState().scrollMaterial).toBe('walnut')
  })

  it('React 挂载前就恢复瓷质轴头，避免默认材质闪现', async () => {
    localStorage.setItem(SCROLL_MATERIAL_STORAGE_KEY, 'porcelain')
    document.documentElement.dataset.scrollMaterial = 'walnut'
    vi.resetModules()
    await import('../theme-init')
    expect(document.documentElement.dataset.scrollMaterial).toBe('porcelain')
  })
})
