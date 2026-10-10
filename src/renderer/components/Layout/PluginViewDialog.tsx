/**
 * 插件视图弹窗 —— openDialog 动作的 renderer 落点（docs/plugin-ui-views-plan.md §四/§五）
 *
 * main 侧（view-actions + view-dialogs）完成授权校验、目标视图归属核对并签发一次性
 * dialogId 之后，才经 PLUGIN_VIEW_ACTION_REQUEST 到这里挂载弹窗 webview：
 *   - src 是 main 签发的入口 URL（带 ?dialogId=，attach 闸单次消费），partition 与
 *     面板同款（pluginviews:${pluginId}）；preload 由 main 强制指定，renderer 不传。
 *   - 尺寸经 clampPluginDialogSize 夹取（与 main 清洗同一钳制，单一事实来源）。
 *   - 关闭路径：guest 调 closeDialog → main 发 dialogResult 给发起方并关闭 guest
 *     → 本组件收到 destroyed 卸载；用户点关闭钮/按 Esc → 本组件卸载 webview，
 *     main 侧 destroyed 链路对发起 guest 推 dialogCancelled（两条路都不丢事件）。
 * 弹窗不保活：关闭即销毁。
 */
import React, { useEffect, useMemo, useRef } from 'react'
import type { WebviewTag } from 'electron'
import { clampPluginDialogSize, pluginViewPartitionName } from '@shared/plugin-types'
import { useEscDismiss } from '@/hooks/useDismiss'

/** MainWindow 收到的 openDialog 请求里 renderer 挂弹窗所需字段（params 由 main 清洗注入） */
export interface PluginViewDialogSpec {
  pluginId: string
  viewId: string
  title?: string
  width?: number
  height?: number
  /** 一次性 dialogId（main 签发；guest 靠它关联 dialogResult/dialogCancelled 事件） */
  dialogId: string
  /** main 构造的入口 URL（lyshell-plugin://…?dialogId=…） */
  entryUrl: string
}

const PluginViewDialog: React.FC<{ spec: PluginViewDialogSpec; isTopmost: boolean; onClose: () => void }> = ({ spec, isTopmost, onClose }) => {
  const webviewRef = useRef<WebviewTag | null>(null)

  // guest 被 main 关闭（closeDialog 完成 / 插件禁用清理链）→ destroyed → 收尾卸载。
  // renderer 主动关闭也走 destroyed，但那时组件已在卸载流程，onClose 幂等。
  useEffect(() => {
    const el = webviewRef.current
    if (!el) return
    const onDestroyed = (): void => onClose()
    el.addEventListener('destroyed', onDestroyed)
    return () => {
      el.removeEventListener('destroyed', onDestroyed)
    }
  }, [onClose])

  // 焦点在宿主时的 Esc 关闭；焦点进入 webview 后由 main 的 before-input-event
  // 取消对应弹窗。两条路都走 dialogCancelled 链路通知发起 guest。
  // 加入统一回退栈，避免底层搜索条/菜单先消费 Esc，也保留 IME 候选取消语义。
  useEscDismiss(isTopmost, onClose)

  const width = useMemo(() => clampPluginDialogSize(spec.width) ?? 520, [spec.width])
  const height = useMemo(() => clampPluginDialogSize(spec.height) ?? 400, [spec.height])
  const partition = useMemo(() => pluginViewPartitionName(spec.pluginId), [spec.pluginId])

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="flex flex-col rounded-md border border-[var(--border-base)] bg-[var(--bg-base)] shadow-2xl overflow-hidden"
        style={{ width, height }}
      >
        <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--border-base)] bg-[var(--bg-slot)]">
          <span className="text-sm text-[var(--text-base)] truncate select-none" title={spec.title ?? spec.viewId}>
            {spec.title ?? spec.viewId}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 ml-2 w-6 h-6 flex items-center justify-center rounded text-[var(--text-dim)] hover:bg-[var(--bg-rack)] hover:text-[var(--text-base)]"
            aria-label="close dialog"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <webview ref={webviewRef} src={spec.entryUrl} partition={partition} className="w-full h-full" />
        </div>
      </div>
    </div>
  )
}

export default PluginViewDialog
