// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TASK_SHELF_PREFERENCES, type TaskShelfRequest, type TaskShelfResult } from '@shared/task-shelf'
import SettingsPanel from './SettingsPanel'
import { useTaskShelf } from '../../stores/task-shelf'
import '../../i18n'

vi.stubGlobal('__APP_VERSION__', '2.0.2')

let preferencesResponse: TaskShelfResult | null = null
const request = vi.fn<[TaskShelfRequest], Promise<TaskShelfResult>>()
beforeEach(() => {
  preferencesResponse = null
  request.mockReset()
  request.mockImplementation(async input => input.kind === 'preferences'
    ? preferencesResponse ?? { success: true, entries: [], preferences: input.preferences }
    : { success: true, entries: [] })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: request } })
  useTaskShelf.setState({ entries: [], bindings: {}, loaded: true, busy: {}, error: null, saveErrors: {}, preferences: { ...DEFAULT_TASK_SHELF_PREFERENCES } })
})
afterEach(cleanup)

// 快捷键设置已从保存区面板移到设置 → 终端，入口只有这一处。
const openTerminalSettings = (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByRole('button', { name: 'Terminal settings' }))
}

describe('终端设置里的任务保存区快捷键', () => {
  it('回显已保存的绑定，保存成功后采用后端回执并提示已保存', async () => {
    const view = render(<SettingsPanel />)
    openTerminalSettings(view)
    expect((view.getByLabelText('Toggle the task panel') as HTMLInputElement).value).toBe('Ctrl+`')
    expect((view.getByLabelText('Collect the current tab') as HTMLInputElement).value).toBe('Ctrl+Shift+S')
    fireEvent.change(view.getByLabelText('Toggle the task panel'), { target: { value: 'Ctrl+Shift+K' } })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save shortcuts' })) })
    expect(request.mock.calls.map(([r]) => r).filter(r => r.kind === 'preferences').at(-1)).toEqual({ kind: 'preferences', preferences: { toggleShortcut: 'Ctrl+Shift+K', collectShortcut: 'Ctrl+Shift+S' } })
    expect(useTaskShelf.getState().preferences).toEqual({ toggleShortcut: 'Ctrl+Shift+K', collectShortcut: 'Ctrl+Shift+S' })
    expect(view.getByRole('status').textContent).toContain('Shortcuts saved')
    expect((view.getByLabelText('Toggle the task panel') as HTMLInputElement).value).toBe('Ctrl+Shift+K')
  })

  it('恢复默认立即保存新的展开快捷键和收纳默认值', async () => {
    useTaskShelf.setState({ preferences: { toggleShortcut: 'Ctrl+Shift+K', collectShortcut: '' } })
    const view = render(<SettingsPanel />)
    openTerminalSettings(view)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Restore defaults' })) })
    expect(request).toHaveBeenCalledWith({ kind: 'preferences', preferences: { toggleShortcut: 'Ctrl+`', collectShortcut: 'Ctrl+Shift+S' } })
    expect((view.getByLabelText('Toggle the task panel') as HTMLInputElement).value).toBe('Ctrl+`')
  })

  it('保存失败保留草稿与旧配置，并就地提示原因', async () => {
    preferencesResponse = { success: false, error: '快捷键需使用 Ctrl/Meta+Shift+字母，不能重复或占用 P；留空可禁用。' }
    const view = render(<SettingsPanel />)
    openTerminalSettings(view)
    fireEvent.change(view.getByLabelText('Collect the current tab'), { target: { value: 'Ctrl+Shift+P' } })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save shortcuts' })) })
    expect(view.getByRole('alert').textContent).toContain('快捷键')
    expect((view.getByLabelText('Collect the current tab') as HTMLInputElement).value).toBe('Ctrl+Shift+P')
    expect(useTaskShelf.getState().preferences).toEqual(DEFAULT_TASK_SHELF_PREFERENCES)
  })

  it('保存区面板不再提供快捷键表单，只保留消费能力', () => {
    const view = render(<SettingsPanel />)
    expect(view.queryByLabelText('Toggle the task panel')).toBeNull()
    openTerminalSettings(view)
    expect(view.getByLabelText('Toggle the task panel')).toBeTruthy()
  })
})
