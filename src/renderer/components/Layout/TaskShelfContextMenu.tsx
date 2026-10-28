import { useEffect, useLayoutEffect, useRef, useState, type ReactPortal } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { shelfEntryFor, shelfResource, useTaskShelf } from '../../stores/task-shelf'
import type { ShelfResource } from '@shared/task-shelf'

const CONTEXT_EVENT = 'task-shelf:context-menu'
type ContextTarget = ({ kind: ShelfResource['kind']; id: string } | { entryId: string }) & { x: number; y: number }
type ContextEvent = { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }
export function showShelfContextMenu(event: ContextEvent, kind: ShelfResource['kind'], id: string): void {
  event.preventDefault(); event.stopPropagation()
  window.dispatchEvent(new CustomEvent<ContextTarget>(CONTEXT_EVENT, { detail: { kind, id, x: event.clientX, y: event.clientY } }))
}
/** 归档记录的管理不依赖运行实例；重启或恢复失败后仍可归档、移除。 */
export function showShelfEntryContextMenu(event: ContextEvent, entryId: string): void {
  event.preventDefault(); event.stopPropagation()
  window.dispatchEvent(new CustomEvent<ContextTarget>(CONTEXT_EVENT, { detail: { entryId, x: event.clientX, y: event.clientY } }))
}
export function TaskShelfContextMenu(): ReactPortal | null {
  const { t } = useTranslation()
  const [target, setTarget] = useState<ContextTarget | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const panel = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const entries = useTaskShelf(s => s.entries)
  const bindings = useTaskShelf(s => s.bindings)
  const entryId = target ? 'entryId' in target ? target.entryId : shelfEntryFor(target.kind, target.id) : undefined
  const entry = entries.find(item => item.id === entryId)
  const binding = target && ('entryId' in target ? bindings[target.entryId] : target)
  const resource = binding ? shelfResource(binding.kind, binding.id) : null
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ContextTarget>).detail
      if (!detail || ('entryId' in detail ? !useTaskShelf.getState().entries.some(entry => entry.id === detail.entryId) : !shelfResource(detail.kind, detail.id))) return
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setTarget(detail)
    }
    const outside = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node)) setTarget(null) }
    window.addEventListener(CONTEXT_EVENT, handle); window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener(CONTEXT_EVENT, handle); window.removeEventListener('pointerdown', outside) }
  }, [])
  useLayoutEffect(() => {
    if (!target || !panel.current) return
    const box = panel.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - box.height - 8)) })
    panel.current.querySelector<HTMLButtonElement>('button')?.focus()
  }, [target])
  if (!target) return null
  const run = (action: () => void | Promise<unknown>) => { setTarget(null); void action() }
  return createPortal(<div ref={panel} role="menu" aria-label={t('taskShelf.taskActions')} className="task-shelf-context-menu win-no-drag" style={position}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTarget(null); previousFocus.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
    {resource && <button role="menuitem" onClick={() => run(() => useTaskShelf.getState().collect(resource))}>{t(entry ? 'taskShelf.hide' : 'taskShelf.collect')}</button>}
    {entry && <>
      <button role="menuitem" onClick={() => run(() => useTaskShelf.getState().archive(entry.id, !entry.archivedAt))}>{t(entry.archivedAt ? 'taskShelf.unarchive' : 'taskShelf.archiveRunning')}</button>
      <button role="menuitem" onClick={() => run(() => useTaskShelf.getState().remove(entry.id))}>{t('taskShelf.remove')}</button>
    </>}
  </div>, document.body)
}
