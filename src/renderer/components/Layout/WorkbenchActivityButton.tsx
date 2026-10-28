import { useTranslation } from 'react-i18next'
import { useWorkbenchActivity } from '../../stores/workbench-activity'
import { useTaskShelf } from '../../stores/task-shelf'
import { shelfEntryForNotice, showShelfNotice } from './task-shelf-navigation'

/** 只占标题栏一个工具按钮；通知不为终端增加常驻横带。 */
export function WorkbenchActivityButton() {
  const { i18n } = useTranslation()
  const open = useTaskShelf(state => state.panelVisible)
  const count = useWorkbenchActivity(state => state.unreadNoticeIds.length)
  const english = i18n.language.startsWith('en')
  const label = english ? `Sessions & tasks${count ? ` · ${count} unread alerts` : ''}` : `会话与任务${count ? ` · ${count} 条未读提醒` : ''}`
  if (!window.electronAPI?.workbenchActivityRequest) return null
  return <button type="button" data-workbench-activity-trigger className={`window-control workbench-activity-trigger${open ? ' is-active' : ''}`} title={label} aria-label={label} aria-expanded={open} onClick={() => {
    const state = useWorkbenchActivity.getState()
    state.close()
    const notice = [...state.notices].sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval')).find(item => state.unreadNoticeIds.includes(item.id) && shelfEntryForNotice(item))
    if (notice && showShelfNotice(notice)) { state.markRead(notice.id); return }
    if (open) { useTaskShelf.getState().togglePanel(); return }
    useTaskShelf.getState().showPanel(undefined, state.notices.length > 0)
  }}>
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 13.5h12l-1.5-2V8a4.5 4.5 0 0 0-9 0v3.5zM8 16a2.2 2.2 0 0 0 4 0"/></svg>
    {count > 0 && <span className="workbench-activity-badge" aria-hidden="true">{count > 9 ? '9+' : count}</span>}
  </button>
}
