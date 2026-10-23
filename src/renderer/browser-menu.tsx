import ReactDOM from 'react-dom/client'
import type { BrowserMenuAPI } from '@shared/browser-context-menu'
import type { BrowserMenuWindowData } from '@shared/browser-menu-style'
import BrowserContextMenu from './components/Layout/BrowserContextMenu'
import './components/Layout/BrowserContextMenu.css'

declare global { interface Window { browserMenu: BrowserMenuAPI } }

async function bootstrap(): Promise<void> {
  const data = await window.browserMenu.request({ kind: 'get' })
  if (!data || typeof data !== 'object') return
  const model = data as BrowserMenuWindowData
  document.documentElement.lang = model.locale
  document.documentElement.dataset.themeMode = model.theme
  for (const [key, value] of Object.entries(model.palette ?? {})) {
    // 浅色菜单固定白底，避免宿主面板的灰底覆盖；文字和强调色仍跟随主题。
    if (model.theme === 'light' && ['surface', 'hover', 'rule'].includes(key)) continue
    if (CSS.supports('color', value)) document.documentElement.style.setProperty(`--menu-${key}`, value)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<BrowserContextMenu data={model} onRequest={request => window.browserMenu.request(request)} />)
}
void bootstrap().catch(() => { void window.browserMenu.request({ kind: 'dismiss' }).catch(() => undefined) })
