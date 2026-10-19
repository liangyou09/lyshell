import React from 'react'
import { useTranslation } from 'react-i18next'
import './GroupList.css'

/** 单一总开关：有展开组时全部收起，全收起后全部展开。 */
export const GroupListActions: React.FC<{
  allCollapsed: boolean
  allExpanded: boolean
  onChange: (collapsed: boolean) => void
}> = ({ allCollapsed, allExpanded, onChange }) => {
  const { t } = useTranslation()
  const label = t(allCollapsed ? 'groupList.expandAll' : 'groupList.collapseAll')
  return <div className="group-list-actions win-no-drag">
    <button type="button" title={label} aria-label={label} aria-expanded={!allCollapsed} disabled={allCollapsed && allExpanded} onClick={() => onChange(!allCollapsed)}>
      <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={allCollapsed ? 'm2 3.4 6 3.6 6-3.6M2 9.4l6 3.6 6-3.6' : 'm2 6.6 6-3.6 6 3.6M2 12.6l6-3.6 6 3.6'} /></svg>
      <span>{label}</span>
    </button>
  </div>
}
