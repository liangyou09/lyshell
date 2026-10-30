/**
 * InputControlService —— 控制租约的纯逻辑测试（无 IO）。
 *
 * 覆盖步骤 07 要求的判定：同会话冲突、同租约续期、GUI 接管后旧句柄/延迟写入失效、
 * 换连接实例后旧租约失效、过期、凭据撤销，以及「fence 装不上就不发租约」。
 * 执行边界用记录器替身：它拿到的是 fence 而不是任何调用方凭据。
 */

import { describe, expect, it } from 'vitest'
import {
  InputControlError,
  type ControllerIdentity,
  type InputFence
} from '@shared/terminal-control'
import { InputControlService } from './input-control'

const GUI_A: ControllerIdentity = { principalId: 'principal-gui', credentialId: 'cred-gui-a', source: 'gui' }
const GUI_B: ControllerIdentity = { principalId: 'principal-gui', credentialId: 'cred-gui-b', source: 'gui' }
const AUTOMATION: ControllerIdentity = { principalId: 'principal-auto', credentialId: 'cred-auto', source: 'automation' }

interface Clock {
  now: () => number
  advance: (ms: number) => void
}

function makeClock(start = 1_000_000): Clock {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    }
  }
}

/** 记录式执行边界：成功时记下 fence，失败模式由用例切换。 */
class FakeBoundary {
  readonly calls: Array<{ sessionId: string; fence: InputFence | null }> = []
  failInstall = false
  failClear = false
  private pending = 0
  maxConcurrent = 0

  async handle(sessionId: string, fence: InputFence | null): Promise<void> {
    this.pending += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.pending)
    try {
      await Promise.resolve()
      if (fence !== null && this.failInstall) throw new Error('host refused the fence')
      if (fence === null && this.failClear) throw new Error('host refused to clear the fence')
      this.calls.push({ sessionId, fence: fence === null ? null : { ...fence } })
    } finally {
      this.pending -= 1
    }
  }

  get installed(): InputFence | null {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const fence = this.calls[index].fence
      if (fence !== null) return fence
    }
    return null
  }

  get lastFence(): InputFence | null | undefined {
    return this.calls.at(-1)?.fence
  }
}

function setup(options: { ttlMs?: number; boundary?: FakeBoundary; connectionInstanceId?: string } = {}): {
  service: InputControlService
  boundary: FakeBoundary
  clock: Clock
} {
  const clock = makeClock()
  const boundary = options.boundary ?? new FakeBoundary()
  const service = new InputControlService({
    now: clock.now,
    onFence: (sessionId, fence) => boundary.handle(sessionId, fence),
    leaseTtlMs: options.ttlMs ?? 30_000,
    controllerInstanceId: 'main-instance-1'
  })
  service.bindSession('session-1', options.connectionInstanceId ?? 'conn-1')
  return { service, boundary, clock }
}

async function rejection(promise: Promise<unknown>): Promise<InputControlError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(InputControlError)
    return error as InputControlError
  }
  throw new Error('expected the promise to reject')
}

describe('acquire：同一会话至多一个有效控制者', () => {
  it('围栏安装等待期间撤销会话，不得在安装回执后复活租约', async () => {
    let installed!: () => void
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const calls: Array<InputFence | null> = []
    const service = new InputControlService({ onFence: async (_id, fence) => {
      calls.push(fence)
      if (fence) { started(); await new Promise<void>(resolve => { installed = resolve }) }
    } })
    service.bindSession('session-1', 'conn-1')
    const pending = service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const failure = rejection(pending)
    await began
    const invalidation = service.invalidateSession('session-1')
    installed()
    expect((await failure).reason).toBe('lease-revoked')
    await invalidation
    expect(service.currentSnapshot('session-1')?.lease).toBeNull()
    expect(calls.at(-1)).toBeNull()
  })

  it('同一持有者重复取得返回同一租约，不涨 epoch', async () => {
    const { service, boundary } = setup()
    const first = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const second = await service.acquire({ sessionId: 'session-1', identity: GUI_A })

    expect(second.leaseId).toBe(first.leaseId)
    expect(second.epoch).toBe(first.epoch)
    // 没有为重复取得再装一次 fence
    expect(boundary.calls).toHaveLength(1)
  })

  it('他人持有时自动化被拒绝，且不触碰已有 fence', async () => {
    const { service, boundary } = setup()
    await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const before = boundary.calls.length

    const error = await rejection(service.acquire({ sessionId: 'session-1', identity: AUTOMATION, contextConfirmed: true }))
    expect(error.reason).toBe('held-by-other')
    expect(boundary.calls.length).toBe(before)
  })

  it('自动化没有显式上下文确认时根本进不来', async () => {
    const { service } = setup()
    const error = await rejection(service.acquire({ sessionId: 'session-1', identity: AUTOMATION }))
    expect(error.reason).toBe('context-not-confirmed')
    expect(error.code).toBe('INVALID_ARGUMENT')
  })

  it('自动化不能发起 takeover', async () => {
    const { service } = setup()
    await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const error = await rejection(
      service.acquire({ sessionId: 'session-1', identity: AUTOMATION, contextConfirmed: true, takeover: true })
    )
    expect(error.reason).toBe('automation-takeover-denied')
  })

  it('返回句柄只含 fence 与主体身份，不含其他凭据', async () => {
    const { service } = setup()
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    expect(handle).toMatchObject({
      sessionId: 'session-1',
      connectionInstanceId: 'conn-1',
      controllerInstanceId: 'main-instance-1',
      principalId: 'principal-gui',
      credentialId: 'cred-gui-a',
      source: 'gui'
    })
    expect(Object.isFrozen(handle)).toBe(true)
  })
})

