/**
 * 终端 resize 调度器（纯逻辑，不依赖 React / xterm / Electron）。
 *
 * 分屏拖动或窗口缩放时，ResizeObserver 会按像素连续回调；如果每次回调都直接
 * fit 并通知 PTY，ConPTY 会反复整屏重印（raw-mode TUI 还会因此错位）。这里把
 * 两条节拍拆开：
 *  - 本地 fit 跟随动画帧：同一帧内的多次 schedule 合并成一次 fit，画面保持实时；
 *  - PTY 通知走尾部防抖：事件停止 delay 毫秒后才下发一次，且只下发与基线不同的
 *    合法尺寸。
 *
 * 帧回调只做 fit，通知只发生在尾部定时器。尾部始终重新 fit 再比较：帧后隐藏
 * 不一定触发 ResizeObserver，字号/页签也可能直接改变网格，不能把缓存当成当前值。
 *
 * 尺寸基线是 initialSize：创建调度器时该尺寸已经 fit 并同步给 PTY，因此一次
 * burst 内拖回 initialSize 的净零变化不会产生通知。fit 返回 null（容器隐藏或
 * 不可测量）时清空已拟合尺寸，绝不把旧值当当前值通知；恢复可见后重新 schedule
 * 即可继续。
 *
 * 与「容器隐藏」不同，isResizing 为 true 表示用户正在拖动布局（侧栏/分屏）：
 * 此时整个调度器暂停——schedule 既不排队帧也不创建尾部定时器，已排队的帧/尾部
 * 到点也直接放弃，不 fit、不通知 PTY。暂停不清空基线或 fittedSize，但也不会在
 * 手势结束后自动补一拍；调用方需在释放时显式调用一次 schedule()，由尾部按最新
 * 尺寸与基线比较后只通知一次。
 */

export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalResizeSchedulerOptions {
  /** 读取容器最新尺寸并执行本地 fit；容器不可见/不可测量时返回 null。 */
  fit: () => TerminalSize | null
  /** 把最终尺寸通知给 PTY。 */
  notify: (size: TerminalSize) => void
  /** 调度器创建时已经生效、且已告知 PTY 的尺寸。 */
  initialSize: TerminalSize
  /**
   * 可选：读取调度器之外最近一次真正下发给 PTY 的尺寸。
   * 字号变化、页签切换等路径会直接通知 PTY；尾部比较应以这条最新基线为准，
   * 避免重复下发。返回值非法时回退到调度器内部记录。
   */
  getReportedSize?: () => TerminalSize | null
  /**
   * 可选：当前是否处于用户布局手势（侧栏/分屏拖动）中。
   *
   * 返回 true 时调度器整体暂停：schedule 不排队动画帧、不 fit、不在尾部通知
   * PTY，也不创建会持续重置的定时器；手势结束时不会自动恢复，调用方需显式
   * 再调用一次 schedule()（例如订阅 layout-resize 的释放事件）。这与 fit 返回
   * null（容器隐藏）不同：暂停不改变基线，也不清空 fittedSize。
   *
   * 回调抛错按「未暂停」处理，保持默认行为。
   */
  isResizing?: () => boolean
  /** 尾部防抖窗口，默认 150ms。 */
  delay?: number
}

export interface TerminalResizeScheduler {
  /** 容器尺寸变化（或字号/分屏变化）时调用；可高频重复调用。 */
  schedule: () => void
  /** 取消待执行的帧与尾部定时器；之后 schedule 不再生效。 */
  dispose: () => void
}

const DEFAULT_DELAY_MS = 150

/** 只有正整数 cols/rows 才是可下发给 PTY 的合法尺寸。 */
function normalizeSize(size: TerminalSize | null | undefined): TerminalSize | null {
  if (!size) return null
  const { cols, rows } = size
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    return null
  }
  return { cols, rows }
}

function sameSize(a: TerminalSize | null, b: TerminalSize | null): boolean {
  return a !== null && b !== null && a.cols === b.cols && a.rows === b.rows
}

