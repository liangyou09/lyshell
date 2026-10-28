import { useTranslation } from 'react-i18next'
import { useWebTerminalState } from './web-terminal-state'

export default function WebTerminalButton({ id, onActivate }: { id: string; onActivate?: () => void }): JSX.Element | null {
  const { t } = useTranslation()
  const state = useWebTerminalState(id)
  if (!state || (!state.count && !state.open && !state.bound)) return null
  const label = t(state.offline ? 'webTerminal.offlineLabel' : state.bound ? 'webTerminal.attached' : 'webTerminal.selectTarget')
  return <button type="button"
    className="web-terminal-entry win-no-drag"
    title={`${t('webTerminal.title')} · ${label}`}
    aria-label={`${t('webTerminal.title')} · ${label}`}
    aria-expanded={state.open} aria-controls={`web-terminal-${id}`}
    onMouseDown={event => event.stopPropagation()}
    onDragStart={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); onActivate?.(); state.toggle() }}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m4 6 6 6-6 6M13 18h7" /></svg>
    <span>{label}</span>
  </button>
}
