import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { PatternMatcher, patternMatcher as sharedMatcher, stopPatternMatcher } from './pattern-matcher'
import { BUILTIN_PROMPT_PATTERN, PatternMatchError } from './pattern-contract'
import { buildPatternWorkerBundle, writeTemporaryScript } from './pattern-test-support'

const matchers: PatternMatcher[] = []
function register(matcher: PatternMatcher): PatternMatcher {
  matchers.push(matcher)
  return matcher
}

let realWorker = ''
beforeAll(async () => {
  realWorker = await buildPatternWorkerBundle()
}, 120000)

afterAll(async () => {
  for (const matcher of matchers.splice(0)) await matcher.shutdown()
})

/** 捕获拒绝原因，避免未处理拒绝提示。 */
async function rejection(promise: Promise<unknown>): Promise<PatternMatchError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PatternMatchError)
    return error as PatternMatchError
  }
  throw new Error('expected the match to be rejected')
}

/** 终止后槽位要等 Worker 退出确认才释放，因此断言计数归零需要轮询等待。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * 可控时序的 Worker：回包延迟由 pattern 前缀 `HOLD<ms>` 决定，`FAIL` / `INVALID` 回 error 帧。
 * 用于排队、公平性与容量恢复这类需要确定时序的场景（正则语义用真实 Worker 验证）。
 */
const STUB_WORKER = `
const { parentPort, workerData } = require('worker_threads')
parentPort.postMessage({ type: 'ready', protocol: 1 })
parentPort.on('message', (request) => {
  if (!request || typeof request !== 'object') return
  const pattern = String(request.pattern || '')
  const delay = pattern.startsWith('HOLD') ? (Number(pattern.slice(4)) || 0) : 0
  setTimeout(() => {
    if (pattern === 'FAIL') {
      parentPort.postMessage({ type: 'error', jobId: request.jobId, generation: request.generation, reason: 'MATCH_WORKER_FAILED', message: 'boom' })
      return
    }
    if (pattern === 'INVALID') {
      parentPort.postMessage({ type: 'error', jobId: request.jobId, generation: request.generation, reason: 'INVALID_PATTERN', message: 'bad pattern' })
      return
    }
    parentPort.postMessage({ type: 'match', jobId: request.jobId, generation: request.generation, matched: true, matchedIndex: 0, elapsedMs: delay })
  }, delay)
})
`

function stubMatcher(limits: Record<string, number> = {}): PatternMatcher {
  const script = writeTemporaryScript('pattern-stub-worker', STUB_WORKER)
  return register(new PatternMatcher({
    workerScriptPath: script,
    limits: { matchDeadlineMs: 5000, workerStartDeadlineMs: 2000, defaultQueueTimeoutMs: 8000, ...limits }
  }))
}

describe('真实 Worker：匹配语义', () => {
  it('literal 模式按字面量匹配，正则元字符不生效', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: realWorker }))
    const spec = { pattern: 'a.b', mode: 'literal' as const }
    expect((await matcher.match({ spec, inputs: ['prefix a.b suffix'], callerKey: 'c1' })).matched).toBe(true)
    expect((await matcher.match({ spec, inputs: ['prefix axb suffix'], callerKey: 'c1' })).matched).toBe(false)
  })

  it('默认模式是 regex：内置提示符正则命中清洗后的提示符', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: realWorker }))
    const spec = { pattern: BUILTIN_PROMPT_PATTERN }
    expect((await matcher.match({ spec, inputs: ['$ '], callerKey: 'c1' })).matched).toBe(true)
    expect((await matcher.match({ spec, inputs: ['running\n'], callerKey: 'c1' })).matched).toBe(false)
  })

  it('合法复杂正则（含分组/量词/锚点）可用', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: realWorker }))
    const spec = { pattern: '^(?:foo|bar)\\s+\\d{2,4}$' }
    expect((await matcher.match({ spec, inputs: ['bar 42'], callerKey: 'c1' })).matched).toBe(true)
    expect((await matcher.match({ spec, inputs: ['foo 1x'], callerKey: 'c1' })).matched).toBe(false)
  })

  it('非法正则只在 Worker 内报错（INVALID_PATTERN），同步 validate 不编译', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: realWorker }))
    expect(() => matcher.validate({ pattern: '(' })).not.toThrow()
    const error = await rejection(matcher.compile({ pattern: '(' }, { callerKey: 'c1' }))
    expect(error).toMatchObject({ reason: 'INVALID_PATTERN', code: 'INVALID_ARGUMENT', retryDisposition: 'never' })
  })

  it('raw 与 ANSI 清洗基底分别匹配，返回命中的基底下标', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: realWorker }))
    const raw = '\u001b[32mREADY\u001b[0m'
    const clean = 'READY'
    const ansiSpec = { pattern: '\u001b\\[32mREADY' }
    expect((await matcher.match({ spec: ansiSpec, inputs: [raw, clean], callerKey: 'c1' })).matchedIndex).toBe(0)
    const anchored = { pattern: '^READY$' }
    expect((await matcher.match({ spec: anchored, inputs: [raw, clean], callerKey: 'c1' })).matchedIndex).toBe(1)
  })
})

