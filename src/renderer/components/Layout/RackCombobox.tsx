import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from '@/hooks/useDismiss'

interface RackComboboxProps {
  value: string
  options: readonly string[]
  label: string
  optionsLabel: string
  emptyText: string
  placeholder?: string
  disabled?: boolean
  id?: string
  required?: boolean
  maxLength?: number
  onChange: (value: string) => void
}

/** 可编辑候选选择：列表独立于滚动栏绘制，输入值始终允许自定义。 */
const RackCombobox: React.FC<RackComboboxProps> = ({ value, options, label, optionsLabel, emptyText, placeholder, disabled, id, required, maxLength, onChange }) => {
  const listId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const restoringFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState<React.CSSProperties | null>(null)
  const filtered = options.filter(option => option.toLowerCase().includes(query.trim().toLowerCase()))
  const expanded = open && !disabled
  useDismiss(expanded, () => setOpen(false), [anchorRef, menuRef])

  useLayoutEffect(() => {
    if (!expanded) return
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const below = window.innerHeight - rect.bottom - 8
      const above = rect.top - 8
      const upwards = below < Math.min(160, filtered.length * 30 + 8) && above > below
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16)
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? rect.top - 5 : rect.bottom + 5,
        width,
        maxHeight: Math.max(40, Math.min(260, upwards ? above - 5 : below - 5)),
        transform: upwards ? 'translateY(-100%)' : undefined,
        fontFamily: getComputedStyle(anchor).fontFamily
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (anchorRef.current) observer?.observe(anchorRef.current)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      observer?.disconnect()
    }
  }, [expanded, filtered.length])

  useEffect(() => {
    if (!expanded || active < 0) return
    const menu = menuRef.current
    const option = menu?.querySelectorAll<HTMLElement>('[role="option"]')[active]
    if (!menu || !option) return
    // 只滚动候选容器，避免 scrollIntoView 连带滚动设置页和外层工作区列表。
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight
    }
  }, [active, expanded])

  const reveal = () => {
    if (disabled) return
    setQuery('')
    setActive(options.indexOf(value))
    setOpen(true)
  }
  const choose = (option: string) => {
    onChange(option)
    setOpen(false)
    restoringFocus.current = true
    inputRef.current?.focus({ preventScroll: true })
    restoringFocus.current = false
  }

  return <div ref={anchorRef} className="rack-combobox">
    <input ref={inputRef} id={id} className="rack-combobox-input" role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && filtered[active] !== undefined ? `${listId}-${active}` : undefined}
      value={value} disabled={disabled} required={required} maxLength={maxLength} placeholder={placeholder} autoComplete="off" spellCheck={false}
      onFocus={() => { if (!restoringFocus.current) reveal() }}
      onClick={() => { if (!expanded) reveal() }}
      onChange={event => { onChange(event.target.value); setQuery(event.target.value); setActive(-1); setOpen(true) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!expanded) { setQuery(''); setOpen(true); setActive(event.key === 'ArrowDown' ? 0 : options.length - 1) }
          else if (filtered.length) setActive(index => event.key === 'ArrowDown' ? (index + 1) % filtered.length : (index <= 0 ? filtered.length : index) - 1)
        } else if (event.key === 'Enter' && expanded && filtered[active] !== undefined) {
          event.preventDefault()
          choose(filtered[active])
        } else if (event.key === 'Tab') setOpen(false)
      }} />
    <button type="button" className="rack-combobox-toggle" aria-label={optionsLabel} aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined} tabIndex={-1} disabled={disabled}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { if (expanded) setOpen(false); else { inputRef.current?.focus({ preventScroll: true }); reveal() } }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {expanded && position && createPortal(<div ref={menuRef} id={listId} role="listbox" aria-label={optionsLabel}
      className="rack-options" style={position}>
      {filtered.length ? filtered.map((option, index) => <button key={option} id={`${listId}-${index}`} type="button"
        role="option" aria-selected={index === active} tabIndex={-1}
        className={`rack-option${option === value ? ' is-selected' : ''}${index === active ? ' is-active' : ''}`}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
        <span className="rack-option-check" aria-hidden="true">{option === value && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m3 8 3 3 7-7" /></svg>}</span>
        <span>{option}</span>
      </button>) : <div className="rack-option-empty" role="status">{emptyText}</div>}
    </div>, document.body)}
  </div>
}

export default RackCombobox
