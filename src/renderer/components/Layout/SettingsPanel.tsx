import React, { useState, useEffect } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useThemeStore, AVAILABLE_THEMES, CUSTOM_THEME_ID, deriveCustomVars, useLocaleStore, AVAILABLE_LOCALES } from '@/stores'
import { isCursorBlinkEnabled, DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_STEP, snapTerminalFontSize } from '@shared/constants'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import './SettingsPanel.css'

/**
 * 设置面板集中展示常用设置，以紧凑分区适配可调宽的左侧栏。
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
    <div className="settings-card-heading">
      <h2>{title}</h2>
      {right}
    </div>
    {children}
  </section>
)

const CheckMark: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const SettingsPanel: React.FC = () => {
  const [scrollbackLines, setScrollbackLines] = useState(() => {
    const saved = localStorage.getItem('terminalScrollback')
    return saved ? parseInt(saved) : 10000
  })
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminalFontSize')
    return saved ? snapTerminalFontSize(parseInt(saved)) : DEFAULT_TERMINAL_FONT_SIZE
  })
  const [cursorBlink, setCursorBlink] = useState(() => isCursorBlinkEnabled())
  const [downloadDir, setDownloadDir] = useState('')
  // 主窗口尺寸(像素) -- 持久化到 preferences,启动恢复;输入框双向绑定,点应用/预设时调 IPC
  const [windowSize, setWindowSize] = useState<{ width: number; height: number }>({ width: 1200, height: 800 })
  const { themeId, setTheme, customColors, setCustomColors } = useThemeStore()
  const { localeId, setLocale } = useLocaleStore()
  const { t } = useTranslation()

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

  // 加载下载配置
  useEffect(() => {
    const loadDownloadConfig = async () => {
      try {
        const result = await window.electronAPI?.getDownloadConfig()
        if (result?.success && result.data?.defaultDir) {
          setDownloadDir(result.data.defaultDir)
        }
      } catch (e) {
        console.warn('Failed to load download config:', e)
      }
    }
    loadDownloadConfig()
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

  // 选择下载目录（使用系统目录选择器）
  const handleSelectDownloadDir = async () => {
    const result = await window.electronAPI?.selectDirectory()
    if (result) {
      setDownloadDir(result)
      await window.electronAPI?.setDownloadConfig({ defaultDir: result })
    }
  }

  // 当前窗口尺寸是否命中某个预设；命中则下拉回显该预设，否则显示"自定义"
  const activeWindowPreset = WINDOW_PRESETS.find(p => windowSize.width === p.width && windowSize.height === p.height)
  const customThemeVars = deriveCustomVars(customColors.base, customColors.accent)

  return (
    <div className="settings-panel">
      {/* 头行与终端页签对齐，保留窗口拖拽区。 */}
      <div className="settings-header win-drag" style={{ height: TOPBAR_HEIGHT }}>
        <span>{t('settings.title')}</span>
      </div>

      <div className="settings-content">
        <SettingCard title={t('settings.sections.terminal')}>
          <label className="settings-field-row">
            <span>{t('settings.font')}</span>
            <span className="settings-number-field">
              <input
                type="number"
                aria-label={t('settings.font')}
                value={fontSize}
                onChange={(e) => {
                  // 编辑输入先保留草稿，原生步进立即生效，避免多位数输入期间被提前吸附。
                  const raw = parseInt(e.target.value)
                  const draft = Number.isFinite(raw) ? raw : DEFAULT_TERMINAL_FONT_SIZE
                  if ((e.nativeEvent as InputEvent).inputType == null) {
                    const next = snapTerminalFontSize(draft)
                    setFontSize(next)
                    localStorage.setItem('terminalFontSize', next.toString())
                    window.dispatchEvent(new CustomEvent('terminalFontSizeChanged', { detail: next }))
                  } else {
                    setFontSize(draft)
                  }
                }}
                onBlur={() => {
                  const next = snapTerminalFontSize(fontSize)
                  setFontSize(next)
                  localStorage.setItem('terminalFontSize', next.toString())
                  window.dispatchEvent(new CustomEvent('terminalFontSizeChanged', { detail: next }))
                }}
                min={TERMINAL_FONT_SIZE_MIN}
                max={TERMINAL_FONT_SIZE_MAX}
                step={TERMINAL_FONT_SIZE_STEP}
              />
              <span>{t('settings.px')}</span>
            </span>
          </label>
          <label className="settings-field-row">
            <span>{t('settings.buffer')}</span>
            <span className="settings-number-field">
              <input
                type="number"
                aria-label={t('settings.buffer')}
                value={scrollbackLines}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 1000
                  setScrollbackLines(value)
                  localStorage.setItem('terminalScrollback', value.toString())
                }}
                min={1000}
                max={100000}
                step={1000}
              />
              <span>{t('settings.lines')}</span>
            </span>
          </label>
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
        </SettingCard>
        <p className="settings-note">{t('settings.applyHint')}</p>

        <SettingCard
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
                  title={theme.description}
                  className={cn('settings-theme', active && 'is-active')}
                  data-theme={theme.id}
                  style={theme.id === CUSTOM_THEME_ID ? customThemeVars as React.CSSProperties : undefined}
                >
                  <span
                    className="settings-theme-preview"
                    aria-hidden="true"
                  >
                    <span className="settings-theme-rail">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="settings-theme-screen">
                      <span />
                      <span className="settings-theme-code">&gt;_</span>
                      <span />
                    </span>
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
        </SettingCard>

        <SettingCard title={t('settings.windowSize')}>
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
        </SettingCard>

        <SettingCard title={t('settings.download')}>
          <p className="settings-path-label">{t('settings.defaultSavePath')}</p>
          <button
            type="button"
            onClick={handleSelectDownloadDir}
            className="settings-path settings-input"
            title={downloadDir || t('settings.clickToSelect')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span>{downloadDir || t('settings.clickToChoose')}</span>
          </button>
          <button
            type="button"
            onClick={() => downloadDir && window.electronAPI?.openFolder(downloadDir)}
            disabled={!downloadDir}
            className="settings-open-folder"
          >
            {t('settings.openFolder')}
            <span aria-hidden="true">↗</span>
          </button>
        </SettingCard>
      </div>
    </div>
  )
}

export default SettingsPanel
