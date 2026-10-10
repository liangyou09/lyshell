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
      <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={allCollapsed ? 'm4 3 4 4 4-4M4 9l4 4 4-4' : 'm4 7 4-4 4 4M4 13l4-4 4 4'} /></svg>
      <span>{label}</span>
    </button>
  </div>
}
