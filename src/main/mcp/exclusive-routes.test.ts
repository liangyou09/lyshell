import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as http from 'http'
import { EventEmitter } from 'events'

/**
 * 独占控制 HTTP 路由的边界测试：真实 host token 鉴权、输入校验、状态映射、桥同步。
 * 桥的真实行为在 exclusive-bridge.test.ts 覆盖；这里替换运行期接线，只测路由判定。
 */

vi.mock('electron-log', () => ({ default: { info: () => {}, error: () => {}, warn: () => {} } }))

const bridge = vi.hoisted(() => ({
  sync: { ok: true } as { ok: boolean; code?: string; error?: string },
  // 假桥的返回值形状（用例会逐字段改写：task/approvals/transcript/viewer）
  outcome: { ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 } } as {
    ok: boolean
    code?: string
    error?: string
    holding?: boolean
    identity?: { instanceId: string; instanceEpoch: number }
    task?: { taskId: string; sessionId: string; epoch: number; state: string; acceptedAt: number; endedAt?: number; endReason?: string } | null
    approvals?: unknown[]
    transcript?: unknown[]
    viewer?: unknown
  },
  calls: [] as Array<{ cmd: string }>,
  syncCalls: 0
}))

/** S5：详情面 runtime 的替身（真实实现在 exclusive-runtime.test.ts 覆盖）。 */
const workbench = vi.hoisted(() => ({
  acquires: 0,
  broadcasts: [] as Array<{ detail: unknown; force: boolean; reopen: boolean }>,
  result: {
    ok: true as boolean,
    code: 'instance/no-bridge',
    error: 'no backend',
    url: 'http://127.0.0.1:4999/',
    cwd: 'D:/workspace',
    instanceId: 'inst-1',
    instanceEpoch: 1000,
    reused: true,
    readOnly: false,
    viewer: { revision: 7, appliedRevision: 7, currentSessionId: 'sess-1', petSessionId: 'sess-1', connected: true, request: null, lastAck: null, ownedByCurrentViewer: true, updatedAt: 1 }
  },
  nav: { ok: true as boolean, skipped: false, code: 'viewer/stale', error: 'stale', viewer: { revision: 8, appliedRevision: 8, currentSessionId: 'sess-1', petSessionId: 'sess-1', connected: true, request: null, lastAck: null, ownedByCurrentViewer: true, updatedAt: 2 } },
  acquire() {
    workbench.acquires += 1
    return { ...workbench.result }
  },
  navigate(sessionId: string) {
    void sessionId
    return { ...workbench.nav }
  },
  publish(force = false) {
    return {
      detail: { key: 'held:1:-:sess-1', phase: 'held', petSessionId: 'sess-1', taskId: null, instanceEpoch: 1000, readOnly: false, updatedAt: 3 },
      changed: true,
      force
    }
  }
}))

vi.mock('../dsh/exclusive-runtime', () => ({
  syncExclusiveBridgeState: async () => {
    bridge.syncCalls += 1
    // 与生产接线一致：真正把桥状态同步进服务（服务实例经全局访问器取，避免 mock 工厂引用问题）
    const service = globalThis.__exclusiveServiceForTest as
      | { syncFromBridge: () => Promise<{ ok: boolean; code?: string; error?: string }> }
      | undefined
    if (service) {
      const synced = await service.syncFromBridge()
      if (!synced.ok) return synced
    }
    return bridge.sync
  },
  runExclusiveBridge: async (command: { cmd: string }) => {
    bridge.calls.push(command)
    return bridge.outcome
  },
  getDshInstanceIdentity: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
  wireExclusiveControl: () => null,
  // S5 详情面：复用渲染层同一条 runtime 路径（这里替换掉，只测路由判定与回执形状）
  acquireWorkbenchDetail: async () => workbench.acquire(),
  confirmWorkbenchNavigation: async (sessionId: string) => workbench.navigate(sessionId),
  publishWorkbenchDetail: (force = false) => workbench.publish(force)
}))

vi.mock('../events/application-notifications', () => ({
  broadcastDshWebDetail: (detail: unknown, force = false, reopen = false) => {
    workbench.broadcasts.push({ detail, force, reopen })
  }
}))

import { handleExclusiveControlRequest } from './exclusive-routes'
import { getExclusiveControl, initExclusiveControl, disposeExclusiveControl } from '../dsh/exclusive-control'
import type { ExclusiveAuthFacts } from '../dsh/exclusive-control'

