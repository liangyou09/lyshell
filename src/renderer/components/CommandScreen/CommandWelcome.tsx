import React from 'react'
import { useTranslation } from 'react-i18next'
import './CommandWelcome.css'

interface CommandWelcomeProps {
  onCommand: (name: string) => void
}

/** 空 pane 的水墨留白；输入和命令输出始终优先。 */
const CommandWelcome: React.FC<CommandWelcomeProps> = ({ onCommand }) => {
  const { t } = useTranslation()
  return (
    <section className="command-welcome" aria-label={t('commandBar.welcome.title')}>
      <div className="command-welcome-landscape" aria-hidden="true" />
      <div className="command-welcome-inscription">
        <h1>LyShell</h1>
        <p>{t('commandBar.welcome.title')}</p>
        <div className="command-welcome-actions">
          {(['local', 'new', 'help'] as const).map(name => (
            <button key={name} type="button" onClick={() => onCommand(name)} className="command-welcome-action">
              <span>{t(`commandBar.welcome.${name}`)}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

export default CommandWelcome
