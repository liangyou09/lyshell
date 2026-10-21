// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessWorkspace } from '@shared/harness'
import { useUiStore } from '@/stores/ui-store'
import type { CodeWorkspacePreset, CodeWorkspaceResult } from '@shared/code-workspaces'
import HarnessPanel from './HarnessPanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('./harness-detect', () => ({
  getCachedDetect: () => ({ codex: true, claude: true, dsh: true, 'dsh-tui': true }),
  ensureDetected: async () => null,
  redetectHarness: async () => null
}))

const presets: CodeWorkspacePreset[] = [{ id: 'shared', name: 'Project', cwd: 'D:/shared', order: 0, isolation: 'shared' }, { id: 'tree', name: 'Project feature', cwd: 'D:/shared', isolation: 'worktree', worktreeKey: 'feature', order: 1 }, { id: 'existing-preset', name: 'Existing project', cwd: 'D:/existing', order: 2 }]
const existing: HarnessWorkspace = { id: 'existing', name: 'Existing project', cwd: 'D:/existing', order: 0 }
const createApi = () => ({
  listCodexWorkspaces: vi.fn(async () => [existing]),
  listClaudeWorkspaces: vi.fn(async () => [existing]),
  listDshWorkspaces: vi.fn(async () => [existing]),
  codeWorkspaceRequest: vi.fn(async (): Promise<CodeWorkspaceResult> => ({ success: true, presets })),
  updateCodexWorkspace: vi.fn(async (_ws: unknown): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  updateClaudeWorkspace: vi.fn(async (_ws: unknown): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  launchCodexWorkspace: vi.fn(async (_id: string) => ({ success: true })),
  launchClaudeWorkspace: vi.fn(async (_id: string) => ({ success: true })),
  listEnvProfiles: vi.fn(async () => ({ profiles: [], activeProfileId: null })),
  addCodexWorkspace: vi.fn(async (_ws: unknown) => ({ success: true })),
  addClaudeWorkspace: vi.fn(async (_ws: unknown) => ({ success: true })),
  listHarnessWorktrees: vi.fn(async () => ({ success: true, keys: [], worktreeRoot: 'D:/shared/.lyshell-worktrees' }))
})
let api: ReturnType<typeof createApi>
beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ createDialogRequests: {}, openItemRequests: {} })
  api = createApi()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
})
afterEach(cleanup)