declare global {
  // eslint-disable-next-line no-var
  var __exclusiveServiceForTest: { syncFromBridge: () => Promise<{ ok: boolean; code?: string; error?: string }> } | undefined
}

function fakeRequest(method: string, body?: unknown): http.IncomingMessage {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {}
  const req = {
    method,
    setEncoding: () => undefined,
    on: (event: string, handler: (arg?: unknown) => void) => {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(handler)
      if (event === 'end') {
        queueMicrotask(() => {
          if (body !== undefined) handlers.data?.forEach((h) => h(JSON.stringify(body)))
          handlers.end?.forEach((h) => h())
        })
      }
      return req
    },
    destroy: () => undefined
  }
  return req as unknown as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  facts: ExclusiveAuthFacts,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const url = new URL(`http://127.0.0.1/api/exclusive-control${path}`)
  const result = await handleExclusiveControlRequest(fakeRequest(method, body), url, facts)
  if (result === null) return null
  return { status: result.status, body: result.body as Record<string, unknown> }
}

/** 真实受控插件 host 凭据（唯一对外控制凭据）。 */
const HOST: ExclusiveAuthFacts = { kind: 'plugin', pluginId: 'aipet', tokenSource: 'host' }

beforeEach(() => {
  disposeExclusiveControl()
  const service = initExclusiveControl({
    runBridge: async (command) => {
      bridge.calls.push(command as { cmd: string })
      return bridge.outcome as never
    },
    currentInstance: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
    isPluginEnabled: () => true
  })
  globalThis.__exclusiveServiceForTest = service
  bridge.calls.length = 0
  bridge.syncCalls = 0
  bridge.sync = { ok: true }
  bridge.outcome = { ok: true, identity: { instanceId: 'inst-1', instanceEpoch: 1000 }, holding: true }
})