export function createTerminalResizeScheduler(
  options: TerminalResizeSchedulerOptions
): TerminalResizeScheduler {
  const delay = options.delay !== undefined && Number.isFinite(options.delay)
    ? Math.max(0, options.delay)
    : DEFAULT_DELAY_MS

  let disposed = false
  // 最近一次 fit 的结果；null 表示当前不可见/不可测量，不能复用。
  let fittedSize: TerminalSize | null = normalizeSize(options.initialSize)
  // schedule 的代数：fit 回调内部若又触发 schedule（例如 xterm resize 事件
  // 同步回调），尾部不能通知本次读取的中间尺寸。
  let fitGeneration = 0
  // 最近一次成功通知 PTY 的尺寸；净零变化与 initialSize 都以它为基线。
  let reportedSize: TerminalSize | null = normalizeSize(options.initialSize)
  // 已排队帧的取消函数；用独立状态记录，避免把 requestAnimationFrame 的
  // 合法返回值 0 误判成「没有排队」。
  let cancelFrame: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 布局手势期间暂停一切 fit/通知；读取失败时退回默认行为。 */
  const isPaused = (): boolean => {
    if (!options.isResizing) return false
    try {
      return options.isResizing()
    } catch {
      return false
    }
  }

  /** 清空已排队的帧与尾部定时器（不改变暂停/销毁状态）。 */
  const cancelPending = (): void => {
    if (cancelFrame !== null) {
      cancelFrame()
      cancelFrame = null
    }
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const runFit = (): void => {
    try {
      fittedSize = normalizeSize(options.fit())
    } catch {
      // fit 是外部回调，异常不能从 rAF / 定时器里逃逸。清掉旧尺寸，
      // 尾部或下一次 schedule 再尝试，避免把过期尺寸发出去。
      fittedSize = null
    }
  }

  const runFrame = (): void => {
    cancelFrame = null
    if (disposed) return
    if (isPaused()) {
      // 手势期间帧被节流后才执行：放弃本次 fit，并清掉此前排队的尾部，
      // 避免手势结束后旧定时器自动补发中间尺寸。
      cancelPending()
      return
    }
    runFit()
  }

  /** 排入下一帧；返回取消函数。 */
  const requestFrame = (): (() => void) => {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const id = globalThis.requestAnimationFrame(runFrame)
      return () => globalThis.cancelAnimationFrame(id)
    }
    // 非浏览器宿主（如 Node 单测）没有 rAF：退化为下一个宏任务，仍然保证
    // 同一轮事件循环里的 burst 只 fit 一次，不是用固定 16ms 伪造帧率。
    const id = setTimeout(runFrame, 0)
    return () => clearTimeout(id)
  }

  const runTail = (): void => {
    timer = null
    if (disposed) return
    if (isPaused()) return
    const generation = fitGeneration
    // 即使帧已执行，也必须核对当前可见性和网格，避免回写旧尺寸。
    runFit()
    // 补 fit 期间又收到事件：本次 fit 结果可能已是中间态，交给新排队的尾部。
    if (disposed || fitGeneration !== generation) return
    // 补 fit 期间手势开始（或 schedule 被暂停）：不通知，等释放后的显式 schedule。
    if (isPaused()) return

    // 字号/页签等路径可能已直接通知过 PTY；以外部最新基线为准，避免重复下发。
    let baseline = reportedSize
    if (options.getReportedSize) {
      try {
        const external = normalizeSize(options.getReportedSize())
        if (external) baseline = external
      } catch {
        // 读取外部基线失败时退回内部记录，不能因此阻断通知。
      }
    }
    if (!fittedSize || sameSize(fittedSize, baseline)) return

    const next = { cols: fittedSize.cols, rows: fittedSize.rows }
    try {
      options.notify(next)
      reportedSize = next
    } catch {
      // 通知失败不更新基线，下一次 schedule 的尾部还会重试；异常不能逃出定时器。
    }
  }

  const schedule = (): void => {
    if (disposed) return
    if (isPaused()) {
      // 手势进行中：不排队动画帧、不创建/重置尾部定时器，避免持续拖动时
      // 产生反复触发的计时器；释放后由调用方显式 schedule() 恢复。
      cancelPending()
      return
    }
    fitGeneration += 1

    if (cancelFrame === null) {
      cancelFrame = requestFrame()
    }

    // 每次事件都重置尾部窗口：只有事件真正停下来 delay 毫秒后才通知 PTY。
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(runTail, delay)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cancelPending()
  }

  return { schedule, dispose }
}
