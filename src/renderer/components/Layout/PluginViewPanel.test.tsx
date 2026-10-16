// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import PluginViewPanel from './PluginViewPanel'
import '../../i18n'

afterEach(cleanup)

describe('插件视图崩溃恢复', () => {
  it('响应 render-process-gone，重试重建客体并为新元素重新监听', () => {
    render(<PluginViewPanel visible view={{ pluginId: 'test-plugin', id: 'main', title: 'Test', entry: 'views/index.html', source: 'manifest' }} />)
    const first = document.querySelector('webview')!
    act(() => { first.dispatchEvent(new Event('render-process-gone')) })
    expect(screen.getByText('View process crashed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.queryByText('View process crashed')).toBeNull()
    const second = document.querySelector('webview')!
    expect(second).not.toBe(first)
    expect(second.getAttribute('src')).toBe(first.getAttribute('src'))
    expect(second.getAttribute('partition')).toBe(first.getAttribute('partition'))
    act(() => { first.dispatchEvent(new Event('render-process-gone')) })
    expect(screen.queryByText('View process crashed')).toBeNull()
    act(() => { second.dispatchEvent(new Event('render-process-gone')) })
    expect(screen.getByText('View process crashed')).toBeTruthy()
  })
})
