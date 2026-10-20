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
  deleteAgent: vi.fn(async (_id: string) => ({ success: true }))
}
beforeEach(() => {
  vi.clearAllMocks()
  api.codeWorkspaceRequest.mockReset().mockResolvedValue({ success: true, presets: [] })
  useUiStore.setState({ createDialogRequests: {} })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
})
afterEach(cleanup)

describe('Agents 项目树', () => {
  it('同仓库的不同 worktree 保留独立入口，启动失败可见且阻止重复启动', async () => {
    const presets = [
      { id: 'plain', name: 'Project', cwd: 'D:/repo', order: 0 },
      { id: 'duplicate', name: 'Alias', cwd: 'd:/repo/', order: 1 },
      { id: 'one', name: 'Project', cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'one', order: 2 },
      { id: 'two', name: 'Project', cwd: 'D:/repo', isolation: 'worktree' as const, worktreeKey: 'two', order: 3 }
    ]
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets })
    const view = render(<AgentsPanel />)
    const one = await view.findByTitle('D:/repo · one')
    expect(view.getByTitle('D:/repo · two')).toBeTruthy()
    expect(view.container.querySelectorAll('.agents-work-launcher button')).toHaveLength(3)
    let finish!: (result: CodeWorkspaceResult) => void
    api.codeWorkspaceRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(one)
    fireEvent.click(one)
    expect(api.codeWorkspaceRequest).toHaveBeenLastCalledWith({ kind: 'launch', id: 'one' })
    expect(api.codeWorkspaceRequest).toHaveBeenCalledTimes(2)
    await act(async () => finish({ success: false, error: 'PowerShell 7 was not found' }))
    expect(view.getByText('PowerShell 7 was not found')).toBeTruthy()
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

  it('同目录归组、未指定目录置底，单组与全体收放不会启动 Agent', async () => {
    const view = render(<AgentsPanel />)
    await view.findByRole('button', { name: 'Claude project' })
    const headers = [...view.container.querySelectorAll('.harness-project-header')]
    expect(headers.map(header => header.textContent)).toEqual(['App2', 'agents.groupNoDir1'])
    expect(view.container.querySelector('.scroll-dual-seg')).toBeNull()
    const header = view.getByTitle('D:/projects/App')
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('button', { name: 'Claude project' })).toBeNull()
    expect(view.getByRole('button', { name: 'Global agent' })).toBeTruthy()
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
})
