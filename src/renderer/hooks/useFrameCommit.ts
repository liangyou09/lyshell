import { useCallback, useEffect, useRef } from 'react'

/** 高频指针只保留最新值；释放捕获时 flush，避免最后一次位移丢失。 */
export function useFrameCommit<T>(commit: (value: T) => void) {
  const callback = useRef(commit)
  callback.current = commit
  const frame = useRef<number | null>(null)
  const pending = useRef<{ value: T } | null>(null)
  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const next = pending.current
    pending.current = null
    if (next) callback.current(next.value)
  }, [])
  const schedule = useCallback((value: T) => {
    pending.current = { value }
    if (frame.current === null) frame.current = requestAnimationFrame(flush)
  }, [flush])
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    pending.current = null
  }, [])
  return { schedule, flush }
}
