import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activityDirectoryKey, activityFresh, tuiActivityFresh, webActivityFresh, useWorkbenchActivity, type ActivityNotice } from '../../stores/workbench-activity'
import { activityToastTimeout, createActivityToastTracker, mergeActivityToasts } from '../../stores/activity-toast'

export function activityProjectName(workspace: string): string {
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/)
  const worktree = parts.lastIndexOf('.lyshell-worktrees')
  if (worktree > 0 && worktree < parts.length - 1) return `${parts[worktree - 1]} / ${parts.slice(worktree + 1).join('/')}`
  return parts.pop() || workspace || 'Harness'
}

export function ActivityNoticeIcon({ kind }: { kind: ActivityNotice['kind'] }) {
  return <svg className={`activity-notice-icon is-${kind}`} width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    {kind === 'completed' || kind === 'turn-ended' ? <path d="m8 12 2.7 2.7L16.5 9"/> : kind === 'approval' ? <><path d="M12 7v5l3 2"/></> : kind === 'interrupted' ? <path d="M9 8v8M15 8v8"/> : <><path d="M12 7v6M12 16v.2"/></>}
  </svg>
}
export function activityNoticeTitle(notice: ActivityNotice, english: boolean): string {
  const title = english ? { completed: 'Task completed', failed: notice.source ? 'Turn failed' : 'Task failed', approval: 'Approval needed', 'turn-ended': 'Turn ended', interrupted: 'Turn interrupted' }[notice.kind]
    : { completed: '任务已完成', failed: notice.source ? '本轮异常停止' : '任务失败', approval: '需要你的审批', 'turn-ended': '本轮结束', interrupted: '本轮已中断' }[notice.kind]
  return notice.source ? `${{ codex: 'Codex', claude: 'Claude', 'harness-web': 'Harness' }[notice.source]} · ${title}` : title
}

function ActivityToast({ notice, suspended, onExpire, onDismiss, onOpen }: {
  notice: ActivityNotice
  suspended: boolean
  onExpire: (id: string) => void
  onDismiss: (id: string) => void
  onOpen: (notice: ActivityNotice) => void
}) {
  const { i18n } = useTranslation()
  const english = i18n.language.startsWith('en')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const remaining = useRef(activityToastTimeout(notice.kind))
  const paused = suspended || hovered || focused
  useEffect(() => {
    if (paused || remaining.current === null) return
    const startedAt = Date.now()
    const timer = setTimeout(() => onExpire(notice.id), remaining.current)
    return () => { clearTimeout(timer); remaining.current = Math.max(0, (remaining.current ?? 0) - (Date.now() - startedAt)) }
  }, [notice.id, paused, onExpire])
  const title = activityNoticeTitle(notice, english)
  const action = english ? notice.kind === 'approval' ? 'Review request' : 'View session' : notice.kind === 'approval' ? '查看请求' : '查看会话'
  return <article className={`activity-toast is-${notice.kind}`} aria-label={`${activityProjectName(notice.workspace)} · ${title}`}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    <button type="button" className="activity-toast-open" onClick={() => onOpen(notice)} aria-label={`${action} · ${activityProjectName(notice.workspace)}`} title={`${notice.workspace}\n${notice.sessionId} · ${notice.taskId}`}>
      <ActivityNoticeIcon kind={notice.kind}/>
      <span className="activity-toast-copy">
        <span className="activity-toast-heading"><strong>{title}</strong><time dateTime={new Date(notice.at).toISOString()}>{new Date(notice.at).toLocaleTimeString(english ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></span>
        <span className="activity-toast-description"><span className="activity-toast-project">{activityProjectName(notice.workspace)}</span><span className="activity-toast-action">{action}<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m4 2 4 4-4 4"/></svg></span></span>
      </span>
    </button>
    <button type="button" className="activity-toast-close" aria-label={english ? `Dismiss ${title}` : `关闭${title}提醒`} title={english ? 'Dismiss notification' : '关闭提醒'} onClick={() => onDismiss(notice.id)}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="m3 3 6 6M9 3l-6 6"/></svg></button>
  </article>
}

/** 自动提醒不抢焦点；关闭卡片或超时均保留历史，只有用户在详情中选择才回答审批。 */
export function ActivityNotifications() {
  const { i18n } = useTranslation()
  const { notices, unreadNoticeIds, muted, snapshot, open, markRead, show } = useWorkbenchActivity()
  const [tracker] = useState(() => createActivityToastTracker(notices))
  const [toasts, setToasts] = useState<ActivityNotice[]>([])
  const [announcement, setAnnouncement] = useState('')
  const fresh = activityFresh(snapshot)
  const tuiFresh = tuiActivityFresh(snapshot?.tui)
  const webFresh = webActivityFresh(snapshot?.web)
  useEffect(() => {
    const incoming = tracker.take(notices)
    const eligible = (notice: ActivityNotice) => {
      if (!notices.some(item => item.id === notice.id) || !unreadNoticeIds.includes(notice.id) || muted.includes(activityDirectoryKey(notice.workspace))) return false
      if (notice.kind !== 'approval') return true
      if (notice.source === 'harness-web') {
        return webFresh && !!snapshot?.web?.sessions.some(row => row.sessionId === notice.sessionId && row.turnId === notice.taskId && row.approvalIds.includes(notice.webEventId ?? '')) &&
          notice.id === JSON.stringify(['harness-web', snapshot.web.identity, notice.webEventId])
      }
      if (notice.source) return tuiFresh && !!snapshot?.tui?.sessions.some(row => row.terminalId === notice.sessionId && row.launchId === notice.launchId && row.turnId === notice.taskId && row.active && row.state === 'waiting-approval' && (!row.approvalEventId || row.approvalEventId === notice.tuiEventId))
      if (!fresh || !snapshot?.identity) return false
      // 审批卡片只在原后台、会话、任务及实际审批仍有效时保留。
      try {
        const identity = JSON.parse(notice.id) as unknown[]
        const row = snapshot.sessions.find(item => item.sessionId === notice.sessionId && item.taskId === notice.taskId && !item.stale)
        return JSON.stringify(identity[0]) === JSON.stringify(snapshot.identity) && !!row?.approvals.some(approval => approval.id === identity[4])
      } catch { return false }
    }
    setToasts(current => mergeActivityToasts(current.filter(eligible), incoming.filter(eligible)))
    if (incoming.some(eligible)) {
      const english = i18n.language.startsWith('en')
      setAnnouncement(incoming.filter(eligible).map(notice => `${activityProjectName(notice.workspace)} · ${activityNoticeTitle(notice, english)} · ${english ? 'Task' : '任务'} ${notice.taskId.slice(-8)}`).join('；'))
    }
  }, [notices, unreadNoticeIds, muted, snapshot, fresh, tuiFresh, webFresh, tracker, i18n.language])
  const expire = useCallback((id: string) => setToasts(current => current.filter(notice => notice.id !== id)), [])
  const dismiss = useCallback((id: string) => { markRead(id); expire(id) }, [markRead, expire])
  const openNotice = useCallback((notice: ActivityNotice) => { markRead(notice.id); expire(notice.id); show(notice.workspace, notice.sessionId) }, [markRead, expire, show])
  return <>
    <div className="activity-toast-region win-no-drag" aria-label={i18n.language.startsWith('en') ? 'Task notifications' : '任务通知'} hidden={open}>
      {toasts.map(notice => <ActivityToast key={notice.id} notice={notice} suspended={open} onExpire={expire} onDismiss={dismiss} onOpen={openNotice}/>) }
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </>
}