describe('renew：续期不改代际', () => {
  it('续期保持 leaseId/epoch，只延长 expiresAt，并重新确认 fence', async () => {
    const { service, boundary, clock } = setup({ ttlMs: 1000 })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    clock.advance(400)
    const renewed = await service.renew(handle)

    expect(renewed.leaseId).toBe(handle.leaseId)
    expect(renewed.epoch).toBe(handle.epoch)
    expect(renewed.expiresAt).toBeGreaterThan(handle.expiresAt)
    expect(boundary.lastFence?.expiresAt).toBe(renewed.expiresAt)
    expect(boundary.lastFence?.epoch).toBe(handle.epoch)
    await expect(service.assertInput(renewed)).resolves.toMatchObject({ leaseId: handle.leaseId })
  })

  it('过期租约不能靠续期复活', async () => {
    const { service, clock } = setup({ ttlMs: 1000 })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    clock.advance(1000)
    const error = await rejection(service.renew(handle))
    expect(error.reason).toBe('lease-expired')
  })

  it('租约生命周期上限之后必须重新取得', async () => {
    const { service, clock } = setup({ ttlMs: 60_000 })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    clock.advance(10 * 60_000)
    const error = await rejection(service.renew(handle))
    expect(error.reason).toBe('lease-expired')
  })
})

describe('GUI takeover：旧句柄与延迟输入一律失效', () => {
  it('接管推进 epoch，旧 fence 被撤销，旧句柄的 assertInput 失败', async () => {
    const { service, boundary } = setup()
    const oldHandle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const newHandle = await service.acquire({ sessionId: 'session-1', identity: GUI_B, takeover: true })

    expect(newHandle.epoch).toBe(oldHandle.epoch + 1)
    expect(newHandle.leaseId).not.toBe(oldHandle.leaseId)
    // 先撤销旧 fence（null），再装新 fence
    expect(boundary.calls.map((call) => call.fence === null)).toEqual([false, true, false])
    expect(boundary.installed?.leaseId).toBe(newHandle.leaseId)

    const error = await rejection(service.assertInput(oldHandle))
    expect(error.reason).toBe('not-holder')
    expect(error.code).toBe('STALE_GENERATION')
  })

  it('接管之后旧句柄的 release 不会撤销新租约', async () => {
    const { service, boundary } = setup()
    const oldHandle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const newHandle = await service.acquire({ sessionId: 'session-1', identity: GUI_B, takeover: true })

    const error = await rejection(service.release(oldHandle))
    expect(error.reason).toBe('not-holder')
    expect(service.currentSnapshot('session-1')?.lease?.leaseId).toBe(newHandle.leaseId)
    expect(boundary.installed).not.toBeNull()
  })
})

describe('连接代际', () => {
  it('同一会话换 connectionInstanceId 后旧租约与旧输入失效', async () => {
    const { service, boundary } = setup()
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    const generation = service.bindSession('session-1', 'conn-2')

    expect(generation).toBe(2)
    expect(service.currentSnapshot('session-1')?.lease).toBeNull()
    // bindSession 同步生效；fence 清理是后台进行的（清不掉会置脏而不是放行）
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(boundary.calls.at(-1)?.fence).toBeNull()

    const error = await rejection(service.assertInput(handle))
    expect(error.reason).toBe('connection-replaced')
  })

  it('新连接上取得的新租约使用新 instance 且 epoch 继续递增', async () => {
    const { service } = setup()
    const first = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    service.bindSession('session-1', 'conn-2')
    const second = await service.acquire({ sessionId: 'session-1', identity: GUI_A })

    expect(second.connectionInstanceId).toBe('conn-2')
    expect(second.epoch).toBeGreaterThan(first.epoch)
  })

  it('未登记连接的会话不能取得控制权', async () => {
    const service = new InputControlService({ now: makeClock().now, onFence: async () => undefined })
    const error = await rejection(service.acquire({ sessionId: 'session-x', identity: GUI_A }))
    expect(error.reason).toBe('session-not-bound')
  })

  it('unbind 之后旧句柄失效且不能重新取得', async () => {
    const { service } = setup()
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    await service.unbindSession('session-1')
    expect((await rejection(service.assertInput(handle))).reason).toBe('lease-revoked')
    expect((await rejection(service.acquire({ sessionId: 'session-1', identity: GUI_A }))).reason).toBe('session-not-bound')
  })
})

