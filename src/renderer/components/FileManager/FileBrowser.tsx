import React, { useState, useMemo } from 'react'
import cn from 'classnames'
import { categorizeFile, formatSize, formatMtime, pathSegments, type FileCategory } from './fileType'

interface FileInfo {
  name: string
  path: string
  isDir: boolean
  size: number
  modifyTime: Date | string
}

interface FileBrowserProps {
  files: FileInfo[]
  currentPath: string
  loading: boolean
  hasSession: boolean
  sessionId: string | null
  filterPattern: string
  onFilterChange: (pattern: string) => void
  onEnterDir: (file: FileInfo) => void
  onGoUp: () => void
  onDownload: (file: FileInfo) => void
  onRefresh: () => void
  onNavigateTo?: (absPath: string) => void
}

type SortKey = 'name' | 'size' | 'mtime'
type SortDir = 'asc' | 'desc'

// ─────────────── 图标 ───────────────

const IconUp = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M5.5 9V2M2 5.5l3.5-3.5L9 5.5"/></svg>
)
const IconFilter = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M1 2h9M3 5.5h5M5 9h1"/></svg>
)
const IconRefresh = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M1.5 3.5a4 4 0 1 1-.3 3.5M1.5 1v2.5h2.5"/></svg>
)
const IconCopy = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><rect x="3" y="3" width="6" height="6"/><path d="M2 7V2h5"/></svg>
)

// 文件类型对应的极简单色 SVG glyph
const FileGlyph: React.FC<{ ft: FileCategory }> = ({ ft }) => {
  if (ft === 'dir') return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="currentColor"><path d="M1 2h3.5l1 1H10v6H1V2z"/></svg>
  )
  if (ft === 'log') return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 1h5l2 2v7H2V1z"/></svg>
  )
  if (ft === 'arch') return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 1h5l2 2v7H2V1zM4.5 4v6"/></svg>
  )
  if (ft === 'src') return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 1h5l2 2v7H2V1zM4 5l-1 1.5L4 8M7 5l1 1.5L7 8"/></svg>
  )
  if (ft === 'img') return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="2" width="9" height="7"/><circle cx="4" cy="5" r="1"/><path d="M1 8l3-2 6 3"/></svg>
  )
  if (ft === 'bin') return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 1h7v9H2V1zM4 4h3M4 6h3M4 8h2"/></svg>
  )
  return (
    <svg width="13" height="13" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 1h5l2 2v7H2V1z"/></svg>
  )
}

const ftStripBg = (ft: FileCategory): string => {
  switch (ft) {
    case 'dir':   return 'bg-[var(--ft-dir)]'
    case 'src':   return 'bg-[var(--ft-src)]'
    case 'log':   return 'bg-[var(--ft-log)]'
    case 'arch':  return 'bg-[var(--ft-arch)]'
    case 'img':   return 'bg-[var(--ft-img)]'
    case 'bin':   return 'bg-[var(--ft-bin)]'
    default:      return 'bg-[var(--ft-other)]'
  }
}

const ftGlyphColor = (ft: FileCategory): string => {
  if (ft === 'dir') return 'text-[var(--ft-dir)] opacity-75'
  return 'text-[var(--text-rack-dim)]'
}

const mtimeColor = (tier: 'recent' | 'fresh' | ''): string => {
  if (tier === 'recent') return 'text-[var(--live)]'
  if (tier === 'fresh')  return 'text-[var(--text-rack-data)]'
  return 'text-[var(--text-rack-mute)]'
}

/**
 * 文件浏览子组件 — 面包屑路径 / 列头排序 / 3px 类型色条行 / 内联可展开 MD5
 */
