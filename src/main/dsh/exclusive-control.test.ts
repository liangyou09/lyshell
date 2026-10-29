import { describe, it, expect, vi } from 'vitest'
import {
  ExclusiveControlService,
  type ExclusiveAuthFacts,
  type ExclusiveBackendLease,
  type ExclusiveBridgeCommand,
  type ExclusiveBridgeOutcome
} from './exclusive-control'
import {
  EXCLUSIVE_EVENT_BUFFER_LIMIT,
  EXCLUSIVE_TRANSCRIPT_LIMIT,
  type ExclusiveApprovalView,
  type ExclusiveTaskView
} from '@shared/exclusive-control'

vi.mock('electron-log', () => ({ default: { info: () => {}, error: () => {}, warn: () => {} } }))

/**
 * 独占控制服务（LyShell 主进程侧）的授权、准入与同步测试。
 *
 * 桥侧真实行为（gate / 原生审批 / 官方服务 / 真实 turn-end）由 exclusive-bridge.test.ts
 * 用真实插件源码覆盖；这里替换桥边界，断言的是主进程侧判定：
 * 真实 host token 授权、S2 后台租约、变更准入、桥失败不假成功、同步幂等。
 */

const PLUGIN = 'aipet'
const BRIDGE_FACTS: ExclusiveAuthFacts = { kind: 'plugin', pluginId: PLUGIN, tokenSource: 'host' }

interface Harness {
  service: ExclusiveControlService
  commands: ExclusiveBridgeCommand[]
  leases: { acquired: string[]; released: string[] }
  setOutcome: (impl: (command: ExclusiveBridgeCommand, call: number) => ExclusiveBridgeOutcome) => void
  setPluginEnabled: (value: boolean) => void
  setBackendAvailable: (value: boolean) => void
  setSyncOutcome: (value: ExclusiveBridgeOutcome | null) => void
  setInstance: (value: { instanceId: string; instanceEpoch: number } | null) => void
}

function makeHarness(over: { pluginEnabled?: boolean; backend?: boolean } = {}): Harness {
  const commands: ExclusiveBridgeCommand[] = []
  const leases = { acquired: [] as string[], released: [] as string[] }
  let pluginEnabled = over.pluginEnabled ?? true
  let backendAvailable = over.backend ?? true
  let syncOutcome: ExclusiveBridgeOutcome | null = null
  let instance: { instanceId: string; instanceEpoch: number } | null = { instanceId: 'inst-1', instanceEpoch: 1000 }
  let outcomeImpl: (command: ExclusiveBridgeCommand, call: number) => ExclusiveBridgeOutcome = (command) => ({
    ok: true,
    identity: { instanceId: 'inst-1', instanceEpoch: 1000 },
    holding: true,
    ...(command.cmd === 'session'
      ? { sessionId: command.mode === 'select' ? (command.sessionId ?? 'session-1') : 'session-new' }
      : {})
  })

  const service = new ExclusiveControlService({
    runBridge: async (command) => {
      if (command.cmd === 'snapshot' && syncOutcome !== null) return syncOutcome
      commands.push(command)
      return outcomeImpl(command, commands.length)
    },
    currentInstance: () => instance,
    isPluginEnabled: () => pluginEnabled,
    acquireBackend: async (bindingId): Promise<ExclusiveBackendLease | null> => {
      if (!backendAvailable) return null
      const leaseId = `exclusive:${bindingId}`
      leases.acquired.push(leaseId)
      return { bindingId: leaseId, release: () => leases.released.push(leaseId) }
    }
  })

  return {
    service,
    commands,
    leases,
    setOutcome: (impl) => {
      outcomeImpl = impl
    },
    setPluginEnabled: (value) => {
      pluginEnabled = value
    },
    setBackendAvailable: (value) => {
      backendAvailable = value
    },
    setSyncOutcome: (value) => {
      syncOutcome = value
    },
    setInstance: (value) => {
      instance = value
    }
  }
}

async function held(h: Harness): Promise<number> {
  const acquired = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
  if (!acquired.ok) throw new Error(`acquire failed: ${acquired.code}`)
  return acquired.binding.epoch
}