describe('时间与凭据', () => {
  it('过期之后 assertInput 失败且没有自动续期', async () => {
    const { service, clock } = setup({ ttlMs: 1000 })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    clock.advance(1000)
    const error = await rejection(service.assertInput(handle))
    expect(error.reason).toBe('lease-expired')
    // 租约仍然挂在状态里（只是过期），不会因为断言失败而被续期
    expect(service.currentSnapshot('session-1')?.lease?.expiresAt).toBe(handle.expiresAt)
  })

  it('当前凭据失效后 assertInput 与 renew 都拒绝', async () => {
    const clock = makeClock()
    let valid = true
    const boundary = new FakeBoundary()
    const service = new InputControlService({
      now: clock.now,
      onFence: (sessionId, fence) => boundary.handle(sessionId, fence),
      isCredentialCurrent: () => valid
    })
    service.bindSession('session-1', 'conn-1')
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })

    valid = false
    expect((await rejection(service.assertInput(handle))).reason).toBe('credential-revoked')
    expect((await rejection(service.renew(handle))).reason).toBe('credential-revoked')
  })

  it('invalidatePrincipal 只撤销该主体的租约并清 fence', async () => {
    const { service, boundary } = setup()
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    await service.invalidatePrincipal('other-principal')
    expect(service.currentSnapshot('session-1')?.lease?.leaseId).toBe(handle.leaseId)

    await service.invalidatePrincipal('principal-gui')
    expect(service.currentSnapshot('session-1')?.lease).toBeNull()
    expect((await rejection(service.assertInput(handle))).reason).toBe('lease-revoked')
    expect(boundary.calls.at(-1)?.fence).toBeNull()
  })

  it('invalidateSession / invalidateAll 撤销后必须重新取得', async () => {
    const { service } = setup()
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    await service.invalidateSession('session-1')
    expect((await rejection(service.assertInput(handle))).reason).toBe('lease-revoked')

    const again = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    await service.invalidateAll()
    expect((await rejection(service.assertInput(again))).reason).toBe('lease-revoked')
  })
})

describe('fence 安装失败不发租约', () => {
  it('执行边界拒绝时抛 fence-install-failed，快照里没有租约', async () => {
    const boundary = new FakeBoundary()
    boundary.failInstall = true
    const { service } = setup({ boundary })

    const error = await rejection(service.acquire({ sessionId: 'session-1', identity: GUI_A }))
    expect(error.reason).toBe('fence-install-failed')
    expect(error.code).toBe('CONTROL_CONFLICT')
    expect(service.currentSnapshot('session-1')?.lease).toBeNull()
  })

  it('失败消耗的 epoch 不会复用', async () => {
    const boundary = new FakeBoundary()
    boundary.failInstall = true
    const { service } = setup({ boundary })
    await rejection(service.acquire({ sessionId: 'session-1', identity: GUI_A }))

    boundary.failInstall = false
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    expect(handle.epoch).toBe(2)
  })

  it('撤销 fence 失败后不发放新租约，清理恢复后才放行', async () => {
    const boundary = new FakeBoundary()
    const { service } = setup({ boundary })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })

    boundary.failClear = true
    await service.release(handle)
    expect((await rejection(service.acquire({ sessionId: 'session-1', identity: GUI_A }))).reason).toBe('fence-not-installed')

    boundary.failClear = false
    const next = await service.acquire({ sessionId: 'session-1', identity: GUI_A })
    expect(next.epoch).toBeGreaterThan(handle.epoch)
    await expect(service.assertInput(next)).resolves.toMatchObject({ leaseId: next.leaseId })
  })
})

describe('串行化', () => {
  it('主体撤权覆盖等待宿主确认的获取操作，迟到确认不能发放租约', async () => {
    let acknowledge!: () => void
    const service = new InputControlService({ onFence: async (_session, fence) => {
      if (fence) await new Promise<void>(resolve => { acknowledge = resolve })
    } })
    service.bindSession('session', 'connection')
    const pending = service.acquire({ sessionId: 'session', identity: GUI_A })
    await Promise.resolve()
    const revoked = service.invalidatePrincipal(GUI_A.principalId)
    acknowledge()
    await expect(pending).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    await revoked
    expect(service.currentSnapshot('session')?.lease).toBeNull()
    await service.forgetSession('session')
    expect(service.snapshots()).toEqual([])
  })
  it('并发的 fence 变更不会交错，且都按调用顺序落地', async () => {
    const boundary = new FakeBoundary()
    const { service } = setup({ boundary })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })

    const takeover = service.acquire({ sessionId: 'session-1', identity: GUI_B, takeover: true })
    const release = service.release(handle)
    const results = await Promise.allSettled([takeover, release])

    // takeover 先落地 → release(old) 必然失败（not-holder）；反过来也至少有一个失败
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(boundary.maxConcurrent).toBe(1)
  })

  it('assertInput 等待在途撤销落地后再判定', async () => {
    const boundary = new FakeBoundary()
    const { service } = setup({ boundary })
    const handle = await service.acquire({ sessionId: 'session-1', identity: GUI_A })

    const revoke = service.invalidateSession('session-1')
    const assert = service.assertInput(handle)
    await expect(revoke).resolves.toBeUndefined()
    expect((await rejection(assert)).reason).toBe('lease-revoked')
  })
})