describe('真实 Worker：灾难性回溯被隔离并硬超时', () => {
  it('29 字符已知回溯场景：主线程保持响应，匹配在 100ms 执行期限后被终止', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: realWorker }))
    const startedAt = Date.now()
    const pending = matcher.match({
      spec: { pattern: '^(a+)+$' },
      inputs: ['a'.repeat(28) + '!'],
      callerKey: 'hostile',
      timeoutMs: 2000
    })
    // 立刻挂上拒绝处理：硬超时可能比下面的心跳定时器更早触发。
    const outcome = pending.then(() => null, (error: unknown) => error)
    // 另一调用方（另一个槽位）在敌意匹配进行中仍能正常完成：池没有被一个正则堵死。
    const heartbeatStarted = Date.now()
    const heartbeat = matcher.match({ spec: { pattern: 'alive', mode: 'literal' }, inputs: ['still alive'], callerKey: 'heartbeat' })
    // 主线程心跳：如果正则在主线程执行，这个 20ms 定时器会被一起卡住。
    const timerDelay = await new Promise<number>(resolve => {
      setTimeout(() => resolve(Date.now() - startedAt), 20)
    })
    expect(timerDelay).toBeLessThan(150)
    expect((await heartbeat).matched).toBe(true)
    expect(Date.now() - heartbeatStarted).toBeLessThan(2000)

    const error = await outcome
    expect(error).toBeInstanceOf(PatternMatchError)
    expect(error).toMatchObject({ reason: 'MATCH_EXECUTION_TIMEOUT', code: 'RESOURCE_LIMIT', retryDisposition: 'never' })
    expect(Date.now() - startedAt).toBeLessThan(5000)
    // 超时先结算，容量要等 Worker 退出确认后才归还（heartbeat 的槽位仍在，属正常复用）。
    await waitFor(() => matcher.diagnostics().workers <= 1)
    expect(matcher.diagnostics()).toMatchObject({ timeouts: 1, terminations: 1 })

    // 容量恢复：终止旧 Worker 后新任务仍能成功（没有主线程回退，也没有永久降级）。
    const ok = await matcher.match({ spec: { pattern: 'OK', mode: 'literal' }, inputs: ['OK'], callerKey: 'hostile' })
    expect(ok.matched).toBe(true)
    expect(matcher.diagnostics().workers).toBeLessThanOrEqual(2)
  }, 30000)
})

describe('有界池：排队、配额与公平性', () => {
  it('每主体 waiter 上限（4）与全局上限（16）拒绝而不是无限排队；租约释放后配额恢复', async () => {
    const perCaller = stubMatcher({ maxWorkers: 1, maxWaitersPerCaller: 2 })
    const a1 = perCaller.acquireWaiter('A')
    const a2 = perCaller.acquireWaiter('A')
    // 配额按「整个等待调用」计：同一主体的第三份租约被拒绝，且没有产生任何匹配任务。
    let third: unknown
    try {
      perCaller.acquireWaiter('A')
    } catch (error) {
      third = error
    }
    expect(third).toMatchObject({ reason: 'MATCH_QUEUE_FULL', code: 'RESOURCE_LIMIT' })
    // 其他主体不受影响
    const b1 = perCaller.acquireWaiter('B')
    expect(perCaller.diagnostics()).toMatchObject({ waiters: 3, callers: 2, queued: 0 })
    for (const lease of [a1, a2, b1]) lease.release()
    expect(perCaller.diagnostics()).toMatchObject({ waiters: 0, callers: 0 })
    // 幂等释放不会重复扣减
    a1.release()
    expect(perCaller.diagnostics().waiters).toBe(0)

    const global = stubMatcher({ maxWorkers: 1, maxWaiters: 2 })
    const g1 = global.acquireWaiter('A')
    const g2 = global.acquireWaiter('B')
    let g3: unknown
    try {
      global.acquireWaiter('C')
    } catch (error) {
      g3 = error
    }
    expect(g3).toMatchObject({ reason: 'MATCH_QUEUE_FULL', code: 'RESOURCE_LIMIT' })
    g1.release()
    g2.release()
    expect(global.diagnostics().waiters).toBe(0)
  })

  it('预留输入预算：在途任务的快照占用会让后续超限任务被拒绝', async () => {
    const matcher = stubMatcher({ maxWorkers: 1, reservedInputChars: 100 })
    const held = matcher.match({ spec: { pattern: 'HOLD200' }, inputs: ['a'.repeat(60)], callerKey: 'A' })
    const over = await rejection(matcher.match({ spec: { pattern: 'x' }, inputs: ['b'.repeat(60)], callerKey: 'B' }))
    expect(over.reason).toBe('MATCH_INPUT_TOO_LARGE')
    await held
    expect(matcher.diagnostics().reservedChars).toBe(0)
  })

  it('同主体同时只允许一个在途任务：另一个主体先派发，不被排队饿死', async () => {
    const matcher = stubMatcher({ maxWorkers: 1 })
    const order: string[] = []
    const a1 = matcher.match({ spec: { pattern: 'HOLD250' }, inputs: ['x'], callerKey: 'A' }).then(() => order.push('A1'))
    const a2 = matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' }).then(() => order.push('A2'))
    const b1 = matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'B' }).then(() => order.push('B1'))
    await Promise.all([a1, a2, b1])
    expect(order).toEqual(['A1', 'B1', 'A2'])
  })
})

