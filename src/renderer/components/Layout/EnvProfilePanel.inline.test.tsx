// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEnvProfile } from '@shared/harness'
import { useUiStore } from '@/stores/ui-store'
import EnvProfilePanel from './EnvProfilePanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))
const originalApi = window.electronAPI
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const writeText = vi.fn(async (_text: string) => {})
let profiles: HarnessEnvProfile[]
const add = vi.fn(async (payload: Omit<HarnessEnvProfile, 'id' | 'order'>) => {
  profiles.push({ ...payload, id: 'new', order: 1 })
  return { success: true }
})
const update = vi.fn(async (_payload: HarnessEnvProfile): Promise<{ success: boolean; error?: string }> => ({ success: false, error: '写入失败' }))
beforeEach(() => {
  profiles = [{ id: 'a', name: 'DeepSeek', baseUrl: 'https://api.example.com', apiKey: 'preview-key', env: { TOKEN: 'preview-token' }, order: 0 }]
  add.mockClear(); update.mockClear()
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  useUiStore.setState({ createDialogRequests: {}, openItemRequests: {} })
  window.electronAPI = { listEnvProfiles: async () => ({ profiles: [...profiles], activeProfileId: null, usage: {} }), addEnvProfile: add, updateEnvProfile: update } as unknown as typeof window.electronAPI
})
afterEach(() => {
  cleanup(); window.electronAPI = originalApi
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('变量组在左侧栏内配置', () => {
  it.each(['success', 'failure', 'reject'] as const)('旧保存结果 %s 不关闭或污染新导入的草稿', async outcome => {
    let finish!: (result: { success: boolean; error?: string }) => void
    let fail!: (reason: Error) => void
    window.electronAPI.addEnvProfile = vi.fn(() => new Promise((resolve, reject) => {
      finish = resolve
      fail = reject
    }))
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.addTitle' }))
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '旧草稿' } })
    fireEvent.change(view.getByLabelText('env.apiKey'), { target: { value: 'old-key' } })
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    expect(window.electronAPI.addEnvProfile).toHaveBeenCalledOnce()
    fireEvent.click(view.getByRole('button', { name: 'env.importConfig' }))
    fireEvent.change(view.getByLabelText('env.importJson'), { target: { value: '{"name":"新草稿","apiKey":"new-key"}' } })
    fireEvent.click(view.getByRole('button', { name: 'env.applyImport' }))
    await act(async () => {
      if (outcome === 'reject') fail(new Error('旧保存错误'))
      else finish({ success: outcome === 'success', error: '旧保存错误' })
    })
    expect(view.getByRole('region', { name: 'env.addTitle' })).toBeTruthy()
    expect((view.getByLabelText('env.name') as HTMLInputElement).value).toBe('新草稿')
    expect((view.getByLabelText('env.apiKey') as HTMLInputElement).value).toBe('new-key')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('保存后的列表刷新期间导入配置，刷新完成仍保留新草稿', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.addTitle' }))
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '旧草稿' } })
    fireEvent.change(view.getByLabelText('env.apiKey'), { target: { value: 'old-key' } })
    let finish!: (result: { profiles: HarnessEnvProfile[]; activeProfileId: null; usage: Record<string, never> }) => void
    window.electronAPI.listEnvProfiles = vi.fn(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    await waitFor(() => expect(window.electronAPI.listEnvProfiles).toHaveBeenCalledOnce())
    fireEvent.click(view.getByRole('button', { name: 'env.importConfig' }))
    fireEvent.change(view.getByLabelText('env.importJson'), { target: { value: '{"name":"新草稿","apiKey":"new-key"}' } })
    fireEvent.click(view.getByRole('button', { name: 'env.applyImport' }))
    await act(async () => { finish({ profiles: [...profiles], activeProfileId: null, usage: {} }) })
    expect((view.getByLabelText('env.name') as HTMLInputElement).value).toBe('新草稿')
  })

  it('导入新配置重置凭据明文状态，并忽略旧复制回调', async () => {
    let finish!: () => void
    writeText.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.copy' }))
    for (const button of view.getAllByTitle('env.showValue')) fireEvent.click(button)
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    fireEvent.click(view.getByRole('button', { name: 'env.importConfig' }))
    fireEvent.change(view.getByLabelText('env.importJson'), { target: { value: '{"name":"新草稿","apiKey":"new-key","env":{"TOKEN":"new-token"}}' } })
    fireEvent.click(view.getByRole('button', { name: 'env.applyImport' }))
    await act(async () => { finish() })
    expect(view.getByRole('status').textContent).toBe('env.configImported')
    expect(view.getByLabelText('env.apiKey').className).toContain('[-webkit-text-security:disc]')
    expect(view.getByDisplayValue('new-token').className).toContain('[-webkit-text-security:disc]')
    expect(view.getByRole('button', { name: 'env.copyConfig' }).hasAttribute('disabled')).toBe(false)
  })

  it('复制的 JSON 可导入新增草稿，检查后保存为新记录', async () => {
    profiles[0].models = ['model-a']
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.editTitle' }))
    expect(view.queryByRole('button', { name: 'env.importConfig' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    await view.findByRole('status')
    const copied = writeText.mock.calls[0][0]
    fireEvent.click(view.getByRole('button', { name: 'env.backToList' }))
    fireEvent.click(view.getByRole('button', { name: 'env.addTitle' }))
    fireEvent.click(view.getByRole('button', { name: 'env.importConfig' }))
    expect(view.getByRole('button', { name: 'env.applyImport' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(view.getByLabelText('env.importJson'), { target: { value: copied } })
    fireEvent.click(view.getByRole('button', { name: 'env.applyImport' }))
    expect(view.queryByLabelText('env.importJson')).toBeNull()
    expect(view.getByRole('status').textContent).toBe('env.configImported')
    expect((view.getByLabelText('env.apiKey') as HTMLInputElement).value).toBe('preview-key')
    expect(view.getByLabelText('env.apiKey').className).toContain('[-webkit-text-security:disc]')
    expect((view.getByLabelText('env.models 1') as HTMLInputElement).value).toBe('model-a')
    expect(add).not.toHaveBeenCalled()
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '导入副本' } })
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    await view.findByRole('switch', { name: '导入副本' })
    expect(add).toHaveBeenCalledWith({
      name: '导入副本', note: undefined, baseUrl: 'https://api.example.com', apiKey: 'preview-key',
      env: { TOKEN: 'preview-token' }, models: ['model-a']
    })
    expect(update).not.toHaveBeenCalled()
  })

  it.each([
    ['{"name":', 'env.importInvalidJson'],
    ['[]', 'env.importInvalidConfig'],
    ['{"env":{"TOKEN":123}}', 'env.importInvalidConfig']
  ])('导入错误 %s 保留现有草稿，修正后可重新填入', async (json, message) => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.addTitle' }))
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '保留草稿' } })
    fireEvent.click(view.getByRole('button', { name: 'env.importConfig' }))
    fireEvent.change(view.getByLabelText('env.importJson'), { target: { value: json } })
    fireEvent.click(view.getByRole('button', { name: 'env.applyImport' }))
    expect(view.getByRole('alert').textContent).toBe(message)
    expect((view.getByLabelText('env.name') as HTMLInputElement).value).toBe('保留草稿')
    expect((view.getByLabelText('env.importJson') as HTMLTextAreaElement).value).toBe(json)
    expect(add).not.toHaveBeenCalled()
    fireEvent.change(view.getByLabelText('env.importJson'), { target: { value: '{"apiKey":"imported-key"}' } })
    expect(view.queryByRole('alert')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'env.applyImport' }))
    expect((view.getByLabelText('env.apiKey') as HTMLInputElement).value).toBe('imported-key')
    fireEvent.click(view.getByRole('button', { name: 'env.save' }))
    expect(view.getByRole('alert').textContent).toBe('env.required')
    expect(add).not.toHaveBeenCalled()
  })

  it('复制当前草稿的完整 JSON，包括隐藏的凭据，不保存或创建副本', async () => {
    profiles[0].note = '用于开发'
    profiles[0].models = ['model-a', 'model-b']
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.editTitle' }))
    fireEvent.change(view.getByLabelText('env.name'), { target: { value: '未保存的配置' } })
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    await view.findByRole('status')
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({
      name: '未保存的配置', note: '用于开发', baseUrl: 'https://api.example.com',
      apiKey: 'preview-key', env: { TOKEN: 'preview-token' }, models: ['model-a', 'model-b']
    })
    expect(view.getByRole('status').textContent).toBe('env.configCopied')
    expect(add).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    fireEvent.change(view.getByLabelText('env.apiKey'), { target: { value: 'new-key' } })
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    await view.findByRole('status')
    expect(JSON.parse(writeText.mock.calls[1][0]).apiKey).toBe('new-key')
  })

  it('剪贴板不可用或拒绝时显示失败，允许重试', async () => {
    const view = render(<EnvProfilePanel embedded />)
    await view.findByRole('switch', { name: 'DeepSeek' })
    fireEvent.click(view.getByRole('button', { name: 'env.editTitle' }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    expect((await view.findByRole('alert')).textContent).toBe('env.copyConfigFailed')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    await waitFor(() => expect(view.getByRole('button', { name: 'env.copyConfig' }).hasAttribute('disabled')).toBe(false))
    expect(view.getByRole('alert').textContent).toBe('env.copyConfigFailed')
    fireEvent.click(view.getByRole('button', { name: 'env.copyConfig' }))
    await view.findByRole('status')
    expect(view.queryByRole('alert')).toBeNull()
  })

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
