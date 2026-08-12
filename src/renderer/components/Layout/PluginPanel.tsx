import React, { useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePluginStore } from '../../stores/plugin-store'
import { normalizeLifecycle } from '@shared/plugin-types'
import type { LyShellPluginManifest, PluginLifecycle } from '@shared/plugin-types'

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
 * 样式沿用 Settings 面板令牌(--bg-elev/--bg-slot/--rule/--amber/--text-rack*)与 font-mono 12px 基线。
 */
const PluginPanel: React.FC = () => {
  const { t } = useTranslation()
  const items = usePluginStore((s) => s.items)
  const loading = usePluginStore((s) => s.loading)
  const error = usePluginStore((s) => s.error)
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
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // URL 安装输入
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const handlePickDev = async (): Promise<void> => {
    setNotice(null)
    const res = await pickFolder()
    if (res.success && res.manifest && res.path) {
      setPicked({ source: 'dev', manifest: res.manifest, path: res.path })
      setInstallEnabled(true)
    } else if (res.error && res.error !== 'canceled') {
      setNotice(res.error)
    }
  }

  const handlePickFile = async (): Promise<void> => {
    setNotice(null)
    const res = await pickFile()
    if (res.success && res.manifest && res.path) {
      setPicked({ source: 'file', manifest: res.manifest, path: res.path })
      setInstallEnabled(true)
    } else if (res.error && res.error !== 'canceled') {
      setNotice(res.error)
    }
  }

  const handleFetchUrl = async (): Promise<void> => {
    setNotice(null)
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
    setNotice(null)
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
    setNotice(null)
    const ok = nextEnabled ? await enable(id) : await disable(id)
    if (!ok) setNotice(t('plugin.toggleFail'))
  }

  const handleRunOneshot = async (id: string): Promise<void> => {
    setNotice(null)
    const res = await runOneshot(id)
    if (!res.success) {
      setNotice(res.error ?? t('plugin.runFail'))
    } else {
      setNotice(t('plugin.runOk'))
    }
  }

  const handleUninstall = async (id: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
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
    setNotice(null)
  }

  const sourceLabel = (s: PickedSource): string =>
    s === 'dev' ? 'dev' : s === 'file' ? t('plugin.sourceFile') : t('plugin.sourceUrl')

  return (
    <div className="w-full h-full flex flex-col bg-[var(--bg-base)] p-3 space-y-2">
      {/* 标题 + 三种安装入口(dev 文件夹 / 本地 zip / URL) */}
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('plugin.title')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePickDev}
            disabled={busy}
            className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            + {t('plugin.addDev')}
          </button>
          <button
            onClick={handlePickFile}
            disabled={busy}
            className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            {t('plugin.addFile')}
          </button>
          <button
            onClick={() => setShowUrlInput((v) => !v)}
            disabled={busy}
            className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            {t('plugin.installFromUrl')}
          </button>
        </div>
      </div>

      {/* URL 输入行 */}
      {showUrlInput && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleFetchUrl()
            }}
            placeholder={t('plugin.urlPlaceholder')}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] font-mono rounded-[2px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--text-rack)] placeholder:text-[var(--text-rack-mute)] focus:outline-none focus:border-[var(--amber)]"
          />
          <button
            onClick={handleFetchUrl}
            disabled={busy || !urlInput.trim()}
            className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] bg-[var(--amber)] text-black hover:brightness-110 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {t('plugin.fetch')}
          </button>
        </div>
      )}

      {/* 权限确认卡(选完文件夹/文件或 URL 下载完后展示 manifest,用户确认权限与是否即启用) */}
      {picked && (
        <div className="border border-[var(--amber)] rounded-[2px] p-2 space-y-1.5 bg-[var(--bg-slot)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] font-mono font-semibold text-[var(--amber)] truncate">{picked.manifest.name}</span>
            <span className="text-[10.5px] font-mono text-[var(--text-rack-data)] shrink-0">{picked.manifest.version}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-[var(--text-rack-mute)]">
            <span className="truncate">{picked.manifest.id} · {picked.manifest.runtime}</span>
            <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{t(`plugin.lifecycle${manifestLifecycle(picked.manifest) === 'oneshot' ? 'Oneshot' : 'Persistent'}`)}</span>
            <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{sourceLabel(picked.source)}</span>
          </div>
          {picked.manifest.capabilities.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {picked.manifest.capabilities.map((c) => (
                <span
                  key={c}
                  className="px-1.5 py-px text-[10px] font-mono rounded-[2px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--text-rack-data)]"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
          {manifestLifecycle(picked.manifest) !== 'oneshot' && (
            <label className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--text-rack)] cursor-pointer">
              <input
                type="checkbox"
                checked={installEnabled}
                onChange={(e) => setInstallEnabled(e.target.checked)}
                className="w-3 h-3 accent-[var(--amber)]"
              />
              {t('plugin.enableOnInstall')}
            </label>
          )}
          <div className="flex justify-end gap-1.5 pt-0.5">
            <button
              onClick={cancelPicked}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] disabled:opacity-50 cursor-pointer"
            >
              {t('plugin.cancel')}
            </button>
            <button
              onClick={handleInstall}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] bg-[var(--amber)] text-black hover:brightness-110 disabled:opacity-50 cursor-pointer"
            >
              {t('plugin.install')}
            </button>
          </div>
        </div>
      )}

      {notice && <div className="text-[10.5px] font-mono text-[var(--text-rack-data)] break-all">{notice}</div>}
      {error && <div className="text-[10.5px] font-mono text-red-400 break-all">{error}</div>}

      {/* 列表 */}
      {loading && items.length === 0 ? (
        <div className="text-[11px] font-mono text-[var(--text-rack-mute)]">{t('plugin.loading')}</div>
      ) : items.length === 0 ? (
        <div className="text-[11px] font-mono text-[var(--text-rack-mute)] py-2 text-center">{t('plugin.empty')}</div>
      ) : (
        <div className="space-y-1 flex-1 min-h-0 overflow-y-auto pr-0.5">
          {items.map((p) => (
            <div key={p.id} className="border border-[var(--rule)] rounded-[2px] p-1.5 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-mono font-semibold text-[var(--text-rack)] truncate">{p.name}</span>
                <span className="text-[10.5px] font-mono text-[var(--text-rack-data)] shrink-0">{p.version}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-[var(--text-rack-mute)]">
                <span className="truncate">{p.id}</span>
                <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{p.runtime}</span>
                <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{t(`plugin.lifecycle${p.lifecycle === 'oneshot' ? 'Oneshot' : 'Persistent'}`)}</span>
                {p.dev && (
                  <span className="px-1 py-px rounded-[2px] border border-[var(--amber)] text-[var(--amber)] shrink-0">dev</span>
                )}
              </div>
              {p.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.capabilities.map((c) => {
                    const granted = p.grantedCapabilities.includes(c)
                    return (
                      <span
                        key={c}
                        title={granted ? t('plugin.granted') : t('plugin.declared')}
                        className={cn(
                          'px-1.5 py-px text-[10px] font-mono rounded-[2px] border',
                          granted
                            ? 'border-[var(--amber)] text-[var(--amber)]'
                            : 'border-[var(--rule)] text-[var(--text-rack-mute)] line-through'
                        )}
                      >
                        {c}
                      </span>
                    )
                  })}
                </div>
              )}
              <div className="flex items-center justify-between pt-0.5">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px] font-mono text-[var(--text-rack)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => handleToggle(p.id, e.target.checked)}
                      className="w-3 h-3 accent-[var(--amber)]"
                    />
                    {p.enabled ? t('plugin.enabled') : t('plugin.disabled')}
                  </label>
                  {p.lifecycle === 'oneshot' && (
                    <button
                      onClick={() => void handleRunOneshot(p.id)}
                      disabled={busy || !p.enabled}
                      className="px-1.5 py-0.5 text-[10px] font-mono rounded-[2px] bg-[var(--amber)] text-black hover:brightness-110 disabled:opacity-50 cursor-pointer"
                    >
                      {t('plugin.run')}
                    </button>
                  )}
                </div>
                {confirmUninstall === p.id ? (
                  <span className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-[var(--text-rack-data)]">{t('plugin.confirmUninstall')}</span>
                    <button
                      onClick={() => void handleUninstall(p.id)}
                      disabled={busy}
                      className="px-1.5 py-0.5 text-[10px] font-mono rounded-[2px] bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-50 cursor-pointer"
                    >
                      {t('plugin.yes')}
                    </button>
                    <button
                      onClick={() => setConfirmUninstall(null)}
                      disabled={busy}
                      className="px-1.5 py-0.5 text-[10px] font-mono rounded-[2px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] disabled:opacity-50 cursor-pointer"
                    >
                      {t('plugin.no')}
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmUninstall(p.id)}
                    disabled={busy}
                    className="px-1.5 py-0.5 text-[10px] font-mono rounded-[2px] text-[var(--text-rack-mute)] hover:text-red-400 disabled:opacity-50 cursor-pointer"
                  >
                    {t('plugin.uninstall')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default PluginPanel
