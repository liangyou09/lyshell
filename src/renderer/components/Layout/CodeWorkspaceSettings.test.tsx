// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeWorkspacePreset, CodeWorkspaceRequest, CodeWorkspaceResult } from '@shared/code-workspaces'
import CodeWorkspaceSettings from './CodeWorkspaceSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number }) => values?.count !== undefined ? `${key}:${values.count}` : key }) }))
const presets: CodeWorkspacePreset[] = [
  { id: 'one', order: 0, name: 'First', cwd: 'D:/first' },
  { id: 'two', order: 1, name: 'Second', cwd: 'D:/second', isolation: 'worktree', worktreeKey: 'feature' }
]
const request = vi.fn<Parameters<(request: CodeWorkspaceRequest) => void>, Promise<CodeWorkspaceResult>>()
beforeEach(() => {
  request.mockReset().mockResolvedValue({ success: true, presets })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    codeWorkspaceRequest: request,
    listHarnessWorktrees: vi.fn(async () => ({ success: true, keys: ['feature'] }))
  } })
})
afterEach(cleanup)

describe('工作区设置行内配置', () => {
  it('无法刷新引用数时不允许确认删除，展示错误并保留原工作区', async () => {
    const view = render(<CodeWorkspaceSettings />)
    await view.findByRole('button', { name: /First.*D:\/first/ })
    request.mockResolvedValueOnce({ success: false, error: 'Usage unavailable' })
    fireEvent.click(view.getAllByRole('button', { name: 'workspacePresets.delete' })[0])
    expect((await view.findByRole('alert')).textContent).toContain('Usage unavailable')
    expect(view.queryByRole('button', { name: 'workspacePresets.confirmDelete' })).toBeNull()
    expect(request).not.toHaveBeenCalledWith({ kind: 'delete', id: 'one' })
    expect(view.getByRole('button', { name: /First.*D:\/first/ })).toBeTruthy()
  })
  it('删除前刷新并显示引用数，取消不删除，确认后清除列表项', async () => {
    const view = render(<CodeWorkspaceSettings />)
    await view.findByRole('button', { name: /First.*D:\/first/ })
    request.mockResolvedValueOnce({ success: true, presets, usage: { one: 3 } })
    fireEvent.click(view.getAllByRole('button', { name: 'workspacePresets.delete' })[0])
    expect(await view.findByText('workspacePresets.deleteReferences:3')).toBeTruthy()
    expect(request).not.toHaveBeenCalledWith({ kind: 'delete', id: 'one' })
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.cancel' }))
    expect(view.queryByText('workspacePresets.deleteReferences:3')).toBeNull()
    request.mockResolvedValueOnce({ success: true, presets, usage: { one: 4 } })
    fireEvent.click(view.getAllByRole('button', { name: 'workspacePresets.delete' })[0])
    await view.findByText('workspacePresets.deleteReferences:4')
    request.mockResolvedValueOnce({ success: true, presets: [presets[1]] })
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.confirmDelete' }))
    await waitFor(() => expect(view.queryByRole('button', { name: /First.*D:\/first/ })).toBeNull())
    expect(request).toHaveBeenLastCalledWith({ kind: 'delete', id: 'one' })
  })
  it('目录隔离与 worktree 候选采用统一选择器，保留必填、长度约束及保存参数', async () => {
    const view = render(<CodeWorkspaceSettings />)
    fireEvent.click(await view.findByRole('button', { name: /First.*D:\/first/ }))
    fireEvent.change(view.getByLabelText('workspacePresets.directoryIsolation'), { target: { value: 'worktree' } })
    const input = view.getByLabelText('workspacePresets.worktreeName') as HTMLInputElement
    expect(input.required).toBe(true)
    expect(input.maxLength).toBe(64)
    expect(input.getAttribute('list')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.chooseWorktree' }))
    fireEvent.click(await view.findByRole('option', { name: 'feature' }))
    expect(input.value).toBe('feature')
    expect(view.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(view.container.querySelector('form')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.save' }))
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: 'save', preset: { ...presets[0], isolation: 'worktree', worktreeKey: 'feature' } }))
  })

  it('从已保存的工作区启动 PS7，启动中禁止重复提交', async () => {
    const view = render(<CodeWorkspaceSettings />)
    const buttons = await view.findAllByRole('button', { name: 'workspacePresets.launchPs7For' })
    let finish!: (result: CodeWorkspaceResult) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(buttons[1])
    fireEvent.click(buttons[1])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith({ kind: 'launch', id: 'two' })
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByRole('status').textContent).toBe('workspacePresets.launching')
    finish({ success: true, presets })
    await waitFor(() => expect((buttons[1] as HTMLButtonElement).disabled).toBe(false))
    expect(view.getByRole('button', { name: /Second.*D:\/second/ })).toBeTruthy()
  })

  it('启动失败显示具体原因，完成后可以重试', async () => {
    const view = render(<CodeWorkspaceSettings />)
    const buttons = await view.findAllByRole('button', { name: 'workspacePresets.launchPs7For' })
    request.mockResolvedValueOnce({ success: false, error: 'PowerShell 7 was not found' })
    fireEvent.click(buttons[0])
    expect((await view.findByRole('alert')).textContent).toContain('PowerShell 7 was not found')
    fireEvent.click(buttons[0])
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull())
    expect(request).toHaveBeenLastCalledWith({ kind: 'launch', id: 'one' })
  })

  it('未保存的编辑不会被误用作启动配置', async () => {
    const view = render(<CodeWorkspaceSettings />)
    fireEvent.click(await view.findByRole('button', { name: /First.*D:\/first/ }))
    for (const button of view.getAllByRole('button', { name: 'workspacePresets.launchPs7For' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.cancel' }))
    for (const button of view.getAllByRole('button', { name: 'workspacePresets.launchPs7For' })) {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it('保留列表，在所选行下方编辑；取消丢弃草稿，保存成功收起', async () => {
    const view = render(<CodeWorkspaceSettings />)
    const first = await view.findByRole('button', { name: /First.*D:\/first/ })
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('button', { name: /Second.*D:\/second/ })).toBeTruthy()
    const form = view.container.querySelector('form')!
    expect(first.closest('.code-workspace-item')?.contains(form)).toBe(true)
    fireEvent.change(within(form).getByLabelText('workspacePresets.name'), { target: { value: 'Unsaved' } })
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.cancel' }))
    expect(view.container.querySelector('form')).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    fireEvent.click(first)
    expect((view.getByLabelText('workspacePresets.name') as HTMLInputElement).value).toBe('First')
    fireEvent.change(view.getByLabelText('workspacePresets.name'), { target: { value: 'Renamed' } })
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.save' }))
    await waitFor(() => expect(view.container.querySelector('form')).toBeNull())
    expect(request).toHaveBeenLastCalledWith({ kind: 'save', preset: { ...presets[0], name: 'Renamed' } })
  })

  it('保存失败保留草稿及列表，可重试成功', async () => {
    const view = render(<CodeWorkspaceSettings />)
    fireEvent.click(await view.findByRole('button', { name: /Second.*D:\/second/ }))
    fireEvent.change(view.getByLabelText('workspacePresets.name'), { target: { value: 'Draft' } })
    request.mockResolvedValueOnce({ success: false, error: 'Save denied' })
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.save' }))
    expect((await view.findByRole('alert')).textContent).toBe('Save denied')
    expect((view.getByLabelText('workspacePresets.name') as HTMLInputElement).value).toBe('Draft')
    expect(view.getByRole('button', { name: /First.*D:\/first/ })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.save' }))
    await waitFor(() => expect(view.container.querySelector('form')).toBeNull())
  })

  it('Escape 取消草稿并恢复焦点，保存期间不关闭编辑器', async () => {
    const view = render(<CodeWorkspaceSettings />)
    const opener = await view.findByRole('button', { name: /First.*D:\/first/ })
    fireEvent.click(opener)
    fireEvent.change(view.getByLabelText('workspacePresets.name'), { target: { value: 'Unsaved' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.querySelector('form')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    fireEvent.click(opener)
    expect((view.getByLabelText('workspacePresets.name') as HTMLInputElement).value).toBe('First')
    let finish!: (result: CodeWorkspaceResult) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.submit(view.container.querySelector('form')!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.querySelector('form')).toBeTruthy()
    finish({ success: true, presets })
    await waitFor(() => expect(view.container.querySelector('form')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('新增在列表顶部展开，保存中禁止重复提交', async () => {
    const view = render(<CodeWorkspaceSettings />)
    await view.findByRole('button', { name: /First.*D:\/first/ })
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.add' }))
    const form = view.container.querySelector('form')!
    expect(form.compareDocumentPosition(view.container.querySelector('.code-workspace-item')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.change(view.getByLabelText('workspacePresets.name'), { target: { value: 'New' } })
    fireEvent.change(view.getByLabelText('settings.workspaceDefaultCwd'), { target: { value: 'D:/new' } })
    let finish!: (result: CodeWorkspaceResult) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(request).toHaveBeenCalledTimes(2)
    expect((view.getByLabelText('workspacePresets.name') as HTMLInputElement).disabled).toBe(true)
    finish({ success: true, presets })
    await waitFor(() => expect(view.container.querySelector('form')).toBeNull())
  })
})
