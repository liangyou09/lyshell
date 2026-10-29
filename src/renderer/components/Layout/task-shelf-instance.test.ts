import { describe, expect, it } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import type { TaskShelfEntry } from '@shared/task-shelf'
import { resolveShelfInstanceStatus } from './task-shelf-instance'

const terminal: TaskShelfEntry = { id: 'a', resourceKey: 'terminal:t', title: 'CLI', createdAt: 1, updatedAt: 1, revision: 1, capability: 'local-live', recovery: { kind: 'terminal', type: ConnectionType.LOCAL, sessionId: 't' } }

describe('任务方块的实例存活状态', () => {
  it('归档归属不改变原终端存活；没有绑定只表示记录', () => {
    const entry = { ...terminal, archivedAt: 10 }
    expect(resolveShelfInstanceStatus({ entry, binding: { kind: 'terminal', id: 't' }, terminalStatus: ConnectionStatus.CONNECTED, taskStatus: 'unknown' })).toBe('live')
    expect(resolveShelfInstanceStatus({ entry, taskStatus: 'unknown' })).toBe('saved')
  })
  it('断开、连接错误和恢复中的实例不会误标为存活', () => {
    for (const [terminalStatus, expected] of [[ConnectionStatus.DISCONNECTED, 'disconnected'], [ConnectionStatus.ERROR, 'error'], [ConnectionStatus.CONNECTING, 'connecting'], [ConnectionStatus.RECONNECTING, 'connecting']] as const) {
      expect(resolveShelfInstanceStatus({ entry: terminal, binding: { kind: 'terminal', id: 't' }, terminalStatus, taskStatus: 'running' })).toBe(expected)
    }
    expect(resolveShelfInstanceStatus({ entry: terminal, binding: { kind: 'terminal', id: 'other' }, terminalStatus: ConnectionStatus.CONNECTED, taskStatus: 'unknown' })).toBe('unknown')
  })
  it('网页只依据运行时报告，绑定与保留的配置本身不证明存活', () => {
    const entry: TaskShelfEntry = { ...terminal, recovery: { kind: 'web', url: 'https://example.org' } }
    for (const [browserState, expected] of [['live', 'live'], ['sleeping', 'sleeping'], ['suspending', 'suspending'], ['restoring', 'restoring'], ['closed', 'saved'], ['metadataOnly', 'saved'], [undefined, 'unknown']] as const) {
      expect(resolveShelfInstanceStatus({ entry, binding: { kind: 'web', id: 'w' }, browserState, taskStatus: 'unknown', hostPresent: true })).toBe(expected)
    }
  })
  it('后台任务仍在执行时可存活；历史完成记录或仅打开工作台不推断执行', () => {
    const entry: TaskShelfEntry = { ...terminal, recovery: { kind: 'harness', sessionId: 'h' } }
    expect(resolveShelfInstanceStatus({ entry, taskStatus: 'running' })).toBe('live')
    expect(resolveShelfInstanceStatus({ entry, taskStatus: 'completed' })).toBe('saved')
    expect(resolveShelfInstanceStatus({ entry, binding: { kind: 'harness', id: 'view' }, taskStatus: 'unknown', hostPresent: true })).toBe('open')
  })
})
