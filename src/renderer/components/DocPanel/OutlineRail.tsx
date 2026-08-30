import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import cn from 'classnames'

/** 从 markdown 源提取的标题（不含 id —— 滚动定位按 DOM 序对齐，避免 slug 去重问题） */
export interface DocHeading {
  level: number  // 1-4
  text: string
}

/* ---------- 目录轨宽度：CSS 变量驱动 grid 列宽，localStorage 持久化 ---------- */

const RAIL_DEFAULT_W = 160
const RAIL_MIN_W = 120
const RAIL_MAX_W = 320
const RAIL_W_KEY = 'lyshell.docRailWidth'

/** 应用到 :root 的 CSS 变量 —— 所有文档页签共享同一偏好（免 prop 传递） */
function applyRailWidth(w: number): void {
  document.documentElement.style.setProperty('--doc-rail-w', `${w}px`)
}

/** 读当前生效宽度（拖动中直接写 DOM，不在 React 状态里），回落默认值 */
function readRailWidth(): number {
  const v = Number.parseFloat(document.documentElement.style.getPropertyValue('--doc-rail-w'))
  return Number.isFinite(v) && v > 0 ? v : RAIL_DEFAULT_W
}

function persistRailWidth(): void {
  try { localStorage.setItem(RAIL_W_KEY, String(readRailWidth())) } catch { /* localStorage 不可用就仅本次生效 */ }
}

function clampRailWidth(w: number): number {
  return Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, w))
}

/* ---------- 分级折叠（纯函数，独立可测） ---------- */

/** 行 i 是否有子标题：紧随其后的标题层级更深即算 */
export function hasChildrenAt(headings: DocHeading[], i: number): boolean {
  const next = headings[i + 1]
  return next !== undefined && next.level > headings[i].level
}

/** 折叠后的可见行：收起行 i 后跳过其后所有更深层级，直到回到不深于 i 的层级 */
export function visibleHeadingIdxs(headings: DocHeading[], collapsed: ReadonlySet<number>): number[] {
  const out: number[] = []
  let suppress = 0
  for (let i = 0; i < headings.length; i++) {
    if (suppress > 0) {
      if (headings[i].level > suppress) continue
      suppress = 0
    }
    out.push(i)
    if (collapsed.has(i)) suppress = headings[i].level
  }
  return out
}

/** 展示用激活行：激活标题被折叠隐藏时，上溯最近的可见祖先替它持高亮 */
export function displayActiveIdx(headings: DocHeading[], visibleIdxs: number[], activeIdx: number): number {
  if (activeIdx < 0 || visibleIdxs.includes(activeIdx)) return activeIdx
  for (let j = visibleIdxs.length - 1; j >= 0; j--) {
    if (visibleIdxs[j] < activeIdx && headings[visibleIdxs[j]].level < headings[activeIdx].level) {
      return visibleIdxs[j]
    }
  }
  return -1
}

/**
 * 大纲栏 — 全高轨道（右边线拉到底）+ sticky 目录 + scrollspy + 分级折叠。
 * 激活项 = 最后一个 top ≤ 阈值的标题；点击平滑滚动到对应标题元素
 * （按 .doc-content 内 h1-h4 的 DOM 序与本组件收到的 headings 序一致对位）。
 * 有子标题的行首有 ▾ 折叠钮（收起隐藏全部后代；激活标题被折叠隐藏时高亮
 * 最近的可见祖先）。激活标记是贴着右缘分隔线的 amber 手柄，随 scrollspy
 * 沿边线滑动；边线可拖拽调宽（双击复位，←/→ 微调），宽度全局共享并持久化。
 */