describe('独占控制路由：鉴权分级', () => {
  it('真实请求 socket 关闭让在飞 acquire 撤销；成功桥接后补偿 release 且移除监听', async () => {
    let resume!: () => void
    const wait = new Promise<void>(resolve => { resume = resolve })
    const commands: string[] = []
    initExclusiveControl({ currentInstance: () => ({ instanceId: 'i', instanceEpoch: 1 }), isPluginEnabled: () => true,
      runBridge: async command => {
        commands.push(command.cmd)
        if (command.cmd === 'acquire') await wait
        return { ok: true, identity: { instanceId: 'i', instanceEpoch: 1 } }
      } })
    const socket = new EventEmitter()
    const req = Object.assign(fakeRequest('POST', { pluginId: 'aipet', pluginInstanceId: 'pet', enabled: true }), { socket })
    const pending = handleExclusiveControlRequest(req as unknown as http.IncomingMessage,
      new URL('http://127.0.0.1/api/exclusive-control/acquire'), HOST)
    while (!commands.length) await Promise.resolve()
    socket.emit('close'); resume()
    expect((await pending)?.body).toMatchObject({ ok: false, code: 'auth/generation-stale' })
    expect(commands).toEqual(['acquire', 'release'])
    expect(getExclusiveControl()?.getSnapshot().phase).toBe('free')
    expect(socket.listenerCount('close')).toBe(0)
  })
  it('非本族路径返回 null（交给原路由）', async () => {
    const result = await handleExclusiveControlRequest(fakeRequest('GET'), new URL('http://127.0.0.1/api/sessions'), HOST)
    expect(result).toBeNull()
  })

  it('只读快照允许任何已鉴权凭据（S4/S5 工作台消费），且不含凭据', async () => {
    const result = await call('GET', '/snapshot', { kind: 'plugin', pluginId: 'other' })
    expect(result?.status).toBe(200)
    const json = JSON.stringify(result?.body)
    expect(json).not.toContain('token')
    expect(json).not.toContain('LYSHELL')
    expect(json).toContain('approvals')
    expect(json).toContain('transcript')
  })

  it('写操作只认 aipet 的 host token：global/session/UI/其他插件一律 403', async () => {
    for (const facts of [
      { kind: 'global' },
      { kind: 'session' },
      { kind: 'plugin', pluginId: 'aipet', tokenSource: 'ui' as const },
      { kind: 'plugin', pluginId: 'other-plugin', tokenSource: 'host' as const },
      { kind: 'dshBridge' }
    ] satisfies ExclusiveAuthFacts[]) {
      const result = await call('POST', '/acquire', facts, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
      expect(result?.status).toBe(403)
      expect(result?.body).toMatchObject({ ok: false, code: 'auth/impersonation' })
    }
    expect(bridge.calls).toEqual([])
  })

  it('插件未启用：403 auth/not-enabled（真实启用态来自仓库）', async () => {
    disposeExclusiveControl()
    initExclusiveControl({
      runBridge: async () => bridge.outcome as never,
      currentInstance: () => ({ instanceId: 'inst-1', instanceEpoch: 1000 }),
      isPluginEnabled: () => false
    })
    const result = await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    expect(result?.status).toBe(403)
    expect(result?.body).toMatchObject({ code: 'auth/not-enabled' })
  })
})

describe('独占控制路由：输入校验与状态映射', () => {
  it('acquire 严格校验：多余字段/缺字段/非 true 的 enabled 一律 400', async () => {
    for (const payload of [
      { pluginId: 'aipet', pluginInstanceId: 'pet-1' },
      { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: false },
      { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true, extra: 1 },
      { pluginId: '', pluginInstanceId: 'pet-1', enabled: true }
    ]) {
      const result = await call('POST', '/acquire', HOST, payload)
      expect(result?.status).toBe(400)
      expect(result?.body).toMatchObject({ ok: false, code: 'bad-request' })
    }
    expect(bridge.calls).toEqual([])
  })

  it('请求体自报的 pluginId 不参与身份判定：只由 token 绑定决定', async () => {
    // 用 aipet 的 host 凭据 + 请求体声称别的插件：绑定登记的是请求体 pluginId，
    // 但授权只看 token；这里验证不会因此获得额外能力（仍在同一 controller 通道内）。
    const result = await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ ok: true, binding: { pluginId: 'aipet', epoch: 1 } })
  })

  it('一次完整授权成功 + 重复 acquire 幂等', async () => {
    const payload = { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true }
    const first = await call('POST', '/acquire', HOST, payload)
    expect(first?.status).toBe(200)
    const again = await call('POST', '/acquire', HOST, payload)
    expect(again?.status).toBe(200)
    expect(again?.body).toMatchObject({ ok: true, binding: { epoch: 1 } })
  })

  it('未持有时任务操作 409 control/not-held；submit 需要 epoch + 非空正文', async () => {
    expect((await call('POST', '/submit', HOST, { epoch: 1, text: 'x' }))?.status).toBe(409)
    expect((await call('POST', '/submit', HOST, { epoch: 0, text: 'x' }))?.status).toBe(400)
    expect((await call('POST', '/submit', HOST, { epoch: 1, text: '' }))?.status).toBe(400)
  })

  it('events：非法游标 400；合法返回有界批次与快照', async () => {
    expect((await call('GET', '/events?since=-1', HOST))?.status).toBe(400)
    expect((await call('GET', '/events?limit=99999', HOST))?.status).toBe(400)
    const ok = await call('GET', '/events?since=0&limit=10', HOST)
    expect(ok?.status).toBe(200)
    expect(ok?.body).toMatchObject({ ok: true, gap: false })
    expect(ok?.body).toHaveProperty('snapshot')
  })

  it('未知子路径 404；release 需要合法 epoch', async () => {
    expect((await call('POST', '/nope', HOST, {}))?.status).toBe(404)
    expect((await call('POST', '/release', HOST, { epoch: 'x' }))?.status).toBe(400)
  })

  it('桥不可达：acquire 映射 503 且不留绑定（不本地兜底）', async () => {
    bridge.outcome = { ok: false, code: 'bridge/unavailable', error: 'down' }
    const result = await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    expect(result?.status).toBe(503)
    expect(result?.body).toMatchObject({ code: 'instance/no-bridge' })
    expect(getExclusiveControl()?.isHeld).toBe(false)
  })

  it('服务未初始化：明确 503，不静默放行', async () => {
    disposeExclusiveControl()
    const result = await call('GET', '/snapshot', HOST)
    expect(result?.status).toBe(503)
    expect(result?.body).toMatchObject({ ok: false, code: 'instance/unavailable' })
  })
})

