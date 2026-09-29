/**
 * 插件视图面板 —— 机柜轨插件视图的宿主（docs/plugin-ui-views-plan.md §五）
 *
 * - 只使用 main 校验后的入口 URL（由已注册 PluginViewMeta 经 makeViewEntryUrl 派生）
 *   与该插件专属 partition（pluginviews:${pluginId}）；preload 由 main 在
 *   will-attach-webview 强制指定打包路径，renderer 一律不传。
 * - 保活语义：MainWindow 常挂载本组件，切走时 visible=false 仅 CSS 隐藏（webview
 *   不可聚焦也不可交互），页面状态与滚动位置自然保留；卸载只发生在视图注销、
 *   插件禁用/卸载（MainWindow 依据 plugin:list 快照摘除）。
 * - 崩溃与加载失败显示可重试状态：重试以 attempt 进 key 整体重挂 webview，旧
 *   guest 销毁走 main 的 handlePluginGuestDestroyed 清理链，新 guest 重走完整
 *   attach 闸（身份不是继承的，是重新验证的）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import { makeViewEntryUrl, pluginViewPartitionName } from '@shared/plugin-types'
import type { PluginViewMeta } from '@shared/plugin-types'

/** did-fail-load 的 ABORTED(-3)：导航被打断（重载/替换），不是真实加载失败 */
const LOAD_ABORTED = -3

const PluginViewPanel: React.FC<{ view: PluginViewMeta; visible: boolean }> = ({ view, visible }) => {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)
  const webviewRef = useRef<WebviewTag | null>(null)

  const src = useMemo(() => makeViewEntryUrl(view.pluginId, view.entry), [view.pluginId, view.entry])
  const partition = useMemo(() => pluginViewPartitionName(view.pluginId), [view.pluginId])

  // 挂载期事件（attempt 变化 = webview 因 key 重挂，effect 随之重绑新元素）
  useEffect(() => {
    const el = webviewRef.current
    if (!el) return
    const onFail = (e: Event): void => {
      const evt = e as CustomEvent<unknown> & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (evt.isMainFrame === false) return // 子框架失败由页面自行降级，不整页铺错误
      if (evt.errorCode === LOAD_ABORTED) return
      setFailed(evt.errorDescription || (evt.errorCode !== undefined ? `ERR_${evt.errorCode}` : 'load failed'))
    }
    const onCrashed = (): void => setFailed(t('pluginView.crashed'))
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('crashed', onCrashed)
    return () => {
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('crashed', onCrashed)
    }
  }, [attempt, t])

  const retry = (): void => {
    setFailed(null)
    setAttempt((a) => a + 1)
  }

  return (
    <div className={cn('relative w-full h-full bg-[var(--bg-base)]', !visible && 'hidden')}>
      <webview key={attempt} ref={webviewRef} src={src} partition={partition} className="w-full h-full" />
      {failed !== null && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--terminal-bg)] text-sm text-gray-400">
          <span className="text-red-400">{t('pluginView.loadFailed')}</span>
          <span className="max-w-[80%] break-all text-center text-xs text-gray-500">{failed}</span>
          <button
            type="button"
            onClick={retry}
            className="px-3 py-1.5 rounded border border-[var(--border-base)] hover:bg-[var(--bg-slot)] text-[var(--text-base)]"
          >
            {t('pluginView.retry')}
          </button>
        </div>
      )}
    </div>
  )
}

export default PluginViewPanel
