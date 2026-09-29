// ui-theme 快照单测：缺省 dark、合法值切换 + 回调、非法值忽略、复位
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setRendererThemeMode,
  getRendererThemeMode,
  setUiThemeModeListener,
  resetUiThemeModeForTest
} from './ui-theme'

describe('ui-theme（main 侧明暗模式快照）', () => {
  beforeEach(() => {
    resetUiThemeModeForTest()
  })

  it('缺省 dark（默认主题 Graphite 即暗色；renderer 尚未推送时 bootstrap 用它兜底）', () => {
    expect(getRendererThemeMode()).toBe('dark')
  })

  it('合法值切换并触发一次回调；同值重复推送不触发', () => {
    const onChange = vi.fn()
    setUiThemeModeListener(onChange)
    setRendererThemeMode('light')
    expect(getRendererThemeMode()).toBe('light')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('light')
    setRendererThemeMode('light')
    expect(onChange).toHaveBeenCalledTimes(1)
    setRendererThemeMode('dark')
    expect(getRendererThemeMode()).toBe('dark')
    expect(onChange).toHaveBeenLastCalledWith('dark')
  })

  it('非法值静默忽略（来自不受信 IPC 的任意负载）', () => {
    const onChange = vi.fn()
    setUiThemeModeListener(onChange)
    for (const bad of ['DARK', 'blue', 1, null, undefined, { theme: 'light' }]) {
      setRendererThemeMode(bad)
    }
    expect(getRendererThemeMode()).toBe('dark')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('未注入回调时切换不抛错', () => {
    expect(() => setRendererThemeMode('light')).not.toThrow()
    expect(getRendererThemeMode()).toBe('light')
  })

  it('复位恢复缺省并摘除回调', () => {
    const onChange = vi.fn()
    setUiThemeModeListener(onChange)
    setRendererThemeMode('light')
    resetUiThemeModeForTest()
    expect(getRendererThemeMode()).toBe('dark')
    setRendererThemeMode('dark') // 同值，不触发已摘除的回调
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
