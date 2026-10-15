import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { findPane, usePaneStore } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { useEscDismiss } from '../../hooks'
import TerminalSearchPanel from '../Terminal/TerminalSearchPanel'
import { findTextRanges } from './dom-search'

export const FIND_IN_TAB_EVENT = 'lyshell:find-in-tab'
let nextHighlightId = 0
interface HighlightWindow extends Window {
  CSS?: { highlights?: Map<string, unknown> }
  Highlight?: new (...ranges: Range[]) => unknown
}

/** 非终端页签的当前内容查找；搜索浮层不进入被搜索的内容树。 */
export default function SearchableTab({ id, children, className = 'relative w-full h-full', web = false }: {
  id: string; children: React.ReactNode; className?: string; web?: boolean
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [matchInfo, setMatchInfo] = useState({ idx: -1, total: 0 })
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const rangesRef = useRef<Range[]>([])
  const indexRef = useRef(-1)
  const requestRef = useRef<number | null>(null)
  const [highlightId] = useState(() => `tab-search-${++nextHighlightId}`)
  const cleanHighlights = useRef<() => void>(() => {})
  const active = usePaneStore(s => {
    const pane = findPane(s.layout.root, s.layout.activePaneId)
    return pane?.type === 'leaf' && pane.overlays.some(r => r.id === id && r.active)
  })
  let invalidRegex = false
  if (!web && regex && query) {
    try { new RegExp(query, caseSensitive ? 'gu' : 'giu') } catch { invalidRegex = true }
  }
  const guest = useCallback(() => rootRef.current?.querySelector<WebviewTag>('webview') ?? null, [])
  const clear = useCallback(() => {
    cleanHighlights.current()
    rangesRef.current = []
    indexRef.current = -1
    requestRef.current = null
    if (web) { try { guest()?.stopFindInPage('clearSelection') } catch { /* guest 未就绪 */ } }
  }, [guest, web])
  const close = useCallback(() => { setOpen(false); setDragging(false); clear() }, [clear])
  useEscDismiss(open && active, close)
  const reveal = useCallback(() => {
    if (useUiStore.getState().paletteOpen) return
    setOpen(true)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }, [])

  // iframe 的按键不会冒泡到宿主；分别接入其 window，不放宽文档沙箱。
  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      if (useUiStore.getState().paletteOpen) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.isComposing && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        reveal()
      }
    }
    const forwarded = () => reveal()
    window.addEventListener('keydown', keydown, true)
    window.addEventListener(FIND_IN_TAB_EVENT, forwarded)
    const frames = new Map<HTMLIFrameElement, Window>()
    const bind = () => {
      rootRef.current?.querySelectorAll('iframe').forEach(frame => {
        try {
          frames.get(frame)?.removeEventListener('keydown', keydown, true)
          if (frame.contentWindow) {
            frame.contentWindow.addEventListener('keydown', keydown, true)
            frames.set(frame, frame.contentWindow)
          }
        } catch { /* 只访问同源惰性 HTML 文档 */ }
      })
    }
    bind()
    const root = rootRef.current!
    root.addEventListener('load', bind, true)
    const observer = new MutationObserver(bind)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener(FIND_IN_TAB_EVENT, forwarded)
      root.removeEventListener('load', bind, true)
      observer.disconnect()
      frames.forEach(frameWindow => { try { frameWindow.removeEventListener('keydown', keydown, true) } catch { /* 已导航 */ } })
    }
  }, [active, reveal])

  // 点击 guest/iframe 后同步所属 pane，防止另一分屏的搜索框消费快捷键。
  useEffect(() => {
    const root = rootRef.current!
    const activate = () => {
      const state = usePaneStore.getState()
      const paneId = state.getOverlayPaneId(id)
      if (paneId && state.layout.activePaneId !== paneId) state.setActivePane(paneId)
    }
    const blur = () => {
      const element = document.activeElement
      if (element?.matches('webview,iframe') && root.contains(element)) activate()
    }
    root.addEventListener('focus', activate, true)
    window.addEventListener('blur', blur)
    return () => { root.removeEventListener('focus', activate, true); window.removeEventListener('blur', blur) }
  }, [id])

  const selectRange = useCallback((index: number) => {
    const ranges = rangesRef.current
    if (!ranges.length) return
    indexRef.current = (index + ranges.length) % ranges.length
    const range = ranges[indexRef.current]
    const doc = range.startContainer.ownerDocument!
    const win = doc.defaultView as HighlightWindow
    if (win.Highlight && win.CSS?.highlights) {
      win.CSS.highlights.set(`${highlightId}-active`, new win.Highlight(range))
    } else {
      const selection = doc.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    range.startContainer.parentElement?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
    setMatchInfo(info => ({ ...info, idx: indexRef.current }))
  }, [highlightId])

  useEffect(() => {
    clear()
    setMatchInfo({ idx: -1, total: 0 })
    if (!open || !active || !query || invalidRegex) return
    const root = rootRef.current!
    if (web) {
      const view = guest()
      if (!view) return
      const run = () => {
        try { requestRef.current = view.findInPage(query, { matchCase: caseSensitive, findNext: false }) } catch { /* 等待 dom-ready */ }
      }
      const found = (event: Event) => {
        const result = (event as Event & { result: { requestId: number; activeMatchOrdinal: number; matches: number } }).result
        if (result?.requestId !== requestRef.current) return
        setMatchInfo({ idx: result.activeMatchOrdinal - 1, total: result.matches })
      }
      const navigating = () => { requestRef.current = null; setMatchInfo({ idx: -1, total: 0 }) }
      view.addEventListener('found-in-page', found)
      view.addEventListener('dom-ready', run)
      view.addEventListener('did-start-loading', navigating)
      view.addEventListener('did-stop-loading', run)
      run()
      return () => {
        view.removeEventListener('found-in-page', found)
        view.removeEventListener('dom-ready', run)
        view.removeEventListener('did-start-loading', navigating)
        view.removeEventListener('did-stop-loading', run)
        clear()
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let frameObserver: MutationObserver | undefined
    const run = () => {
      cleanHighlights.current()
      frameObserver?.disconnect()
      const frame = root.querySelector('iframe')
      let target = root.querySelector<HTMLElement>('[data-tab-search-content] .doc-content, [data-tab-search-content].doc-content')
        ?? root.querySelector<HTMLElement>('[data-tab-search-content]') ?? root
      try { if (frame?.contentDocument?.body) target = frame.contentDocument.body } catch { /* 不读跨源 frame */ }
      const doc = target.ownerDocument
      const win = doc.defaultView as HighlightWindow
      const { ranges, truncated } = findTextRanges(target, query, { caseSensitive, regex, wholeWord })
      rangesRef.current = ranges
      indexRef.current = -1
      const name = highlightId
      const style = doc.createElement('style')
      style.textContent = `::highlight(${name}){background:#ffcf6b;color:#332100}::highlight(${name}-active){background:#a74b00;color:#ffffff}`
      doc.head.appendChild(style)
      if (win.Highlight) win.CSS?.highlights?.set(name, new win.Highlight(...ranges))
      cleanHighlights.current = () => {
        win.CSS?.highlights?.delete(name)
        win.CSS?.highlights?.delete(`${name}-active`)
        // 没有 Highlight API 的环境只清理本搜索选中的 range。
        const selection = doc.getSelection()
        if (selection?.rangeCount && ranges.includes(selection.getRangeAt(0))) selection.removeAllRanges()
        style.remove()
      }
      setMatchInfo({ idx: ranges.length ? 0 : -1, total: truncated ? -1 : ranges.length })
      selectRange(0)
      if (frame && target !== root) {
        frameObserver = new MutationObserver(schedule)
        frameObserver.observe(target, { subtree: true, childList: true, characterData: true })
      }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 120) }
    const observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-search-panel]'))) schedule()
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    root.addEventListener('load', schedule, true)
    run()
    return () => { clearTimeout(timer); observer.disconnect(); frameObserver?.disconnect(); root.removeEventListener('load', schedule, true); clear() }
  }, [open, active, query, caseSensitive, regex, wholeWord, invalidRegex, web, guest, clear, selectRange, highlightId])

  useEffect(() => {
    if (!dragging || !open || !active) return
    const move = (event: MouseEvent) => {
      const root = rootRef.current!
      const rect = root.getBoundingClientRect()
      const panel = root.querySelector('[data-search-panel]')!.getBoundingClientRect()
      setPosition({ x: Math.max(0, Math.min(event.clientX - rect.left - dragOffset.current.x, rect.width - panel.width)), y: Math.max(0, Math.min(event.clientY - rect.top - dragOffset.current.y, rect.height - 32)) })
    }
    const stop = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop) }
  }, [dragging, open, active])
  const search = (direction: 'next' | 'prev') => {
    if (!query || invalidRegex) return
    if (web) {
      try { requestRef.current = guest()?.findInPage(query, { forward: direction === 'next', findNext: true, matchCase: caseSensitive }) ?? null } catch { /* 未就绪 */ }
    } else selectRange(indexRef.current + (direction === 'next' ? 1 : -1))
  }
  return <div ref={rootRef} className={className}>
    {children}
    {open && active && <TerminalSearchPanel inputRef={inputRef} position={position} isDragging={dragging}
      searchText={query} searchScope="current" caseSensitive={caseSensitive} useRegex={regex} wholeWord={wholeWord}
      invalidRegex={invalidRegex} matchInfo={matchInfo} showScope={false} showAdvanced={!web}
      onDragStart={event => {
        if (event.button !== 0) return
        event.preventDefault()
        const rect = rootRef.current!.querySelector('[data-search-panel]')!.getBoundingClientRect()
        dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        setDragging(true)
      }}
      onSearchChange={setQuery} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); search(event.shiftKey ? 'prev' : 'next') } }}
      onSearch={search} onClose={close} onCaseSensitiveChange={() => setCaseSensitive(value => !value)}
      onRegexChange={() => setRegex(value => !value)} onWholeWordChange={() => setWholeWord(value => !value)} onScopeChange={() => {}} />}
  </div>
}
