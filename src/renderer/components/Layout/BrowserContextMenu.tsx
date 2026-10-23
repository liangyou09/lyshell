import { useLayoutEffect, useRef } from 'react'
import type { BrowserMenuAction, BrowserMenuData, BrowserMenuItem, BrowserMenuRequest } from '@shared/browser-context-menu'

const paths: Record<BrowserMenuAction, string> = {
  back: 'm11 5-6 5 6 5M5 10h12', forward: 'm9 5 6 5-6 5M3 10h12',
  reload: 'M16 8a6 6 0 1 0 0 5M16 3v5h-5',
  'open-link': 'M11 4h5v5M16 4l-7 7M8 4H4v12h12v-4',
  'copy-link': 'm8 12 4-4M7 13l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M13 7l1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0',
  'copy-link-text': 'M5 4h10M10 4v12M7 16h6',
  'save-link': 'M10 3v10m-4-4 4 4 4-4M4 14v3h12v-3',
  'open-image': 'M11 4h5v5M16 4l-6 6M7 4H3v13h13v-5M3 13l4-4 5 5',
  'copy-image': 'M7 3h10v10M3 7h10v10H3zM3 14l3-3 4 4',
  'copy-image-url': 'M3 4h13v8M3 4v12h5M3 12l4-4 4 4M12 14l2-2a2 2 0 0 1 3 3l-2 2M11 17l-1 1',
  'save-image': 'M3 3h14v9M3 3v14h7M3 12l4-4 4 4M14 12v6m-3-3 3 3 3-3',
  undo: 'M7 4 3 8l4 4M3 8h8a5 5 0 0 1 0 10', redo: 'm13 4 4 4-4 4M17 8H9a5 5 0 0 0 0 10',
  cut: 'm7 8 9 9M7 12l9-9M7 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM7 14a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  copy: 'M7 3h10v10M3 7h10v10H3z', paste: 'M7 4H4v13h12V4h-3M7 2h6v4H7zM7 10h6M7 13h4',
  'select-all': 'M6 3H3v3M14 3h3v3M3 14v3h3M17 14v3h-3M7 7h6v6H7z',
  'search-selection': 'M13 13l4 4M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  'copy-page-url': 'M11 3h5v14H4V3h3M7 1h6v4H7zM7 9h6M7 12h5',
  'save-page': 'M4 2h8l4 4v12H4zM12 2v5h4M10 9v6m-3-3 3 3 3-3',
  inspect: 'M7 5 2 10l5 5M13 5l5 5-5 5M11 3 9 17'
}

function MenuIcon({ id }: { id: BrowserMenuAction }): JSX.Element {
  return <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[id]} /></svg>
}

export default function BrowserContextMenu({ data, onRequest }: {
  data: BrowserMenuData; onRequest: (request: BrowserMenuRequest) => Promise<unknown>
}): JSX.Element {
  const root = useRef<HTMLElement>(null)
  const requested = useRef(false)
  const decide = (request: BrowserMenuRequest): void => {
    if (requested.current) return
    requested.current = true
    void onRequest(request).catch(() => { requested.current = false })
  }
  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true })
    void onRequest({ kind: 'ready' })
  }, [onRequest])

  const item = (entry: BrowserMenuItem, toolbar = false): JSX.Element => <button
    key={entry.id} role="menuitem" type="button" disabled={!entry.enabled} tabIndex={-1}
    className={toolbar ? 'browser-menu-nav' : 'browser-menu-item'}
    title={toolbar ? entry.label : undefined}
    onClick={() => decide({ kind: 'action', id: entry.id })}
  ><MenuIcon id={entry.id} /><span>{entry.label}</span>{!toolbar && entry.shortcut && <kbd>{entry.shortcut}</kbd>}</button>

  return <section ref={root} className="browser-menu" role="menu" aria-label={data.locale === 'zh' ? '网页右键菜单' : 'Page context menu'} tabIndex={-1}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); decide({ kind: 'dismiss' }); return }
      let shortcut: BrowserMenuAction | undefined
      if (event.key === 'F12') shortcut = 'inspect'
      else if (event.key === 'F5') shortcut = 'reload'
      else if (event.altKey && event.key === 'ArrowLeft') shortcut = 'back'
      else if (event.altKey && event.key === 'ArrowRight') shortcut = 'forward'
      else if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const edits: Record<string, BrowserMenuAction> = { z: event.shiftKey ? 'redo' : 'undo', y: 'redo', x: 'cut', c: 'copy', v: 'paste', a: 'select-all' }
        shortcut = edits[event.key.toLowerCase()]
      }
      if (shortcut) {
        event.preventDefault()
        if ([...data.toolbar, ...data.groups.flat()].some(item => item.id === shortcut && item.enabled)) decide({ kind: 'action', id: shortcut })
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!buttons.length) return
      const index = buttons.findIndex(button => button === document.activeElement)
      const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : index < 0 ? (backward ? buttons.length - 1 : 0)
          : (index + (backward ? -1 : 1) + buttons.length) % buttons.length
      buttons[next].focus({ preventScroll: true })
      buttons[next].scrollIntoView?.({ block: 'nearest' })
    }}>
    <header className="browser-menu-heading"><h1>{data.title}</h1><p title={data.detail}>{data.detail}</p></header>
    <div className="browser-menu-toolbar" role="group" aria-label={data.locale === 'zh' ? '页面导航' : 'Page navigation'}>{data.toolbar.map(entry => item(entry, true))}</div>
    <div className="browser-menu-groups">{data.groups.map((group, index) => <div className="browser-menu-group" key={index} role="group">{group.map(entry => item(entry))}</div>)}</div>
  </section>
}
