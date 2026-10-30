/**
 * 隔离匹配 Worker 入口（构建为 `dist/main/patternWorker.js`）。
 *
 * 外部提供的正则只在这里编译与执行：主线程用 `worker.terminate()` 就能打断灾难性回溯，
 * 因此 `pattern-matcher.ts` 可以给出确定的执行期限，而不是把主进程（含 HTTP 心跳）一起卡死。
 *
 * 协议失败时不回退到主线程；错误一律收敛成固定 reason 的 `error` 帧。
 */
import { parentPort } from 'worker_threads'
import { performance } from 'node:perf_hooks'
import {
  MATCH_MODES,
  PATTERN_WORKER_PROTOCOL,
  PatternMatchError,
  validateMatchInputs,
  validatePatternSpec,
  type MatchMode,
  type PatternWorkerRequest,
  type PatternWorkerResponse
} from './pattern-contract'

if (!parentPort) throw new Error('Pattern matcher worker must be started as a worker thread')
const port = parentPort

/** 已编译正则缓存：按 pattern 源缓存，避免每次轮询重复编译。上限很小，命中即清空。 */
const MAX_COMPILED = 32
const compiled = new Map<string, RegExp>()

function compileRegex(pattern: string): RegExp {
  const cached = compiled.get(pattern)
  if (cached) return cached
  // 不传 flags：g/y 会让 lastIndex 在多次 test() 之间残留，跨轮询结果不可复现。
  const regex = new RegExp(pattern)
  if (compiled.size >= MAX_COMPILED) compiled.clear()
  compiled.set(pattern, regex)
  return regex
}

function matchInputs(inputs: readonly string[], pattern: string, mode: MatchMode): number {
  if (mode === 'literal') {
    for (let index = 0; index < inputs.length; index++) {
      if (inputs[index].includes(pattern)) return index
    }
    return -1
  }
  const regex = compileRegex(pattern)
  for (let index = 0; index < inputs.length; index++) {
    if (regex.test(inputs[index])) return index
  }
  return -1
}

function handle(request: PatternWorkerRequest): PatternWorkerResponse {
  // 长度/形态校验也在 Worker 内再做一次：主线程校验后仍可能被改写的输入不接受。
  const { pattern, mode } = validatePatternSpec({ pattern: request.pattern, mode: request.mode })
  if (!(MATCH_MODES as readonly string[]).includes(mode)) {
    throw new PatternMatchError('UNSUPPORTED_MATCH_MODE')
  }
  const startedAt = performance.now()

  if (request.type === 'compile') {
    if (mode === 'regex') compileRegex(pattern)
    return {
      type: 'compile',
      jobId: request.jobId,
      generation: request.generation,
      elapsedMs: performance.now() - startedAt
    }
  }

  validateMatchInputs(request.inputs)
  const matchedIndex = matchInputs(request.inputs, pattern, mode)
  return {
    type: 'match',
    jobId: request.jobId,
    generation: request.generation,
    matched: matchedIndex >= 0,
    matchedIndex,
    elapsedMs: performance.now() - startedAt
  }
}

function failureReasonOf(error: unknown): PatternMatchError['reason'] {
  if (error instanceof PatternMatchError) return error.reason
  if (error instanceof SyntaxError || error instanceof RangeError) return 'INVALID_PATTERN'
  return 'MATCH_WORKER_FAILED'
}

port.on('message', (request: PatternWorkerRequest) => {
  if (!request || typeof request !== 'object' || typeof request.jobId !== 'string') return
  try {
    port.postMessage(handle(request))
  } catch (error) {
    const reason = failureReasonOf(error)
    const message = error instanceof Error ? error.message.slice(0, 256) : ''
    const response: PatternWorkerResponse = {
      type: 'error',
      jobId: request.jobId,
      generation: request.generation,
      reason,
      message
    }
    port.postMessage(response)
  }
})

port.postMessage({ type: 'ready', protocol: PATTERN_WORKER_PROTOCOL } satisfies PatternWorkerResponse)
