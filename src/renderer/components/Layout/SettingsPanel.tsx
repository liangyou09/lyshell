import React, { useState, useEffect } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useThemeStore, AVAILABLE_THEMES, CUSTOM_THEME_ID } from '../../stores/theme-store'
import { useLocaleStore, AVAILABLE_LOCALES } from '../../stores/locale-store'
import { isCursorBlinkEnabled, DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_STEP, snapTerminalFontSize } from '@shared/constants'

/**
 * 设置面板(机柜左列 Settings 页签内容)。
 *
 * 从 MainWindow 的悬浮覆盖面板迁入左列:去掉拖拽/关闭/位置记忆等「被召唤覆盖物」逻辑,
 * 只保留 terminal + mcp 两个页签的实质内容,按机柜面板令牌(--bg-rack/--bg-strip/--amber/--text-rack*)
 * 组织成整列面板。设置值沿用 localStorage + IPC 持久化,与迁移前一致。
 *
 * 主题/语言两段的 store initFromStorage 仍在 MainWindow 启动时执行(全局副作用),这里只读
 * store 值做选择器消费,不重复 init。
 */

/** 设置页签列表。插件页签已迁至 ActivityRail 的 plugins 槽,此处只留终端 + MCP。 */
const SETTINGS_TABS = ['terminal', 'mcp'] as const

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

