// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshLaunchTab } from './DshLaunchTab'

const fixture = vi.hoisted(() => ({ open: false, t: (key: string) => key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.t }) }))
vi.mock('../../stores/pane-store', () => ({ usePaneStore: (selector: (state: unknown) => unknown) => selector({
  overlayPayloads: fixture.open ? { __dsh_web__: { kind: 'dshWeb' } } : {}
}) }))

afterEach(() => { cleanup(); fixture.open = false })

describe('DeepSeek Harness Launch 槽', () => {
  it('默认只显示鲸鱼，点击才启动；StrictMode 和连点不重复提交', async () => {
    let finish!: (result: { success: boolean }) => void
    const launch = vi.fn(() => new Promise<{ success: boolean }>(resolve => { finish = resolve }))
    const view = render(<StrictMode><DshLaunchTab onLaunch={launch} /></StrictMode>)
    const button = view.getByRole('button', { name: 'dshMarket.workbench' }) as HTMLButtonElement
    expect(launch).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(launch).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(launch).toHaveBeenCalledOnce()
    await act(async () => { finish({ success: true }) })
    expect(button.getAttribute('aria-busy')).toBe('false')
    view.rerender(<StrictMode><DshLaunchTab onLaunch={launch} /></StrictMode>)
    expect(launch).toHaveBeenCalledOnce()
  })

  it('打开时变色，关闭后恢复且不自动重新打开，点击可重开', async () => {
    const launch = vi.fn().mockResolvedValue({ success: true })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    await act(async () => {})
    const button = view.getByRole('button', { name: 'dshMarket.workbench' })
    fixture.open = true
    view.rerender(<DshLaunchTab onLaunch={launch} />)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className).toContain('is-open')
    fixture.open = false
    view.rerender(<DshLaunchTab onLaunch={launch} />)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.className).not.toContain('is-open')
    expect(launch).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button) })
    expect(launch).toHaveBeenCalledOnce()
  })

  it('失败显示原因，重试成功后消除提示', async () => {
    const launch = vi.fn().mockResolvedValueOnce({ success: false, error: 'dsh not installed' }).mockResolvedValueOnce({ success: true })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' }))
    await act(async () => {})
    expect(view.getByRole('alert').textContent).toContain('dsh not installed')
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshLaunch.retry' })) })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('启动异常被捕获，提示可以关闭', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('backend unavailable'))
    const view = render(<DshLaunchTab onLaunch={launch} />)
    fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' }))
    await act(async () => {})
    expect(view.getByRole('alert').textContent).toContain('backend unavailable')
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.dismiss' }))
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('鲸鱼下方状态语随状态切换', async () => {
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    const hint = view.getByRole('status')
    expect(hint.className).toContain('dsh-launch-hint')
    expect(hint.textContent).toBe('dshLaunch.hint')
    fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' }))
    expect(hint.textContent).toBe('dshLaunch.opening')
    await act(async () => {})
    expect(hint.textContent).toBe('dshLaunch.failed')
  })

  it('工作台已开时状态语提示点击切回', () => {
    const launch = vi.fn().mockResolvedValue({ success: true })
    fixture.open = true
    const view = render(<DshLaunchTab onLaunch={launch} />)
    expect(view.getByRole('status').textContent).toBe('dshLaunch.running')
  })

})