const task = (over: Partial<ExclusiveTaskView> = {}): ExclusiveTaskView => ({
  taskId: 'task-1',
  sessionId: 'session-1',
  epoch: 1,
  state: 'running',
  acceptedAt: 1,
  ...over
})

const approval = (over: Partial<ExclusiveApprovalView> = {}): ExclusiveApprovalView => ({
  approvalId: 'appr-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  epoch: 1,
  toolName: 'pwsh',
  askedAt: 5,
  ...over
})

describe('凭据层：只认受控插件的 host token', () => {
  it('确定换代后旧绑定/审批失效，任务结果保留未知，新 acquire 不再返回旧绑定', async () => {
    const h = makeHarness(), epoch = await held(h)
    h.setSyncOutcome({ ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 }, holding: true,
      task: task({ epoch }), approvals: [approval({ epoch })] })
    await h.service.syncFromBridge()
    h.setInstance(null)
    expect(h.service.getSnapshot().binding?.epoch).toBe(epoch)
    h.setInstance({ instanceId: 'inst-2', instanceEpoch: 2000 })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: false, code: 'auth/generation-stale' })
    expect(h.service.getSnapshot()).toMatchObject({ phase: 'free', binding: null, activeTask: null, approvals: [],
      interruptedTasks: [{ outcome: 'unknown', task: { taskId: 'task-1', state: 'running' } }] })
    h.setOutcome(() => ({ ok: true, identity: { instanceId: 'inst-2', instanceEpoch: 2000 }, holding: true }))
    const reacquired = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    expect(reacquired).toMatchObject({ ok: true, binding: { instanceId: 'inst-2' } })
    expect(h.commands.some(command => command.cmd === 'submit' || command.cmd === 'cancel')).toBe(false)
  })
  it('global/session/UI token/其他插件一律按冒充拒绝', () => {
    const h = makeHarness()
    for (const facts of [
      { kind: 'global' },
      { kind: 'session' },
      { kind: 'plugin', pluginId: PLUGIN, tokenSource: 'ui' as const },
      { kind: 'plugin', pluginId: 'other-plugin', tokenSource: 'host' as const },
      { kind: 'plugin', tokenSource: 'host' as const }
    ] satisfies ExclusiveAuthFacts[]) {
      const out = h.service.authorize(facts)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.code).toBe('auth/impersonation')
    }
    expect(h.service.authorize({ kind: 'dshBridge' }).ok).toBe(false)
    expect(h.service.authorize(BRIDGE_FACTS).ok).toBe(true)
  })

  it('插件未启用即拒绝（真实启用态来自仓库，不看请求体）', () => {
    const h = makeHarness({ pluginEnabled: false })
    const out = h.service.authorize(BRIDGE_FACTS)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('auth/not-enabled')
  })

  it('快照对已鉴权凭据只读开放（不含凭据字段）', async () => {
    const h = makeHarness()
    await held(h)
    expect(h.service.canReadSnapshot({ kind: 'ui' })).toBe(true)
    const json = JSON.stringify(h.service.getSnapshot())
    expect(json).not.toContain('token')
    expect(json).not.toContain('LYSHELL')
  })
})

