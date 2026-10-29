import { createHash, randomBytes } from 'crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { HarnessWorkRequest } from '@shared/harness-work'

/** 稳定的是已鉴权 global 客户群的本地身份；它不是可用于 HTTP 鉴权的凭据。 */
export function persistentGlobalWorkOwner(userData: string): string {
  const file = join(userData, 'harness-work-owner')
  if (!existsSync(file)) {
    let fd: number | undefined
    try {
      fd = openSync(file, 'wx', 0o600)
      writeFileSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('journal/owner-unavailable') }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 64) throw new Error('journal/owner-unavailable')
  const value = readFileSync(file, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('journal/owner-unavailable')
  return createHash('sha256').update('lyshell-global-work\0').update(value).digest('hex')
}

interface SavedRecord {
  task: Record<string, unknown> & { taskId: string; sessionId: string; state: string; acceptedAt?: number; executionIdentity?: unknown }
  transcript: unknown[]; truncated: boolean
}
interface SavedState {
  sessionId: string | null; lastTask: SavedRecord | null
  tasks: Map<string, SavedRecord>
  sessions: Map<string, SavedSession>
}
interface SavedSession { sessionId: string; workspace: string; current: SavedRecord | null }
interface JournalModule { openWorkJournal: (dir: string) => unknown }
interface StateModule { loadNativeStates: (journal: unknown) => { states: Map<string, SavedState> } }

/** 离线只读取已有日志，不创建目录、不启动后台、不接管其他 owner 的历史。 */
export async function readSavedWorkState(
  userData: string, bridgeDirectory: string, owner: string, request: HarnessWorkRequest
): Promise<Record<string, unknown> | null> {
  const root = join(userData, 'harness-work')
  if (!existsSync(root)) return null
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('journal/unsafe-path')
  const names = readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name))
  if (names.length > 64) throw new Error('journal/too-large')
  const journalModule = await import(/* @vite-ignore */ pathToFileURL(join(bridgeDirectory, 'work-journal.mjs')).href) as JournalModule
  const stateModule = await import(/* @vite-ignore */ pathToFileURL(join(bridgeDirectory, 'work-state.mjs')).href) as StateModule
  const candidates: Array<{ row: SavedSession; record: SavedRecord | null; selected: boolean }> = []
  let exact: typeof candidates[number] | undefined
  for (const name of names) {
    const directory = join(root, name)
    if (!existsSync(join(directory, `${owner}.json`))) continue
    const state = stateModule.loadNativeStates(journalModule.openWorkJournal(directory)).states.get(owner)
    if (!state) continue
    for (const row of state.sessions.values()) candidates.push({ row, record: row.current, selected: state.sessionId === row.sessionId })
    if (request.kind === 'state' && (request.taskId !== undefined || request.sessionId !== undefined)) {
      const record = request.taskId ? state.tasks.get(request.taskId) : state.sessions.get(request.sessionId!)?.current
      const row = state.sessions.get(request.sessionId ?? record?.task.sessionId ?? '')
      if (!row || request.taskId && (!record || record.task.sessionId !== row.sessionId)) continue
      if (exact) throw new Error('journal/ambiguous-task')
      exact = { row, record: record ?? null, selected: state.sessionId === row.sessionId }
    }
  }
  if (!candidates.length) return null
  if (request.kind === 'state' && (request.taskId !== undefined || request.sessionId !== undefined) && !exact) {
    return { ok: false, code: 'task/not-found', error: 'Saved task does not belong to this caller' }
  }
  candidates.sort((a, b) => (b.record?.task.acceptedAt ?? 0) - (a.record?.task.acceptedAt ?? 0))
  const selected = candidates.find(candidate => candidate.selected)
  const target = exact ?? selected ?? candidates[0]
  const view = ({ row, record }: typeof target): Record<string, unknown> => ({
    sessionId: row.sessionId, workspace: row.workspace, taskId: record?.task.taskId ?? null,
    taskState: record?.task.state ?? null, task: record ? { ...record.task } : null,
    status: 'offline', stale: true, recoveryRequired: record?.task.recoveryRequired === true,
    approvals: [], transcript: record?.transcript ?? [], transcriptTruncated: record?.truncated ?? false
  })
  return { ok: true, ...view(target), identity: null, lastKnownIdentity: target.record?.task.executionIdentity ?? null,
    connection: 'offline', selectedSessionId: selected?.row.sessionId ?? null,
    ...(!exact && !selected ? { sessionId: null } : {}),
    sessions: candidates.map(view), activeTaskIds: candidates.filter(entry => entry.record &&
      !['completed', 'cancelled', 'failed'].includes(entry.record.task.state)).map(entry => entry.record!.task.taskId),
    recovery: 'Backend offline; saved progress retained. Recover backend, then inspect side effects before explicit resume.' }
}
