/**
 * R1 验收：外部正则匹配必须在可终止的子进程/Worker 中完成，且测试运行器本身不会被拖死。
 *
 * 本文件用**外部看门狗**跑一个独立的 Node 子进程：子进程里加载真实 `pattern-matcher` +
 * 真实 `pattern-worker` 源码打包产物，执行已知灾难性回溯场景。看门狗负责在超时后强杀
 * 子进程树并让测试失败，因此即使隔离开关失效、整条匹配被卡住，测试也会结束而不是挂起。
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PATTERN_SOURCE_DIR,
  buildPatternWorkerBundle,
  buildProbeBundle
} from './pattern-test-support'

const WATCHDOG_TIMEOUT_MS = 12000

const HOSTILE_PROBE = `
import { writeFileSync } from 'node:fs'
import { PatternMatcher } from './pattern-matcher'

const script = process.env.LYSHELL_PATTERN_WORKER_SCRIPT || ''
const reportPath = process.argv[2] || ''
const startedAt = Date.now()

async function main(): Promise<number> {
  const matcher = new PatternMatcher({ workerScriptPath: script })
  try {
    const result = await matcher.match({
      spec: { pattern: '^(a+)+$' },
      inputs: ['a'.repeat(28) + '!'],
      callerKey: 'watchdog',
      timeoutMs: 2000
    })
    writeFileSync(reportPath, JSON.stringify({ verdict: 'UNEXPECTED_MATCH', matched: result.matched, elapsedMs: Date.now() - startedAt }))
    return 2
  } catch (error) {
    const shaped = error as { reason?: string; code?: string }
    writeFileSync(reportPath, JSON.stringify({
      verdict: 'REJECTED',
      reason: shaped.reason,
      code: shaped.code,
      elapsedMs: Date.now() - startedAt
    }))
    return shaped.reason === 'MATCH_EXECUTION_TIMEOUT' ? 0 : 3
  } finally {
    await matcher.shutdown()
  }
}

main().then(code => process.exit(code), () => process.exit(4))
`

interface WatchdogOutcome {
  readonly code: number | null
  readonly watchdogFired: boolean
  readonly wallMs: number
}

/** 外部看门狗：子进程超时未退出就强杀整棵进程树，断言不会因为匹配卡住而无限等待。 */
function runWithWatchdog(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<WatchdogOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: 'ignore',
      windowsHide: true
    })
    let watchdogFired = false
    const timer = setTimeout(() => {
      watchdogFired = true
      if (child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
    }, WATCHDOG_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ code, watchdogFired, wallMs: Date.now() - startedAt })
    })
  })
}

describe('隔离验收：外部正则永不进入主线程', () => {
  it('29 字符已知灾难性回溯场景在隔离 Worker 内被 100ms 硬超时终止，看门狗未触发', async () => {
    const workerPath = await buildPatternWorkerBundle()
    const probePath = await buildProbeBundle('pattern-hostile-probe', HOSTILE_PROBE)
    const reportPath = join(tmpdir(), `r1-isolation-probe-${process.pid}.json`)

    const outcome = await runWithWatchdog(probePath, [reportPath], {
      ...process.env,
      LYSHELL_PATTERN_WORKER_SCRIPT: workerPath
    })

    expect(outcome.watchdogFired).toBe(false)
    expect(outcome.code).toBe(0)
    expect(outcome.wallMs).toBeLessThan(WATCHDOG_TIMEOUT_MS)

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      verdict: string
      reason?: string
      code?: string
      elapsedMs: number
    }
    expect(report.verdict).toBe('REJECTED')
    expect(report.reason).toBe('MATCH_EXECUTION_TIMEOUT')
    expect(report.code).toBe('RESOURCE_LIMIT')
    expect(report.elapsedMs).toBeLessThan(5000)
  }, 60000)

  it('外部 pattern 只在 pattern-worker.ts 里编译；session-manager 与 HTTP 入口不再同步构造正则', () => {
    const read = (relative: string): string => readFileSync(join(PATTERN_SOURCE_DIR, relative), 'utf8')
    const workerSource = read('pattern-worker.ts')
    expect(workerSource).toContain('new RegExp(')

    // 这两个文件分别承载 sendAndWait / wait_for_prompt / tail_until 入口，必须没有动态正则构造。
    for (const relative of ['session-manager.ts', '../mcp/http-server.ts']) {
      const source = read(relative)
      expect(source, relative).not.toContain('new RegExp(')
    }
  })
})