describe('一次完整授权（acquire 复用 S2 后台 + 桥接管）', () => {
  for (const boundary of ['backend', 'bridge']) it(`acquire 请求在 ${boundary} await 期间断开不留孤立绑定`, async () => {
    let continueAcquire!: () => void
    const pending = new Promise<void>(resolve => { continueAcquire = resolve })
    const commands: string[] = []
    let entered = false, released = false
    const service = new ExclusiveControlService({ isPluginEnabled: () => true,
      currentInstance: () => ({ instanceId: 'i', instanceEpoch: 1 }),
      acquireBackend: async bindingId => {
        if (boundary === 'backend') { entered = true; await pending }
        return { bindingId, release: () => { released = true } }
      }, runBridge: async command => {
        commands.push(command.cmd)
        if (boundary === 'bridge' && command.cmd === 'acquire') { entered = true; await pending }
        return { ok: true, identity: { instanceId: 'i', instanceEpoch: 1 } }
      } })
    const abort = new AbortController()
    const acquire = service.acquire({ pluginId: 'aipet', pluginInstanceId: 'pet' }, abort.signal)
    while (!entered) await Promise.resolve()
    abort.abort(); continueAcquire()
    expect((await acquire).ok).toBe(false)
    expect(service.getSnapshot().phase).toBe('free')
    expect(service.getSnapshot().binding).toBeNull()
    expect(released).toBe(true)
    expect(commands).toEqual(boundary === 'backend' ? [] : ['acquire', 'release'])
  })
  it('成功：拿到后台租约 → 桥 acquire → 登记绑定/代际', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    expect(epoch).toBe(1)
    expect(h.leases.acquired.length).toBe(1)
    expect(h.commands.map((c) => c.cmd)).toEqual(['acquire'])
    expect(h.service.isHeld).toBe(true)
  })

  it('同插件实例重复 acquire 幂等：不换 epoch、不重启后台、不再叫桥', async () => {
    const h = makeHarness()
    const first = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    const again = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    expect(first.ok && again.ok).toBe(true)
    if (!first.ok || !again.ok) return
    expect(again.binding).toEqual(first.binding)
    expect(h.leases.acquired.length).toBe(1)
    expect(h.commands.filter((c) => c.cmd === 'acquire').length).toBe(1)
  })

  it('其他插件实例持有 ⇒ held-by-other，且不再叫桥', async () => {
    const h = makeHarness()
    await held(h)
    const other = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-2' })
    expect(other).toMatchObject({ ok: false, code: 'control/held-by-other' })
  })

  it('后台拿不到 ⇒ instance/no-bridge，不登记绑定、不叫桥', async () => {
    const h = makeHarness({ backend: false })
    const result = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    expect(result).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    expect(h.commands).toEqual([])
    expect(h.service.isHeld).toBe(false)
    expect(h.service.getSnapshot().phase).toBe('free')
  })

  it('桥拒绝 acquire ⇒ 释放本次后台租约（不留空绑定）', async () => {
    const h = makeHarness()
    h.setOutcome(() => ({ ok: false, code: 'bridge/unavailable', error: 'down' }))
    const result = await h.service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    expect(result).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    expect(h.leases.acquired.length).toBe(1)
    expect(h.leases.released).toEqual(h.leases.acquired)
    expect(h.service.isHeld).toBe(false)
  })

  it('acquire 期间被撤销：不复活（generation-stale）并释放租约', async () => {
    const leases = { acquired: [] as string[], released: [] as string[] }
    let releaseBackend = (): void => undefined
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve
    })
    const service = new ExclusiveControlService({
      runBridge: async (command) =>
        command.cmd === 'acquire'
          ? { ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 }, holding: true }
          : { ok: true, holding: false },
      currentInstance: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
      isPluginEnabled: () => true,
      acquireBackend: async (bindingId) => {
        await backendGate // 卡在后台获取这一步：此时代际已分配、绑定尚未登记
        leases.acquired.push(bindingId)
        return { bindingId, release: () => leases.released.push(bindingId) }
      }
    })
    const pending = service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    // 后台还没就绪时撤销：在飞 acquire 必须失效，不得复活
    service.revoke('plugin disabled')
    releaseBackend()
    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'auth/generation-stale' })
    expect(service.isHeld).toBe(false)
    expect(leases.released).toEqual(leases.acquired)
  })

  it('撤销发生在桥已接管之后：向该 epoch 发真实 release 并等回执，不假 free', async () => {
    const leases = { acquired: [] as string[], released: [] as string[] }
    const commands: ExclusiveBridgeCommand[] = []
    let releaseBackend = (): void => undefined
    const acquireGate = new Promise<void>((resolve) => {
      releaseBackend = resolve
    })
    const service = new ExclusiveControlService({
      runBridge: async (command) => {
        commands.push(command)
        if (command.cmd === 'acquire') {
          await acquireGate // 桥 acquire 挂起期间发生撤销
          return { ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 }, holding: true }
        }
        if (command.cmd === 'release') return { ok: true, holding: false }
        return { ok: true, holding: true }
      },
      currentInstance: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
      isPluginEnabled: () => true,
      acquireBackend: async (bindingId) => {
        leases.acquired.push(bindingId)
        return { bindingId, release: () => leases.released.push(bindingId) }
      }
    })
    const pending = service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    await new Promise((r) => setTimeout(r, 0))
    service.revoke('plugin disabled')
    releaseBackend()
    const result = await pending
    expect(result.ok).toBe(false)
    // 桥已经持有这个 epoch ⇒ 必须真的发 release（不能直接置 free 把桥留在旧 epoch 上）
    const releaseCommands = commands.filter((c) => c.cmd === 'release')
    expect(releaseCommands.length).toBe(1)
    expect(releaseCommands[0]).toMatchObject({ epoch: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(service.isHeld).toBe(false)
    expect(leases.released).toEqual(leases.acquired)
  })

  it('桥接管后撤销但桥 release 未确认：保持 releasing 且不假 free，旧请求仍被拒', async () => {
    const leases = { acquired: [] as string[], released: [] as string[] }
    let releaseBackend = (): void => undefined
    const acquireGate = new Promise<void>((resolve) => {
      releaseBackend = resolve
    })
    const service = new ExclusiveControlService({
      runBridge: async (command) => {
        if (command.cmd === 'acquire') {
          await acquireGate
          return { ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 }, holding: true }
        }
        if (command.cmd === 'release') return { ok: false, code: 'bridge/unavailable', error: 'down' }
        return { ok: true, holding: true }
      },
      currentInstance: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
      isPluginEnabled: () => true,
      acquireBackend: async (bindingId) => {
        leases.acquired.push(bindingId)
        return { bindingId, release: () => leases.released.push(bindingId) }
      }
    })
    const pending = service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    await new Promise((r) => setTimeout(r, 0))
    service.revoke('plugin disabled')
    releaseBackend()
    const result = await pending
    expect(result).toMatchObject({ ok: false })
    await new Promise((r) => setTimeout(r, 0))
    // 桥未确认 ⇒ 不能假 free，租约也不释放（可重试 release）
    expect(service.isHeld).toBe(false)
    expect(service.getSnapshot().phase).toBe('releasing')
    expect(leases.released).toEqual([])
    expect(service.getSnapshot().binding).not.toBeNull()
  })
})

