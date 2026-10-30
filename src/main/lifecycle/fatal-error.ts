/**
 * 致命错误处理器：进程已处于不确定状态时，只做最小、可预期的收尾，然后非零退出。
 *
 * 与旧 index.ts 策略的区别（见 docs/lyshell-complete-remediation-plan-2026-10-30.md 4.2/4.3）：
 * - 不再按错误文本（SSH/timeout/EOF/...）决定「可以继续服务」；
 * - 不再在生产环境记录后继续运行；
 * - 诊断有界、脱敏、定长；诊断/日志/落盘任何一步失败都仍然退出；
 * - 幂等 guard 防止诊断路径自身抛错导致递归处理。
 *
 * 本模块不依赖 electron，可被 vitest 直接构造；进程级注册只在 index.ts 发生。
 */
import type { LifecyclePhase } from './app-lifecycle'

export type FatalSource = 'uncaughtException' | 'unhandledRejection'

export const FATAL_EXIT_CODE = 1
export const FATAL_MESSAGE_MAX = 512
export const FATAL_STACK_MAX = 4_096
export const FATAL_REPORT_MAX_CHARS = 8_192

export interface FatalReport {
  kind: 'fatal'
  at: number
  source: FatalSource
  /** 进入致命状态前的生命周期阶段（running/draining），用于区分退出场景。 */
  phase: LifecyclePhase
  pid: number
  name: string
  code?: string
  message: string
  stack?: string
}

export interface FatalReportOptions {
  now?: () => number
  phase?: LifecyclePhase
  pid?: number
}

