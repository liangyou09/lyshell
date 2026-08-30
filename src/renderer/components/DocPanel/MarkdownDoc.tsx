import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DEFAULT_FONT_FAMILY } from '@shared/constants'
import type { DocTabEntry } from '@shared/types'
import { hljsToReact, normalizeLang } from './hljsToReact'
import OutlineRail, { DocHeading } from './OutlineRail'
import { docLinkTarget, docDirFromPath } from './docLink'
import { openLocalDoc, openRemoteDoc } from './readDoc'
import { useDocZoom, adjustDocZoom, DOC_ZOOM_STEP } from './docZoom'
import { usePanMode } from './docPan'

/** 从 markdown 源提取标题（跳过围栏代码块内的 # 行）；去粗体/行内码标记取纯文本 */
function extractHeadings(src: string): DocHeading[] {
  const out: DocHeading[] = []
  let inFence = false
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      const text = m[2].replace(/[*_`~]/g, '').trim()
      if (text) out.push({ level: m[1].length, text })
    }
  }
  return out
}

/** 递归取 React 子树的纯文本（code 元素的 children 可能嵌套） */
function flattenText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (React.isValidElement(node)) {
    return flattenText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** 从 pre 的 children（单个 code React 元素）提取代码文本与语言 */
function extractCodeInfo(children: React.ReactNode): { code: string; lang: string | null } {
  const child = Array.isArray(children) ? children[0] : children
  const props = (child as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined)?.props
  const cls = props?.className ?? ''
  const lang = normalizeLang(/language-([\w-]+)/.exec(cls)?.[1])
  return { code: flattenText(props?.children), lang }
}

/** 代码块：codehead（语言 chip + 复制）+ hljs 高亮体（未识别语言回退纯文本） */
const CodeBlock: React.FC<{ code: string; lang: string | null }> = ({ code, lang }) => {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const { nodes, ok } = useMemo(() => hljsToReact(code, lang), [code, lang])

  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* 剪贴板不可用时静默 */ })
  }

  return (
    <div className="doc-codeblock">
      <div className="doc-codehead">
        <span className="doc-lang">{lang ?? 'text'}</span>
        <button type="button" className="doc-copy" onClick={copy}>
          {copied ? t('doc.copied') : t('doc.copy')}
        </button>
      </div>
      <pre className={ok ? 'doc-code' : 'doc-code doc-code-plain'}>{nodes}</pre>
    </div>
  )
}

/**
 * Markdown 文档渲染 —— react-markdown + remark-gfm 管线。
 * 设计语言（设计稿）：全文等宽（MapleMono）、幽灵 # 记号标题、
 * prompt 行页头（DocHeader）、左侧大纲轨（OutlineRail）。
 * 主题全部走 rack CSS 变量（globals.css 的 .doc-* 段），7 主题自动适配。
 */
const MarkdownDoc: React.FC<{ content: string; tab: DocTabEntry }> = ({ content, tab }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => extractHeadings(content), [content])
  const zoom = useDocZoom()
  const panMode = usePanMode()
  // 文档内链接的解析基准：当前文档所在目录（相对链接 ./x.md ../y.html 都归并到这里）
  const docDir = useMemo(() => docDirFromPath(tab.path), [tab.path])

  // Ctrl+滚轮调缩放：原生非 passive 监听（React 合成 wheel 走 passive，preventDefault 无效）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault() // 顺带压掉 Chromium 的 ctrl+滚轮页面缩放语义
      adjustDocZoom(e.deltaY < 0 ? DOC_ZOOM_STEP : -DOC_ZOOM_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 抓手平移：panMode 左键 / 任意时刻中键拖拽（绝对滚动赋值，不丢事件）。
  // 拖过 3px 才算拖动并吞掉随后的 click（免误触复制按钮等）；大纲轨区域交还自身交互。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let pid = -1
    let panning = false
    let moved = false
    let sx = 0, sy = 0, sl = 0, st = 0
    const onDown = (e: PointerEvent) => {
      if (!(e.button === 1 || (panMode && e.button === 0))) return
      if ((e.target as HTMLElement | null)?.closest?.('.doc-rail-track')) return
      e.preventDefault()
      panning = true; moved = false; pid = e.pointerId
      sx = e.clientX; sy = e.clientY; sl = el.scrollLeft; st = el.scrollTop
      try { el.setPointerCapture(pid) } catch { /* 捕获失败退化为跟随移动 */ }
    }
    const onMove = (e: PointerEvent) => {
      if (!panning || e.pointerId !== pid) return
      const dx = e.clientX - sx, dy = e.clientY - sy
      if (!moved) {
        if (Math.hypot(dx, dy) <= 3) return
        moved = true
        document.body.classList.add('doc-pan-dragging')
      }
      el.scrollLeft = sl - dx
      el.scrollTop = st - dy
    }
    const onUp = (e: PointerEvent) => {
      if (!panning || e.pointerId !== pid) return
      panning = false
      try { el.releasePointerCapture(pid) } catch { /* 已释放 */ }
      document.body.classList.remove('doc-pan-dragging')
    }
    // 捕获阶段吞 click：拖动刚结束时落在按钮上的 click 是拖拽的尾巴不是意图
    const onClickCapture = (e: MouseEvent) => {
      if (!moved) return
      moved = false
      e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('click', onClickCapture, true)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('click', onClickCapture, true)
      document.body.classList.remove('doc-pan-dragging')
    }
  }, [panMode])

  const components = useMemo<Components>(() => ({
    // 围栏代码块：pre 只做壳，code 内容由 CodeBlock 全权渲染（code 覆盖因此只命中行内码）
    pre: ({ children }) => {
      const { code, lang } = extractCodeInfo(children)
      return <CodeBlock code={code.replace(/\n$/, '')} lang={lang} />
    },
    // 行内码 chip（设计稿 .ic）
    code: ({ children }) => <code className="doc-ic">{children}</code>,
    // 文档内链接：指向可打开文档（.md/.html/.txt，相对当前文档目录归并）的
    // 点击即开新文档页签；外链/锚点/其他扩展名保持只读渲染
    a: ({ href, children }) => {
      const target = typeof href === 'string' ? docLinkTarget(href, tab.source === 'local', docDir) : null
      if (!target) {
        return (
          <a href={href} title={typeof href === 'string' ? href : undefined} className="doc-link" onClick={(e) => e.preventDefault()}>
            {children}
          </a>
        )
      }
      return (
        <a
          href={href}
          title={target}
          className="doc-link doc-link-file"
          onClick={(e) => {
            e.preventDefault()
            if (tab.source === 'local') void openLocalDoc(target, tab.paneId)
            else if (tab.sessionId) void openRemoteDoc(tab.sessionId, target, tab.paneId)
          }}
        >
          {children}
        </a>
      )
    },
    // 宽表横向滚动在自己的容器内（页面不横向滚）
    table: ({ children }) => (
      <div className="doc-table-wrap">
        <table>{children}</table>
      </div>
    ),
    // 远程图被渲染层 CSP 拦截（img-src 'self' data:）：data: 直显，其余降级为占位 chip
    img: ({ src, alt }) => (
      typeof src === 'string' && src.startsWith('data:')
        ? <img src={src} alt={alt ?? ''} className="doc-img" />
        : <span className="doc-img-off" title={typeof src === 'string' ? src : undefined}>[img] {alt || ''}</span>
    )
  }), [tab, docDir])

  return (
    <div ref={scrollRef} className={`doc-body h-full overflow-y-auto${panMode ? ' doc-pan' : ''}`} style={{ fontFamily: DEFAULT_FONT_FAMILY }}>
      {/* doc-grid 内层网格：滚动容器兼容器查询锚点（窄 pane 收起大纲栏须改网格自身） */}
      <div className={headings.length > 0 ? 'doc-grid' : 'doc-grid doc-grid-plain'}>
        <OutlineRail headings={headings} scrollRef={scrollRef} />
        {/* zoom 挂内容列：整体缩放（含 px 字号/代码块/表格），块级自适应宽度回流不出横向滚动条；大纲轨不缩 */}
        <div className="doc-content" style={{ zoom }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

export default MarkdownDoc
