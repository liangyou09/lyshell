import { describe, expect, it } from 'vitest'
import {
  ShelfResourceLifecycle,
  type BlockReason,
  type DemandSource,
  type LifecycleCode,
  type NativeAttachEvidence,
  type ResourceToken,
  type RestoreMetadata,
  type Result,
  type ShelfResourceLifecycleOptions
} from './shelf-resource-lifecycle'

const R = { scopeId: 'scope-1', resourceId: 'res-1', ownerId: 'owner-main' }

/** Result 失败分支的 code；成功时返回 'ok'，让断言保持一行可读。 */
function failureCode(result: Result): LifecycleCode | 'ok' {
  return result.ok ? 'ok' : result.code
}

interface Harness {
  lc: ShelfResourceLifecycle
  advance(ms: number): void
  at(): number
}

function harness(options: Partial<ShelfResourceLifecycleOptions> = {}): Harness {
  let now = 1_700_000_000_000
  let seq = 0
  const lc = new ShelfResourceLifecycle({
    now: () => now,
    createId: () => `id-${++seq}`,
    allowlistedProviderIds: ['provider.a'],
    safeCloseSupported: true,
    // 模拟 main 侧依据原生 did-attach 事件核验；trusted 标记由真实事件适配层给出。
    verifyNativeAttach: (raw) => {
      const candidate = raw as (NativeAttachEvidence & { trusted?: boolean }) | null
      if (!candidate || candidate.trusted !== true) return null
      const { trusted: _trusted, ...evidence } = candidate
      void _trusted
      return evidence
    },
    ...options
  })
  return {
    lc,
    advance: (ms) => {
      now += ms
    },
    at: () => now
  }
}

function evidence(
  permitId: string,
  guestId: string,
  token: ResourceToken,
  ownerId = R.ownerId,
  trusted = true
): Record<string, unknown> {
  return {
    trusted,
    kind: 'native-did-attach',
    permitId,
    guestId,
    scopeId: token.scopeId,
    resourceId: token.resourceId,
    ownerId,
    instanceGeneration: token.instanceGeneration,
    navigationGeneration: token.navigationGeneration
  }
}

function tokenOf(h: Harness): ResourceToken {
  const inspected = h.lc.inspect(R)
  if (!inspected.ok) throw new Error(inspected.code)
  return inspected.view.token
}

function codesOf(h: Harness, restore: RestoreMetadata, policyAllowed = true): LifecycleCode[] {
  const evaluated = h.lc.evaluateSuspend({ ...R, policyAllowed, restore })
  if (!evaluated.ok) throw new Error(evaluated.code)
  return evaluated.codes
}

function bringLive(h: Harness, source: DemandSource = 'explicitMain', guestId = 'guest-1'): ResourceToken {
  expect(h.lc.setDemand({ ...R, source, requestId: 'req-1' }).ok).toBe(true)
  const created = h.lc.createPermit(R)
  if (!created.ok) throw new Error(`createPermit: ${created.code}`)
  expect(h.lc.beginAttach(created.permit.permitId).ok).toBe(true)
  const attached = h.lc.recordAttached(evidence(created.permit.permitId, guestId, created.permit.token))
  if (!attached.ok) throw new Error(`recordAttached: ${attached.code}`)
  const token = tokenOf(h)
  expect(h.lc.recordGeometry(token, { geometryRevision: 1, width: 800, height: 600, dpr: 2 }).ok).toBe(true)
  expect(h.lc.recordReady(token).ok).toBe(true)
  return tokenOf(h)
}

function restoreMeta(h: Harness): RestoreMetadata {
  return {
    taskId: 'task-1',
    resourceId: R.resourceId,
    method: 'GET',
    url: 'https://example.com/a?b=1',
    partition: 'persist:shelf',
    zoom: 1,
    scrollY: 120,
    formatVersion: 1,
    recordedAt: h.at()
  }
}

/** 进入「一切正面条件满足」的深睡候选：清空需求 + 闲置 5 分钟 + 新鲜 safe 保护。 */
function deepSleepReady(h: Harness, providerId = 'provider.a'): RestoreMetadata {
  expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
  h.advance(300_000)
  const token = tokenOf(h)
  expect(
    h.lc.reportProtection({
      ...R,
      decision: 'safe',
      providerId,
      revision: 1,
      instanceGeneration: token.instanceGeneration,
      navigationGeneration: token.navigationGeneration
    }).ok
  ).toBe(true)
  return restoreMeta(h)
}

