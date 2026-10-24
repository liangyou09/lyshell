import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OverlayPayload } from '@shared/types'
import { attachProjectEntrySession } from '../../stores/project-entry-launch'
import { useSceneEntryLabel } from './useSceneEntryLabel'
import { usePaneStore } from '../../stores/pane-store'

export function ProjectEntry({ payload, id }: { payload: Extract<OverlayPayload, { kind: 'projectEntry' }>; id: string }) {
  const { i18n } = useTranslation()
  const text = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const [error, setError] = useState('')
  // 回执跟随入口而非组件：拖分屏会重挂组件，不能因此再次启动进程。
  const launchState = usePaneStore(state => {
    const current = state.overlayPayloads[id]
    return current?.kind === 'projectEntry' ? current.launch : undefined
  })
  const acceptedId = launchState?.status === 'accepted' ? launchState.sessionId : null
  const missingReceipt = launchState?.status === 'unknown'
  const disabled = busy || launchState?.status === 'pending'
  const recordLaunch = (launch: Extract<OverlayPayload, { kind: 'projectEntry' }>['launch']) => {
    usePaneStore.setState(state => {
      const current = state.overlayPayloads[id]
      return current?.kind === 'projectEntry' ? { overlayPayloads: { ...state.overlayPayloads, [id]: { ...current, launch } } } : {}
    })
  }
  const labels = useSceneEntryLabel(payload)
  const entry = payload.entry
  const picker = entry.kind === 'agent' && (entry.agentKind === 'codex' || entry.agentKind === 'claude')
  const title = entry.kind === 'agent' ? labels.entryName || ({ codex: 'Codex', claude: 'Claude', dsh: 'DeepSeek', agent: text('Agent 启动项', 'Agent launcher') }[entry.agentKind]) : text('项目终端', 'Project terminal')
  const projectName = labels.projectName || payload.target.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || payload.target.cwd
  const status = missingReceipt ? text('启动结果未知', 'Launch status unknown') : launchState?.status === 'pending' ? text('正在启动', 'Starting') : acceptedId ? text('等待定位', 'Locating terminal') : text('待启动', 'Ready to start')
  async function launch(resume: boolean) {
    if (working.current) return
    const current = usePaneStore.getState().overlayPayloads[id]
    if (current?.kind !== 'projectEntry' || current.launch?.status === 'pending' || current.launch?.status === 'unknown') return
    working.current = true
    setBusy(true)
    setError('')
    try {
      let sessionId = current.launch?.status === 'accepted' ? current.launch.sessionId : null
      if (!sessionId) {
        recordLaunch({ status: 'pending' })
        const result = await window.electronAPI.projectSceneRequest({ kind: 'launch', target: payload.target, entry, resume }).catch(failure => {
          // IPC 失败不能证明主进程未创建终端，禁止盲目重发。
          recordLaunch({ status: 'unknown' })
          throw failure
        })
        if (!result.success) { recordLaunch(undefined); throw new Error(result.error) }
        if (!result.sessionId) { recordLaunch({ status: 'unknown' }); throw new Error(text('启动回执缺少终端标识，请先检查终端列表，不要重复启动。', 'Launch receipt has no terminal ID. Check the terminal list before starting again.')) }
        sessionId = result.sessionId
        recordLaunch({ status: 'accepted', sessionId: result.sessionId })
      }
      if (!sessionId) throw new Error(text('终端标识不可用，请先检查终端列表。', 'Terminal ID unavailable. Check the terminal list first.'))
      await attachProjectEntrySession(id, payload, sessionId)
    } catch (failure) { setError((failure as Error).message) }
    finally { working.current = false; setBusy(false) }
  }
  return <section className="project-entry">
    <header className="project-entry-header">
    <h2 title={title}>{title} · {status}</h2>
    <p className="project-entry-context" title={payload.target.cwd}>{projectName}{payload.target.worktreeKey ? ` · ${payload.target.worktreeKey}` : ''}</p>
    <div className="project-entry-actions">
      {missingReceipt ? <button disabled>{text('请先检查终端列表', 'Check terminal list')}</button> : acceptedId ? <button className="project-scene-primary" disabled={disabled} onClick={() => void launch(false)}>{text('定位已创建的终端', 'Locate created terminal')}</button> : <>
        {picker && <button className="project-scene-primary" disabled={disabled} onClick={() => void launch(true)}>{text('选择历史对话…', 'Choose conversation…')}</button>}
        <button disabled={disabled} onClick={() => void launch(false)}>{picker ? text('新建对话', 'New conversation') : entry.kind === 'agent' ? text('普通启动', 'Start Agent') : text('打开终端', 'Open terminal')}</button>
      </>}
    </div>
    </header>
    <div className="project-entry-body rack-scroll">
    <p>{missingReceipt ? text('启动结果尚未确认，请先检查终端列表，不要重复启动。', 'Launch outcome is unconfirmed. Check the terminal list before starting again.') : launchState?.status === 'pending' ? text('正在等待启动回执。', 'Waiting for the launch receipt.') : text(acceptedId ? '进程已创建，重试只会定位同一个终端。' : '现场已恢复，进程尚未启动。历史命令不会执行。', acceptedId ? 'Process created. Retrying only locates the same terminal.' : 'Scene restored; processes remain stopped. Historical commands are not replayed.')}</p>
    {picker && <p>{text('历史对话由 CLI 显示，请自行选择；打开选择器不代表已经续接。', 'Choose a conversation in the CLI. Opening its picker does not confirm a resumed conversation.')}</p>}
    {error && <p role="alert">{error}</p>}
    <details><summary>{text('目录与恢复范围', 'Directory & restore details')}</summary><dl><dt>{text('项目目录', 'Project directory')}</dt><dd>{payload.target.cwd}</dd>{entry.kind === 'agent' && <><dt>{text('启动项引用', 'Launcher reference')}</dt><dd>{entry.agentKind}:{entry.agentId}</dd></>}</dl><p>{text('仅恢复资源入口和布局，不保存进程、任务、凭据或 CLI 会话 ID。', 'Only resources and layout are restored. Processes, tasks, credentials and CLI session IDs are not saved.')}</p>{!picker && entry.kind === 'agent' && <p>{text('此启动项没有可靠的跨重启续接适配；DeepSeek 历史请在官方界面选择，原生控制权不跨重启恢复。', 'This launcher has no verified restart resume adapter. Select DeepSeek history in its official UI; native control does not survive restarts.')}</p>}</details>
    </div>
  </section>
}