const FileBrowser: React.FC<FileBrowserProps> = ({
  files, currentPath, loading, hasSession, sessionId,
  filterPattern, onFilterChange,
  onEnterDir, onGoUp, onDownload, onRefresh, onNavigateTo
}) => {
  const [md5Values, setMd5Values] = useState<Record<string, string>>({})
  const [md5Loading, setMd5Loading] = useState<Record<string, boolean>>({})
  const [expandedMd5, setExpandedMd5] = useState<Record<string, boolean>>({})
  const [showFilter, setShowFilter] = useState(false)
  const [sortBy, setSortBy] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // 处理 MD5 按钮：未取得时拉取并展开；已取得时切换展开状态
  const handleMd5Click = async (file: FileInfo) => {
    if (!sessionId) return
    if (md5Values[file.path]) {
      setExpandedMd5(prev => ({ ...prev, [file.path]: !prev[file.path] }))
      return
    }
    setExpandedMd5(prev => ({ ...prev, [file.path]: true }))
    setMd5Loading(prev => ({ ...prev, [file.path]: true }))
    try {
      const result = await window.electronAPI.fileMd5(sessionId, file.path)
      if (result.success && result.data) {
        setMd5Values(prev => ({ ...prev, [file.path]: result.data }))
      } else {
        setMd5Values(prev => ({ ...prev, [file.path]: '获取失败' }))
      }
    } catch {
      setMd5Values(prev => ({ ...prev, [file.path]: '获取失败' }))
    }
    setMd5Loading(prev => ({ ...prev, [file.path]: false }))
  }

  const handleCopyMd5 = (hash: string) => {
    if (hash && hash !== '获取失败') {
      navigator.clipboard?.writeText(hash).catch(() => {})
    }
  }

  // 排序：dir 永远先于 file，组内按选中列排序
  const sortedFiles = useMemo(() => {
    const arr = [...files]
    const dirs = arr.filter(f => f.isDir)
    const regs = arr.filter(f => !f.isDir)
    const cmp = (a: FileInfo, b: FileInfo): number => {
      let r = 0
      if (sortBy === 'name') {
        r = a.name.localeCompare(b.name)
      } else if (sortBy === 'size') {
        r = (a.size || 0) - (b.size || 0)
      } else {
        const ta = new Date(a.modifyTime).getTime() || 0
        const tb = new Date(b.modifyTime).getTime() || 0
        r = ta - tb
      }
      return sortDir === 'asc' ? r : -r
    }
    dirs.sort(cmp)
    regs.sort(cmp)
    return [...dirs, ...regs]
  }, [files, sortBy, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortDir(key === 'mtime' ? 'desc' : 'asc')
    }
  }

  const SortableCol: React.FC<{
    keyName: SortKey
    align?: 'left' | 'right'
    children: React.ReactNode
  }> = ({ keyName, align, children }) => {
    const active = sortBy === keyName
    const arrow = sortDir === 'asc' ? '↑' : '↓'
    return (
      <button
        onClick={() => toggleSort(keyName)}
        className={cn(
          'bg-transparent border-none cursor-pointer p-0 inline-flex items-center gap-0.5',
          'font-semibold tracking-[.14em] text-[10px] uppercase',
          align === 'right' ? 'justify-end' : '',
          active ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] hover:text-[var(--text-rack-data)]'
        )}
      >
        {children}
        {active && <span className="font-mono font-normal">{arrow}</span>}
      </button>
    )
  }

  const segments = pathSegments(currentPath)

  return (
    <div className="flex flex-col h-full bg-[var(--bg-base)]">
      {/* ===== 路径 / 面包屑 ===== */}
      <div className="flex items-center px-2.5 py-1.5 bg-[var(--bg-rack)] border-b border-[var(--rule-soft)] min-h-[26px] gap-1">
        <button
          onClick={onGoUp}
          disabled={currentPath === '/'}
          title="上级目录"
          className={cn(
            'w-[18px] h-[18px] inline-flex items-center justify-center bg-transparent border-none rounded-[2px] mr-0.5',
            currentPath === '/'
              ? 'text-[var(--text-rack-faint)] cursor-not-allowed'
              : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] cursor-pointer'
          )}
        >
          <IconUp />
        </button>
        <div className="flex items-center flex-1 min-w-0 font-mono text-[12.5px] overflow-hidden whitespace-nowrap">
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1
            return (
              <React.Fragment key={seg.abs}>
                <span
                  onClick={!isLast && onNavigateTo ? () => onNavigateTo(seg.abs) : undefined}
                  className={cn(
                    'px-1 py-[1px] rounded-[2px] flex-shrink-0',
                    isLast
                      ? 'text-[var(--text-rack)] cursor-default'
                      : 'text-[var(--text-rack-data)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] cursor-pointer'
                  )}
                  title={seg.abs}
                >
                  {seg.label}
                </span>
                {!isLast && <span className="text-[var(--text-rack-faint)] mx-px flex-shrink-0">›</span>}
              </React.Fragment>
            )
          })}
        </div>
        <div className="flex flex-shrink-0">
          <button
            onClick={() => setShowFilter(!showFilter)}
            title="筛选文件"
            className={cn(
              'w-[20px] h-[20px] inline-flex items-center justify-center bg-transparent border-none rounded-[2px] cursor-pointer transition-colors',
              (showFilter || filterPattern)
                ? 'text-[var(--amber)] bg-[var(--amber-soft)]'
                : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--amber)]'
            )}
          >
            <IconFilter />
          </button>
          <button
            onClick={onRefresh}
            title="刷新"
            className="w-[20px] h-[20px] inline-flex items-center justify-center bg-transparent border-none rounded-[2px] cursor-pointer text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] transition-colors"
          >
            <IconRefresh />
          </button>
        </div>
      </div>

      {/* ===== 筛选输入 ===== */}
      {showFilter && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--bg-rack)] border-b border-[var(--rule-soft)]">
          <input
            type="text"
            value={filterPattern}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="*.log, *.conf"
            autoFocus
            className="flex-1 bg-[var(--bg-base)] border border-[var(--rule)] rounded-[2px] px-2 py-[3px] font-mono text-[12.5px] text-[var(--text-rack)] placeholder:text-[var(--text-rack-faint)] focus:outline-none focus:border-[var(--amber)]"
          />
          {filterPattern && (
            <button
              onClick={() => onFilterChange('')}
              className="text-[12.5px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] px-1"
              title="清除筛选"
            >
              ✕
            </button>
          )}
          <span className="font-mono text-[11.5px] text-[var(--text-rack-mute)] flex-shrink-0">{files.length}</span>
        </div>
      )}

      {/* ===== 列头 ===== */}
      {hasSession && !loading && files.length > 0 && (
        <div className="grid grid-cols-[3px_16px_1fr_64px_56px_36px] gap-2 pl-0 pr-2.5 py-1.5 border-b border-[var(--rule-soft)] items-center">
          <span /><span />
          <SortableCol keyName="name">name</SortableCol>
          <SortableCol keyName="size" align="right">size</SortableCol>
          <SortableCol keyName="mtime" align="right">mtime</SortableCol>
          <span />
        </div>
      )}

      {/* ===== 列表主体 ===== */}
      <div
        className="flex-1 overflow-auto rack-scroll"
        onContextMenu={(e) => { e.preventDefault(); onGoUp() }}
      >
        {!hasSession ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
            <span className="font-mono text-[18px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
            <span className="text-[13px] text-[var(--text-rack-mute)]">attach a remote session to browse</span>
            <span className="font-mono text-[12px] text-[var(--text-rack-faint)]">click any session in the rack above</span>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full text-[13px] text-[var(--text-rack-mute)]">
            loading…
          </div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[13px] text-[var(--text-rack-mute)]">
            empty directory
          </div>
        ) : (
          <div>
            {sortedFiles.map(file => {
              const ft = categorizeFile(file.name, file.isDir)
              const mt = formatMtime(file.modifyTime)
              const isExpanded = !!expandedMd5[file.path]
              const hash = md5Values[file.path]
              return (
                <div
                  key={file.path}
                  onClick={() => file.isDir && onEnterDir(file)}
                  data-ft={ft}
                  className={cn(
                    'group relative grid grid-cols-[3px_16px_1fr_64px_56px_36px] gap-2 pl-0 pr-2.5 py-[7px] items-center min-h-[32px] transition-colors',
                    file.isDir ? 'cursor-pointer' : 'cursor-default',
                    'hover:bg-[var(--bg-rack)]'
                  )}
                >
                  <span className={cn('h-[22px] w-[3px] rounded-r-[2px]', ftStripBg(ft))} />
                  <span className={cn('w-[16px] h-[16px] inline-flex items-center justify-center', ftGlyphColor(ft))}>
                    <FileGlyph ft={ft} />
                  </span>
                  <div className="min-w-0 flex flex-col gap-px">
                    <span
                      className={cn(
                        'text-[13px] truncate whitespace-nowrap overflow-hidden',
                        file.isDir ? 'text-[var(--text-rack)] font-medium' : 'text-[var(--text-rack)]'
                      )}
                      title={file.name}
                    >
                      {file.name}
                    </span>
                    {isExpanded && !file.isDir && (
                      <div className="font-mono text-[12px] text-[var(--text-rack-mute)] flex items-center gap-1.5 mt-px whitespace-nowrap min-w-0">
                        <span className="text-[var(--text-rack-faint)] flex-shrink-0">md5</span>
                        <span className={cn('truncate', hash === '获取失败' ? 'text-[var(--error-rack)]' : 'text-[var(--text-rack-data)]')}>
                          {md5Loading[file.path] ? '…' : (hash || '…')}
                        </span>
                        {hash && hash !== '获取失败' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCopyMd5(hash) }}
                            title="复制"
                            className="w-[14px] h-[14px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-rack-mute)] hover:text-[var(--amber)] flex-shrink-0"
                          >
                            <IconCopy />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <span className={cn('font-mono text-[12.5px] text-right tracking-[-.02em]', file.isDir ? 'text-[var(--text-rack-faint)]' : 'text-[var(--text-rack-data)]')}>
                    {file.isDir ? '—' : formatSize(file.size)}
                  </span>
                  <span className={cn('font-mono text-[12.5px] text-right', mtimeColor(mt.tier))}>
                    {mt.text}
                  </span>
                  {/* 行动作（hover 显露） */}
                  {!file.isDir && (
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex justify-end items-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleMd5Click(file) }}
                        disabled={md5Loading[file.path]}
                        title="MD5"
                        className={cn(
                          'w-[24px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] font-mono text-[12px]',
                          md5Loading[file.path]
                            ? 'text-[var(--text-rack-mute)] cursor-wait'
                            : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--text-rack)]'
                        )}
                      >
                        {md5Loading[file.path] ? '·' : '#'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDownload(file) }}
                        title="下载"
                        className="w-[24px] h-[22px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] font-mono text-[12px] text-[var(--text-rack-mute)] hover:bg-[var(--bg-elev)] hover:text-[var(--amber)]"
                      >
                        ↓
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default FileBrowser
