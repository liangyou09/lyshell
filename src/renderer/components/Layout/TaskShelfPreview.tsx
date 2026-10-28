import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTerminalStore } from '../../stores/terminal-store'
import { paintTerminalPreview } from './task-shelf-terminal-preview'
import { registerShelfWebPreview } from './task-shelf-preview-sources'
import { subscribeShelfPreviewClock } from './task-shelf-preview-clock'
import type { WebviewTag } from 'electron'
import { getWebview } from './web-tab-controls'
import type { ShelfDecodedReservation, ShelfFrameLease, ShelfFrameToken } from './task-shelf-resource-budget'
import {
  acquireShelfDisplayFrame,
  currentShelfFrame,
  openShelfWebPreview,
  refreshShelfWebPreview,
  releaseShelfCanvas,
  releaseShelfDisplayFrame,
  reserveShelfCanvas,
  type ShelfWebPreviewHandle,
} from './task-shelf-web-frame'

function shelfWebview(kind: string, id: string): WebviewTag | undefined {
  return kind === 'web' ? getWebview(id) ?? undefined : [...document.querySelectorAll<WebviewTag>('webview[data-task-shelf-id]')].find(el => el.getAttribute('data-task-shelf-id') === id)
}

const sameToken = (a: ShelfFrameToken, b: ShelfFrameToken) =>
  a.instanceGeneration === b.instanceGeneration && a.navigationGeneration === b.navigationGeneration &&
  a.geometryRevision === b.geometryRevision && a.sequence === b.sequence

const resourceIdFor = (kind: string, id: string) => `shelf:${kind}:${id}`

