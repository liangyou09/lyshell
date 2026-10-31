import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { PerformanceMetric, TaskDefinition, TaskEntry, TaskSubmission, TaskWorkbenchRequest } from '@shared/task-workbench'
import { useTaskWorkbench } from '../../stores/task-workbench'
import { usePaneStore } from '../../stores/pane-store'
import { activityDirectoryKey, useWorkbenchActivity } from '../../stores/workbench-activity'
import './TaskWorkbenchDetails.css'

const operation = () => crypto.randomUUID()
const blank = (workspace: string): TaskDefinition => ({ title: '', goal: '', workspace, templateId: 'general',
  acceptanceCriteria: '', resourceIds: [], approvalPolicy: 'auto-allow' })
const metric = (): PerformanceMetric => ({ name: '', unit: '', direction: 'lower', baseline: 0, current: 0, samples: 1, thresholdPercent: 5 })

export function TaskWorkbenchDetails({ workspace = '' }: { workspace?: string }) {
  const { i18n } = useTranslation()
  const text = (zh: string, en: string) => i18n.language.startsWith('en') ? en : zh
  const store = useTaskWorkbench()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState<{ entryId?: string; revision?: number; definition: TaskDefinition } | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [runId, setRunId] = useState('')
  const [note, setNote] = useState('')
  const [content, setContent] = useState<{ name: string; text: string } | null>(null)
  const [localError, setLocalError] = useState('')
  const snapshot = store.snapshot
  const entries = snapshot?.entries.filter(entry => !workspace || activityDirectoryKey(entry.workspace) === activityDirectoryKey(workspace)) ?? []
  const entry = entries.find(item => item.id === selectedId) ?? entries[0]
  const submissions = snapshot?.submissions.filter(item => item.taskEntryId === entry?.id).sort((a, b) => b.enqueueSeq - a.enqueueSeq) ?? []
  const run = submissions.find(item => item.id === runId) ?? submissions[0]
  const result = snapshot?.results.filter(item => item.submissionId === run?.id).at(-1)
  const blocked = store.busy || !!store.pending || !!snapshot?.storageError
  const active = snapshot?.submissions.filter(item => item.slotHeld).length ?? 0
  const waiting = snapshot?.submissions.filter(item => item.handoffState === 'waiting' || item.resumeIntent?.state === 'waiting').length ?? 0
  const action = async (request: TaskWorkbenchRequest) => {
    setLocalError('')
    return store.execute(request)
  }
  const mutation = (kind: 'withdraw' | 'cancel' | 'verify') => run && void action({ kind, submissionId: run.id, operationId: operation() })
  const labeledState = (item: TaskSubmission) => {
    if (item.resumeIntent) return item.resumeIntent.state === 'waiting' ? text('等待续接', 'Resume queued') : text('续接结果待核对', 'Resume unconfirmed')
    if (item.handoffState === 'waiting') return snapshot?.queueEnabled ? text('等待执行', 'Queued') : text('队列已暂停', 'Queue paused')
    if (item.handoffState === 'sending') return text('正在交接', 'Handing off')
    if (item.handoffState === 'unknown') return text('交接结果待核对', 'Handoff unconfirmed')
    if (item.handoffState === 'rejected') return text('交接被拒绝', 'Handoff refused')
    if (item.handoffState === 'withdrawn') return text('已撤回', 'Withdrawn')
    if (item.observation?.stale) return text('观察已过期 · 请核对', 'Observation stale · inspect')
    if (item.cancelRequestedAt && item.slotHeld) return text('已请求停止 · 等待确认', 'Stop requested · awaiting confirmation')
    return ({ accepted: text('已接收', 'Accepted'), running: text('执行中', 'Running'), completed: text('执行结束 · 查看验收', 'Execution ended · check results'), failed: text('执行失败', 'Execution failed'), cancelled: text('已停止', 'Stopped'), unconfirmed: text('执行结果未知', 'Execution unconfirmed'), unknown: text('执行结果未知', 'Execution unknown') })[item.observation?.state ?? 'unknown']
  }
  const waitingDescription = (item: TaskSubmission) => {
    if (!snapshot?.queueEnabled) return text('恢复队列后才会派发。', 'Dispatch begins after you resume the queue.')
    const conflict = snapshot.submissions.find(other => other.id !== item.id &&
      other.resourcesHeld.some(resource => item.frozenDefinition.resourceIds.includes(resource)))
    if (conflict) return text(`等待资源 ${conflict.resourcesHeld.filter(resource => item.frozenDefinition.resourceIds.includes(resource)).join('、')} · ${conflict.frozenDefinition.title} 仍持有。`,
      `Waiting for ${conflict.resourcesHeld.filter(resource => item.frozenDefinition.resourceIds.includes(resource)).join(', ')} · held by ${conflict.frozenDefinition.title}.`)
    return active >= snapshot.maxActive ? text('并发额度已满；审批和未确认停止仍占用额度。', 'Active limit reached; approvals and unconfirmed stops retain their slots.') : text('按队列顺序等待交接。', 'Waiting for handoff in queue order.')
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    const reply = await action({ kind: 'save', operationId: operation(), definition: { ...editing.definition,
      resourceIds: [...new Set(editing.definition.resourceIds.map(value => value.trim()).filter(Boolean))] },
      ...(editing.entryId ? { entryId: editing.entryId, expectedRevision: editing.revision } : {}) })
    if (reply.ok) { setSelectedId(reply.entityId ?? ''); setRunId(''); setEditing(null) }
  }
  async function openNative() {
    if (!run?.nativeExecutionRef) return
    const reply = await action({ kind: 'openNative', submissionId: run.id })
    const navigation = reply.navigation
    if (!navigation?.success || !navigation.url) return
    const pane = usePaneStore.getState()
    pane.openDshWebInPane(pane.layout.activePaneId, { kind: 'dshWeb', url: navigation.url,
      name: text('原生 Harness 工作台', 'Native Harness workbench'), cwd: run.frozenDefinition.workspace, detail: true })
    const identity = run.observation?.identity
    if (!identity) return
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      const progress = await window.electronAPI.workbenchActivityNavigate({ kind: 'navigation', identity,
        sessionId: run.nativeExecutionRef.sessionId, requestId: navigation.requestId })
      if (!progress.success || progress.navigation === 'failed') { setLocalError(text('会话定位失败，请核对原生工作台。', 'Session navigation failed. Check the native workbench.')); return }
      if (progress.navigation === 'navigated') return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    setLocalError(text('定位确认超时，请核对原生工作台。', 'Navigation confirmation timed out. Check the native workbench.'))
  }
  const update = (value: Partial<TaskDefinition>) => setEditing(current => current ? { ...current, definition: { ...current.definition, ...value } } : current)
  const definition = editing?.definition
  const performance = definition?.performance
  const updateMetric = (index: number, value: Partial<PerformanceMetric>) => {
    if (performance) update({ performance: { ...performance, metrics: performance.metrics.map((item, i) => i === index ? { ...item, ...value } : item) } })
  }
  const updatePerformance = (value: Partial<NonNullable<TaskDefinition['performance']>>) => {
    if (performance) update({ performance: { ...performance, ...value } })
  }
  const choose = (item: TaskEntry) => { setSelectedId(item.id); setRunId(''); setContent(null); setNote(''); setLocalError('') }
  if (!window.electronAPI?.taskWorkbenchRequest) return null
  return <section className="task-workbench" aria-label={text('任务工作台', 'Task workbench')}>
    <header className="task-workbench-heading">
      <button className="task-workbench-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? 'm3 5 5 5 5-5' : 'm5 3 5 5-5 5'} /></svg>
        <strong>{text('任务工作台', 'Task workbench')}</strong><span>{waiting ? text(`${waiting} 项等待`, `${waiting} queued`) : text(`${entries.length} 个目标`, `${entries.length} goals`)}</span>
      </button>
      <button disabled={blocked} onClick={() => { setExpanded(true); setEditing({ definition: blank(workspace) }); setContent(null) }}>{text('新建', 'New')}</button>
    </header>
    {expanded && <>
      <div className="task-workbench-queue">
        <span role="status">{snapshot?.queueEnabled ? text('派发中', 'Dispatching') : text('派发已暂停', 'Dispatch paused')} · {active}/{snapshot?.maxActive ?? 2}</span>
        <button disabled={blocked} onClick={() => void action({ kind: 'setQueueEnabled', enabled: !snapshot?.queueEnabled, operationId: operation() })}>{snapshot?.queueEnabled ? text('暂停派发', 'Pause queue') : text('恢复队列', 'Resume queue')}</button>
        <label>{text('并发', 'Limit')}<select aria-label={text('最大并发任务', 'Maximum active tasks')} disabled={blocked} value={snapshot?.maxActive ?? 2} onChange={event => void action({ kind: 'setQueueEnabled', enabled: snapshot?.queueEnabled ?? false, maxActive: Number(event.target.value), operationId: operation() })}>{[1, 2, 3, 4, 5, 6, 7, 8].map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <p className="task-workbench-hint">{text('仅控制本工作台创建的任务。重启后需恢复队列；原执行不会重发。', 'Controls tasks created here. Resume the queue after restart; existing executions are never resent.')}</p>
      {(store.error || snapshot?.storageError || localError || !!store.pending && !store.busy) && <div role="alert" className="task-workbench-error">{localError || store.error || snapshot?.storageError}{store.pending && <><p>{text('上次操作回执未确认，请沿用原操作核对。', 'The previous receipt is unconfirmed. Check using the original operation.')}</p><button disabled={store.busy} onClick={() => void store.retry()}>{text('核对上次操作', 'Check previous operation')}</button></>}</div>}
      {!snapshot && <p role="status">{store.error ? text('无法读取任务记录。', 'Task records are unavailable.') : text('正在读取任务记录…', 'Reading task records…')}</p>}
      {definition && <form className="task-workbench-form" onSubmit={event => void save(event)}>
        <h3>{editing.entryId ? text('编辑目标', 'Edit goal') : text('新建任务', 'New task')}</h3>
        <label>{text('名称', 'Name')}<input required maxLength={200} value={definition.title} onChange={event => update({ title: event.target.value })} /></label>
        <label>{text('工作目录', 'Workspace')}<input required maxLength={2048} placeholder={text('已存在的绝对目录', 'Existing absolute directory')} value={definition.workspace} onChange={event => update({ workspace: event.target.value })} /></label>
        <label>{text('任务目标', 'Goal')}<textarea required maxLength={12000} rows={3} value={definition.goal} onChange={event => update({ goal: event.target.value })} /></label>
        <label>{text('任务模板', 'Template')}<select value={definition.templateId} onChange={event => update(event.target.value === 'general' ? { templateId: 'general', performance: undefined } : { templateId: 'component-performance', performance: { component: '', baselineVersion: '', currentVersion: '', environment: '', workload: '', metrics: [metric()] } })}><option value="general">{text('通用任务', 'General task')}</option><option value="component-performance">{text('组件性能 · 分析已有结果', 'Component performance · analyze existing results')}</option></select></label>
        {performance && <fieldset><legend>{text('固定性能输入 · 用户提供的数据', 'Frozen performance inputs · user-provided data')}</legend>
          {(['component', 'baselineVersion', 'currentVersion', 'environment', 'workload'] as const).map((key, index) => <label key={key}>{[text('组件', 'Component'), text('基线版本', 'Baseline version'), text('当前版本', 'Current version'), text('相同环境', 'Shared environment'), text('相同工作负载', 'Shared workload')][index]}<input required maxLength={key === 'environment' || key === 'workload' ? 1000 : 200} value={performance[key]} onChange={event => updatePerformance({ [key]: event.target.value })} /></label>)}
          {performance.metrics.map((item, index) => <fieldset className="task-workbench-metric" key={index}><legend>{text(`指标 ${index + 1}`, `Metric ${index + 1}`)}</legend>
            <label>{text('指标名称', 'Metric name')}<input required maxLength={128} value={item.name} onChange={event => updateMetric(index, { name: event.target.value })}/></label>
            <label>{text('单位', 'Unit')}<input required maxLength={64} value={item.unit} onChange={event => updateMetric(index, { unit: event.target.value })}/></label>
            <label>{text('基线数值', 'Baseline value')}<input type="number" required min="0" step="any" value={item.baseline} onChange={event => updateMetric(index, { baseline: event.target.valueAsNumber })}/></label>
            <label>{text('当前数值', 'Current value')}<input type="number" required min="0" step="any" value={item.current} onChange={event => updateMetric(index, { current: event.target.valueAsNumber })}/></label>
            <label>{text('样本数', 'Samples')}<input type="number" required min="1" max="1000000000" step="1" value={item.samples} onChange={event => updateMetric(index, { samples: event.target.valueAsNumber })}/></label>
            <label>{text('回退阈值 %', 'Regression threshold %')}<input type="number" required min="0" max="10000" step="any" value={item.thresholdPercent} onChange={event => updateMetric(index, { thresholdPercent: event.target.valueAsNumber })}/></label>
            <label>{text('改善方向', 'Improvement direction')}<select value={item.direction} onChange={event => updateMetric(index, { direction: event.target.value as 'higher' | 'lower' })}><option value="lower">{text('越低越好', 'Lower is better')}</option><option value="higher">{text('越高越好', 'Higher is better')}</option></select></label>
            {performance.metrics.length > 1 && <button type="button" onClick={() => updatePerformance({ metrics: performance.metrics.filter((_, i) => i !== index) })}>{text('移除此指标', 'Remove metric')}</button>}
          </fieldset>)}
          <button type="button" disabled={performance.metrics.length >= 100} onClick={() => updatePerformance({ metrics: [...performance.metrics, metric()] })}>{text('添加指标', 'Add metric')}</button>
        </fieldset>}
        <label>{text('补充完成条件（可选）', 'Additional acceptance criteria (optional)')}<textarea maxLength={8000} rows={2} value={definition.acceptanceCriteria} onChange={event => update({ acceptanceCriteria: event.target.value })}/></label>
        <label>{text('独占资源 ID（每行一个，可留空）', 'Exclusive resource IDs (one per line, optional)')}<textarea rows={2} maxLength={2064} value={definition.resourceIds.join('\n')} onChange={event => update({ resourceIds: event.target.value.split('\n') })}/></label>
        <label>{text('审批策略', 'Approval policy')}<select value={definition.approvalPolicy} onChange={event => update({ approvalPolicy: event.target.value as TaskDefinition['approvalPolicy'] })}><option value="auto-allow">{text('全部默认通过', 'Allow all by default')}</option><option value="manual">{text('逐项人工审批', 'Review each request')}</option></select></label>
        <p className="task-workbench-hint">{text('策略固定到每次运行。全部默认通过仅适用于本次新执行的有效请求；重启后的旧审批仍需核对。', 'The policy is frozen for each run. Auto-allow applies to valid requests from this new execution; old approvals require review after restart.')}</p>
        <div className="task-workbench-actions"><button type="submit" disabled={blocked}>{text('保存任务', 'Save task')}</button><button type="button" disabled={store.busy} onClick={() => setEditing(null)}>{text('取消编辑', 'Cancel edit')}</button></div>
      </form>}
      {!editing && entries.length > 0 && <>
        <label className="task-workbench-select">{text('任务目标', 'Task goal')}<select value={entry?.id ?? ''} onChange={event => { const selected = entries.find(item => item.id === event.target.value); if (selected) choose(selected) }}>{entries.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {entry && <><h3>{entry.title}</h3><p>{entry.goal}</p><p className="task-workbench-hint">{entry.workspace}</p>
          <div className="task-workbench-actions"><button disabled={blocked} onClick={() => { setRunId(''); void action({ kind: 'start', entryId: entry.id, expectedRevision: entry.revision, operationId: operation() }) }}>{submissions.length ? text('再次运行并排队', 'Run again and queue') : text('创建并排队', 'Create and queue')}</button><button disabled={blocked} onClick={() => setEditing({ entryId: entry.id, revision: entry.revision, definition: { title: entry.title, goal: entry.goal, workspace: entry.workspace, templateId: entry.templateId, acceptanceCriteria: entry.acceptanceCriteria, resourceIds: [...entry.resourceIds], approvalPolicy: entry.approvalPolicy, ...(entry.performance ? { performance: structuredClone(entry.performance) } : {}) } })}>{text('编辑草稿', 'Edit draft')}</button></div>
        </>}
        {run && <div className="task-workbench-run">
          <label>{text('运行历史', 'Run history')}<select value={run.id} onChange={event => { setRunId(event.target.value); setContent(null); setNote('') }}>{submissions.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {labeledState(item)}</option>)}</select></label>
          <p role="status" className="task-workbench-run-state">{labeledState(run)}</p>
          {(run.handoffState === 'waiting' || run.resumeIntent?.state === 'waiting') && <p className="task-workbench-hint">{waitingDescription(run)}</p>}
          {run.error && <p className="task-workbench-error">{run.error}</p>}
          <dl><div><dt>{text('冻结版本', 'Frozen revision')}</dt><dd>{run.taskRevision}</dd></div><div><dt>{text('审批', 'Approvals')}</dt><dd>{run.frozenDefinition.approvalPolicy === 'auto-allow' ? text('全部默认通过', 'Allow all by default') : text('逐项审批', 'Manual')}</dd></div><div><dt>{text('验收', 'Acceptance')}</dt><dd>{result ? ({ pending: text('待检查', 'Pending'), passed: text('通过', 'Passed'), failed: text('未通过', 'Failed'), 'needs-human': text('需人工确认', 'Needs review') })[result.decision] : text('待检查', 'Pending')}</dd></div></dl>
          {result && <p className="task-workbench-outcome">{({ normal: text('业务结论：未发现性能回退', 'Outcome: no performance regression'), regression: text('业务结论：发现性能回退', 'Outcome: performance regression'), 'not-comparable': text('业务结论：数据不可比', 'Outcome: data is not comparable'), 'not-evaluated': text('业务结论：未评估', 'Outcome: not evaluated') })[result.businessOutcome]}</p>}
          <div className="task-workbench-actions">
            <button disabled={store.busy} onClick={() => void action({ kind: 'inspect', submissionId: run.id })}>{text('核对状态', 'Inspect state')}</button>
            {(run.handoffState === 'waiting' || run.resumeIntent?.state === 'waiting') && <button disabled={blocked} onClick={() => mutation('withdraw')}>{text('撤回等待', 'Withdraw')}</button>}
            {run.nativeExecutionRef && <><button disabled={store.busy} onClick={() => void openNative().catch(error => setLocalError((error as Error).message))}>{text('打开原生执行', 'Open execution')}</button>{run.slotHeld && <button disabled={store.busy} onClick={() => mutation('cancel')}>{text('请求停止', 'Request stop')}</button>}</>}
            <button disabled={blocked || !run.nativeExecutionRef} onClick={() => mutation('verify')}>{text('采集并验收', 'Collect and verify')}</button>
          </div>
          <details><summary>{text('固定输入与执行身份', 'Frozen inputs and execution identity')}</summary><p>{run.frozenDefinition.goal}</p><p>{run.frozenDefinition.acceptanceCriteria}</p><code>{run.frozenInputHash}</code>{run.nativeExecutionRef && <pre>{JSON.stringify(run.nativeExecutionRef, null, 2)}</pre>}</details>
          {result && <><ul className="task-workbench-checks">{result.checks.map((check, index) => <li key={index}><strong>{check.passed ? text('通过', 'Pass') : text('待处理', 'Needs attention')} · {check.name}</strong><span>{check.detail}</span></li>)}</ul><div className="task-workbench-artifacts">{result.artifacts.map(artifact => <div key={artifact.artifactId}><button disabled={store.busy} onClick={() => void action({ kind: 'readArtifact', artifactId: artifact.artifactId }).then(reply => { if (reply.ok) setContent({ name: artifact.name, text: reply.artifactContent ?? '' }) })}>{artifact.name}</button><span>{artifact.bytes.toLocaleString()} B</span><button disabled={store.busy} onClick={() => void action({ kind: 'exportArtifact', artifactId: artifact.artifactId })}>{text('导出', 'Export')}</button></div>)}</div></>}
          {content && <div className="task-workbench-artifact-preview"><strong>{content.name}</strong><button onClick={() => setContent(null)}>{text('关闭预览', 'Close preview')}</button><pre>{content.text}</pre></div>}
          <label>{text('人工说明 / 核对依据', 'Note / reconciliation evidence')}<textarea rows={3} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} /></label>
          <div className="task-workbench-actions"><button disabled={blocked || !note.trim()} onClick={() => void action({ kind: 'addNote', submissionId: run.id, text: note, operationId: operation() }).then(reply => { if (reply.ok) setNote('') })}>{text('保存说明', 'Save note')}</button>
            {run.resourcesHeld.length > 0 && <button disabled={blocked || !note.trim()} title={text('填写已确认资源空闲的核对依据', 'Record evidence that the resources are free')} onClick={() => void action({ kind: 'releaseResources', submissionId: run.id, text: note, operationId: operation() })}>{text('确认释放资源', 'Confirm resource release')}</button>}
            {run.nativeExecutionRef && (run.handoffState === 'unknown' || run.observation?.state === 'unconfirmed') && !run.resumeIntent && <button disabled={blocked || !note.trim()} onClick={() => void action({ kind: 'resume', submissionId: run.id, text: note, operationId: operation() })}>{text('核对并续接', 'Reconcile and resume')}</button>}
            {result?.decision === 'needs-human' && <button disabled={blocked || !note.trim()} onClick={() => void action({ kind: 'accept', submissionId: run.id, text: note, operationId: operation() })}>{text('确认验收', 'Accept results')}</button>}
          </div>
          {run.resourcesHeld.length > 0 && <p className="task-workbench-hint">{text('仍占用资源', 'Resources retained')}：{run.resourcesHeld.join(' · ')}</p>}
          {run.notes.length > 0 && <details><summary>{text('人工与审批记录', 'Notes and approval records')} ({run.notes.length})</summary>{run.notes.map(item => <p key={item.id}><time>{new Date(item.at).toLocaleString()}</time> · {item.text}</p>)}</details>}
        </div>}
      </>}
      {!editing && snapshot && !entries.length && <p className="task-workbench-empty">{text('新建一个目标，保存完成条件，再创建运行。等待任务可以撤回，运行结果可单独验收。', 'Create a goal, save its acceptance criteria, then queue a run. Withdraw waiting tasks and verify results separately.')}</p>}
      <details className="task-workbench-help"><summary>{text('故障恢复与支持范围', 'Recovery and supported scope')}</summary><p>{text('性能模板分析用户提供的数据，不启动测试。共享资源须有核对依据才能释放。恢复后端不会续跑任务。', 'The performance template analyzes user-provided data without running tests. Shared resources require release evidence. Backend recovery does not resume tasks.')}</p><button disabled={blocked} onClick={() => void action({ kind: 'recover' })}>{text('恢复 Harness 后端', 'Recover Harness backend')}</button><button disabled={store.busy} onClick={() => void store.refresh()}>{text('重读业务记录', 'Reload task records')}</button><button onClick={() => useWorkbenchActivity.getState().show(workspace || null)}>{text('查看原生会话与审批', 'View native sessions and approvals')}</button></details>
    </>}
  </section>
}
