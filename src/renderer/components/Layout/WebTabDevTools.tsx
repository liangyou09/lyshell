import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import type { BrowserDevToolsBounds } from '@shared/browser-devtools'
import { usePaneStore } from '../../stores/pane-store'

/** 页签内的 DevTools 承载区：仅主进程能将它绑定到同一宿主的网页 guest。 */
export default function WebTabDevTools({ id, pageRef, onClose, inspectPoint }: {
  id: string; pageRef: React.RefObject<WebviewTag>; onClose: () => void; inspectPoint?: { x: number; y: number }
}): JSX.Element {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(42)
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState(false)

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    const page = pageRef.current
    if (!surface || !page) { setFailed(true); return }
    let pageId: number
    try { pageId = page.getWebContentsId() } catch {
      // 切换开关与布局 effect 之间 guest 也可能已销毁，按打开失败呈现而非崩溃。
      setFailed(true)
      return
    }
    let disposed = false
    let opened = false
    let inspectorId: number | undefined
    let frame: number | undefined
    let lastBounds = ''
    const rectBounds = (): BrowserDevToolsBounds => {
      const rect = surface.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const visibleBounds = (): BrowserDevToolsBounds | null => {
      const bounds = rectBounds()
      if (!bounds.width || !bounds.height || getComputedStyle(surface).visibility === 'hidden') return null
      // 原生子视图位于宿主 DOM 之上；页签隐藏、拖动盾或弹层遮住承载区时必须同步隐藏。
      for (const overlay of document.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"],[role="menu"],dialog[open],.fixed')) {
        if (overlay.contains(surface) || surface.contains(overlay)) continue
        const style = getComputedStyle(overlay)
        if (style.visibility === 'hidden' || style.display === 'none' ||
          (!overlay.matches('[role="dialog"],[aria-modal="true"],[role="menu"],dialog[open]') && !(Number(style.zIndex) >= 20))) continue
        const rect = overlay.getBoundingClientRect()
        if (rect.width && rect.height && rect.left < bounds.x + bounds.width && rect.right > bounds.x &&
          rect.top < bounds.y + bounds.height && rect.bottom > bounds.y) return null
      }
      for (const x of [0.05, 0.5, 0.95]) for (const y of [0.05, 0.5, 0.95]) {
        const top = document.elementFromPoint(bounds.x + bounds.width * x, bounds.y + bounds.height * y)
        if (!top || !surface.contains(top)) return null
      }
      return bounds
    }
    const sync = (): void => {
      if (!opened || disposed || inspectorId === undefined) return
      const bounds = visibleBounds()
      const key = JSON.stringify(bounds)
      if (key === lastBounds) return
      lastBounds = key
      void window.electronAPI.webTabDevTools({ kind: 'layout', pageId, inspectorId, bounds }).catch(() => {})
    }
    const schedule = (): void => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => { frame = undefined; sync() })
    }
    const activate = (): void => {
      const state = usePaneStore.getState()
      const paneId = state.getOverlayPaneId(id)
      if (paneId && state.layout.activePaneId !== paneId) state.setActivePane(paneId)
    }
    const unsubscribe = window.electronAPI.onWebTabDevToolsEvent(event => {
      if (event.kind === 'inspect' || event.pageId !== pageId || event.inspectorId !== inspectorId) return
      if (event.kind === 'focus') activate()
      else onClose()
    })
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(surface)
    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
    window.addEventListener('resize', schedule)
    // 不先导航空白页：主进程创建全新的 WebContentsView 后直接绑定调试目标。
    void window.electronAPI.webTabDevTools({ kind: 'open', pageId, bounds: visibleBounds() ?? { x: 0, y: 0, width: 0, height: 0 } })
      .then(result => {
        inspectorId = result.inspectorId
        if (disposed) {
          if (result.success && inspectorId !== undefined) void window.electronAPI.webTabDevTools({ kind: 'close', pageId, inspectorId }).catch(() => {})
          return
        }
        opened = result.success
        setFailed(!result.success)
        if (result.success && inspectPoint) page.inspectElement(inspectPoint.x, inspectPoint.y)
        sync()
      }).catch(() => { if (!disposed) setFailed(true) })
    return () => {
      disposed = true
      unsubscribe()
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (inspectorId !== undefined) void window.electronAPI.webTabDevTools({ kind: 'close', pageId, inspectorId }).catch(() => {})
    }
  }, [id, pageRef, onClose, inspectPoint])

  const resize = useCallback((clientY: number): void => {
    const rect = rootRef.current?.parentElement?.getBoundingClientRect()
    if (rect?.height) setHeight(Math.max(20, Math.min(75, (rect.bottom - clientY) / rect.height * 100)))
  }, [])

  // 原生视图显隐 / 跨 webview 拖动可能让 pointerup 落到拖动盾，窗口捕获负责兜底收尾。
  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent): void => resize(event.clientY)
    const end = (): void => setDragging(false)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('blur', end)
    }
  }, [dragging, resize])

  return (
    <div ref={rootRef} data-webtab-devtools={id} className="flex min-h-0 shrink-0 flex-col bg-[var(--bg-rack)]" style={{ height: `${height}%` }}>
      <div
        role="separator" tabIndex={0} aria-label={t('webBar.resizeDevtools')}
        aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={75} aria-valuenow={Math.round(height)}
        className="h-1 shrink-0 cursor-row-resize border-t border-[var(--rule)] hover:bg-[var(--amber)] focus-visible:bg-[var(--amber)] focus-visible:outline-none"
        style={{ touchAction: 'none' }}
        onPointerDown={event => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          setDragging(false)
        }}
        onLostPointerCapture={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          setHeight(value => event.key === 'Home' ? 20 : event.key === 'End' ? 75
            : Math.max(20, Math.min(75, value + (event.key === 'ArrowUp' ? 5 : -5))))
        }}
      />
      <div className="flex h-7 shrink-0 items-center justify-between px-2 text-xs text-[var(--text-rack)]">
        <span>{t('webBar.devtoolsTitle')}</span>
        <button type="button" onClick={onClose} title={t('webBar.closeDevtools')} aria-label={t('webBar.closeDevtools')}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--bg-elev)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--amber)]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {failed ? <div role="alert" className="flex flex-1 items-center justify-center px-4 text-sm text-[var(--text-rack)]">{t('webBar.devtoolsFailed')}</div> : null}
      <div ref={surfaceRef} data-webtab-devtools-surface="" className={failed ? 'hidden' : 'min-h-0 w-full flex-1'} />
      {dragging && <div className="absolute inset-0 z-20 cursor-row-resize" />}
    </div>
  )
}
