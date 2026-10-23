import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useDismiss } from '../../hooks'

interface Action {
  label: string
  icon: ReactNode
  disabled: boolean
  onClick: () => void
  checked?: boolean
}

/** 小窗低频操作收进菜单；浮层挂到 body，避免被画轴纸窗裁切。 */
export default function MiniBrowserActions({ label, visible, actions, triggerIcon, triggerClassName, disabled, onOpen }: {
  label: string
  visible: boolean
  actions: Action[]
  triggerIcon?: ReactNode
  triggerClassName?: string
  disabled?: boolean
  onOpen?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, height: 0, theme: '', mode: '' })
  const expanded = open && visible
  const close = useCallback(() => {
    if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    setOpen(false)
  }, [])
  useDismiss(expanded, close, [triggerRef, menuRef])
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  useLayoutEffect(() => {
    if (!expanded) return
    const sync = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const width = Math.min(240, window.innerWidth - 16)
      const height = Math.min(actions.length * 36 + 8, window.innerHeight - 16)
      const top = window.innerHeight - rect.bottom >= height + 8 ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top, width, height,
        theme: trigger.closest('[data-theme]')?.getAttribute('data-theme') ?? '',
        mode: trigger.closest('[data-theme-mode]')?.getAttribute('data-theme-mode') ?? '' })
    }
    sync()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    if (triggerRef.current?.parentElement) observer?.observe(triggerRef.current.parentElement)
    window.addEventListener('resize', sync)
    document.addEventListener('scroll', sync, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', sync); document.removeEventListener('scroll', sync, true) }
  }, [expanded, actions.length])
  useEffect(() => {
    if (expanded) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [expanded])

  return <>
    <button ref={triggerRef} type="button" className={`web-mini-button${triggerClassName ? ` ${triggerClassName}` : ''}`} title={label} aria-label={label} disabled={disabled}
      aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      onClick={() => { if (!expanded) onOpen?.(); setOpen(value => !value) }}>
      {triggerIcon ?? <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
      </svg>}
    </button>
    {expanded && createPortal(<div ref={menuRef} id={id} role="menu" aria-label={label}
      className="web-mini-menu" data-theme={position.theme || undefined} data-theme-mode={position.mode || undefined}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.height }}
      onKeyDown={event => {
        if (event.key === 'Tab') { close(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}>
      {actions.map(action => <button key={action.label} type="button" role={action.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={action.checked} title={action.label}
        disabled={action.disabled} onClick={() => { close(); action.onClick() }}>
        {action.icon}<span>{action.label}</span>
      </button>)}
    </div>, document.body)}
  </>
}