describe('共享工作区预选', () => {
  it.each(['codex', 'claude'] as const)('%s 新建时主动清空目录，暂离设置后仍保持未引用与名称草稿', async agent => {
    const view = render(<HarnessPanel agent={agent} />)
    fireEvent.click(await view.findByTitle(agent + '.wsAddTitle'))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('shared'))
    fireEvent.change(view.getByLabelText('settings.workspace'), { target: { value: '' } })
    fireEvent.change(view.getByLabelText(agent + '.wsModel'), { target: { value: 'Draft model' } })
    view.rerender(<HarnessPanel agent={agent} visible={false} />)
    view.rerender(<HarnessPanel agent={agent} />)
    await act(async () => {})
    expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('')
    fireEvent.click(view.getByRole('button', { name: agent + '.wsSave' }))
    const add = agent === 'codex' ? api.addCodexWorkspace : api.addClaudeWorkspace
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Project', workspacePresetId: undefined, cwd: '', isolation: 'shared', worktreeKey: undefined, model: 'Draft model' })))
  })

  it.each(['codex', 'claude'] as const)('%s 将未绑定及失效引用放入未引用工作目录，不生成临时选项', async agent => {
    const list = agent === 'codex' ? api.listCodexWorkspaces : api.listClaudeWorkspaces
    list.mockResolvedValue([{ ...existing, cwd: 'D:/unmanaged' }, { ...existing, id: 'dangling', workspacePresetId: 'deleted' }])
    const view = render(<HarnessPanel agent={agent} />)
    await act(async () => {})
    expect(view.getAllByRole('button', { name: 'Existing project' })).toHaveLength(2)
    expect(view.getByRole('group', { name: 'workspacePresets.unassigned' })).toBeTruthy()
    fireEvent.click(view.getByTitle(agent + '.wsAddTitle'))
    await view.findByLabelText('settings.workspace')
    expect(view.container.querySelector('option[value^="current-"]')).toBeNull()
  })

  it.each(['codex', 'claude'] as const)('%s 暂离设置后保留已选目标和模型草稿', async agent => {
    const view = render(<HarnessPanel agent={agent} />)
    fireEvent.click(await view.findByRole('button', { name: 'Existing project' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    fireEvent.change(view.getByLabelText('settings.workspace'), { target: { value: 'tree' } })
    fireEvent.change(view.getByLabelText(agent + '.wsModel'), { target: { value: 'Draft model' } })
    view.rerender(<HarnessPanel agent={agent} visible={false} />)
    view.rerender(<HarnessPanel agent={agent} />)
    await act(async () => {})
    expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('tree')
    fireEvent.click(view.getByRole('button', { name: agent + '.wsSave' }))
    const update = agent === 'codex' ? api.updateCodexWorkspace : api.updateClaudeWorkspace
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'D:/shared', isolation: 'worktree', worktreeKey: 'feature', model: 'Draft model' })))
  })

  it('复制工作区沿用已关联设置预设，保留启动参数', async () => {
    localStorage.setItem('lyshell.codeWorkspacePreset.v1', 'tree')
    const view = render(<HarnessPanel agent="codex" />)
    fireEvent.click(await view.findByRole('button', { name: 'Existing project' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    fireEvent.click(view.getByRole('button', { name: 'codex.copy' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    fireEvent.click(view.getByRole('button', { name: 'codex.wsSave' }))
    await waitFor(() => expect(api.addCodexWorkspace).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'D:/existing', name: 'Existing projectcodex.copySuffix', isolation: 'shared', workspacePresetId: 'existing-preset' })))
  })

  it('默认项目色跨 Codex / Claude 和列表重排保持一致', async () => {
    const items = [
      { ...existing, cwd: 'D:/workspace/claude/LyShell' },
      { id: 'other', name: 'Pet workspace', cwd: 'D:/workspace/claude/AIPet', order: 1 }
    ]
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: items.map((item, order) => ({ ...item, id: `preset-${order}` })) })
    api.listCodexWorkspaces.mockResolvedValue(items)
    api.listClaudeWorkspaces.mockResolvedValue([...items].reverse())
    const collect = (container: HTMLElement) => Object.fromEntries(
      [...container.querySelectorAll<HTMLButtonElement>('.harness-project-header')].map(header => [
        header.title, (header.parentElement as HTMLElement).style.getPropertyValue('--project-hue')
      ])
    )
    const codex = render(<HarnessPanel agent="codex" />)
    await codex.findByRole('button', { name: 'Existing project' })
    const colors = collect(codex.container)
    expect(Object.values(colors).every(Boolean)).toBe(true)
    codex.unmount()
    const claude = render(<HarnessPanel agent="claude" />)
    await claude.findByRole('button', { name: 'Existing project' })
    expect(collect(claude.container)).toEqual(colors)
  })

  it.each(['codex', 'claude'] as const)('%s 项目树可单组折叠及全部收放，不触发启动', async agent => {
    const items = [existing, { id: 'other', name: 'Another workspace', cwd: 'D:/other', order: 1 }]
    const list = agent === 'codex' ? api.listCodexWorkspaces : api.listClaudeWorkspaces
    list.mockResolvedValue(items)
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: items.map((item, order) => ({ ...item, id: `preset-${order}` })) })
    const view = render(<HarnessPanel agent={agent} />)
    await view.findByRole('button', { name: 'Existing project' })
    expect(view.container.querySelector('.scroll-dual-seg')).toBeNull()
    const header = view.getByTitle('D:/existing')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('button', { name: 'Existing project' })).toBeNull()
    expect(view.getByRole('button', { name: 'Another workspace' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'groupList.collapseAll' }))
    expect(view.queryByRole('button', { name: 'Another workspace' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'groupList.expandAll' }))
    expect(view.getByRole('button', { name: 'Existing project' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Another workspace' })).toBeTruthy()
    const launch = agent === 'codex' ? api.launchCodexWorkspace : api.launchClaudeWorkspace
    expect(launch).not.toHaveBeenCalled()
  })

  it('同名项目组保留不同父目录提示和完整路径', async () => {
    const items = [
      { ...existing, cwd: 'D:/east/Project' },
      { id: 'other', name: 'Another workspace', cwd: 'D:/west/Project', order: 1 }
    ]
    api.listCodexWorkspaces.mockResolvedValue(items)
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: items.map((item, order) => ({ ...item, id: `preset-${order}` })) })
    const view = render(<HarnessPanel agent="codex" />)
    await view.findByRole('button', { name: 'Existing project' })
    const headers = [...view.container.querySelectorAll('.harness-project-header')]
    expect(headers.map(header => header.getAttribute('title'))).toEqual(['D:/east/Project', 'D:/west/Project'])
    expect(headers.map(header => header.querySelector('.harness-project-parent')?.textContent)).toEqual(['east', 'west'])
    expect(view.getByRole('group', { name: 'D:/east/Project' })).toBeTruthy()
    expect(view.getByRole('group', { name: 'D:/west/Project' })).toBeTruthy()
  })

  it.each(['codex', 'claude'] as const)('%s 可选带 worktree 的预设，在列表内新建并直接配置', async agent => {
    const view = render(<HarnessPanel agent={agent} />)
    fireEvent.click(await view.findByTitle(agent + '.wsAddTitle'))
    const select = await view.findByLabelText('settings.workspace') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('shared'))
    fireEvent.change(select, { target: { value: 'tree' } })
    expect(select.selectedOptions[0].textContent).toBe('Project feature · feature')
    expect(view.queryByLabelText(agent + '.wsName')).toBeNull()
    expect(view.queryByLabelText(agent + '.wsCwd')).toBeNull()
    expect(view.container.querySelector('.ly-dialog-backdrop')).toBeNull()
    expect(view.container.querySelector('details')?.open).toBe(true)
    expect(view.getByRole('combobox', { name: agent + '.wsPermissions' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: agent + '.wsSave' }))
    const add = agent === 'codex' ? api.addCodexWorkspace : api.addClaudeWorkspace
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Project feature', cwd: 'D:/shared', isolation: 'worktree', worktreeKey: 'feature' })))
  })

  it('Codex 与 Claude 共享上次选定的工作区，旧配置编辑时保留原目录', async () => {
    localStorage.setItem('lyshell.codeWorkspacePreset.v1', 'tree')
    const view = render(<HarnessPanel agent="claude" />)
    fireEvent.click(await view.findByTitle('claude.wsAddTitle'))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('tree'))
    fireEvent.click(view.getByRole('button', { name: 'claude.wsCancel' }))
    fireEvent.contextMenu(await view.findByText('Existing project'))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    expect(within(view.container.querySelector('#harness-ws-detail-existing') as HTMLElement).getByText('D:/existing')).toBeTruthy()
    expect(view.queryByLabelText('claude.wsCwd')).toBeNull()
  })

  it.each(['codex', 'claude'] as const)('%s 点击工作区在原位展开配置，保存、取消和启动独立', async agent => {
    const view = render(<HarnessPanel agent={agent} />)
    const name = await view.findByRole('button', { name: 'Existing project' })
    const detail = view.container.querySelector('#harness-ws-detail-existing') as HTMLElement
    expect(detail.hidden).toBe(true)
    fireEvent.click(name)
    expect(detail.hidden).toBe(false)
    expect(view.container.querySelector('.ly-dialog-backdrop')).toBeNull()
    await waitFor(() => expect((within(detail).getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    expect(within(detail).getByText('D:/existing')).toBeTruthy()
    expect(view.queryByLabelText(agent + '.wsName')).toBeNull()
    expect(view.queryByLabelText(agent + '.wsCwd')).toBeNull()
    const launch = agent === 'codex' ? api.launchCodexWorkspace : api.launchClaudeWorkspace
    const update = agent === 'codex' ? api.updateCodexWorkspace : api.updateClaudeWorkspace
    expect(launch).not.toHaveBeenCalled()
    fireEvent.change(within(detail).getByLabelText(agent + '.wsModel'), { target: { value: 'Draft model' } })
    fireEvent.click(within(detail).getByRole('button', { name: agent + '.wsCancel' }))
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(name)
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    expect((view.getByLabelText(agent + '.wsModel') as HTMLInputElement).value).toBe('')
    fireEvent.change(view.getByLabelText('settings.workspace'), { target: { value: 'tree' } })
    fireEvent.change(view.getByLabelText(agent + '.wsModel'), { target: { value: 'Saved model' } })
    fireEvent.click(view.getByRole('button', { name: agent + '.wsSave' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing', name: 'Project feature', cwd: 'D:/shared', isolation: 'worktree', worktreeKey: 'feature', model: 'Saved model' })))
    await waitFor(() => expect(detail.hidden).toBe(true))
    fireEvent.click(view.getByRole('button', { name: agent + '.launch · Existing project' }))
    await waitFor(() => expect(launch).toHaveBeenCalledWith('existing'))
    expect(detail.hidden).toBe(true)
  })

  it('保存拒绝和异常时保留编辑内容，重试后收起', async () => {
    const view = render(<HarnessPanel agent="codex" />)
    fireEvent.click(await view.findByRole('button', { name: 'Existing project' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    fireEvent.change(view.getByLabelText('codex.wsModel'), { target: { value: 'Keep draft' } })
    api.updateCodexWorkspace.mockResolvedValueOnce({ success: false, error: 'Disk denied' })
    fireEvent.click(view.getByRole('button', { name: 'codex.wsSave' }))
    await view.findByText('Disk denied')
    expect((view.getByLabelText('codex.wsModel') as HTMLInputElement).value).toBe('Keep draft')
    api.updateCodexWorkspace.mockRejectedValueOnce(new Error('Connection lost'))
    fireEvent.click(view.getByRole('button', { name: 'codex.wsSave' }))
    await view.findByText('Connection lost')
    expect((view.getByLabelText('codex.wsModel') as HTMLInputElement).value).toBe('Keep draft')
    fireEvent.click(view.getByRole('button', { name: 'codex.wsSave' }))
    await waitFor(() => expect(view.queryByLabelText('codex.wsModel')).toBeNull())
  })

  it.each(['codex', 'claude'] as const)('%s 模型菜单可选候选，Escape 只收候选且模型可保存', async agent => {
    const view = render(<HarnessPanel agent={agent} />)
    fireEvent.click(await view.findByRole('button', { name: 'Existing project' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    const input = view.getByLabelText(agent + '.wsModel')
    expect(input.getAttribute('list')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.modelSuggestions' }))
    const selected = agent === 'claude' ? 'claude-sonnet-5' : 'gpt-5-codex'
    fireEvent.click(view.getByRole('option', { name: selected }))
    expect((input as HTMLInputElement).value).toBe(selected)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(view.queryByRole('listbox')).toBeNull()
    expect(view.getByLabelText(agent + '.wsModel')).toBe(input)
    fireEvent.click(view.getByRole('button', { name: agent + '.wsSave' }))
    const update = agent === 'claude' ? api.updateClaudeWorkspace : api.updateCodexWorkspace
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ model: selected })))
  })

  it('保存期间禁用表单并阻止重复提交和切换', async () => {
    let finish!: (value: { success: boolean }) => void
    api.updateCodexWorkspace.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<HarnessPanel agent="codex" />)
    fireEvent.click(await view.findByRole('button', { name: 'Existing project' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('existing-preset'))
    fireEvent.click(view.getByRole('button', { name: 'codex.wsSave' }))
    fireEvent.click(view.getByRole('button', { name: 'workspacePresets.saving' }))
    fireEvent.click(view.getByTitle('codex.wsAddTitle'))
    expect(api.updateCodexWorkspace).toHaveBeenCalledOnce()
    expect(view.getByLabelText('codex.wsModel').closest('fieldset')?.disabled).toBe(true)
    finish({ success: true })
    await waitFor(() => expect(view.queryByLabelText('codex.wsModel')).toBeNull())
  })

  it('dsh 工作区卡保留整行详情(无下拉开关)', async () => {
    const view = render(<HarnessPanel agent="dsh" />)
    await view.findByText('Existing project')
    expect(view.queryByRole('button', { name: 'dsh.wsDetailShow' })).toBeNull()
    // dsh 卡没有折叠容器,详情区不出现(备注为空时不渲染额外行)
    expect(view.container.querySelector('#harness-ws-detail-existing')).toBeNull()
  })

  it('被合并条目的上次选择会恢复到同一目录的保留项', async () => {
    localStorage.setItem('lyshell.codeWorkspacePreset.v1', 'merged-tree')
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets, aliases: { 'merged-tree': 'tree' } })
    const view = render(<HarnessPanel agent="codex" />)
    fireEvent.click(await view.findByTitle('codex.wsAddTitle'))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe('tree'))
  })

  it('没有预设时允许保存未绑定启动器，并提供设置入口', async () => {
    api.codeWorkspaceRequest.mockResolvedValue({ success: true, presets: [] })
    const open = vi.fn()
    const view = render(<HarnessPanel agent="codex" onOpenWorkspaceSettings={open} />)
    fireEvent.click(await view.findByTitle('codex.wsAddTitle'))
    fireEvent.click(view.getByRole('button', { name: 'codex.wsSave' }))
    await waitFor(() => expect(api.addCodexWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspacePresetId: undefined, cwd: '' })))
    fireEvent.click(view.getByTitle('codex.wsAddTitle'))
    await view.findByLabelText('settings.workspace')
    fireEvent.click(view.getAllByRole('button', { name: 'workspacePresets.manage' }).at(-1)!)
    expect(open).toHaveBeenCalledOnce()
  })
  it.each(['codex', 'claude'] as const)('%s 清空目录绑定后保留可启动、可编辑的配置，保存不会自动改绑', async agent => {
    const detached = { ...existing, cwd: '', model: 'keep-model', envProfileId: undefined }
    const list = agent === 'codex' ? api.listCodexWorkspaces : api.listClaudeWorkspaces
    list.mockResolvedValue([detached])
    const view = render(<HarnessPanel agent={agent} />)
    const group = await view.findByRole('group', { name: 'workspacePresets.unassigned' })
    fireEvent.click(within(group).getByRole('button', { name: `${agent}.launch · Existing project` }))
    const launch = agent === 'codex' ? api.launchCodexWorkspace : api.launchClaudeWorkspace
    await waitFor(() => expect(launch).toHaveBeenCalledWith('existing'))
    fireEvent.click(within(group).getByRole('button', { name: 'Existing project' }))
    await waitFor(() => expect((view.getByLabelText('settings.workspace') as HTMLSelectElement).value).toBe(''))
    expect((view.getByLabelText(agent + '.wsModel') as HTMLInputElement).value).toBe('keep-model')
    fireEvent.click(view.getByRole('button', { name: agent + '.wsSave' }))
    const update = agent === 'codex' ? api.updateCodexWorkspace : api.updateClaudeWorkspace
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing', workspacePresetId: undefined, cwd: '', model: 'keep-model' })))
  })
})