describe('独占控制路由：读路径与桥同步', () => {
  it('snapshot 会先同步桥状态（任务终态/审批/输出）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    bridge.outcome = {
      ok: true,
      holding: true,
      task: { taskId: 't1', sessionId: 's1', epoch: 1, state: 'running', acceptedAt: 1 },
      approvals: [{ approvalId: 'a1', taskId: 't1', sessionId: 's1', epoch: 1, toolName: 'pwsh', askedAt: 3 }],
      transcript: [{ seq: 1, at: 1, kind: 'assistant', sessionId: 's1', text: 'hi' }]
    }
    const before = bridge.syncCalls
    const result = await call('GET', '/snapshot', HOST)
    expect(bridge.syncCalls).toBeGreaterThan(before)
    const snapshot = result?.body.snapshot as Record<string, unknown>
    expect(snapshot.activeTask).toMatchObject({ state: 'running' })
    expect((snapshot.approvals as unknown[]).length).toBe(1)
    expect((snapshot.transcript as unknown[]).length).toBe(1)
    bridge.outcome.task = { taskId: 't1', sessionId: 's1', epoch: 1, state: 'completed', acceptedAt: 1, endedAt: 2, endReason: 'completed' }
    const ended = await call('GET', '/snapshot', HOST)
    expect(ended?.body.snapshot).toMatchObject({ activeTask: { state: 'completed' }, approvals: [] })
  })

  it('events 也会同步桥状态', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    const before = bridge.syncCalls
    await call('GET', '/events?since=0&limit=10', HOST)
    expect(bridge.syncCalls).toBeGreaterThan(before)
  })

  it('桥同步失败且正在持有时：明确 503，不谎报状态', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    bridge.sync = { ok: false, code: 'bridge/unavailable', error: 'down' }
    const result = await call('GET', '/snapshot', HOST)
    expect(result?.status).toBe(503)
    expect(result?.body).toMatchObject({ ok: false, code: 'bridge/unavailable' })
  })

  it('releasing 期间同步失败同样明确 503（isHeld=false 不得吞掉 host 错误）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    // 桥 release 未确认 ⇒ 撤销后停留在 releasing（不假 free、租约保留）
    bridge.outcome = { ok: false, code: 'bridge/unavailable', error: 'release not confirmed' }
    getExclusiveControl()?.revoke('plugin disabled')
    await new Promise((r) => setTimeout(r, 0))
    const service = getExclusiveControl()
    expect(service?.isHeld).toBe(false)
    expect(service?.isReleasing).toBe(true)

    bridge.sync = { ok: false, code: 'bridge/unavailable', error: 'down' }
    const snapshot = await call('GET', '/snapshot', HOST)
    expect(snapshot?.status).toBe(503)
    expect(snapshot?.body).toMatchObject({ ok: false, code: 'bridge/unavailable' })
    const events = await call('GET', '/events?since=0&limit=10', HOST)
    expect(events?.status).toBe(503)
  })

  it('release 桥未确认：明确 503 并保留 held（不假成功、不假 free）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    bridge.outcome = { ok: false, code: 'bridge/unavailable', error: 'release not confirmed' }
    const released = await call('POST', '/release', HOST, { epoch: 1 })
    expect(released?.status).toBe(503)
    const service = getExclusiveControl()
    expect(service?.isHeld).toBe(true)
    expect(service?.getSnapshot().binding).not.toBeNull()
  })

  it('未持有时桥同步失败不阻塞只读快照', async () => {
    bridge.sync = { ok: false, code: 'bridge/unavailable', error: 'down' }
    const result = await call('GET', '/snapshot', HOST)
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ ok: true })
  })

  it('acquire 请求体 pluginId 与凭据不一致：403 冒充拒绝（身份只认 token）', async () => {
    const result = await call('POST', '/acquire', HOST, { pluginId: 'evil-plugin', pluginInstanceId: 'pet-1', enabled: true })
    expect(result?.status).toBe(403)
    expect(result?.body).toMatchObject({ ok: false, code: 'auth/impersonation' })
    expect(bridge.calls.filter((c) => c.cmd === 'acquire')).toEqual([])
  })
})

/**
 * S5：托管工作台详情路由。
 * 只复用已有 runtime 路径 + 详情面广播；epoch 必须匹配当前绑定；导航失败如实回执，不 fake ack。
 */
