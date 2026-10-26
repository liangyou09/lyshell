import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useDismiss } from '../../hooks'
import BrowserSearchEngineButton from './BrowserSearchEngineButton'
import { browserSearchAddress, browserSearchQuery } from '@shared/browser-settings'
import { requestBrowser, useBrowserSettingsStore } from '../../stores/browser-settings-store'

export interface BrowserAddressSuggestion { url: string; title: string }

interface Props {
  inputRef: React.RefObject<HTMLInputElement>
  value: string
  placeholder: string
  'aria-label': string
  suggestions: BrowserAddressSuggestion[]
  renderIcon: (url: string) => React.ReactNode
  onChange: React.ChangeEventHandler<HTMLInputElement>
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>
  onFocus?: React.FocusEventHandler<HTMLInputElement>
  onSubmit: (url: string) => void
  mini?: boolean
  visible: boolean
}

/** 主题化地址补全：保留输入焦点，浮层通过 portal 避开小窗纸面的裁切。 */
export default function BrowserAddressField({ inputRef, value, placeholder, suggestions, renderIcon, onChange, onKeyDown, onFocus, onSubmit, mini, visible, ...props }: Props): JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const fieldRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState(false)
  const [active, setActive] = useState(-1)
  const [composing, setComposing] = useState(false)
  const [remote, setRemote] = useState<{ query: string; items: string[] }>({ query: '', items: [] })
  const engine = useBrowserSettingsStore(s => s.settings.searchEngine)
  const loaded = useBrowserSettingsStore(s => s.loaded && !s.error)
  const query = filter && !composing ? browserSearchQuery(value, engine) : null
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, height: 0, theme: '', mode: '' })
  const items = useMemo(() => {
    const text = filter ? value.trim().toLocaleLowerCase() : ''
    const local = suggestions.filter(item => !text || `${item.title} ${item.url}`.toLocaleLowerCase().includes(text))
      .slice(0, query ? 3 : 8).map(item => ({ ...item, search: false }))
    const words = query ? [query, ...(engine === 'bing' && remote.query === query ? remote.items : [])] : []
    const searches = [...new Set(words)].map(word => ({ url: word, title: word, search: true }))
    return [...local, ...searches].slice(0, 8)
  }, [suggestions, filter, value, query, remote, engine])
  const expanded = open && visible && items.length > 0
  const close = useCallback(() => { setOpen(false); setActive(-1) }, [])
  useDismiss(expanded, close, [fieldRef, menuRef])
  useEffect(() => { if (!visible) close() }, [visible, close])
  useEffect(() => { setActive(-1) }, [value, suggestions])
  useEffect(() => {
    if (!open || !visible || !loaded || engine !== 'bing' || !query) return
    let cancelled = false
    const timer = setTimeout(() => {
      void requestBrowser({ kind: 'searchSuggestions', query }).then(result => {
        if (!cancelled && result.success && result.searchEngine === engine) {
          setRemote({ query, items: result.searchSuggestions ?? [] })
        }
      })
    }, 220)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, visible, loaded, engine, query])

  useLayoutEffect(() => {
    if (!expanded) return
    const sync = (): void => {
      const field = fieldRef.current
      if (!field) return
      const rect = field.getBoundingClientRect()
      const height = Math.min(items.length * 44 + 8, 272, Math.max(44, window.innerHeight - 16))
      const width = Math.min(Math.max(rect.width, 264), window.innerWidth - 16)
      const below = window.innerHeight - rect.bottom - 8
      const top = below >= height || below >= rect.top - 8 ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)
      const theme = field.closest('[data-theme]')
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top, width,
        height: Math.min(height, window.innerHeight - top - 8), theme: theme?.getAttribute('data-theme') ?? '', mode: field.closest('[data-theme-mode]')?.getAttribute('data-theme-mode') ?? '' })
    }
    sync()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    if (fieldRef.current) observer?.observe(fieldRef.current)
    window.addEventListener('resize', sync)
    document.addEventListener('scroll', sync, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', sync); document.removeEventListener('scroll', sync, true) }
  }, [expanded, items.length])
  useEffect(() => { if (active >= 0) menuRef.current?.querySelectorAll('[role="option"]')[active]?.scrollIntoView?.({ block: 'nearest' }) }, [active])

  const select = (url: string): void => { close(); onSubmit(url) }
  return <>
    <div ref={fieldRef} className={`web-address-field${mini ? ' web-address-field-mini' : ''}`}>
      {!mini && <BrowserSearchEngineButton visible={visible} onOpen={close} />}
      <input ref={inputRef} id={id} type="text" role="combobox" aria-label={props['aria-label']} aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && active >= 0 && items[active] ? `${id}-option-${active}` : undefined}
        className="web-address-input" value={value} placeholder={placeholder} spellCheck={false} onFocus={onFocus}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onBlur={event => { if (!fieldRef.current?.contains(event.relatedTarget as Node) && !menuRef.current?.contains(event.relatedTarget as Node)) close() }}
        onChange={event => { setFilter(true); setOpen(true); setActive(-1); onChange(event) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (items.length || suggestions.length)) {
            event.preventDefault()
            if (!expanded) { setFilter(!suggestions.length); setOpen(true); setActive(event.key === 'ArrowDown' ? 0 : Math.max(0, (suggestions.length ? Math.min(suggestions.length, 8) : items.length) - 1)) }
            else setActive(index => index < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            const item = expanded && active >= 0 ? items[active] : undefined
            select(item ? (item.search ? browserSearchAddress(item.url, engine)! : item.url) : event.currentTarget.value)
            return
          }
          if (event.key === 'Tab') close()
          onKeyDown(event)
        }} />
      <button type="button" className="web-address-dropdown" title={t('webBar.suggestions')} aria-label={t('webBar.suggestions')}
        aria-expanded={expanded} aria-haspopup="listbox" aria-controls={expanded ? `${id}-list` : undefined} disabled={!suggestions.length && !browserSearchQuery(value, engine)}
        onMouseDown={event => event.preventDefault()} onClick={() => { inputRef.current?.focus(); setFilter(!suggestions.length); setActive(-1); setOpen(!expanded) }}>
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
      </button>
      {!mini && <button type="button" className="web-address-go" title={t('webBar.go')} aria-label={t('webBar.go')} disabled={!value.trim()}
        onClick={() => select(inputRef.current?.value ?? value)}>
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>
      </button>}
    </div>
    {expanded && createPortal(<div ref={menuRef} className="browser-address-menu" data-theme={position.theme || undefined} data-theme-mode={position.mode || undefined}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.height || 272 }}>
      <div role="listbox" id={`${id}-list`} aria-label={t('webBar.suggestions')}>
        {items.map((item, index) => <div key={item.url} role="option" id={`${id}-option-${index}`} aria-selected={active === index}
          className="browser-address-option" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(item.search ? browserSearchAddress(item.url, engine)! : item.url)}>
          <span aria-hidden className="browser-address-option-icon">{item.search
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
            : renderIcon(item.url)}</span>
          <span className="browser-address-option-copy"><span className="browser-address-option-title">{item.title}</span><span className="browser-address-option-url">{item.search ? t('webBar.searchSuggestion') : item.url}</span></span>
        </div>)}
      </div>
    </div>, document.body)}
  </>
}
