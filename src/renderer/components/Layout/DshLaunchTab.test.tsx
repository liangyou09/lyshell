// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshLaunchTab } from './DshLaunchTab'
import { DSH_WEB_INSTALL_COMMAND, HARNESS_AGENT_VIEWS } from '../../../shared/harness'

const fixture = vi.hoisted(() => ({ open: false, t: (key: string) => key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.t, i18n: { resolvedLanguage: 'zh', language: 'zh' } }) }))
vi.mock('../../stores/pane-store', () => ({ usePaneStore: (selector: (state: unknown) => unknown) => selector({
  overlayPayloads: fixture.open ? { __dsh_web__: { kind: 'dshWeb' } } : {}
}) }))

afterEach(() => { cleanup(); fixture.open = false; vi.unstubAllGlobals() })

describe('DeepSeek Harness Launch 槽', () => {
  it('Web 安装提示只需 dsh，终端工作区的安装提示仍包含 dsh-tui', () => {
    expect(DSH_WEB_INSTALL_COMMAND).toBe('npm install -g @deepseek-ai/dsh')
    expect(HARNESS_AGENT_VIEWS.dsh.installCommand).toBe('npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui')
  })

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
    expect(view.getByRole('alert').textContent).toContain('dshLaunch.installHint')
    expect(view.getByRole('alert').querySelector('code')?.textContent).toBe('npm install -g @deepseek-ai/dsh')
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
    expect(view.getByRole('alert').querySelector('code')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.dismiss' }))
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('复制完整安装命令，成功后显示已复制且不触发启动', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'dsh not installed' })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' })) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dsh.copy' })) })
    expect(writeText).toHaveBeenCalledWith('npm install -g @deepseek-ai/dsh')
    expect(view.getByRole('button', { name: 'dsh.copied' })).toBeTruthy()
    expect(launch).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshLaunch.retry' })) })
    expect(view.getByRole('button', { name: 'dsh.copy' })).toBeTruthy()
  })

  it('剪贴板写入失败时保留命令并提示手动复制，可重试', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied')).mockResolvedValueOnce(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = render(<DshLaunchTab onLaunch={async () => ({ success: false, error: 'dsh not installed' })} />)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' })) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dsh.copy' })) })
    expect(view.getByText('dshLaunch.copyFailed')).toBeTruthy()
    expect(view.getByRole('alert').querySelector('code')?.textContent).toBe(DSH_WEB_INSTALL_COMMAND)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dsh.copy' })) })
    expect(view.queryByText('dshLaunch.copyFailed')).toBeNull()
    expect(view.getByRole('button', { name: 'dsh.copied' })).toBeTruthy()
  })

  it('鲸鱼下方状态语随状态切换', async () => {
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    const hint = view.getByRole('status')
    expect(hint.closest('button')).toBeNull()
    expect(view.container.querySelector('.dsh-launch-hint')?.getAttribute('aria-hidden')).toBe('true')
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

  it('可切换会话与今日用量，未接入时不伪造零消费，也不会触发启动', () => {
    const launch = vi.fn()
    const view = render(<DshLaunchTab onLaunch={launch} />)
    const session = view.getByRole('button', { name: 'dshLaunch.session' })
    const today = view.getByRole('button', { name: 'dshLaunch.today' })
    expect(session.getAttribute('aria-pressed')).toBe('true')
    expect(today.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(today)
    expect(session.getAttribute('aria-pressed')).toBe('false')
    expect(today.getAttribute('aria-pressed')).toBe('true')
    const usage = view.getByRole('region', { name: 'dshLaunch.usage' })
    expect(usage.textContent).toContain('dshLaunch.usagePending')
    expect(usage.querySelectorAll('dd').length).toBe(2)
    expect(Array.from(usage.querySelectorAll('dd')).map(value => value.textContent)).toEqual(['—', '—'])
    expect(launch).not.toHaveBeenCalled()
  })

})
