import ReactDOM from 'react-dom/client'
import type { McpConfirmationAPI } from '@shared/mcp-confirmation'
import McpConfirmationView from './components/Mcp/McpConfirmationView'
import './components/Mcp/McpConfirmationView.css'

declare global { interface Window { mcpConfirmation: McpConfirmationAPI } }

async function bootstrap(): Promise<void> {
  const data = await window.mcpConfirmation.request({ kind: 'get' })
  if (!data || typeof data !== 'object') { await window.mcpConfirmation.request({ kind: 'reject' }); return }
  document.documentElement.lang = data.locale
  document.documentElement.dataset.themeMode = data.theme
  document.title = data.title
  const unsubscribe = window.mcpConfirmation.onTheme(theme => { document.documentElement.dataset.themeMode = theme })
  window.addEventListener('beforeunload', unsubscribe, { once: true })
  ReactDOM.createRoot(document.getElementById('root')!).render(<McpConfirmationView data={data} onRequest={window.mcpConfirmation.request} />)
}
void bootstrap().catch(() => { void window.mcpConfirmation.request({ kind: 'reject' }).catch(() => undefined) })