describe('permit 与原生附着', () => {
  it('同资源双创建被拒：pending 许可与已附着实例都不发替代许可', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-1' }).ok).toBe(true)
    const first = h.lc.createPermit(R)
    expect(first.ok).toBe(true)
    expect(h.lc.createPermit(R)).toEqual({ ok: false, code: 'permit-held', detail: 'permit=pending' })

    if (!first.ok) throw new Error('unreachable')
    expect(h.lc.beginAttach(first.permit.permitId).ok).toBe(true)
    expect(h.lc.recordAttached(evidence(first.permit.permitId, 'guest-1', first.permit.token)).ok).toBe(true)
    expect(h.lc.createPermit(R)).toEqual({ ok: false, code: 'instance-present' })
  })

  it('beginAttach 只能消费一次，且没有需求时不允许创建', () => {
    const h = harness()
    expect(h.lc.createPermit(R)).toEqual({ ok: false, code: 'not-found' })
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-1' }).ok).toBe(true)
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    expect(h.lc.createPermit(R)).toEqual({ ok: false, code: 'demand-required', detail: '没有有效展示需求，不创建 guest' })
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-2' }).ok).toBe(true)
    const created = h.lc.createPermit(R)
    if (!created.ok) throw new Error('unreachable')
    expect(h.lc.beginAttach(created.permit.permitId).ok).toBe(true)
    expect(h.lc.beginAttach(created.permit.permitId)).toEqual({
      ok: false,
      code: 'permit-consumed',
      detail: 'permit=attaching'
    })
  })

  it('拒绝 renderer 裸 id 冒充 did-attach 证据，也拒绝 owner/generation 不符的证据', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-1' }).ok).toBe(true)
    const created = h.lc.createPermit(R)
    if (!created.ok) throw new Error('unreachable')
    expect(h.lc.beginAttach(created.permit.permitId).ok).toBe(true)

    expect(h.lc.recordAttached('guest-from-renderer')).toEqual({
      ok: false,
      code: 'attach-untrusted',
      detail: '只接受调用方核验过的原生 did-attach 证据'
    })
    expect(h.lc.recordAttached(evidence(created.permit.permitId, 'g', created.permit.token, R.ownerId, false)).ok).toBe(false)
    expect(failureCode(h.lc.recordAttached(evidence(created.permit.permitId, 'g', created.permit.token, 'owner-other')))).toBe(
      'owner-mismatch'
    )
    expect(failureCode(h.lc.recordAttached({
        ...evidence(created.permit.permitId, 'g', created.permit.token),
        instanceGeneration: created.permit.token.instanceGeneration + 1
      }))).toBe('stale-generation')
    expect(h.lc.recordAttached(evidence(created.permit.permitId, 'guest-1', created.permit.token)).ok).toBe(true)
  })

  it('创建超时只标 unknown/blocked，不提前发第二个许可', () => {
    const h = harness({ permitTimeoutMs: 1_000 })
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-1' }).ok).toBe(true)
    const created = h.lc.createPermit(R)
    if (!created.ok) throw new Error('unreachable')
    h.advance(2_000)
    expect(failureCode(h.lc.beginAttach(created.permit.permitId))).toBe('permit-expired')
    expect(h.lc.createPermit(R)).toEqual({ ok: false, code: 'permit-held', detail: 'permit=unknown' })
    // 未确认旧创建终止前不得释放槽位
    expect(h.lc.abandonPermit(created.permit.permitId, { terminationConfirmed: false, reason: 'create-timeout' }).ok).toBe(
      false
    )
    expect(h.lc.createPermit(R).ok).toBe(false)
    expect(h.lc.abandonPermit(created.permit.permitId, { terminationConfirmed: true, reason: 'host-exit' }).ok).toBe(true)
    expect(h.lc.createPermit(R).ok).toBe(true)
  })

  it('旧 owner 与旧 token 的事件被拒绝', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-1' }).ok).toBe(true)
    const created = h.lc.createPermit(R)
    if (!created.ok) throw new Error('unreachable')
    const staleToken = created.permit.token
    expect(h.lc.beginAttach(created.permit.permitId).ok).toBe(true)
    expect(h.lc.recordAttached(evidence(created.permit.permitId, 'guest-1', staleToken)).ok).toBe(true)
    expect(h.lc.inspect({ ...R, ownerId: 'owner-other' })).toEqual({ ok: false, code: 'owner-mismatch' })
    expect(failureCode(h.lc.setDemand({ ...R, ownerId: 'owner-other', source: 'explicitMain', requestId: 'r' }))).toBe(
      'owner-mismatch'
    )
    // 需求版本推进后旧 token 一律失效
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-2' }).ok).toBe(true)
    expect(h.lc.recordGeometry(staleToken, { geometryRevision: 5, width: 1, height: 1, dpr: 1 })).toEqual({
      ok: false,
      code: 'stale-token'
    })
    expect(failureCode(h.lc.recordReady(staleToken))).toBe('stale-token')
    expect(failureCode(h.lc.recordNavigation(staleToken, 'https://example.com/b'))).toBe('stale-token')
  })
})

