import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControlHandle } from '@shared/terminal-control'

/** 视图只持有 main 发放的句柄。拒绝后的输入不会重新获取句柄并重放。 */
export function useTerminalControl(sessionId: string, connected: boolean, active: boolean, automationHeld: boolean) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const control = useRef<ControlHandle>()
  const generation = useRef(0)
  useEffect(() => window.electronAPI?.onTerminalControlInvalidated?.(payload => {
    if (payload?.sessionId && payload.sessionId !== sessionId) return
    generation.current++
    control.current = undefined
    setReady(false)
    setError('')
  }), [sessionId])

  const acquire = useCallback(async (takeover: boolean) => {
    const current = generation.current
    try {
      const result = await window.electronAPI.terminalControl({ kind: takeover ? 'takeover' : 'acquire', sessionId })
      if (current !== generation.current) return
      if (!result.success || !result.control) throw new Error(result.error ?? 'Terminal control unavailable')
      control.current = result.control
      setReady(true)
      setError('')
    } catch (cause) {
      if (current !== generation.current) return
      control.current = undefined
      setReady(false)
      setError(cause instanceof Error ? cause.message : 'Terminal control unavailable')
    }
  }, [sessionId])

  useEffect(() => {
    const lifecycle = generation
    generation.current++
    setReady(false)
    control.current = undefined
    if (!connected || !active || automationHeld || !window.electronAPI?.terminalControl) return
    void acquire(false)
    const timer = setInterval(() => {
      const handle = control.current
      if (!handle) return
      if (Date.now() >= handle.expiresAt) {
        control.current = undefined
        setReady(false)
        return
      }
      if (document.visibilityState === 'hidden') return
      const current = generation.current
      void window.electronAPI.terminalControl({ kind: 'renew', control: handle }).then(result => {
        if (current !== generation.current) return
        if (!result.success || !result.control) {
          control.current = undefined
          setReady(false)
          setError(result.error ?? 'Terminal control expired')
          return
        }
        control.current = result.control
      }).catch(() => { if (current === generation.current) { control.current = undefined; setReady(false) } })
    }, 10_000)
    return () => { lifecycle.current++; clearInterval(timer) }
  }, [sessionId, connected, active, automationHeld, acquire])

  return { ready: ready && !automationHeld, error, takeControl: () => acquire(true) }
}
