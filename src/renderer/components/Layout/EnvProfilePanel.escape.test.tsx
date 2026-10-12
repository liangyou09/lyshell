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
  expect(screen.getByRole('dialog', { name: 'env.addTitle' })).toBeTruthy()
}

describe('环境配置弹窗 Esc 回退', () => {
  it('在名称输入框里按一次 Esc 即关闭新增弹窗', () => {
    openNew()
    fireEvent.keyDown(screen.getByPlaceholderText('env.namePh'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('输入法取消候选词不关闭弹窗', () => {
    openNew()
    const input = screen.getByPlaceholderText('env.namePh')
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc 只关闭环境弹窗，不穿透底层浮窗', () => {
    const closeBackground = vi.fn()
    const Background = () => { useEscDismiss(true, closeBackground); return null }
    render(<><Background /><EnvProfilePanel /></>)
    act(() => useUiStore.getState().requestCreateDialog('env'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(closeBackground).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeBackground).toHaveBeenCalledOnce()
  })

  it('编辑时第一次 Esc 退出删除确认，再按才关闭', async () => {
    render(<EnvProfilePanel />)
    await screen.findByText('测试环境')
    fireEvent.click(screen.getByTitle('env.editTitle'))
    const dialog = screen.getByRole('dialog', { name: 'env.editTitle' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'env.delete' }))
    expect(within(dialog).getByRole('button', { name: 'env.confirmDelete' })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(within(dialog).getByRole('button', { name: 'env.delete' })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
