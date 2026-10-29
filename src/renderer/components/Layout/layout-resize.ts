/**
 * 布局手势租约（纯逻辑，不依赖 React / DOM / Electron / 定时器）。
 *
 * 侧栏、分屏等拖动会持续若干帧，期间应暂停"按容器尺寸做昂贵适配"的工作。
 * 这里只维护一个租约计数：
 *  - beginLayoutResize() 每次获取一个独立租约，返回的 release 只释放自己；
 *  - 只有租约数在 0 与 >=1 之间跨越时才通知订阅者，因此两个手势重叠时，
 *    先结束的那个不会让观察者误以为拖动已经结束；
 *  - release 幂等，重复调用不会把计数减成负数。
 *
 * 订阅者只收到状态变化（true/false），订阅时不会回放当前状态。模块不启动
 * 任何定时器，也不假设手势结束后会自动恢复：调用方收到 active=false 后，
 * 自行决定是否重新调度（例如对终端 resize 调度器调用一次 schedule()）。
 */

export type LayoutResizeListener = (active: boolean) => void

let leaseCount = 0
const listeners = new Set<LayoutResizeListener>()

/** 同步通知当前一轮订阅者；单个订阅者抛错不能阻断其他订阅者。 */
function notify(active: boolean): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(active)
    } catch {
      // 订阅者异常不应让 begin/release 的调用方（指针事件处理器）失败。
    }
  }
}

/** 获取一个布局手势租约；返回幂等的释放函数。 */
export function beginLayoutResize(): () => void {
  leaseCount += 1
  if (leaseCount === 1) notify(true)

  let released = false
  return () => {
    if (released) return
    released = true
    leaseCount -= 1
    if (leaseCount === 0) notify(false)
  }
}

/** 当前是否至少有一个手势租约处于活动状态。 */
export function isLayoutResizing(): boolean {
  return leaseCount > 0
}

/** 订阅手势活动状态变化；返回取消订阅函数。 */
export function subscribeLayoutResize(listener: LayoutResizeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
