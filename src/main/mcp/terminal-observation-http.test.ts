import { EventEmitter, getEventListeners } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import { OperationError } from '@shared/operation'
import { PatternMatchError } from '../terminal/pattern-contract'
import type { WaitForPatternOptions, WaitForPatternResult } from '../terminal/session-manager'
import type { TokenBinding } from './auth'

const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const names = ['handleWaitForPrompt', 'handleTailUntil', 'observationAbort', 'sendOperationError']
const script = ts.transpileModule(names.map(name => {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw new Error(`Missing ${name}`)
  return node.getText(source)
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

type Handler = 'handleWaitForPrompt' | 'handleTailUntil'
interface HttpApi {
  handleWaitForPrompt: (data: unknown, res: EventEmitter, binding: TokenBinding) => Promise<void>
  handleTailUntil: (data: unknown, res: EventEmitter, binding: TokenBinding) => Promise<void>
}
interface ResponseBody {
  success: boolean
  data?: Record<string, unknown>
  code?: string
  reason?: string
  error?: string
  retryDisposition?: string
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const verify of cleanups) verify()
  cleanups.length = 0
})

function fixture() {
  const binding: TokenBinding = { kind: 'global' }
  const state = { credential: true, visible: true }
  const session = { config: { type: ConnectionType.SSH }, status: ConnectionStatus.CONNECTED }
  let live = session
  const result: WaitForPatternResult = {
    matched: true, settled: true, reason: 'matched', output: 'raw fixture output', cleanOutput: 'clean fixture output',
    elapsedMs: 12, pattern: 'fixture', mode: 'regex'
  }
  const wait = vi.fn<[string, WaitForPatternOptions], Promise<WaitForPatternResult>>(async () => result)
  const authorize = vi.fn(async () => ({ allowed: true }))
  const responses: Array<{ status: number; body: ResponseBody }> = []
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false })
  const mainThreadRegExp = vi.fn(function () { throw new Error('External regex compilation must remain in the matcher worker') })
  const context = {
    OperationError, ConnectionStatus, AbortController, RegExp: mainThreadRegExp,
    MAX_COMMAND_TIMEOUT_MS: 300000,
    clampNumber: (value: unknown, min: number, max: number, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(value, max)) : fallback,
    bindingCredentialIds: new WeakMap([[binding, 'trusted-credential']]),
    resolveRuntimeSessionId: (id: string) => id === 'saved-target' ? 'target' : id,
    sessionManager: { getSession: (id: string) => id === 'target' ? live : undefined, waitForPattern: wait },
    authorizeMcpOperation: authorize,
    isMcpConfirmationAuthorized: () => state.credential,
    isSessionAllowedForMcp: () => state.visible,
    sendJson: (response: typeof res, status: number, body: ResponseBody) => {
      if (!response.destroyed) responses.push({ status, body })
    }
  }
  const api = runInNewContext(script + '\n({handleWaitForPrompt,handleTailUntil})', context) as HttpApi
  cleanups.push(() => {
    expect(res.listenerCount('close')).toBe(0)
    expect(mainThreadRegExp).not.toHaveBeenCalled()
  })
  return { api, res, binding, state, session, result, wait, authorize, responses,
    replace: () => { live = { ...session } } }
}

const request = (f: ReturnType<typeof fixture>, handler: Handler, extra: Record<string, unknown> = {}) =>
  f.api[handler]({ sessionId: 'saved-target', ...(handler === 'handleTailUntil' ? { pattern: 'fixture' } : {}), ...extra }, f.res, f.binding)