describe('展示归属与版本化事件', () => {
  it('长导航仍换代并撤销旧呈现，诊断不保存 URL 查询内容', () => {
    const h = harness()
    const token = bringLive(h)
    expect(h.lc.recordPresentationReady(token, 'main').ok).toBe(true)
    const url = `https://example.com/?secret=${'x'.repeat(1500)}`
    expect(h.lc.recordNavigation(token, url)).toMatchObject({ ok: true, navigationGeneration: token.navigationGeneration + 1 })
    expect(h.lc.inspect(R)).toMatchObject({ ok: true, view: { presentationReady: false, restoreStatus: 'loading', lastUrl: url } })
    expect(JSON.stringify(h.lc.diagnostics())).not.toContain('secret=')
    expect(h.lc.recordReady(token)).toMatchObject({ ok: false, code: 'stale-token' })
  })
  it('主区优先于侧栏，取消侧栏不撤销 main 需求', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'explicitShelf', requestId: 'shelf-1' }).ok).toBe(true)
    const shelfView = h.lc.inspect(R)
    if (!shelfView.ok) throw new Error('unreachable')
    expect(shelfView.view.presentationOwner).toBe('shelf')

    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'main-1' }).ok).toBe(true)
    expect(h.lc.clearDemand({ ...R, source: 'explicitShelf' }).ok).toBe(true)
    const mainView = h.lc.inspect(R)
    if (!mainView.ok) throw new Error('unreachable')
    expect(mainView.view.presentationOwner).toBe('main')
    expect(mainView.view.hasMainDemand).toBe(true)
    expect(mainView.view.hasShelfDemand).toBe(false)

    // 主需求仍在：深睡候选必须给出 demand-present
    h.advance(300_000)
    const restore = restoreMeta(h)
    const token = mainView.view.token
    expect(
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 1,
        instanceGeneration: token.instanceGeneration,
        navigationGeneration: token.navigationGeneration
      }).ok
    ).toBe(true)
    const evaluated = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore })
    if (!evaluated.ok) throw new Error('unreachable')
    expect(evaluated.eligible).toBe(false)
    expect(evaluated.codes).toContain('demand-present')
  })

  it('旧 bulkVisible 清理不能误删当前 explicitShelf 需求，需求按实际 source 核对', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'explicitShelf', requestId: 'shelf-1' }).ok).toBe(true)
    // 旧视图的 bulkVisible 清理到达时，当前是 explicitShelf：不得删除
    expect(h.lc.clearDemand({ ...R, source: 'bulkVisible' })).toEqual({ ok: true, changed: false })
    let view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.hasShelfDemand).toBe(true)
    expect(view.view.presentationOwner).toBe('shelf')

    // 反向同样按 source 核对：explicitShelf 清理不能冒充 bulkVisible 需求
    expect(h.lc.setDemand({ ...R, source: 'bulkVisible', requestId: 'bulk-1' }).ok).toBe(true)
    expect(h.lc.clearDemand({ ...R, source: 'explicitShelf' })).toEqual({ ok: true, changed: false })
    view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.hasShelfDemand).toBe(true)

    // 主需求也不受侧栏清理影响
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'main-1' }).ok).toBe(true)
    expect(h.lc.clearDemand({ ...R, source: 'bulkVisible' }).ok).toBe(true)
    view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.hasMainDemand).toBe(true)
    expect(view.view.presentationOwner).toBe('main')

    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' })).toEqual({ ok: true, changed: true })
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' })).toEqual({ ok: true, changed: false })
  })

  it('归属 main/shelf/none 收敛，restoreStatus 与 presentationReady 独立', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-0' }).ok).toBe(true)
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    const empty = h.lc.inspect(R)
    if (!empty.ok) throw new Error('unreachable')
    expect(empty.view.presentationOwner).toBe('none')
    expect(empty.view.restoreStatus).toBe('idle')

    const token = bringLive(h, 'explicitMain')
    expect(h.lc.recordPresentationReady(token, 'main').ok).toBe(true)
    const view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.presentationReady).toBe(true)
    expect(view.view.restoreStatus).toBe('ready')
    expect(failureCode(h.lc.recordPresentationReady(token, 'shelf'))).toBe('owner-mismatch')

    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    const idle = h.lc.inspect(R)
    if (!idle.ok) throw new Error('unreachable')
    expect(idle.view.presentationOwner).toBe('none')
    expect(idle.view.presentationReady).toBe(false)
    expect(idle.view.state).toBe('live')
  })

  it('迟到 geometry/ready/导航事件按版本拒绝，30 秒只做诊断标签', () => {
    const h = harness()
    const token = bringLive(h)
    expect(failureCode(h.lc.recordGeometry(token, { geometryRevision: 1, width: 800, height: 600, dpr: 2 }))).toBe('stale-geometry')
    const geometry = h.lc.recordGeometry(token, { geometryRevision: 2, width: 800, height: 600, dpr: 2 })
    expect(geometry.ok).toBe(true)

    const navigated = h.lc.recordNavigation(token, 'https://example.com/next')
    if (!navigated.ok) throw new Error('unreachable')
    expect(navigated.token.navigationGeneration).toBe(token.navigationGeneration + 1)
    expect(failureCode(h.lc.recordGeometry(token, { geometryRevision: 3, width: 1, height: 1, dpr: 1 }))).toBe('stale-token')
    expect(failureCode(h.lc.recordReady(token))).toBe('stale-token')

    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    h.advance(30_000)
    const labeled = h.lc.inspect(R)
    if (!labeled.ok) throw new Error('unreachable')
    expect(labeled.view.idleLabel).toBe(true)
    expect(labeled.view.state).toBe('live')
    expect(labeled.view.guestId).toBe('guest-1')
  })

  it('小型字符串与资源上限是有界的', () => {
    const h = harness()
    expect(failureCode(h.lc.setDemand({ scopeId: 's'.repeat(513), resourceId: 'r', ownerId: 'o', source: 'explicitMain', requestId: 'q' }))).toBe(
      'invalid'
    )
    expect(failureCode(h.lc.setDemand({ scopeId: 'a\u0001b', resourceId: 'r', ownerId: 'o', source: 'explicitMain', requestId: 'q' }))).toBe(
      'invalid'
    )
    for (let index = 0; index < 100; index += 1) {
      expect(h.lc.setDemand({ ...R, resourceId: `res-${index}`, source: 'bulkVisible', requestId: 'q' }).ok).toBe(true)
    }
    expect(h.lc.stats().resources).toBe(100)
    expect(failureCode(h.lc.setDemand({ ...R, resourceId: 'res-overflow', source: 'bulkVisible', requestId: 'q' }))).toBe(
      'limit-reached'
    )
    expect(h.lc.diagnostics().length).toBeLessThanOrEqual(100)
  })
})

