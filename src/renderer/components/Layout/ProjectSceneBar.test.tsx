// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectScene, ProjectSceneRequest } from '@shared/project-scene'
import { ProjectSceneBar, ProjectSceneProjectActions } from './ProjectSceneBar'
import { useProjectSceneUI } from '../../stores/project-scene-ui'

const { restore, save } = vi.hoisted(() => ({ restore: vi.fn(), save: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh' } }) }))
vi.mock('../../stores/project-scene', () => ({ restoreProjectScene: restore, saveCurrentProjectScene: save }))
const presets = [
  { id: 'a', name: 'Alpha', cwd: 'C:/projects/alpha', order: 0, isolation: 'shared' as const },
  { id: 'tree', name: 'Alpha', cwd: 'C:/projects/alpha', order: 1, isolation: 'worktree' as const, worktreeKey: 'feature' },
  { id: 'b', name: 'Beta', cwd: 'C:/projects/beta', order: 2, isolation: 'shared' as const }
]
const scenes: ProjectScene[] = presets.map((preset, index) => ({ version: 1, id: `scene-${preset.id}`, savedAt: 100 + index, target: { presetId: preset.id, cwd: preset.cwd, isolation: preset.isolation, worktreeKey: 'worktreeKey' in preset ? preset.worktreeKey : undefined }, directory: preset.cwd, activeLeaf: 0, root: { type: 'leaf', active: 0, entries: [{ kind: 'directory' }] } }))
const request = vi.fn(async (input: ProjectSceneRequest) => input.kind === 'list' ? { success: true as const, scenes, issues: [] } : { success: true as const, scenes, issues: [], scene: input.kind === 'restore' ? scenes.find(scene => scene.id === input.id) : undefined })
beforeEach(() => {
  request.mockClear()
  restore.mockReset().mockResolvedValue({ restored: 1, focused: false, issues: [] })
  save.mockReset().mockResolvedValue({ success: true, scenes, scene: scenes[0], issues: [] })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', projectSceneRequest: request, codeWorkspaceRequest: async () => ({ success: true, presets }) } })
  useProjectSceneUI.setState({ loaded: true, presets, scenes, selected: scenes[0].target, busy: false, notice: null, menu: null })
})
afterEach(cleanup)

describe('project-centered scene controls', () => {
  it('shows a readable project and directly continues its latest scene without two selectors', async () => {
    const view = render(<ProjectSceneBar />)
    expect(view.queryByRole('combobox')).toBeNull()
    expect(view.getByRole('button', { name: 'Alpha' })).toBeTruthy()
    expect(view.queryByText('C:/projects/alpha')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '继续上次工作' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith({ kind: 'restore', id: 'scene-a' })
    expect(await view.findByRole('status')).toBeTruthy()
    await waitFor(() => expect(useProjectSceneUI.getState().busy).toBe(false))
  })
  it('project-side worktree continue cannot restore the shared directory snapshot', async () => {
    const view = render(<ProjectSceneProjectActions preset={presets[1]} />)
    fireEvent.click(view.getByRole('button', { name: '继续上次工作' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith({ kind: 'restore', id: 'scene-tree' })
    expect(useProjectSceneUI.getState().selected?.worktreeKey).toBe('feature')
  })
  it('keeps project-side history available when the home-only bar is absent, scoped to its worktree', async () => {
    useProjectSceneUI.setState({ selected: scenes[1].target })
    const view = render(<><ProjectSceneBar showBar={false} /><ProjectSceneProjectActions preset={presets[1]} /></>)
    expect(view.container.querySelector('.project-scene-bar')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '历史' }))
    const menu = await view.findByRole('dialog', { name: '项目现场选择' })
    await waitFor(() => expect(within(menu).getAllByRole('button', { name: '恢复此现场' })).toHaveLength(1))
    expect(within(menu).queryByText('Beta')).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: '全部项目' }))
    expect(within(menu).getAllByRole('button', { name: '恢复此现场' })).toHaveLength(3)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })
  it('switches projects by name and leaves the workspace untouched until continue is chosen', async () => {
    const view = render(<ProjectSceneBar />)
    fireEvent.click(view.getByRole('button', { name: 'Alpha' }))
    const menu = await view.findByRole('dialog')
    fireEvent.click(within(menu).getByRole('button', { name: /^Beta/ }))
    expect(useProjectSceneUI.getState().selected?.presetId).toBe('b')
    expect(restore).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '继续上次工作' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: 'restore', id: 'scene-b' }))
  })
  it('blocks repeated clicks while a continue is pending and reports focus separately', async () => {
    let finish!: (result: unknown) => void
    restore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<ProjectSceneBar />)
    const button = view.getByRole('button', { name: '继续上次工作' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    await act(async () => finish({ restored: 0, focused: true, issues: [] }))
    expect(view.getByRole('status').textContent).toBe('已定位打开的现场')
  })
  it('keeps full scope instructions and item errors collapsed by default', () => {
    useProjectSceneUI.setState({ notice: { kind: 'restored', count: 2, issues: ['README.md 已删除'] } })
    const view = render(<ProjectSceneBar />)
    const details = view.getByText('1 项提示').closest('details')!
    expect(details.open).toBe(false)
    expect(view.queryByText('保存与恢复范围')).toBeNull()
    fireEvent.click(view.getByText('1 项提示'))
    expect(details.open).toBe(true)
    expect(view.getByText('README.md 已删除')).toBeTruthy()
  })
})
