// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentsPanel from './AgentsPanel'
import { useUiStore } from '@/stores/ui-store'
import type { CodeWorkspaceResult } from '@shared/code-workspaces'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))

const agents = [
  { id: 'claude', name: 'Claude project', command: 'claude', cwd: 'D:/projects/App', order: 0 },
  { id: 'codex', name: 'Codex project', command: 'codex', cwd: 'D:/projects/App/', order: 1 },
  { id: 'global', name: 'Global agent', command: 'custom-agent', order: 2 }
]
const api = {
  platform: 'win32',
  codeWorkspaceRequest: vi.fn(async (_request: unknown): Promise<CodeWorkspaceResult> => ({ success: true, presets: [] })),
  listAgents: vi.fn(async () => agents),
  listEnvProfiles: vi.fn(async () => ({ profiles: [], activeProfileId: null })),
  launchAgent: vi.fn(async (_id: string) => ({ success: true })),
  deleteAgent: vi.fn(async (_id: string) => ({ success: true })),
  addAgent: vi.fn(async (_agent: unknown) => ({ success: true })),
  updateAgent: vi.fn(async (_agent: unknown) => ({ success: true }))
}
beforeEach(() => {
  vi.clearAllMocks()
  api.updateAgent.mockReset().mockResolvedValue({ success: true })
  api.codeWorkspaceRequest.mockReset().mockResolvedValue({ success: true, presets: [{ id: 'app', name: 'App', cwd: 'D:/projects/App', isolation: 'shared', order: 0 }] })
  localStorage.removeItem('lyshell.codeWorkspacePreset.v1')
  useUiStore.setState({ createDialogRequests: {} })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
})
afterEach(cleanup)

