/**
 * 共享控制契约的纯函数测试：围栏判定是 main、连接器、宿主三处共用的唯一判据，
 * 这里把它钉死，避免三个进程对「同一租约」理解不同。
 */

import { describe, expect, it } from 'vitest'
import {
  CONTROL_LEASE_MAX_TTL_MS,
  InputControlError,
  asInputControlError,
  checkFenceInstall,
  checkInputFence,
  controlErrorForHostFailure,
  fenceOf,
  isControlHandle,
  isInputFence,
  nextFenceFloor,
  sameFence,
  sameLease,
  type ControlHandle,
  type FenceFloor,
  type InputFence
} from './terminal-control'

const NOW = 1_000_000

function fence(overrides: Partial<InputFence> = {}): InputFence {
  return {
    epoch: 1,
    connectionInstanceId: 'conn-1',
    controllerInstanceId: 'main-1',
    leaseId: 'lease-1',
    expiresAt: NOW + 1000,
    ...overrides
  }
}

describe('fenceOf / sameFence / sameLease', () => {
  it('fenceOf 只取五个字段，绝不夹带调用方身份', () => {
    const handle: ControlHandle = {
      ...fence(),
      sessionId: 's1',
      principalId: 'p1',
      credentialId: 'cred-1',
      source: 'gui',
      issuedAt: NOW
    }
    expect(fenceOf(handle)).toEqual(fence())
    expect(Object.keys(fenceOf(handle)).sort()).toEqual([
      'connectionInstanceId',
      'controllerInstanceId',
      'epoch',
      'expiresAt',
      'leaseId'
    ])
  })

  it('sameFence 看有效期，sameLease 不看', () => {
    const extended = fence({ expiresAt: NOW + 5000 })
    expect(sameFence(fence(), extended)).toBe(false)
    expect(sameLease(fence(), extended)).toBe(true)
    expect(sameLease(fence(), fence({ leaseId: 'lease-2' }))).toBe(false)
  })
})

describe('checkInputFence：写入前判定', () => {
  it('没有活动围栏就拒绝', () => {
    expect(checkInputFence(null, fence(), NOW)).toBe('no-fence')
  })

  it('形状非法与租约不匹配分别归类', () => {
    expect(checkInputFence(fence(), { epoch: 1 } as InputFence, NOW)).toBe('invalid-fence')
    expect(checkInputFence(fence(), fence({ leaseId: 'other' }), NOW)).toBe('lease-mismatch')
    expect(checkInputFence(fence(), fence({ epoch: 2 }), NOW)).toBe('lease-mismatch')
    expect(checkInputFence(fence(), fence({ connectionInstanceId: 'conn-2' }), NOW)).toBe('lease-mismatch')
    expect(checkInputFence(fence(), fence({ controllerInstanceId: 'main-2' }), NOW)).toBe('lease-mismatch')
  })

  it('到期时刻即失效', () => {
    expect(checkInputFence(fence(), fence(), NOW + 999)).toBeNull()
    expect(checkInputFence(fence(), fence(), NOW + 1000)).toBe('expired')
    expect(checkInputFence(fence(), fence(), NOW + 1001)).toBe('expired')
  })
})

describe('checkFenceInstall：安装判定', () => {
  it('形状非法直接拒绝', () => {
    expect(checkFenceInstall(null, null, null)).toBe('invalid-fence')
    expect(checkFenceInstall(null, null, { epoch: 1 } as InputFence)).toBe('invalid-fence')
  })

  it('同一实例内 epoch 必须严格递增', () => {
    expect(checkFenceInstall(fence(), null, fence({ epoch: 2 }))).toBeNull()
    expect(checkFenceInstall(fence({ epoch: 3 }), null, fence({ epoch: 2 }))).toBe('epoch-stale')
    expect(checkFenceInstall(fence(), null, fence({ leaseId: 'other' }))).toBe('epoch-stale')
  })

  it('同一租约续期只允许延长有效期', () => {
    const renewed = fence({ expiresAt: NOW + 5000 })
    expect(checkFenceInstall(fence(), null, renewed)).toBeNull()
    const shortened = fence({ expiresAt: NOW + 10 })
    expect(checkFenceInstall(fence(), null, shortened)).toBe('epoch-stale')
  })

  it('换了 main 实例可以接管，即使 epoch 更小', () => {
    expect(checkFenceInstall(fence({ epoch: 9 }), null, fence({ epoch: 1, controllerInstanceId: 'main-2' }))).toBeNull()
  })

  it('无活动围栏时从下限继续：只接受更大的 epoch，旧租约不能复活', () => {
    const floor: FenceFloor = { epoch: 4, controllerInstanceId: 'main-1', last: fence({ epoch: 4 }) }
    expect(checkFenceInstall(null, floor, fence({ epoch: 5 }))).toBeNull()
    expect(checkFenceInstall(null, floor, fence({ epoch: 4 }))).toBe('epoch-stale')
    expect(checkFenceInstall(null, floor, fence({ epoch: 4, expiresAt: NOW + 2000 }))).toBe('epoch-stale')
    expect(checkFenceInstall(null, floor, fence({ epoch: 3 }))).toBe('epoch-stale')
    expect(checkFenceInstall(null, { epoch: 4, controllerInstanceId: 'main-1', last: null }, fence({ epoch: 4 }))).toBe(
      'epoch-stale'
    )
  })
})

