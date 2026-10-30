import i18n from '../../i18n'
import './TerminalInputNotice.css'

interface TerminalInputNoticeProps {
  automationHeld: boolean
  error: string
  onTakeControl: () => void
}

/** 输入被阻止时的轻量提示，控制权的获取和续期仍由终端视图负责。 */
export default function TerminalInputNotice({ automationHeld, error, onTakeControl }: TerminalInputNoticeProps) {
  return (
    <div className="terminal-input-notice" role="status">
      <svg className="terminal-input-notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M7 9h.01M12 9h.01M17 9h.01M7 12h.01M12 12h.01M17 12h.01M8 15h8" />
      </svg>
      <div className="terminal-input-notice-content">
        <div className="terminal-input-notice-copy">
          <p className="terminal-input-notice-message">{i18n.t(automationHeld ? 'terminal.automationControl' : 'terminal.controlUnavailable')}</p>
          {error && <p className="terminal-input-notice-error">{error}</p>}
        </div>
        <button type="button" className="terminal-input-notice-action" onClick={onTakeControl}>
          {i18n.t('terminal.takeControl')}
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
