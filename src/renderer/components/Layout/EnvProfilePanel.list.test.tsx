// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EnvProfilePanel from './EnvProfilePanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))

const profiles = [
  { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.example.com', apiKey: 'secret-needle', env: { TOKEN: 'private-value' }, order: 0 },
  { id: 'b', name: 'GLM', baseUrl: 'http://localhost:8080', note: '团队开发', env: {}, order: 1 }
]
const previousApi = window.electronAPI
let activeProfileId: string | null
const setActive = vi.fn(async (id: string | null) => { activeProfileId = id; return { success: true } })
beforeEach(() => {
  activeProfileId = 'a'
  setActive.mockClear()
  window.electronAPI = {
    listEnvProfiles: async () => ({ profiles, activeProfileId, usage: {} }),
    setEnvProfileActive: setActive,
    deleteEnvProfile: vi.fn(async () => ({ success: true }))
  } as unknown as typeof window.electronAPI
})
afterEach(() => { cleanup(); window.electronAPI = previousApi })

describe('环境变量列表', () => {
  it('仅配置密钥的变量组显示凭据状态，实际凭据保持隐藏', async () => {
    window.electronAPI.listEnvProfiles = vi.fn(async () => ({ profiles: [{ id: 'key-only', name: 'Key only', apiKey: 'private-key-only', env: {}, order: 0 }], activeProfileId: null, usage: {} }))
    const view = render(<EnvProfilePanel embedded />)
    const profile = await view.findByRole('button', { name: 'Key only' })
    expect(profile.textContent).toContain('env.keyPresent')
    expect(profile.textContent).not.toContain('private-key-only')
  })

  it('支持按名称、地址、备注搜索，清空后恢复列表；凭据和值不参与搜索', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    const search = view.getByRole('searchbox', { name: 'env.search' })
    for (const query of ['glm', 'LOCALHOST', '团队']) {
      fireEvent.change(search, { target: { value: query } })
      expect(view.getByRole('switch', { name: 'GLM' })).toBeTruthy()
      expect(view.queryByRole('switch', { name: 'DeepSeek' })).toBeNull()
    }
    for (const query of ['secret-needle', 'private-value']) {
      fireEvent.change(search, { target: { value: query } })
      expect(view.queryAllByRole('switch')).toHaveLength(0)
      expect(view.getByRole('status').textContent).toContain('env.noMatches')
    }
    fireEvent.click(within(view.getByRole('status')).getByRole('button', { name: 'env.clearSearch' }))
    expect(view.getAllByRole('switch')).toHaveLength(2)
    expect(setActive).not.toHaveBeenCalled()
  })

  it('启用状态采用后端回读，切换到另一个组后仍保持单选', async () => {
    const view = render(<EnvProfilePanel embedded />)
    const first = await view.findByRole('switch', { name: 'DeepSeek' })
    expect(first.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(view.getByRole('switch', { name: 'GLM' }))
    await waitFor(() => expect(view.getByRole('switch', { name: 'GLM' }).getAttribute('aria-checked')).toBe('true'))
    expect(first.getAttribute('aria-checked')).toBe('false')
    expect(setActive).toHaveBeenCalledWith('b')
    fireEvent.click(view.getByRole('switch', { name: 'GLM' }))
    await waitFor(() => expect(view.getByRole('switch', { name: 'GLM' }).getAttribute('aria-checked')).toBe('false'))
    expect(setActive).toHaveBeenLastCalledWith(null)
  })

  it('编辑、复制是开关以外的独立按钮，操作不会切换全局启用组', async () => {
    const view = render(<EnvProfilePanel embedded />)
    const toggle = await view.findByRole('switch', { name: 'DeepSeek' })
    expect(toggle.querySelector('button')).toBeNull()

    fireEvent.click(view.getAllByRole('button', { name: 'env.editTitle' })[0])
    expect(view.getByRole('region', { name: 'env.editTitle' })).toBeTruthy()
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'env.cancel' }))

    fireEvent.click(view.getAllByRole('button', { name: 'env.copy' })[0])
    expect((view.getByPlaceholderText('env.namePh') as HTMLInputElement).value).toBe('DeepSeekenv.copySuffix')
    expect(setActive).not.toHaveBeenCalled()
  })


  it('单击条目即选中并启用，再点已启用条目保持启用；各条目编辑自己的配置', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'GLM' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'GLM' }).getAttribute('aria-pressed')).toBe('true'))
    expect(view.getByRole('switch', { name: 'GLM' }).getAttribute('aria-checked')).toBe('true')
    expect(view.getByRole('switch', { name: 'DeepSeek' }).getAttribute('aria-checked')).toBe('false')
    expect(setActive).toHaveBeenCalledWith('b')
    fireEvent.click(view.getByRole('button', { name: 'GLM' }))
    expect(setActive).toHaveBeenCalledTimes(1)
    fireEvent.click(within(view.getByRole('group', { name: 'DeepSeek' })).getByRole('button', { name: 'env.editTitle' }))
    expect((view.getByLabelText('env.name') as HTMLInputElement).value).toBe('DeepSeek')
    expect(setActive).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: 'env.cancel' }))
    fireEvent.click(within(view.getByRole('group', { name: 'GLM' })).getByRole('button', { name: 'env.editTitle' }))
    expect((view.getByLabelText('env.name') as HTMLInputElement).value).toBe('GLM')
  })

  it('各条目提供独立操作，Esc 可撤回删除确认，删除仍需再次点击', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    expect(view.getAllByRole('button', { name: 'env.editTitle' })).toHaveLength(2)
    expect(view.getAllByRole('button', { name: 'env.copy' })).toHaveLength(2)
    expect(view.getAllByRole('button', { name: 'env.delete' })).toHaveLength(2)
    expect(view.queryByRole('menu')).toBeNull()
    fireEvent.click(view.getAllByRole('button', { name: 'env.delete' })[0])
    fireEvent.keyDown(view.getByRole('button', { name: 'env.confirmDelete' }), { key: 'Escape' })
    expect(view.queryByRole('button', { name: 'env.confirmDelete' })).toBeNull()
    fireEvent.click(view.getAllByRole('button', { name: 'env.delete' })[0])
    expect(window.electronAPI.deleteEnvProfile).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'env.confirmDelete' }))
    await waitFor(() => expect(window.electronAPI.deleteEnvProfile).toHaveBeenCalledWith('a'))
    expect(view.queryByRole('menu')).toBeNull()
    expect(setActive).not.toHaveBeenCalled()
  })
})