describe('深睡保护与关闭事务', () => {
  it('默认拒绝自动深睡：safeCloseSupported=false 时保活并发不出关闭', () => {
    const h = harness({ safeCloseSupported: false })
    bringLive(h)
    const restore = deepSleepReady(h)
    const evaluated = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore })
    if (!evaluated.ok) throw new Error('unreachable')
    expect(evaluated.eligible).toBe(false)
    expect(evaluated.codes).toContain('unsupported-close')
    expect(h.lc.beginSuspend({ ...R, policyAllowed: true, restore }).ok).toBe(false)
    const view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.state).toBe('live')
    expect(view.view.guestId).toBe('guest-1')
    expect(view.view.restoreStatus).toBe('ready')
  })

  it('保护 unknown/blocked、allowlist 外、代际不符、TTL 过期都正面拒绝', () => {
    const cases: Array<{ name: string; prep: (h: Harness) => void; code: string }> = [
      { name: 'unknown', prep: () => undefined, code: 'protection-unknown' },
      {
        name: 'blocked',
        prep: (h) => {
          const token = tokenOf(h)
          h.lc.reportProtection({
            ...R,
            decision: 'blocked',
            providerId: 'provider.a',
            revision: 1,
            instanceGeneration: token.instanceGeneration,
            navigationGeneration: token.navigationGeneration,
            reasonCodes: ['editing', 'upload']
          })
        },
        code: 'protection-blocked'
      },
      {
        name: 'untrusted provider',
        prep: (h) => {
          const token = tokenOf(h)
          h.lc.reportProtection({
            ...R,
            decision: 'safe',
            providerId: 'provider.evil',
            revision: 9,
            instanceGeneration: token.instanceGeneration,
            navigationGeneration: token.navigationGeneration
          })
        },
        code: 'protection-untrusted'
      }
    ]
    for (const testCase of cases) {
      const h = harness()
      bringLive(h)
      expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
      h.advance(300_000)
      testCase.prep(h)
      const evaluated = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore: restoreMeta(h) })
      if (!evaluated.ok) throw new Error('unreachable')
      expect(evaluated.codes, testCase.name).toContain(testCase.code)
      expect(evaluated.eligible, testCase.name).toBe(false)
      expect(h.lc.inspect(R).ok).toBe(true)
    }

    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    h.advance(2_001)
    const expired = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore })
    if (!expired.ok) throw new Error('unreachable')
    expect(expired.codes).toContain('protection-expired')
  })

  it('闲置不足、策略关闭、非 GET 恢复元数据都拒绝深睡', () => {
    const h = harness()
    bringLive(h)
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    const token = tokenOf(h)
    expect(
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 1,
        instanceGeneration: token.instanceGeneration,
        navigationGeneration: token.navigationGeneration
      }).ok
    ).toBe(true)
    const restore = restoreMeta(h)
    const shortIdle = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore })
    if (!shortIdle.ok) throw new Error('unreachable')
    expect(shortIdle.codes).toContain('idle-short')

    h.advance(300_000)
    const denied = h.lc.evaluateSuspend({ ...R, policyAllowed: false, restore })
    if (!denied.ok) throw new Error('unreachable')
    expect(denied.codes).toContain('policy-disabled')
    const post = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore: { ...restore, method: 'POST' as 'GET' } })
    if (!post.ok) throw new Error('unreachable')
    expect(post.codes).toContain('restore-unsafe')
  })

  it('保护报告必须是当前代际且 revision 严格递增，旧报告不刷新 TTL、不覆盖新结论', () => {
    const h = harness({ deepSleepAfterMs: 1_000 })
    bringLive(h)
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    h.advance(1_500)
    const token = tokenOf(h)
    const current = {
      instanceGeneration: token.instanceGeneration,
      navigationGeneration: token.navigationGeneration
    }
    const report = (overrides: Record<string, unknown> = {}) =>
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 5,
        ...current,
        ...overrides
      } as Parameters<ShelfResourceLifecycle['reportProtection']>[0])

    // 代际不符（instance 或 navigation）直接拒绝
    expect(report({ instanceGeneration: current.instanceGeneration - 1 })).toMatchObject({
      ok: false,
      code: 'protection-stale'
    })
    expect(report({ navigationGeneration: current.navigationGeneration + 1 })).toMatchObject({
      ok: false,
      code: 'protection-stale'
    })
    // 未被拒绝的写入污染保护结论
    const untouched = h.lc.inspect(R)
    if (!untouched.ok) throw new Error('unreachable')
    expect(untouched.view.protection).toBeNull()

    expect(report().ok).toBe(true)
    // 同版本重复上报与更旧版本都不能覆盖已写入的结论
    expect(report({ decision: 'blocked', revision: 5 })).toMatchObject({ ok: false, code: 'protection-stale' })
    expect(report({ decision: 'blocked', revision: 4 })).toMatchObject({ ok: false, code: 'protection-stale' })
    const kept = h.lc.inspect(R)
    if (!kept.ok) throw new Error('unreachable')
    expect(kept.view.protection?.decision).toBe('safe')
    expect(kept.view.protection?.revision).toBe(5)

    // 旧报告被拒后不得刷新 checkedAt：TTL 仍从 revision=5 的写入时刻起算
    h.advance(600)
    expect(report({ instanceGeneration: current.instanceGeneration - 1, revision: 6 })).toMatchObject({
      ok: false,
      code: 'protection-stale'
    })
    h.advance(1_500)
    const codes = codesOf(h, restoreMeta(h))
    expect(codes).toContain('protection-expired')
    expect(codes).not.toContain('protection-stale')
  })

  it('未知保护原因与 prototype 键一律拒绝，不写入保护结论', () => {
    const h = harness()
    const token = bringLive(h)
    const base = {
      ...R,
      providerId: 'provider.a',
      revision: 1,
      instanceGeneration: token.instanceGeneration,
      navigationGeneration: token.navigationGeneration
    }
    for (const reason of ['edit', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const result = h.lc.reportProtection({ ...base, decision: 'blocked', reasonCodes: [reason as BlockReason] })
      expect(result, reason).toMatchObject({ ok: false, code: 'invalid' })
    }
    expect(failureCode(h.lc.reportProtection({ ...base, decision: 'blocked', reasonCodes: new Array(17).fill('editing') }))).toBe(
      'invalid'
    )
    const untouched = h.lc.inspect(R)
    if (!untouched.ok) throw new Error('unreachable')
    expect(untouched.view.protection).toBeNull()

    expect(h.lc.reportProtection({ ...base, decision: 'blocked', reasonCodes: ['editing'] }).ok).toBe(true)
    const recorded = h.lc.inspect(R)
    if (!recorded.ok) throw new Error('unreachable')
    expect(recorded.view.protection?.decision).toBe('blocked')
    // safe 与 blocked 原因矛盾时按 blocked 处理，宁可保活
    expect(h.lc.reportProtection({ ...base, decision: 'safe', revision: 2, reasonCodes: ['upload'] })).toEqual({
      ok: true,
      decision: 'blocked'
    })
  })

  it('实例换代后旧保护结论按 protection-stale 拒绝深睡', () => {
    const h = harness({ deepSleepAfterMs: 1_000 })
    bringLive(h)
    const first = tokenOf(h)
    expect(
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 1,
        instanceGeneration: first.instanceGeneration,
        navigationGeneration: first.navigationGeneration
      }).ok
    ).toBe(true)
    // 导航换代：保护结论仍停在旧 navigationGeneration
    const navigated = h.lc.recordNavigation(first, 'https://example.com/next')
    if (!navigated.ok) throw new Error(navigated.code)
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    h.advance(1_500)
    const evaluated = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore: restoreMeta(h) })
    if (!evaluated.ok) throw new Error('unreachable')
    expect(evaluated.codes).toContain('protection-stale')
    expect(evaluated.eligible).toBe(false)
  })

  it('恢复 URL 上限为仓库统一的 4096，凭据与非 GET 仍拒绝', () => {
    const h = harness({ deepSleepAfterMs: 1_000 })
    bringLive(h)
    expect(h.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    h.advance(1_500)
    const token = tokenOf(h)
    expect(
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 1,
        instanceGeneration: token.instanceGeneration,
        navigationGeneration: token.navigationGeneration
      }).ok
    ).toBe(true)
    const base = restoreMeta(h)
    const urlAt = (url: string): RestoreMetadata => ({ ...base, url })
    const prefix = 'https://example.com/'
    const atLimit = prefix + 'a'.repeat(4096 - prefix.length)
    expect(atLimit).toHaveLength(4096)

    // 恰好 4096 且合法：不能再被旧的 512 上限挡住
    expect(codesOf(h, urlAt(atLimit))).not.toContain('restore-unsafe')
    expect(codesOf(h, urlAt(prefix + 'a'.repeat(600)))).not.toContain('restore-unsafe')
    expect(codesOf(h, urlAt('http://example.com/ok'))).not.toContain('restore-unsafe')

    expect(codesOf(h, urlAt(`${atLimit}a`))).toContain('restore-unsafe')
    expect(codesOf(h, urlAt('https://user:pass@example.com/x'))).toContain('restore-unsafe')
    expect(codesOf(h, urlAt('https://example.com/\u0001'))).toContain('restore-unsafe')
    expect(codesOf(h, { ...base, method: 'POST' as 'GET' })).toContain('restore-unsafe')
    expect(codesOf(h, urlAt('file:///etc/passwd'))).toContain('restore-unsafe')
    const eligible = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore: urlAt(atLimit) })
    if (!eligible.ok) throw new Error('unreachable')
    expect(eligible.eligible).toBe(true)
  })

  it('保存期间新需求撤销休眠并回到 live', () => {
    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    const begun = h.lc.beginSuspend({ ...R, policyAllowed: true, restore })
    if (!begun.ok) throw new Error(begun.code)
    expect(h.lc.setDemand({ ...R, source: 'explicitShelf', requestId: 'shelf-2' }).ok).toBe(true)

    const view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.state).toBe('live')
    expect(view.view.suspend).toBeNull()
    expect(failureCode(h.lc.commitSuspendSaved(begun.operation.operationId))).toBe('stale-operation')
    expect(h.lc.inspect(R).ok).toBe(true)
    const kept = h.lc.inspect(R)
    if (!kept.ok) throw new Error('unreachable')
    expect(kept.view.guestId).toBe('guest-1')
  })

  it('保存后复检失败（保护版本变化）不关闭，回到 live', () => {
    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    const begun = h.lc.beginSuspend({ ...R, policyAllowed: true, restore })
    if (!begun.ok) throw new Error(begun.code)
    const token = tokenOf(h)
    expect(
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 2,
        instanceGeneration: token.instanceGeneration,
        navigationGeneration: token.navigationGeneration
      }).ok
    ).toBe(true)
    expect(failureCode(h.lc.commitSuspendSaved(begun.operation.operationId))).toBe('protection-stale')
    const view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.state).toBe('live')
    expect(view.view.guestId).toBe('guest-1')
  })

  it('关闭被拒绝回 live，同保护版本不再循环提示，保护版本变化后才可重试', () => {
    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    const begun = h.lc.beginSuspend({ ...R, policyAllowed: true, restore })
    if (!begun.ok) throw new Error(begun.code)
    const saved = h.lc.commitSuspendSaved(begun.operation.operationId)
    if (!saved.ok) throw new Error(saved.code)
    expect(saved.close.guestId).toBe('guest-1')
    expect(h.lc.failClose(begun.operation.operationId, 'close-refused').ok).toBe(true)

    const afterRefusal = h.lc.inspect(R)
    if (!afterRefusal.ok) throw new Error('unreachable')
    expect(afterRefusal.view.state).toBe('live')
    expect(afterRefusal.view.guestId).toBe('guest-1')
    const retry = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore })
    if (!retry.ok) throw new Error('unreachable')
    expect(retry.codes).toContain('cooldown')

    const token = tokenOf(h)
    expect(
      h.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 2,
        instanceGeneration: token.instanceGeneration,
        navigationGeneration: token.navigationGeneration
      }).ok
    ).toBe(true)
    const cleared = h.lc.evaluateSuspend({ ...R, policyAllowed: true, restore })
    if (!cleared.ok) throw new Error('unreachable')
    expect(cleared.codes).not.toContain('cooldown')
    expect(cleared.eligible).toBe(true)
  })

  it('关闭超时既不变 sleeping 也不发替代许可，迟到 destroyed 才提交', () => {
    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    const begun = h.lc.beginSuspend({ ...R, policyAllowed: true, restore })
    if (!begun.ok) throw new Error(begun.code)
    if (!h.lc.commitSuspendSaved(begun.operation.operationId).ok) throw new Error('unreachable')
    h.advance(5_000)

    const timedOut = h.lc.failClose(begun.operation.operationId, 'close-timeout')
    if (!timedOut.ok) throw new Error(timedOut.code)
    expect(timedOut.holdHandle).toBe(true)
    const view = h.lc.inspect(R)
    if (!view.ok) throw new Error('unreachable')
    expect(view.view.state).toBe('suspending')
    expect(view.view.guestId).toBe('guest-1')
    expect(view.view.suspend?.closeTimedOut).toBe(true)
    // 关闭已发出时出现新需求，也只能等原生证据，不能发替代许可
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'main-timeout' }).ok).toBe(true)
    expect(h.lc.createPermit(R)).toEqual({ ok: false, code: 'permit-held', detail: 'permit=closing' })
    expect(h.lc.abortSuspend(begun.operation.operationId, 'cancelled').ok).toBe(false)

    const confirmed = h.lc.confirmSuspendDestroyed(begun.operation.operationId, {
      resourceId: R.resourceId,
      instanceGeneration: view.view.token.instanceGeneration,
      guestId: 'guest-1'
    })
    if (!confirmed.ok) throw new Error(confirmed.code)
    expect(confirmed.demandPending).toBe(true)
    const sleeping = h.lc.inspect(R)
    if (!sleeping.ok) throw new Error('unreachable')
    expect(sleeping.view.state).toBe('sleeping')
    expect(sleeping.view.guestId).toBeNull()
    expect(sleeping.view.restoreStatus).toBe('queued')
    expect(h.lc.stats().instances).toBe(0)
    // destroyed 已确认，新需求可以走下一轮许可
    expect(h.lc.createPermit(R).ok).toBe(true)
  })

  it('关闭已发出时新需求不假定取消成功；guest 拒绝则复用原实例', () => {
    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    const begun = h.lc.beginSuspend({ ...R, policyAllowed: true, restore })
    if (!begun.ok) throw new Error(begun.code)
    if (!h.lc.commitSuspendSaved(begun.operation.operationId).ok) throw new Error('unreachable')

    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'main-2' }).ok).toBe(true)
    const pending = h.lc.inspect(R)
    if (!pending.ok) throw new Error('unreachable')
    expect(pending.view.state).toBe('suspending')
    expect(pending.view.suspend?.pendingDemand).toBe(true)
    expect(failureCode(h.lc.createPermit(R))).toBe('permit-held')

    expect(h.lc.failClose(begun.operation.operationId, 'close-refused').ok).toBe(true)
    const reused = h.lc.inspect(R)
    if (!reused.ok) throw new Error('unreachable')
    expect(reused.view.state).toBe('live')
    expect(reused.view.guestId).toBe('guest-1')
    expect(failureCode(h.lc.createPermit(R))).toBe('instance-present')
  })

  it('destroyed 后才允许新代实例，且拒绝陈旧 generation 的 destroyed 证据', () => {
    const h = harness()
    bringLive(h)
    const before = h.lc.inspect(R)
    if (!before.ok) throw new Error('unreachable')
    const generation = before.view.token.instanceGeneration
    expect(h.lc.recordDestroyed({ ...R, resourceId: R.resourceId, instanceGeneration: generation - 1 })).toEqual({
      ok: false,
      code: 'stale-generation',
      detail: `evidence=${generation - 1} current=${generation}`
    })
    expect(failureCode(h.lc.createPermit(R))).toBe('instance-present')

    const destroyed = h.lc.recordDestroyed({ ...R, resourceId: R.resourceId, instanceGeneration: generation, guestId: 'guest-1' })
    if (!destroyed.ok) throw new Error(destroyed.code)
    expect(destroyed.state).toBe('metadataOnly')
    const recreated = h.lc.createPermit(R)
    if (!recreated.ok) throw new Error(recreated.code)
    expect(recreated.permit.token.instanceGeneration).toBe(generation + 1)
  })
})

