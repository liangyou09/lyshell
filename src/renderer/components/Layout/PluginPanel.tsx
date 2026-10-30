import { PanelHeader, PanelHeaderAction, PanelHeaderMenu } from './PanelHeader'
import React, { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePluginStore } from '../../stores/plugin-store'
import { useUiStore } from '../../stores/ui-store'
import { normalizeLifecycle } from '@shared/plugin-types'
import type { LyShellPluginManifest, PluginLifecycle, PluginListItem } from '@shared/plugin-types'
import './PluginPanel.css'

/** 安装来源(dev=文件夹/file=本地 zip/url=URL 下载)。决定走 installDev 还是 installZip。 */
type PickedSource = 'dev' | 'file' | 'url'

/** 取 manifest 展示用的生命周期（未声明时按 runtime 默认值显示）。 */
function manifestLifecycle(manifest: LyShellPluginManifest): PluginLifecycle {
  return normalizeLifecycle(manifest.runtime, manifest.lifecycle)
}

/**
 * 插件管理面板(机柜左列 Plugins 页签,原 Settings "插件" 页签迁出)。
 * 列表 / 三种安装来源(dev 文件夹 / 本地 .lyshell-plugin / URL 下载)/ 启用禁用 / 卸载 / 查看权限。
 * 详见 docs/plugin-system-design.md §8(生命周期)+ §8.3(安装流程)。
 *
 * 沿用侧栏主题令牌；名称与说明使用界面字体，标识符及权限名使用等宽字体。
 */
