import { describe, it, expect, vi } from 'vitest'

/**
 * 独占控制运行期接线的撤销订阅测试。
 *
 * 这里测的是**真实订阅回调**（不是直接调 service.revoke）：host token 撤销发生在 mcpAuth，
 * 回调必须把受控插件的撤销传进服务。关键回归：binding 还没登记（acquire 正卡在后台/桥往返）
 * 时也必须调用 revoke —— 否则在飞 acquire 会复活成一个仍持有旧 epoch 的桥。
 */

vi.mock('electron-log', () => ({ default: { info: () => {}, error: () => {}, warn: () => {} } }))

// 只为让模块能被导入：真实接线用到 Electron/仓库/管理器，这里全部替换掉。
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\lyshell-exclusive-runtime-test', isPackaged: false }
}))
vi.mock('./web', () => ({ dshWebManager: { instanceIdentity: null, bridgeControlEndpoint: null, acquire: vi.fn(), release: vi.fn() } }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
vi.mock('../storage/plugin-repository', () => ({ pluginRepository: { get: () => undefined } }))
vi.mock('../mcp/auth', () => ({ onPluginTokenRevoked: () => () => {} }))

import { createPluginRevokeHandler, deriveWorkbenchDetail, workbenchDetailKey } from './exclusive-runtime'
import { EXCLUSIVE_CONTROLLER_PLUGIN_ID } from '@shared/exclusive-control'
import type { ExclusiveControlSnapshot } from '@shared/exclusive-control'

/**
 * 共享工作台**详情面**推导（S4）—— 主进程推给渲染层的身份。
 *
 * 锁两件事：
 *   ① 身份由 phase/epoch/taskId/sessionId 组成 —— **用户浏览历史不在其中**，
 *      所以「同一实例同一会话」的重复推送不会把用户从历史里拽回；
 *   ② 任务终态不再算活动任务（不再作为导航目标），但绑定会话仍可读。
 * 同身份「只报一次变化」的记账在 publishWorkbenchDetail（依赖单例），由 IPC 层回执覆盖。
 */
describe('共享工作台详情面（deriveWorkbenchDetail / workbenchDetailKey）', () => {
  function source(state: {
    phase?: ExclusiveControlSnapshot['phase']
    epoch?: number | null
    instanceEpoch?: number
    sessionIdForTask?: string
    task?: { taskId: string; sessionId: string; state: string } | null
  }): { getSnapshot: () => ExclusiveControlSnapshot; isHeld: boolean; isReleasing: boolean } {
    const phase = state.phase ?? 'held'
    const epoch = state.epoch === undefined ? 3 : state.epoch
    const snapshot = {
      phase,
      binding: epoch === null ? null : {
        bindingId: 'b-1', epoch, pluginId: 'aipet', pluginInstanceId: 'p-1',
        instanceId: 'inst-1', instanceEpoch: state.instanceEpoch ?? 1000, acquiredAt: 1,
        ...(state.sessionIdForTask ? { sessionIdForTask: state.sessionIdForTask } : {})
      },
      activeTask: state.task
        ? { taskId: state.task.taskId, sessionId: state.task.sessionId, epoch: epoch ?? 0, state: state.task.state, acceptedAt: 1 }
        : null,
      pendingApproval: null, approvals: [], transcript: [], lastEventSeq: 0, webBusy: false
    } as ExclusiveControlSnapshot
    return { getSnapshot: () => snapshot, isHeld: phase === 'held', isReleasing: phase === 'releasing' }
  }

  it('未接线（服务不存在）：身份为 null、free、只读 false', () => {
    expect(deriveWorkbenchDetail(null, 42)).toEqual({
      key: null, phase: 'free', petSessionId: null, taskId: null, instanceEpoch: null, readOnly: false, updatedAt: 42
    })
  })

  it('Pet 绑定 + 活动任务：身份含 phase/epoch/taskId/sessionId，Web 可操作', () => {
    const detail = deriveWorkbenchDetail(source({ phase: 'held', task: { taskId: 't-1', sessionId: 's-1', state: 'running' } }))
    expect(detail.key).toBe('held:3:t-1:s-1')
    expect(detail.petSessionId).toBe('s-1')
    expect(detail.readOnly).toBe(false)
    expect(detail.instanceEpoch).toBe(1000)
  })

  it('任务已终态：不再算活动任务（不再指向它导航），但绑定会话仍可读', () => {
    const detail = deriveWorkbenchDetail(source({
      phase: 'held',
      task: { taskId: 't-1', sessionId: 's-1', state: 'completed' },
      sessionIdForTask: 's-1'
    }))
    expect(detail.taskId).toBeNull()
    expect(detail.key).toBe('held:3:-:s-1')
    expect(detail.petSessionId).toBe('s-1')
  })

  it('没有绑定（free）：无身份、只读 false，即使残留任务也不当目标', () => {
    const detail = deriveWorkbenchDetail(source({ phase: 'free', epoch: null, task: null }))
    expect(detail.key).toBeNull()
    expect(detail.petSessionId).toBeNull()
    expect(detail.readOnly).toBe(false)
  })

  it('releasing 期间 Web 仍可操作，Pet 身份照旧', () => {
    const detail = deriveWorkbenchDetail(source({ phase: 'releasing', task: { taskId: 't-1', sessionId: 's-1', state: 'running' } }))
    expect(detail.readOnly).toBe(false)
    expect(detail.phase).toBe('releasing')
  })

  it('任务换代（新 taskId）/ 新绑定（新 epoch）都换身份 ⇒ 渲染层可重新导航到新目标', () => {
    const a = deriveWorkbenchDetail(source({ phase: 'held', task: { taskId: 't-1', sessionId: 's-1', state: 'running' } }))
    const b = deriveWorkbenchDetail(source({ phase: 'held', task: { taskId: 't-2', sessionId: 's-2', state: 'running' } }))
    const c = deriveWorkbenchDetail(source({ phase: 'held', epoch: 4, task: { taskId: 't-1', sessionId: 's-1', state: 'running' } }))
    expect(a.key).toBe('held:3:t-1:s-1')
    expect(b.key).toBe('held:3:t-2:s-2')
    expect(c.key).toBe('held:4:t-1:s-1')
    expect(new Set([a.key, b.key, c.key]).size).toBe(3)
  })

  it('身份只由控制态字段组成：缺 epoch 或 sessionId 一律无身份（不猜目标）', () => {
    expect(workbenchDetailKey({ phase: 'held', epoch: null, taskId: 't-1', sessionId: 's-1' })).toBeNull()
    expect(workbenchDetailKey({ phase: 'held', epoch: 3, taskId: 't-1', sessionId: null })).toBeNull()
    expect(workbenchDetailKey({ phase: 'held', epoch: 3, taskId: null, sessionId: 's-1' })).toBe('held:3:-:s-1')
  })
})
interface FakeService {
  revoke: (reason: string) => void
  snapshots: number
  getSnapshot: () => { binding: null }
}

function fakeService(): FakeService {
  const calls: string[] = []
  return {
    snapshots: 0,
    revoke: (reason: string) => {
      calls.push(reason)
      void calls
    },
    getSnapshot: () => {
      return { binding: null }
    }
  }
}

describe('host token 撤销 → 服务撤销（真实订阅回调层）', () => {
  it('受控插件撤销时即使没有已登记 binding 也必须调用 revoke（在飞 acquire 要失效）', () => {
    const service = fakeService()
    const revocations: string[] = []
    service.revoke = (reason) => revocations.push(reason)
    const handler = createPluginRevokeHandler(() => service as never, EXCLUSIVE_CONTROLLER_PLUGIN_ID)

    // 关键：snapshot 里 binding 为 null（acquire 还在飞），仍然必须撤销
    expect(service.getSnapshot().binding).toBeNull()
    handler(EXCLUSIVE_CONTROLLER_PLUGIN_ID)

    expect(revocations.length).toBe(1)
    expect(revocations[0]).toContain('revoked')
  })

  it('其他插件的 host token 撤销被忽略（不误撤受控插件）', () => {
    const revocations: string[] = []
    const handler = createPluginRevokeHandler(
      () => ({ revoke: (reason: string) => revocations.push(reason) }) as never,
      EXCLUSIVE_CONTROLLER_PLUGIN_ID
    )
    handler('some-other-plugin')
    handler('')
    expect(revocations).toEqual([])
  })

  it('服务尚未初始化时不抛（退出路径/早期撤销）', () => {
    const handler = createPluginRevokeHandler(() => null, EXCLUSIVE_CONTROLLER_PLUGIN_ID)
    expect(() => handler(EXCLUSIVE_CONTROLLER_PLUGIN_ID)).not.toThrow()
  })
})
