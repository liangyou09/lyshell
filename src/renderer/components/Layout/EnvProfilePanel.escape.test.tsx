// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EnvProfilePanel from './EnvProfilePanel'
import { useUiStore } from '@/stores/ui-store'
import { useEscDismiss } from '@/hooks/useDismiss'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))
const previousApi = window.electronAPI
beforeEach(() => {
  window.electronAPI = {
    listEnvProfiles: vi.fn(async () => ({ profiles: [{ id: 'test', name: '测试环境', order: 0, env: {} }], activeProfileId: null, usage: {} }))
  } as unknown as typeof window.electronAPI
})
afterEach(() => { cleanup(); window.electronAPI = previousApi })

function openNew(): void {
  render(<EnvProfilePanel />)
  act(() => useUiStore.getState().requestCreateDialog('env'))
  expect(screen.getByRole('region', { name: 'env.addTitle' })).toBeTruthy()
}

describe('环境配置页返回与 Esc', () => {
  it('Esc 不丢弃草稿，通过返回按钮回到列表', () => {
    openNew()
    fireEvent.change(screen.getByPlaceholderText('env.namePh'), { target: { value: '草稿' } })
    fireEvent.keyDown(screen.getByPlaceholderText('env.namePh'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByPlaceholderText('env.namePh') as HTMLInputElement).value).toBe('草稿')
    fireEvent.click(screen.getByRole('button', { name: 'env.backToList' }))
    expect(screen.queryByRole('region', { name: 'env.addTitle' })).toBeNull()
  })

  it('输入法取消候选词不离开编辑页', () => {
    openNew()
    const input = screen.getByPlaceholderText('env.namePh')
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('region', { name: 'env.addTitle' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'env.cancel' }))
    expect(screen.queryByRole('region', { name: 'env.addTitle' })).toBeNull()
  })

  it('左栏编辑不拦截其他工作区的 Esc', () => {
    const closeBackground = vi.fn()
    const Background = () => { useEscDismiss(true, closeBackground); return null }
    render(<><Background /><EnvProfilePanel /></>)
    act(() => useUiStore.getState().requestCreateDialog('env'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'env.addTitle' })).toBeTruthy()
    expect(closeBackground).toHaveBeenCalledOnce()
  })

  it('编辑页内 Esc 退出删除确认，保留当前编辑内容', async () => {
    render(<EnvProfilePanel />)
    await screen.findByRole('switch', { name: '测试环境' })

    fireEvent.click(screen.getByRole('button', { name: 'env.editTitle' }))
    const dialog = screen.getByRole('region', { name: 'env.editTitle' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'env.delete' }))
    expect(within(dialog).getByRole('button', { name: 'env.confirmDelete' })).toBeTruthy()
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'env.confirmDelete' }), { key: 'Escape' })
    expect(within(dialog).getByRole('button', { name: 'env.delete' })).toBeTruthy()
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'env.delete' }), { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'env.editTitle' })).toBeTruthy()
  })
})
