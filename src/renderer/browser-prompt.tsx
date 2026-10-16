import ReactDOM from 'react-dom/client'
import type { BrowserPromptAPI } from '@shared/browser-prompt'
import i18n from './i18n'
import BrowserPromptView from './components/Layout/BrowserPromptView'
import './styles/globals.css'
import './components/Layout/BrowserPromptView.css'

declare global { interface Window { browserPrompt: BrowserPromptAPI } }

async function bootstrap(): Promise<void> {
  const data = await window.browserPrompt.get()
  if (!data) { await window.browserPrompt.action({ kind: 'cancel' }); return }
  document.documentElement.lang = data.locale
  document.documentElement.dataset.theme = data.theme === 'light' ? 'rack-paper' : 'rack-graphite'
  document.documentElement.dataset.themeMode = data.theme
  const unsubscribe = window.browserPrompt.onTheme(theme => {
    document.documentElement.dataset.theme = theme === 'light' ? 'rack-paper' : 'rack-graphite'
    document.documentElement.dataset.themeMode = theme
  })
  window.addEventListener('beforeunload', unsubscribe, { once: true })
  await i18n.changeLanguage(data.locale)
  ReactDOM.createRoot(document.getElementById('root')!).render(<BrowserPromptView data={data} onAction={action => window.browserPrompt.action(action)} />)
}
void bootstrap().catch(() => { void window.browserPrompt.action({ kind: 'cancel' }).catch(() => undefined) })