const SettingsPanel: React.FC = () => {
  const [settingsTab, setSettingsTab] = useState<'terminal' | 'mcp'>('terminal')
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
  const [mcpSessionMetadataWrite, setMcpSessionMetadataWrite] = useState(false)
  // 破坏性命令确认默认开启（与后端 DEFAULT_MCP_SECURITY 一致）
  const [mcpConfirmDestructive, setMcpConfirmDestructive] = useState(true)
  // 复制 MCP 注册命令的瞬时反馈
  const [mcpCmdCopied, setMcpCmdCopied] = useState(false)
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

  // 加载 MCP 安全开关
  useEffect(() => {
    if (!window.electronAPI) return
    const loadMcpSecurity = async () => {
      try {
        const rawSecurity = await window.electronAPI?.getConfig('security')
        if (rawSecurity && typeof rawSecurity === 'object') {
          const security = rawSecurity as Record<string, unknown>
          const mcp = security.mcp && typeof security.mcp === 'object'
            ? (security.mcp as Record<string, unknown>)
            : null
          if (mcp) {
            setMcpSessionMetadataWrite(mcp.allowSessionMetadataWrite === true)
            // confirmDestructiveCommands 默认 true：仅在显式 false 时关闭
            setMcpConfirmDestructive(mcp.confirmDestructiveCommands !== false)
          }
        }
      } catch (e) {
        console.warn('Failed to load MCP security settings:', e)
      }
    }
    loadMcpSecurity()
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

  return (
    <div className="h-full flex flex-col bg-[var(--bg-rack)]">
      {/* 页签栏 —— bg-strip;active 用 amber 底边线标识,沿用原悬浮面板视觉语言(去掉拖拽把手/关闭钮) */}
      <div className="flex bg-[var(--bg-strip)] border-b border-[var(--rule)] flex-shrink-0">
        {SETTINGS_TABS.map(tab => {
          const active = settingsTab === tab
          return (
            <button
              key={tab}
              onClick={() => setSettingsTab(tab)}
              className={cn(
                // flex 居中 + leading-none:CJK("终端")满 em 与 Latin("MCP")cap-height 同字号下天然不等高,
                // 收紧行高并垂直居中,让两个页签的文字框一致,消除"大小不一样"的错觉
                'relative flex-1 h-[26px] flex items-center justify-center leading-none text-[12px] font-mono font-semibold transition-colors',
                active ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] hover:text-[var(--text-rack)]'
              )}
            >
              {tab === 'terminal' ? t('settings.tabTerminal') : t('settings.tabMcp')}
              {/* amber 底边线 —— bottom-[-1px] 压住 strip 的 border-b,让选中页签"咬合"进下方主体 */}
              {active && <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-[var(--amber)]" />}
            </button>
          )
        })}
      </div>

      {/* 内容区 —— 滚动适配 180–400px 可调栏宽;两页签 grid 同格重叠(invisible)以取较大者稳定高度 */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid p-3">
          <div className={cn('col-start-1 row-start-1 space-y-3', settingsTab === 'terminal' ? '' : 'invisible')} aria-hidden={settingsTab !== 'terminal'}>
            {/* 窗口大小 -- 预设 chip + 自定义宽高,持久化到 preferences,启动恢复 */}
            <div className="border-b border-[var(--rule-soft)] pb-3">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('settings.windowSize')}</span>
                <span className="text-[11px] font-mono text-[var(--text-rack-data)] tabular-nums">
                  {windowSize.width}×{windowSize.height}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {WINDOW_PRESETS.map(p => {
                  const active = windowSize.width === p.width && windowSize.height === p.height
                  return (
                    <button
                      key={`${p.width}x${p.height}`}
                      onClick={() => applyWindowSize(p.width, p.height)}
                      className={cn(
                        'px-2 h-[22px] rounded-[2px] border text-[11px] font-mono tabular-nums transition-colors cursor-pointer',
                        active
                          ? 'border-[var(--amber)] text-[var(--amber)] bg-[var(--bg-slot)]'
                          : 'border-[var(--rule)] text-[var(--text-rack-data)] bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
                      )}
                    >
                      {p.width}×{p.height}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-[var(--text-rack-data)] w-[40px]">{t('settings.custom')}</span>
                <input
                  type="number"
                  value={windowSize.width}
                  onChange={(e) => setWindowSize(s => ({ ...s, width: parseInt(e.target.value) || 0 }))}
                  className="w-[64px] px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                  min={800}
                  step={10}
                  title={t('settings.width')}
                />
                <span className="text-[11px] text-[var(--text-rack-data)] font-mono">×</span>
                <input
                  type="number"
                  value={windowSize.height}
                  onChange={(e) => setWindowSize(s => ({ ...s, height: parseInt(e.target.value) || 0 }))}
                  className="w-[64px] px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                  min={600}
                  step={10}
                  title={t('settings.height')}
                />
                <button
                  onClick={() => applyWindowSize(windowSize.width, windowSize.height)}
                  className="px-2 h-[24px] rounded-[2px] border border-[var(--rule)] bg-[var(--bg-slot)] text-[11px] font-mono text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors cursor-pointer"
                >
                  {t('settings.apply')}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.buffer')}</span>
              <input
                type="number"
                value={scrollbackLines}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 1000
                  setScrollbackLines(value)
                  localStorage.setItem('terminalScrollback', value.toString())
                }}
                className="w-[80px] px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                min={1000}
                max={100000}
                step={1000}
              />
              <span className="text-[11px] text-[var(--text-rack-data)] font-mono">{t('settings.lines')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.font')}</span>
              <input
                type="number"
                value={fontSize}
                onChange={(e) => {
                  // 输入期间只存草稿值（不吸附），避免键入 "25" 时输到 "2" 就被吸成 "20" 而无法键入多位数
                  const raw = parseInt(e.target.value)
                  setFontSize(Number.isFinite(raw) ? raw : DEFAULT_TERMINAL_FONT_SIZE)
                }}
                onBlur={() => {
                  // 失焦时才吸附 + 持久化 + 派发，保证终端永远拿不到「有问题」的档位
                  const next = snapTerminalFontSize(fontSize)
                  setFontSize(next)
                  localStorage.setItem('terminalFontSize', next.toString())
                  window.dispatchEvent(new CustomEvent('terminalFontSizeChanged', { detail: next }))
                }}
                className="w-[80px] px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                min={TERMINAL_FONT_SIZE_MIN}
                max={TERMINAL_FONT_SIZE_MAX}
                step={TERMINAL_FONT_SIZE_STEP}
              />
              <span className="text-[11px] text-[var(--text-rack-data)] font-mono">{t('settings.px')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.cursor')}</span>
              <input
                type="checkbox"
                checked={cursorBlink}
                onChange={(e) => {
                  setCursorBlink(e.target.checked)
                  localStorage.setItem('terminalCursorBlink', e.target.checked.toString())
                  window.dispatchEvent(new CustomEvent('terminalCursorBlinkChanged', { detail: e.target.checked }))
                }}
                className="w-3.5 h-3.5 accent-[var(--amber)]"
              />
              {/* blink on/off 是该行的值(等价 input 的数值),不是单位 —— 提到 text-rack-data + 11px,跟 lines/px 那种纯单位拉开层级 */}
              <span className={cn(
                'text-[12px] font-mono',
                cursorBlink ? 'text-[var(--amber)]' : 'text-[var(--text-rack-data)]'
              )}>{cursorBlink ? t('settings.blinkOn') : t('settings.blinkOff')}</span>
            </div>

            {/* 主题 ——— 三个 rack 槽位，每行用自己主题的真实色铺底 */}
            <div className="border-t border-[var(--rule)] pt-2 mt-2">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('settings.theme')}</span>
                <span className="text-[11px] font-mono text-[var(--text-rack-data)] truncate ml-2">
                  {AVAILABLE_THEMES.find(t => t.id === themeId)?.name}
                </span>
              </div>
              <div className="border border-[var(--rule)] rounded-[2px] overflow-hidden divide-y divide-[var(--rule-soft)]">
                {AVAILABLE_THEMES.map(t => {
                  const active = themeId === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      title={t.description}
                      className={cn(
                        'group relative w-full grid items-center gap-2 h-[30px] pr-2 text-left transition-[filter] duration-150',
                        'grid-cols-[3px_1fr_auto_14px]',
                        !active && 'hover:brightness-110'
                      )}
                      style={{ backgroundColor: t.preview.bgRack, color: t.preview.text }}
                    >
                      {/* 3px 左条 — active=amber, idle=本主题 bg-slot（隐形但留位） */}
                      <span
                        aria-hidden
                        className="h-full"
                        style={{ backgroundColor: active ? 'var(--amber)' : t.preview.bgSlot }}
                      />

                      {/* 名 */}
                      <span
                        className={cn(
                          'text-[13px] font-semibold font-mono truncate pl-1',
                          active && 'text-[var(--amber)]'
                        )}
                        style={!active ? { color: t.preview.text } : undefined}
                      >
                        {t.name}
                      </span>

                      {/* hex — 用本主题 bg-rack 的真值，遥测语言 */}
                      <span
                        className="text-[10.5px] font-mono tracking-[.04em] tabular-nums"
                        style={{ color: active ? 'var(--amber)' : `${t.preview.text}66` }}
                      >
                        {t.preview.bgRack.toLowerCase()}
                      </span>

                      {/* chrome 三阶塔（迷你机柜灯） */}
                      <span
                        aria-hidden
                        className="flex flex-col h-[18px] w-[5px] border border-[var(--bg-base)]"
                        style={{ borderColor: t.preview.bgBase }}
                      >
                        <span className="flex-1" style={{ backgroundColor: t.preview.bgBase }} />
                        <span className="flex-1" style={{ backgroundColor: t.preview.bgRack }} />
                        <span className="flex-1" style={{ backgroundColor: t.preview.bgSlot }} />
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Custom 主题色 picker —— 只有 themeId === rack-custom 时展开,
                  两个 native color input 直接驱动 store.setCustomColors,store 内部已处理实时注入 */}
              {themeId === CUSTOM_THEME_ID && (
                <div className="mt-1.5 border border-[var(--rule)] rounded-[2px] bg-[var(--bg-rack)] divide-y divide-[var(--rule-soft)]">
                  {/* Base */}
                  <div className="flex items-center gap-2 px-2 h-[26px]">
                    <span className="text-[11px] font-mono text-[var(--text-rack-data)] w-[44px]">Base</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="color"
                        value={customColors.base}
                        onChange={(e) => setCustomColors({ base: e.target.value.toUpperCase() })}
                        className="w-[18px] h-[18px] cursor-pointer border-0 bg-transparent p-0"
                        title={t('settings.pickBaseColor')}
                      />
                    </label>
                    <span className="text-[11px] font-mono text-[var(--text-rack-mute)] tabular-nums">
                      {customColors.base.toLowerCase()}
                    </span>
                  </div>
                  {/* Accent */}
                  <div className="flex items-center gap-2 px-2 h-[26px]">
                    <span className="text-[11px] font-mono text-[var(--text-rack-data)] w-[44px]">Accent</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="color"
                        value={customColors.accent}
                        onChange={(e) => setCustomColors({ accent: e.target.value.toUpperCase() })}
                        className="w-[18px] h-[18px] cursor-pointer border-0 bg-transparent p-0"
                        title={t('settings.pickAccentColor')}
                      />
                    </label>
                    <span className="text-[11px] font-mono text-[var(--text-rack-mute)] tabular-nums">
                      {customColors.accent.toLowerCase()}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 语言 —— 镜像 Theme 段布局：border-t 分隔 + 标题行 + locale 按钮列表 */}
            <div className="border-t border-[var(--rule)] pt-2 mt-2">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('settings.language')}</span>
                <span className="text-[11px] font-mono text-[var(--text-rack-data)] truncate ml-2">
                  {AVAILABLE_LOCALES.find(l => l.id === localeId)?.name}
                </span>
              </div>
              <div className="border border-[var(--rule)] rounded-[2px] overflow-hidden divide-y divide-[var(--rule-soft)]">
                {AVAILABLE_LOCALES.map(l => {
                  const active = localeId === l.id
                  return (
                    <button
                      key={l.id}
                      onClick={() => setLocale(l.id)}
                      className={cn(
                        'group relative w-full grid items-center gap-2 h-[30px] pr-2 text-left transition-[filter] duration-150',
                        'grid-cols-[3px_1fr]',
                        !active && 'hover:brightness-110'
                      )}
                    >
                      {/* 3px 左条 — active=amber, idle=透明留位 */}
                      <span
                        aria-hidden
                        className="h-full"
                        style={{ backgroundColor: active ? 'var(--amber)' : 'transparent' }}
                      />
                      {/* name 用目标语言自身书写，不翻译 */}
                      <span
                        className={cn(
                          'text-[13px] font-semibold font-mono truncate pl-1',
                          active ? 'text-[var(--amber)]' : 'text-[var(--text-rack)]'
                        )}
                      >
                        {l.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 下载路径 */}
            <div className="border-t border-[var(--rule)] pt-2 mt-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.download')}</span>
                <div
                  onClick={handleSelectDownloadDir}
                  className="flex-1 px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] cursor-pointer hover:border-[var(--amber)] truncate transition-colors"
                  title={downloadDir || t('settings.clickToSelect')}
                >
                  {downloadDir || t('settings.clickToChoose')}
                </div>
                <button
                  onClick={() => downloadDir && window.electronAPI?.openFolder(downloadDir)}
                  disabled={!downloadDir}
                  className={cn(
                    'w-[26px] h-[26px] rounded-[2px] text-xs border flex items-center justify-center transition-colors',
                    downloadDir
                      ? 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack-data)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
                      : 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack-faint)] cursor-not-allowed'
                  )}
                  title={t('settings.openFolder')}
                >
                  📂
                </button>
              </div>
              <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">{t('settings.defaultSavePath')}</p>
            </div>

            {/* 字号/缓冲/光标生效说明 —— 终端页脚(原面板底部 hint,随终端页签归属) */}
            <p className="text-[11px] text-[var(--text-rack-mute)] border-t border-[var(--rule)] pt-2 mt-2 font-mono leading-relaxed">
              {t('settings.applyHint')}
            </p>
          </div>
          <div className={cn('col-start-1 row-start-1 space-y-3', settingsTab === 'mcp' ? '' : 'invisible')} aria-hidden={settingsTab !== 'mcp'}>
            {/* MCP 会话元数据写入开关 —— 页签内首块,去掉 border-t/mt-2(无需与上方分隔) */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <input
                  id="mcp-session-metadata-write"
                  type="checkbox"
                  checked={mcpSessionMetadataWrite}
                  onChange={async (e) => {
                    const checked = e.target.checked
                    setMcpSessionMetadataWrite(checked)
                    try {
                      const rawSecurity = await window.electronAPI?.getConfig('security')
                      const security = rawSecurity && typeof rawSecurity === 'object'
                        ? (rawSecurity as Record<string, unknown>)
                        : {}
                      const existingMcp =
                        security.mcp && typeof security.mcp === 'object'
                          ? (security.mcp as Record<string, unknown>)
                          : {}
                      await window.electronAPI?.setConfig('security', {
                        ...security,
                        mcp: {
                          ...existingMcp,
                          allowSessionMetadataWrite: checked
                        }
                      })
                    } catch (err) {
                      console.warn('Failed to save MCP security setting:', err)
                    }
                  }}
                  className="w-3.5 h-3.5 accent-[var(--amber)]"
                />
                <label
                  htmlFor="mcp-session-metadata-write"
                  className="text-[12px] font-mono text-[var(--text-rack)] cursor-pointer"
                >
                  {t('settings.mcpSessionMetadataWrite')}
                </label>
              </div>
              <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">
                {t('settings.mcpSessionMetadataWriteHint')}
              </p>
            </div>

            {/* MCP 破坏性命令确认开关 */}
            <div className="border-t border-[var(--rule)] pt-2 mt-2">
              <div className="flex items-center gap-2 mb-1">
                <input
                  id="mcp-confirm-destructive"
                  type="checkbox"
                  checked={mcpConfirmDestructive}
                  onChange={async (e) => {
                    const checked = e.target.checked
                    setMcpConfirmDestructive(checked)
                    try {
                      const rawSecurity = await window.electronAPI?.getConfig('security')
                      const security = rawSecurity && typeof rawSecurity === 'object'
                        ? (rawSecurity as Record<string, unknown>)
                        : {}
                      const existingMcp =
                        security.mcp && typeof security.mcp === 'object'
                          ? (security.mcp as Record<string, unknown>)
                          : {}
                      await window.electronAPI?.setConfig('security', {
                        ...security,
                        mcp: {
                          ...existingMcp,
                          confirmDestructiveCommands: checked
                        }
                      })
                    } catch (err) {
                      console.warn('Failed to save MCP security setting:', err)
                    }
                  }}
                  className="w-3.5 h-3.5 accent-[var(--amber)]"
                />
                <label
                  htmlFor="mcp-confirm-destructive"
                  className="text-[12px] font-mono text-[var(--text-rack)] cursor-pointer"
                >
                  {t('settings.mcpConfirmDestructive')}
                </label>
              </div>
              <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">
                {t('settings.mcpConfirmDestructiveHint')}
              </p>
            </div>

            {/* MCP 注册命令复制 */}
            <div className="border-t border-[var(--rule)] pt-2 mt-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">
                  {t('settings.mcpRegister')}
                </span>
                <button
                  onClick={async () => {
                    try {
                      const info = await window.electronAPI?.getMcpAddCommand()
                      if (info?.command) {
                        await navigator.clipboard.writeText(info.command)
                        setMcpCmdCopied(true)
                        setTimeout(() => setMcpCmdCopied(false), 2000)
                      }
                    } catch (err) {
                      console.warn('Failed to copy MCP add command:', err)
                    }
                  }}
                  className={cn(
                    'px-2 py-1 rounded-[2px] text-[12px] font-mono border transition-colors',
                    mcpCmdCopied
                      ? 'bg-[var(--amber)] border-[var(--amber)] text-[var(--bg-rack)]'
                      : 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
                  )}
                >
                  {mcpCmdCopied ? t('settings.mcpRegisterCopied') : t('settings.mcpRegisterCopy')}
                </button>
              </div>
              <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">
                {t('settings.mcpRegisterHint')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsPanel
