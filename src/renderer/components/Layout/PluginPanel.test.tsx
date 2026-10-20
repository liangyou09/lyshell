// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { PluginListItem } from '@shared/plugin-types'
import { usePluginStore } from '@/stores/plugin-store'
import PluginPanel from './PluginPanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const initialState = usePluginStore.getState()
const plugin: PluginListItem = {
  id: 'example-plugin', name: 'Example', description: '插件用途说明', version: '1.0.0',
  path: 'example', dev: true, enabled: true, source: 'dev', installedAt: '',
  grantedCapabilities: ['read'], runtime: 'node', lifecycle: 'oneshot',
  activationEvents: [], capabilities: ['read'], views: []
}
const enable = vi.fn(async () => {
  usePluginStore.setState({ items: [{ ...plugin, enabled: true }] })
  return true
})
const disable = vi.fn(async () => {
  usePluginStore.setState({ items: [{ ...plugin, enabled: false }] })
  return true
})
const runOneshot = vi.fn(async () => ({ success: true }))
const uninstall = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  vi.clearAllMocks()
  usePluginStore.setState({
    ...initialState, items: [plugin], load: vi.fn(async () => {}), enable, disable,
    runOneshot, uninstall
  })
})
afterEach(() => { cleanup(); usePluginStore.setState(initialState, true) })

describe('插件卡片交互', () => {
  it('进程清理失败只显示一条提示，原始命令默认折叠并可关闭', async () => {
    const rawError = 'Command failed: taskkill /PID 13524 /T /F\nWindows process cleanup error'
    disable.mockImplementationOnce(async () => {
      usePluginStore.setState({ error: rawError, items: [{ ...plugin, enabled: false }] })
      return false
    })
    const view = render(<PluginPanel />)
    fireEvent.click(view.getByRole('checkbox', { name: plugin.name }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('plugin.cleanupUnconfirmed'))
    expect(view.queryByRole('status')).toBeNull()
    expect(view.queryByText('plugin.toggleFail')).toBeNull()
    const diagnostics = view.getByText('plugin.errorDetails').closest('details')!
    expect(diagnostics.open).toBe(false)
    expect(diagnostics.querySelector('pre')?.textContent).toBe(rawError)
    fireEvent.click(view.getByText('plugin.errorDetails'))
    expect(diagnostics.open).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'plugin.dismissNotice' }))
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.queryByText('plugin.toggleFail')).toBeNull()
    expect(usePluginStore.getState().error).toBeNull()
    expect((view.getByRole('checkbox', { name: plugin.name }) as HTMLInputElement).checked).toBe(false)
  })

  it('普通错误保留原始详情，再次操作清除旧错误', async () => {
    usePluginStore.setState({ error: 'Permission denied' })
    const view = render(<PluginPanel />)
    expect(view.getByRole('alert').textContent).toBe('plugin.toggleFail')
    expect(view.queryByText('plugin.cleanupHint')).toBeNull()
    fireEvent.click(view.getByRole('checkbox', { name: plugin.name }))
    await waitFor(() => expect(disable).toHaveBeenCalledOnce())
    expect(view.queryByRole('alert')).toBeNull()
    expect(usePluginStore.getState().error).toBeNull()
  })

  it('卡片空白、说明、名称和勾选框都能切换，每次仅调用一次', async () => {
    const view = render(<PluginPanel />)
    const checkbox = view.getByRole('checkbox', { name: plugin.name }) as HTMLInputElement
    const card = checkbox.closest('[aria-busy]')!
    fireEvent.click(card)
    await waitFor(() => expect(checkbox.checked).toBe(false))
    expect(disable).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByText(plugin.description!, { selector: 'p[title]' }))
    await waitFor(() => expect(checkbox.checked).toBe(true))
    expect(enable).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByText(plugin.name))
    await waitFor(() => expect(checkbox.checked).toBe(false))
    expect(disable).toHaveBeenCalledTimes(2)
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox.checked).toBe(true))
    expect(enable).toHaveBeenCalledTimes(2)
  })

  it('详情默认收起，展开、读取信息、运行和两步卸载不会切换启用', async () => {
    const view = render(<PluginPanel />)
    const details = view.container.querySelector('details')!
    expect(details.open).toBe(false)
    fireEvent.click(view.getByText('plugin.technicalDetails'))
    expect(details.open).toBe(true)
    fireEvent.click(view.getByText(plugin.id))
    fireEvent.click(view.getByRole('button', { name: 'plugin.run' }))
    await waitFor(() => expect(runOneshot).toHaveBeenCalledWith(plugin.id))
    fireEvent.click(view.getByRole('button', { name: 'plugin.uninstall' }))
    expect(uninstall).not.toHaveBeenCalled()
    fireEvent.keyDown(view.getByRole('button', { name: 'plugin.confirmUninstallAction' }), { key: 'Escape' })
    expect(view.getByRole('button', { name: 'plugin.uninstall' })).toBeDefined()
    expect(uninstall).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'plugin.uninstall' }))
    fireEvent.click(view.getByRole('button', { name: 'plugin.confirmUninstallAction' }))
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith(plugin.id))
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })

  it('切换中拦截重复点击并保留键盘焦点，失败后恢复操作和原状态', async () => {
    let finish!: (value: boolean) => void
    disable.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
    const view = render(<PluginPanel />)
    const checkbox = view.getByRole('checkbox', { name: plugin.name }) as HTMLInputElement
    const card = checkbox.closest('[aria-busy]')!
    checkbox.focus()
    fireEvent.click(checkbox)
    fireEvent.click(card)
    fireEvent.click(checkbox)
    expect(disable).toHaveBeenCalledTimes(1)
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(checkbox)
    expect(view.getByText('plugin.updating')).toBeDefined()
    await act(async () => finish(false))
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.getAttribute('aria-disabled')).toBe('false')
    expect(document.activeElement).toBe(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(view.getByText('plugin.toggleFail')).toBeDefined()
  })
})
