import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'
import './TerminalSearchPanel.css'

interface SearchOptionProps {
  checked: boolean
  label: string
  title?: string
  onChange: () => void
  radio?: boolean
  name?: string
}

// 保留原生复选/单选键盘行为，在选项框里落一笔粗细有致的墨勾。
const SearchOption: React.FC<SearchOptionProps> = ({ checked, label, title, onChange, radio, name }) => (
  <label className="terminal-search-option" title={title}>
    <input
      type={radio ? 'radio' : 'checkbox'}
      name={name}
      checked={checked}
      onChange={onChange}
    />
    <span className="terminal-search-mark" aria-hidden="true">
      <svg viewBox="0 0 28 28" focusable="false">
        <path d="M3.5 13.1 C5.8 13.5 8.4 16.4 10.4 18.4 C14.8 13.7 20.5 6.8 25.4 3.6 C21.9 8.1 16.6 17.2 12.2 23.4 C11.4 24.5 10.3 24.9 9.5 23.8 C7.8 21.1 5.8 17.3 3.5 13.1 Z" />
        <path className="terminal-search-dry-ink" d="M12.1 20.7 L18.6 11.3 L13 20.1 Z" />
      </svg>
    </span>
    <span>{label}</span>
  </label>
)

interface TerminalSearchPanelProps {
  inputRef: React.RefObject<HTMLTextAreaElement>
  position: { x: number; y: number } | null
  isDragging: boolean
  searchText: string
  searchScope: 'current' | 'all'
  caseSensitive: boolean
  useRegex: boolean
  wholeWord: boolean
  invalidRegex: boolean
  matchInfo: { idx: number; total: number }
  onDragStart: React.MouseEventHandler<HTMLDivElement>
  onSearchChange: (text: string) => void
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>
  onSearch: (direction: 'next' | 'prev') => void
  onClose: () => void
  onCaseSensitiveChange: () => void
  onRegexChange: () => void
  onWholeWordChange: () => void
  onScopeChange: (scope: 'current' | 'all') => void
}

const TerminalSearchPanel: React.FC<TerminalSearchPanelProps> = (props) => {
  const { t } = useTranslation()
  const scopeName = useId()
  const statusId = useId()
  const { searchScope, searchText, matchInfo } = props

  return (
    <div
      data-search-panel
      className="terminal-search-scroll"
      role="search"
      aria-label={t('terminal.search.placeholder')}
      style={props.position ? { left: props.position.x, top: props.position.y } : { right: 12, top: 8 }}
    >
      {/* 上轴兼作拖动把手，下轴压住纸尾；木材跟随全局画轴材质。 */}
      <div
        className={`terminal-search-handle ${props.isDragging ? 'is-dragging' : ''}`}
        onMouseDown={props.onDragStart}
        title={t('terminal.search.dragToMove')}
      >
        <span className="rod-caps terminal-search-axis" aria-hidden="true">
          <span className="scroll-rod-collar scroll-rod-collar-l" />
          <span className="scroll-rod-collar scroll-rod-collar-r" />
        </span>
      </div>
      <div className="terminal-search-sheet">
        <div className="terminal-search-frame">
          <div className="terminal-search-query">
            <span className="terminal-search-symbol" aria-hidden="true">⌕</span>
            <textarea
              ref={props.inputRef}
              value={searchText}
              onChange={(e) => props.onSearchChange(e.target.value)}
              onKeyDown={props.onKeyDown}
              placeholder={t('terminal.search.placeholder')}
              aria-label={t('terminal.search.placeholder')}
              aria-invalid={props.invalidRegex}
              aria-describedby={props.invalidRegex ? statusId : undefined}
              autoFocus
              rows={1}
            />
            <button type="button" onClick={() => props.onSearch('prev')} title={t('terminal.search.previous')} aria-label={t('terminal.search.previous')}>↑</button>
            <button type="button" onClick={() => props.onSearch('next')} title={t('terminal.search.next')} aria-label={t('terminal.search.next')}>↓</button>
            <button type="button" className="terminal-search-close" onClick={props.onClose} title={t('terminal.search.close')} aria-label={t('terminal.search.close')}>✕</button>
          </div>

          <div className="terminal-search-options">
            <SearchOption checked={props.caseSensitive} label={t('terminal.search.matchCase')} onChange={props.onCaseSensitiveChange} />
            <SearchOption checked={props.useRegex} label={t('terminal.search.regex')} onChange={props.onRegexChange} />
            <SearchOption checked={props.wholeWord} label={t('terminal.search.wholeWord')} onChange={props.onWholeWordChange} />
          </div>

          <div className="terminal-search-results">
            <span id={statusId} className={`terminal-search-count${props.invalidRegex ? ' terminal-search-error' : ''}`} role="status" aria-live="polite">
              {props.invalidRegex
                ? t('terminal.search.invalidRegex')
                : searchScope === 'all'
                ? <span title={t('terminal.search.allTabsNoCount')}>—</span>
                : searchText
                  ? matchInfo.total === -1
                    ? t('terminal.search.matchesOverLimit')
                    : matchInfo.total === 0
                      ? t('terminal.search.noMatches')
                      : <><strong>{matchInfo.idx + 1}</strong> / {matchInfo.total}</>
                  : '—'}
            </span>
            <div className="terminal-search-scope" role="radiogroup" aria-label={t('terminal.search.scopeLabel')}>
              <span>{t('terminal.search.scopeLabel')}</span>
              <SearchOption radio name={scopeName} checked={searchScope === 'current'} label={t('terminal.search.scopeCurrent')} title={t('terminal.search.searchThisTab')} onChange={() => props.onScopeChange('current')} />
              <SearchOption radio name={scopeName} checked={searchScope === 'all'} label={t('terminal.search.scopeAll')} title={t('terminal.search.searchAllTabs')} onChange={() => props.onScopeChange('all')} />
            </div>
          </div>

          <div className="terminal-search-hints">
            <span><kbd>↵</kbd>{t('terminal.search.hintNext')}</span>
            <span><kbd>⇧↵</kbd>{t('terminal.search.hintPrev')}</span>
            <span><kbd>Alt A</kbd>{t('terminal.search.hintScope')}</span>
            <span><kbd>Esc</kbd>{t('terminal.search.hintClose')}</span>
          </div>
        </div>
      </div>
      <div className="terminal-search-foot" aria-hidden="true">
        <span className="rod-caps terminal-search-axis">
          <span className="scroll-rod-collar scroll-rod-collar-l" />
          <span className="scroll-rod-collar scroll-rod-collar-r" />
        </span>
      </div>
    </div>
  )
}

export default TerminalSearchPanel
