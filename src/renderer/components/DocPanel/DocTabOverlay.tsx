import React, { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import type { DocTabEntry } from '@shared/types'
import DocHeader from './DocHeader'

// lazy：把文档渲染拆出主 chunk（react-markdown + highlight.js 体积可观，P3 接入后生效）
const MarkdownDoc = React.lazy(() => import('./MarkdownDoc'))
const HtmlDoc = React.lazy(() => import('./HtmlDoc'))

/**
 * 文档页签覆盖层 —— 与 webTabs 同型挂载（PaneView 内 absolute inset-0，
 * 外层用 visibility 控制显隐以保滚动位置与组件状态）。
 * 头条 + lazy 内容区；loadError 时整块换成错误占位。
 */
const DocTabOverlay: React.FC<{ tab: DocTabEntry }> = ({ tab }) => {
  const { t } = useTranslation()
  const closeDocTab = usePaneStore(s => s.closeDocTab)

  return (
    <div className="absolute inset-0 flex flex-col bg-[var(--terminal-bg)]">
      <DocHeader tab={tab} onClose={() => closeDocTab(tab.id)} />
      <div className="flex-1 overflow-hidden">
        {tab.loadError ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-[80%]">
              <p className="text-sm text-[var(--error-rack)]">{t('doc.loadErrorTitle')}</p>
              <p className="text-xs mt-1 text-[var(--text-rack-mute)] break-all">{tab.loadError}</p>
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
            {tab.kind === 'html'
              ? <HtmlDoc content={tab.content} title={tab.title} />
              : <MarkdownDoc content={tab.content} tab={tab} />}
          </Suspense>
        )}
      </div>
    </div>
  )
}

export default DocTabOverlay
