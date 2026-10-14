// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, act } from '@testing-library/react'
import { usePluginStore } from '@/stores/plugin-store'
import SettingsPanel from './SettingsPanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.stubGlobal('__APP_VERSION__', '2.0.1')
afterEach(() => { cleanup(); usePluginStore.setState({ items: [] }) })

const plugin = {
  id: 'aipet', name: 'PetLink', version: '1.0.0', path: 'aipet', dev: true, enabled: true,
  source: 'dev' as const, installedAt: '', grantedCapabilities: [], runtime: 'node' as const,
  lifecycle: 'persistent' as const, activationEvents: [], capabilities: [],
  views: [{ pluginId: 'aipet', id: 'settings', title: 'PetLink', entry: 'views/settings.html', source: 'manifest' as const, surface: 'settings' as const }]
}

describe('宿主插件设置', () => {
  it('选择设置嵌入安全 webview，重复宿主请求重新定位，禁用即卸载', () => {
    usePluginStore.setState({ items: [plugin] })
    const { container, getByLabelText, rerender } = render(<SettingsPanel requestedView={{ key: 'plugin:aipet:settings', nonce: 1 }} />)
    expect(container.querySelector('webview')?.getAttribute('src')).toBe('lyshell-plugin://aipet/settings.html')
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe('pluginviews:aipet')
    fireEvent.change(getByLabelText('settings.section'), { target: { value: '' } })
    expect(container.querySelector('webview')).toBeNull()
    rerender(<SettingsPanel requestedView={{ key: 'plugin:aipet:settings', nonce: 2 }} />)
    expect(container.querySelector('webview')).not.toBeNull()
    act(() => usePluginStore.getState().markResourcesReleased('aipet'))
    expect(container.querySelector('webview')).toBeNull()
    expect(container.querySelector('.settings-content')).not.toBeNull()
  })
})
