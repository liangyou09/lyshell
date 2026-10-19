// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEnvProfile } from '@shared/harness'
import { useUiStore } from '@/stores/ui-store'
import EnvProfilePanel from './EnvProfilePanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))
const originalApi = window.electronAPI
let profiles: HarnessEnvProfile[]
const add = vi.fn(async (payload: Omit<HarnessEnvProfile, 'id' | 'order'>) => {
  profiles.push({ ...payload, id: 'new', order: 1 })
  return { success: true }
})
const update = vi.fn(async (_payload: HarnessEnvProfile): Promise<{ success: boolean; error?: string }> => ({ success: false, error: '写入失败' }))
beforeEach(() => {
  profiles = [{ id: 'a', name: 'DeepSeek', baseUrl: 'https://api.example.com', apiKey: 'preview-key', env: { TOKEN: 'preview-token' }, order: 0 }]
  add.mockClear(); update.mockClear()
  useUiStore.setState({ createDialogRequests: {}, openItemRequests: {} })
  window.electronAPI = { listEnvProfiles: async () => ({ profiles: [...profiles], activeProfileId: null, usage: {} }), addEnvProfile: add, updateEnvProfile: update } as unknown as typeof window.electronAPI
})
afterEach(() => { cleanup(); window.electronAPI = originalApi })

describe('变量组在左侧栏内配置', () => {
  it('新增使用栏内编辑页，保存后回到刷新后的列表', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.addTitle' }))
    expect(view.getByRole('region', { name: 'env.addTitle' })).toBeTruthy()
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.container.querySelector('.ly-dialog-backdrop')).toBeNull()
    expect(view.queryByRole('switch', { name: 'DeepSeek' })).toBeNull()
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '新的环境' } })
    fireEvent.change(view.getByLabelText('env.baseUrl'), { target: { value: 'https://new.example.com' } })
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    await view.findByRole('switch', { name: '新的环境' })
    expect(add).toHaveBeenCalledOnce()
    expect(view.queryByRole('region', { name: 'env.addTitle' })).toBeNull()
  })

  it('返回列表保留原搜索，编辑中的敏感值默认隐藏且键值分行', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'deep' } })

    fireEvent.click(view.getAllByRole('button', { name: 'env.editTitle' })[0])
    expect(view.getByLabelText('env.apiKey').className).toContain('[-webkit-text-security:disc]')
    expect(view.container.querySelector('.env-rows-stacked-row')).not.toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'env.backToList' }))
    expect((view.getByRole('searchbox') as HTMLInputElement).value).toBe('deep')
    expect(view.getByRole('switch', { name: 'DeepSeek' })).toBeTruthy()
  })

  it('校验或写入失败保留栏内草稿并显示原因', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })

    fireEvent.click(view.getAllByRole('button', { name: 'env.editTitle' })[0])
    fireEvent.change(view.getByLabelText('env.baseUrl'), { target: { value: 'invalid' } })
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    expect(view.getByRole('alert').textContent).toBe('env.baseUrlInvalid')
    expect(update).not.toHaveBeenCalled()
    fireEvent.change(view.getByLabelText('env.baseUrl'), { target: { value: 'https://api.example.com' } })
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '保留草稿' } })
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('写入失败'))
    expect((view.getByLabelText('env.name') as HTMLInputElement).value).toBe('保留草稿')
    expect(view.getByRole('region', { name: 'env.editTitle' })).toBeTruthy()
  })
})
