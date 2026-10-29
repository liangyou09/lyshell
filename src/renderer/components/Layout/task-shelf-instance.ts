import { ConnectionStatus } from '@shared/types'
import type { TaskShelfEntry } from '@shared/task-shelf'
import type { ShelfTaskStatus } from './task-shelf-status'

export type ShelfInstanceStatus = 'live' | 'saved' | 'disconnected' | 'error' | 'connecting' | 'sleeping' | 'suspending' | 'restoring' | 'open' | 'unknown'

/** 归档归属由 archivedAt 独立表达；这里仅判断原实例，绝不把归档等同于已停止。 */
export function resolveShelfInstanceStatus({ entry, binding, terminalStatus, browserState, hostPresent, taskStatus }: {
  entry: TaskShelfEntry
  binding?: { kind: string; id: string }
  terminalStatus?: string
  browserState?: string
  hostPresent?: boolean
  taskStatus: ShelfTaskStatus
}): ShelfInstanceStatus {
  if (!binding) {
    return entry.recovery.kind === 'harness' && ['accepted', 'running', 'approval'].includes(taskStatus) ? 'live' : 'saved'
  }
  if (binding.kind !== entry.recovery.kind) return 'unknown'
  if (entry.recovery.kind === 'terminal') {
    if (binding.id !== entry.recovery.sessionId) return 'unknown'
    if (terminalStatus === ConnectionStatus.CONNECTED) return 'live'
    if (terminalStatus === ConnectionStatus.DISCONNECTED) return 'disconnected'
    if (terminalStatus === ConnectionStatus.ERROR) return 'error'
    if (terminalStatus === ConnectionStatus.CONNECTING || terminalStatus === ConnectionStatus.RECONNECTING) return 'connecting'
    return 'unknown'
  }
  if (entry.recovery.kind === 'web') {
    if (browserState === 'live') return 'live'
    if (browserState === 'sleeping') return 'sleeping'
    if (browserState === 'suspending') return 'suspending'
    if (browserState === 'restoring') return 'restoring'
    if (browserState === 'metadataOnly' || browserState === 'closed') return 'saved'
    return 'unknown'
  }
  if (['accepted', 'running', 'approval'].includes(taskStatus)) return 'live'
  return hostPresent ? 'open' : 'saved'
}
