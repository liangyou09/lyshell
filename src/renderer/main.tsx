import ReactDOM from 'react-dom/client'
import { TERMINAL_WEBFONT_FAMILY } from '@shared/constants'
import './i18n'  // 副作用初始化 i18next（用 saved locale），必须在 App render 前
import App from './App'
import './styles/globals.css'

// 预加载终端等宽字体（Maple Mono NF CN，已随 app 打包）。
// 必须等字体就绪后再挂载 React：xterm 在 terminal.open() 时测量字符宽度，
// 若此时 Maple 尚未加载，会用回退字体（Cascadia Mono / Consolas）的宽度去测量，
// 中文/emoji 等宽字符的列宽随之错位，产生"文字漂移"且不会自动修复。
// document.fonts.load 找不到字体时 resolve 空数组（不 reject），失败会 reject；
// 用 allSettled 逐个检查 —— 任一面失败/未命中都要留告警，不能让整组 catch 吞掉。
async function bootstrap() {
  const results = await Promise.allSettled([
    document.fonts.load(`16px "${TERMINAL_WEBFONT_FAMILY}"`),
    document.fonts.load(`bold 16px "${TERMINAL_WEBFONT_FAMILY}"`)
  ])
  results.forEach((result, i) => {
    const face = i === 0 ? 'regular' : 'bold'
    if (result.status === 'rejected') {
      // 字体文件加载失败（磁盘/解码问题）：门闩放行后终端将长期渲染回退字体
      console.warn(`[bootstrap] 终端字体 ${TERMINAL_WEBFONT_FAMILY} (${face}) 预加载失败:`, result.reason)
    } else if (result.value.length === 0) {
      // 空数组 = family 名与 index.html 的 @font-face 漂移了（改名只改了一处）。
      // 门闩此时等于没等，webfont 竞态会重新打开 —— 至少留个可检索的告警。
      console.warn(`[bootstrap] 终端字体 ${TERMINAL_WEBFONT_FAMILY} (${face}) 预加载未命中任何 @font-face（family 名漂移？）`)
    }
  })
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <App />
  )
}

void bootstrap()