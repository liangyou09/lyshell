// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useHarnessRecovery } from './useHarnessRecovery'
const fixture = vi.hoisted(() => ({ tab: null as { ref: { id: string } } | null, patch: vi.fn() }))
vi.mock('../stores', () => ({ usePaneStore: { getState: () => ({ getOverlayByKind: () => fixture.tab, updateDshWebInPane: fixture.patch }) } }))
afterEach(() => { cleanup(); fixture.tab = null; fixture.patch.mockClear() })

describe('工作台后台恢复通知', () => {
  it('渲染器重载时主动读取就绪后台，迟到读回执不会覆盖较新恢复事件', async () => {
    let deliver!: (value: unknown) => void
    let resolveInitial!: (value: unknown) => void
    const initial = new Promise(resolve => { resolveInitial = resolve })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      getHarnessBackend: () => initial,
      onHarnessBackendRecovered: (fn: typeof deliver) => { deliver = fn; return () => {} }
    } })
    fixture.tab = { ref: { id: 'existing' } }
    renderHook(() => useHarnessRecovery())
    const event = (epoch: number) => ({ identity: { instanceId: `backend-${epoch}`, instanceEpoch: epoch }, url: `http://127.0.0.1:${3100 + epoch}`, cwd: 'D:/work' })
    act(() => deliver(event(3)))
    await act(async () => { resolveInitial(event(2)); await initial })
    expect(fixture.patch).toHaveBeenCalledTimes(1)
    expect(fixture.patch.mock.calls[0][1].url).toBe('http://127.0.0.1:3103')
  })
  it('只更新已有页签，不挂载/抢焦点；忽略迟到代际和非法地址，退订监听', () => {
    let deliver!: (value: unknown) => void
    const dispose = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { onHarnessBackendRecovered: (fn: typeof deliver) => { deliver = fn; return dispose } } })
    const hook = renderHook(() => useHarnessRecovery())
    const event = (epoch: number, url = 'http://127.0.0.1:3100') => ({ identity: { instanceId: `backend-${epoch}`, instanceEpoch: epoch }, url, cwd: 'D:/work' })
    act(() => deliver(event(1)))
    expect(fixture.patch).not.toHaveBeenCalled()
    fixture.tab = { ref: { id: 'existing-tab' } }
    act(() => deliver(event(3)))
    expect(fixture.patch).toHaveBeenCalledWith('existing-tab', { url: 'http://127.0.0.1:3100', cwd: 'D:/work', readOnly: false, petSessionId: null, workbenchKey: null })
    act(() => { deliver(event(2)); deliver(event(4, 'https://external.example')); deliver(event(4, 'http://127.0.0.1:3100/?token=secret')) })
    expect(fixture.patch).toHaveBeenCalledTimes(1)
    hook.unmount(); expect(dispose).toHaveBeenCalledTimes(1)
  })
})