describe('HTTP 终端观察隔离与兼容契约', () => {
  it('默认 prompt 保留历史预检语义与可信 caller，literal tail 使用最近输出范围', async () => {
    const prompt = fixture()
    await request(prompt, 'handleWaitForPrompt')
    expect(prompt.wait).toHaveBeenCalledWith('target', expect.objectContaining({
      pattern: undefined, mode: undefined, scope: 'new-output', checkHistoryFirst: true,
      historyLines: 1000, callerKey: 'trusted-credential'
    }))
    expect(prompt.responses[0]).toMatchObject({ status: 200, body: { success: true,
      data: { output: 'clean fixture output', cleanOutput: 'clean fixture output', patternMatched: true } } })

    const tail = fixture()
    await request(tail, 'handleTailUntil', { pattern: 'literal [text]', patternMode: 'literal' })
    expect(tail.wait).toHaveBeenCalledWith('target', expect.objectContaining({
      pattern: 'literal [text]', mode: 'literal', scope: 'recent', historyLines: 500, callerKey: 'trusted-credential'
    }))
    expect(tail.wait.mock.calls[0][1].checkHistoryFirst).toBeUndefined()
    expect(tail.responses[0]).toMatchObject({ status: 200, body: { success: true, data: { matched: true, output: 'clean fixture output' } } })
  })

  it('仅指定 mode 而没有 pattern 时保留服务的参数错误、禁止重试与固定原因', async () => {
    const f = fixture()
    f.wait.mockRejectedValueOnce(new PatternMatchError('PATTERN_MODE_WITHOUT_PATTERN'))
    await request(f, 'handleWaitForPrompt', { patternMode: 'literal' })
    expect(f.wait).toHaveBeenCalledWith('target', expect.objectContaining({ pattern: undefined, mode: 'literal' }))
    expect(f.responses[0]).toMatchObject({ status: 400, body: {
      success: false, code: 'INVALID_ARGUMENT', retryDisposition: 'never', reason: 'PATTERN_MODE_WITHOUT_PATTERN'
    } })
  })

  it.each(['handleWaitForPrompt', 'handleTailUntil'] as const)('%s Worker 硬超时保留 RESOURCE_LIMIT/never 与原因，不透出模式正文', async handler => {
    const f = fixture()
    f.wait.mockRejectedValueOnce(new PatternMatchError('MATCH_EXECUTION_TIMEOUT'))
    await request(f, handler, { pattern: 'private-pattern-(a+)+$' })
    expect(f.responses[0]).toMatchObject({ status: 429, body: {
      success: false, code: 'RESOURCE_LIMIT', retryDisposition: 'never', reason: 'MATCH_EXECUTION_TIMEOUT'
    } })
    expect(JSON.stringify(f.responses)).not.toContain('private-pattern')
    expect(JSON.stringify(f.responses)).not.toContain('fixture output')
  })

  it.each(['handleWaitForPrompt', 'handleTailUntil'] as const)('%s 在授权 await 期间撤权不进入观察服务', async handler => {
    const f = fixture()
    f.authorize.mockImplementationOnce(async () => {
      await Promise.resolve()
      f.state.credential = false
      return { allowed: true }
    })
    await request(f, handler)
    expect(f.wait).not.toHaveBeenCalled()
    expect(f.responses[0]).toMatchObject({ status: 403, body: { success: false, code: 'FORBIDDEN' } })
    expect(JSON.stringify(f.responses)).not.toContain('fixture output')
  })

  it.each(['handleWaitForPrompt', 'handleTailUntil'] as const)('%s 在 matcher await 期间撤权不投影旧 output', async handler => {
    const f = fixture()
    f.wait.mockImplementationOnce(async (_id, options) => {
      expect(options.authorizeObservation?.()).toBe(true)
      await Promise.resolve()
      f.state.visible = false
      expect(options.authorizeObservation?.()).toBe(false)
      return f.result
    })
    await request(f, handler)
    expect(f.responses[0]).toMatchObject({ status: 403, body: { success: false, code: 'FORBIDDEN' } })
    expect(JSON.stringify(f.responses)).not.toContain('fixture output')
  })

  it.each(['handleWaitForPrompt', 'handleTailUntil'] as const)('%s 在授权等待后拒绝被替换的 Session 实例', async handler => {
    const f = fixture()
    f.authorize.mockImplementationOnce(async () => {
      await Promise.resolve()
      f.replace()
      return { allowed: true }
    })
    await request(f, handler)
    expect(f.wait).not.toHaveBeenCalled()
    expect(f.responses[0]).toMatchObject({ status: 409, body: { success: false, code: 'STALE_GENERATION', retryDisposition: 'never' } })
  })

  it.each(['handleWaitForPrompt', 'handleTailUntil'] as const)('%s response.close 中止信号，finally 移除观察监听器', async handler => {
    const f = fixture()
    let signal!: AbortSignal
    f.wait.mockImplementationOnce((_id, options) => new Promise((_resolve, reject) => {
      signal = options.signal!
      signal.addEventListener('abort', () => reject(new PatternMatchError('MATCH_CANCELLED')), { once: true })
    }))
    const pending = request(f, handler)
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalledOnce())
    expect(f.res.listenerCount('close')).toBe(1)
    expect(signal.aborted).toBe(false)
    f.res.destroyed = true
    f.res.emit('close')
    await pending
    expect(signal.aborted).toBe(true)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(f.res.listenerCount('close')).toBe(0)
    expect(f.responses).toEqual([])
  })

  it('成功返回后再发生 close 不会触发已经清理的取消器', async () => {
    const f = fixture()
    await request(f, 'handleWaitForPrompt')
    const signal = f.wait.mock.calls[0][1].signal!
    expect(signal.aborted).toBe(false)
    f.res.emit('close')
    expect(signal.aborted).toBe(false)
  })
})
