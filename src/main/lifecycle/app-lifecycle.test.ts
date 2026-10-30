import { describe, expect, it, vi } from 'vitest'
import {
  AppLifecycle,
  LifecycleRejectedError,
  SHUTDOWN_PREPARE_BUDGET_MS,
  SHUTDOWN_TOTAL_BUDGET_MS,
  type AppLifecycleOptions
} from './app-lifecycle'

const silentLogger = { info: (): void => {}, warn: (): void => {} }

function createLifecycle(options: AppLifecycleOptions = {}): AppLifecycle {
  return new AppLifecycle({ logger: silentLogger, ...options })
}

describe('业务 gate', () => {
  it('running 接受业务，draining 后拒绝并保留稳定错误码', async () => {
    const lifecycle = createLifecycle()
    expect(lifecycle.phase).toBe('running')
    expect(lifecycle.accepts()).toBe(true)
    await expect(lifecycle.runBusiness('ssh:connect', async () => 'connected')).resolves.toBe('connected')

    lifecycle.beginDrain('app-will-quit')
    expect(lifecycle.phase).toBe('draining')
    expect(lifecycle.accepts()).toBe(false)

    expect(() => lifecycle.assertAcceptsBusiness('session:input')).toThrow(LifecycleRejectedError)
    try {
      lifecycle.assertAcceptsBusiness('session:input')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'LIFECYCLE_REJECTED',
        operation: 'session:input',
        phase: 'draining'
      })
    }
    await expect(lifecycle.runBusiness('session:input', async () => 'never')).rejects.toMatchObject({
      code: 'LIFECYCLE_REJECTED'
    })
  })

  it('wrap 在 running 时透传参数，在 draining 时直接拒绝', async () => {
    const lifecycle = createLifecycle()
    const add = lifecycle.wrap('quick-command:run', (left: number, right: number) => left + right)
    await expect(add(2, 3)).resolves.toBe(5)

    lifecycle.beginDrain('quit')
    await expect(add(2, 3)).rejects.toMatchObject({ code: 'LIFECYCLE_REJECTED', operation: 'quick-command:run' })
  })

  it('内部清理令牌只在协调器作用域内有效，外部无法伪造', async () => {
    const lifecycle = createLifecycle()
    lifecycle.beginDrain('quit')
    expect(lifecycle.accepts()).toBe(false)
    // 同步作用域内放行
    expect(lifecycle.runInternalCleanup(() => lifecycle.accepts())).toBe(true)
    // 作用域结束后令牌不泄漏
    expect(lifecycle.accepts()).toBe(false)
    // 令牌随 await 传播（退出步骤是异步的）
    await expect(lifecycle.runInternalCleanup(async () => {
      await Promise.resolve()
      return lifecycle.accepts()
    })).resolves.toBe(true)
    expect(lifecycle.accepts()).toBe(false)
  })
})

describe('draining 与总期限', () => {
  it('beginDrain 幂等，重复退出不重新起算总期限', () => {
    let clock = 1000
    const lifecycle = createLifecycle({ totalBudgetMs: 5000, now: () => clock })
    expect(lifecycle.deadlineAt).toBeUndefined()

    const first = lifecycle.beginDrain('first')
    expect(first).toEqual({ startedAt: 1000, deadlineAt: 6000 })
    expect(lifecycle.deadlineAt).toBe(6000)

    clock = 4000
    const second = lifecycle.beginDrain('second')
    expect(second).toEqual(first)
    expect(lifecycle.deadlineAt).toBe(6000)
  })

  it('默认预算覆盖 prepareShutdown 与 final 等待', () => {
    const lifecycle = createLifecycle()
    const deadline = lifecycle.beginDrain('quit')
    expect(deadline.deadlineAt - deadline.startedAt).toBe(SHUTDOWN_TOTAL_BUDGET_MS)
    // revoke 不再有独立子预算：它只做同步撤权，等待统一放在 final 的总期限里。
    expect(SHUTDOWN_PREPARE_BUDGET_MS).toBeLessThan(SHUTDOWN_TOTAL_BUDGET_MS)
  })
})

