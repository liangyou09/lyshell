import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskShelfEntry } from '@shared/task-shelf'
import type { ShelfTaskStatus } from './task-shelf-status'
import { resolveShelfInstanceStatus } from './task-shelf-instance'
import { TaskStatusLight } from './TaskStatusLight'

export function TaskTileStatusLight({ entry, binding, terminalStatus, hostPresent, taskStatus, visible, now }: {
  entry: TaskShelfEntry
  binding?: { kind: string; id: string }
  terminalStatus?: string
  hostPresent: boolean
  taskStatus: ShelfTaskStatus
  visible: boolean
  now: number
}) {
  const { t } = useTranslation()
  const key = `${entry.id}:${binding?.id ?? ''}`
  const [browser, setBrowser] = useState<{ key: string; state?: string; at: number }>()
  useEffect(() => {
    if (!visible || binding?.kind !== 'web' || !window.electronAPI?.shelfBrowserRequest) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const inspect = async () => {
      try {
        const result = await window.electronAPI.shelfBrowserRequest({ kind: 'inspect', resourceId: `saved:${entry.id}` })
        if (!disposed) setBrowser({ key, state: result.success ? result.state : undefined, at: Date.now() })
      } catch { if (!disposed) setBrowser({ key, at: Date.now() }) }
      if (!disposed) timer = setTimeout(() => { void inspect() }, 4000)
    }
    void inspect()
    return () => { disposed = true; clearTimeout(timer) }
  }, [visible, binding?.kind, entry.id, key])
  const browserState = browser?.key === key && Math.max(now, Date.now()) - browser.at < 8000 ? browser.state : undefined
  const status = resolveShelfInstanceStatus({ entry, binding, terminalStatus, browserState, hostPresent, taskStatus })
  const label = [entry.archivedAt ? t('taskShelf.archivedBadge') : t('taskShelf.activeTasks'), t(`taskShelf.instanceStatus.${status}`), t(`taskShelf.activityStatus.${taskStatus}`)].join(' · ')
  return <TaskStatusLight status={taskStatus} instanceStatus={status} label={label} />
}
