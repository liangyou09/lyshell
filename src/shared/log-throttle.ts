/**
 * 插件日志限速转发器（防刷屏）。
 *
 * 插件进程的 stderr/stdout、guest 页 console 会被转发进 LyShell 主日志。
 * 失控/恶意插件可以按管线速度刷屏（electron-log 默认 ~1MB 轮转，很快冲掉有用日志）。
 * 这里提供统一的转发闸：滑动窗口内超过 maxLines 条后开始抑制，窗口滚动时汇总一条
 * 「已抑制 N 条」；单条超长再截断，防多行 chunk 一条超限。
 *
 * 纯函数、零依赖，main 进程（host-mgr/python engine/guest console）与
 * plugin-host 子进程 entry 共用。
 */

export interface LogTapOptions {
  /** 窗口时长 ms（默认 10s） */
  windowMs?: number
  /** 窗口内最多放行条数（默认 40） */
  maxLines?: number
  /** 单条最大字符数（默认 2000） */
  maxChars?: number
}

export interface LogTap {
  (text: string): void
  /** 累计被抑制的条数（测试/诊断用） */
  suppressedCount(): number
}

export function createLogTap(sink: (line: string) => void, opts: LogTapOptions = {}): LogTap {
  const windowMs = opts.windowMs ?? 10_000
  const maxLines = opts.maxLines ?? 40
  const maxChars = opts.maxChars ?? 2000
  let windowStart = 0
  let allowed = 0
  let suppressedInWindow = 0
  let totalSuppressed = 0

  const tap = ((text: string): void => {
    const now = Date.now()
    if (now - windowStart >= windowMs) {
      // 窗口滚动：先汇总上一窗口的抑制量，再重开窗口
      if (suppressedInWindow > 0) {
        sink(`[log-tap] 过去 ${Math.round(windowMs / 1000)}s 抑制了 ${suppressedInWindow} 条刷屏日志`)
        suppressedInWindow = 0
      }
      windowStart = now
      allowed = 0
    }
    if (allowed >= maxLines) {
      suppressedInWindow++
      totalSuppressed++
      return
    }
    allowed++
    sink(text.length > maxChars ? `${text.slice(0, maxChars)}…[截断]` : text)
  }) as LogTap
  tap.suppressedCount = () => totalSuppressed
  return tap
}
