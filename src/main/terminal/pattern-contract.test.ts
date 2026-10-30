import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROMPT_PATTERN,
  PATTERN_LIMITS,
  PATTERN_WORKER_PROTOCOL,
  PatternMatchError,
  asPatternMatchError,
  isPatternWorkerResponse,
  validateMatchInputs,
  validatePatternSpec
} from './pattern-contract'

/** 断言抛出的是带固定 reason/code 的 PatternMatchError（vitest 的 toThrow 不吃 objectContaining）。 */
function expectPatternError(run: () => unknown, reason: string, code: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PatternMatchError)
  expect(caught).toMatchObject({ reason, code })
}

describe('pattern-contract 同步校验（不编译正则）', () => {
  it('默认 regex，literal 显式指定', () => {
    expect(validatePatternSpec({ pattern: '^ok$' })).toEqual({ pattern: '^ok$', mode: 'regex' })
    expect(validatePatternSpec({ pattern: 'a.b', mode: 'literal' })).toEqual({ pattern: 'a.b', mode: 'literal' })
  })

  it('语法非法的表达式不在同步校验里编译（编译只能发生在 Worker 内）', () => {
    expect(() => validatePatternSpec({ pattern: '(' })).not.toThrow()
    expect(() => validatePatternSpec({ pattern: '(?<broken' })).not.toThrow()
  })

  it('空/非字符串 pattern → INVALID_PATTERN', () => {
    for (const pattern of ['', undefined, null, 42]) {
      expectPatternError(() => validatePatternSpec({ pattern } as never), 'INVALID_PATTERN', 'INVALID_ARGUMENT')
    }
  })

  it('超过 2048 个 UTF-16 单位 → PATTERN_TOO_LONG', () => {
    expect(validatePatternSpec({ pattern: 'a'.repeat(PATTERN_LIMITS.maxPatternChars) }).pattern).toHaveLength(2048)
    expectPatternError(
      () => validatePatternSpec({ pattern: 'a'.repeat(PATTERN_LIMITS.maxPatternChars + 1) }),
      'PATTERN_TOO_LONG',
      'INVALID_ARGUMENT'
    )
  })

  it('未知模式 → UNSUPPORTED_MATCH_MODE', () => {
    expectPatternError(() => validatePatternSpec({ pattern: 'x', mode: 'glob' } as never), 'UNSUPPORTED_MATCH_MODE', 'INVALID_ARGUMENT')
  })

  it('内置提示符正则仍是 [$#>%]\\s*$', () => {
    expect(BUILTIN_PROMPT_PATTERN).toBe('[$#>%]\\s*$')
  })
})

describe('pattern-contract 输入预算', () => {
  it('返回总字符数并拒绝空/非字符串', () => {
    expect(validateMatchInputs(['abc', 'de'])).toBe(5)
    expectPatternError(() => validateMatchInputs([]), 'MATCH_INPUT_INVALID', 'INVALID_ARGUMENT')
    expectPatternError(() => validateMatchInputs([42 as never]), 'MATCH_INPUT_INVALID', 'INVALID_ARGUMENT')
  })

  it('单条超过 1 MiB、合计超过 2 MiB → MATCH_INPUT_TOO_LARGE', () => {
    expect(validateMatchInputs(['a'.repeat(PATTERN_LIMITS.maxBaseChars)])).toBe(1048576)
    expectPatternError(
      () => validateMatchInputs(['a'.repeat(PATTERN_LIMITS.maxBaseChars + 1)]),
      'MATCH_INPUT_TOO_LARGE',
      'RESOURCE_LIMIT'
    )
    expectPatternError(
      () => validateMatchInputs(['a'.repeat(PATTERN_LIMITS.maxBaseChars), 'b'.repeat(PATTERN_LIMITS.maxJobInputChars)]),
      'MATCH_INPUT_TOO_LARGE',
      'RESOURCE_LIMIT'
    )
  })
})

