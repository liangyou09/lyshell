import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { WorkbenchActivitySession, WorkbenchBackendIdentity } from '@shared/workbench-activity'
import { useWorkbenchActivity, activityDirectoryKey, activityFresh, tuiActivityFresh, webActivityFresh, startActivityPolling } from '../../stores/workbench-activity'
import { useSessionStore, type SessionState } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { ActivityNotifications, ActivityNoticeIcon, activityProjectName, activityNoticeTitle } from './ActivityNotifications'
import { showShelfNotice } from './task-shelf-navigation'
import { useTaskShelf, shelfEntryFor } from '../../stores/task-shelf'
import { TaskStatusLight, TaskStatusLegend } from './TaskStatusLight'
import { resolveTerminalTaskStatus, resolveNativeTaskStatus, resolveWebTaskStatus, type ShelfTaskStatus } from './task-shelf-status'
import './WorkbenchActivity.css'
import { TaskWorkbenchDetails } from './TaskWorkbenchDetails'
import { startTaskWorkbenchSubscription } from '../../stores/task-workbench'

export function ActivityIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 3.5h12v9H2zM5 6h6M5 9h4"/></svg>
}

/** 常用信息留在列表，完整身份与状态依据放在原位详情中。 */
function ActivitySessionRow({ id, selected, name, source, workspace, status, taskStatus, updatedAt, terminal, instanceLive, action, disabled, onOpen, children, approvals }: {
  id: string; selected: boolean; name: string; source: string; workspace: string; status: string; taskStatus: ShelfTaskStatus
  updatedAt?: number; terminal?: boolean; instanceLive?: boolean; action: string; disabled?: boolean; onOpen: () => void
  children: ReactNode; approvals?: ReactNode
}) {
  const { i18n, t } = useTranslation()
  const english = i18n.language.startsWith('en')
  return <article tabIndex={-1} data-session-id={id} className={`workbench-activity-row${selected ? ' is-selected' : ''}`}>
    <div className="activity-session-heading">
      <button className="activity-session-open" aria-label={`${action} · ${name}`} title={[name, source, workspace, status, action].filter(Boolean).join('\n')} disabled={disabled} onClick={onOpen}>
        <span className="activity-session-symbol"><span aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{terminal ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></> : <><path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z"/></>}</svg></span><TaskStatusLight status={taskStatus} instanceStatus={instanceLive ? 'live' : undefined} label={instanceLive && taskStatus === 'unknown' ? `${t('taskShelf.instanceStatus.live')} · ${status}` : status} /></span>
        <strong>{name}</strong>
        <span className={`activity-session-state status-${taskStatus}`} title={status}>{t(`taskShelf.statusShort.${taskStatus}`)}</span>
      </button>
    </div>
    <details className="activity-session-details"><summary aria-label={`${english ? 'Session details' : '会话详情'} · ${name}`} title={english ? 'Session details' : '会话详情'}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 3 5 5-5 5"/></svg></summary><div><p className="activity-session-explanation">{status}</p>{children}<dl><div><dt>{english ? 'Source' : '来源'}</dt><dd>{source}</dd></div><div><dt>{english ? 'Workspace' : '项目目录'}</dt><dd>{workspace || (english ? 'Workspace unavailable' : '目录未提供')}</dd></div><div><dt>{english ? 'Session' : '会话'}</dt><dd>{id}</dd></div>{updatedAt !== undefined && <div><dt>{english ? 'Updated' : '更新于'}</dt><dd><time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleString()}</time></dd></div>}</dl></div></details>
    {approvals}
  </article>
}

/** 轮询和提醒只挂载一次；旧入口统一路由到任务侧栏。 */
export function WorkbenchActivityMonitor() {
  const { open, panelView, workspace, selectedSessionId, close } = useWorkbenchActivity()
  useEffect(() => startActivityPolling(), [])
  useEffect(() => startTaskWorkbenchSubscription(), [])
  useEffect(() => {
    if (!open) return
    useTaskShelf.getState().showActivity(panelView)
    close()
  }, [open, panelView, workspace, selectedSessionId, close])
  return createPortal(<ActivityNotifications />, document.body)
}

/** 侧栏共用的会话/提醒内容，不创建独立浮窗或重复页签。 */
export function WorkbenchActivity({ view = 'sessions' }: { view?: 'sessions' | 'notices' }) {
  const { i18n } = useTranslation()
  const text = (zh: string, en: string) => i18n.language.startsWith('en') ? en : zh
  const state = useWorkbenchActivity()
  const local = useSessionStore(store => store.sessions)
  const panel = useRef<HTMLElement>(null)
  const [now, setNow] = useState(Date.now())
  const [navigationError, setNavigationError] = useState('')
  const [navigating, setNavigating] = useState(false)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!state.selectedSessionId) return
    const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])].find(item => item.dataset.sessionId === state.selectedSessionId)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [state.workspace, state.selectedSessionId, view])
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
    if (!row.active && row.state !== 'session-ended') return text('未知 · CLI 事件已失活', 'Unknown · inactive CLI event')
    return ({ unknown: text('等待 CLI 事件 · 检查 /hooks 提示', 'Awaiting CLI event · check /hooks'), idle: text('等待输入', 'Awaiting input'), running: text('本轮运行中', 'Turn running'),
      'waiting-approval': text('等待审批 · 请在终端处理', 'Awaiting approval · answer in terminal'), 'turn-ended': text('本轮结束 · 不代表整个目标完成', 'Turn ended · goal completion unverified'),
      failed: text('本轮异常停止', 'Turn failed'), interrupted: text('本轮已中断', 'Turn interrupted'), 'session-ended': text('CLI 会话已结束', 'CLI session ended') })[row.state]
  }

  function focusTerminal(row: SessionState) {
    const saved = shelfEntryFor('terminal', row.id)
    const entry = useTaskShelf.getState().entries.find(item => item.id === saved)
    if (saved && entry && !entry.archivedAt && !entry.trashedAt && (row.status === 'connected' || row.status === 'connecting')) {
      useTaskShelf.getState().hide(saved)
      useTaskShelf.getState().showPanel(saved)
      return
    }
    // 定位归档、回收或断开的终端只显示原实例，不隐式激活或进入恢复流程。
    if (saved) useTaskShelf.getState().setPreview(saved, false)
    const pane = usePaneStore.getState()
    pane.toggleLiveSessionTabs([row.id], false)
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
  // 本地终端不依赖 Harness；其后台读取错误放进状态说明，操作失败仍就地显示。
  const passiveError = view === 'sessions' && visibleTerminals.length > 0 && !visibleNative.length && !visibleWeb.length ? state.error : null
  const visibleError = state.actionError || navigationError || (!passiveError ? state.error : null)
  const connectionLabel = webFresh && webSessions.length ? text('Harness 内置聊天通知已接入', 'Harness chat notifications connected') : cliConnection ?? (state.snapshot ? fresh ? text('原生 Harness 已连接', 'Native Harness connected') : state.snapshot.connection === 'offline' ? text('Harness 未连接', 'Harness offline') : state.snapshot.connection === 'connected' && !state.snapshot.identity ? text('暂无已接入的 Harness 任务', 'No observed Harness tasks') : text('Harness 状态已过期', 'Harness state stale') : text('正在读取状态…', 'Reading state…'))
  return <section ref={panel} aria-label={text('会话与任务', 'Sessions & tasks')} className={`workbench-activity-panel is-${view}`}>
      <div className="workbench-activity-toolbar">
        <label><span className="sr-only">{text('项目目录', 'Project directory')}</span><select title={state.workspace ?? text('全部项目', 'All projects')} value={state.workspace ? activityDirectoryKey(state.workspace) : ''} onChange={event => useWorkbenchActivity.setState({ workspace: directories.find(path => activityDirectoryKey(path) === event.target.value) ?? null, selectedSessionId: null })}><option value="">{text('全部项目', 'All projects')}</option>{directories.map(path => <option key={activityDirectoryKey(path)} value={activityDirectoryKey(path)}>{path}</option>)}</select></label>
        <button className="activity-icon-button" aria-label={text('刷新', 'Refresh')} title={text('刷新', 'Refresh')} onClick={() => void state.refresh()}><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16.5 8a6.5 6.5 0 1 0-.8 6M16.5 3v5h-5"/></svg></button>
        {state.workspace && <button aria-pressed={muted} onClick={() => state.mute(state.workspace!)}>{muted ? text('取消静音', 'Unmute') : text('静音此项目', 'Mute project')}</button>}
        {view === 'notices' && state.notices.length > 0 && <>
          <button className="activity-icon-button" aria-label={text('全部已读', 'Mark all read')} title={text('全部已读', 'Mark all read')} onClick={() => state.markRead()} disabled={!state.unreadNoticeIds.length}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 4 4 8-8m-4 8 6-6"/></svg></button>
          <button className="activity-icon-button" aria-label={text('清空', 'Clear')} title={text('清空', 'Clear')} onClick={state.dismiss}><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h14M8 3h4M5 5l1 12h8l1-12M8 8v6m4-6v6"/></svg></button>
        </>}
      </div>
      <div aria-label={view === 'notices' ? text('提醒列表', 'Notifications') : text('会话列表', 'Sessions')} className="workbench-activity-list rack-scroll">
        {view === 'sessions' && <TaskWorkbenchDetails workspace={state.workspace ?? ''} />}
        {visibleError && <p role="status" className="workbench-activity-message">{visibleError}</p>}
        {view === 'notices' ? <>
          {visibleNotices.map(notice => <button key={notice.id} className={`workbench-notice-row${state.unreadNoticeIds.includes(notice.id) ? ' is-unread' : ''}`} title={`${notice.workspace}\n${notice.sessionId}`} onClick={() => { state.markRead(notice.id); if (showShelfNotice(notice)) state.close(); else state.show(notice.workspace, notice.sessionId) }}>
            <ActivityNoticeIcon kind={notice.kind}/><span><strong>{activityProjectName(notice.workspace)}</strong><span>{activityNoticeTitle(notice, i18n.language.startsWith('en'))}</span></span><time dateTime={new Date(notice.at).toISOString()}>{new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
          </button>)}
          {!visibleNotices.length && <div className="workbench-activity-empty"><ActivityIcon/><strong>{text('暂时没有新提醒', 'All quiet for now')}</strong><p>{text('任务完成、失败或需要审批时，会在这里保留提醒。', 'A notification will appear here when a task completes, fails, or needs approval.')}</p></div>}
        </> : <>
        {visibleNative.map(row => <ActivitySessionRow key={row.key} id={row.sessionId} selected={row.sessionId === state.selectedSessionId}
          name={activityProjectName(row.workspace)} source="Harness" workspace={row.workspace}
          status={row.approvals.length && fresh && !row.stale ? text('等待审批', 'Awaiting approval') : taskLabel(row)}
          taskStatus={resolveNativeTaskStatus(row, state.snapshot, Math.max(now, Date.now()))} updatedAt={row.updatedAt}
          action={navigating ? text('正在定位…', 'Locating…') : text('打开工作台', 'Open workbench')} disabled={!fresh || row.stale || navigating} onOpen={() => void openWorkbench(row)}
          approvals={row.approvals.map(approval => <details className="workbench-activity-approval" key={approval.id}>
            <summary title={approval.toolName}>{text('查看请求', 'Review request')}<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m5 3 5 5-5 5"/></svg></summary><strong>{approval.toolName}</strong><p>{approval.reason}</p>
            {approval.operation ? <pre>{approval.operation}</pre> : <p>{text('操作参数不完整，请在官方工作台核对。', 'Operation details are incomplete. Verify in the official workbench.')}</p>}
            <div className="workbench-activity-options">{approval.options.map(option => <button key={option} disabled={state.busy || !fresh || row.stale || (option === 'allowed-once' && !approval.operation)} onClick={() => void state.approve(row, approval, option)}>{option === 'allowed-once' ? text('仅允许一次', 'Allow once') : option === 'rejected' ? text('拒绝', 'Reject') : text('取消', 'Cancel')}</button>)}</div>
          </details>)}>
          <dl><div><dt>{text('进程', 'Process')}</dt><dd>{text('后台托管 · 无独立终端证据', 'Backend managed · no terminal evidence')}</dd></div><div><dt>{text('连接', 'Connection')}</dt><dd>{fresh && !row.stale ? text('已连接', 'Connected') : text('未知 / 已过期', 'Unknown / stale')}</dd></div><div><dt>{text('任务', 'Task')}</dt><dd>{row.taskId || text('暂无任务', 'No task')}</dd></div></dl>
          <p className="workbench-activity-evidence">{text('来源：原生 Harness · 状态变更于', 'Source: native Harness · state changed at')} {new Date(row.updatedAt).toLocaleString()}</p>
        </ActivitySessionRow>)}
        {visibleWeb.map(row => <ActivitySessionRow key={`web-${row.sessionId}`} id={row.sessionId} selected={row.sessionId === state.selectedSessionId}
          name={activityProjectName(row.workspace)} source={text('Harness 内置聊天', 'Harness chat')} workspace={row.workspace}
          status={!webFresh ? text('未知 · 状态已过期', 'Unknown · stale state') : ({ running: text('本轮运行中', 'Turn running'), 'waiting-approval': text('等待审批 · 请在工作台处理', 'Awaiting approval · answer in workbench'), 'turn-ended': text('本轮结束 · 不代表整个目标完成', 'Turn ended · goal completion unverified'), failed: text('本轮异常停止', 'Turn failed'), interrupted: text('本轮已中断', 'Turn interrupted') })[row.state]}
          taskStatus={resolveWebTaskStatus(row, web, Math.max(now, Date.now()))} updatedAt={row.updatedAt}
          action={navigating ? text('正在定位…', 'Locating…') : text('打开工作台', 'Open workbench')} disabled={!webFresh || navigating} onOpen={() => void openWorkbench(row, web?.identity)}>
          <dl><div><dt>{text('连接', 'Connection')}</dt><dd>{webFresh ? text('已连接', 'Connected') : text('未知 / 已过期', 'Unknown / stale')}</dd></div></dl>
          <p className="workbench-activity-evidence">{text('来源：Harness 官方回合事件 ·', 'Source: official Harness turn events ·')} {new Date(row.updatedAt).toLocaleString()}</p>
          {webFresh && !!row.approvalIds.length && <p>{text('有操作需要确认，请打开工作台核对并处理。', 'An operation needs approval. Open the workbench to review it.')}</p>}
        </ActivitySessionRow>)}
        {visibleTerminals.map(row => {
          const observed = tui?.sessions.find(item => item.terminalId === row.id)
          const taskStatus = resolveTerminalTaskStatus(row.id, state.snapshot, row.status, Math.max(now, Date.now()))
          const explanation = taskStatus === 'connectionError' ? text('连接异常 · 任务结果未知', 'Connection error · task outcome unknown') : taskStatus === 'disconnected' ? text('终端已断开 · 任务结果未知', 'Terminal disconnected · task outcome unknown') : tuiLabel(row.id)
          return <ActivitySessionRow key={row.id} id={row.id} selected={row.id === state.selectedSessionId} terminal instanceLive={row.status === 'connected'}
            name={row.config.name} source={observed ? `${observed.source === 'codex' ? 'Codex' : 'Claude'} · ${text('终端', 'Terminal')}` : text('本地终端', 'Local terminal')} workspace={row.config.local!.cwd!}
            status={explanation} taskStatus={taskStatus} updatedAt={observed?.updatedAt}
            action={text('定位终端', 'Go to terminal')} onOpen={() => focusTerminal(row)}>
            <dl><div><dt>{text('进程', 'Process')}</dt><dd>{row.status === 'connected' ? text('存活', 'Alive') : row.status === 'disconnected' || row.status === 'error' ? text('已退出 / 未运行', 'Exited / stopped') : text('未知', 'Unknown')}</dd></div><div><dt>{text('连接', 'Connection')}</dt><dd>{row.status}</dd></div></dl>
            <p className="workbench-activity-evidence">{observed ? text('来源：CLI 官方生命周期事件 · 仅通知，审批请定位终端', 'Source: official CLI lifecycle events · notifications only, approve in terminal') : text('来源：终端连接事件 · 不推断任务结果', 'Source: terminal connection events · task outcome unavailable')}</p>
          </ActivitySessionRow>
        })}
        {!visibleNative.length && !visibleWeb.length && !visibleTerminals.length && <p className="workbench-activity-message">{text('此目录暂无已打开会话。启动 Agent 或终端后可在这里定位。', 'No open sessions in this directory. Launch an Agent or terminal to find it here.')}</p>}
        </>}
      </div>
      <details className="workbench-activity-help"><summary>{text('状态说明', 'About status')}</summary><footer>
        <TaskStatusLegend />
        {passiveError && <p role="status">{passiveError}</p>}
        <span className="workbench-activity-connection">{connectionLabel}</span>
        {state.snapshot && <div>{text('最近检查：', 'Last checked: ')}<time dateTime={new Date(state.snapshot.observedAt).toISOString()}>{new Date(state.snapshot.observedAt).toLocaleTimeString()}</time></div>}
        {text('每 4 秒检查 Harness 状态，CLI 事件即时提醒。回合结束不等于整个目标完成。内置聊天审批在工作台处理，TUI 审批在原终端处理。', 'Harness state refreshes every 4 seconds; CLI events notify immediately. A turn ending does not verify goal completion. Approve chat requests in the workbench and TUI requests in the terminal.')}
      </footer></details>
    </section>
}
