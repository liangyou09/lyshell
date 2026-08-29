/**
 * 按 key 串行化异步任务的进程内互斥（promise 链实现，无锁依赖）。
 *
 * 用途：Harness 工作区启动解析（读仓库记录 → resolveLaunchWorktree）必须按
 * <kind>:<workspaceId> 串行 —— 并发双启动同一工作区会同时命中旧 worktree 迁移：
 * 后执行的 move 失败后会把前者已持久化的 key 回滚成 undefined，甚至返回已被前者
 * 迁走的旧路径。锁必须罩住「读记录 + 解析」全程：只锁解析本身的话，后来者仍拿着
 * 迁移前的旧快照（空 key），会另起新树。
 *
 * 语义：
 *   - 同 key 严格按提交顺序执行（FIFO）；
 *   - 不同 key 互不阻塞（并行）；
 *   - 前序任务失败不连坐后来者（异常只抛给发起方，队列链吞掉）；
 *   - 队列空闲后自动清理登记项，Map 不随历史 key 增长。
 *
 * 进程内互斥即可：所有启动入口（TUI launch / dsh web）都在同一主进程里。
 * 本模块不 import Electron，可独立单测。
 */
export interface TaskSerializer {
  /** 提交任务：同 key 排队串行，返回值/异常透传给发起方 */
  <T>(key: string, task: () => Promise<T>): Promise<T>
  /** 仍在排队/执行中的 key 数（测试与诊断用） */
  readonly pending: number
}

export function createTaskSerializer(): TaskSerializer {
  const queues = new Map<string, Promise<void>>()
  const serialize = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    // 排在前序之后；前序的成败都不该卡住/连坐后来者（吞掉异常，只保顺序）
    const run = (queues.get(key) ?? Promise.resolve()).then(() => task())
    const tail = run.then(() => undefined, () => undefined)
    queues.set(key, tail)
    // 队列排空即清理：期间若有新任务入队会覆盖 Map 项，比对失败说明自己已不是队尾，不删
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return run
  }
  // 注意不能用 Object.assign 挂 getter：它会把源对象的 getter 求值成静态值拷走，
  // pending 会永远停在创建时的 0 —— 须 defineProperty 定义真正的访问器
  const serializer = serialize as TaskSerializer
  Object.defineProperty(serializer, 'pending', {
    get: () => queues.size,
    enumerable: true
  })
  return serializer
}
