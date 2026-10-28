import React, { lazy, Suspense, useState, useEffect } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useThemeStore, AVAILABLE_THEMES, CUSTOM_THEME_ID, deriveCustomVars, useLocaleStore, AVAILABLE_LOCALES, usePaneStore } from '@/stores'
import { isCursorBlinkEnabled, DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_STEP, snapTerminalFontSize } from '@shared/constants'
import { PanelHeader } from './PanelHeader'
import releaseNotes from '../../../../CHANGELOG.md?raw'
import './SettingsPanel.css'
import { usePluginStore } from '@/stores/plugin-store'
import { makePluginViewKey } from '@shared/plugin-types'
import PluginViewPanel from './PluginViewPanel'
import BrowserSettingsPanel, { type BrowserSettingsCategory } from './BrowserSettingsPanel'
import { SettingsBackGlyph, SettingsNavigation } from './SettingsNavigation'
import { useTaskShelf } from '../../stores/task-shelf'
import { DEFAULT_TASK_SHELF_PREFERENCES } from '@shared/task-shelf'
import type { NavTab } from './ActivityRail'

const EnvProfilePanel = lazy(() => import('./EnvProfilePanel'))
const CodeWorkspaceSettings = lazy(() => import('./CodeWorkspaceSettings'))

/**
 * 设置面板按用途导航，每次只展示当前分类，适配可调宽的左侧栏。
 * 设置值沿用 localStorage + IPC 持久化；主题/语言初始化仍由 MainWindow 负责。
 * MCP 配置入口保留在 /help 手册的「MCP 集成」段。
 */

/**
 * 主窗口尺寸预设(像素) -- 常见分辨率 + 默认 1200×800
 */
const WINDOW_PRESETS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1200, height: 800 }
]

/**
 * 统一分区标题和卡片留白，视觉样式只作用于设置面板。
 */
const SettingCard: React.FC<{
  title: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
}> = ({ title, right, children }) => (
  <section className="settings-card">
    {title && <div className="settings-card-heading">
      <h2>{title}</h2>
      {right}
    </div>}
    {children}
  </section>
)

const CheckMark: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const NumberStepper: React.FC<{
  label: string
  canDecrease: boolean
  canIncrease: boolean
  onStep: (direction: -1 | 1) => void
}> = ({ label, canDecrease, canIncrease, onStep }) => {
  const { t } = useTranslation()
  return <span className="settings-number-stepper">
    {([1, -1] as const).map(direction => {
      const action = t(direction === 1 ? 'settings.increaseValue' : 'settings.decreaseValue', { setting: label })
      return <button key={direction} type="button" title={action} aria-label={action} disabled={direction === 1 ? !canIncrease : !canDecrease} onMouseDown={event => event.preventDefault()} onClick={() => onStep(direction)}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === 1 ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
      </button>
    })}
  </span>
}

export interface SettingsViewRequest {
  key: string
  nonce: number
  returnTo?: NavTab
}

const BUILTIN_VIEWS = ['home', '', 'browser', 'env', 'workspace']

const normalizeScrollback = (value: number) => Number.isFinite(value)
  ? Math.max(1000, Math.min(100000, Math.trunc(value)))
  : 10000