const AUTHORIZATION_SCHEME = /\b((?:proxy-)?authorization)\b(["']?\s*[:=]\s*["']?)(basic|bearer|token)\s+[A-Za-z0-9._~+/=-]+/gi
// 引号键、转义引号和截断后未闭合的值均整体脱敏，避免只吞掉凭据首个单词。
const SECRET_ASSIGNMENT = /\b(token|secret|password|passwd|api[-_ ]?key|credential|private[-_ ]?key)\b(["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^\s,;]+)/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

/**
 * 脱敏：诊断只保留定位所需信息，凭据类片段统一替换。
 *
 * 先处理 `Authorization: Bearer/Basic <secret>` 整体（否则通用赋值规则只会吞掉
 * 方案名、把真正的 token 留在日志里），再处理 `token=...` 形式，最后兜底裸 Bearer。
 */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(AUTHORIZATION_SCHEME, (_match, name: string, separator: string, scheme: string) =>
      `${name}${separator}${scheme} [redacted]`)
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[redacted]`)
    .replace(BEARER_TOKEN, 'Bearer [redacted]')
}

function boundText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
}

/** 先限长再脱敏：避免对超大错误文本/堆栈做无界正则替换（也避免泄漏被截断的尾部凭据）。 */
function sanitizeText(text: string, max: number): string {
  return redactDiagnosticText(boundText(text, max))
}

/** 属性读取可能触发 getter 抛错；失败按缺失处理，绝不阻断致命路径。 */
function safeStringProperty(value: object, key: string): string | undefined {
  try {
    const raw: unknown = (value as Record<string, unknown>)[key]
    return typeof raw === 'string' ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * 非 Error 值的固定类型标签：**不**调用 `JSON.stringify`（任意 rejection 对象的
 * `toJSON` 可能有副作用，也可能极大），只按 `typeof`/`Array.isArray` 给出固定标签。
 */
function describeNonError(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[array length=${value.length}]`
  switch (typeof value) {
    case 'number': case 'boolean': case 'bigint': return String(value)
    case 'symbol': return '[symbol]'
    case 'function': return '[function]'
    default: return '[object]'
  }
}

/** 构造有界、脱敏的致命报告。不读取业务仓库、不访问网络、不序列化任意对象。 */
export function buildFatalReport(error: unknown, source: FatalSource, options: FatalReportOptions = {}): FatalReport {
  const now = options.now ?? Date.now
  const base = {
    kind: 'fatal' as const,
    at: now(),
    source,
    phase: options.phase ?? 'running',
    pid: options.pid ?? process.pid
  }
  if (error instanceof Error) {
    const name = safeStringProperty(error, 'name') ?? 'Error'
    const message = safeStringProperty(error, 'message') ?? name
    const code = safeStringProperty(error, 'code')
    const stack = safeStringProperty(error, 'stack')
    return {
      ...base,
      name: sanitizeText(name, 80),
      ...(code ? { code: sanitizeText(code, 80) } : {}),
      message: sanitizeText(message, FATAL_MESSAGE_MAX),
      ...(stack ? { stack: sanitizeText(stack, FATAL_STACK_MAX) } : {})
    }
  }
  return {
    ...base,
    name: 'NonErrorValue',
    message: sanitizeText(describeNonError(error), FATAL_MESSAGE_MAX)
  }
}

/**
 * 序列化为定长 JSON。超限时依次丢弃堆栈、截短消息 —— 保证日志单行可读且不会
 * 把整个响应体/大对象写进退出日志。
 */
export function serializeFatalReport(report: FatalReport): string {
  let json = JSON.stringify(report)
  if (json.length <= FATAL_REPORT_MAX_CHARS) return json
  const withoutStack = { ...report, stack: undefined }
  json = JSON.stringify(withoutStack)
  if (json.length <= FATAL_REPORT_MAX_CHARS) return json
  return JSON.stringify({ ...withoutStack, message: withoutStack.message.slice(0, 256) })
}

export interface FatalHandlerOptions {
  /** 只需要「置 fatal + 读阶段」两件事，便于测试替身。 */
  lifecycle: { enterFatal(reason: string): void; readonly phase: LifecyclePhase }
  /** 同步落盘最小诊断；抛错也必须继续退出。 */
  persist?: (report: FatalReport) => void
  /** 同步写日志；抛错也必须继续退出。 */
  log?: (report: FatalReport) => void
  /** 预先定义的最小同步失效（不写业务仓库、不调用 app.quit）。 */
  onFatalSync?: readonly (() => void)[]
  /** 退出实现；默认 process.exit。 */
  exit?: (code: number) => void
  exitCode?: number
  now?: () => number
  pid?: number
}

export interface FatalHandlers {
  handle(error: unknown, source: FatalSource): void
}

/**
 * 构造幂等致命处理器：第一次调用后，后续调用（包括诊断路径递归抛出的）直接忽略。
 * 无论诊断/日志/落盘是否失败，最后都在 finally 里退出。
 */
export function createFatalHandlers(options: FatalHandlerOptions): FatalHandlers {
  let handling = false
  const handle = (error: unknown, source: FatalSource): void => {
    if (handling) return
    handling = true
    try {
      // 报告构造本身也可能因为恶意 getter/代理抛错；失败时退化为固定说明，仍执行最小失效与退出。
      let report: FatalReport | undefined
      try {
        report = buildFatalReport(error, source, {
          now: options.now,
          phase: options.lifecycle.phase,
          pid: options.pid
        })
      } catch {
        report = undefined
      }
      try { options.lifecycle.enterFatal(report?.message ?? 'Unprintable fatal error') } catch { /* 状态置位失败也必须退出 */ }
      if (report) {
        if (options.persist) {
          try { options.persist(report) } catch { /* 诊断落盘失败不能阻止退出 */ }
        }
        if (options.log) {
          try { options.log(report) } catch { /* 日志失败不能阻止退出 */ }
        }
      }
      for (const hook of options.onFatalSync ?? []) {
        try { hook() } catch { /* 最小同步失效失败不能阻止退出 */ }
      }
    } finally {
      const code = options.exitCode ?? FATAL_EXIT_CODE
      try {
        if (options.exit) options.exit(code)
        else process.exit(code)
      } catch {
        process.exit(code)
      }
    }
  }
  return { handle }
}

/** 注册进程级 handler；返回卸载函数（生产环境通常不卸载）。 */
export function installFatalHandlers(options: FatalHandlerOptions): () => void {
  const handlers = createFatalHandlers(options)
  const onUncaught = (error: Error): void => handlers.handle(error, 'uncaughtException')
  const onRejection = (reason: unknown): void => handlers.handle(reason, 'unhandledRejection')
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  return () => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onRejection)
  }
}
