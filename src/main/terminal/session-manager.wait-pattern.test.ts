/**
 * R1 接入回归：session-manager 的 sendAndWait / waitForPattern 必须
 *  - 把所有外部 pattern 交给隔离 matcher（本文件 mock 掉池，只验证接入顺序与语义）；
 *  - 保持锁 owner、游标/epoch、授权与代际校验；
 *  - 编译失败不写终端、并发不互相踩锁、断连/撤销不留锁。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfig } from '@shared/types'
import { ConnectionStatus, ConnectionType } from '@shared/types'

vi.mock('electron', () => ({ app: {} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/file', () => ({ fileManager: { removeConnector: vi.fn(async () => {}) }, cancelDownloadsBySession: vi.fn(), cancelUploadsBySession: vi.fn() }))
vi.mock('@main/mcp/auth', () => ({ bindSessionToken: vi.fn(() => 'test-token'), revokeSessionToken: vi.fn() }))
vi.mock('@main/mcp/http-port', () => ({ getMcpHttpPort: () => 12345 }))
vi.mock('../connectors', async () => {
  const { EventEmitter } = await import('events')
  class Connector extends EventEmitter {
    constructor(_id: string, readonly receivedConfig?: Record<string, unknown>) { super() }
    async connect() {}
    disconnect = vi.fn(async () => {})
    write = vi.fn()
    async writeConfirmed(data: string) { this.write(data) }
    async setInputControl() {}
    resize = vi.fn()
    getSpawnCwd() { return null }
  }
  return {
    SSHConnector: Connector,
    TelnetConnector: Connector,
    SerialConnector: Connector,
    LocalConnector: Connector,
    ConnectionStatus: { CONNECTED: 'connected', CONNECTING: 'connecting', DISCONNECTED: 'disconnected', ERROR: 'error' },
    ConnectionType: { SSH: 'ssh', TELNET: 'telnet', SERIAL: 'serial', LOCAL: 'local' }
  }
})
vi.mock('./pattern-matcher', () => ({
  patternMatcher: {
    // validate 是同步归一化：返回的 spec 会被后续 compile/match 直接使用。
    validate: vi.fn((spec: { pattern: string; mode?: string }) => ({ pattern: spec.pattern, mode: spec.mode ?? 'regex' })),
    compile: vi.fn(async (spec: { pattern: string; mode?: string }) => ({ pattern: spec.pattern, mode: spec.mode ?? 'regex' })),
    match: vi.fn(async () => ({ matched: false, matchedIndex: 0, elapsedMs: 0, pattern: 'x', mode: 'regex' })),
    // 等待器配额覆盖整个等待调用：每次 sendAndWait / waitForPattern 取一份、finally 释放。
    acquireWaiter: vi.fn((callerKey: string) => ({ callerKey, release: vi.fn() })),
    diagnostics: vi.fn(() => ({})),
    shutdown: vi.fn(async () => ({ confirmedExits: 0, unconfirmedExits: 0 }))
  },
  PatternMatcher: class {},
  PATTERN_WORKER_SCRIPT_ENV: 'LYSHELL_PATTERN_WORKER_SCRIPT'
}))

import { SessionManager } from './session-manager'
import { patternMatcher } from './pattern-matcher'
import { BUILTIN_PROMPT_PATTERN, PatternMatchError } from './pattern-contract'

const match = vi.mocked(patternMatcher.match)
const compile = vi.mocked(patternMatcher.compile)
const validate = vi.mocked(patternMatcher.validate)

const managers: SessionManager[] = []
async function fixture() {
  const manager = new SessionManager()
  managers.push(manager)
  const session = await manager.createSession({
    id: 'wait-pattern-case',
    name: 'Test',
    type: ConnectionType.TELNET,
    telnet: { host: 'localhost', port: 23 },
    terminal: {} as SessionConfig['terminal'],
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date()
  })
  await manager.connectSession(session.id)
  manager.inputControl.setCredentialValidator(() => true)
  return { manager, session }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

beforeEach(() => {
  vi.clearAllMocks()
  match.mockResolvedValue({ matched: false, matchedIndex: 0, elapsedMs: 0, pattern: 'x', mode: 'regex' })
  compile.mockImplementation(async (spec: { pattern: string; mode?: string }) => ({ pattern: spec.pattern, mode: spec.mode ?? 'regex' }) as never)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) for (const session of manager.getAllSessions()) await manager.deleteSession(session.id)
  vi.useRealTimers()
})

describe('waitForPattern：只读观测语义', () => {
  it('无 pattern 时使用内置提示符正则；显式 mode 无 pattern 是参数错误且不触发匹配', async () => {
    const { manager } = await fixture()
    const pending = manager.waitForPattern('wait-pattern-case', { timeoutMs: 150, pollMs: 25 })
    await vi.waitFor(() => expect(validate).toHaveBeenCalled())
    expect(validate.mock.calls[0][0]).toMatchObject({ pattern: BUILTIN_PROMPT_PATTERN })
    const result = await pending
    expect(result).toMatchObject({ matched: false, reason: 'timeout' })
    expect(result.output).toBe('')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100)

    match.mockClear()
    await expect(manager.waitForPattern('wait-pattern-case', { mode: 'literal', timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'PATTERN_MODE_WITHOUT_PATTERN' })
    expect(match).not.toHaveBeenCalled()
  })

  it('history 预检先看最近输出，新输出游标变化后才重新匹配且基底不含旧输出', async () => {
    const { manager, session } = await fixture()
    session.connector!.emit('data', 'OLD-READY\r\n')
    const pending = manager.waitForPattern(session.id, {
      pattern: 'READY',
      scope: 'new-output',
      checkHistoryFirst: true,
      timeoutMs: 500,
      pollMs: 25,
      callerKey: 'caller-1'
    })
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    expect(match.mock.calls[0][0]).toMatchObject({ callerKey: 'caller-1' })
    expect(match.mock.calls[0][0].inputs.join('')).toContain('OLD-READY')

    // 没有新输出：不重复把同样的快照送去 Worker（切换历史→新输出后同一快照只匹配一次）
    await delay(120)
    const baseline = match.mock.calls.length
    await delay(150)
    expect(match.mock.calls.length).toBe(baseline)

    session.connector!.emit('data', 'NEW-READY\r\n')
    await vi.waitFor(() => expect(match.mock.calls.length).toBeGreaterThan(baseline))
    const latest = match.mock.calls[match.mock.calls.length - 1][0].inputs.join('')
    expect(latest).toContain('NEW-READY')
    expect(latest).not.toContain('OLD-READY')
    await pending
  })

  it('scope=recent 用最近输出作为基底（tail_until 语义）', async () => {
    const { manager, session } = await fixture()
    session.connector!.emit('data', 'line-1\r\nTarget line\r\n')
    const pending = manager.waitForPattern(session.id, { pattern: 'Target', scope: 'recent', historyLines: 20, timeoutMs: 150, pollMs: 25 })
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    expect(match.mock.calls[0][0].inputs.join('')).toContain('Target line')
    await pending
  })

  it('匹配超时错误原样上抛（RESOURCE_LIMIT/硬超时），不自动用同一表达式重试', async () => {
    const { manager } = await fixture()
    match.mockRejectedValueOnce(new PatternMatchError('MATCH_EXECUTION_TIMEOUT'))
    await expect(manager.waitForPattern('wait-pattern-case', { pattern: '^(a+)+$', timeoutMs: 500 }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', reason: 'MATCH_EXECUTION_TIMEOUT', retryDisposition: 'never' })
    expect(match).toHaveBeenCalledTimes(1)
  })

  it('断连返回 matched:false + reason=disconnected；迟到命中不被接受', async () => {
    const { manager, session } = await fixture()
    let release!: () => void
    match.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ matched: true, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' } as never)
    }))
    const pending = manager.waitForPattern(session.id, { pattern: 'READY', timeoutMs: 5000, pollMs: 25 })
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    await manager.disconnectSession(session.id)
    release()
    const result = await pending
    expect(result).toMatchObject({ matched: false, settled: false, reason: 'disconnected' })
  })

  it('清空/裁剪历史导致游标缺口时抛 OUTCOME_UNKNOWN，要求先对账', async () => {
    const { manager, session } = await fixture()
    session.connector!.emit('data', 'some output\r\n')
    const pending = manager.waitForPattern(session.id, { pattern: 'READY', timeoutMs: 5000, pollMs: 25 })
    // 先挂拒绝处理，避免未处理拒绝
    const outcome = pending.then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    session.outputBuffer!.clear()
    await expect(outcome).resolves.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
  })

  it('跨数据块：分两次到达的输出合起来才命中，不只看最后一块', async () => {
    const { manager, session } = await fixture()
    const matchImpl = async ({ inputs }: { inputs: string[] }) => ({
      matched: inputs.some(text => text.includes('foobar')),
      matchedIndex: 0,
      elapsedMs: 1,
      pattern: 'foobar',
      mode: 'regex' as const
    })
    match.mockImplementation(matchImpl as never)
    const pending = manager.waitForPattern(session.id, { pattern: 'foobar', timeoutMs: 2000, pollMs: 25 })
    session.connector!.emit('data', 'foo')
    await delay(60)
    session.connector!.emit('data', 'bar')
    const result = await pending
    expect(result).toMatchObject({ matched: true, reason: 'matched' })
    const lastInputs = match.mock.calls[match.mock.calls.length - 1][0].inputs.join('')
    expect(lastInputs).toContain('foobar')
  })

  it('历史被容量裁剪（earliest 越过起始游标）时抛 OUTCOME_UNKNOWN', async () => {
    const { manager, session } = await fixture()
    session.connector!.emit('data', 'before\r\n')
    const pending = manager.waitForPattern(session.id, { pattern: 'never', timeoutMs: 5000, pollMs: 25 })
    const outcome = pending.then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    // 超出 1MiB 缓冲后最旧数据被裁剪，起始游标已经不可读
    session.connector!.emit('data', 'x'.repeat(1_200_000))
    await expect(outcome).resolves.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
  })

  it('观测授权被撤销 → FORBIDDEN，且不再继续匹配', async () => {
    const { manager } = await fixture()
    const authorize = vi.fn(() => false)
    await expect(manager.waitForPattern('wait-pattern-case', { pattern: 'READY', timeoutMs: 1000, authorizeObservation: authorize }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(authorize).toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })
})

describe('sendAndWait：锁、编译验证与输入顺序', () => {
  it('编译阶段失败 → INVALID_ARGUMENT，不写终端，锁已释放可再次进入', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    compile.mockRejectedValueOnce(new PatternMatchError('INVALID_PATTERN'))

    await expect(manager.sendAndWait(session.id, { text: 'echo hi\n', control, waitForPattern: '(' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'INVALID_PATTERN' })
    expect(write).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
    expect(session.pendingWaitOwner).toBeUndefined()

    // 锁释放后可重入
    match.mockResolvedValueOnce({ matched: true, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' })
    const ok = await manager.sendAndWait(session.id, { text: 'echo hi\n', control, waitForPattern: 'hi', waitMs: 0, idleMs: 0, maxWaitMs: 2000 })
    expect(ok.patternMatched).toBe(true)
    expect(session.pendingWaitLock).toBe(false)
  })

  it('编译期间断连 → STALE_GENERATION，输入未发送', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const connector = session.connector!
    const write = vi.spyOn(connector, 'writeConfirmed')
    let release!: () => void
    compile.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ pattern: 'x', mode: 'regex' } as never)
    }))
    const pending = manager.sendAndWait(session.id, { text: 'rm -rf /tmp/x\n', control, waitForPattern: 'x', waitMs: 100, maxWaitMs: 500 })
    await vi.waitFor(() => expect(compile).toHaveBeenCalled())
    await manager.disconnectSession(session.id)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect(write).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
  })

  it('同一会话并发 sendAndWait 被拒绝；先写完输入再匹配输出', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const order: string[] = []
    vi.spyOn(session.connector!, 'writeConfirmed').mockImplementation(async () => { order.push('write') })
    match.mockImplementation(async () => {
      order.push('match')
      return { matched: true, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' } as never
    })
    let release!: () => void
    compile.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ pattern: 'x', mode: 'regex' } as never)
    }))

    const first = manager.sendAndWait(session.id, { text: 'ls\n', control, waitForPattern: 'x', waitMs: 0, idleMs: 0 })
    await vi.waitFor(() => expect(compile).toHaveBeenCalled())
    await expect(manager.sendAndWait(session.id, { text: 'ls\n', control, waitForPattern: 'x' }))
      .rejects.toMatchObject({ code: 'CONTROL_CONFLICT' })
    release()
    const result = await first
    expect(result.patternMatched).toBe(true)
    expect(order[0]).toBe('write')
    expect(order).toContain('match')
    expect(session.pendingWaitLock).toBe(false)
  })

  it('默认按 regex 匹配，并透传 waitForPatternMode=literal', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    match.mockResolvedValue({ matched: true, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' } as never)
    await manager.sendAndWait(session.id, { text: '', autoNewline: false, control, waitForPattern: 'a.b', waitMs: 0, idleMs: 0 })
    // 默认模式是 regex（validate 归一化后交给 Worker 的 spec 带 mode:'regex'）
    expect(validate.mock.calls.at(-1)![0]).toMatchObject({ pattern: 'a.b' })
    expect(compile.mock.calls.at(-1)![0]).toMatchObject({ pattern: 'a.b', mode: 'regex' })
    await manager.sendAndWait(session.id, { text: '', autoNewline: false, control, waitForPattern: 'a.b', waitForPatternMode: 'literal', waitMs: 0, idleMs: 0 })
    expect(compile.mock.calls.at(-1)![0]).toMatchObject({ pattern: 'a.b', mode: 'literal' })
  })

  it('编译期间控制权被别的调用方接管 → CONTROL_CONFLICT，输入未发送', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    let release!: () => void
    compile.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ pattern: 'x', mode: 'regex' } as never)
    }))
    const pending = manager.sendAndWait(session.id, { text: 'reboot\n', control, waitForPattern: 'x', waitMs: 100, maxWaitMs: 500 })
    await vi.waitFor(() => expect(compile).toHaveBeenCalled())
    const takeover = await manager.acquireInput(session.id, { principalId: 'gui:2', source: 'gui' }, { takeover: true })
    expect(takeover.principalId).toBe('gui:2')
    release()
    await expect(pending).rejects.toMatchObject({ code: 'CONTROL_CONFLICT' })
    expect(write).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
  })

  it('输入已发送后观测被中断 → OUTCOME_UNKNOWN（reconcile-first）而不是返回成功', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    match.mockResolvedValue({ matched: false, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' } as never)
    const pending = manager.sendAndWait(session.id, { text: 'sleep 5\n', control, waitForPattern: 'never', waitMs: 50, maxWaitMs: 8000 })
    const outcome = pending.then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    // 连接实例没换、状态掉线：属于"输入已发出但观测失败"，必须是 OUTCOME_UNKNOWN 而不是成功/重试安全。
    session.status = ConnectionStatus.DISCONNECTED
    await expect(outcome).resolves.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    expect(session.pendingWaitLock).toBe(false)
  })
})

describe('R1 定点修正：参数形态、期限、未知结果与等待器配额', () => {
  it('assertInput 的 await 耗尽总期限时不写入终端，锁和等待器租约照常释放', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const original = manager.inputControl.assertInput.bind(manager.inputControl)
    const assertion = vi.spyOn(manager.inputControl, 'assertInput').mockImplementationOnce(async handle => {
      await delay(180)
      return original(handle)
    })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    await expect(manager.sendAndWait(session.id, {
      text: 'reboot\n', control, waitForPattern: 'ready', maxWaitMs: 100, waitMs: 0, idleMs: 0
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', reason: 'MATCH_QUEUE_TIMEOUT', retryDisposition: 'safe' })
    expect(assertion).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
    expect(session.pendingWaitOwner).toBeUndefined()
    const lease = vi.mocked(patternMatcher.acquireWaiter).mock.results[0].value
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it('只读匹配的排队总期限耗尽是正常 timeout，独立硬超时仍由原用例保护', async () => {
    const { manager, session } = await fixture()
    match.mockImplementationOnce(async () => {
      await delay(140)
      throw new PatternMatchError('MATCH_QUEUE_TIMEOUT')
    })
    const result = await manager.waitForPattern(session.id, { pattern: 'never', timeoutMs: 100, idleMs: 0, pollMs: 25 })
    expect(result).toMatchObject({ matched: false, settled: false, reason: 'timeout' })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
    expect(match).toHaveBeenCalledOnce()
    const lease = vi.mocked(patternMatcher.acquireWaiter).mock.results[0].value
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it('空 text 且不补换行没有输入副作用，matcher 失败保留原始错误而非 OUTCOME_UNKNOWN', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    match.mockRejectedValueOnce(new PatternMatchError('MATCH_EXECUTION_TIMEOUT'))
    await expect(manager.sendAndWait(session.id, {
      text: '', autoNewline: false, control, waitForPattern: 'never', maxWaitMs: 1000, waitMs: 0, idleMs: 0
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', reason: 'MATCH_EXECUTION_TIMEOUT', retryDisposition: 'never' })
    expect(write).not.toHaveBeenCalled()
    expect(match).toHaveBeenCalledOnce()
    expect(session.pendingWaitLock).toBe(false)
    expect(session.pendingWaitOwner).toBeUndefined()
  })

  it('非 string 的 pattern 是参数错误，不能被当成「未提供」继续发送输入', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    await expect(manager.sendAndWait(session.id, { text: 'echo hi\n', control, waitForPattern: 42 as never }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'PATTERN_NOT_A_STRING' })
    await expect(manager.waitForPattern(session.id, { pattern: null as never }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'PATTERN_NOT_A_STRING' })
    expect(write).not.toHaveBeenCalled()
    expect(compile).not.toHaveBeenCalled()
    // 参数错误发生在取锁之前：锁从未被占用。
    expect(session.pendingWaitLock).toBeFalsy()
  })

  it('编译消耗掉总期限时不得发送输入（无副作用，可按安全重试上报）', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    compile.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve({ pattern: 'x', mode: 'regex' } as never), 250)
    }))
    await expect(manager.sendAndWait(session.id, { text: 'reboot\n', control, waitForPattern: 'x', maxWaitMs: 150 }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', reason: 'MATCH_QUEUE_TIMEOUT', retryDisposition: 'safe' })
    expect(write).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
    expect(session.pendingWaitOwner).toBeUndefined()
  })

  it('输入已发出后 matcher 硬超时 → OUTCOME_UNKNOWN（reconcile-first）并保留固定 reason', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    match.mockRejectedValueOnce(new PatternMatchError('MATCH_EXECUTION_TIMEOUT'))
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    await expect(manager.sendAndWait(session.id, { text: 'yes\n', control, waitForPattern: '^(a+)+$', maxWaitMs: 2000 }))
      .rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', reason: 'MATCH_EXECUTION_TIMEOUT', retryDisposition: 'reconcile-first' })
    expect(write).toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
  })

  it('历史预检命中时返回真正被匹配的快照，而不是空的新输出', async () => {
    const { manager, session } = await fixture()
    session.connector!.emit('data', 'old banner\r\nuser@host:~$ ')
    match.mockResolvedValue({ matched: true, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' } as never)
    const result = await manager.waitForPattern(session.id, {
      pattern: 'user@host',
      mode: 'literal',
      checkHistoryFirst: true,
      timeoutMs: 1000
    })
    expect(result).toMatchObject({ matched: true, reason: 'matched' })
    expect(result.output).toContain('user@host')
    expect(result.cleanOutput).toContain('user@host')
    expect(result.output.length).toBeGreaterThan(0)
  })

  it('等待器租约覆盖整个等待调用（compile 之后的长等待仍占配额），finally 释放', async () => {
    const { manager, session } = await fixture()
    const acquireWaiter = vi.mocked(patternMatcher.acquireWaiter)
    const pending = manager.waitForPattern(session.id, { pattern: 'never', timeoutMs: 250, pollMs: 25 })
    await vi.waitFor(() => expect(match).toHaveBeenCalled())
    // 同一快照不会重复匹配；跨越多轮轮询后仍然只持有一份等待器租约（不是每次 match 各占一份）。
    await delay(120)
    expect(acquireWaiter).toHaveBeenCalledTimes(1)
    const lease = acquireWaiter.mock.results[0].value as { release: ReturnType<typeof vi.fn> }
    expect(lease.release).not.toHaveBeenCalled()
    await pending
    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it('sendAndWait 同样只取一份等待器租约，且异常路径也会释放', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    const acquireWaiter = vi.mocked(patternMatcher.acquireWaiter)
    compile.mockRejectedValueOnce(new PatternMatchError('INVALID_PATTERN'))
    await expect(manager.sendAndWait(session.id, { text: 'echo hi\n', control, waitForPattern: '(' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(acquireWaiter).toHaveBeenCalledTimes(1)
    const lease = acquireWaiter.mock.results[0].value as { release: ReturnType<typeof vi.fn> }
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(session.pendingWaitLock).toBe(false)
  })

  it('未命中结果返回后授权被撤销 → 只读等待报 FORBIDDEN 而不是正常超时', async () => {
    const { manager, session } = await fixture()
    let authorize = true
    match.mockImplementation(async () => {
      // 第一次匹配返回未命中，并在返回后撤销授权。
      authorize = false
      return { matched: false, matchedIndex: 0, elapsedMs: 1, pattern: 'x', mode: 'regex' } as never
    })
    await expect(manager.waitForPattern(session.id, { pattern: 'never', timeoutMs: 2000, authorizeObservation: () => authorize }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('复审回归：输入派发前取消', () => {
  it('没有 pattern 且调用前已取消时不发送输入', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:abort', source: 'gui' })
    const controller = new AbortController()
    controller.abort()
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    await expect(manager.sendAndWait(session.id, { text: 'reboot\n', control, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', reason: 'MATCH_CANCELLED', retryDisposition: 'safe' })
    expect(write).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBeFalsy()
  })

  it('控制权复核的 await 期间取消后不发送输入，并释放锁和配额', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:abort', source: 'gui' })
    const controller = new AbortController()
    const original = manager.inputControl.assertInput.bind(manager.inputControl)
    vi.spyOn(manager.inputControl, 'assertInput').mockImplementationOnce(async handle => {
      controller.abort()
      return original(handle)
    })
    const write = vi.spyOn(session.connector!, 'writeConfirmed')
    await expect(manager.sendAndWait(session.id, { text: 'reboot\n', control, signal: controller.signal }))
      .rejects.toMatchObject({ reason: 'MATCH_CANCELLED', retryDisposition: 'safe' })
    expect(write).not.toHaveBeenCalled()
    expect(session.pendingWaitLock).toBe(false)
    expect(vi.mocked(patternMatcher.acquireWaiter).mock.results[0].value.release).toHaveBeenCalledOnce()
  })

  it('输入队列等待期间取消后不发送排队输入', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:abort', source: 'gui' })
    const controller = new AbortController()
    let unblock!: () => void
    const write = vi.spyOn(session.connector!, 'writeConfirmed').mockImplementationOnce(() => new Promise<void>(resolve => { unblock = resolve }))
    const enqueue = vi.spyOn(manager, 'writeToSession')
    const first = manager.writeToSession(session.id, 'first\n', control)
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    const pending = manager.sendAndWait(session.id, { text: 'reboot\n', control, signal: controller.signal })
    const outcome = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2))
    controller.abort()
    unblock()
    await first
    await expect(outcome).resolves.toMatchObject({ reason: 'MATCH_CANCELLED', retryDisposition: 'safe' })
    expect(write).toHaveBeenCalledOnce()
    expect(session.pendingWaitLock).toBe(false)
  })

  it('已确认首片后取消不会发送下一片，结果仍要求对账', async () => {
    const { manager, session } = await fixture()
    const control = await manager.acquireInput(session.id, { principalId: 'gui:abort', source: 'gui' })
    const controller = new AbortController()
    const write = vi.spyOn(session.connector!, 'writeConfirmed').mockImplementationOnce(async () => { controller.abort() })
    await expect(manager.sendAndWait(session.id, { text: 'x'.repeat(40 * 1024), control, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    expect(write).toHaveBeenCalledOnce()
    expect(session.pendingWaitLock).toBe(false)
  })
})
