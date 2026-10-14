// @vitest-environment jsdom
/**
 * 共享工作台状态条（S4）回归。
 *
 * 这里锁的是**渲染层的可读性与真实动作**，不是 CSS：
 *   - 独占期间出现可读原因（不只靠颜色），非独占且非详情时**完全不显示**（保持原界面）；
 *   - 「回到 Pet 任务会话」是显式动作，且请求下发后**不立刻宣告成功** —— 只有快照里
 *     官方 UI 的实际当前会话（viewer.currentSessionId）越过请求 revision 才标记落地；
 *   - 桥不可达时明确报错并给出键盘可达的重试入口（不假装一切正常）。
 *
 * v3 官方页面保持可输入和操作，状态条仅显示连接与显式导航结果。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor } from '@testing-library/react'
import { DshWebWorkbenchStrip } from './DshWebWorkbenchStrip'
import i18n from '../../i18n'
import type { ExclusiveControlSnapshot, ExclusiveViewerAck } from '@shared/exclusive-control'

// 断言按中文文案锁可读性：jsdom 无 localStorage 时 i18n 默认 en，这里显式钉成 zh
beforeAll(async () => {
  await i18n.changeLanguage('zh')
})

interface ApiStub {
  getExclusiveSnapshot?: () => Promise<unknown>
  requestDshWebViewerNav?: (target: { sessionId: string }) => Promise<unknown>
}

const setApi = (api: ApiStub): void => {
  (window as unknown as { electronAPI?: ApiStub }).electronAPI = api
}

function snapshot(over: {
  phase?: ExclusiveControlSnapshot['phase']
  petSessionId?: string | null
  currentSessionId?: string | null
  revision?: number
  approvals?: number
  ack?: ExclusiveViewerAck
}): ExclusiveControlSnapshot {
  const viewer = {
    revision: over.revision ?? 10,
    appliedRevision: 0,
    currentSessionId: over.currentSessionId ?? null,
    petSessionId: over.petSessionId ?? null,
    request: null,
    lastAck: over.ack ?? null,
    connected: true,
    updatedAt: Date.now()
  }
  return {
    phase: over.phase ?? 'held',
    binding: {
      bindingId: 'b-1',
      epoch: 3,
      pluginId: 'aipet',
      pluginInstanceId: 'p-1',
      instanceId: 'inst-1',
      instanceEpoch: 1000,
      acquiredAt: Date.now()
    },
    activeTask: { taskId: 't-1', sessionId: over.petSessionId ?? 's-pet', epoch: 3, state: 'running', acceptedAt: Date.now() },
    pendingApproval: null,
    approvals: Array.from({ length: over.approvals ?? 0 }, (_, i) => ({
      approvalId: `a-${i}`,
      taskId: 't-1',
      sessionId: over.petSessionId ?? 's-pet',
      epoch: 3,
      toolName: 'bash',
      askedAt: Date.now()
    })),
    transcript: [],
    lastEventSeq: 1,
    webBusy: false,
    viewer
  }
}

beforeEach(() => {
  delete (window as unknown as { electronAPI?: ApiStub }).electronAPI
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  delete (window as unknown as { electronAPI?: ApiStub }).electronAPI
})

describe('共享工作台状态条', () => {
  it('非详情页签且当前未被独占：不渲染任何条（普通 Web 界面不受影响）', async () => {
    setApi({ getExclusiveSnapshot: async () => ({ success: true, snapshot: snapshot({ phase: 'free', petSessionId: null }) }) })
    const { container } = render(<DshWebWorkbenchStrip detail={false} />)
    await act(async () => { await Promise.resolve() })
    expect(container.firstChild).toBeNull()
  })

  it('Pet 绑定期间：显示共享可操作说明，并有回到 Pet 会话入口', async () => {
    setApi({
      getExclusiveSnapshot: async () => ({
        success: true,
        snapshot: snapshot({ phase: 'held', petSessionId: 's-pet', currentSessionId: 's-other' })
      })
    })
    render(<DshWebWorkbenchStrip detail />)
    await waitFor(() => expect(screen.getByText('与 PetLink 共用 Harness')).toBeTruthy())
    expect(screen.getByText(/正常输入、新建会话/)).toBeTruthy()
    expect(screen.getByText(/s-pet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '回到 Pet 任务会话' })).toBeTruthy()
  })

  it('已在该任务会话：不再提供导航入口（没有需要拽回的位置）', async () => {
    setApi({
      getExclusiveSnapshot: async () => ({
        success: true,
        snapshot: snapshot({ phase: 'held', petSessionId: 's-pet', currentSessionId: 's-pet' })
      })
    })
    render(<DshWebWorkbenchStrip detail />)
    await waitFor(() => expect(screen.getByText('已在该任务会话')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '回到 Pet 任务会话' })).toBeNull()
  })

  it('导航请求下发 ≠ 落地：只有官方当前会话越过请求 revision 才标记已确认', async () => {
    const navCalls: string[] = []
    let currentSessionId = 's-other'
    let revision = 10
    let ack: ExclusiveViewerAck | undefined
    setApi({
      getExclusiveSnapshot: async () => ({
        success: true,
        snapshot: snapshot({ phase: 'held', petSessionId: 's-pet', currentSessionId, revision, ack })
      }),
      requestDshWebViewerNav: async (target) => {
        navCalls.push(target.sessionId)
        // 桥已受理但官方 UI 还没落地：revision 不动、当前会话仍是旧值
        return { success: true, skipped: false, requestId: 'nav-1', revision: 11 }
      }
    })
    render(<DshWebWorkbenchStrip detail />)
    const nav = await waitFor(() => screen.getByRole('button', { name: '回到 Pet 任务会话' }))
    await act(async () => {
      nav.click()
      await Promise.resolve()
    })
    expect(navCalls).toEqual(['s-pet'])
    // 未落地：不能出现「已确认到达」
    expect(screen.queryByText('已确认到达该任务会话')).toBeNull()
    expect(screen.getByText(/等待官方界面确认/)).toBeTruthy()

    // 官方 UI 真的到了目标会话且 revision 越过冻结值 ⇒ 才标记落地
    // （状态由 1.5s 轮询带回，故等待窗口放宽到 >1 个轮询周期）
    currentSessionId = 's-pet'
    revision = 11
    ack = { requestId: 'nav-1', revision: 11, sessionId: 's-pet', currentSessionId: 's-pet', status: 'navigated', at: Date.now() }
    await waitFor(() => expect(screen.getByText('已确认到达该任务会话')).toBeTruthy(), { timeout: 4000 })
  })

  it('导航被拒：显示明确失败原因（不自动重试、不假装成功）', async () => {
    setApi({
      getExclusiveSnapshot: async () => ({
        success: true,
        snapshot: snapshot({ phase: 'held', petSessionId: 's-pet', currentSessionId: 's-other' })
      }),
      requestDshWebViewerNav: async () => ({ success: false, error: 'viewer navigation was superseded', code: 'viewer/stale' })
    })
    render(<DshWebWorkbenchStrip detail />)
    const nav = await waitFor(() => screen.getByRole('button', { name: '回到 Pet 任务会话' }))
    await act(async () => {
      nav.click()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText(/viewer navigation was superseded/)).toBeTruthy())
  })

  it('桥/控制状态不可达：明确报错 + 键盘可达的重试入口（不加载本地兜底）', async () => {
    let calls = 0
    setApi({
      getExclusiveSnapshot: async () => {
        calls++
        if (calls === 1) return { success: false, error: 'harness bridge did not answer', snapshot: null }
        return { success: true, snapshot: snapshot({ phase: 'held', petSessionId: 's-pet', currentSessionId: 's-pet' }) }
      }
    })
    render(<DshWebWorkbenchStrip detail />)
    await waitFor(() => expect(screen.getByText('PetLink 状态不可用')).toBeTruthy())
    expect(screen.getByText(/无法读取 PetLink 连接状态/)).toBeTruthy()
    const retry = screen.getByRole('button', { name: '重试连接' })
    await act(async () => {
      retry.click()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByText('PetLink 状态不可用')).toBeNull())
  })

  // S4：状态条把**权威**只读态/Pet 目标/相位如实回传，供页签 payload 原位刷新（不重挂、不激活页签）
  it('onSnapshot：每次新鲜快照如实回传只读态、Pet 目标与相位', async () => {
    const seen: Array<{ readOnly: boolean; petSessionId: string | null; phase: string }> = []
    setApi({
      getExclusiveSnapshot: async () => ({
        success: true,
        snapshot: snapshot({ phase: 'held', petSessionId: 's-pet', currentSessionId: 's-other' })
      })
    })
    render(<DshWebWorkbenchStrip detail onSnapshot={(s) => seen.push(s)} />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[0]).toEqual({ readOnly: false, petSessionId: 's-pet', phase: 'held' })
  })

  it('onSnapshot：解除 Pet 绑定后回传 readOnly=false 与 free 相位（页签始终可写）', async () => {
    const seen: Array<{ readOnly: boolean; petSessionId: string | null; phase: string }> = []
    setApi({
      getExclusiveSnapshot: async () => ({ success: true, snapshot: snapshot({ phase: 'free', petSessionId: null }) })
    })
    render(<DshWebWorkbenchStrip detail onSnapshot={(s) => seen.push(s)} />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[0]).toEqual({ readOnly: false, petSessionId: null, phase: 'free' })
  })

  it('onSnapshot：取快照失败时不回传（绝不用旧值把页签改写成「已恢复」）', async () => {
    const seen: unknown[] = []
    setApi({ getExclusiveSnapshot: async () => ({ success: false, error: 'offline', snapshot: snapshot({ phase: 'held' }) }) })
    render(<DshWebWorkbenchStrip detail onSnapshot={(s) => seen.push(s)} />)
    await waitFor(() => expect(screen.getByText('PetLink 状态不可用')).toBeTruthy())
    expect(seen).toEqual([])
  })

  it('官方导航受理后 failed ack：结束等待并允许用户重试，普通轮询保留失败原因', async () => {
    let ack: ExclusiveViewerAck | undefined
    setApi({
      getExclusiveSnapshot: async () => ({ success: true, snapshot: snapshot({ petSessionId: 's-pet', currentSessionId: 's-other', revision: 11, ack }) }),
      requestDshWebViewerNav: async () => ({ success: true, requestId: 'nav-failed', revision: 12 })
    })
    render(<DshWebWorkbenchStrip detail />)
    const button = await waitFor(() => screen.getByRole('button', { name: '回到 Pet 任务会话' }))
    await act(async () => { button.click(); await Promise.resolve() })
    ack = { requestId: 'nav-failed', revision: 12, sessionId: 's-pet', currentSessionId: 's-other', status: 'failed', at: Date.now() }
    await waitFor(() => expect(screen.getByText(/官方界面未完成导航，请重试/)).toBeTruthy(), { timeout: 4000 })
    expect((screen.getByRole('button', { name: '回到 Pet 任务会话' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)) })
    expect(screen.getByText(/官方界面未完成导航，请重试/)).toBeTruthy()
  })

  it('旧请求的成功 ack 与用户浏览到目标都不能冒充本次导航落地', async () => {
    const ack: ExclusiveViewerAck = { requestId: 'old-nav', revision: 12, sessionId: 's-pet', currentSessionId: 's-pet', status: 'navigated', at: Date.now() }
    let currentSessionId = 's-other'
    setApi({
      getExclusiveSnapshot: async () => ({ success: true, snapshot: snapshot({ petSessionId: 's-pet', currentSessionId, revision: 12, ack }) }),
      requestDshWebViewerNav: async () => { currentSessionId = 's-pet'; return { success: true, requestId: 'new-nav', revision: 12 } }
    })
    render(<DshWebWorkbenchStrip detail />)
    const button = await waitFor(() => screen.getByRole('button', { name: '回到 Pet 任务会话' }))
    await act(async () => { button.click(); await Promise.resolve() })
    expect(screen.queryByText('已确认到达该任务会话')).toBeNull()
    expect(screen.getByText(/等待官方界面确认/)).toBeTruthy()
  })

  it('官方页面未回 ack：等待有界，超时显示恢复提示而不假报成功', async () => {
    vi.useFakeTimers()
    setApi({
      getExclusiveSnapshot: async () => ({ success: true, snapshot: snapshot({ petSessionId: 's-pet', currentSessionId: 's-other' }) }),
      requestDshWebViewerNav: async () => ({ success: true, requestId: 'no-ack', revision: 11 })
    })
    await act(async () => { render(<DshWebWorkbenchStrip detail />); await Promise.resolve() })
    await act(async () => { screen.getByRole('button', { name: '回到 Pet 任务会话' }).click(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(12001) })
    expect(screen.getByText(/未收到官方界面确认，请重试/)).toBeTruthy()
    expect(screen.queryByText('已确认到达该任务会话')).toBeNull()
    expect((screen.getByRole('button', { name: '回到 Pet 任务会话' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
