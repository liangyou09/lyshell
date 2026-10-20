// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceLauncherTree from './WorkspaceLauncherTree'
import type { CodeWorkspaceResult } from '@shared/code-workspaces'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => values?.name ? `${key} ${values.name}` : key }) }))
const presets = [
  { id: 'base', name: 'App', cwd: 'D:/work/app', order: 0 },
  { id: 'child', name: 'Nested', cwd: 'D:/work/app/tools', order: 1 },
  { id: 'tree', name: 'App', cwd: 'D:/work/app', order: 2, isolation: 'worktree' as const, worktreeKey: 'feature-login' }
]
const request = vi.fn<Parameters<(request: unknown) => Promise<CodeWorkspaceResult>>, Promise<CodeWorkspaceResult>>()
beforeEach(() => {
  request.mockReset().mockResolvedValue({ success: true, presets })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', codeWorkspaceRequest: request } })
})
afterEach(cleanup)

describe('Workspace 快速 PS7 启动树', () => {
  it('工作区路径逐级显示，父目录展开不启动；嵌套目录和 worktree 保留独立入口', async () => {
    const view = render(<WorkspaceLauncherTree visible />)
    const parent = await view.findByRole('button', { name: 'agents.toggleDirectory D:\\work' })
    const app = view.getByRole('button', { name: 'agents.toggleDirectory D:\\work\\app' })
    expect(view.getByText('tools')).toBeTruthy()
    fireEvent.click(parent)
    expect(view.queryByRole('button', { name: 'agents.toggleDirectory D:\\work\\app' })).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    fireEvent.click(parent)
    fireEvent.click(app)
    expect(app.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.launchPs7For App · D:/work/app' }))
    expect(request).toHaveBeenLastCalledWith({ kind: 'launch', id: 'base' })
    await view.findByText('agents.workspaceLaunched App')
    fireEvent.click(app)
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.launchPs7For App · feature-login · D:/work/app' }))
    expect(request).toHaveBeenLastCalledWith({ kind: 'launch', id: 'tree' })
    await view.findByText('agents.workspaceLaunched App · feature-login')
  })
  it('全体收放仅控制目录，隐藏内容无法被键盘访问', async () => {
    const view = render(<WorkspaceLauncherTree visible />)
    await view.findByText('feature-login')
    fireEvent.click(view.getByRole('button', { name: 'groupList.collapseAll' }))
    // 折叠后根目录本身仍可启动。
    expect(view.getAllByRole('button', { name: /launchPs7For/ })).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'groupList.expandAll' }))
    expect(view.getAllByRole('button', { name: /launchPs7For/ })).toHaveLength(5)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('加载失败可重试，空树提供新增工作区入口', async () => {
    request.mockResolvedValueOnce({ success: false, error: 'Could not load presets' }).mockResolvedValueOnce({ success: true, presets: [] })
    const manage = vi.fn()
    const view = render(<WorkspaceLauncherTree visible onManage={manage} />)
    expect(await view.findByRole('alert')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.retry' }))
    await view.findByText('workspacePresets.empty')
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.add' }))
    expect(manage).toHaveBeenCalledTimes(1)
  })
  it('点击父目录名称启动该目录，独立箭头不会误触发启动；失败可重试', async () => {
    const view = render(<WorkspaceLauncherTree visible />)
    const parent = await view.findByRole('button', { name: 'workspacePresets.launchPs7For work · D:\\work' })
    request.mockResolvedValueOnce({ success: false, error: 'Launch failed' })
    fireEvent.click(parent)
    expect(request).toHaveBeenLastCalledWith({ kind: 'launchDirectory', id: 'base', cwd: 'D:\\work' })
    const alert = await view.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'workspacePresets.retry' }))
    expect(request).toHaveBeenLastCalledWith({ kind: 'launchDirectory', id: 'base', cwd: 'D:\\work' })
    await view.findByText('agents.workspaceLaunched work')
    const calls = request.mock.calls.length
    fireEvent.click(view.getByRole('button', { name: 'agents.toggleDirectory D:\\work' }))
    expect(request).toHaveBeenCalledTimes(calls)
  })
  it('启动期间防连点，失败重试使用原预设，成功可见', async () => {
    const view = render(<WorkspaceLauncherTree visible />)
    const launch = await view.findByRole('button', { name: 'workspacePresets.launchPs7For App · D:/work/app' })
    let finish!: (result: CodeWorkspaceResult) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(launch)
    fireEvent.click(launch)
    expect(request).toHaveBeenCalledTimes(2)
    expect(view.getByRole('status').textContent).toBe('workspacePresets.launching')
    await act(async () => finish({ success: false, error: 'PS7 unavailable' }))
    const alert = view.getByRole('alert')
    expect(alert.textContent).toContain('PS7 unavailable')
    fireEvent.click(within(alert).getByRole('button', { name: 'workspacePresets.retry' }))
    expect(request).toHaveBeenLastCalledWith({ kind: 'launch', id: 'base' })
    await view.findByText('agents.workspaceLaunched App')
  })
  it('离开面板的旧请求不会覆盖重新进入后返回的路径', async () => {
    let finish!: (result: CodeWorkspaceResult) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<WorkspaceLauncherTree visible />)
    view.rerender(<WorkspaceLauncherTree visible={false} />)
    view.rerender(<WorkspaceLauncherTree visible />)
    await view.findByText('app')
    await act(async () => finish({ success: true, presets: [] }))
    expect(view.getByText('app')).toBeTruthy()
  })
  it('Agent 按设置中的目录/worktree 目标并入同一棵树，不为旧配置另建目录', async () => {
    const agents = [
      { id: 'shared-agent', cwd: 'd:\\work\\APP\\' },
      { id: 'tree-agent', cwd: 'D:/work/app', isolation: 'worktree' as const, worktreeKey: 'feature-login' },
      { id: 'legacy-agent', cwd: 'D:/other/legacy' },
      { id: 'parent-agent', cwd: 'D:/work' }
    ]
    const view = render(<WorkspaceLauncherTree visible agents={agents} renderAgent={agent => <button>{agent.id}</button>}/>)
    const shared = await view.findByRole('button', { name: 'shared-agent' })
    const tree = view.getByRole('button', { name: 'tree-agent' })
    expect(shared.closest('ul')?.id).not.toBe(tree.closest('ul')?.id)
    expect(view.queryByText('legacy')).toBeNull()
    expect(view.queryByText('agents.unassigned')).toBeNull()
    expect(view.queryByRole('button', { name: 'legacy-agent' })).toBeNull()
    expect(view.queryByRole('button', { name: 'parent-agent' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'agents.toggleDirectory App · feature-login' }))
    expect(view.queryByRole('button', { name: 'tree-agent' })).toBeNull()
    expect(view.getByRole('button', { name: 'shared-agent' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'groupList.collapseAll' }))
    expect(view.queryByRole('button', { name: 'shared-agent' })).toBeNull()
    expect(view.queryByRole('button', { name: 'legacy-agent' })).toBeNull()
  })
})
