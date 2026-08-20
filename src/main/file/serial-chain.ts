/**
 * 按 key 串行执行异步任务的工具。
 *
 * 同一 key 的任务排队执行（前一个完成/失败/取消后才跑下一个），
 * 不同 key 的任务并行。用于避免并发写同一文件导致内容交错损坏
 * （如两个上传同时 `open(path, "wb")` 同一远端文件，或两个下载
 * 同时 `fs.openSync(localPath, 'w')` 同一本地文件）。
 *
 * - 前序任务失败/拒绝不会阻塞后续同 key 任务。
 * - 当前任务的真实结算结果（resolve/reject）透传给调用方。
 * - 可按 id/group 取消尚未启动的排队任务；正在运行的任务由调用方终止实际资源。
 * - 链项在结算后自动摘除，不泄漏。
 */

interface SerialTaskOptions {
  /** 任务唯一 ID，用于单任务取消 */
  id?: string
  /** 分组 ID（文件传输使用 sessionId），用于批量取消 */
  group?: string
  /** 排队任务被取消时执行的轻量清理（不得抛错） */
  onCancel?: () => void
}

interface SerialTask extends SerialTaskOptions {
  fn: () => Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  started: boolean
}

export function createSerialChain() {
  const queues = new Map<string, SerialTask[]>()

  function startNext(key: string): void {
    const queue = queues.get(key)
    const task = queue?.[0]
    if (!queue || !task || task.started) return
    task.started = true

    const finish = (error?: unknown): void => {
      if (queue[0] === task) queue.shift()
      if (queue.length === 0) queues.delete(key)
      else startNext(key)

      if (error === undefined) task.resolve()
      else task.reject(error instanceof Error ? error : new Error(String(error)))
    }

    // 同步调用 fn，确保任务在 run() 返回前进入调用方的 activeWorkers；
    // 会话紧接着断开时不会落入「链标记已启动、activeWorkers 尚未登记」的缝隙。
    try {
      Promise.resolve(task.fn()).then(() => finish(), finish)
    } catch (error) {
      finish(error)
    }
  }

  function run(key: string, fn: () => Promise<void>, options: SerialTaskOptions = {}): Promise<void> {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const task: SerialTask = { ...options, fn, resolve, reject, started: false }
    const queue = queues.get(key)
    if (queue) queue.push(task)
    else queues.set(key, [task])
    startNext(key)
    return promise
  }

  function cancelWhere(predicate: (task: SerialTask) => boolean): string[] {
    const cancelledIds: string[] = []
    for (const [key, queue] of queues) {
      // 正在运行的队首不由串行链取消；manager 会终止实际 Worker。
      for (let i = queue.length - 1; i >= 0; i--) {
        const task = queue[i]
        if (task.started || !predicate(task)) continue
        queue.splice(i, 1)
        try {
          task.onCancel?.()
        } catch {
          /* 取消清理失败不应阻止其余任务取消 */
        }
        if (task.id) cancelledIds.push(task.id)
        task.reject(new Error('Task cancelled before start'))
      }
      if (queue.length === 0) queues.delete(key)
    }
    return cancelledIds
  }

  return {
    run,
    cancelId: (id: string): boolean => cancelWhere((task) => task.id === id).length > 0,
    cancelGroup: (group: string): string[] => cancelWhere((task) => task.group === group),
    cancelAll: (): string[] => cancelWhere(() => true),
    /** 当前挂起（运行中或排队中）的 key 数量，主要用于诊断/测试 */
    pendingCount: () => queues.size
  }
}
