import React, { useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import { TOPBAR_HEIGHT } from './topbar-metrics'

/** 历史行展示用:取 hostname,取不到回落原样字符串(与页签 title 初始值同源) */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/**
 * 网页访问面板(机柜左列 Web 页签)。
 * 顶部 URL 栏输入完整网址,以终端页签形式打开在活动分屏(多页签,类似 dsh Web 页签);
 * 下方列出打开的网页:点击跳到承载分屏并激活页签,✕ 关闭。
 * 再下方是「最近访问」历史(localStorage 持久化,pane-store webTabHistory):
 * 点击重开、✕ 删除单条、段头清空;输入框挂 datalist 原生补全。
 * URL 归一化/校验在 pane-store 的 normalizeWebBarUrl;webview 的导航/弹窗由主进程
 * 按 persist:webbar partition 分流锁定(仅 http/https,见 main/index.ts)。
 *
 * 样式沿用面板令牌(--bg-elev/--bg-slot/--rule/--amber/--text-rack*)与
 * [font-family:inherit] 12px 基线,头条与 SessionsPanel/PluginPanel 同构。
 */
const WebPanel: React.FC = () => {
  const { t } = useTranslation()
  const openWebTab = usePaneStore((s) => s.openWebTab)
  const activateWebTab = usePaneStore((s) => s.activateWebTab)
  const closeWebTab = usePaneStore((s) => s.closeWebTab)
  const webTabs = usePaneStore((s) => s.webTabs)
  const webTabHistory = usePaneStore((s) => s.webTabHistory)
  const removeWebTabHistory = usePaneStore((s) => s.removeWebTabHistory)
  const clearWebTabHistory = usePaneStore((s) => s.clearWebTabHistory)
  const [webBarInput, setWebBarInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  // 输入完整 URL(无 scheme 自动补 https://)→ 以终端页签形式打开在活动分屏。
  // 非法输入走 notice 提示(对齐其他面板的错误路径)
  const handleOpenWebTab = (): void => {
    setNotice(null)
    const raw = webBarInput.trim()
    if (!raw) return
    const res = openWebTab(raw)
    if (res.ok) {
      setWebBarInput('')
    } else {
      setNotice(t('webBar.invalid'))
    }
  }

  return (
    <div
      className="w-full h-full flex flex-col bg-[var(--bg-base)]"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 头条:网页铭牌 —— 与 SessionsPanel/PluginPanel 头行同构(行高对齐终端第一行、
          满幅 border-b 发丝线、铭牌走系统 UI 字体做「厂牌丝印」) */}
      <div
        className="flex items-center justify-between gap-1 px-3 border-b border-[var(--rule)] flex-shrink-0"
        style={{ height: TOPBAR_HEIGHT }}
      >
        <span
          className="flex-1 min-w-0 truncate font-bold tracking-[-0.01em] text-[16px] text-[var(--text-rack)] select-none"
          style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
        >
          {t('webBar.title')}
        </span>
      </div>

      {/* 内容笼:p-3 + space-y-2(与 PluginPanel 同构) */}
      <div className="flex-1 min-h-0 flex flex-col p-3 space-y-2">

        {/* 网页访问栏 —— 输入完整 URL 回车即开;无 scheme 自动补 https://;
            datalist 挂最近历史做原生补全 */}
        <div className="flex items-center gap-1">
          <input
            type="text"
            list="lyshell-webbar-history"
            value={webBarInput}
            onChange={(e) => setWebBarInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleOpenWebTab()
            }}
            placeholder={t('webBar.placeholder')}
            spellCheck={false}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--text-rack)] placeholder:text-[var(--text-rack-mute)] focus:outline-none focus:border-[var(--amber)]"
          />
          {/* datalist 选项 = 全量历史(store 已封顶 30 条,无需再截) */}
          <datalist id="lyshell-webbar-history">
            {webTabHistory.map(url => (
              <option key={url} value={url}>{hostOf(url)}</option>
            ))}
          </datalist>
          <button
            onClick={handleOpenWebTab}
            disabled={!webBarInput.trim()}
            className="px-2 py-0.5 text-[11px] [font-family:inherit] rounded-[2px] bg-[var(--amber)] text-black hover:brightness-110 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {t('webBar.open')}
          </button>
        </div>

        {notice && <div className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] break-all">{notice}</div>}

        {/* 打开的网页 —— 点击跳到承载分屏并激活页签,✕ 关闭(模式对齐 SessionsPanel LIVE 段) */}
        {webTabs.length > 0 ? (
          <div className="border border-[var(--rule)] rounded-[2px] flex-1 min-h-0 overflow-y-auto">
            <div className="px-1.5 py-1 text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] select-none border-b border-[var(--rule)] sticky top-0 bg-[var(--bg-base)]">
              {t('webBar.openTabs')}
            </div>
            {webTabs.map(tab => (
              <div key={tab.id} className="flex items-center gap-1.5 px-1.5 py-1 border-b border-[var(--rule-soft)] last:border-b-0">
                <button
                  onClick={() => activateWebTab(tab.id)}
                  title={tab.url}
                  className={cn(
                    'flex-1 min-w-0 text-left text-[11px] [font-family:inherit] truncate cursor-pointer transition-colors',
                    tab.active
                      ? 'text-[var(--amber)]'
                      : 'text-[var(--text-rack)] hover:text-[var(--amber)]'
                  )}
                >
                  {tab.title}
                </button>
                <button
                  onClick={() => closeWebTab(tab.id)}
                  title={t('pane.webTabClose')}
                  className="w-[14px] h-[14px] flex-shrink-0 flex items-center justify-center text-xs text-[var(--text-rack-mute)] hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors cursor-pointer"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] [font-family:inherit] text-[var(--text-rack-mute)] py-2 text-center">
            {t('webBar.empty')}
          </div>
        )}

        {/* 最近访问 —— localStorage 持久化历史:点击重开、✕ 删除单条、段头清空。
            有打开的网页时压缩高度(max-h-40%),没有时占满剩余空间 */}
        {webTabHistory.length > 0 && (
          <div
            className={cn(
              'border border-[var(--rule)] rounded-[2px] min-h-0 overflow-y-auto flex-shrink-0',
              webTabs.length > 0 ? 'max-h-[40%]' : 'flex-1'
            )}
          >
            <div className="flex items-center justify-between gap-1 px-1.5 py-1 border-b border-[var(--rule)] sticky top-0 bg-[var(--bg-base)]">
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-mute)] select-none">
                {t('webBar.recent')}
              </span>
              <button
                onClick={clearWebTabHistory}
                className="text-[10px] [font-family:inherit] text-[var(--text-rack-mute)] hover:text-[var(--error-rack)] cursor-pointer select-none"
              >
                {t('webBar.clear')}
              </button>
            </div>
            {webTabHistory.map(url => (
              <div key={url} className="flex items-center gap-1.5 px-1.5 py-1 border-b border-[var(--rule-soft)] last:border-b-0">
                <button
                  onClick={() => openWebTab(url)}
                  title={url}
                  className="flex-1 min-w-0 text-left text-[11px] [font-family:inherit] truncate text-[var(--text-rack)] hover:text-[var(--amber)] cursor-pointer transition-colors"
                >
                  {hostOf(url)}
                </button>
                <button
                  onClick={() => removeWebTabHistory(url)}
                  title={t('webBar.removeRecent')}
                  className="w-[14px] h-[14px] flex-shrink-0 flex items-center justify-center text-xs text-[var(--text-rack-mute)] hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors cursor-pointer"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default WebPanel
