import ReactDOM from 'react-dom/client'
import './i18n'  // 副作用初始化 i18next（用 saved locale），必须在 App render 前
import App from './App'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
)