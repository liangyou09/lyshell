/** 内部 HTTP 只接受本机代理使用的明确 Host；随机端口本身不充当认证。 */
export function isLocalApiHost(host: string | undefined, port: number | undefined): boolean {
  return Number.isInteger(port) && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
}

/** HTTP 响应结束才释放名额。响应断开不代表底层有副作用任务已经停止。 */
export class RequestBudget {
  private active = 0
  private callers = new Map<string, number>()
  constructor(private readonly total = 64, private readonly perCaller = 16) {}

  acquire(caller: string): (() => void) | undefined {
    const count = this.callers.get(caller) ?? 0
    if (this.active >= this.total || count >= this.perCaller) return undefined
    this.active++
    this.callers.set(caller, count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = (this.callers.get(caller) ?? 1) - 1
      if (next) this.callers.set(caller, next)
      else this.callers.delete(caller)
    }
  }
}

export function isBoundedJson(value: unknown, maxDepth = 32, maxNodes = 100_000): boolean {
  const pending = [{ value, depth: 0 }]
  let count = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++count > maxNodes || entry.depth > maxDepth) return false
    if (entry.value && typeof entry.value === 'object') {
      for (const child of Object.values(entry.value)) {
        if (pending.length + count >= maxNodes) return false
        pending.push({ value: child, depth: entry.depth + 1 })
      }
    }
  }
  return true
}