describe('release / revoke：不假成功、不自造终态、不 kill 后台', () => {
  it('release 桥失败：保留 held + 明确错误，租约不释放', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome(() => ({ ok: false, code: 'bridge/unavailable', error: 'down' }))
    const result = await h.service.release(epoch)
    expect(result).toMatchObject({ ok: false, code: 'bridge/unavailable' })
    expect(h.service.isHeld).toBe(true)
    expect(h.service.getSnapshot().phase).toBe('held')
    expect(h.leases.released).toEqual([])
  })

  it('release 桥确认终态：清绑定 + 解租约（只解绑，不 kill）', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome(() => ({ ok: true, task: task({ state: 'cancelled', endedAt: 9, endReason: 'aborted' }) }))
    const result = await h.service.release(epoch)
    expect(result.ok).toBe(true)
    expect(h.service.isHeld).toBe(false)
    expect(h.leases.released).toEqual(h.leases.acquired)
    expect(h.service.getSnapshot().activeTask?.state).toBe('cancelled')
  })

  it('revoke：立即停止接受请求，桥未确认期间保持 releasing（不假 free）', async () => {
    const h = makeHarness()
    await held(h)
    h.setOutcome(() => ({ ok: false, code: 'bridge/unavailable', error: 'down' }))
    h.service.revoke('plugin disabled')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.service.getSnapshot().phase).toBe('releasing')
    // 撤销后旧请求一律拒绝（凭据层已经不启用；epoch 也拒绝）
    h.setPluginEnabled(false)
    const out = h.service.authorize(BRIDGE_FACTS)
    expect(out.ok).toBe(false)
    h.setPluginEnabled(true)
    expect(await h.service.submit({ epoch: 99, text: 'x' })).toMatchObject({ ok: false })
  })
})