describe('有界池：失败、超时与恢复', () => {
  it('总期限先于匹配硬期限：在途 Worker 停止且未退出前不复用，输入预算也不提前归还', async () => {
    const matcher = stubMatcher({ maxWorkers: 1, matchDeadlineMs: 5000, workerExitDeadlineMs: 25 })
    // 先完成冷启动，使下面只测已派发任务的总期限，而不是 Worker 启动期限。
    await matcher.match({ spec: { pattern: 'warm' }, inputs: ['warm'], callerKey: 'warm' })
    const originalTerminate = Worker.prototype.terminate
    const originalSetTimeout = globalThis.setTimeout
    const stoppingWorkers: Worker[] = []
    let confirmTermination!: (code: number) => void
    const termination = new Promise<number>(resolve => { confirmTermination = resolve })
    const terminate = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      stoppingWorkers.push(this)
      return termination
    })
    const posts = vi.spyOn(Worker.prototype, 'postMessage')
    let timerCount = 0
    // 模拟执行看门狗回调被延迟，让先登记的总期限回调独立负责停止在途 Worker。
    // 不调用 matcher 私有方法；否则只验证 onExecDeadline 会掩盖总期限路径的复用缺陷。
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      timerCount++
      return originalSetTimeout(callback, timerCount === 2 ? 5000 : ms, ...args)
    })
    let released = false
    try {
      const firstInput = 'old-snapshot'
      const nextInput = 'new'
      const first = rejection(matcher.match({ spec: { pattern: 'HOLD5000' }, inputs: [firstInput], callerKey: 'A', timeoutMs: 150 }))
      const next = matcher.match({ spec: { pattern: 'next' }, inputs: [nextInput], callerKey: 'B', timeoutMs: 3000 })
      const nextOutcome = next.then(value => ({ value }), error => ({ error }))
      expect(await first).toMatchObject({ reason: 'MATCH_QUEUE_TIMEOUT', code: 'RESOURCE_LIMIT', retryDisposition: 'safe' })
      await waitFor(() => matcher.diagnostics().unavailableSlots === 1)
      expect(terminate).toHaveBeenCalledOnce()
      expect(posts).toHaveBeenCalledOnce()
      expect(posts.mock.calls[0][0]).toMatchObject({ pattern: 'HOLD5000' })
      expect(matcher.diagnostics()).toMatchObject({
        workers: 1, spawned: 1, queued: 1, inflight: 0,
        reservedChars: firstInput.length + nextInput.length, unavailableSlots: 1
      })
      expect(stoppingWorkers[0]).toBeDefined()
      const exitCode = await originalTerminate.call(stoppingWorkers[0])
      confirmTermination(exitCode)
      released = true
      timers.mockRestore()
      terminate.mockRestore()
      const outcome = await nextOutcome
      expect(outcome).toMatchObject({ value: { matched: true } })
      expect(posts).toHaveBeenCalledTimes(2)
      expect(posts.mock.calls[1][0]).toMatchObject({ pattern: 'next' })
      expect(matcher.diagnostics()).toMatchObject({ spawned: 2, workers: 1, queued: 0, reservedChars: 0, unavailableSlots: 0 })
    } finally {
      timers.mockRestore()
      terminate.mockRestore()
      posts.mockRestore()
      if (stoppingWorkers[0] && !released) confirmTermination(await originalTerminate.call(stoppingWorkers[0]))
      await matcher.shutdown()
    }
  }, 15000)

  it('Worker 回 error 帧 → MATCH_WORKER_FAILED，随后新任务仍可用（替换 Worker 而不是降级）', async () => {
    const matcher = stubMatcher()
    const error = await rejection(matcher.match({ spec: { pattern: 'FAIL' }, inputs: ['x'], callerKey: 'A' }))
    expect(error).toMatchObject({ reason: 'MATCH_WORKER_FAILED', code: 'RESOURCE_LIMIT' })
    const ok = await matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' })
    expect(ok.matched).toBe(true)
  })

  it('Worker 内非法正则 → INVALID_PATTERN，Worker 保持可用', async () => {
    const matcher = stubMatcher()
    const error = await rejection(matcher.match({ spec: { pattern: 'INVALID' }, inputs: ['x'], callerKey: 'A' }))
    expect(error.reason).toBe('INVALID_PATTERN')
    expect((await matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' })).matched).toBe(true)
  })

  it('回包超过执行期限 → 终止 Worker，迟到回包不会污染下一个任务', async () => {
    const matcher = stubMatcher({ matchDeadlineMs: 150, defaultQueueTimeoutMs: 5000 })
    const error = await rejection(matcher.match({ spec: { pattern: 'HOLD1000' }, inputs: ['x'], callerKey: 'A' }))
    expect(error.reason).toBe('MATCH_EXECUTION_TIMEOUT')
    expect(matcher.diagnostics().terminations).toBeGreaterThanOrEqual(1)
    const ok = await matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' })
    expect(ok.matched).toBe(true)
    expect(matcher.diagnostics()).toMatchObject({ waiters: 0, queued: 0, reservedChars: 0 })
  })

  it('Worker 脚本不存在 → 明确失败且不挂起、不留占用', async () => {
    const matcher = register(new PatternMatcher({ workerScriptPath: join(tmpdir(), `missing-pattern-worker-${process.pid}.cjs`) }))
    const error = await rejection(matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' }))
    expect(error.code).toBe('RESOURCE_LIMIT')
    expect(['MATCH_WORKER_START_FAILED', 'MATCH_WORKER_FAILED']).toContain(error.reason)
    await waitFor(() => matcher.diagnostics().workers === 0)
    expect(matcher.diagnostics().workers).toBe(0)
    // 池仍可服务（脚本修好后即可用），没有把"不可用"变成主线程回退。
    expect(matcher.diagnostics().closed).toBe(false)
  }, 20000)

  it('Worker 迟迟不 ready → MATCH_WORKER_START_FAILED 并终止该 Worker', async () => {
    const script = writeTemporaryScript('pattern-silent-worker', `
const { parentPort } = require('worker_threads')
parentPort.on('message', () => {})
`)
    const matcher = register(new PatternMatcher({
      workerScriptPath: script,
      limits: { workerStartDeadlineMs: 200, matchDeadlineMs: 5000, defaultQueueTimeoutMs: 5000 }
    }))
    const error = await rejection(matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' }))
    expect(error.reason).toBe('MATCH_WORKER_START_FAILED')
    await waitFor(() => matcher.diagnostics().workers === 0)
    expect(matcher.diagnostics().workers).toBe(0)
  }, 20000)
})

describe('有界池：shutdown', () => {
  it('拒绝新任务、终止在途任务、确认退出并清空计数', async () => {
    const matcher = stubMatcher({ maxWorkers: 1 })
    const inflight = matcher.match({ spec: { pattern: 'HOLD2000' }, inputs: ['x'], callerKey: 'A' })
    const queued = matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'B' })
    // 提前挂上拒绝处理，避免 shutdown 与断言之间出现未处理拒绝。
    const inflightOutcome = rejection(inflight)
    const queuedOutcome = rejection(queued)
    // 让在途任务真正派发出去、B 留在队列里
    await new Promise(resolve => setTimeout(resolve, 50))

    const shutdown = await matcher.shutdown()
    expect(shutdown.confirmedExits).toBeGreaterThanOrEqual(1)
    expect(shutdown.unconfirmedExits).toBe(0)
    const [inflightError, queuedError] = await Promise.all([inflightOutcome, queuedOutcome])
    expect(inflightError.reason).toBe('MATCH_SERVICE_SHUTDOWN')
    expect(queuedError.reason).toBe('MATCH_SERVICE_SHUTDOWN')

    const after = await rejection(matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' }))
    expect(after.reason).toBe('MATCH_SERVICE_SHUTDOWN')
    expect(matcher.diagnostics()).toMatchObject({ workers: 0, queued: 0, waiters: 0, reservedChars: 0, closed: true })
  }, 30000)

  it('stopPatternMatcher 关闭进程级单例（退出流程挂接点），且可重复调用', async () => {
    await expect(stopPatternMatcher()).resolves.toBeUndefined()
    const error = await rejection(sharedMatcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' }))
    expect(error.reason).toBe('MATCH_SERVICE_SHUTDOWN')
    // 幂等：重复调用不抛错，也不等待已清空的槽位
    await expect(stopPatternMatcher()).resolves.toBeUndefined()
    expect(sharedMatcher.diagnostics()).toMatchObject({ workers: 0, closed: true })
  })
})

describe('有界池：冷启动、终止重入与启动失败退避', () => {
  it('Worker 冷启动超过执行期限但仍在启动期限内 → 任务留在队列并最终成功', async () => {
    // ready 延迟 400ms：远大于 matchDeadlineMs(100)，但小于 workerStartDeadlineMs(2000)。
    const script = writeTemporaryScript('pattern-slow-ready-worker', `
const { parentPort } = require('worker_threads')
setTimeout(() => {
  parentPort.postMessage({ type: 'ready', protocol: 1 })
}, 400)
parentPort.on('message', (request) => {
  parentPort.postMessage({ type: 'match', jobId: request.jobId, generation: request.generation, matched: true, matchedIndex: 0, elapsedMs: 1 })
})
`)
    const matcher = register(new PatternMatcher({
      workerScriptPath: script,
      limits: { matchDeadlineMs: 100, workerStartDeadlineMs: 2000, defaultQueueTimeoutMs: 8000 }
    }))
    const result = await matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' })
    expect(result.matched).toBe(true)
    // 冷启动不计入执行期限：没有触发硬超时，也没有终止过 Worker。
    expect(matcher.diagnostics()).toMatchObject({ timeouts: 0, terminations: 0, startFailures: 0 })
  }, 20000)

  it('终止重入：超时后再 shutdown 不会重复 terminate/计数，迟到 exit 幂等', async () => {
    const matcher = stubMatcher({ maxWorkers: 1, matchDeadlineMs: 100, defaultQueueTimeoutMs: 5000 })
    const error = await rejection(matcher.match({ spec: { pattern: 'HOLD2000' }, inputs: ['abcd'], callerKey: 'A' }))
    expect(error.reason).toBe('MATCH_EXECUTION_TIMEOUT')
    expect(matcher.diagnostics().terminations).toBe(1)

    // 在终止仍在进行时 shutdown：同一槽位只应被终止一次，且只确认一次退出。
    const first = await matcher.shutdown()
    const second = await matcher.shutdown()
    expect(first.confirmedExits).toBe(1)
    expect(second.confirmedExits).toBe(0)
    expect(matcher.diagnostics().terminations).toBe(1)
    // 迟到 exit：再等一会儿，计数不再变化，容量与输入预算都已归零。
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(matcher.diagnostics()).toMatchObject({
      terminations: 1,
      workers: 0,
      queued: 0,
      waiters: 0,
      reservedChars: 0,
      unavailableSlots: 0
    })
  }, 20000)

  it('启动反复失败不会在排队期限内无界重建 Worker', async () => {
    const matcher = register(new PatternMatcher({
      workerScriptPath: join(tmpdir(), `missing-pattern-worker-${process.pid}-${Date.now()}.cjs`),
      limits: { workerStartDeadlineMs: 200, defaultQueueTimeoutMs: 5000 }
    }))
    const startedAt = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await rejection(matcher.match({ spec: { pattern: 'x' }, inputs: ['y'], callerKey: 'A' }))
      expect(error.code).toBe('RESOURCE_LIMIT')
      expect(['MATCH_WORKER_START_FAILED', 'MATCH_WORKER_FAILED']).toContain(error.reason)
    }
    // 三次调用最多各尝试一次启动；冷却期内不会持续重建。
    expect(matcher.diagnostics().spawned).toBeLessThanOrEqual(3)
    expect(matcher.diagnostics().startFailures).toBeGreaterThanOrEqual(1)
    expect(Date.now() - startedAt).toBeLessThan(5000)
  }, 20000)
})