describe('用户关闭与稳定性', () => {
  it('用户关闭与自动休眠分离，迟到结果不能复活资源', () => {
    const h = harness()
    bringLive(h)
    const restore = deepSleepReady(h)
    const begun = h.lc.beginSuspend({ ...R, policyAllowed: true, restore })
    if (!begun.ok) throw new Error(begun.code)

    expect(h.lc.closeResource({ ...R, reason: 'user' })).toEqual({ ok: true, alreadyClosed: false })
    const closed = h.lc.inspect(R)
    if (!closed.ok) throw new Error('unreachable')
    expect(closed.view.state).toBe('closed')
    expect(closed.view.presentationOwner).toBe('none')
    expect(failureCode(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'late' }))).toBe('already-closed')
    expect(failureCode(h.lc.createPermit(R))).toBe('already-closed')
    expect(failureCode(h.lc.confirmSuspendDestroyed(begun.operation.operationId, {
      resourceId: R.resourceId,
      instanceGeneration: closed.view.token.instanceGeneration
    }))).toBe('stale-operation')
    // 旧 guest 句柄未销毁前不允许恢复
    expect(h.lc.reopenResource(R)).toEqual({ ok: false, code: 'instance-present', detail: '旧实例销毁证据未到，拒绝恢复' })
    expect(h.lc.recordDestroyed({ ...R, resourceId: R.resourceId, instanceGeneration: closed.view.token.instanceGeneration }).ok).toBe(
      true
    )
    expect(h.lc.reopenResource(R).ok).toBe(true)
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'after-reopen' }).ok).toBe(true)
    expect(h.lc.createPermit(R).ok).toBe(true)
  })

  it('至少 100 轮 create/attach/destroy 后资源计数回稳', () => {
    const h = harness()
    expect(h.lc.setDemand({ ...R, source: 'bulkVisible', requestId: 'bulk-1' }).ok).toBe(true)
    for (let round = 1; round <= 100; round += 1) {
      const created = h.lc.createPermit(R)
      if (!created.ok) throw new Error(`round ${round}: ${created.code}`)
      expect(created.permit.token.instanceGeneration).toBe(round)
      expect(h.lc.beginAttach(created.permit.permitId).ok).toBe(true)
      const attached = h.lc.recordAttached(evidence(created.permit.permitId, `guest-${round}`, created.permit.token))
      if (!attached.ok) throw new Error(`round ${round}: ${attached.code}`)
      expect(h.lc.recordGeometry(tokenOf(h), { geometryRevision: round, width: 640, height: 480, dpr: 1 }).ok).toBe(true)
      expect(h.lc.recordReady(tokenOf(h)).ok).toBe(true)
      const destroyed = h.lc.recordDestroyed({
        ...R,
        resourceId: R.resourceId,
        instanceGeneration: round,
        guestId: `guest-${round}`
      })
      if (!destroyed.ok) throw new Error(`round ${round}: ${destroyed.code}`)
      const stats = h.lc.stats()
      expect(stats.resources).toBe(1)
      expect(stats.instances).toBe(0)
      expect(stats.permits).toBe(0)
      expect(stats.metadataOnly).toBe(1)
      expect(stats.demands).toBe(1)
    }
    expect(h.lc.inspect(R).ok).toBe(true)
    expect(h.lc.diagnostics().length).toBeLessThanOrEqual(100)
  })
})

