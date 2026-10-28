import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { useTranslation } from 'react-i18next'
import type { QuickCommand } from '@shared/types'
import type { WebTerminalResult } from '@shared/web-terminal'
import { usePaneStore, useQuickCommandsStore } from '../../stores'
import { activeWebTabId } from './web-tab-controls'
import { registerWebTerminalCommand } from './web-terminal-command'
import { WEB_SCRIPT_LIMIT, waitWebTerminalDelay, webTerminalLines } from './web-terminal-script'
import './WebTerminalTools.css'
import { publishWebTerminalState } from './web-terminal-state'

/** 页签常驻，草稿只留内存。网络恢复、页签切换均不重放输入。 */
export default function WebTerminalTools({ id, pageRef }: { id: string; pageRef: React.RefObject<WebviewTag> }): JSX.Element {
  const { t } = useTranslation()
  const commands = useQuickCommandsStore(state => state.commands)
  const groups = useQuickCommandsStore(state => state.groups)
  const [open, setOpen] = useState(false)
  const [terminalCount, setTerminalCount] = useState(0)
  const [draft, setDraft] = useState('')
  const [binding, setBinding] = useState<{ pageId: number; bindingId: string }>()
  const [bindingBusy, setBindingBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [delay, setDelay] = useState(150)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState({ sent: 0, total: 0 })
  const abort = useRef<AbortController>()
  const generation = useRef(0)
  const busy = useRef(false)
  const alive = useRef(true)
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  const probing = useRef(false)
  const pendingDiscovery = useRef<Promise<WebTerminalResult>>()
  const navigating = useRef(false)
  const toggle = useCallback(() => setOpen(value => !value), [])
  const editor = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    publishWebTerminalState(id, { count: terminalCount, bound: !!binding && !offline, offline, open, toggle })
  }, [id, terminalCount, binding, offline, open, toggle])
  useEffect(() => () => publishWebTerminalState(id), [id])

  const invalidate = useCallback(() => {
    generation.current++
    abort.current?.abort()
    const old = bindingRef.current
    bindingRef.current = undefined
    setBinding(undefined)
    if (old) void window.electronAPI.webTerminal({ kind: 'release', ...old }).catch(() => {})
  }, [])

  const discover = useCallback(async (): Promise<void> => {
    if (!alive.current || probing.current || busy.current || navigating.current || !navigator.onLine || activeWebTabId() !== id) return
    probing.current = true
    const current = generation.current
    try {
      const pageId = pageRef.current?.getWebContentsId()
      if (!pageId) return
      const pending = window.electronAPI.webTerminal({ kind: 'discover', pageId })
      pendingDiscovery.current = pending
      const result = await pending
      if (!alive.current || current !== generation.current) {
        if (result.bindingId) void window.electronAPI.webTerminal({ kind: 'release', pageId, bindingId: result.bindingId }).catch(() => {})
        return
      }
      if (activeWebTabId() !== id) return
      if (!result.success) {
        if (result.error !== 'busy') { invalidate(); setTerminalCount(0) }
        return
      }
      setTerminalCount(result.terminalCount ?? 0)
      const previous = bindingRef.current
      if (result.bindingId) {
        if (previous?.bindingId !== result.bindingId) {
          const next = { pageId, bindingId: result.bindingId }
          bindingRef.current = next
          setBinding(next)
          // 执行结果保持可见，自动识别不覆盖发送结果或不确定提示。
          setStatus(value => ['', 'rebind', 'bound', 'unsupported', 'stale', 'unavailable', 'offline'].includes(value) ? 'bound' : value)
        }
      } else if (previous) {
        bindingRef.current = undefined
        setBinding(undefined)
        setStatus(value => value === 'uncertain' ? value : 'rebind')
      }
    } catch { if (alive.current && current === generation.current) invalidate() }
    finally { probing.current = false; pendingDiscovery.current = undefined }
  }, [id, pageRef, invalidate])

  useEffect(() => {
    alive.current = true
    const page = pageRef.current
    const navigation = (event: Event): void => {
      // iframe 的导航也使绑定失效，SPA 路由同样需要重新确认目标。
      const inPlace = (event as Event & { isInPlace?: boolean }).isInPlace
      if (event.type === 'did-start-navigation' && inPlace) return
      navigating.current = event.type !== 'did-navigate-in-page' &&
        (event.type !== 'did-start-navigation' || (event as Event & { isMainFrame?: boolean }).isMainFrame !== false)
      invalidate()
      setTerminalCount(0)
      setStatus('rebind')
    }
    const ready = (): void => { navigating.current = false; void discover() }
    const network = (): void => {
      setOffline(!navigator.onLine)
      if (!navigator.onLine) { invalidate(); setStatus('offline') }
      else void discover()
    }
    const events = ['did-start-navigation', 'did-navigate-in-page', 'render-process-gone', 'destroyed']
    events.forEach(name => page?.addEventListener(name, navigation))
    page?.addEventListener('dom-ready', ready)
    page?.addEventListener('did-finish-load', ready)
    // 导航失败/取消后不一定再有 dom-ready，加载停止时也解除探测暂停。
    page?.addEventListener('did-stop-loading', ready)
    window.addEventListener('offline', network)
    window.addEventListener('online', network)
    let wasActive = activeWebTabId() === id
    const unsubscribe = usePaneStore.subscribe(() => {
      const active = activeWebTabId() === id
      if (!active && busy.current) abort.current?.abort()
      if (active && !wasActive) void discover()
      wasActive = active
    })
    const timer = window.setInterval(() => void discover(), 1500)
    void discover()
    return () => {
      alive.current = false
      invalidate()
      unsubscribe()
      window.clearInterval(timer)
      page?.removeEventListener('dom-ready', ready)
      page?.removeEventListener('did-finish-load', ready)
      page?.removeEventListener('did-stop-loading', ready)
      events.forEach(name => page?.removeEventListener(name, navigation))
      window.removeEventListener('offline', network)
      window.removeEventListener('online', network)
    }
  }, [id, pageRef, invalidate, discover])

  useEffect(() => registerWebTerminalCommand(id, (command: QuickCommand) => {
    setOpen(true)
    if (busy.current) { setStatus('busy'); return }
    // 网页输入保持字面文本；PTY 的控制字符转义不能注入网页。
    setDraft(command.content)
    setStatus(command.escapeSequences ? 'literal' : 'staged')
    requestAnimationFrame(() => editor.current?.focus())
  }), [id])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => editor.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const bind = async (): Promise<void> => {
    if (busy.current || bindingBusy || probing.current) return
    invalidate()
    const current = generation.current
    probing.current = true
    setBindingBusy(true)
    try {
      const pageId = pageRef.current?.getWebContentsId()
      if (!pageId) { setStatus('unavailable'); return }
      const result = await window.electronAPI.webTerminal({ kind: 'bind', pageId })
      if (!alive.current || current !== generation.current) {
        if (result.bindingId) void window.electronAPI.webTerminal({ kind: 'release', pageId, bindingId: result.bindingId }).catch(() => {})
        return
      }
      if (result.success && result.bindingId) {
        const next = { pageId, bindingId: result.bindingId }
        bindingRef.current = next
        setBinding(next)
        setStatus('bound')
      } else setStatus(result.error || 'unavailable')
    } catch { if (alive.current) setStatus('unavailable') }
    finally { probing.current = false; if (alive.current) setBindingBusy(false) }
  }

  const send = async (execute: boolean): Promise<void> => {
    if (busy.current || !binding || offline || activeWebTabId() !== id) return
    let lines: string[]
    try {
      lines = webTerminalLines(draft)
      // 仅输入不回车只适用于单行；多行本身就可能触发远端执行。
      if (!execute && lines.length !== 1) { setStatus('singleLine'); return }
    } catch { setStatus('invalid'); return }
    // 发送前更新一次目标；用户刚点了另一终端时不能沿用上一轮的绑定。
    if (!probing.current) void discover()
    const controller = new AbortController()
    abort.current = controller
    busy.current = true
    setSending(true)
    setProgress({ sent: 0, total: lines.length })
    setStatus('sending')
    let sent = 0
    try {
      // 等已经发出的探测收束，避免与发送争抢后端 inflight；目标变化时要求再次发送。
      await pendingDiscovery.current
      if (!alive.current || controller.signal.aborted || activeWebTabId() !== id) return
      if (bindingRef.current?.bindingId !== binding.bindingId) { setStatus('targetChanged'); return }
      for (const line of lines) {
        if (controller.signal.aborted || activeWebTabId() !== id || !navigator.onLine) break
        const result = await window.electronAPI.webTerminal({ kind: 'send', ...binding, text: line, enter: execute })
        if (!result.success) {
          invalidate()
          if (alive.current) setStatus(result.error || 'uncertain')
          return
        }
        sent++
        if (alive.current) setProgress({ sent, total: lines.length })
        if (sent < lines.length) await waitWebTerminalDelay(delay, controller.signal)
      }
      if (alive.current) setStatus(controller.signal.aborted || sent < lines.length ? 'stopped' : 'sent')
    } catch {
      invalidate()
      if (alive.current) setStatus('uncertain')
    } finally {
      busy.current = false
      if (alive.current) setSending(false)
    }
  }

  const importScript = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (!selected || busy.current) return
    if (selected.size > WEB_SCRIPT_LIMIT) { setStatus('invalid'); return }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer())
      webTerminalLines(text)
      if (alive.current && !busy.current) { setDraft(text); setStatus('staged') }
    } catch { if (alive.current) setStatus('invalid') }
  }

  return (
    <>{open && <section className="web-terminal-tools" aria-label={t('webTerminal.title')} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); document.querySelector<HTMLButtonElement>(`[aria-controls="web-terminal-${id}"]`)?.focus() }
    }}>
      <div className="web-terminal-toolbar">
        <button type="button" className="web-terminal-toggle" aria-label={t('webTerminal.close')} onClick={toggle}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m4 6 6 6-6 6M13 18h7" /></svg>
          {t('webTerminal.title')}
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
        </button>
        <span className="web-terminal-target">{t(offline ? 'webTerminal.offlineLabel' : binding ? 'webTerminal.boundLabel' : terminalCount > 1 ? 'webTerminal.selectTarget' : 'webTerminal.unboundLabel')}</span>
        {sending && <button type="button" onClick={() => abort.current?.abort()}>{t('webTerminal.stop')}</button>}
      </div>
      {open && <div id={`web-terminal-${id}`} className="web-terminal-composer">
        <div className="web-terminal-actions">
          <button type="button" onClick={() => void bind()} disabled={sending || bindingBusy || offline}>{t(bindingBusy ? 'webTerminal.binding' : 'webTerminal.bind')}</button>
          <select aria-label={t('webTerminal.quickCommand')} value="" disabled={sending} onChange={event => {
            const command = commands.find(item => item.id === event.target.value)
            if (command) { setDraft(command.content); setStatus(command.escapeSequences ? 'literal' : 'staged') }
          }}>
            <option value="">{t('webTerminal.quickCommand')}</option>
            {[{ id: 'default', name: t('webTerminal.defaultGroup') }, ...groups].map(group => (
              <optgroup key={group.id} label={group.name}>{commands.filter(command => group.id === 'default' ? !command.groupId : command.groupId === group.id).map(command => <option key={command.id} value={command.id}>{command.name}</option>)}</optgroup>
            ))}
          </select>
          <button type="button" disabled={sending} onClick={() => file.current?.click()}>{t('webTerminal.import')}</button>
          <input ref={file} type="file" accept=".sh,.bash,.zsh,.txt,.ps1,.cmd,.bat" hidden onChange={event => void importScript(event)} />
          <label className="web-terminal-delay">{t('webTerminal.interval')}<input type="number" min={50} max={3000} step={50} value={delay} disabled={sending} onChange={event => setDelay(Math.max(50, Math.min(3000, Number(event.target.value) || 150)))} />ms</label>
        </div>
        <p className="web-terminal-hint">{t('webTerminal.hint')}</p>
        <textarea ref={editor} aria-label={t('webTerminal.script')} spellCheck={false} value={draft} maxLength={WEB_SCRIPT_LIMIT} disabled={sending} placeholder={t('webTerminal.placeholder')} onChange={event => { setDraft(event.target.value); setStatus('') }} />
        <div className="web-terminal-actions web-terminal-send">
          <output role="status" aria-live="polite">{status ? t(`webTerminal.status.${status}`, { sent: progress.sent, total: progress.total }) : t('webTerminal.ready')}</output>
          <button type="button" disabled={!binding || !draft || sending || offline} onClick={() => void send(false)}>{t('webTerminal.insert')}</button>
          <button type="button" className="web-terminal-execute" disabled={!binding || !draft || sending || offline} onClick={() => void send(true)}>{t('webTerminal.execute')}</button>
        </div>
      </div>}
    </section>}</>
  )
}