const OutlineRail: React.FC<{
  headings: DocHeading[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}> = ({ headings, scrollRef }) => {
  const { t } = useTranslation()
  const [activeIdx, setActiveIdx] = useState(-1)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const navRef = useRef<HTMLElement | null>(null)
  // 折叠态：headings 索引键（内容变化/刷新即重置 —— 索引会漂移）
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  // 手柄几何：top/height 保留上一帧（隐藏时只降 opacity，重现可滑入）
  const [marker, setMarker] = useState({ top: 0, height: 0, visible: false })
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => { setCollapsed(new Set()) }, [headings])

  // 折叠后的可见行与展示用激活行（纯函数见上方折叠段）
  const visibleIdxs = useMemo(() => visibleHeadingIdxs(headings, collapsed), [headings, collapsed])
  const displayActive = useMemo(
    () => displayActiveIdx(headings, visibleIdxs, activeIdx),
    [headings, visibleIdxs, activeIdx]
  )

  const toggleFold = (i: number): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  // 恢复上次宽度（多实例幂等；无存储时不设变量，CSS 默认 160px 生效）
  useEffect(() => {
    try {
      const v = Number.parseFloat(localStorage.getItem(RAIL_W_KEY) || '')
      if (Number.isFinite(v) && v >= RAIL_MIN_W && v <= RAIL_MAX_W) applyRailWidth(v)
    } catch { /* localStorage 不可用走默认 */ }
  }, [])

  // scrollspy：节流到 rAF，滚出可视区的重复计算不触发 setState
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let raf = 0
    const update = () => {
      raf = 0
      const hs = container.querySelectorAll<HTMLElement>('.doc-content h1, .doc-content h2, .doc-content h3, .doc-content h4')
      const baseTop = container.getBoundingClientRect().top
      let idx = -1
      hs.forEach((h, i) => {
        if (h.getBoundingClientRect().top - baseTop <= 20) idx = i
      })
      // 滚到底锁定最后一项：末尾章节短于视口时标题永远到不了顶部阈值
      if (hs.length > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        idx = hs.length - 1
      }
      setActiveIdx(prev => prev === idx ? prev : idx)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    update()
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [headings, scrollRef])

  // 手柄定位：量展示用激活项在列表里的 offset；目录超长时把它滚进目录轨可视区。
  // 折叠/展开会重排列表且可能切换 displayActive（隐藏 → 祖先持高亮），都须重量
  useLayoutEffect(() => {
    const el = displayActive >= 0 ? itemRefs.current[displayActive] : null
    if (!el) {
      setMarker(m => (m.visible ? { ...m, visible: false } : m))
      return
    }
    setMarker({ top: el.offsetTop, height: el.offsetHeight, visible: true })
    const nav = navRef.current
    if (nav && nav.scrollHeight > nav.clientHeight) {
      const top = el.offsetTop
      const bottom = top + el.offsetHeight
      if (top < nav.scrollTop) nav.scrollTop = top
      else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight
    }
  }, [displayActive, headings, collapsed])

  if (headings.length === 0) return null

  const scrollTo = (idx: number) => {
    const container = scrollRef.current
    if (!container) return
    const hs = container.querySelectorAll<HTMLElement>('.doc-content h1, .doc-content h2, .doc-content h3, .doc-content h4')
    hs[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // 立即高亮被点击项：滚不动（已在目标位/到底了）时没有 scroll 事件可依赖
    setActiveIdx(idx)
  }

  // ----- 拖拽调宽（Pointer Capture：移出窗口仍跟踪；拖动中直接写 CSS 变量，松手才持久化） -----
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragState.current = { startX: e.clientX, startW: readRailWidth() }
    setDragging(true)
    document.body.classList.add('doc-rail-dragging')
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragState.current
    if (!s) return
    applyRailWidth(clampRailWidth(s.startW + e.clientX - s.startX))
  }
  const onResizeEnd = () => {
    if (!dragState.current) return
    dragState.current = null
    setDragging(false)
    document.body.classList.remove('doc-rail-dragging')
    persistRailWidth()
  }
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -8 : e.key === 'ArrowRight' ? 8 : 0
    if (!step) return
    e.preventDefault()
    applyRailWidth(clampRailWidth(readRailWidth() + step))
    persistRailWidth()
  }
  const onResizeReset = () => {
    applyRailWidth(RAIL_DEFAULT_W)
    persistRailWidth()
  }

  return (
    <div className="doc-rail-track">
      <nav ref={navRef} className="doc-rail rack-scroll" aria-label={t('doc.outline')}>
        <div className="doc-rail-label">
          {t('doc.outline')}
          <span className="doc-rail-count">
            {collapsed.size > 0 ? `${visibleIdxs.length}/${headings.length}` : headings.length}
          </span>
        </div>
        <div className="doc-rail-list">
          {visibleIdxs.map(i => {
            const h = headings[i]
            const folded = collapsed.has(i)
            return (
              <button
                key={`${i}-${h.text}`}
                ref={el => { itemRefs.current[i] = el }}
                type="button"
                onClick={() => scrollTo(i)}
                data-level={h.level}
                title={h.text}
                aria-current={i === displayActive ? 'location' : undefined}
                className={cn('doc-rail-item', i === displayActive && 'on')}
              >
                {/* 折叠钮：有子标题才有箭头（叶子渲染占位空 span 保持同级文本对齐）；点它只折叠不滚动 */}
                <span
                  aria-hidden
                  className={cn('doc-rail-fold', !hasChildrenAt(headings, i) && 'leaf', hasChildrenAt(headings, i) && folded && 'closed')}
                  title={hasChildrenAt(headings, i) ? (folded ? t('doc.unfold') : t('doc.fold')) : undefined}
                  onClick={(e) => {
                    if (!hasChildrenAt(headings, i)) return
                    e.stopPropagation()
                    toggleFold(i)
                  }}
                />
                {h.text}
              </button>
            )
          })}
          <span
            className="doc-rail-marker"
            style={{ top: marker.top, height: marker.height, opacity: marker.visible ? 1 : 0 }}
          />
        </div>
      </nav>
      <div
        className={cn('doc-rail-resizer', dragging && 'dragging')}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('doc.railResize')}
        title={t('doc.railResize')}
        tabIndex={0}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={onResizeReset}
        onKeyDown={onResizeKey}
      />
    </div>
  )
}

export default OutlineRail