describe('构造参数与记录预算', () => {
  it('个数型参数非法时回退默认，NaN/负值/无限/小数都不能让 100 记录预算失效', () => {
    for (const maxResources of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      0.5,
      2.5
    ]) {
      const h = harness({ maxResources })
      for (let index = 0; index < 100; index += 1) {
        expect(h.lc.setDemand({ ...R, resourceId: `res-${index}`, source: 'bulkVisible', requestId: 'q' }).ok).toBe(true)
      }
      expect(h.lc.stats().resources).toBe(100)
      expect(failureCode(h.lc.setDemand({ ...R, resourceId: 'res-overflow', source: 'bulkVisible', requestId: 'q' }))).toBe(
        'limit-reached'
      )
    }

    const two = harness({ maxResources: 2 })
    expect(two.lc.setDemand({ ...R, resourceId: 'a', source: 'bulkVisible', requestId: 'q' }).ok).toBe(true)
    expect(two.lc.setDemand({ ...R, resourceId: 'b', source: 'bulkVisible', requestId: 'q' }).ok).toBe(true)
    expect(failureCode(two.lc.setDemand({ ...R, resourceId: 'c', source: 'bulkVisible', requestId: 'q' }))).toBe('limit-reached')
  })

  it('时长型参数非法时回退默认，许可超时与保护 TTL 仍然生效', () => {
    const permit = harness({ permitTimeoutMs: Number.NaN })
    expect(permit.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-1' }).ok).toBe(true)
    const created = permit.lc.createPermit(R)
    if (!created.ok) throw new Error(created.code)
    permit.advance(30_001)
    expect(failureCode(permit.lc.beginAttach(created.permit.permitId))).toBe('permit-expired')

    const idle = harness({ deepSleepAfterMs: Number.NaN, idleLabelMs: Number.NEGATIVE_INFINITY })
    bringLive(idle)
    expect(idle.lc.clearDemand({ ...R, source: 'explicitMain' }).ok).toBe(true)
    const idleToken = tokenOf(idle)
    expect(
      idle.lc.reportProtection({
        ...R,
        decision: 'safe',
        providerId: 'provider.a',
        revision: 1,
        instanceGeneration: idleToken.instanceGeneration,
        navigationGeneration: idleToken.navigationGeneration
      }).ok
    ).toBe(true)
    idle.advance(1_000)
    expect(codesOf(idle, restoreMeta(idle))).toContain('idle-short')

    const ttl = harness({ protectionTtlMs: Number.NaN })
    bringLive(ttl)
    const restore = deepSleepReady(ttl)
    ttl.advance(2_001)
    expect(codesOf(ttl, restore)).toContain('protection-expired')
  })
})

