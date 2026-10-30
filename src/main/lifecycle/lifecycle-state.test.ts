import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXIT_STATE_MAX_CHARS,
  FATAL_STATE_FILE,
  LIFECYCLE_STATE_DIR,
  SHUTDOWN_STATE_FILE,
  readLastExitState,
  writeFatalState,
  writeShutdownState
} from './lifecycle-state'
import { buildFatalReport } from './fatal-error'
import type { ShutdownReport } from './app-lifecycle'

const tempRoots: string[] = []

function createUserDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lyshell-lifecycle-state-'))
  tempRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'lyshell-lifecycle-state-'))) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`)
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function createShutdownReport(overrides: Partial<ShutdownReport> = {}): ShutdownReport {
  return {
    kind: 'stopped',
    reason: 'app-will-quit',
    startedAt: 1000,
    finishedAt: 2000,
    elapsedMs: 1000,
    budgetMs: 18_000,
    timedOut: false,
    outcomes: [],
    unconfirmed: [],
    ...overrides
  }
}

describe('致命退出标记', () => {
  it('同步写入最小诊断，读取时保留来源/阶段/pid', () => {
    const userData = createUserDataDir()
    const report = buildFatalReport(new Error('boom token=secret-123'), 'uncaughtException', {
      now: () => 1234,
      phase: 'draining',
      pid: 4321
    })

    expect(writeFatalState(userData, report)).toBe(true)
    const file = join(userData, LIFECYCLE_STATE_DIR, FATAL_STATE_FILE)
    expect(existsSync(file)).toBe(true)

    const record = readLastExitState(userData)
    expect(record).toMatchObject({ kind: 'fatal', at: 1234, pid: 4321, phase: 'draining' })
    expect(record?.reason).toContain('uncaughtException')
    expect(record?.reason).toContain('token=[redacted]')
    expect(record?.reason).not.toContain('secret-123')
  })

  it('原因定长，超大诊断不会把状态文件写成日志转储', () => {
    const userData = createUserDataDir()
    const report = buildFatalReport(new Error('x'.repeat(5_000)), 'unhandledRejection')
    expect(writeFatalState(userData, report)).toBe(true)

    const raw = readFileSync(join(userData, LIFECYCLE_STATE_DIR, FATAL_STATE_FILE), 'utf-8')
    expect(raw.length).toBeLessThanOrEqual(EXIT_STATE_MAX_CHARS)
    const record = readLastExitState(userData)
    expect(record?.reason?.length).toBeLessThanOrEqual(601)
  })
})

describe('正常退出标记', () => {
  it('记录未确认步骤与预算结果，供下次启动保守恢复', () => {
    const userData = createUserDataDir()
    const report = createShutdownReport({
      elapsedMs: 2500,
      timedOut: true,
      unconfirmed: ['plugin-release', 'dsh-web']
    })

    expect(writeShutdownState(userData, report)).toBe(true)
    const record = readLastExitState(userData)
    expect(record).toMatchObject({ kind: 'stopped', at: 2000, phase: 'stopped' })
    expect(record?.reason).toContain('elapsed=2500ms')
    expect(record?.reason).toContain('timedOut=true')
    expect(record?.unconfirmed).toEqual(['plugin-release', 'dsh-web'])
  })

  it('未确认步骤列表有上限', () => {
    const userData = createUserDataDir()
    const unconfirmed = Array.from({ length: 50 }, (_value, index) => `step-${index}`)
    expect(writeShutdownState(userData, createShutdownReport({ unconfirmed }))).toBe(true)
    expect(readLastExitState(userData)?.unconfirmed).toHaveLength(32)
  })
})

describe('读取最近一次退出标记', () => {
  it('fatal 与 stopped 取时间更新者', () => {
    const userData = createUserDataDir()
    const fatal = buildFatalReport(new Error('boom'), 'uncaughtException', { now: () => 1000, pid: 1 })

    writeFatalState(userData, fatal)
    writeShutdownState(userData, createShutdownReport({ finishedAt: 2000 }))
    expect(readLastExitState(userData)?.kind).toBe('stopped')

    writeFatalState(userData, { ...fatal, at: 3000 })
    expect(readLastExitState(userData)?.kind).toBe('fatal')
  })

  it('缺失、损坏或结构不符时返回 null，不抛错', () => {
    const userData = createUserDataDir()
    expect(readLastExitState(userData)).toBeNull()

    const file = join(userData, LIFECYCLE_STATE_DIR, FATAL_STATE_FILE)
    mkdirSync(join(userData, LIFECYCLE_STATE_DIR), { recursive: true })
    writeFileSync(file, '{not json', 'utf-8')
    expect(readLastExitState(userData)).toBeNull()

    writeFileSync(file, JSON.stringify({ kind: 'fatal', at: 'yesterday', pid: 1 }), 'utf-8')
    expect(readLastExitState(userData)).toBeNull()

    writeFileSync(join(userData, LIFECYCLE_STATE_DIR, SHUTDOWN_STATE_FILE), JSON.stringify({
      kind: 'stopped', at: 1000, pid: 1, unconfirmed: [1, 'ok', null]
    }), 'utf-8')
    expect(readLastExitState(userData)?.unconfirmed).toEqual(['ok'])
  })

  it('目录不可写时写入返回 false 而不是抛错（致命路径不能因诊断失败中断）', () => {
    const parent = createUserDataDir()
    const fileAsUserData = join(parent, 'not-a-directory')
    writeFileSync(fileAsUserData, 'x', 'utf-8')
    const report = buildFatalReport(new Error('boom'), 'uncaughtException')
    expect(() => writeFatalState(fileAsUserData, report)).not.toThrow()
    expect(writeFatalState(fileAsUserData, report)).toBe(false)
    expect(() => readLastExitState(fileAsUserData)).not.toThrow()
    expect(readLastExitState(fileAsUserData)).toBeNull()
  })
})