describe('Agents 项目树', () => {
  it('新建时主动清空目录，候选刷新后仍保持未引用', async () => {
    const view = render(<AgentsPanel />)
    await view.findByRole('button', { name: 'Claude project' })
    fireEvent.click(view.getByRole('button', { name: 'panelHeader.add' }))
    fireEvent.click(view.getByRole('button', { name: 'sidebar.addAgent' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('app'))
    fireEvent.change(view.getByLabelText('settings.workspace'), { target: { value: '' } })
    fireEvent.change(view.getByPlaceholderText('claude'), { target: { value: 'custom-agent' } })
    view.rerender(<AgentsPanel visible={false} />)
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: [{ id: 'app', name: 'App', cwd: 'D:/projects/App', isolation: 'shared', order: 0 }] })
    view.rerender(<AgentsPanel />)
    await act(async () => {})
    expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('')
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentSave' }))
    await waitFor(() => expect(api.addAgent).toHaveBeenCalledWith(expect.objectContaining({ command: 'custom-agent', workspacePresetId: undefined, cwd: undefined, isolation: 'shared', worktreeKey: undefined })))
  })

  it('同仓库的不同 worktree 保留独立入口，启动失败可见且阻止重复启动', async () => {
    const presets = [
      { id: 'plain', name: 'Project', cwd: 'D:/repo', order: 0 },
      { id: 'duplicate', name: 'Alias', cwd: 'd:/repo/', order: 1 },
      { id: 'one', name: 'Project', cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'one', order: 2 },
      { id: 'two', name: 'Project', cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'two', order: 3 }
    ]
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets })
    const view = render(<AgentsPanel />)
    await view.findByTitle('D:/repo · one')
    const one = view.getByTitle('D:/repo · one')
    expect(view.getByTitle('D:/repo · two')).toBeTruthy()
    expect(view.container.querySelectorAll('.workspace-launcher-launch')).toHaveLength(4)
    let finish!: (result: CodeWorkspaceResult) => void
    api.codeWorkspaceRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(one)
    fireEvent.click(one)
    expect(api.codeWorkspaceRequest).toHaveBeenLastCalledWith({ kind: 'launch', id: 'one' })
    expect(api.codeWorkspaceRequest).toHaveBeenCalledTimes(2)
    await act(async () => finish({ success: false, error: 'PowerShell 7 was not found' }))
    expect(view.getByRole('alert').textContent).toContain('PowerShell 7 was not found')
    expect((one as HTMLButtonElement).disabled).toBe(false)
  })

  it('从设置返回后刷新工作区启动入口', async () => {
    const view = render(<AgentsPanel />)
    await view.findByRole('button', { name: 'Claude project' })
    view.rerender(<AgentsPanel visible={false} />)
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: [{ id: 'new', name: 'New', cwd: 'D:/new', order: 0 }] })
    view.rerender(<AgentsPanel />)
    await waitFor(() => expect(view.getByTitle('D:/new')).toBeTruthy())
  })

  it('只展示设置管辖的目标，单组与全体收放不会启动 Agent', async () => {
    const view = render(<AgentsPanel />)
    await view.findByRole('button', { name: 'Claude project' })
    expect(view.container.querySelectorAll('.group-list-actions')).toHaveLength(1)
    expect(view.container.querySelectorAll('.workspace-launcher')).toHaveLength(1)
    expect(view.queryByText('agents.cliAgents')).toBeNull()
    expect(view.container.querySelectorAll('.workspace-launcher-label')).toHaveLength(4)
    expect(view.container.querySelector('.scroll-dual-seg')).toBeNull()
    const header = view.getByTitle('D:/projects/App').previousElementSibling as HTMLElement
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('button', { name: 'Claude project' })).toBeNull()
    expect(view.getByRole('button', { name: 'Global agent' })).toBeTruthy()
    expect(view.queryByText('agents.unassigned')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'groupList.collapseAll' }))
    expect(view.queryByRole('button', { name: 'Global agent' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'groupList.expandAll' }))
    expect(view.getByRole('button', { name: 'Claude project' })).toBeTruthy()
    expect(api.launchAgent).not.toHaveBeenCalled()
  })

  it('行按钮启动目标，编辑与删除确认不会触发启动', async () => {
    const view = render(<AgentsPanel />)
    const launch = await view.findByRole('button', { name: 'Claude project' })
    fireEvent.click(launch)
    expect(api.launchAgent).toHaveBeenCalledTimes(1)
    expect(api.launchAgent).toHaveBeenCalledWith('claude')
    const row = launch.parentElement as HTMLElement
    fireEvent.click(within(row).getByTitle('sidebar.agentDelete'))
    expect(api.deleteAgent).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByTitle('sidebar.agentEditTitle'))
    expect(view.getByDisplayValue('Claude project')).toBeTruthy()
    expect(api.launchAgent).toHaveBeenCalledTimes(1)
  })
  it('箭头展开行内编辑，取消和 Esc 不保存，保存沿用设置工作区关联', async () => {
    const view = render(<AgentsPanel />)
    const launch = await view.findByRole('button', { name: 'Claude project' })
    const toggle = within(launch.parentElement as HTMLElement).getByTitle('sidebar.agentEditTitle')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('.ly-dialog-backdrop')).toBeNull()
    fireEvent.change(view.getByLabelText('agents.edit.command'), { target: { value: 'claude --resume' } })
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentCancel' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    expect(api.updateAgent).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect((view.getByLabelText('agents.edit.command') as HTMLInputElement).value).toBe('claude')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(view.queryByLabelText('agents.edit.command')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.change(view.getByLabelText('agents.edit.command'), { target: { value: 'claude --continue' } })
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentSave' }))
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
    expect(api.updateAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude', command: 'claude --continue', workspacePresetId: 'app', cwd: 'D:/projects/App' }))
    expect(api.launchAgent).not.toHaveBeenCalled()
  })
  it('保存期间阻止重复提交和收起，失败后保留草稿并能重试', async () => {
    let finish!: (value: { success: boolean; error?: string }) => void
    api.updateAgent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<AgentsPanel />)
    const launch = await view.findByRole('button', { name: 'Claude project' })
    const toggle = within(launch.parentElement as HTMLElement).getByTitle('sidebar.agentEditTitle')
    fireEvent.click(toggle)
    fireEvent.change(view.getByLabelText('agents.edit.command'), { target: { value: 'claude --resume' } })
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentSave' }))
    fireEvent.click(view.getByRole('button', { name: 'agents.edit.saving' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(api.updateAgent).toHaveBeenCalledOnce()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await act(async () => finish({ success: false, error: 'Disk full' }))
    expect(view.getByRole('alert').textContent).toBe('Disk full')
    expect((view.getByLabelText('agents.edit.command') as HTMLInputElement).value).toBe('claude --resume')
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentSave' }))
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
  })
  it('新增 Agent 与 Harness 共用设置工作区选择，额外保存启动命令和所选 worktree', async () => {
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: [
      { id: 'app', name: 'App', cwd: 'D:/projects/App', isolation: 'shared', order: 0 },
      { id: 'tree', name: 'Feature', cwd: 'D:/projects/App', isolation: 'worktree', worktreeKey: 'feature', order: 1 }
    ] })
    const view = render(<AgentsPanel />)
    await view.findByRole('button', { name: 'Claude project' })
    fireEvent.click(view.getByRole('button', { name: 'panelHeader.add' }))
    fireEvent.click(view.getByRole('button', { name: 'sidebar.addAgent' }))
    const select = await view.findByLabelText('settings.workspace')
    fireEvent.change(select, { target: { value: 'tree' } })
    fireEvent.change(view.getByPlaceholderText('claude'), { target: { value: 'custom-agent --serve' } })
    expect(view.queryByPlaceholderText('~/projects/lyshell')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentSave' }))
    await waitFor(() => expect(api.addAgent).toHaveBeenCalledWith(expect.objectContaining({ command: 'custom-agent --serve', cwd: 'D:/projects/App', isolation: 'worktree', worktreeKey: 'feature' })))
  })

  it('没有设置工作区时仍能新建未引用目录的启动器，保留设置入口', async () => {
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: [] })
    const manage = vi.fn()
    const view = render(<AgentsPanel onOpenWorkspaceSettings={manage} />)
    await view.findByRole('button', { name: 'Global agent' })
    fireEvent.click(view.getByRole('button', { name: 'panelHeader.add' }))
    fireEvent.click(view.getByRole('button', { name: 'sidebar.addAgent' }))
    fireEvent.change(view.getByPlaceholderText('claude'), { target: { value: 'custom-agent' } })
    fireEvent.click(view.getByRole('button', { name: 'sidebar.agentSave' }))
    await waitFor(() => expect(api.addAgent).toHaveBeenCalledWith(expect.objectContaining({ command: 'custom-agent', workspacePresetId: undefined, cwd: undefined })))
    fireEvent.click(view.getByRole('button', { name: 'panelHeader.add' }))
    fireEvent.click(view.getByRole('button', { name: 'sidebar.addAgent' }))
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.manage' }))
    expect(manage).toHaveBeenCalledOnce()
  })
  it('Agent 启动错误可见，失败后允许重试', async () => {
    api.launchAgent.mockRejectedValueOnce(new Error('Custom command was not found'))
    const view = render(<AgentsPanel />)
    const launch = await view.findByRole('button', { name: 'Claude project' })
    fireEvent.click(launch)
    expect((await view.findByRole('alert')).textContent).toContain('Custom command was not found')
    expect((launch as HTMLButtonElement).disabled).toBe(false)
  })
})
