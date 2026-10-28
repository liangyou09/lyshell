/** 应用级预览时钟：所有可见缩略图共用 500ms 节拍；无订阅时清掉 timer 与监听。 */
type Listener = () => void

const TICK_MS = 500
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | undefined
let visibilityBound = false

const tick = () => {
  if (typeof document !== 'undefined' && document.hidden) return
  for (const listener of [...listeners]) {
    try { listener() } catch { /* 单个缩略图失败不影响其他消费者 */ }
  }
}

const stopTimer = () => {
  if (timer !== undefined) { clearInterval(timer); timer = undefined }
}

const startTimer = () => {
  if (timer === undefined && listeners.size > 0) timer = setInterval(tick, TICK_MS)
}

const onVisibility = () => {
  if (typeof document !== 'undefined' && document.hidden) stopTimer()
  else { tick(); startTimer() }
}

/** 订阅者只在缩略图可见时存在；最后一个订阅释放后时钟完全停摆。 */
export function subscribeShelfPreviewClock(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    if (typeof document !== 'undefined') { document.addEventListener('visibilitychange', onVisibility); visibilityBound = true }
    if (typeof document === 'undefined' || !document.hidden) startTimer()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopTimer()
      if (visibilityBound && typeof document !== 'undefined') { document.removeEventListener('visibilitychange', onVisibility); visibilityBound = false }
    }
  }
}

/** 仅供测试观察：当前订阅数与 timer 是否存在。 */
export const shelfPreviewClockState = () => ({ listeners: listeners.size, running: timer !== undefined })
