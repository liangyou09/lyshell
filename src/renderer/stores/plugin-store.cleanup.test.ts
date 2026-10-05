import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginStore } from './plugin-store'

beforeEach(() => { usePluginStore.setState({ items: [], loading: false, loaded: true, error: 'old error' }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('插件禁用清理失败反馈', () => {
  it('显示主进程的清理错误，收到资源撤销通知后仍保留失败提示', async () => {
    let finish!: (result: { success: boolean; error: string }) => void
    vi.stubGlobal('window', { electronAPI: {
      disablePlugin: vi.fn(() => new Promise(resolve => { finish = resolve }))
    } })
    const result = usePluginStore.getState().disable('plugin')
    expect(usePluginStore.getState().error).toBeNull()
    usePluginStore.getState().markResourcesReleased('plugin')
    finish({ success: false, error: 'Serial close could not be confirmed; restart the application' })
    expect(await result).toBe(false)
    expect(usePluginStore.getState().error).toBe('Serial close could not be confirmed; restart the application')
  })

  it('再次禁用成功时清除旧错误并刷新列表', async () => {
    const listPlugins = vi.fn(async () => [])
    vi.stubGlobal('window', { electronAPI: { disablePlugin: vi.fn(async () => ({ success: true })), listPlugins } })
    expect(await usePluginStore.getState().disable('plugin')).toBe(true)
    expect(usePluginStore.getState().error).toBeNull()
    expect(listPlugins).toHaveBeenCalledOnce()
  })
})
