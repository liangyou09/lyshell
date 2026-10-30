import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FATAL_EXIT_CODE,
  FATAL_MESSAGE_MAX,
  FATAL_REPORT_MAX_CHARS,
  buildFatalReport,
  createFatalHandlers,
  redactDiagnosticText,
  serializeFatalReport,
  type FatalReport
} from './fatal-error'
import type { LifecyclePhase } from './app-lifecycle'

const tempRoots: string[] = []

function createTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'lyshell-fatal-'))) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`)
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('致命诊断脱敏与定长', () => {
  it('替换 token/password/Bearer 等凭据片段', () => {
    expect(redactDiagnosticText('connect failed token=secret-123')).toBe('connect failed token=[redacted]')
    expect(redactDiagnosticText('password: "hunter2" rejected')).toBe('password: [redacted] rejected')
    expect(redactDiagnosticText('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]')
    expect(redactDiagnosticText('authorization: Basic dXNlcjpwYXNz')).toBe('authorization: Basic [redacted]')
    expect(redactDiagnosticText('retry with Bearer abcdefghijklmnop')).toBe('retry with Bearer [redacted]')
    expect(redactDiagnosticText('api_key = sk-live-12345')).toBe('api_key = [redacted]')
  })

  it('消息与堆栈截断，凭据不进入报告', () => {
    const error = new Error(`x token=super-secret ${'y'.repeat(FATAL_MESSAGE_MAX * 2)}`)
    error.stack = `Error: boom\n${'z'.repeat(10_000)}`
    const report = buildFatalReport(error, 'uncaughtException', { now: () => 123, phase: 'draining', pid: 42 })
    expect(report.kind).toBe('fatal')
    expect(report.at).toBe(123)
    expect(report.source).toBe('uncaughtException')
    expect(report.phase).toBe('draining')
    expect(report.pid).toBe(42)
    expect(report.message).not.toContain('super-secret')
    expect(report.message).toContain('[redacted]')
    expect(report.message.length).toBeLessThanOrEqual(FATAL_MESSAGE_MAX + 32)
    expect(report.stack?.length).toBeLessThanOrEqual(4_096 + 32)
  })

  it('非 Error 值也能生成有界报告', () => {
    const stringReport = buildFatalReport('plain failure token=abc', 'unhandledRejection')
    expect(stringReport.name).toBe('NonErrorValue')
    expect(stringReport.message).toBe('plain failure token=[redacted]')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => buildFatalReport(circular, 'unhandledRejection')).not.toThrow()

    expect(buildFatalReport(undefined, 'uncaughtException').message).toBe('undefined')
  })

  it('未知 rejection 对象绝不触发 toJSON，只给固定类型标签', () => {
    let toJSONCalled = false
    const value = {
      toJSON(): string {
        toJSONCalled = true
        throw new Error('toJSON must not run')
      }
    }
    const report = buildFatalReport(value, 'unhandledRejection')
    expect(toJSONCalled).toBe(false)
    expect(report.name).toBe('NonErrorValue')
    expect(report.message).toBe('[object]')
    expect(JSON.stringify(report)).not.toContain('toJSON')
  })

  it('超长字符串先限长再脱敏，截断之外的凭据不会被处理', () => {
    const padding = 'a'.repeat(FATAL_MESSAGE_MAX * 2)
    const report = buildFatalReport(`${padding} token=late-secret`, 'uncaughtException')
    expect(report.message.length).toBeLessThanOrEqual(FATAL_MESSAGE_MAX + 32)
    expect(report.message).not.toContain('late-secret')
    // 截断发生在脱敏之前：扫描量有界，不会对超大文本跑无界正则。
    expect(report.message.startsWith('a'.repeat(100))).toBe(true)
  })

  it('Error getter 抛错时仍生成报告（属性读取有界且不抛出）', () => {
    const error = new Error('boom')
    Object.defineProperty(error, 'message', {
      configurable: true,
      get(): string {
        throw new Error('getter exploded')
      }
    })
    const report = buildFatalReport(error, 'uncaughtException')
    expect(report.name).toBe('Error')
    expect(report.message).toBe('Error')
  })

  it('序列化超限时先丢堆栈再截消息，始终是定长单行 JSON', () => {
    const report: FatalReport = {
      kind: 'fatal', at: 1, source: 'uncaughtException', phase: 'running', pid: 1,
      name: 'Error', message: 'm'.repeat(FATAL_MESSAGE_MAX), stack: 's'.repeat(8_000)
    }
    const json = serializeFatalReport(report)
    expect(json.length).toBeLessThanOrEqual(FATAL_REPORT_MAX_CHARS)
    expect(JSON.parse(json).stack).toBeUndefined()
    expect(JSON.parse(json).message.length).toBeLessThanOrEqual(FATAL_MESSAGE_MAX)
  })
})

function createHarness(overrides: { phase?: LifecyclePhase; persistThrows?: boolean; logThrows?: boolean } = {}) {
  const phase = overrides.phase ?? 'running'
  const order: string[] = []
  const enterFatal = vi.fn()
  const persist = vi.fn((_report: FatalReport) => {
    order.push('persist')
    if (overrides.persistThrows) throw new Error('disk full')
  })
  const log = vi.fn((_report: FatalReport) => {
    order.push('log')
    if (overrides.logThrows) throw new Error('log sink failed')
  })
  const exit = vi.fn((_code: number) => { order.push('exit') })
  const handlers = createFatalHandlers({
    lifecycle: { enterFatal, phase },
    persist,
    log,
    onFatalSync: [() => { order.push('sync') }],
    exit
  })
  return { handlers, enterFatal, persist, log, exit, order }
}

describe('致命处理器', () => {
  it('按 fatal → persist → log → 同步失效 → 退出的顺序执行一次', () => {
    const harness = createHarness()
    harness.handlers.handle(new Error('boom'), 'uncaughtException')
    expect(harness.enterFatal).toHaveBeenCalledOnce()
    expect(harness.persist).toHaveBeenCalledOnce()
    expect(harness.log).toHaveBeenCalledOnce()
    expect(harness.exit).toHaveBeenCalledWith(FATAL_EXIT_CODE)
    expect(harness.order).toEqual(['persist', 'log', 'sync', 'exit'])
  })

  it('幂等：诊断路径重入或重复异常不会重复落盘/退出', () => {
    const harness = createHarness()
    harness.handlers.handle(new Error('first'), 'uncaughtException')
    harness.handlers.handle(new Error('second'), 'unhandledRejection')
    expect(harness.persist).toHaveBeenCalledOnce()
    expect(harness.exit).toHaveBeenCalledOnce()
  })

  it('落盘失败仍写日志并退出', () => {
    const harness = createHarness({ persistThrows: true })
    harness.handlers.handle(new Error('boom'), 'uncaughtException')
    expect(harness.log).toHaveBeenCalledOnce()
    expect(harness.exit).toHaveBeenCalledWith(FATAL_EXIT_CODE)
  })

  it('日志失败仍落盘并退出', () => {
    const harness = createHarness({ logThrows: true })
    harness.handlers.handle(new Error('boom'), 'uncaughtException')
    expect(harness.persist).toHaveBeenCalledOnce()
    expect(harness.exit).toHaveBeenCalledWith(FATAL_EXIT_CODE)
  })

  it('置 fatal 状态失败也不阻止退出', () => {
    const persist = vi.fn()
    const exit = vi.fn()
    const handlers = createFatalHandlers({
      lifecycle: { enterFatal: () => { throw new Error('state failed') }, phase: 'running' },
      persist,
      exit
    })
    expect(() => handlers.handle(new Error('boom'), 'uncaughtException')).not.toThrow()
    expect(persist).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(FATAL_EXIT_CODE)
  })
})

describe('致命退出（真实子进程）', () => {
  let bundlePath: string
  let bundleDir: string

  beforeAll(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'lyshell-fatal-bundle-'))
    bundlePath = join(bundleDir, 'fatal-exit.cjs')
    buildSync({
      entryPoints: [resolve('src/main/lifecycle/__fixtures__/fatal-exit.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      tsconfig: resolve('tsconfig.node.json'),
      logLevel: 'silent'
    })
  })

  afterAll(() => {
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true })
  })

  function runFixture(mode: string): { status: number | null; signal: NodeJS.Signals | null; userData: string } {
    const userData = createTempDir('lyshell-fatal-')
    const result = spawnSync(process.execPath, [bundlePath], {
      env: { ...process.env, FATAL_FIXTURE_MODE: mode, FATAL_FIXTURE_USER_DATA: userData },
      stdio: 'ignore',
      timeout: 15_000
    })
    return { status: result.status, signal: result.signal, userData }
  }

  function readMarkers(userData: string): { fatal?: Record<string, unknown>; log: boolean; sync: boolean; business: boolean } {
    const fatalPath = join(userData, 'lifecycle', 'fatal-last.json')
    return {
      fatal: existsSync(fatalPath) ? JSON.parse(readFileSync(fatalPath, 'utf-8')) : undefined,
      log: existsSync(join(userData, 'log-ran')),
      sync: existsSync(join(userData, 'sync-hook-ran')),
      business: existsSync(join(userData, 'business-shutdown-ran'))
    }
  }

  it('uncaughtException 非零退出，落盘脱敏诊断，不执行正常清理', () => {
    const { status, signal, userData } = runFixture('uncaught')
    expect(signal).toBeNull()
    expect(status).toBe(FATAL_EXIT_CODE)

    const markers = readMarkers(userData)
    expect(markers.fatal).toMatchObject({ kind: 'fatal', phase: 'running' })
    expect(String(markers.fatal?.reason)).toContain('uncaughtException')
    expect(String(markers.fatal?.reason)).toContain('[redacted]')
    expect(String(markers.fatal?.reason)).not.toContain('secret-123')
    expect(markers.log).toBe(true)
    expect(markers.sync).toBe(true)
    // 致命路径不执行正常退出步骤（不批量保存业务仓库）
    expect(markers.business).toBe(false)
  })

  it('unhandledRejection 同样非零退出并记录来源', () => {
    const { status, userData } = runFixture('rejection')
    expect(status).toBe(FATAL_EXIT_CODE)
    const markers = readMarkers(userData)
    expect(String(markers.fatal?.reason)).toContain('unhandledRejection')
    expect(markers.business).toBe(false)
  })

  it('诊断日志写入失败仍非零退出', () => {
    const { status, userData } = runFixture('log-failure')
    expect(status).toBe(FATAL_EXIT_CODE)
    const markers = readMarkers(userData)
    expect(markers.fatal).toBeDefined()
    expect(markers.log).toBe(true)
    expect(markers.sync).toBe(true)
  })

  it('诊断落盘失败仍非零退出', () => {
    const { status, userData } = runFixture('persist-failure')
    expect(status).toBe(FATAL_EXIT_CODE)
    const markers = readMarkers(userData)
    expect(markers.fatal).toBeUndefined()
    expect(markers.log).toBe(true)
    expect(markers.sync).toBe(true)
  })
})

describe('复审回归：结构化凭据诊断', () => {
  it('JSON 引号键、转义值和 Basic 凭据均不进入消息或堆栈', () => {
    const secrets = ['pa"ss\\ word', 'json-token-value', 'json-api-key', 'dXNlcjpwYXNz']
    const text = JSON.stringify({ password: secrets[0], token: secrets[1], api_key: secrets[2], Authorization: `Basic ${secrets[3]}` })
    const error = new Error(text)
    error.stack = `Error: ${text}`
    const report = buildFatalReport(error, 'uncaughtException')
    for (const secret of secrets) {
      expect(report.message).not.toContain(secret)
      expect(report.stack).not.toContain(secret)
    }
    expect(report.message).not.toContain('ss\\\\ word')
    expect(report.message).toContain('[redacted]')
    expect(redactDiagnosticText("'password': 'single quoted secret'")).not.toContain('single quoted secret')
  })

  it('截断发生在带空格的引号凭据内部时不泄漏剩余片段', () => {
    const secret = 'secret-fragment '.repeat(FATAL_MESSAGE_MAX)
    const report = buildFatalReport(`password: "${secret}"`, 'unhandledRejection')
    expect(report.message).not.toContain('secret-fragment')
    expect(report.message).toContain('[redacted]')
  })
})
