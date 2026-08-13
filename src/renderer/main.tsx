import ReactDOM from 'react-dom/client'
import './i18n'  // 副作用初始化 i18next（用 saved locale），必须在 App render 前
import App from './App'
import './styles/globals.css'

// 预加载终端等宽字体（Maple Mono NF CN，已随 app 打包）。
// 必须等字体就绪后再挂载 React：xterm 在 terminal.open() 时测量字符宽度，
// 若此时 Maple 尚未加载，会用回退字体（Cascadia Mono / Consolas）的宽度去测量，
// 中文/emoji 等宽字符的列宽随之错位，产生"文字漂移"且不会自动修复。
// document.fonts.load 找不到字体时 resolve 空数组（不 reject），失败也能静默继续。
async function bootstrap() {
  try {
    await Promise.all([
      document.fonts.load('16px "Maple Mono NF CN"'),
      document.fonts.load('bold 16px "Maple Mono NF CN"')
    ])
  } catch {
    // 字体加载异常时回退到 font-family 栈后续字体，不阻塞启动
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <App />
  )
}

void bootstrap()