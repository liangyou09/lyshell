import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTerminalStore } from '../../stores/terminal-store'
import { paintTerminalPreview } from './task-shelf-terminal-preview'
import { registerShelfWebPreview } from './task-shelf-preview-sources'
import type { WebviewTag } from 'electron'
import { getWebview } from './web-tab-controls'

function shelfWebview(kind: string, id: string): WebviewTag | undefined {
  return kind === 'web' ? getWebview(id) ?? undefined : [...document.querySelectorAll<WebviewTag>('webview[data-task-shelf-id]')].find(el => el.getAttribute('data-task-shelf-id') === id)
}
import { captureShelfWebFrame } from './task-shelf-web-frame'

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
    let releasePreview: (() => void) | undefined
    const syncVisibility = () => {
      if (id && kind !== 'terminal' && visible && !document.hidden) releasePreview ??= registerShelfWebPreview(id)
      else { releasePreview?.(); releasePreview = undefined }
    }
    const update = async () => {
      if (stopped || !visible || document.hidden || pending || !id) return
      pending = true
      try {
        if (kind === 'terminal') {
          const terminal = useTerminalStore.getState().getTerminal(id)?.terminal
          const target = canvas.current
          const live = !!terminal && !!target && paintTerminalPreview(target, terminal)
          if (!stopped) setState(old => old.live === live ? old : { live })
        } else {
          const page = shelfWebview(kind || 'web', id)
          if (!page) { if (!stopped) setState({ live: false }); return }
          // 让透明后台 guest 完成一帧绘制；visibility:hidden 的 guest 没有可截取的表面。
          await new Promise(resolve => setTimeout(resolve, 50))
          if (stopped || !visible || document.hidden) return
          const bounds = page.getBoundingClientRect?.()
          if (bounds && (!bounds.width || !bounds.height)) { setState({ live: false }); return }
          const frame = await captureShelfWebFrame(page)
          if (stopped) return
          setState(old => old.image === frame.image && old.live === !!frame.image && old.width === frame.width && old.height === frame.height ? old : { live: !!frame.image, ...frame })
        }
      } catch {
        // 实例未就绪、关闭或崩溃时撤下旧图，下一次可见轮询自动恢复。
        if (!stopped) setState({ live: false })
      } finally { pending = false }
    }
    setState({ live: false })
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      syncVisibility()
      if (visible) void update()
    }) : undefined
    if (root.current) observer?.observe(root.current)
    const onVisibility = () => { syncVisibility(); if (!document.hidden) void update() }
    document.addEventListener('visibilitychange', onVisibility)
    syncVisibility()
    void update()
    const timer = setInterval(() => { void update() }, 500)
    return () => { stopped = true; clearInterval(timer); observer?.disconnect(); releasePreview?.(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [kind, id])

  return <span ref={root} className={`task-shelf-preview is-${variant} ${kind === 'terminal' ? 'is-terminal' : ''} ${state.live ? 'is-live' : 'is-unavailable'}`} aria-hidden="true">
    {kind === 'terminal' && <canvas ref={canvas} hidden={!state.live} />}
    {state.image && <img src={state.image} alt="" draggable={false} />}
    {!state.live && <span className="task-shelf-preview-empty">{fallback || <><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 10 3 3-3 3m6 0h3"/></svg><span>{t(id ? 'taskShelf.previewUnavailable' : 'taskShelf.previewRestore')}</span></>}</span>}
  </span>
}

export default TaskShelfPreview
