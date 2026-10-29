import { useTranslation } from 'react-i18next'
import type { ShelfTaskStatus } from './task-shelf-status'
import type { ShelfInstanceStatus } from './task-shelf-instance'
import './TaskStatusLight.css'

/** 任务方块、小窗和会话列表共用；灯色、填充和可访问名称同步更新。 */
export function TaskStatusLight({ status, label, showLabel = false, className = '', instanceStatus }: {
  status: ShelfTaskStatus
  label?: string
  showLabel?: boolean
  className?: string
  instanceStatus?: ShelfInstanceStatus
}) {
  const { t } = useTranslation()
  const description = label || t(`taskShelf.activityStatus.${status}`)
  return <span className={`task-status-indicator ${className}`.trim()} data-task-status={status} data-instance-status={instanceStatus} role="img" aria-label={description} title={description}>
    <span className="task-status-light" aria-hidden="true" />
    {showLabel && <span className="task-status-label">{t(`taskShelf.statusShort.${status}`)}</span>}
  </span>
}

const LEGEND_STATES: ShelfTaskStatus[] = ['accepted', 'running', 'idle', 'approval', 'turnEnded', 'completed', 'failed', 'connectionError', 'interrupted', 'disconnected', 'unknown']

export function TaskStatusLegend() {
  const { t } = useTranslation()
  return <div className="task-status-legend" role="group" aria-label={t('taskShelf.statusLights')}>
    <span className="task-status-indicator"><TaskStatusLight status="unknown" instanceStatus="live" label={t('taskShelf.instanceHint.live')} /><span className="task-status-label">{t('taskShelf.instanceStatus.live')}</span></span>
    {LEGEND_STATES.map(status => <TaskStatusLight key={status} status={status} showLabel />)}
  </div>
}
