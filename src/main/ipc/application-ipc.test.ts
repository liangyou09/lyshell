import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  phase: 'running' as 'running' | 'draining' | 'fatal',
  invokes: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  events: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  context: vi.fn(),
  diagnostic: vi.fn(),
  runContext: vi.fn(),
  warn: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: {
  handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
    fixture.invokes.set(channel, listener)
  }),
  on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
    fixture.events.set(channel, listener)
  })
} }))
vi.mock('electron-log', () => ({ default: { warn: fixture.warn } }))
vi.mock('../security/application-caller', () => ({ applicationCallers: { context: fixture.context } }))
vi.mock('../diagnostics/events', () => ({ recordDiagnosticEvent: fixture.diagnostic }))
vi.mock('../diagnostics/request-context', () => ({ runWithRequestContext: fixture.runContext }))
vi.mock('../lifecycle/app-lifecycle', async importOriginal => ({
  ...await importOriginal<typeof import('../lifecycle/app-lifecycle')>(),
  businessGate: {
    get phase() { return fixture.phase },
    accepts: () => fixture.phase === 'running'
  }
}))

import { applicationIpc } from './application-ipc'
import { LifecycleRejectedError } from '../lifecycle/app-lifecycle'

const event = { sender: { id: 13 }, senderFrame: { url: 'file:///application/index.html' } }
const context = { requestId: 'gui-request', principalId: 'gui:13', source: 'gui' as const, receivedAt: Date.now() }

beforeEach(() => {
  vi.clearAllMocks()
  fixture.phase = 'running'
  fixture.invokes.clear()
  fixture.events.clear()
  fixture.context.mockReset().mockReturnValue(context)
  fixture.runContext.mockReset().mockImplementation((_context: unknown, action: () => unknown) => action())
})

afterEach(() => { vi.restoreAllMocks() })

describe('应用 IPC 生命周期门禁', () => {
  it('running invoke 使用已核对 caller 的上下文，保留 event、参数和异步结果', async () => {
    const listener = vi.fn(async (_event: unknown, value: unknown) => ({ value }))
    applicationIpc.handle('fixture:invoke', listener)
    await expect(fixture.invokes.get('fixture:invoke')!(event, 'argument')).resolves.toEqual({ value: 'argument' })
    expect(fixture.context).toHaveBeenCalledWith(event)
    expect(fixture.runContext).toHaveBeenCalledWith(context, expect.any(Function))
    expect(listener).toHaveBeenCalledWith(event, 'argument')
    expect(fixture.diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'gui-request', operation: 'fixture:invoke', source: 'gui', outcome: 'completed'
    }))
  })

  it('running 单向事件仍验证 caller，并将原参数交给 listener', () => {
    const listener = vi.fn()
    applicationIpc.on('fixture:event', listener)
    expect(fixture.events.get('fixture:event')!(event, 'value', 7)).toBeUndefined()
    expect(fixture.context).toHaveBeenCalledWith(event)
    expect(fixture.runContext).toHaveBeenCalledWith(context, expect.any(Function))
    expect(listener).toHaveBeenCalledWith(event, 'value', 7)
    expect(fixture.warn).not.toHaveBeenCalled()
  })

  it.each(['draining', 'fatal'] as const)('%s invoke 拒绝而不进入 listener，并记录 refused', async phase => {
    fixture.phase = phase
    const listener = vi.fn()
    applicationIpc.handle('fixture:blocked', listener)
    const response = fixture.invokes.get('fixture:blocked')!(event, { cleanup: true })
    await expect(response).rejects.toBeInstanceOf(LifecycleRejectedError)
    await expect(response).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED', phase, operation: 'fixture:blocked' })
    expect(fixture.context).toHaveBeenCalledWith(event)
    expect(listener).not.toHaveBeenCalled()
    expect(fixture.runContext).not.toHaveBeenCalled()
    expect(fixture.diagnostic).toHaveBeenCalledOnce()
    expect(fixture.diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'fixture:blocked', outcome: 'refused'
    }))
  })

  it.each(['draining', 'fatal'] as const)('%s 单向事件静默丢弃，外部 cleanup 字段不能开启门禁', phase => {
    fixture.phase = phase
    const listener = vi.fn()
    applicationIpc.on('fixture:blocked-event', listener)
    expect(() => fixture.events.get('fixture:blocked-event')!(event, { cleanup: true })).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
    expect(fixture.runContext).not.toHaveBeenCalled()
    expect(fixture.warn).not.toHaveBeenCalled()
  })

  it.each(['running', 'draining', 'fatal'] as const)('%s invoke 保留未信任 caller 的原拒绝，不执行任何业务', async phase => {
    fixture.phase = phase
    const forbidden = Object.assign(new Error('Current application caller required'), { code: 'FORBIDDEN' })
    fixture.context.mockImplementationOnce(() => { throw forbidden })
    const listener = vi.fn()
    applicationIpc.handle('fixture:untrusted', listener)
    await expect(fixture.invokes.get('fixture:untrusted')!(event)).rejects.toBe(forbidden)
    expect(listener).not.toHaveBeenCalled()
    expect(fixture.runContext).not.toHaveBeenCalled()
    expect(fixture.diagnostic).not.toHaveBeenCalled()
  })

  it('running 单向事件吞下 caller 校验拒绝并保留固定诊断，不执行 listener', () => {
    fixture.context.mockImplementationOnce(() => { throw new Error('Untrusted sender') })
    const listener = vi.fn()
    applicationIpc.on('fixture:untrusted-event', listener)
    expect(() => fixture.events.get('fixture:untrusted-event')!(event)).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
    expect(fixture.runContext).not.toHaveBeenCalled()
    expect(fixture.warn).toHaveBeenCalledWith('[IPC] Rejected application event', 'fixture:untrusted-event')
  })

  it('invoke 的异步 listener 失败可由调用方观察，记录 failed 而不报 completed', async () => {
    const failure = new Error('fixture invoke failed')
    const listener = vi.fn(async () => { throw failure })
    applicationIpc.handle('fixture:failure', listener)
    await expect(fixture.invokes.get('fixture:failure')!(event)).rejects.toBe(failure)
    expect(fixture.diagnostic).toHaveBeenCalledOnce()
    expect(fixture.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', operation: 'fixture:failure' }))
  })

  it('单向 listener 的异步 rejection 已被观察，不外溢为 unhandledRejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const listener = vi.fn(async () => { throw new Error('private fixture detail') })
      applicationIpc.on('fixture:async-failure', listener)
      expect(fixture.events.get('fixture:async-failure')!(event)).toBeUndefined()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(listener).toHaveBeenCalledOnce()
      expect(unhandled).not.toHaveBeenCalled()
      expect(fixture.warn).toHaveBeenCalledOnce()
      expect(fixture.warn).toHaveBeenCalledWith('[IPC] Application event failed', 'fixture:async-failure')
      expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain('private fixture detail')
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })
})