describe('独占控制路由：托管工作台详情（S5）', () => {
  beforeEach(() => {
    workbench.acquires = 0
    workbench.broadcasts.length = 0
    workbench.result = {
      ok: true,
      code: 'instance/no-bridge',
      error: 'no backend',
      url: 'http://127.0.0.1:4999/',
      cwd: 'D:/workspace',
      instanceId: 'inst-1',
      instanceEpoch: 1000,
      reused: true,
      readOnly: false,
      viewer: { revision: 7, appliedRevision: 7, currentSessionId: 'sess-1', petSessionId: 'sess-1', connected: true, request: null, lastAck: null, ownedByCurrentViewer: true, updatedAt: 1 }
    }
    workbench.nav = { ok: true, skipped: false, code: 'viewer/stale', error: 'stale', viewer: { revision: 8, appliedRevision: 8, currentSessionId: 'sess-1', petSessionId: 'sess-1', connected: true, request: null, lastAck: null, ownedByCurrentViewer: true, updatedAt: 2 } }
  })

  it('未持有独占：409（详情只在独占期间存在）', async () => {
    const result = await call('POST', '/detail', HOST, { epoch: 1 })
    expect(result?.status).toBe(409)
    expect(result?.body).toMatchObject({ ok: false, code: 'control/not-held' })
    expect(workbench.acquires).toBe(0)
  })

  it('旧 epoch：409 stale，且不触碰 runtime（不拽用户、不重开）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    const broadcasts = workbench.broadcasts.length
    const stale = await call('POST', '/detail', HOST, { epoch: 99, sessionId: 'sess-1' })
    expect(stale?.status).toBe(409)
    expect(stale?.body).toMatchObject({ code: 'task/stale-epoch' })
    expect(workbench.acquires).toBe(0)
    expect(workbench.broadcasts.length).toBe(broadcasts)
  })

  it('形状非法：400（未知字段 / sessionId 非法 / epoch 非法）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    expect((await call('POST', '/detail', HOST, { epoch: 1, extra: true }))?.status).toBe(400)
    expect((await call('POST', '/detail', HOST, { epoch: 1, sessionId: '' }))?.status).toBe(400)
    expect((await call('POST', '/detail', HOST, { epoch: 0 }))?.status).toBe(400)
    expect(workbench.acquires).toBe(0)
  })

  it('同实例同会话：复用后台 + 真实导航回执 + 详情面广播（不重开页签）', async () => {
    workbench.result.url = 'http://127.0.0.1:4999/?token=SECRET_DSH_LOGIN'
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    const broadcasts = workbench.broadcasts.length
    const result = await call('POST', '/detail', HOST, { epoch: 1, sessionId: 'sess-1' })
    expect(result?.status).toBe(200)
    expect(workbench.acquires).toBe(1)
    expect(result?.body).toMatchObject({
      ok: true,
      reused: true,
      readOnly: false,
      petSessionId: 'sess-1',
      currentSessionId: 'sess-1',
      navigation: { ok: true, skipped: false }
    })
    expect(result?.body).not.toHaveProperty('url')
    expect(JSON.stringify(result?.body)).not.toContain('SECRET_DSH_LOGIN')
    expect(workbench.result.url).toContain('SECRET_DSH_LOGIN') // 内部 runtime/webview 链仍保留地址
    // force 补发：页签刚打开/渲染层刚重载时也要拿到当前详情面；身份不变 ⇒ 渲染层不会重挂。
    expect(workbench.broadcasts.length).toBe(broadcasts + 1)
    expect(workbench.broadcasts.at(-1)?.force).toBe(true)
    expect(workbench.broadcasts.at(-1)?.reopen).toBe(true)
  })

  it('导航被用户浏览作废：navigation.ok=false 如实回执（不 fake ack、不重试）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    workbench.nav = { ...workbench.nav, ok: false, code: 'viewer/stale', error: 'superseded' }
    const result = await call('POST', '/detail', HOST, { epoch: 1, sessionId: 'sess-1' })
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ ok: true, navigation: { ok: false, code: 'viewer/stale' } })
  })

  it('后台不可用：明确 503（不本地兜底）', async () => {
    await call('POST', '/acquire', HOST, { pluginId: 'aipet', pluginInstanceId: 'pet-1', enabled: true })
    const broadcasts = workbench.broadcasts.length
    workbench.result = { ...workbench.result, ok: false, code: 'instance/no-bridge', error: 'no backend' }
    const result = await call('POST', '/detail', HOST, { epoch: 1 })
    expect(result?.status).toBe(503)
    expect(result?.body).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    expect(workbench.broadcasts.length).toBe(broadcasts)
  })

  it('其他插件凭据：403（详情同属控制面写路径）', async () => {
    const result = await call('POST', '/detail', { kind: 'plugin', pluginId: 'other', tokenSource: 'host' }, { epoch: 1 })
    expect(result?.status).toBe(403)
    expect(workbench.acquires).toBe(0)
  })
})
