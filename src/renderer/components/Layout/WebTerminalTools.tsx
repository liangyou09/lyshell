import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { useTranslation } from 'react-i18next'
import type { QuickCommand } from '@shared/types'
import { usePaneStore, useQuickCommandsStore } from '../../stores'
import { activeWebTabId } from './web-tab-controls'
import { registerWebTerminalCommand } from './web-terminal-command'
import { WEB_SCRIPT_LIMIT, waitWebTerminalDelay, webTerminalLines } from './web-terminal-script'
import './WebTerminalTools.css'

/** 页签常驻，草稿只留内存。网络恢复、页签切换均不重放输入。 */
export default function WebTerminalTools({ id, pageRef }: { id: string; pageRef: React.RefObject<WebviewTag> }): JSX.Element {
  const { t } = useTranslation()
  const commands = useQuickCommandsStore(state => state.commands)
  const groups = useQuickCommandsStore(state => state.groups)
  const [open, setOpen] = useState(false)
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
  const editor = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)

  const invalidate = useCallback(() => {
    generation.current++
    abort.current?.abort()
    const old = bindingRef.current
    bindingRef.current = undefined
    setBinding(undefined)
    if (old) void window.electronAPI.webTerminal({ kind: 'release', ...old }).catch(() => {})
  }, [])

  useEffect(() => {
    alive.current = true
    const page = pageRef.current
    const navigation = (event: Event): void => {
      // iframe 的导航也使绑定失效，SPA 路由同样需要重新确认目标。
      const inPlace = (event as Event & { isInPlace?: boolean }).isInPlace
      if (event.type === 'did-start-navigation' && inPlace) return
      invalidate()
      setStatus('rebind')
    }
    const network = (): void => {
      setOffline(!navigator.onLine)
      if (!navigator.onLine) { invalidate(); setStatus('offline') }
    }
    const events = ['did-start-navigation', 'did-navigate-in-page', 'render-process-gone', 'destroyed']
    events.forEach(name => page?.addEventListener(name, navigation))
    window.addEventListener('offline', network)
    window.addEventListener('online', network)
    const unsubscribe = usePaneStore.subscribe(() => {
      if (activeWebTabId() !== id && busy.current) { abort.current?.abort() }
    })
    return () => {
      alive.current = false
      invalidate()
      unsubscribe()
      events.forEach(name => page?.removeEventListener(name, navigation))
      window.removeEventListener('offline', network)
      window.removeEventListener('online', network)
    }
  }, [id, pageRef, invalidate])

  useEffect(() => registerWebTerminalCommand(id, (command: QuickCommand) => {
    setOpen(true)
    if (busy.current) { setStatus('busy'); return }
    // 网页输入保持字面文本；PTY 的控制字符转义不能注入网页。
    setDraft(command.content)
    setStatus(command.escapeSequences ? 'literal' : 'staged')
    requestAnimationFrame(() => editor.current?.focus())
  }), [id])

  const bind = async (): Promise<void> => {
    if (busy.current || bindingBusy) return
    invalidate()
    const current = generation.current
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
        setBinding({ pageId, bindingId: result.bindingId })
        setStatus('bound')
      } else setStatus(result.error || 'unavailable')
    } catch { if (alive.current) setStatus('unavailable') }
    finally { if (alive.current) setBindingBusy(false) }
  }

  const send = async (execute: boolean): Promise<void> => {
    if (busy.current || !binding || offline || activeWebTabId() !== id) return
    let lines: string[]
    try {
      lines = webTerminalLines(draft)
      // 仅输入不回车只适用于单行；多行本身就可能触发远端执行。
      if (!execute && lines.length !== 1) { setStatus('singleLine'); return }
    } catch { setStatus('invalid'); return }
    const controller = new AbortController()
    abort.current = controller
    busy.current = true
    setSending(true)
    setProgress({ sent: 0, total: lines.length })
    setStatus('sending')
    let sent = 0
    try {
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
    <section className="web-terminal-tools" aria-label={t('webTerminal.title')}>
      <div className="web-terminal-toolbar">
        <button type="button" className="web-terminal-toggle" aria-expanded={open} aria-controls={`web-terminal-${id}`} onClick={() => setOpen(value => !value)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m4 6 6 6-6 6M13 18h7" /></svg>
          {t('webTerminal.title')}
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
        </button>
        <span className="web-terminal-target">{t(offline ? 'webTerminal.offlineLabel' : binding ? 'webTerminal.boundLabel' : 'webTerminal.unboundLabel')}</span>
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
    </section>
  )
}