describe('pattern-contract 上限（计划 R1 3.3 初始值）', () => {
  it('与计划一致', () => {
    expect(PATTERN_LIMITS).toMatchObject({
      maxPatternChars: 2048,
      maxBaseChars: 1048576,
      maxJobInputChars: 2097152,
      maxWorkers: 2,
      maxQueuedJobs: 16,
      maxWaitersPerCaller: 4,
      maxWaiters: 16,
      reservedInputChars: 16777216,
      matchDeadlineMs: 100,
      workerStartDeadlineMs: 2000,
      workerExitDeadlineMs: 5000
    })
  })
})

describe('pattern-contract 稳定错误', () => {
  it('code / 公共消息 / 重试语义固定', () => {
    expect(new PatternMatchError('INVALID_PATTERN')).toMatchObject({
      code: 'INVALID_ARGUMENT',
      retryDisposition: 'never',
      message: 'Wait pattern is not a valid regular expression'
    })
    expect(new PatternMatchError('MATCH_EXECUTION_TIMEOUT')).toMatchObject({
      code: 'RESOURCE_LIMIT',
      retryDisposition: 'never',
      message: 'Wait pattern matching exceeded the execution deadline'
    })
    expect(new PatternMatchError('MATCH_QUEUE_FULL')).toMatchObject({ code: 'RESOURCE_LIMIT', retryDisposition: 'safe' })
    expect(new PatternMatchError('MATCH_SERVICE_SHUTDOWN')).toMatchObject({ code: 'FORBIDDEN', retryDisposition: 'never' })
    expect(new PatternMatchError('PATTERN_MODE_WITHOUT_PATTERN')).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Wait pattern mode requires an explicit pattern'
    })
  })

  it('未知错误收敛成固定消息，不外泄原始文本', () => {
    const error = asPatternMatchError(new Error('secret /(a+)+$/ and terminal output'))
    expect(error.reason).toBe('MATCH_WORKER_FAILED')
    expect(error.message).toBe('Wait pattern matcher stopped unexpectedly')
    expect(error.message).not.toContain('secret')
    expect(asPatternMatchError(new PatternMatchError('MATCH_CANCELLED')).reason).toBe('MATCH_CANCELLED')
  })
})

describe('pattern-contract Worker 协议帧校验', () => {
  it('接受合法帧', () => {
    expect(isPatternWorkerResponse({ type: 'ready', protocol: PATTERN_WORKER_PROTOCOL })).toBe(true)
    expect(isPatternWorkerResponse({ type: 'match', jobId: 'j1', generation: 3, matched: true, matchedIndex: 0, elapsedMs: 1 })).toBe(true)
    expect(isPatternWorkerResponse({ type: 'compile', jobId: 'j1', generation: 3, elapsedMs: 1 })).toBe(true)
    expect(isPatternWorkerResponse({ type: 'error', jobId: 'j1', generation: 3, reason: 'INVALID_PATTERN', message: 'x' })).toBe(true)
  })

  it('拒绝畸形帧（含未知 reason），迟到/伪造回包不会生效', () => {
    expect(isPatternWorkerResponse(null)).toBe(false)
    expect(isPatternWorkerResponse({ type: 'ready', protocol: '1' })).toBe(false)
    expect(isPatternWorkerResponse({ type: 'match', generation: 1, matched: true, matchedIndex: 0, elapsedMs: 1 })).toBe(false)
    expect(isPatternWorkerResponse({ type: 'match', jobId: 'j1', generation: '1', matched: true, matchedIndex: 0, elapsedMs: 1 })).toBe(false)
    expect(isPatternWorkerResponse({ type: 'error', jobId: 'j1', generation: 1, reason: 'SOMETHING_ELSE', message: 'x' })).toBe(false)
    expect(isPatternWorkerResponse({ type: 'unknown', jobId: 'j1', generation: 1 })).toBe(false)
  })
})