describe('任务：准入串行 + 终态只认桥 + 不登记陈旧结果', () => {
  it('单活动任务：第二个提交 busy', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome((command) =>
      command.cmd === 'submit'
        ? { ok: true, task: task({ taskId: command.taskId, state: 'accepted', acceptedAt: 1 }) }
        : { ok: true, holding: true }
    )
    expect(await h.service.submit({ epoch, sessionId: 'session-1', text: 'a' })).toMatchObject({ ok: true })
    expect(await h.service.submit({ epoch, sessionId: 'session-1', text: 'b' })).toMatchObject({ ok: false, code: 'task/busy' })
  })

  it('submit 之后绑定已被替换：不登记陈旧结果（stale-epoch）', async () => {
    let releaseSubmit = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      releaseSubmit = resolve
    })
    const service = new ExclusiveControlService({
      runBridge: async (command) => {
        if (command.cmd === 'submit') {
          await gate // 桥回复期间控制权被交回
          return { ok: true, task: task({ taskId: command.taskId, state: 'accepted', acceptedAt: 1 }) }
        }
        if (command.cmd === 'acquire') return { ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 }, holding: true }
        return { ok: true, holding: false }
      },
      currentInstance: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
      isPluginEnabled: () => true,
      acquireBackend: async (bindingId) => ({ bindingId, release: () => undefined })
    })
    const acquired = await service.acquire({ pluginId: PLUGIN, pluginInstanceId: 'pet-1' })
    if (!acquired.ok) return
    const pending = service.submit({ epoch: acquired.binding.epoch, sessionId: 'session-1', text: 'a' })
    // release 走同一准入链（排在 submit 之后），所以不 await；撤销则立即生效
    service.revoke('controller superseded')
    releaseSubmit()
    const result = await pending
    // 陈旧结果绝不登记：撤销后不得把 accepted 任务写进新状态
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('task/stale-epoch')
    expect(service.getSnapshot().activeTask).toBeNull()
  })

  it('cancel 只 ack：不把任务改成 cancelled（终态等桥的 turn/end）', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome((command) => {
      if (command.cmd === 'submit') return { ok: true, task: task({ taskId: command.taskId, state: 'accepted', acceptedAt: 1 }) }
      if (command.cmd === 'cancel') return { ok: true, task: task({ taskId: command.taskId, state: 'accepted', acceptedAt: 1 }) }
      return { ok: true, holding: true }
    })
    const submitted = await h.service.submit({ epoch, sessionId: 'session-1', text: 'a' })
    if (!submitted.ok) return
    const cancelled = await h.service.cancel({ epoch, taskId: submitted.task.taskId })
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.task.state).toBe('accepted')
  })

  it('旧 epoch 的取消/提交一律拒绝', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    expect(await h.service.cancel({ epoch: epoch + 1, taskId: 'task-1' })).toMatchObject({ ok: false, code: 'task/stale-epoch' })
    expect(await h.service.submit({ epoch: epoch + 1, text: 'x' })).toMatchObject({ ok: false, code: 'task/stale-epoch' })
  })
})

