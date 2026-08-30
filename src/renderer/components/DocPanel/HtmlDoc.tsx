/**
 * HTML 文档渲染 —— 沙箱 iframe（sandbox="allow-same-origin"，不带 allow-scripts）。
 * 无脚本 / 无表单 / 无弹窗 / 无顶层导航，内容是惰性 HTML+CSS；同源令牌只给
 * 宿主放行 DOM 访问：① 缩放直接写 documentElement.style.zoom（免 srcdoc 重载）；
 * ② 抓手平移经 contentWindow.scrollBy 拖动文档视图。srcDoc 直注内容不经网络；
 * referrerPolicy 不外泄来源；背景显式给白（多数 HTML 文档自带浅色底假设）。
 *
 * 安全不变量（改动前必读）：sandbox 的同源令牌没有脚本执行权（allow-scripts
 * 永远缺席，导航后仍如此 —— sandbox 标志随 frame 存续），iframe 内容无法运行
 * 任何代码，也就不可能反向触碰宿主 DOM；唯一跨边界方向是宿主读自己注入的
 * 惰性内容。srcdoc 子文档继承宿主 CSP（default-src 'self'，img/font 仅 self
 * 与 data:），惰性内容连远程子资源都拉不动；frame 自导航也被 onLoad 拦截器
 * 掐灭。因此「同源」不构成逃逸面 —— 但一旦有人追加 allow-scripts，本沙箱
 * 即刻退化为完全同源可达，届时宿主 DOM、IPC 桥全部暴露，绝不可加。
 *
 * 滚轮/拖拽与 iframe 的关系：悬停 iframe 时事件进 iframe 文档、宿主收不到，
 * 故有一块透明护盾 —— 平移模式（docPan）或按住 Ctrl（缩放）时护盾接管：
 * 拖拽平移 / Ctrl+滚轮缩放 / 普通滚轮转发为文档滚动。平时护盾穿透，
 * 文档自身滚动（含 Chromium 原生中键自动滚动）不受影响。
 *
 * 焦点陷阱：点击文档内部后焦点进入 iframe 的内嵌 window，宿主 window 收不到
 * keydown/keyup，Ctrl 态追踪失效。补救：window blur 时若 activeElement 正是
 * 本 iframe，则标记「焦点在内」——护盾常开接管滚轮（事件自带真实 ctrlKey：
 * Ctrl=缩放，普通滚轮经 scrollBy 转发为文档滚动）；点击护盾或焦点回宿主
 * 即恢复原生穿透。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useDocZoom, adjustDocZoom, DOC_ZOOM_STEP } from './docZoom'
import { usePanMode } from './docPan'

const HtmlDoc: React.FC<{ content: string; title: string }> = ({ content, title }) => {
  const zoom = useDocZoom()
  const panMode = usePanMode()
  const [ctrlHeld, setCtrlHeld] = useState(false)
  const [iframeFocused, setIframeFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const shieldRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Ctrl 按住态：缩放护盾激活窗口。blur 兜底（焦点切走时 keyup 可能丢）。
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.ctrlKey) setCtrlHeld(true) }
    const up = (e: KeyboardEvent) => { if (!e.ctrlKey) setCtrlHeld(false) }
    const onBlur = () => setCtrlHeld(false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 焦点进 iframe 检测：宿主 window blur 时 activeElement 若是本 iframe，
  // 说明用户点了文档内部 —— 键盘事件从此只进 iframe，Ctrl 态追踪失效，
  // 改由护盾常开接管滚轮。焦点回宿主（window focus）即解除。
  useEffect(() => {
    const onBlur = () => {
      if (document.activeElement === iframeRef.current) setIframeFocused(true)
    }
    const onFocus = () => setIframeFocused(false)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // 缩放：直接写 iframe 文档根样式（zoom 变化即时生效，不再注入 srcdoc 重载）。
  // 文档（重）加载会清样式，onLoad 时按最新值重涂。
  const applyZoom = useCallback((): void => {
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc) doc.documentElement.style.zoom = zoomRef.current !== 1 ? String(zoomRef.current) : ''
    } catch { /* 文档不可达（加载中）：onload 后重试 */ }
  }, [])
  useEffect(() => { applyZoom() }, [applyZoom, zoom])

  // 文档（重）加载后：重涂缩放 + 挂只读护栏。沙箱已禁弹窗与顶层导航，但 frame
  // 自导航（点 <a> 让 frame 自己跳转）默认仍可能 —— 宿主侧在同源子文档上挂
  // 捕获点击监听掐灭它，文档预览从此完全不可离开本地注入的内容。
  const onDocLoad = useCallback((): void => {
    applyZoom()
    try {
      const doc = iframeRef.current?.contentDocument
      doc?.addEventListener('click', (e) => {
        const el = e.target as Element | null
        if (el?.closest?.('a[href]')) e.preventDefault()
      }, true)
    } catch { /* 文档不可达：仅失去拦截，缩放已涂 */ }
  }, [applyZoom])

  // 护盾交互：拖拽平移（增量 scrollBy）、Ctrl+滚轮缩放、普通滚轮转发为文档滚动
  useEffect(() => {
    const el = shieldRef.current
    if (!el) return
    const scrollDoc = (dx: number, dy: number): void => {
      try { iframeRef.current?.contentWindow?.scrollBy(dx, dy) } catch { /* 不可达则忽略 */ }
    }
    let pid = -1
    let panning = false
    let sx = 0, sy = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) {
        adjustDocZoom(e.deltaY < 0 ? DOC_ZOOM_STEP : -DOC_ZOOM_STEP)
        return
      }
      if (!panMode) setCtrlHeld(false) // Ctrl 态漂移自愈：松开后护盾本不该拦滚轮
      scrollDoc(e.deltaX, e.deltaY)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      // 点击护盾本身就把焦点拉回宿主（pointerdown 落在宿主 DOM 上），
      // 焦点模式随之解除，下一次点击重新穿透进 iframe
      setIframeFocused(false)
      panning = true; pid = e.pointerId; sx = e.clientX; sy = e.clientY
      try { el.setPointerCapture(pid) } catch { /* 捕获失败退化为跟随移动 */ }
      setDragging(true)
    }
    const onMove = (e: PointerEvent) => {
      if (!panning || e.pointerId !== pid) return
      const dx = e.clientX - sx, dy = e.clientY - sy
      if (Math.hypot(dx, dy) <= 2) return
      sx = e.clientX; sy = e.clientY
      scrollDoc(-dx, -dy)
    }
    const onUp = (e: PointerEvent) => {
      if (!panning || e.pointerId !== pid) return
      panning = false
      try { el.releasePointerCapture(pid) } catch { /* 已释放 */ }
      setDragging(false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [panMode])

  // 护盾激活形态：平移模式或焦点在内 → 抓手（拖拽平移 + 滚轮转发）；
  // 仅按住 Ctrl → 缩放光标。两者叠加时平移优先。
  const shieldPan = panMode || iframeFocused
  return (
    <div className="relative h-full">
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        srcDoc={content}
        title={title}
        referrerPolicy="no-referrer"
        onLoad={onDocLoad}
        className="w-full h-full border-0 bg-white"
      />
      <div
        ref={shieldRef}
        aria-hidden
        className={cn(
          'doc-html-shield',
          (ctrlHeld || shieldPan) && 'on',
          shieldPan ? 'pan' : ctrlHeld && 'zoom',
          dragging && 'dragging'
        )}
      />
    </div>
  )
}

export default HtmlDoc