describe('退出步骤编排', () => {
  it('按 prepare → revoke → final 执行，插件 release 期间 revoke 尚未开始', async () => {
    const lifecycle = createLifecycle({ totalBudgetMs: 5000, prepareBudgetMs: 500 })
    const order: string[] = []
    let revokeStarted = false

    lifecycle.registerStep('prepare', 'plugin-release', async () => {
      order.push('prepare:plugin-release')
      await new Promise(resolve => setTimeout(resolve, 20))
      // prepare 阶段（插件 release）必须仍持有 host token/HTTP：revoke 不能提前跑。
      if (revokeStarted) throw new Error('revoke ran before plugin release finished')
    })
    lifecycle.registerStep('revoke', 'mcp-http-stop', () => {
      revokeStarted = true
      order.push('revoke:mcp-http-stop')
    })
    lifecycle.registerStep('final', 'transfers', () => { order.push('final:transfers') })
    lifecycle.registerStep('final', 'terminals', () => { order.push('final:terminals') })

    const report = await lifecycle.runShutdown()
    expect(order[0]).toBe('prepare:plugin-release')
    expect(order[1]).toBe('revoke:mcp-http-stop')
    expect(order.slice(2).sort()).toEqual(['final:terminals', 'final:transfers'])
    expect(report.kind).toBe('stopped')
    expect(report.unconfirmed).toEqual([])
    expect(report.timedOut).toBe(false)
    expect(lifecycle.phase).toBe('stopped')
  })

  it('插件准备永久不返回时，prepare 预算耗尽后仍执行 revoke/final 并结束', async () => {
    const lifecycle = createLifecycle({ totalBudgetMs: 2000, prepareBudgetMs: 120 })
    const neverSettles = new Promise<void>(() => { /* 模拟 prepareShutdown 卡死 */ })
    let finalRan = false
    lifecycle.registerStep('prepare', 'plugin-release', () => neverSettles)
    lifecycle.registerStep('revoke', 'mcp-http-stop', () => { /* noop */ })
    lifecycle.registerStep('final', 'transfers', () => { finalRan = true })

    const started = Date.now()
    const report = await lifecycle.runShutdown()
    const elapsed = Date.now() - started

    expect(finalRan).toBe(true)
    expect(elapsed).toBeLessThan(2000)
    expect(report.unconfirmed).toContain('plugin-release')
    expect(report.outcomes.find(outcome => outcome.name === 'plugin-release')?.status).toBe('pending')
    expect(report.outcomes.find(outcome => outcome.name === 'transfers')?.status).toBe('completed')
    // 有步骤未确认时报告整体标记为超时，供下次启动保守恢复。
    expect(report.timedOut).toBe(true)
  })

  it('prepare 预算大于总期限时被裁到总期限，不会把退出无限推后', async () => {
    const lifecycle = createLifecycle({ totalBudgetMs: 80, prepareBudgetMs: 60_000 })
    lifecycle.registerStep('prepare', 'plugin-release', () => new Promise<void>(() => { /* never */ }))
    lifecycle.registerStep('final', 'transfers', () => { /* noop */ })

    const started = Date.now()
    const report = await lifecycle.runShutdown()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(report.unconfirmed).toContain('plugin-release')
    expect(report.elapsedMs).toBeLessThanOrEqual(report.budgetMs + 100)
  })

  it('单项失败只进入 unconfirmed，不阻断其他步骤', async () => {
    const lifecycle = createLifecycle()
    lifecycle.registerStep('prepare', 'plugin-release', () => { throw new Error('release failed') })
    lifecycle.registerStep('revoke', 'mcp-http-stop', () => { /* noop */ })
    lifecycle.registerStep('final', 'transfers', () => { /* noop */ })

    const report = await lifecycle.runShutdown()
    expect(report.unconfirmed).toEqual(['plugin-release'])
    expect(report.outcomes.filter(outcome => outcome.status === 'completed').map(outcome => outcome.name))
      .toEqual(['mcp-http-stop', 'transfers'])
  })

  it('重复调用 runShutdown 复用同一计划，不重复执行清理', async () => {
    const lifecycle = createLifecycle()
    const archive = vi.fn()
    lifecycle.registerStep('final', 'archive', archive)

    const [first, second] = await Promise.all([lifecycle.runShutdown(), lifecycle.runShutdown()])
    expect(archive).toHaveBeenCalledOnce()
    expect(first).toBe(second)

    const third = await lifecycle.runShutdown()
    expect(third).toBe(first)
    expect(archive).toHaveBeenCalledOnce()
  })

  it('日志失败不阻断退出编排', async () => {
    const lifecycle = new AppLifecycle({
      logger: {
        info: () => { throw new Error('log down') },
        warn: () => { throw new Error('log down') }
      }
    })
    lifecycle.registerStep('final', 'archive', () => { /* noop */ })
    await expect(lifecycle.runShutdown()).resolves.toMatchObject({ kind: 'stopped', unconfirmed: [] })
  })

  it('禁止在退出计划开始后注册步骤，重复名与未知阶段直接报错', async () => {
    const lifecycle = createLifecycle()
    expect(() => lifecycle.registerStep('final', 'dup', () => { /* noop */ })).not.toThrow()
    expect(() => lifecycle.registerStep('final', 'dup', () => { /* noop */ })).toThrow(/Duplicate shutdown step name/)
    expect(() => lifecycle.registerStep('nope' as never, 'unknown', () => { /* noop */ })).toThrow(/Unknown shutdown step kind/)

    const unregister = lifecycle.registerStep('final', 'removed', () => { /* noop */ })
    unregister()
    expect(() => lifecycle.registerStep('final', 'removed', () => { /* noop */ })).not.toThrow()

    await lifecycle.runShutdown()
    expect(() => lifecycle.registerStep('final', 'late', () => { /* noop */ })).toThrow(/after the shutdown plan started/)
  })

  it('revoke 只同步发起停止：活跃 HTTP 停止挂起不阻挡后续撤权', async () => {
    const lifecycle = createLifecycle({ totalBudgetMs: 150, prepareBudgetMs: 50 })
    const order: string[] = []
    // 模拟 server.close 被活跃请求挂起：revoke 只能登记 Promise，绝不 await。
    const hangingHttpStop = new Promise<void>(() => { /* 永不落定 */ })

    lifecycle.registerStep('revoke', 'mcp-http-stop', () => { order.push('mcp-http-stop') })
    lifecycle.registerStep('revoke', 'pattern-matcher', () => { order.push('pattern-matcher') })
    lifecycle.registerStep('revoke', 'plugin-host-stop', () => { order.push('plugin-host-stop') })
    lifecycle.registerStep('revoke', 'audit-write-barrier', () => { order.push('audit-write-barrier') })
    lifecycle.registerStep('final', 'mcp-http-stop-wait', () => hangingHttpStop)

    const started = Date.now()
    const report = await lifecycle.runShutdown()
    expect(Date.now() - started).toBeLessThan(2000)
    // 所有必要撤权都执行了，没有被挂起的停服挡住。
    expect(order).toEqual(['mcp-http-stop', 'pattern-matcher', 'plugin-host-stop', 'audit-write-barrier'])
    expect(report.outcomes.find(outcome => outcome.name === 'mcp-http-stop')?.status).toBe('completed')
    // 未落定的等待在 final 里如实记为未确认。
    expect(report.unconfirmed).toContain('mcp-http-stop-wait')
  })

  it('revoke 步骤返回 Promise 记为失败且不等待（完成应登记到 final）', async () => {
    const lifecycle = createLifecycle()
    const hanging = new Promise<void>(() => { /* 永不落定 */ })
    lifecycle.registerStep('revoke', 'mcp-http-stop', () => hanging)

    const started = Date.now()
    const report = await lifecycle.runShutdown()
    expect(Date.now() - started).toBeLessThan(1000)
    const outcome = report.outcomes.find(item => item.name === 'mcp-http-stop')
    expect(outcome?.status).toBe('failed')
    expect(outcome?.error).toMatch(/returned a promise/)
    expect(report.unconfirmed).toContain('mcp-http-stop')
  })
})