describe('桥状态同步：终态 / 审批 / 工作输出（幂等、无幽灵）', () => {
  it('同步把桥的真实终态写入，且重复同步同状态不重复加事件', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({ ok: true, task: task({ state: 'completed', endedAt: 7, endReason: 'completed' }) })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: true })
    const afterFirst = h.service.getSnapshot()
    expect(afterFirst.activeTask?.state).toBe('completed')
    const eventsAfterFirst = h.service.getEvents(0, 100).events.length
    await h.service.syncFromBridge()
    expect(h.service.getEvents(0, 100).events.length).toBe(eventsAfterFirst)
  })

  it('待答审批同步登记一次；桥侧消失即自动清理（不留下幽灵审批）', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({ ok: true, task: task({ state: 'running' }), approvals: [approval()] })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().approvals.map((a) => a.approvalId)).toEqual(['appr-1'])
    const askedEvents = h.service.getEvents(0, 100).events.filter((e) => e.type === 'approval/asked').length
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().approvals.length).toBe(1)
    expect(h.service.getEvents(0, 100).events.filter((e) => e.type === 'approval/asked').length).toBe(askedEvents)

    h.setSyncOutcome({ ok: true, task: task({ state: 'running' }), approvals: [] })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().approvals).toEqual([])
    expect(h.service.getSnapshot().pendingApproval).toBeNull()
  })

  it('审批回答：只接受当前待答且同代际；陈旧回答拒绝', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setSyncOutcome({ ok: true, task: task({ state: 'running' }), approvals: [approval({ epoch })] })
    await h.service.syncFromBridge()
    expect(await h.service.approve({ epoch, approvalId: 'nope', outcome: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'approval/not-pending'
    })
    h.setOutcome(() => ({ ok: true, approval: 'rejected' }))
    const ok = await h.service.approve({ epoch, approvalId: 'appr-1', outcome: 'rejected' })
    expect(ok).toMatchObject({ ok: true, outcome: 'rejected' })
    expect(h.service.getSnapshot().approvals).toEqual([])
    expect(h.service.getEvents(0, 100).events.some((e) => e.type === 'approval/decided')).toBe(true)
  })

  it('任务终结后同任务的待答审批一并作废', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({ ok: true, task: task({ state: 'running' }), approvals: [approval()] })
    await h.service.syncFromBridge()
    h.setSyncOutcome({ ok: true, task: task({ state: 'cancelled', endedAt: 3, endReason: 'aborted' }), approvals: [] })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().approvals).toEqual([])
  })

  it('工作输出：有界 transcript、按 seq 去重、文本截断', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({
      ok: true,
      task: task({ state: 'running' }),
      transcript: [
        { seq: 1, at: 1, kind: 'user', sessionId: 'session-1', text: 'hi' },
        { seq: 2, at: 2, kind: 'assistant', sessionId: 'session-1', text: 'x'.repeat(2000) },
        { seq: 3, at: 3, kind: 'tool-call', sessionId: 'session-1', toolName: 'pwsh', text: 'Get-Date' },
        { seq: 4, at: 4, kind: 'tool-result', sessionId: 'session-1', toolName: 'pwsh', text: 'out', failed: true }
      ]
    })
    await h.service.syncFromBridge()
    const first = h.service.getSnapshot().transcript
    expect(first.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool-call', 'tool-result'])
    expect(first[1].text.length).toBeLessThanOrEqual(512)
    expect(first[3].failed).toBe(true)
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().transcript.length).toBe(first.length)

    // 大量条目 ⇒ 有界截断
    const many = Array.from({ length: EXCLUSIVE_TRANSCRIPT_LIMIT + 20 }, (_, i) => ({
      seq: 100 + i,
      at: i,
      kind: 'assistant' as const,
      sessionId: 'session-1',
      text: `m${i}`
    }))
    h.setSyncOutcome({ ok: true, task: task({ state: 'running' }), transcript: many })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().transcript.length).toBe(EXCLUSIVE_TRANSCRIPT_LIMIT)
  })

  it('桥不可达：同步返回明确 host 错误，不 local fallback', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({ ok: false, code: 'bridge/unavailable', error: 'down' })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: false, code: 'bridge/unavailable' })
  })

  it('未持有时同步是 no-op（不去叫桥）', async () => {
    const h = makeHarness()
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: true })
    expect(h.commands).toEqual([])
  })

  it('桥自报别的实例（后台换代）：generation-stale，不继续报旧 held 快照', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({ ok: true, holding: true, identity: { instanceId: 'inst-OTHER', instanceEpoch: 2000 }, task: task({ state: 'running' }) })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: false, code: 'auth/generation-stale' })
  })

  it('currentInstance 被替换：generation-stale', async () => {
    const h = makeHarness()
    await held(h)
    h.setInstance({ instanceId: 'inst-NEW', instanceEpoch: 3000 })
    h.setSyncOutcome({ ok: true, holding: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 } })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: false, code: 'auth/generation-stale' })
  })

  it('桥 holding=false：明确 bridge 错误，不能继续报 held', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({ ok: true, holding: false, task: task({ state: 'completed', endedAt: 5 }) })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: false, code: 'bridge/unavailable' })
  })

  it('旧 epoch 的任务/审批不被接纳（不覆盖当前绑定）', async () => {
    const h = makeHarness()
    await held(h)
    h.setSyncOutcome({
      ok: true,
      holding: true,
      identity: { instanceId: 'inst-1', instanceEpoch: 1000 },
      task: task({ epoch: 99, taskId: 'task-old', state: 'running' }),
      approvals: [approval({ epoch: 99, approvalId: 'appr-old', taskId: 'task-old' })]
    })
    expect(await h.service.syncFromBridge()).toMatchObject({ ok: true })
    const snap = h.service.getSnapshot()
    expect(snap.activeTask).toBeNull()
    expect(snap.approvals).toEqual([])
  })

  it('本地已有新 task 时，桥报另一旧 taskId 不被跟随', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome((command) =>
      command.cmd === 'submit' ? { ok: true, task: task({ taskId: command.taskId, state: 'running' }) } : { ok: true, holding: true }
    )
    const submitted = await h.service.submit({ epoch, sessionId: 'session-1', text: 'a' })
    if (!submitted.ok) return
    h.setSyncOutcome({
      ok: true,
      holding: true,
      identity: { instanceId: 'inst-1', instanceEpoch: 1000 },
      task: task({ epoch, taskId: 'task-OTHER', state: 'running' })
    })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().activeTask?.taskId).toBe(submitted.task.taskId)
  })

  it('迟到的旧快照不把已终结任务拉回 open', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome((command) =>
      command.cmd === 'submit' ? { ok: true, task: task({ taskId: command.taskId, state: 'running' }) } : { ok: true, holding: true }
    )
    const submitted = await h.service.submit({ epoch, sessionId: 'session-1', text: 'a' })
    if (!submitted.ok) return
    h.setSyncOutcome({
      ok: true,
      holding: true,
      identity: { instanceId: 'inst-1', instanceEpoch: 1000 },
      task: task({ epoch, taskId: submitted.task.taskId, state: 'completed', endedAt: 9, endReason: 'completed' })
    })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().activeTask?.state).toBe('completed')

    // 迟到的旧快照（同一 task 但仍是 running）
    h.setSyncOutcome({
      ok: true,
      holding: true,
      identity: { instanceId: 'inst-1', instanceEpoch: 1000 },
      task: task({ epoch, taskId: submitted.task.taskId, state: 'running' }),
      approvals: [approval({ epoch, taskId: submitted.task.taskId })]
    })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().activeTask?.state).toBe('completed')
    expect(h.service.getSnapshot().approvals).toEqual([])
  })

  it('旧任务的迟到输出不污染同会话的新任务', async () => {
    const h = makeHarness()
    const epoch = await held(h)
    h.setOutcome(command => command.cmd === 'submit'
      ? { ok: true, task: task({ epoch, taskId: command.taskId, state: 'running' }) }
      : { ok: true, holding: true })
    const first = await h.service.submit({ epoch, sessionId: 'session-1', text: 'first' })
    if (!first.ok) throw new Error('first task refused')
    h.setSyncOutcome({ ok: true, task: { ...first.task, state: 'completed', endedAt: 10 } })
    await h.service.syncFromBridge()
    const second = await h.service.submit({ epoch, sessionId: 'session-1', text: 'second' })
    if (!second.ok) throw new Error('second task refused')
    h.setSyncOutcome({ ok: true, task: first.task, transcript: [{ seq: 90, at: 10,
      kind: 'assistant', sessionId: 'session-1', taskId: first.task.taskId, text: 'old task output' }] })
    await h.service.syncFromBridge()
    expect(h.service.getSnapshot().activeTask?.taskId).toBe(second.task.taskId)
    expect(h.service.getSnapshot().transcript).toEqual([])
  })
})

describe('有界事件与快照恢复', () => {
  it('事件严格递增；游标太旧 ⇒ gap 且带 snapshot', async () => {
    const h = makeHarness()
    await held(h)
    const first = h.service.getEvents(0, 100)
    expect(first.gap).toBe(false)
    expect(first.events.map((e) => e.type)).toContain('control/acquired')

    for (let i = 0; i < EXCLUSIVE_EVENT_BUFFER_LIMIT + 10; i++) {
      h.setSyncOutcome({
        ok: true,
        task: task({ state: 'running' }),
        approvals: [
          {
            approvalId: `appr-${i}`,
            taskId: 'task-1',
            sessionId: 'session-1',
            epoch: 1,
            toolName: 'pwsh',
            askedAt: i
          }
        ]
      })
      await h.service.syncFromBridge()
    }
    const gapped = h.service.getEvents(0, 100)
    expect(gapped.gap).toBe(true)
    expect(gapped.snapshot.binding?.epoch).toBe(1)
    expect(gapped.lastEventSeq).toBeGreaterThan(EXCLUSIVE_EVENT_BUFFER_LIMIT)
  })
})
