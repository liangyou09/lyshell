import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createTerminalResizeScheduler,
  type TerminalResizeScheduler,
  type TerminalSize
} from './terminal-resize-scheduler'

const INITIAL: TerminalSize = { cols: 80, rows: 24 }

describe('终端 resize 调度器', () => {
  let geometry: TerminalSize | null
  let fit: Mock<[], TerminalSize | null>
  let notify: Mock<[size: TerminalSize], void>
  let notifyCalls: TerminalSize[]
  let frames: Map<number, FrameRequestCallback>
  let nextFrameId: number
  let requestFrame: Mock<[callback: FrameRequestCallback], number>
  let cancelFrame: Mock<[id: number], void>
  let scheduler: TerminalResizeScheduler | null
  let resizing: boolean

  const create = (options: { delay?: number; initialSize?: TerminalSize; getReportedSize?: () => TerminalSize | null; isResizing?: () => boolean } = {}): TerminalResizeScheduler => {
    scheduler = createTerminalResizeScheduler({
      fit,
      notify,
      initialSize: options.initialSize ?? INITIAL,
      ...(options.getReportedSize === undefined ? {} : { getReportedSize: options.getReportedSize }),
      ...(options.isResizing === undefined ? {} : { isResizing: options.isResizing }),
      ...(options.delay === undefined ? {} : { delay: options.delay })
    })
    return scheduler
  }

  /** 执行当前排队的第一帧（rAF 的测试替身不开真实 16ms 时钟）。 */
  const flushFrame = (): void => {
    const next = frames.entries().next()
    if (next.done) throw new Error('没有排队的动画帧')
    const [id, callback] = next.value
    frames.delete(id)
    callback(0)
  }

  beforeEach(() => {
    // 只假 setTimeout，动画帧由下面的手动队列驱动，避免用固定 16ms 伪造显示器帧率。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    geometry = { ...INITIAL }
    notifyCalls = []
    fit = vi.fn(() => (geometry ? { ...geometry } : null))
    notify = vi.fn((size: TerminalSize) => {
      notifyCalls.push({ ...size })
    })
    frames = new Map()
    nextFrameId = 0
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    })
    cancelFrame = vi.fn((id: number) => {
      frames.delete(id)
    })
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    scheduler = null
    resizing = false
  })

  afterEach(() => {
    scheduler?.dispose()
    vi.clearAllTimers()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('合并同一帧内的 burst：fit 每帧一次，尾部只通知最终尺寸', () => {
    const s = create()

    s.schedule()
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    geometry = { cols: 132, rows: 43 }
    s.schedule()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(fit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    flushFrame()
    expect(fit).toHaveBeenCalledTimes(1)
    expect(notifyCalls).toEqual([])

    vi.advanceTimersByTime(149)
    expect(notifyCalls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(notifyCalls).toEqual([{ cols: 132, rows: 43 }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('连续拖动每帧 fit 一次，停下来只发一次最终尺寸', () => {
    const s = create()
    const dragged: TerminalSize[] = [
      { cols: 90, rows: 28 },
      { cols: 100, rows: 30 },
      { cols: 110, rows: 34 },
      { cols: 120, rows: 40 }
    ]

    dragged.forEach((size, index) => {
      geometry = size
      s.schedule()
      expect(frames.size).toBe(1)
      flushFrame()
      expect(fit).toHaveBeenCalledTimes(index + 1)
    })

    expect(notifyCalls).toEqual([])
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([dragged[3]])
  })

  it('尺寸未变化时后续尾部不重复通知', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }

    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])

    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toHaveLength(1)
  })

  it('一次 burst 内拖回 initialSize 不通知', () => {
    const s = create()

    s.schedule()
    flushFrame()
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    geometry = { ...INITIAL }
    s.schedule()
    flushFrame()

    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([])
  })

  it('已通知过别的尺寸后，拖回 initialSize 仍需通知 PTY', () => {
    const s = create()

    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)

    geometry = { ...INITIAL }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)

    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }, { ...INITIAL }])
  })

  it('隐藏时 fit 返回 null 不发旧尺寸，恢复后重新 schedule 可继续', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])

    // 隐藏：帧照常 fit 到 null，尾部不得拿上一次的 100x30 充数。
    geometry = null
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])

    // 隐藏期间帧被节流：尾部自己 fit 仍是 null，同样不能发旧尺寸。
    s.schedule()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
    flushFrame()

    // 恢复可见但尺寸没变：不重复通知。
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toHaveLength(1)

    // 恢复可见且尺寸变化：重新通知。
    geometry = { cols: 120, rows: 40 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }, { cols: 120, rows: 40 }])
  })

  it('尾部早于最后一帧触发时先补 fit，迟到帧不会重复通知', () => {
    const s = create()
    geometry = { cols: 90, rows: 28 }
    s.schedule()
    expect(frames.size).toBe(1)

    // 帧被节流：尾部定时器先到，必须先 fit 再通知。
    vi.advanceTimersByTime(150)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(notifyCalls).toEqual([{ cols: 90, rows: 28 }])

    // 迟到的帧仍按「每帧最多 fit 一次」执行，但不得再次通知。
    flushFrame()
    expect(fit).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(notifyCalls).toHaveLength(1)
  })

  it('fit 同步触发 schedule 时，尾部仍会补 fit 最新尺寸', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }
    let nested = false
    fit.mockImplementation(() => {
      const result = geometry ? { ...geometry } : null
      if (!nested) {
        // 模拟 xterm.resize 的同步 resize 回调再调一次 schedule。
        nested = true
        geometry = { cols: 110, rows: 34 }
        s.schedule()
      }
      return result
    })

    s.schedule()
    flushFrame()
    expect(fit).toHaveBeenCalledTimes(1)

    // 嵌套帧尚未执行，尾部必须先 fit 到 110x34，不能通知这次 fit 的 100x30。
    vi.advanceTimersByTime(150)
    expect(fit).toHaveBeenCalledTimes(2)
    expect(notifyCalls).toEqual([{ cols: 110, rows: 34 }])
  })

  it('尾部补 fit 期间又收到事件时，不通知已过期的中间尺寸', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }
    let nested = false
    fit.mockImplementation(() => {
      const result = geometry ? { ...geometry } : null
      if (!nested) {
        nested = true
        geometry = { cols: 110, rows: 34 }
        s.schedule()
      }
      return result
    })

    // 帧被节流，尾部先到：fit 读到 100x30 期间又来了 110x34。
    s.schedule()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([])

    // 新排队的尾部补 fit 到最新尺寸后只通知一次。
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 110, rows: 34 }])
  })

  it('getReportedSize 反映外部已通知尺寸时不重复下发', () => {
    let reported: TerminalSize = { ...INITIAL }
    const s = create({ getReportedSize: () => reported })
    notify.mockImplementation((size: TerminalSize) => {
      notifyCalls.push({ ...size })
      reported = { ...size }
    })

    // 字号/页签等路径已直接通知 PTY：尾部不再重复。
    geometry = { cols: 100, rows: 30 }
    reported = { ...geometry }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([])

    // 外部基线未覆盖的新尺寸仍要通知，并同步回外部记录。
    geometry = { cols: 120, rows: 40 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 120, rows: 40 }])
    expect(reported).toEqual({ cols: 120, rows: 40 })

    // 外部基线是 120x40 时，拖回 initialSize 仍需通知。
    geometry = { ...INITIAL }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 120, rows: 40 }, { ...INITIAL }])
  })

  it('getReportedSize 抛错时回退内部基线，不产生未处理异常', () => {
    const s = create({
      getReportedSize: () => {
        throw new Error('reported boom')
      }
    })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    expect(() => vi.advanceTimersByTime(150)).not.toThrow()
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
  })

  it('帧完成后容器隐藏，尾部不能把缓存尺寸通知 PTY', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()

    // visibility:hidden 不改变容器尺寸，不保证再有 ResizeObserver 回调。
    geometry = null
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([])
  })

  it('帧完成后外部路径已 fit 并通知新尺寸，尾部不能回写旧尺寸', () => {
    let reported: TerminalSize = { ...INITIAL }
    const s = create({ getReportedSize: () => reported })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()

    // 字号/页签路径直接 fit，不改变外层容器尺寸。
    geometry = { cols: 120, rows: 40 }
    reported = { ...geometry }
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([])
  })

  it('dispose 取消 rAF 返回 0 的帧与尾部定时器，之后 schedule 无效', () => {
    const s = create()
    s.schedule()

    expect(requestFrame).toHaveReturnedWith(0)
    expect(frames.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    s.dispose()
    expect(cancelFrame).toHaveBeenCalledWith(0)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(1000)
    expect(fit).not.toHaveBeenCalled()
    expect(notifyCalls).toEqual([])

    s.schedule()
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose 在尾部通知前取消，不会补发最终尺寸', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    expect(fit).toHaveBeenCalledTimes(1)

    s.dispose()
    vi.advanceTimersByTime(1000)
    expect(notifyCalls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('每次 schedule 都重置尾部窗口，并支持自定义 delay', () => {
    const s = create({ delay: 50 })
    geometry = { cols: 100, rows: 30 }

    s.schedule()
    vi.advanceTimersByTime(40)
    s.schedule()
    vi.advanceTimersByTime(40)
    expect(notifyCalls).toEqual([])

    vi.advanceTimersByTime(10)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
  })

  it('fit 抛错不逃逸；尾部重试成功后再通知', () => {
    const s = create()
    fit.mockImplementationOnce(() => {
      throw new Error('fit boom')
    })
    geometry = { cols: 100, rows: 30 }

    s.schedule()
    expect(() => flushFrame()).not.toThrow()
    expect(notifyCalls).toEqual([])

    expect(() => vi.advanceTimersByTime(150)).not.toThrow()
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
  })

  it('fit 持续抛错时保持静默，不产生未处理异常', () => {
    const s = create()
    fit.mockImplementation(() => {
      throw new Error('fit boom')
    })
    geometry = { cols: 100, rows: 30 }

    s.schedule()
    expect(() => {
      flushFrame()
      vi.advanceTimersByTime(150)
    }).not.toThrow()
    expect(notifyCalls).toEqual([])
  })

  it('notify 抛错不逃逸且不更新基线，下一次 schedule 会重试', () => {
    const s = create()
    notify.mockImplementationOnce(() => {
      throw new Error('notify boom')
    })
    geometry = { cols: 100, rows: 30 }

    s.schedule()
    flushFrame()
    expect(() => vi.advanceTimersByTime(150)).not.toThrow()
    expect(notify).toHaveBeenCalledTimes(1)

    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
  })

  it('非法尺寸不通知，恢复合法尺寸后正常通知', () => {
    const s = create()
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])

    const invalid: TerminalSize[] = [
      { cols: 100.5, rows: 30 },
      { cols: 0, rows: 30 },
      { cols: 120, rows: -1 }
    ]
    invalid.forEach(size => {
      geometry = size
      s.schedule()
      flushFrame()
      vi.advanceTimersByTime(150)
      expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
    })

    geometry = { cols: 120, rows: 40 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }, { cols: 120, rows: 40 }])
  })

  it('initialSize 非法时，首个合法尺寸仍会通知', () => {
    const s = create({ initialSize: { cols: 0, rows: 0 } })
    geometry = { ...INITIAL }

    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ ...INITIAL }])
  })

  it('手势期间不排队帧与定时器，释放后显式 schedule 按最新尺寸只通知一次', () => {
    const s = create({ isResizing: () => resizing })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    expect(fit).toHaveBeenCalledTimes(1)

    // 手势开始后即使 ResizeObserver 继续触发 schedule，也不排队、不建定时器。
    resizing = true
    s.schedule()
    s.schedule()
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(fit).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(notifyCalls).toEqual([])

    // 释放本身不会自动恢复：释放时显式 schedule，尾部按最新尺寸比较后只发一次。
    geometry = { cols: 132, rows: 43 }
    resizing = false
    s.schedule()
    expect(frames.size).toBe(1)
    flushFrame()
    expect(fit).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(149)
    expect(notifyCalls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(notifyCalls).toEqual([{ cols: 132, rows: 43 }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('暂停会放弃手势前已排队的尾部，不补 fit 也不通知', () => {
    const s = create({ isResizing: () => resizing })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    expect(frames.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    resizing = true
    // 尾部先到：暂停时不补 fit，也不能把中间尺寸发给 PTY。
    vi.advanceTimersByTime(150)
    expect(fit).not.toHaveBeenCalled()
    expect(notifyCalls).toEqual([])

    // 迟到的帧执行时仍暂停：不 fit。
    flushFrame()
    expect(fit).not.toHaveBeenCalled()
  })

  it('暂停中先到的帧放弃 fit，并清掉已排队的尾部定时器', () => {
    const s = create({ isResizing: () => resizing })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    resizing = true

    flushFrame()
    expect(fit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(1000)
    expect(fit).not.toHaveBeenCalled()
    expect(notifyCalls).toEqual([])
  })

  it('释放后没有显式 schedule 时不会自动补发', () => {
    const s = create({ isResizing: () => resizing })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    resizing = true
    vi.advanceTimersByTime(150)
    flushFrame()

    resizing = false
    vi.advanceTimersByTime(1000)
    expect(fit).not.toHaveBeenCalled()
    expect(notifyCalls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('暂停不清空基线，恢复后尺寸未变则不重复通知', () => {
    const s = create({ isResizing: () => resizing })
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])

    // 手势中尺寸变了也不发；基线仍是 100x30。
    resizing = true
    geometry = { cols: 120, rows: 40 }
    s.schedule()
    vi.advanceTimersByTime(200)
    expect(notifyCalls).toHaveLength(1)

    // 释放后拖回基线尺寸：不需要重复通知。
    resizing = false
    geometry = { cols: 100, rows: 30 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toHaveLength(1)
  })

  it('尾部补 fit 期间手势开始时不通知中间尺寸，释放后再通知最新尺寸', () => {
    const s = create({ isResizing: () => resizing })
    geometry = { cols: 100, rows: 30 }
    let flipped = false
    fit.mockImplementation(() => {
      const result = geometry ? { ...geometry } : null
      if (!flipped) {
        flipped = true
        resizing = true
        s.schedule()
      }
      return result
    })

    s.schedule()
    vi.advanceTimersByTime(150)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(notifyCalls).toEqual([])

    // 释放后显式 schedule 才会按最新尺寸通知。
    resizing = false
    geometry = { cols: 110, rows: 34 }
    s.schedule()
    flushFrame()
    vi.advanceTimersByTime(150)
    expect(notifyCalls).toEqual([{ cols: 110, rows: 34 }])
  })

  it('isResizing 抛错时按未暂停处理，保持默认行为', () => {
    const s = create({
      isResizing: () => {
        throw new Error('flag boom')
      }
    })
    geometry = { cols: 100, rows: 30 }

    s.schedule()
    expect(() => {
      flushFrame()
      vi.advanceTimersByTime(150)
    }).not.toThrow()
    expect(notifyCalls).toEqual([{ cols: 100, rows: 30 }])
  })

  it('暂停期间 dispose 不留下帧或定时器，之后 schedule 无效', () => {
    resizing = true
    const s = create({ isResizing: () => resizing })
    s.schedule()
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    s.dispose()
    resizing = false
    s.schedule()
    vi.advanceTimersByTime(1000)
    expect(fit).not.toHaveBeenCalled()
    expect(notifyCalls).toEqual([])
  })
})
