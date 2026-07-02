import React from 'react'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import type { SplitDirection } from '@shared/types'

interface PaneToolbarProps {
  paneId: string
  isActive: boolean
}

/**
 * 分屏工具栏 - 显示分屏和关闭按钮
 */
const PaneToolbar: React.FC<PaneToolbarProps> = ({ paneId, isActive }) => {
  const { splitPane, closePane, getAllLeafPanes } = usePaneStore()
  const { t } = useTranslation()

  // 是否可以关闭（至少保留一个分屏）
  const canClose = getAllLeafPanes().length > 1

  const handleSplit = (direction: SplitDirection) => {
    splitPane(paneId, direction)
  }

  const handleClose = () => {
    if (canClose) {
      closePane(paneId)
    }
  }

  return (
    <div
      className={`
        absolute top-0 right-0 flex items-center gap-1 p-1 z-10
        ${isActive ? 'opacity-100' : 'opacity-0 hover:opacity-100'}
        transition-opacity
      `}
    >
      {/* 水平分屏 */}
      <button
        onClick={() => handleSplit('horizontal')}
        title={t('pane.splitHorizontal')}
        className="w-[20px] h-[20px] flex items-center justify-center text-xs text-gray-400 hover:text-white hover:bg-[#3C3C3C] rounded"
      >
        ⎮
      </button>

      {/* 垂直分屏 */}
      <button
        onClick={() => handleSplit('vertical')}
        title={t('pane.splitVertical')}
        className="w-[20px] h-[20px] flex items-center justify-center text-xs text-gray-400 hover:text-white hover:bg-[#3C3C3C] rounded"
      >
        ⎯
      </button>

      {/* 关闭分屏 */}
      {canClose && (
        <button
          onClick={handleClose}
          title={t('pane.closePane')}
          className="w-[20px] h-[20px] flex items-center justify-center text-xs text-gray-400 hover:text-red-400 hover:bg-[#3C3C3C] rounded"
        >
          ✕
        </button>
      )}
    </div>
  )
}

export default PaneToolbar