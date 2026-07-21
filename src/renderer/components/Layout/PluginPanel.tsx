import React, { useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePluginStore } from '../../stores/plugin-store'
import type { LyShellPluginManifest } from '@shared/plugin-types'

/**
 * 插件管理面板(Settings "插件" 页签内容)。
 * 列表 / 添加 dev 插件(选文件夹->权限确认) / 启用禁用 / 卸载 / 查看权限。
 * 详见 docs/plugin-system-design.md §8(生命周期)。
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
  const enable = usePluginStore((s) => s.enable)
  const disable = usePluginStore((s) => s.disable)
  const uninstall = usePluginStore((s) => s.uninstall)

  // pick 后的 manifest 预览(权限确认卡);null = 未在安装流程中
  const [picked, setPicked] = useState<{ manifest: LyShellPluginManifest; path: string } | null>(null)
  const [installEnabled, setInstallEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const handlePick = async (): Promise<void> => {
    setNotice(null)
    const res = await pickFolder()
    if (res.success && res.manifest && res.path) {
      setPicked({ manifest: res.manifest, path: res.path })
      setInstallEnabled(true)
    } else if (res.error && res.error !== 'canceled') {
      setNotice(res.error)
    }
  }

  const handleInstall = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setNotice(null)
    const res = await installDev({
      path: picked.path,
      // dev 插件:用户即开发者,安装即批准其声明的全部 capability(服务端仍取 ∩ manifest.capabilities 兜底)
      grantedCapabilities: picked.manifest.capabilities,
      enabled: installEnabled
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

  const handleUninstall = async (id: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const res = await uninstall(id)
    setBusy(false)
    setConfirmUninstall(null)
    if (!res.success) setNotice(res.error ?? t('plugin.uninstallFail'))
  }

  return (
    <div className="w-[320px] space-y-2">
      {/* 标题 + 添加 dev 插件 */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('plugin.title')}</span>
        <button
          onClick={handlePick}
          disabled={busy}
          className="px-2 py-0.5 text-[11px] font-mono rounded-[2px] border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-slot)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-50 transition-colors cursor-pointer"
        >
          + {t('plugin.addDev')}
        </button>
      </div>

      {/* 权限确认卡(选完文件夹后展示 manifest,用户确认权限与是否即启用) */}
      {picked && (
        <div className="border border-[var(--amber)] rounded-[2px] p-2 space-y-1.5 bg-[var(--bg-slot)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] font-mono font-semibold text-[var(--amber)] truncate">{picked.manifest.name}</span>
            <span className="text-[10.5px] font-mono text-[var(--text-rack-data)] shrink-0">{picked.manifest.version}</span>
          </div>
          <div className="text-[10.5px] font-mono text-[var(--text-rack-mute)] truncate">
            {picked.manifest.id} · {picked.manifest.runtime}
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
          <label className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--text-rack)] cursor-pointer">
            <input
              type="checkbox"
              checked={installEnabled}
              onChange={(e) => setInstallEnabled(e.target.checked)}
              className="w-3 h-3 accent-[var(--amber)]"
            />
            {t('plugin.enableOnInstall')}
          </label>
          <div className="flex justify-end gap-1.5 pt-0.5">
            <button
              onClick={() => setPicked(null)}
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
        <div className="space-y-1 max-h-[260px] overflow-y-auto pr-0.5">
          {items.map((p) => (
            <div key={p.id} className="border border-[var(--rule)] rounded-[2px] p-1.5 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-mono font-semibold text-[var(--text-rack)] truncate">{p.name}</span>
                <span className="text-[10.5px] font-mono text-[var(--text-rack-data)] shrink-0">{p.version}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-[var(--text-rack-mute)]">
                <span className="truncate">{p.id}</span>
                <span className="px-1 py-px rounded-[2px] border border-[var(--rule)] shrink-0">{p.runtime}</span>
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
                <label className="flex items-center gap-1 text-[11px] font-mono text-[var(--text-rack)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => handleToggle(p.id, e.target.checked)}
                    className="w-3 h-3 accent-[var(--amber)]"
                  />
                  {p.enabled ? t('plugin.enabled') : t('plugin.disabled')}
                </label>
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
