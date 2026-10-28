import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { WorkbenchActivitySession, WorkbenchBackendIdentity } from '@shared/workbench-activity'
import { useWorkbenchActivity, activityDirectoryKey, activityFresh, tuiActivityFresh, webActivityFresh, startActivityPolling } from '../../stores/workbench-activity'
import { useSessionStore, type SessionState } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { ActivityNotifications, ActivityNoticeIcon, activityProjectName, activityNoticeTitle } from './ActivityNotifications'
import { showShelfNotice } from './task-shelf-navigation'
import './WorkbenchActivity.css'

export function ActivityIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 3.5h12v9H2zM5 6h6M5 9h4"/></svg>
}

export function WorkbenchActivity() {
  const { i18n } = useTranslation()
  const text = (zh: string, en: string) => i18n.language.startsWith('en') ? en : zh
  const state = useWorkbenchActivity()
  const local = useSessionStore(store => store.sessions)
  const panel = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())
  const [navigationError, setNavigationError] = useState('')
  const [navigating, setNavigating] = useState(false)
  const close = state.close
  useEffect(() => startActivityPolling(), [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!state.open) return
    panel.current?.querySelector<HTMLSelectElement>('select')?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation(); close(); document.querySelector<HTMLButtonElement>('[data-workbench-activity-trigger]')?.focus()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [state.open, close])
  useEffect(() => {
    if (!state.open || !state.selectedSessionId) return
    const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])].find(item => item.dataset.sessionId === state.selectedSessionId)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [state.open, state.workspace, state.selectedSessionId, state.panelView])
  const terminals = useMemo(() => local.filter(row => row.config.type === 'local' && !row.config.ownerPluginId && !!row.config.local?.cwd), [local])
  const web = state.snapshot?.web
  const webSessions = web?.sessions ?? []
  const webFresh = webActivityFresh(web, Math.max(now, Date.now()))
  const native = (state.snapshot?.sessions ?? []).filter(row => !webFresh || !webSessions.some(item => item.sessionId === row.sessionId))
  const directories = [...new Map([...terminals.map(row => row.config.local!.cwd!), ...native.map(row => row.workspace), ...webSessions.map(row => row.workspace), ...state.notices.map(notice => notice.workspace), ...(state.workspace ? [state.workspace] : [])].filter(Boolean).map(path => [activityDirectoryKey(path), path])).values()]
  const matches = (workspace: string) => !state.workspace || activityDirectoryKey(state.workspace) === activityDirectoryKey(workspace)
  const visibleTerminals = terminals.filter(row => matches(row.config.local!.cwd!))
  const visibleNative = native.filter(row => matches(row.workspace))
  const visibleWeb = webSessions.filter(row => matches(row.workspace))
  const fresh = activityFresh(state.snapshot, Math.max(now, Date.now()))
  const muted = !!state.workspace && state.muted.includes(activityDirectoryKey(state.workspace))
  const taskLabel = (row: WorkbenchActivitySession) => !fresh || row.stale ? text('未知 · 状态已过期', 'Unknown · stale state') : ({
    accepted: text('已接收 · 等待运行证据', 'Accepted · awaiting execution'), running: text('执行中', 'Running'),
    completed: text('已完成', 'Completed'), failed: text('失败', 'Failed'), cancelled: text('已取消', 'Cancelled'),
    unconfirmed: text('结果未知 · 请核对', 'Outcome unconfirmed'), unknown: text('未知', 'Unknown')
  }[row.taskState])
  const tui = state.snapshot?.tui
  const tuiFresh = tuiActivityFresh(tui, Math.max(now, Date.now()))
  const cliConnection = tui?.sessions.length ? !tuiFresh ? text('CLI 状态已过期', 'CLI state stale')
    : tui.sessions.some(row => row.event) ? text('CLI 通知已接入 · 审批在终端处理', 'CLI notifications connected · approve in terminal')
      : text('等待 CLI 通知 · 检查 /hooks 提示', 'Awaiting CLI notifications · check /hooks') : null
  const tuiLabel = (terminalId: string): string => {
    const row = tui?.sessions.find(item => item.terminalId === terminalId)
    if (!row) return text('未知 · CLI 未提供可靠状态', 'Unknown · CLI has no reliable adapter')
    if (!tuiFresh) return text('未知 · 状态已过期', 'Unknown · stale state')
    if (!row.active && row.state === 'unknown') return text('未知 · 终端已断开', 'Unknown · terminal disconnected')
    return ({ unknown: text('等待 CLI 事件 · 检查 /hooks 提示', 'Awaiting CLI event · check /hooks'), idle: text('等待输入', 'Awaiting input'), running: text('本轮运行中', 'Turn running'),
      'waiting-approval': text('等待审批 · 请在终端处理', 'Awaiting approval · answer in terminal'), 'turn-ended': text('本轮结束 · 不代表整个目标完成', 'Turn ended · goal completion unverified'),
      failed: text('本轮异常停止', 'Turn failed'), interrupted: text('本轮已中断', 'Turn interrupted'), 'session-ended': text('CLI 会话已结束', 'CLI session ended') })[row.state]
  }

  function focusTerminal(row: SessionState) {
    const pane = usePaneStore.getState()
    const existing = pane.getAllLeafPanes().find(item => item.sessions.includes(row.id))
    if (existing) {
      pane.deactivateOverlaysInPane(existing.id)
      pane.setActiveSessionInPane(existing.id, row.id)
    } else pane.addSessionToPane(pane.layout.activePaneId, row.id)
    useSessionStore.getState().setActiveSession(row.id)
    state.close()
  }
  async function openWorkbench(row: Pick<WorkbenchActivitySession, 'sessionId' | 'workspace'>, identity: WorkbenchBackendIdentity | null = state.snapshot?.identity ?? null) {
    if (navigating || !identity) return
    setNavigationError('')
    setNavigating(true)
    try {
      const result = await window.electronAPI.workbenchActivityNavigate({ kind: 'open', identity, sessionId: row.sessionId })
      if (!result.success) throw new Error(result.error)
      if (!result.url) throw new Error(text('无法打开工作台', 'Cannot open workbench'))
      const pane = usePaneStore.getState()
      pane.openDshWebInPane(pane.layout.activePaneId, { kind: 'dshWeb', url: result.url, name: text('原生 Harness 工作台', 'Native Harness workbench'), cwd: row.workspace, detail: true })
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const progress = await window.electronAPI.workbenchActivityNavigate({ kind: 'navigation', identity, sessionId: row.sessionId, requestId: result.requestId })
        if (!progress.success) throw new Error(progress.error)
        if (progress.navigation === 'navigated') { state.close(); return }
        if (progress.navigation === 'failed') throw new Error(text('工作台未确认会话跳转，请在工作台核对；任务未重发。', 'Workbench did not confirm navigation. Verify in the workbench; task was not resent.'))
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error(text('会话跳转确认超时，请在工作台核对；任务未重发。', 'Session navigation confirmation timed out. Verify in the workbench; task was not resent.'))
    } catch (error) { setNavigationError((error as Error).message) }
    finally { setNavigating(false) }
  }
  if (!window.electronAPI?.workbenchActivityRequest) return null
  const visibleNotices = state.notices.filter(notice => matches(notice.workspace))
  return createPortal(<>
    <ActivityNotifications />
    {state.open && <div ref={panel} id="workbench-activity-panel" role="dialog" aria-label={text('项目会话与任务', 'Project sessions and tasks')} className="workbench-activity-panel win-no-drag">
      <header><div><h2>{text('会话与任务', 'Sessions & tasks')}</h2><span className="workbench-activity-connection">{webFresh && webSessions.length ? text('Harness 内置聊天通知已接入', 'Harness chat notifications connected') : cliConnection ?? (state.snapshot ? fresh ? text('原生 Harness 已连接', 'Native Harness connected') : state.snapshot.connection === 'offline' ? text('Harness 未连接', 'Harness offline') : state.snapshot.connection === 'connected' && !state.snapshot.identity ? text('暂无已接入的 Harness 任务', 'No observed Harness tasks') : text('Harness 状态已过期', 'Harness state stale') : text('正在读取状态…', 'Reading state…'))}</span></div><button onClick={() => { state.close(); document.querySelector<HTMLButtonElement>('[data-workbench-activity-trigger]')?.focus() }}>{text('关闭', 'Close')}</button></header>
      <div className="workbench-activity-tabs" role="tablist" aria-label={text('工作状态视图', 'Work status views')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        tabs[index]?.click(); tabs[index]?.focus()
      }}>
        <button role="tab" id="activity-notices-tab" tabIndex={state.panelView === 'notices' ? 0 : -1} aria-selected={state.panelView === 'notices'} aria-controls="activity-content" onClick={() => state.setPanelView('notices')}>{text('提醒', 'Notifications')}<span>{state.unreadNoticeIds.length || state.notices.length}</span></button>
        <button role="tab" id="activity-sessions-tab" tabIndex={state.panelView === 'sessions' ? 0 : -1} aria-selected={state.panelView === 'sessions'} aria-controls="activity-content" onClick={() => state.setPanelView('sessions')}>{text('会话', 'Sessions')}<span>{terminals.length + native.length + webSessions.length}</span></button>
      </div>
      <div className="workbench-activity-toolbar">
        <label>{text('项目目录', 'Project directory')}<select value={state.workspace ? activityDirectoryKey(state.workspace) : ''} onChange={event => useWorkbenchActivity.setState({ workspace: directories.find(path => activityDirectoryKey(path) === event.target.value) ?? null, selectedSessionId: null })}><option value="">{text('全部项目', 'All projects')}</option>{directories.map(path => <option key={activityDirectoryKey(path)} value={activityDirectoryKey(path)}>{path}</option>)}</select></label>
        <button onClick={() => void state.refresh()}>{text('刷新', 'Refresh')}</button>
        {state.workspace && <button aria-pressed={muted} onClick={() => state.mute(state.workspace!)}>{muted ? text('取消静音', 'Unmute') : text('静音此项目', 'Mute project')}</button>}
      </div>
      <div id="activity-content" role="tabpanel" aria-labelledby={state.panelView === 'notices' ? 'activity-notices-tab' : 'activity-sessions-tab'} className="workbench-activity-list rack-scroll">
        {(state.actionError || navigationError || state.error) && <p role="status" className="workbench-activity-message">{state.actionError || navigationError || state.error}</p>}
        {state.panelView === 'notices' ? <>
          {state.notices.length > 0 && <div className="workbench-activity-notice-actions"><span>{text('最近的工作动态', 'Recent work activity')}</span><button onClick={() => state.markRead()} disabled={!state.unreadNoticeIds.length}>{text('全部已读', 'Mark all read')}</button><button onClick={state.dismiss}>{text('清空', 'Clear')}</button></div>}
          {visibleNotices.map(notice => <button key={notice.id} className={`workbench-notice-row${state.unreadNoticeIds.includes(notice.id) ? ' is-unread' : ''}`} onClick={() => { state.markRead(notice.id); if (showShelfNotice(notice)) state.close(); else state.show(notice.workspace, notice.sessionId) }}>
            <ActivityNoticeIcon kind={notice.kind}/><span><strong>{activityProjectName(notice.workspace)}</strong><span>{activityNoticeTitle(notice, i18n.language.startsWith('en'))}</span><small title={notice.workspace}>{notice.workspace} · {notice.sessionId.slice(-8)}</small></span><time dateTime={new Date(notice.at).toISOString()}>{new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
          </button>)}
          {!visibleNotices.length && <div className="workbench-activity-empty"><ActivityIcon/><strong>{text('暂时没有新提醒', 'All quiet for now')}</strong><p>{text('任务完成、失败或需要审批时，会在右上角提醒你。', 'A notification will appear here when a task completes, fails, or needs approval.')}</p></div>}
        </> : <>
        {visibleNative.map(row => <article key={row.key} tabIndex={-1} data-session-id={row.sessionId} className={`workbench-activity-row${row.sessionId === state.selectedSessionId ? ' is-selected' : ''}`}>
          <div className="workbench-activity-row-title"><strong>Harness · {row.sessionId}</strong><button disabled={!fresh || row.stale || navigating} onClick={() => void openWorkbench(row)}>{navigating ? text('正在定位…', 'Locating…') : text('打开工作台', 'Open workbench')}</button></div>
          <p className="workbench-activity-path">{row.workspace}</p>
          <dl><div><dt>{text('进程', 'Process')}</dt><dd>{text('后台托管 · 无独立终端证据', 'Backend managed · no terminal evidence')}</dd></div><div><dt>{text('任务', 'Task')}</dt><dd>{row.approvals.length && fresh && !row.stale ? text('等待审批', 'Awaiting approval') : taskLabel(row)}</dd></div><div><dt>{text('连接', 'Connection')}</dt><dd>{fresh && !row.stale ? text('已连接', 'Connected') : text('未知 / 已过期', 'Unknown / stale')}</dd></div></dl>
          <p className="workbench-activity-evidence">{text('来源：原生 Harness · 状态变更于', 'Source: native Harness · state changed at')} {new Date(row.updatedAt).toLocaleTimeString()} · {row.taskId || text('暂无任务', 'No task')}</p>
          {row.approvals.map(approval => <section className="workbench-activity-approval" key={approval.id}>
            <strong>{text('请求审批', 'Approval request')} · {approval.toolName}</strong><p>{approval.reason}</p>
            {approval.operation ? <pre>{approval.operation}</pre> : <p>{text('操作参数不完整，请在官方工作台核对。', 'Operation details are incomplete. Verify in the official workbench.')}</p>}
            <div className="workbench-activity-options">{approval.options.map(option => <button key={option} disabled={state.busy || !fresh || row.stale || (option === 'allowed-once' && !approval.operation)} onClick={() => void state.approve(row, approval, option)}>{option === 'allowed-once' ? text('仅允许一次', 'Allow once') : option === 'rejected' ? text('拒绝', 'Reject') : text('取消', 'Cancel')}</button>)}</div>
          </section>)}
        </article>)}
        {visibleWeb.map(row => <article key={`web-${row.sessionId}`} tabIndex={-1} data-session-id={row.sessionId} className={`workbench-activity-row${row.sessionId === state.selectedSessionId ? ' is-selected' : ''}`}>
          <div className="workbench-activity-row-title"><strong>{text('Harness 内置聊天', 'Harness chat')} · {row.sessionId}</strong><button disabled={!webFresh || navigating} onClick={() => void openWorkbench(row, web?.identity)}>{navigating ? text('正在定位…', 'Locating…') : text('打开工作台', 'Open workbench')}</button></div>
          <p className="workbench-activity-path">{row.workspace || text('目录未提供', 'Workspace unavailable')}</p>
          <dl><div><dt>{text('回合', 'Turn')}</dt><dd>{!webFresh ? text('未知 · 状态已过期', 'Unknown · stale state') : ({ running: text('本轮运行中', 'Turn running'), 'waiting-approval': text('等待审批 · 请在工作台处理', 'Awaiting approval · answer in workbench'), 'turn-ended': text('本轮结束 · 不代表整个目标完成', 'Turn ended · goal completion unverified'), failed: text('本轮异常停止', 'Turn failed'), interrupted: text('本轮已中断', 'Turn interrupted') })[row.state]}</dd></div><div><dt>{text('连接', 'Connection')}</dt><dd>{webFresh ? text('已连接', 'Connected') : text('未知 / 已过期', 'Unknown / stale')}</dd></div></dl>
          <p className="workbench-activity-evidence">{text('来源：Harness 官方回合事件 ·', 'Source: official Harness turn events ·')} {new Date(row.updatedAt).toLocaleTimeString()}</p>
          {webFresh && !!row.approvalIds.length && <p>{text('有操作需要确认，请打开工作台核对并处理。', 'An operation needs approval. Open the workbench to review it.')}</p>}
        </article>)}
        {visibleTerminals.map(row => <article key={row.id} tabIndex={-1} data-session-id={row.id} className={`workbench-activity-row${row.id === state.selectedSessionId ? ' is-selected' : ''}`}>
          <div className="workbench-activity-row-title"><strong>{row.config.name}</strong><button onClick={() => focusTerminal(row)}>{text('定位终端', 'Go to terminal')}</button></div>
          <p className="workbench-activity-path">{row.config.local!.cwd}</p>
          <dl><div><dt>{text('进程', 'Process')}</dt><dd>{row.status === 'connected' ? text('存活', 'Alive') : row.status === 'disconnected' || row.status === 'error' ? text('已退出 / 未运行', 'Exited / stopped') : text('未知', 'Unknown')}</dd></div><div><dt>{text('任务', 'Task')}</dt><dd>{tuiLabel(row.id)}</dd></div><div><dt>{text('连接', 'Connection')}</dt><dd>{row.status}</dd></div></dl>
          <p className="workbench-activity-evidence">{tui?.sessions.some(item => item.terminalId === row.id) ? text('来源：CLI 官方生命周期事件 · 仅通知，审批请定位终端', 'Source: official CLI lifecycle events · notifications only, approve in terminal') : text('来源：终端连接事件 · 不推断任务结果', 'Source: terminal connection events · task outcome unavailable')}</p>
        </article>)}
        {!visibleNative.length && !visibleWeb.length && !visibleTerminals.length && <p className="workbench-activity-message">{text('此目录暂无已打开会话。启动 Agent 或终端后可在这里定位。', 'No open sessions in this directory. Launch an Agent or terminal to find it here.')}</p>}
        </>}
      </div>
      <footer>{state.snapshot && <div>{text('最近检查：', 'Last checked: ')}<time dateTime={new Date(state.snapshot.observedAt).toISOString()}>{new Date(state.snapshot.observedAt).toLocaleTimeString()}</time></div>}{text('每 4 秒检查 Harness 状态，CLI 事件即时提醒。回合结束不等于整个目标完成。内置聊天审批在工作台处理，TUI 审批在原终端处理。', 'Harness state refreshes every 4 seconds; CLI events notify immediately. A turn ending does not verify goal completion. Approve chat requests in the workbench and TUI requests in the terminal.')}</footer>
    </div>}
  </>, document.body)
}
