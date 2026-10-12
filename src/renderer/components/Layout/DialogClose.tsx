import React from 'react'
import { useTranslation } from 'react-i18next'

// 册页弹窗的明确关闭入口；不提交表单，不触发遮罩的点击事件。
const DialogClose: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation()
  return <button type="button" className="ly-dialog-close" aria-label={t('common.close')} title={t('common.close')} onClick={event => {
    event.stopPropagation()
    onClose()
  }}>
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10 M15 5 5 15" /></svg>
  </button>
}

export default DialogClose