/** 只读当前实例；不新建连接、不重放导航、不改变终端尺寸或焦点。 */
const TaskShelfPreview: React.FC<{
  kind?: string; id?: string; variant?: 'tile'; fallback?: React.ReactNode
}> = ({ kind, id, variant = 'tile', fallback }) => {
  const { t } = useTranslation()
  const root = useRef<HTMLSpanElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<{ live: boolean; image?: string; width?: number; height?: number }>({ live: false })

  useEffect(() => {
    let stopped = false
    let visible = typeof IntersectionObserver === 'undefined'
    let pending = false
    let unsubscribeClock: (() => void) | undefined
    let releasePreview: (() => void) | undefined
    let page: WebviewTag | undefined
    let webHandle: ShelfWebPreviewHandle | undefined
    let webLease: ShelfFrameLease | undefined
    let canvasReservation: ShelfDecodedReservation | undefined
    let pendingCanvas: ShelfDecodedReservation | undefined

    const idle = () => { if (!stopped) setState(old => old.live || old.image ? { live: false } : old) }

    const releaseWebLease = () => {
      if (webLease) { releaseShelfDisplayFrame(webLease); webLease = undefined }
    }

    const closeWeb = () => {
      releaseWebLease()
      if (webHandle) { webHandle.release(); webHandle = undefined }
      if (releasePreview) { releasePreview(); releasePreview = undefined }
      page = undefined
    }

    const releaseDisplay = (lease: ShelfFrameLease) => { releaseShelfDisplayFrame(lease) }

    const clearCanvas = () => {
      if (pendingCanvas) { releaseShelfCanvas(pendingCanvas); pendingCanvas = undefined }
      if (canvasReservation) { releaseShelfCanvas(canvasReservation); canvasReservation = undefined }
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0 }
    }

    const deactivate = () => {
      if (unsubscribeClock) { unsubscribeClock(); unsubscribeClock = undefined }
      closeWeb()
      clearCanvas()
      idle()
    }

    const updateWeb = async () => {
      if (!id) return
      const currentPage = shelfWebview(kind || 'web', id)
      if (!currentPage) { closeWeb(); idle(); return }
      if (page !== currentPage) {
        closeWeb()
        page = currentPage
        webHandle = openShelfWebPreview(currentPage, resourceIdFor(kind || 'web', id), 'bulkVisible') ?? undefined
        if (!webHandle) { page = undefined; idle(); return }
        releasePreview = registerShelfWebPreview(id)
      }
      if (!webHandle) return
      // 让透明后台 guest 完成一帧绘制；visibility:hidden 的 guest 没有可截取的表面。
      await new Promise(resolve => setTimeout(resolve, 50))
      if (stopped || !visible || document.hidden || !webHandle) return
      const bounds = page?.getBoundingClientRect?.()
      if (!bounds || !bounds.width || !bounds.height) { releaseWebLease(); idle(); return }
      await refreshShelfWebPreview(webHandle)
      if (stopped || !visible || document.hidden || !webHandle) return
      const view = currentShelfFrame(webHandle.resourceId)
      if (!view) {
        // 宽度变化或新一帧失败时，旧租约继续计入预算并缩放显示；离屏才释放。
        if (!webLease) idle()
        return
      }
      if (webLease && sameToken(webLease.token, view.token)) {
        setState(old => old.live ? old : { live: true, image: webLease?.frame.dataUrl, width: webLease?.frame.width, height: webLease?.frame.height })
        return
      }
      const next = acquireShelfDisplayFrame(webHandle.resourceId)
      if (!next) {
        if (webLease) { releaseDisplay(webLease); webLease = undefined }
        idle()
        return
      }
      const previous = webLease
      webLease = next
      if (previous) releaseDisplay(previous)
      setState({ live: true, image: next.frame.dataUrl, width: next.frame.width, height: next.frame.height })
    }

    const updateTerminal = () => {
      if (!id) return
      const terminal = useTerminalStore.getState().getTerminal(id)?.terminal
      const target = canvas.current
      if (!terminal || !target) { clearCanvas(); idle(); return }
      const ok = paintTerminalPreview(target, terminal, {
        beforeResize: (width, height) => {
          if (stopped || !visible || document.hidden) return false
          if (width === target.width && height === target.height && canvasReservation) return true
          const bytes = width * height * 4
          if (!Number.isSafeInteger(bytes) || bytes < 1) return false
          const reservation = reserveShelfCanvas(bytes)
          if (!reservation) return false
          pendingCanvas = reservation
          return true
        },
      })
      if (!ok) {
        // 画布 resize 后的绘制异常不能只归还账本，必须同时释放已经分配的像素。
        if (pendingCanvas) { clearCanvas(); idle(); return }
        if (!canvasReservation) idle()
        return
      }
      if (pendingCanvas) {
        if (canvasReservation) releaseShelfCanvas(canvasReservation)
        canvasReservation = pendingCanvas
        pendingCanvas = undefined
      }
      setState(old => old.live ? old : { live: true })
    }

    const update = async () => {
      if (stopped || !visible || document.hidden || pending || !id) return
      pending = true
      try {
        if (kind === 'terminal') updateTerminal()
        else await updateWeb()
      } catch {
        // 截图失败或实例未就绪：保留旧帧；下一次可见轮询自动重试。
      } finally { pending = false }
    }

    const syncVisibility = () => {
      if (!id || stopped || !visible || document.hidden) { deactivate(); return }
      if (!unsubscribeClock) unsubscribeClock = subscribeShelfPreviewClock(() => { void update() })
      void update()
    }

    setState({ live: false })
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      syncVisibility()
    }) : undefined
    if (root.current) observer?.observe(root.current)
    const onVisibility = () => { syncVisibility() }
    document.addEventListener('visibilitychange', onVisibility)
    syncVisibility()
    return () => {
      stopped = true
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      deactivate()
    }
  }, [kind, id])

  return <span ref={root} className={`task-shelf-preview is-${variant} ${kind === 'terminal' ? 'is-terminal' : ''} ${state.live ? 'is-live' : 'is-unavailable'}`} aria-hidden="true">
    {kind === 'terminal' && <canvas ref={canvas} hidden={!state.live} />}
    {state.image && <img src={state.image} alt="" draggable={false} />}
    {!state.live && <span className="task-shelf-preview-empty">{fallback || <><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 10 3 3-3 3m6 0h3"/></svg><span>{t(id ? 'taskShelf.previewUnavailable' : 'taskShelf.previewRestore')}</span></>}</span>}
  </span>
}

export default TaskShelfPreview
