import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { InputControlService } from '../terminal/input-control'
import { OperationError } from '@shared/operation'
import type { ControlHandle, ControllerIdentity } from '@shared/terminal-control'
import { readTerminalControlRequest } from '@shared/terminal-control-request'

// 执行实际 HTTP handler：Electron 外壳与人工确认窗口替换为隔离夹具，租约服务是真实实现。
const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleTerminalControl')!
const script = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

describe('HTTP 自动化交接边界', () => {
  it.each(['confirmed', 'denied', 'revoked', 'connection-replaced', 'lease-replaced'] as const)('确认期间 %s：只有同一现场允许输入', async change => {
    const service = new InputControlService({ onFence: async () => {} })
    service.bindSession('target', 'connection')
    await service.acquire({ sessionId: 'target', identity: { principalId: 'gui:1', source: 'gui' } })
    let current = true
    const session = {
      config: { type: 'local', name: 'fixture' },
      connector: { id: 'connector-1' },
      connectionInstanceId: 'connection'
    }
    const confirm = vi.fn(async (_content: unknown, authorized: () => boolean) => {
      if (change === 'revoked') current = false
      if (change === 'connection-replaced') {
        service.bindSession('target', 'new-connection')
        session.connectionInstanceId = 'new-connection'
        session.connector = { id: 'connector-2' }
      }
      if (change === 'lease-replaced') await service.acquire({ sessionId: 'target', identity: { principalId: 'gui:2', source: 'gui' }, takeover: true })
      return change !== 'denied' && authorized()
    })
    const sendJson = vi.fn()
    const acquireInput = vi.fn((sessionId: string, identity: Parameters<InputControlService['acquire']>[0]['identity'], options: { contextConfirmed: boolean }) => service.acquire({ sessionId, identity, ...options }))
    const handler = runInNewContext(script + '\nhandleTerminalControl', {
      readTerminalControlRequest, OperationError, sendJson,
      resolveRuntimeSessionId: (id: string) => id,
      sessionManager: { inputControl: service, getSession: () => session, acquireInput },
      authorizeMcpOperation: async () => ({ allowed: true }),
      inputIdentity: () => ({ principalId: 'automation:fixture', credentialId: 'fixture', source: 'automation' }),
      isMcpConfirmationAuthorized: () => current, isSessionAllowedForMcp: () => true,
      requestMcpConfirmation: confirm, mcpRequestSource: () => 'fixture', t: (key: string) => key
    })
    await handler({ kind: 'acquire', sessionId: 'target' }, {}, {})
    expect(confirm).toHaveBeenCalledOnce()
    expect(acquireInput).toHaveBeenCalledTimes(change === 'confirmed' ? 1 : 0)
    expect(sendJson.mock.calls.at(-1)?.[1]).toBe(change === 'confirmed' ? 200 : 403)
    if (change === 'confirmed') {
      const handle = sendJson.mock.calls.at(-1)![2].data.control
      await expect(service.assertInput(handle)).resolves.toMatchObject({ leaseId: handle.leaseId })
      await service.acquire({ sessionId: 'target', identity: { principalId: 'gui:1', source: 'gui' }, takeover: true })
      await expect(service.assertInput(handle)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    }
  })
})

// ── F05：清理 fence 期间与取得租约期间的现场变化 ─────────────────────────────
type InjectionPhase = 'clear' | 'install'

interface RaceContext {
  service: InputControlService
  confirmationValid: boolean
  sessionAllowed: boolean
  session: { config: { type: string; name: string }; connector?: { id: string }; connectionInstanceId?: string }
}

/** 真实 handler + 真实租约服务；onFence 就是注入窗口（null=清理，对象=安装）。 */
function buildRaceFixture(options: {
  injectAt: InjectionPhase
  inject: (ctx: RaceContext) => void | Promise<void>
  release?: (ctx: RaceContext, handle: ControlHandle) => Promise<void>
}) {
  const ctx = {
    confirmationValid: true,
    sessionAllowed: true,
    session: {
      config: { type: 'local', name: 'fixture' },
      connector: { id: 'connector-1' },
      connectionInstanceId: 'connection'
    }
  } as RaceContext
  let armed = false
  const service = new InputControlService({
    onFence: async (_sessionId, fence) => {
      if (!armed) return
      if ((fence === null) === (options.injectAt === 'clear')) await options.inject(ctx)
    }
  })
  ctx.service = service
  service.bindSession('target', 'connection')

  const sendJson = vi.fn()
  const acquireInput = vi.fn((sessionId: string, identity: ControllerIdentity, acquireOptions: { contextConfirmed?: boolean; takeover?: boolean }) =>
    service.acquire({ sessionId, identity, ...acquireOptions }))
  const releaseInput = vi.fn((handle: ControlHandle) =>
    options.release ? options.release(ctx, handle) : service.release(handle))
  const confirm = vi.fn(async (_content: unknown, authorized: () => boolean) => authorized())
  const handler = runInNewContext(script + '\nhandleTerminalControl', {
    readTerminalControlRequest, OperationError, sendJson,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    resolveRuntimeSessionId: (id: string) => id,
    sessionManager: { inputControl: service, getSession: () => ctx.session, acquireInput, releaseInput },
    authorizeMcpOperation: async () => ({ allowed: true }),
    inputIdentity: () => ({ principalId: 'automation:fixture', credentialId: 'fixture', source: 'automation' }),
    isMcpConfirmationAuthorized: () => ctx.confirmationValid,
    isSessionAllowedForMcp: () => ctx.sessionAllowed,
    requestMcpConfirmation: confirm, mcpRequestSource: () => 'fixture', t: (key: string) => key
  })
  return {
    ctx, service, sendJson, acquireInput, releaseInput, confirm,
    arm: () => { armed = true },
    run: async () => { await handler({ kind: 'acquire', sessionId: 'target' }, {}, {}) },
    status: () => sendJson.mock.calls.at(-1)?.[1] as number | undefined,
    handle: () => sendJson.mock.calls.at(-1)?.[2]?.data?.control as ControlHandle | undefined,
    lease: () => service.currentSnapshot('target')?.lease ?? null
  }
}

const raceChanges = [
  // 真实换连接：租约服务换代，同时原 Session 的 connector/connectionInstanceId 也跟着换代。
  { change: 'connection-replaced', apply: (ctx: RaceContext) => {
    ctx.service.bindSession('target', 'new-connection')
    ctx.session.connectionInstanceId = 'new-connection'
    ctx.session.connector = { id: 'connector-2' }
  } },
  { change: 'session-replaced', apply: (ctx: RaceContext) => {
    ctx.session = {
      config: { type: 'local', name: 'replacement' },
      connector: { id: 'connector-9' },
      connectionInstanceId: 'replacement-connection'
    }
  } },
  { change: 'credential-revoked', apply: (ctx: RaceContext) => { ctx.confirmationValid = false } },
  { change: 'resource-denied', apply: (ctx: RaceContext) => { ctx.sessionAllowed = false } },
  // 同一 Session 对象原地换代：连接实例标识没变，但现场已经不是被确认的那一个。
  { change: 'type-replaced', apply: (ctx: RaceContext) => { ctx.session.config.type = 'telnet' } },
  { change: 'connector-replaced', apply: (ctx: RaceContext) => { ctx.session.connector = { id: 'connector-3' } } },
  { change: 'connection-field-replaced', apply: (ctx: RaceContext) => { ctx.session.connectionInstanceId = 'mutated-connection' } }
] as const

const raceCases = (['clear', 'install'] as const).flatMap(phase => raceChanges.map(entry => ({ phase, ...entry })))

describe('HTTP 交接清理/取得期间的现场变化', () => {
  it.each(raceCases)('$phase 等待期间 $change：拒绝且不留下自动化租约', async ({ phase, change, apply }) => {
    const fixture = buildRaceFixture({ injectAt: phase, inject: apply })
    // 交接前由界面持有输入；这次确认针对的就是这个现场。
    const gui = await fixture.service.acquire({ sessionId: 'target', identity: { principalId: 'gui:1', source: 'gui' } })
    fixture.arm()
    await fixture.run()

    // 连接替换在 acquire 内部就被代际检查拒绝（409），其余都走到复核后被拒（403）。
    const expected = phase === 'clear' ? 403 : change === 'connection-replaced' ? 409 : 403
    expect(fixture.status()).toBe(expected)
    expect(fixture.status()).not.toBe(200)
    expect(fixture.handle()).toBeUndefined()
    expect(fixture.lease()).toBeNull()

    if (phase === 'clear') {
      expect(fixture.acquireInput).not.toHaveBeenCalled()
      expect(fixture.releaseInput).not.toHaveBeenCalled()
    } else {
      expect(fixture.acquireInput).toHaveBeenCalledOnce()
      // 只有真正拿到过租约的分支需要归还；连接已在 acquire 内失效时没有可归还的租约。
      expect(fixture.releaseInput).toHaveBeenCalledTimes(change === 'connection-replaced' ? 0 : 1)
    }

    if (change === 'connection-replaced') {
      // 旧确认/旧句柄不能写新连接：租约代际已失效。
      await expect(fixture.service.assertInput(gui)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    }
  })

  it('取得后复核失败时，释放失败既不返回句柄，也不影响另一个新租约', async () => {
    let replacement: ControlHandle | undefined
    const fixture = buildRaceFixture({
      injectAt: 'install',
      inject: ctx => { ctx.sessionAllowed = false },
      release: async (ctx, handle) => {
        // 复核失败的同时另一个控制者接手：旧租约已不是当前租约，释放必然失败。
        replacement = await ctx.service.acquire({ sessionId: 'target', identity: { principalId: 'gui:9', source: 'gui' }, takeover: true })
        await ctx.service.release(handle)
      }
    })
    await fixture.service.acquire({ sessionId: 'target', identity: { principalId: 'gui:1', source: 'gui' } })
    fixture.arm()
    await fixture.run()

    expect(fixture.status()).toBe(403)
    expect(fixture.handle()).toBeUndefined()
    expect(fixture.releaseInput).toHaveBeenCalledOnce()
    expect(replacement).toBeDefined()
    expect(fixture.lease()?.source).toBe('gui')
    // 释放失败没有清掉新租约：接手方仍然可写。
    await expect(fixture.service.assertInput(replacement!)).resolves.toMatchObject({ leaseId: replacement!.leaseId })
  })

  it('正常交接不受影响：返回可用句柄且不触发归还', async () => {
    const fixture = buildRaceFixture({ injectAt: 'clear', inject: () => {} })
    await fixture.service.acquire({ sessionId: 'target', identity: { principalId: 'gui:1', source: 'gui' } })
    fixture.arm()
    await fixture.run()

    expect(fixture.status()).toBe(200)
    expect(fixture.releaseInput).not.toHaveBeenCalled()
    const handle = fixture.handle()!
    expect(handle.connectionInstanceId).toBe('connection')
    await expect(fixture.service.assertInput(handle)).resolves.toMatchObject({ leaseId: handle.leaseId, connectionInstanceId: 'connection' })
    expect(fixture.lease()?.source).toBe('automation')
  })
})