const SettingsPanel: React.FC<{
  requestedView?: SettingsViewRequest | null
  onReturnBrowser?: () => void
  onReturnPage?: () => void
}> = ({ requestedView, onReturnBrowser, onReturnPage }) => {
  const pluginItems = usePluginStore(state => state.items)
  const settingsViews = React.useMemo(() => pluginItems.flatMap(item => item.views).filter(view => view.surface === 'settings'), [pluginItems])
  const [selectedView, setSelectedView] = useState(requestedView?.key ?? 'home')
  const [browserCategory, setBrowserCategory] = useState<BrowserSettingsCategory | null>(null)
  const [browserVisited, setBrowserVisited] = useState(requestedView?.key === 'browser')
  const activeSettingsView = settingsViews.find(view => makePluginViewKey(view.pluginId, view.id) === selectedView)
  useEffect(() => { setSelectedView(requestedView?.key ?? 'home'); setBrowserCategory(null) }, [requestedView])
  useEffect(() => {
    if (!BUILTIN_VIEWS.includes(selectedView) && !activeSettingsView) setSelectedView('home')
  }, [selectedView, activeSettingsView])
  useEffect(() => { if (selectedView === 'browser') setBrowserVisited(true) }, [selectedView])
  const [scrollbackInput, setScrollbackInput] = useState(() => {
    const saved = localStorage.getItem('terminalScrollback')
    return String(normalizeScrollback(saved ? Number(saved) : 10000))
  })
  const scrollbackLines = Number(scrollbackInput)
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminalFontSize')
    return saved ? snapTerminalFontSize(parseInt(saved)) : DEFAULT_TERMINAL_FONT_SIZE
  })
  const [cursorBlink, setCursorBlink] = useState(() => isCursorBlinkEnabled())
  // 任务保存区快捷键：保存区面板只消费绑定，修改入口统一收在终端设置里。
  const shelfShortcuts = useTaskShelf(state => state.preferences)
  const [shortcutDraft, setShortcutDraft] = useState(shelfShortcuts)
  const [shortcutStatus, setShortcutStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)
  // 主窗口尺寸(像素) -- 持久化到 preferences,启动恢复;输入框双向绑定,点应用/预设时调 IPC
  const [windowSize, setWindowSize] = useState<{ width: number; height: number }>({ width: 1200, height: 800 })
  const { themeId, setTheme, customColors, setCustomColors } = useThemeStore()
  const { localeId, setLocale } = useLocaleStore()
  const { t } = useTranslation()
  const categories = [
    { key: '', icon: 'terminal', label: t('settings.terminalSettings'), hint: t('settings.navigation.terminal') },
    { key: 'browser', icon: 'browser', label: t('browser.title'), hint: t('settings.navigation.browser') },
    { key: 'env', icon: 'env', label: t('env.title'), hint: t('settings.navigation.env') },
    { key: 'workspace', icon: 'workspace', label: t('settings.workspace'), hint: t('settings.workspaceHint') },
    ...settingsViews.map(view => ({ key: makePluginViewKey(view.pluginId, view.id), icon: 'plugin', label: view.title }))
  ]
  const isHome = selectedView === 'home'
  const returnAction = onReturnPage ?? (requestedView?.returnTo === 'web' ? onReturnBrowser : undefined)
  const returnLabel = t(requestedView?.returnTo === 'web' ? 'settings.returnBrowser' : 'settings.returnPage')
  const title = isHome ? t('settings.title') : selectedView === 'browser' && browserCategory ? t(`browser.${browserCategory}`) : categories.find(item => item.key === selectedView)?.label ?? t('settings.title')
  const goBack = () => {
    if (selectedView === 'browser' && browserCategory) setBrowserCategory(null)
    else setSelectedView('home')
  }

  const applyFontSize = (value: number) => {
    const next = snapTerminalFontSize(value)
    setFontSize(next)
    localStorage.setItem('terminalFontSize', next.toString())
    window.dispatchEvent(new CustomEvent('terminalFontSizeChanged', { detail: next }))
  }

  const applyScrollback = (value: number) => {
    const next = normalizeScrollback(value)
    setScrollbackInput(String(next))
    localStorage.setItem('terminalScrollback', String(next))
  }

  // 持久化值变化（含后端规范化后的回执）时回填草稿；保存失败不覆盖用户输入。
  useEffect(() => { setShortcutDraft(shelfShortcuts) }, [shelfShortcuts])

  // 后端校验通过才采用新绑定，失败保留草稿并就地提示原因。
  const saveShelfShortcuts = async (event: React.FormEvent) => {
    event.preventDefault()
    const draft = shortcutDraft
    const saved = await useTaskShelf.getState().setPreferences(draft)
    setShortcutStatus(saved
      ? { kind: 'saved', text: t('settings.shelfShortcutsSaved') }
      : { kind: 'error', text: useTaskShelf.getState().error || t('settings.shelfShortcutsFailed') })
  }

  const applyWindowSize = async (w: number, h: number) => {
    const result = await window.electronAPI?.setWindowSize(w, h)
    if (result?.success) {
      setWindowSize({ width: result.width, height: result.height })
    }
  }

  // Ctrl+滚轮改字号时,同步设置面板的字号输入框(否则输入框还显示旧值)。
  // 输入框自身 onChange 也会派发同一事件,但 setFontSize 的是相同数值,React 会 bail out,无环路。
  useEffect(() => {
    const handler = (e: Event) => {
      const value = (e as CustomEvent<number>).detail
      if (typeof value === 'number' && Number.isFinite(value)) {
        setFontSize(value)
      }
    }
    window.addEventListener('terminalFontSizeChanged', handler as EventListener)
    return () => window.removeEventListener('terminalFontSizeChanged', handler as EventListener)
  }, [])

  // 加载已保存的窗口尺寸(回显输入框与预设高亮)
  useEffect(() => {
    if (!window.electronAPI) return
    const loadWindowSize = async () => {
      try {
        const saved = await window.electronAPI?.getConfig('window')
        if (saved && typeof saved === 'object') {
          const s = saved as { width?: number; height?: number }
          if (typeof s.width === 'number' && typeof s.height === 'number') {
            setWindowSize({ width: s.width, height: s.height })
          }
        }
      } catch { /* 静默:读失败回退默认值 */ }
    }
    loadWindowSize()
  }, [])

  // 当前窗口尺寸是否命中某个预设；命中则下拉回显该预设，否则显示"自定义"
  const activeWindowPreset = WINDOW_PRESETS.find(p => windowSize.width === p.width && windowSize.height === p.height)
  const customThemeVars = deriveCustomVars(customColors.base, customColors.accent)

  // 内置更新记录随应用打包，复用文档页签，无需网络或新增 IPC。
  const openReleaseNotes = () => {
    usePaneStore.getState().openDocTab(undefined, {
      source: 'builtin',
      docKind: 'markdown',
      path: 'lyshell://changelog.md',
      title: t('settings.releaseNotes'),
      content: releaseNotes,
      size: new TextEncoder().encode(releaseNotes).byteLength,
      mtime: 0
    })
  }

  return (
    <div className="settings-panel">
      {/* 头行与终端页签对齐，保留窗口拖拽区。 */}
      <PanelHeader
        title={t('settings.title')}
        titleAccessory={!requestedView?.returnTo && <button type="button" className="settings-version win-no-drag" title={t('settings.viewReleaseNotes')} aria-label={t('settings.versionReleaseNotes', { version: __APP_VERSION__ })} onClick={openReleaseNotes}>v{__APP_VERSION__}</button>}
        actions={requestedView?.returnTo && returnAction && <button type="button" className="settings-back win-no-drag" title={returnLabel} aria-label={returnLabel} onClick={returnAction}><SettingsBackGlyph /><span>{returnLabel}</span></button>}
      />
      <div className="settings-frame">
      {!isHome && selectedView !== 'env' && <button type="button" className="settings-category-header" title={t(selectedView === 'browser' && browserCategory ? 'browser.backToCategories' : 'settings.backToCategories')} aria-label={t(selectedView === 'browser' && browserCategory ? 'browser.backToCategories' : 'settings.backToCategories')} onClick={goBack}>
        <span className="settings-content-back" aria-hidden="true"><SettingsBackGlyph /></span>
        <span className="settings-category-title">{title}</span>
      </button>}
      {isHome && <div className="settings-content settings-index"><SettingsNavigation label={t('settings.section')} items={categories} onSelect={setSelectedView} /></div>}
      {/* 分类切换保留浏览器草稿；隐藏区域不参与布局或键盘导航。 */}
      {(browserVisited || selectedView === 'browser') && <div className="settings-browser-content" hidden={selectedView !== 'browser'}><BrowserSettingsPanel category={browserCategory} onCategoryChange={setBrowserCategory} /></div>}
      {selectedView === 'env' && <div className="settings-env-content"><Suspense fallback={null}><EnvProfilePanel embedded onBackToSettings={() => setSelectedView('home')} /></Suspense></div>}
      {activeSettingsView ? (
        <div className="settings-plugin-content">
          <PluginViewPanel key={selectedView} view={activeSettingsView} visible />
        </div>
      ) : !isHome && selectedView !== 'browser' && selectedView !== 'env' && <div className="settings-content" key={selectedView}>
        {selectedView === 'workspace' && <Suspense fallback={null}><CodeWorkspaceSettings /></Suspense>}
        {selectedView === '' && <><SettingCard title={t('settings.sections.terminal')}>
          <div className="settings-field-row">
            <label htmlFor="settings-terminal-font">{t('settings.font')}</label>
            <span className="settings-number-field">
              <input
                type="number"
                id="settings-terminal-font"
                aria-label={t('settings.font')}
                value={fontSize}
                onChange={(e) => {
                  // 编辑输入先保留草稿，原生步进立即生效，避免多位数输入期间被提前吸附。
                  const raw = parseInt(e.target.value)
                  const draft = Number.isFinite(raw) ? raw : DEFAULT_TERMINAL_FONT_SIZE
                  if ((e.nativeEvent as InputEvent).inputType == null) {
                    applyFontSize(draft)
                  } else {
                    setFontSize(draft)
                  }
                }}
                onBlur={() => applyFontSize(fontSize)}
                min={TERMINAL_FONT_SIZE_MIN}
                max={TERMINAL_FONT_SIZE_MAX}
                step={TERMINAL_FONT_SIZE_STEP}
              />
              <span className="settings-number-unit">{t('settings.px')}</span>
              <NumberStepper label={t('settings.font')} canDecrease={fontSize > TERMINAL_FONT_SIZE_MIN} canIncrease={fontSize < TERMINAL_FONT_SIZE_MAX} onStep={direction => applyFontSize(fontSize + direction * TERMINAL_FONT_SIZE_STEP)} />
            </span>
          </div>
          <div className="settings-field-row">
            <label htmlFor="settings-terminal-scrollback">{t('settings.buffer')}</label>
            <span className="settings-number-field">
              <input
                type="number"
                id="settings-terminal-scrollback"
                aria-label={t('settings.buffer')}
                value={scrollbackInput}
                onChange={e => {
                  const input = e.target.value
                  setScrollbackInput(input)
                  const value = Number(input)
                  // 合法输入立即持久化；编辑中的空值或越界草稿等失焦后统一校正。
                  if (Number.isInteger(value) && value >= 1000 && value <= 100000) {
                    localStorage.setItem('terminalScrollback', String(value))
                  }
                }}
                onBlur={() => applyScrollback(scrollbackLines)}
                onKeyDown={e => { if (e.key === 'Enter') applyScrollback(scrollbackLines) }}
                min={1000}
                max={100000}
                step={1000}
              />
              <span className="settings-number-unit">{t('settings.lines')}</span>
              <NumberStepper label={t('settings.buffer')} canDecrease={scrollbackLines > 1000} canIncrease={scrollbackLines < 100000} onStep={direction => applyScrollback(scrollbackLines + direction * 1000)} />
            </span>
          </div>
          <div className="settings-field-row">
            <span id="settings-cursor-label">{t('settings.cursor')}</span>
            <label className="settings-switch-label">
              <span>{cursorBlink ? t('settings.blinkOn') : t('settings.blinkOff')}</span>
              <input
                className="settings-switch"
                type="checkbox"
                role="switch"
                aria-labelledby="settings-cursor-label"
                checked={cursorBlink}
                onChange={(e) => {
                  setCursorBlink(e.target.checked)
                  localStorage.setItem('terminalCursorBlink', e.target.checked.toString())
                  window.dispatchEvent(new CustomEvent('terminalCursorBlinkChanged', { detail: e.target.checked }))
                }}
              />
            </label>
          </div>
          <p className="settings-note">{t('settings.applyHint')}</p>
        </SettingCard></>}

        {selectedView === '' && <SettingCard title={t('settings.shelfShortcuts')}>
          <form onSubmit={event => { void saveShelfShortcuts(event) }}>
            <div className="settings-field-row">
              <label htmlFor="settings-shelf-toggle">{t('settings.shelfToggleShortcut')}</label>
              <input
                id="settings-shelf-toggle"
                className="settings-input settings-shortcut-input"
                aria-label={t('settings.shelfToggleShortcut')}
                value={shortcutDraft.toggleShortcut}
                placeholder={DEFAULT_TASK_SHELF_PREFERENCES.toggleShortcut}
                spellCheck={false}
                autoComplete="off"
                onChange={event => {
                  setShortcutDraft(draft => ({ ...draft, toggleShortcut: event.target.value }))
                  setShortcutStatus(null)
                }}
              />
            </div>
            <div className="settings-field-row">
              <label htmlFor="settings-shelf-collect">{t('settings.shelfCollectShortcut')}</label>
              <input
                id="settings-shelf-collect"
                className="settings-input settings-shortcut-input"
                aria-label={t('settings.shelfCollectShortcut')}
                value={shortcutDraft.collectShortcut}
                placeholder="Ctrl+Shift+S"
                spellCheck={false}
                autoComplete="off"
                onChange={event => {
                  setShortcutDraft(draft => ({ ...draft, collectShortcut: event.target.value }))
                  setShortcutStatus(null)
                }}
              />
            </div>
            <p className="settings-note">{t('settings.shelfShortcutHint')}</p>
            <div className="settings-shortcut-actions">
              {shortcutStatus && (shortcutStatus.kind === 'error'
                ? <span className="settings-shortcut-error" role="alert">{shortcutStatus.text}</span>
                : <span className="settings-shortcut-status" role="status">{shortcutStatus.text}</span>)}
              <button type="button" className="settings-apply" onClick={() => {
                setShortcutDraft({ ...DEFAULT_TASK_SHELF_PREFERENCES })
                void useTaskShelf.getState().setPreferences({ ...DEFAULT_TASK_SHELF_PREFERENCES }).then(saved => {
                  setShortcutStatus(saved
                    ? { kind: 'saved', text: t('settings.shelfShortcutsSaved') }
                    : { kind: 'error', text: useTaskShelf.getState().error || t('settings.shelfShortcutsFailed') })
                })
              }}>{t('settings.restoreShelfDefaults')}</button>
              <button type="submit" className="settings-apply">{t('settings.saveShortcuts')}</button>
            </div>
          </form>
        </SettingCard>}

        {selectedView === '' && <><SettingCard
          title={t('settings.theme')}
          right={<span className="settings-current-value">{AVAILABLE_THEMES.find(theme => theme.id === themeId)?.name}</span>}
        >
          <div className="settings-theme-grid" role="group" aria-label={t('settings.theme')}>
            {AVAILABLE_THEMES.map(theme => {
              const active = themeId === theme.id
              return (
                <button
                  key={theme.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTheme(theme.id)}
                  title={t(theme.descriptionKey)}
                  className={cn('settings-theme', active && 'is-active')}
                >
                  <span
                    className="settings-theme-preview"
                    data-theme={theme.id}
                    style={theme.id === CUSTOM_THEME_ID ? customThemeVars as React.CSSProperties : undefined}
                    aria-hidden="true"
                  >
                    <span className="settings-theme-rail" />
                    <span className="settings-theme-screen" />
                  </span>
                  <span className="settings-theme-caption">
                    <span>{theme.name}</span>
                    {active && <CheckMark />}
                  </span>
                </button>
              )
            })}
          </div>
          {themeId === CUSTOM_THEME_ID && (
            <div className="settings-custom-colors">
              {(['base', 'accent'] as const).map(key => (
                <label key={key} className="settings-color-row">
                  <span>{t(key === 'base' ? 'settings.pickBaseColor' : 'settings.pickAccentColor')}</span>
                  <span className="settings-color-value">
                    <input
                      type="color"
                      value={customColors[key]}
                      aria-label={t(key === 'base' ? 'settings.pickBaseColor' : 'settings.pickAccentColor')}
                      onChange={e => setCustomColors({ [key]: e.target.value.toUpperCase() })}
                    />
                    <span>{customColors[key].toLowerCase()}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </SettingCard>

        <SettingCard title={t('settings.language')}>
          <div className="settings-language" role="group" aria-label={t('settings.language')}>
            {AVAILABLE_LOCALES.map(locale => (
              <button
                key={locale.id}
                type="button"
                aria-pressed={localeId === locale.id}
                onClick={() => setLocale(locale.id)}
                className={cn('settings-language-option', localeId === locale.id && 'is-active')}
              >
                {locale.name}
                {localeId === locale.id && <CheckMark />}
              </button>
            ))}
          </div>
        </SettingCard></>}

        {selectedView === '' && <SettingCard title={t('settings.windowSize')}>
          <select
            aria-label={t('settings.windowSize')}
            value={activeWindowPreset ? `${activeWindowPreset.width}x${activeWindowPreset.height}` : 'custom'}
            onChange={(e) => {
              const preset = WINDOW_PRESETS.find(p => `${p.width}x${p.height}` === e.target.value)
              if (preset) applyWindowSize(preset.width, preset.height)
            }}
            className="settings-input settings-preset"
          >
            {!activeWindowPreset && <option value="custom" disabled>{t('settings.custom')}</option>}
            {WINDOW_PRESETS.map(preset => (
              <option key={`${preset.width}x${preset.height}`} value={`${preset.width}x${preset.height}`}>
                {preset.width} × {preset.height}
              </option>
            ))}
          </select>
          <div className="settings-window-grid">
            <label>
              <span>{t('settings.width')}</span>
              <input
                type="number"
                value={windowSize.width}
                onChange={e => setWindowSize(size => ({ ...size, width: parseInt(e.target.value) || 0 }))}
                className="settings-input"
                min={800}
                step={10}
              />
            </label>
            <label>
              <span>{t('settings.height')}</span>
              <input
                type="number"
                value={windowSize.height}
                onChange={e => setWindowSize(size => ({ ...size, height: parseInt(e.target.value) || 0 }))}
                className="settings-input"
                min={600}
                step={10}
              />
            </label>
            <button
              type="button"
              onClick={() => applyWindowSize(windowSize.width, windowSize.height)}
              className="settings-apply"
            >
              {t('settings.apply')}
            </button>
          </div>
        </SettingCard>}

      </div>}
      </div>
    </div>
  )
}

export default SettingsPanel
