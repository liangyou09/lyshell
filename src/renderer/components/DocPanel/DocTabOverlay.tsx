import React, { Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import type { DocOverlayPayload } from '@shared/types'
import DocHeader from './DocHeader'
import { extractHeadings } from './docHeadings'

// lazy：把文档渲染拆出主 chunk（react-markdown + highlight.js 体积可观，P3 接入后生效）
const MarkdownDoc = React.lazy(() => import('./MarkdownDoc'))
const HtmlDoc = React.lazy(() => import('./HtmlDoc'))

/**
 * 文档页签覆盖层 —— 归一化模型下的 payload 形态（挂载态在 pane 树的 OverlayRef 上，
 * 这里只接 id / paneId / 内容数据）。与其它覆盖层同型挂载（PaneView 内 absolute inset-0，
 * 外层用 visibility 控制显隐以保滚动位置与组件状态）。
 * 头条 + lazy 内容区；loadError 时整块换成错误占位。
 */
const DocTabOverlay: React.FC<{ id: string; paneId: string; payload: DocOverlayPayload }> = ({ id, paneId, payload }) => {
  const { t } = useTranslation()
  const closeDocTab = usePaneStore(s => s.closeDocTab)
  // 目录轨开关的显隐门控：无标题 md 连开关都不显示（点了也没轨可开，还会顺手
  // 翻转全局偏好，别的文档跟着遭殃）。与 MarkdownDoc 内部同一提取器（docHeadings）
  const hasHeadings = useMemo(
    () => payload.docKind === 'markdown' && extractHeadings(payload.content).length > 0,
    [payload.docKind, payload.content]
  )

  return (
    // doc-pane：整片文档页签的命名容器查询锚点 —— 头条（含目录开关）与阅读画布
    // 分属兄弟子树，各自做容器会量出不同宽度（头条有 px-3 内距），620px 阈值翻转
    // 点错开会出现「轨还开着、唯一开关已隐藏」的窗口；统一锚在这一层两者同宽
    <div className="doc-pane absolute inset-0 flex flex-col bg-[var(--terminal-bg)]">
      <DocHeader id={id} payload={payload} hasHeadings={hasHeadings} onClose={() => closeDocTab(id)} />
      <div className="flex-1 overflow-hidden">
        {payload.loadError ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-[80%]">
              <p className="text-sm text-[var(--error-rack)]">{t('doc.loadErrorTitle')}</p>
              <p className="text-xs mt-1 text-[var(--text-rack-mute)] break-all">{payload.loadError}</p>
            </div>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center text-xs text-[var(--text-rack-mute)]">
                {t('doc.loading')}
              </div>
            }
          >
            {payload.docKind === 'html'
              ? <HtmlDoc content={payload.content} title={payload.title} />
              : <MarkdownDoc content={payload.content} payload={payload} paneId={paneId} />}
          </Suspense>
        )}
      </div>
    </div>
  )
}

export default DocTabOverlay