const PluginPanel: React.FC = () => {
  const { t } = useTranslation()
  const items = usePluginStore((s) => s.items)
  const loading = usePluginStore((s) => s.loading)
  const error = usePluginStore((s) => s.error)
  const clearError = usePluginStore((s) => s.clearError)
  const load = usePluginStore((s) => s.load)
  const pickFolder = usePluginStore((s) => s.pickFolder)
  const installDev = usePluginStore((s) => s.installDev)
  const pickFile = usePluginStore((s) => s.pickFile)
  const fetchUrl = usePluginStore((s) => s.fetchUrl)
  const installZip = usePluginStore((s) => s.installZip)
  const cancelDownload = usePluginStore((s) => s.cancelDownload)
  const enable = usePluginStore((s) => s.enable)
  const disable = usePluginStore((s) => s.disable)
  const runOneshot = usePluginStore((s) => s.runOneshot)
  const uninstall = usePluginStore((s) => s.uninstall)

  // pick/下载后的 manifest 预览(权限确认卡);null = 未在安装流程中
  const [picked, setPicked] = useState<{
    source: PickedSource
    manifest: LyShellPluginManifest
    path: string
  } | null>(null)
  const [installEnabled, setInstallEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const togglingRef = useRef(new Set<string>())
  const [togglingIds, setTogglingIds] = useState(new Set<string>())
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // URL 安装输入
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [urlInput, setUrlInput] = useState('')

  const clearFeedback = (): void => {
    setNotice(null)
    clearError()
  }
  const cleanupUnconfirmed = !!error && /taskkill|process (?:tree )?cleanup/i.test(error)

  useEffect(() => {
    void load()
  }, [load])

  // 权限 chip 悬停提示：授予状态 + 一句话能力说明(未知能力只显示授予状态,不暴露 i18n 键名)
  const capTitle = (c: string, granted: boolean): string => {
    const state = granted ? t('plugin.granted') : t('plugin.declared')
    const desc = t(`plugin.capDesc.${c}`, { defaultValue: '' })
    return typeof desc === 'string' && desc ? `${state} · ${desc}` : state
  }

  const handlePickDev = async (): Promise<void> => {
    clearFeedback()
    const res = await pickFolder()
    if (res.success && res.manifest && res.path) {
      setPicked({ source: 'dev', manifest: res.manifest, path: res.path })
      setInstallEnabled(true)
    } else if (res.error && res.error !== 'canceled') {
      setNotice(res.error)
    }
  }

  // 外部「安装插件」请求(ui-store,如 /ls 清点文档的新建链接):本面板条件挂载,
  // 请求落 store 跨挂载存活,挂载后读到存量也能走安装流程,消费后归零防误弹。
  // 对应动作 = 头条的琥珀「+」图标钮(dev 文件夹 → 权限确认卡)
  const createRequestId = useUiStore(s => s.createDialogRequests.plugins ?? 0)
  useEffect(() => {
    if (!createRequestId) return
    void handlePickDev()
    useUiStore.getState().consumeCreateDialogRequest('plugins')
    // 请求消费只看 id;handlePickDev 的引用变化不构成「再来一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequestId])

  const handlePickFile = async (): Promise<void> => {
    clearFeedback()
    const res = await pickFile()
    if (res.success && res.manifest && res.path) {
      setPicked({ source: 'file', manifest: res.manifest, path: res.path })
      setInstallEnabled(true)
    } else if (res.error && res.error !== 'canceled') {
      setNotice(res.error)
    }
  }

  const handleFetchUrl = async (): Promise<void> => {
    clearFeedback()
    const url = urlInput.trim()
    if (!url) return
    setBusy(true)
    setNotice(t('plugin.fetching'))
    const res = await fetchUrl(url)
    setBusy(false)
    if (res.success && res.manifest && res.path) {
      setPicked({ source: 'url', manifest: res.manifest, path: res.path })
      setInstallEnabled(true)
      setShowUrlInput(false)
      setUrlInput('')
      setNotice(null)
    } else {
      setNotice(res.error ?? t('plugin.fetchFail'))
    }
  }

  // 安装:dev 走 installDev;file/url 走 installZip(source 区分 registry 记录与审计)
  const handleInstall = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    clearFeedback()
    // 三种来源都按"用户即批准其声明的全部 capability"(服务端仍取 ∩ manifest.capabilities 兜底)
    const granted = picked.manifest.capabilities
    // oneshot 插件不通过 enable/disable 常驻，安装即视为可用，强制 enabled=true。
    const enabled = manifestLifecycle(picked.manifest) === 'oneshot' ? true : installEnabled
    const res =
      picked.source === 'dev'
        ? await installDev({ path: picked.path, grantedCapabilities: granted, enabled })
        : await installZip({
            path: picked.path,
            source: picked.source === 'file' ? 'local-file' : 'url',
            grantedCapabilities: granted,
            enabled
          })
    setBusy(false)
    if (res.success) {
      setPicked(null)
      // engines.lyshell 不兼容等 warn-only 提示优先于通用 installOk,避免"静默安装"
      setNotice(res.warning ?? t('plugin.installOk'))
    } else {
      setNotice(res.error ?? t('plugin.installFail'))
    }
  }

  // e.target.checked 是用户期望的新状态:true->enable,false->disable
  const handleToggle = async (id: string, nextEnabled: boolean): Promise<void> => {
    if (busy || togglingRef.current.has(id)) return
    togglingRef.current.add(id)
    setTogglingIds(new Set(togglingRef.current))
    clearFeedback()
    try {
      const ok = nextEnabled ? await enable(id) : await disable(id)
      if (!ok) setNotice(t('plugin.toggleFail'))
    } catch {
      setNotice(t('plugin.toggleFail'))
    } finally {
      togglingRef.current.delete(id)
      setTogglingIds(new Set(togglingRef.current))
    }
  }

  const handleRunOneshot = async (id: string): Promise<void> => {
    clearFeedback()
    const res = await runOneshot(id)
    if (!res.success) {
      setNotice(res.error ?? t('plugin.runFail'))
    } else {
      setNotice(t('plugin.runOk'))
    }
  }

  const handleUninstall = async (id: string): Promise<void> => {
    setBusy(true)
    clearFeedback()
    const res = await uninstall(id)
    setBusy(false)
    setConfirmUninstall(null)
    if (!res.success) setNotice(res.error ?? t('plugin.uninstallFail'))
  }

  const cancelPicked = (): void => {
    // url 来源:取消时即时删除临时下载文件(.downloads/ 下),防 fetch-then-cancel 累积到退出(评审 #1)
    if (picked?.source === 'url' && picked.path) {
      void cancelDownload(picked.path)
    }
    setPicked(null)
    clearFeedback()
  }

  const sourceLabel = (s: PickedSource): string =>
    s === 'dev' ? 'dev' : s === 'file' ? t('plugin.sourceFile') : t('plugin.sourceUrl')

  // 整卡切换启用，技术信息按需展开；保留原生 checkbox 和 details 的键盘操作。
  const renderPluginCard = (p: PluginListItem) => (
    <div
      key={p.id}
      onClick={(e) => {
        // label 会转发一次原生 input 点击；详情及操作按钮也不参与整卡切换。
        if ((e.target as Element).closest('label, input, button, details')) return
        void handleToggle(p.id, !p.enabled)
      }}
      onMouseLeave={() => { if (confirmUninstall === p.id) setConfirmUninstall(null) }}
      aria-busy={togglingIds.has(p.id)}
      className={cn(
        'plugin-card',
        busy || togglingIds.has(p.id) ? 'cursor-wait' : 'cursor-pointer'
      )}
    >
      <div className="plugin-card-header">
        <label
          title={p.enabled ? t('plugin.enabled') : t('plugin.disabled')}
          className="plugin-card-toggle"
        >
          <input
            type="checkbox"
            checked={p.enabled}
            // 切换中由同步守卫拦截重复操作；保留可聚焦状态，避免键盘焦点被浏览器移到 body。
            disabled={busy}
            aria-disabled={busy || togglingIds.has(p.id)}
            onChange={(e) => handleToggle(p.id, e.target.checked)}
            className="plugin-toggle-input"
          />
          <span title={p.name} className="plugin-card-name">{p.name}</span>
          <span aria-hidden="true" className="plugin-toggle-track" />
        </label>
        {p.lifecycle === 'oneshot' && (
          <button
            onClick={() => void handleRunOneshot(p.id)}
            disabled={busy || togglingIds.has(p.id) || !p.enabled}
            className="plugin-run"
          >
            {t('plugin.run')}
          </button>
        )}
      </div>
      {p.description?.trim() && (
        <p title={p.description} className="plugin-card-description">
          {p.description}
        </p>
      )}
      <details
        onToggle={(e) => { if (!e.currentTarget.open && confirmUninstall === p.id) setConfirmUninstall(null) }}
        className="plugin-details"
      >
        <summary title={t('plugin.technicalDetails')}>
          <span className="plugin-card-meta">
            <span aria-live="polite" className="plugin-card-state" data-enabled={p.enabled}>
              {togglingIds.has(p.id) ? t('plugin.updating') : p.enabled ? t('plugin.enabled') : t('plugin.disabled')}
            </span>
            <span className="plugin-card-version">{p.version}</span>
          </span>
          <span className="plugin-details-label">
            {t('plugin.technicalDetails')}
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="m3.5 2 3 3-3 3" /></svg>
          </span>
        </summary>
        <div className="plugin-details-body">
          <div className="plugin-identity">
            <span className="min-w-0 break-all select-text">{p.id}</span>
          </div>
          <div className="plugin-runtime">
            <span>{p.runtime} · {t(`plugin.lifecycle${p.lifecycle === 'oneshot' ? 'Oneshot' : 'Persistent'}`)}</span>
            {p.dev && <span>dev</span>}
          </div>
          <div className="plugin-capabilities">
            {p.capabilities.map((c) => {
              const granted = p.grantedCapabilities.includes(c)
              return (
                <span
                  key={c}
                  title={capTitle(c, granted)}
                  className={cn(
                    'plugin-capability',
                    !granted && 'line-through'
                  )}
                >
                  {c}
                </span>
              )
            })}
          </div>
          <div className="plugin-details-actions">
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation()
                // 两步确认：首次点击切到确认态，再次点击才真正卸载。
                if (confirmUninstall !== p.id) {
                  setConfirmUninstall(p.id)
                  return
                }
                setConfirmUninstall(null)
                await handleUninstall(p.id)
              }}
              disabled={busy || togglingIds.has(p.id)}
              title={confirmUninstall === p.id ? t('plugin.confirmUninstall') : t('plugin.uninstall')}
              onBlur={() => { if (confirmUninstall === p.id) setConfirmUninstall(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && confirmUninstall === p.id) {
                  e.stopPropagation()
                  setConfirmUninstall(null)
                }
              }}
              className={cn(
                'plugin-uninstall',
                confirmUninstall === p.id && 'plugin-uninstall-confirm'
              )}
            >
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.6 9h6.8l.6-9M6.5 7v4M9.5 7v4" />
              </svg>
              {confirmUninstall === p.id ? t('plugin.confirmUninstallAction') : t('plugin.uninstall')}
            </button>
          </div>
        </div>
      </details>
    </div>
  )

  return (
    <div
      className="plugin-panel w-full h-full flex flex-col bg-[var(--bg-base)]"
    >
      <PanelHeader
        title={t('plugin.title')}
        count={items.length}
        actions={<>
          <PanelHeaderAction label={t('panelHeader.add')} disabled={busy} onClick={handlePickDev} title={t('plugin.addDev')} />
          <PanelHeaderMenu title={t('panelHeader.moreInstallOptions')} items={[
            { label: t('plugin.addFile'), onClick: handlePickFile, disabled: busy },
            { label: t('plugin.installFromUrl'), onClick: () => setShowUrlInput(v => !v), disabled: busy }
          ]} />
        </>}
      />

      {/* 内容统一留白，安装流程与列表共用滚动区域，窄栏和矮窗口也能完成确认。 */}
      <div className="plugin-panel-content rack-scroll">

      {/* URL 输入行 */}
      {showUrlInput && (
        <div className="plugin-url-row">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleFetchUrl()
            }}
            placeholder={t('plugin.urlPlaceholder')}
            aria-label={t('plugin.installFromUrl')}
            disabled={busy}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--text-rack)] placeholder:text-[var(--text-rack-mute)] focus:outline-none focus:border-[var(--amber)]"
          />
          <button
            onClick={handleFetchUrl}
            disabled={busy || !urlInput.trim()}
            className="px-2 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] bg-[var(--amber)] text-black hover:brightness-110 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {t('plugin.fetch')}
          </button>
        </div>
      )}

      {/* 权限确认卡(选完文件夹/文件或 URL 下载完后展示 manifest,用户确认权限与是否即启用) */}
      {picked && (
        <div className="plugin-install-preview border border-[var(--amber)] space-y-1.5 bg-[var(--bg-slot)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] [font-family:inherit] font-semibold text-[var(--amber)] truncate">{picked.manifest.name}</span>
            <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] shrink-0">{picked.manifest.version}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)]">
            <span className="truncate">{picked.manifest.id} · {picked.manifest.runtime}</span>
            <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{t(`plugin.lifecycle${manifestLifecycle(picked.manifest) === 'oneshot' ? 'Oneshot' : 'Persistent'}`)}</span>
            <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{sourceLabel(picked.source)}</span>
          </div>
          {picked.manifest.main && (
            <p className="text-[11px] leading-relaxed text-[var(--text-rack)]">{t('plugin.localTrust')}</p>
          )}
          {picked.manifest.capabilities.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {picked.manifest.capabilities.map((c) => (
                <span
                  key={c}
                  title={capTitle(c, false)}
                  className="px-1.5 py-px text-[10px] [font-family:inherit] rounded-[2px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--text-rack-data)]"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
          {manifestLifecycle(picked.manifest) !== 'oneshot' && (
            <label className="flex items-center gap-2 min-h-[32px] px-1 rounded-[2px] text-[11px] [font-family:inherit] text-[var(--text-rack)] cursor-pointer hover:bg-[var(--bg-elev)] focus-within:outline focus-within:outline-2 focus-within:outline-[var(--amber)] focus-within:outline-offset-[-2px]">
              <input
                type="checkbox"
                checked={installEnabled}
                onChange={(e) => setInstallEnabled(e.target.checked)}
                className="w-4 h-4 shrink-0 accent-[var(--amber)] cursor-pointer"
              />
              {t('plugin.enableOnInstall')}
            </label>
          )}
          <div className="flex justify-end gap-1.5 pt-0.5">
            <button
              onClick={cancelPicked}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] disabled:opacity-50 cursor-pointer"
            >
              {t('plugin.cancel')}
            </button>
            <button
              onClick={handleInstall}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] bg-[var(--amber)] text-black hover:brightness-110 disabled:opacity-50 cursor-pointer"
            >
              {t('plugin.install')}
            </button>
          </div>
        </div>
      )}

      {/* 同一次失败只呈现一条反馈；底层命令保留在按需展开的诊断里。 */}
      {(error || notice) && (
        <div className={cn('plugin-panel-notice', error && 'plugin-panel-error')}>
          <div className="plugin-notice-heading">
            <span role={error ? 'alert' : 'status'}>
              {error ? t(cleanupUnconfirmed ? 'plugin.cleanupUnconfirmed' : 'plugin.toggleFail') : notice}
            </span>
            <button type="button" className="plugin-notice-dismiss" onClick={clearFeedback} aria-label={t('plugin.dismissNotice')} title={t('plugin.dismissNotice')}>
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          {error && <>
            {cleanupUnconfirmed && <p className="plugin-notice-hint">{t('plugin.cleanupHint')}</p>}
            <details className="plugin-error-details">
              <summary>{t('plugin.errorDetails')}</summary>
              <pre>{error}</pre>
            </details>
          </>}
        </div>
      )}

      {/* 列表 —— 加载/空态走机柜 ─ · ─ 分隔语法（与其余面板归一） */}
      {loading && items.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
          <span className="text-[12px] [font-family:inherit] text-[var(--text-rack-data)]">{t('plugin.loading')}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="font-mono text-[16px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
          <span className="text-[13px] [font-family:inherit] font-medium text-[var(--text-rack)]">{t('plugin.empty')}</span>
          <span className="text-[12px] leading-5 [font-family:inherit] text-[var(--text-rack-data)]">{t('plugin.emptyHint')}</span>
        </div>
      ) : (
        <div className="plugin-list">
            {items.map(renderPluginCard)}
        </div>
      )}
      </div>
    </div>
  )
}

export default PluginPanel