describe('致命状态', () => {
  it('fatal 后拒绝所有新业务，且不执行正常退出清理', async () => {
    const lifecycle = createLifecycle()
    const archive = vi.fn()
    lifecycle.registerStep('final', 'archive', archive)
    lifecycle.enterFatal('uncaughtException Error: boom')

    expect(lifecycle.phase).toBe('fatal')
    expect(lifecycle.accepts()).toBe(false)
    expect(lifecycle.fatalReason).toBe('uncaughtException Error: boom')
    expect(() => lifecycle.assertAcceptsBusiness('ipc:invoke')).toThrow(/fatal state/)

    const report = await lifecycle.runShutdown()
    expect(report.kind).toBe('fatal')
    expect(report.outcomes).toEqual([])
    expect(archive).not.toHaveBeenCalled()
    expect(lifecycle.phase).toBe('fatal')
  })

  it('fatal 原因定长，避免把整段堆栈写入状态', () => {
    const lifecycle = createLifecycle()
    lifecycle.enterFatal('x'.repeat(1000))
    expect(lifecycle.fatalReason).toHaveLength(300)
  })

  it('draining 期间进入 fatal 会立即关闭业务入口', () => {
    const lifecycle = createLifecycle()
    lifecycle.beginDrain('quit')
    expect(lifecycle.accepts()).toBe(false)
    lifecycle.enterFatal('unhandledRejection Error: disk full')
    expect(lifecycle.phase).toBe('fatal')
    expect(lifecycle.accepts()).toBe(false)
  })

  it('内部 cleanup 作用域内进入 fatal 后同样拒绝业务', () => {
    const lifecycle = createLifecycle()
    lifecycle.beginDrain('quit')
    expect(lifecycle.runInternalCleanup(() => lifecycle.accepts())).toBe(true)

    const afterFatal = lifecycle.runInternalCleanup(() => {
      lifecycle.enterFatal('uncaughtException Error: boom')
      return lifecycle.accepts()
    })
    expect(afterFatal).toBe(false)
    expect(lifecycle.accepts()).toBe(false)
  })

  it('正常退出途中进入 fatal：报告为 fatal 且状态不被覆盖回 stopped', async () => {
    const lifecycle = createLifecycle()
    lifecycle.registerStep('final', 'archive', () => {
      lifecycle.enterFatal('uncaughtException Error: mid-shutdown')
    })

    const report = await lifecycle.runShutdown()
    expect(report.kind).toBe('fatal')
    expect(lifecycle.phase).toBe('fatal')
  })
})