describe('nextFenceFloor：断开后同代际永久失效', () => {
  it('首次安装建立下限，撤销保留 last', () => {
    const first = fence({ epoch: 2 })
    const floor = nextFenceFloor(first, null)
    expect(floor).toEqual({ epoch: 2, controllerInstanceId: 'main-1', last: first })
    // 撤销：previous 为空，下限原样保留
    expect(nextFenceFloor(null, floor)).toEqual(floor)
    // 撤销后的旧租约无法原样重新安装。
    expect(checkFenceInstall(null, floor, first)).toBe('epoch-stale')
    expect(checkFenceInstall(null, floor, { ...first, expiresAt: first.expiresAt + 1 })).toBe('epoch-stale')
  })

  it('续期后的租约在断线后也不能原样重装', () => {
    const first = fence({ epoch: 2, expiresAt: NOW + 1000 })
    let floor = nextFenceFloor(first, null)
    const renewed = { ...first, expiresAt: NOW + 9000 }
    floor = nextFenceFloor(renewed, floor)
    expect(floor?.last?.expiresAt).toBe(NOW + 9000)
    expect(checkFenceInstall(null, floor, renewed)).toBe('epoch-stale')
  })

  it('换了 main 实例时下限随新实例重置', () => {
    const previous = fence({ controllerInstanceId: 'main-2', epoch: 1 })
    expect(nextFenceFloor(previous, { epoch: 9, controllerInstanceId: 'main-1', last: null })).toEqual({
      epoch: 1,
      controllerInstanceId: 'main-2',
      last: previous
    })
  })
})

describe('校验与错误映射', () => {
  it('isInputFence / isControlHandle 拒绝越界与多余类型', () => {
    expect(isInputFence(fence())).toBe(true)
    expect(isInputFence(fence({ epoch: -1 }))).toBe(false)
    expect(isInputFence(fence({ epoch: 1.5 }))).toBe(false)
    expect(isInputFence(fence({ leaseId: '' }))).toBe(false)
    expect(isInputFence('nope')).toBe(false)
    const handle: ControlHandle = {
      ...fence(),
      sessionId: 's1',
      principalId: 'p1',
      source: 'automation',
      issuedAt: NOW
    }
    expect(isControlHandle(handle)).toBe(true)
    expect(isControlHandle({ ...handle, source: 'root' })).toBe(false)
  })

  it('稳定 code 覆盖冲突/旧代际/过期', () => {
    expect(new InputControlError('held-by-other').code).toBe('CONTROL_CONFLICT')
    expect(new InputControlError('not-holder').code).toBe('STALE_GENERATION')
    expect(new InputControlError('lease-expired').code).toBe('STALE_GENERATION')
    expect(new InputControlError('connection-replaced').code).toBe('STALE_GENERATION')
    expect(new InputControlError('credential-revoked').code).toBe('UNAUTHENTICATED')
    expect(new InputControlError('version-incompatible').code).toBe('INCOMPATIBLE_VERSION')
    expect(new InputControlError('held-by-other').retryDisposition).toBe('never')
    expect(new InputControlError('fence-install-failed').retryDisposition).toBe('safe')
    expect(CONTROL_LEASE_MAX_TTL_MS).toBeGreaterThan(0)
  })

  it('asInputControlError 保留原错误类型，宿主失败映射成版本/宿主拒绝', () => {
    const original = new InputControlError('held-by-other')
    expect(asInputControlError(original)).toBe(original)
    expect(asInputControlError(new Error('boom')).reason).toBe('fence-install-failed')
    expect(controlErrorForHostFailure({ code: 'incompatible-version' }).reason).toBe('version-incompatible')
    expect(controlErrorForHostFailure({ code: 'fence-rejected' }).reason).toBe('host-rejected')
    expect(controlErrorForHostFailure(new Error('pipe closed')).reason).toBe('host-rejected')
  })
})
