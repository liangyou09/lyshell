// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentsPanel from './AgentsPanel'
import HarnessPanel from './HarnessPanel'
import { useUiStore } from '@/stores/ui-store'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('./harness-detect', () => ({
  getCachedDetect: () => ({ codex: true, claude: true }),
  ensureDetected: vi.fn(), redetectHarness: vi.fn()
}))

const previousApi = window.electronAPI
const listProfiles = vi.fn()
beforeEach(() => {
  listProfiles.mockReset().mockResolvedValue({ profiles: [], activeProfileId: null, usage: {} })
  useUiStore.setState({ createDialogRequests: {}, openItemRequests: {} })
  window.electronAPI = {
    listAgents: async () => [],
    listCodexWorkspaces: async () => [],
    listClaudeWorkspaces: async () => [],
    codeWorkspaceRequest: async () => ({ success: true, presets: [{ id: 'preset', name: 'Project', cwd: 'D:/project', isolation: 'shared', order: 0 }] }),
    listEnvProfiles: listProfiles
  } as unknown as typeof window.electronAPI
})
afterEach(() => { cleanup(); window.electronAPI = previousApi })

describe('从引用页进入环境变量设置', () => {
  for (const source of ['codex', 'claude'] as const) {
    it(`${source} 返回后的新列表不被离开前的迟到响应覆盖`, async () => {
      type Profiles = Awaited<ReturnType<typeof window.electronAPI.listEnvProfiles>>
      let resolveOld!: (value: Profiles) => void
      const oldRequest = new Promise<Profiles>(resolve => { resolveOld = resolve })
      listProfiles.mockImplementationOnce(() => oldRequest)
      const view = render(<HarnessPanel agent={source} />)
      await act(async () => {})
      act(() => useUiStore.getState().requestCreateDialog(source))
      view.rerender(<HarnessPanel agent={source} visible={false} />)
      listProfiles.mockResolvedValue({ profiles: [{ id: 'new-profile', name: '新增变量组', env: {}, order: 0 }], activeProfileId: null, usage: {} })
      view.rerender(<HarnessPanel agent={source} />)
      const option = await view.findByRole('option', { name: /新增变量组/ })
      const select = option.parentElement as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'new-profile' } })
      await act(async () => { resolveOld({ profiles: [], activeProfileId: null, usage: {} }) })
      expect(view.getByRole('option', { name: /新增变量组/ })).toBeTruthy()
      expect(select.value).toBe('new-profile')
    })
  }

  for (const source of ['agents', 'codex', 'claude'] as const) {
    it(`${source} 暂离时隐藏弹窗、暂停 Esc，返回保留草稿并刷新变量组`, async () => {
      const openSettings = vi.fn()
      const panel = (visible: boolean) => source === 'agents'
        ? <AgentsPanel visible={visible} onOpenEnvSettings={openSettings} />
        : <HarnessPanel agent={source} visible={visible} onOpenEnvSettings={openSettings} />
      const view = render(panel(true))
      await act(async () => {})
      act(() => useUiStore.getState().requestCreateDialog(source))
      const placeholder = source === 'agents' ? 'agents.edit.namePh' : `${source}.wsModelPh`
      const input = view.getByPlaceholderText(placeholder) as HTMLInputElement
      fireEvent.change(input, { target: { value: '未保存的工作' } })
      const manageButtons = view.getAllByRole('button', { name: 'env.manage' })
      fireEvent.click(manageButtons[manageButtons.length - 1])
      expect(openSettings).toHaveBeenCalledOnce()

      view.rerender(panel(false))
      expect(view.queryByPlaceholderText(placeholder)).toBeNull()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      listProfiles.mockResolvedValue({ profiles: [{ id: 'new-profile', name: '新增变量组', env: {}, order: 0 }], activeProfileId: null, usage: {} })
      view.rerender(panel(true))
      await waitFor(() => expect(view.getByRole('option', { name: /新增变量组/ })).toBeTruthy())
      expect((view.getByPlaceholderText(placeholder) as HTMLInputElement).value).toBe('未保存的工作')
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(view.queryByPlaceholderText(placeholder)).toBeNull()
    })
  }
})