describe('关闭记录的显式遗忘', () => {
  it('关闭意图不释放未确认终止的创建许可', () => {
    const h = harness()
    h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'q' })
    const permit = h.lc.createPermit(R)
    if (!permit.ok) throw new Error(permit.code)
    h.lc.beginAttach(permit.permit.permitId)
    h.lc.closeResource(R)
    expect(h.lc.reopenResource(R)).toMatchObject({ ok: false, code: 'instance-present' })
    expect(h.lc.forgetClosed(R)).toMatchObject({ ok: false, code: 'instance-present' })
    expect(h.lc.recordAttached(evidence(permit.permit.permitId, 'late', permit.permit.token))).toMatchObject({ ok: false })
    h.lc.abandonPermit(permit.permit.permitId, { terminationConfirmed: true, reason: 'attach-failed' })
    expect(h.lc.reopenResource(R)).toMatchObject({ ok: true })
  })
  it('只删除 closed 且 guest/permit 均已清空的记录，owner 与状态都要核对', () => {
    const h = harness()
    bringLive(h)
    expect(h.lc.forgetClosed(R)).toMatchObject({ ok: false, code: 'not-eligible' })
    expect(h.lc.closeResource({ ...R, reason: 'user' })).toEqual({ ok: true, alreadyClosed: false })
    // 用户关闭只清需求，旧 guest 句柄还在：必须等匹配的 destroyed 证据
    expect(h.lc.forgetClosed(R)).toMatchObject({ ok: false, code: 'instance-present' })
    expect(h.lc.stats().resources).toBe(1)

    const closed = h.lc.inspect(R)
    if (!closed.ok) throw new Error('unreachable')
    expect(
      h.lc.recordDestroyed({ ...R, instanceGeneration: closed.view.token.instanceGeneration, guestId: 'guest-1' }).ok
    ).toBe(true)
    expect(h.lc.forgetClosed({ ...R, ownerId: 'owner-other' })).toMatchObject({ ok: false, code: 'owner-mismatch' })
    expect(h.lc.forgetClosed(R)).toEqual({ ok: true, removed: true })
    expect(h.lc.inspect(R)).toEqual({ ok: false, code: 'not-found' })
    expect(h.lc.stats().resources).toBe(0)
    expect(h.lc.setDemand({ ...R, source: 'explicitMain', requestId: 'req-again' }).ok).toBe(true)
    const replacement = h.lc.createPermit(R)
    if (!replacement.ok) throw new Error(replacement.code)
    expect(replacement.permit.token.instanceGeneration).toBeGreaterThan(closed.view.token.instanceGeneration)
    expect(h.lc.recordReady(closed.view.token)).toMatchObject({ ok: false, code: 'stale-token' })
    expect(h.lc.recordDestroyed({ ...R, instanceGeneration: closed.view.token.instanceGeneration, guestId: 'guest-1' })).toMatchObject({ ok: false, code: 'stale-generation' })
  })

  it('关闭记录占满预算后必须显式遗忘，遗忘即回收且不会自动驱逐 live 记录', () => {
    const h = harness()
    bringLive(h)
    for (let index = 0; index < 99; index += 1) {
      expect(h.lc.setDemand({ ...R, resourceId: `closed-${index}`, source: 'bulkVisible', requestId: 'q' }).ok).toBe(true)
      expect(h.lc.closeResource({ ...R, resourceId: `closed-${index}`, reason: 'user' }).ok).toBe(true)
    }
    expect(h.lc.stats().resources).toBe(100)
    expect(h.lc.stats().live).toBe(1)
    expect(h.lc.stats().closed).toBe(99)
    expect(failureCode(h.lc.setDemand({ ...R, resourceId: 'overflow', source: 'bulkVisible', requestId: 'q' }))).toBe(
      'limit-reached'
    )
    expect(h.lc.forgetClosed(R)).toMatchObject({ ok: false, code: 'not-eligible' })
    expect(h.lc.forgetClosed({ ...R, resourceId: 'closed-0' })).toEqual({ ok: true, removed: true })
    expect(h.lc.stats().resources).toBe(99)
    expect(h.lc.setDemand({ ...R, resourceId: 'overflow', source: 'bulkVisible', requestId: 'q' }).ok).toBe(true)
  })
})
