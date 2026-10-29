// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { HarnessWebActivitySession, HarnessWebActivitySnapshot } from '@shared/harness-web-activity'
import type { ShelfRecovery, TaskShelfEntry } from '@shared/task-shelf'
import type { TuiActivitySession, TuiActivitySnapshot, TuiActivityState } from '@shared/tui-activity'
import type { WorkbenchActivitySession, WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import {
  resolveNativeTaskStatus, resolveShelfTaskStatus, resolveTerminalTaskStatus, resolveWebTaskStatus,
  type ShelfTaskStatus
} from './task-shelf-status'

const NOW = 1_700_000_000_000
const FRESH_MS = 12000
const IDENTITY = { instanceId: 'backend-a', instanceEpoch: 1 }
const OTHER_IDENTITY = { instanceId: 'backend-b', instanceEpoch: 1 }
const TERMINAL_BINDING = { kind: 'terminal', id: 't-a' }

type HarnessRecovery = Extract<ShelfRecovery, { kind: 'harness' }>

function terminalEntry(overrides: Partial<TaskShelfEntry> = {}): TaskShelfEntry {
  return {
    id: 'entry-terminal', resourceKey: 'terminal:t-a', title: 'Shell', createdAt: NOW, updatedAt: NOW, revision: 1,
    recovery: { kind: 'terminal', sessionId: 't-a', type: ConnectionType.LOCAL },
    capability: 'live-only',
    ...overrides
  }
}

function harnessEntry(recovery: Partial<HarnessRecovery> = {}, overrides: Partial<TaskShelfEntry> = {}): TaskShelfEntry {
  return {
    id: 'entry-harness', resourceKey: 'harness:h', title: 'DeepSeek', createdAt: NOW, updatedAt: NOW, revision: 1,
    recovery: { kind: 'harness', sessionId: 'session-a', identity: IDENTITY, ...recovery },
    capability: 'harness-history',
    ...overrides
  }
}

function webEntry(): TaskShelfEntry {
  return {
    id: 'entry-web', resourceKey: 'web:w-a', title: 'Docs', createdAt: NOW, updatedAt: NOW, revision: 1,
    recovery: { kind: 'web', url: 'https://example.com' }, capability: 'web'
  }
}

function tuiRow(overrides: Partial<TuiActivitySession> = {}): TuiActivitySession {
  return {
    terminalId: 't-a', launchId: 'launch-a', source: 'codex', workspace: 'C:/ws', cliSessionId: 'cli-a',
    turnId: 'turn-a', state: 'running', updatedAt: NOW, event: 'UserPromptSubmit', active: true,
    ...overrides
  }
}

function tuiSnapshot(rows: TuiActivitySession[] = [tuiRow()], observedAt = NOW): TuiActivitySnapshot {
  return { observedAt, revision: 1, sessions: rows, events: [] }
}

/** 默认离线：终端状态只来自 TUI 行，避免把连接状态混进任务判断。 */
function activity(
  tui?: TuiActivitySnapshot,
  overrides: Partial<WorkbenchActivitySnapshot> = {}
): WorkbenchActivitySnapshot {
  return {
    observedAt: NOW, connection: 'offline', identity: null, sessions: [],
    ...(tui ? { tui } : {}),
    ...overrides
  }
}

function nativeRow(overrides: Partial<WorkbenchActivitySession> = {}): WorkbenchActivitySession {
  return {
    key: 'row-a', sessionId: 'session-a', workspace: 'C:/ws', taskId: 'task-a', taskState: 'running',
    source: 'native-harness', updatedAt: NOW, stale: false, approvals: [],
    ...overrides
  }
}

function nativeSnapshot(
  sessions: WorkbenchActivitySession[],
  overrides: Partial<WorkbenchActivitySnapshot> = {}
): WorkbenchActivitySnapshot {
  return { observedAt: NOW, connection: 'connected', identity: IDENTITY, sessions, ...overrides }
}

function webRow(overrides: Partial<HarnessWebActivitySession> = {}): HarnessWebActivitySession {
  return {
    sessionId: 'session-a', workspace: 'C:/ws', turnId: 'turn-a', state: 'running', updatedAt: NOW, approvalIds: [],
    ...overrides
  }
}

function webSnapshot(
  sessions: HarnessWebActivitySession[],
  overrides: Partial<HarnessWebActivitySnapshot> = {}
): HarnessWebActivitySnapshot {
  return { observedAt: NOW, connection: 'connected', identity: IDENTITY, revision: 1, sessions, events: [], ...overrides }
}

describe('保存区终端任务状态', () => {
  it('连接错误只表达连接异常，断开/关闭只表达断线，均不借用 TUI 的运行态', () => {
    const snapshot = activity(tuiSnapshot([tuiRow({ state: 'running', active: true })]))
    // 连接异常的任务结果未知，不能冒充任务失败。
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, ConnectionStatus.ERROR, NOW)).toBe('connectionError')
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, ConnectionStatus.DISCONNECTED, NOW)).toBe('disconnected')
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, 'closed', NOW)).toBe('disconnected')
  })

  it('连接在线不推断运行，也不从输出静默推断空闲', () => {
    const connected = activity(tuiSnapshot([]), { connection: 'connected', identity: IDENTITY })
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, connected, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, activity(), ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, activity(), ConnectionStatus.CONNECTING, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, activity(), ConnectionStatus.RECONNECTING, NOW)).toBe('unknown')
    // 空闲只能来自官方 CLI 事件，连接正常但没有 TUI 行时保持未知。
    const idleOnly = activity(tuiSnapshot([tuiRow({ state: 'idle' })]), { connection: 'connected', identity: IDENTITY })
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, idleOnly, ConnectionStatus.CONNECTED, NOW)).toBe('idle')
  })

  it('新鲜且活跃的 TUI 行提供完整状态映射', () => {
    const cases: Array<[TuiActivityState, ShelfTaskStatus]> = [
      ['idle', 'idle'],
      ['running', 'running'],
      ['waiting-approval', 'approval'],
      ['turn-ended', 'turnEnded'],
      ['failed', 'failed'],
      ['interrupted', 'interrupted'],
      ['unknown', 'unknown'],
      ['session-ended', 'unknown']
    ]
    for (const [state, expected] of cases) {
      const snapshot = activity(tuiSnapshot([tuiRow({ state })]))
      expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, ConnectionStatus.CONNECTED, NOW)).toBe(expected)
    }
  })

  it('失活的历史行不提供当前状态', () => {
    const snapshot = activity(tuiSnapshot([tuiRow({ state: 'waiting-approval', active: false })]))
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
  })

  it('绑定不匹配、缺失绑定或绑定类型不符时返回未知', () => {
    const snapshot = activity(tuiSnapshot([tuiRow()]))
    expect(resolveShelfTaskStatus(terminalEntry(), { kind: 'terminal', id: 't-other' }, snapshot, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    // 别的终端会话的连接错误也不能记到这条条目上。
    expect(resolveShelfTaskStatus(terminalEntry(), { kind: 'terminal', id: 't-other' }, snapshot, ConnectionStatus.ERROR, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(terminalEntry(), undefined, snapshot, undefined, NOW)).toBe('unknown')
    // 没有绑定就没有权威连接来源；即便调用方传入错误状态也不假装知道。
    expect(resolveShelfTaskStatus(terminalEntry(), undefined, snapshot, ConnectionStatus.ERROR, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(terminalEntry(), { kind: 'harness', id: 't-a' }, snapshot, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
  })

  it('过期、未来时钟或边界上的 TUI 快照不可用', () => {
    const staleAt = NOW - FRESH_MS
    for (const observedAt of [staleAt, NOW - FRESH_MS - 1, NOW + 1]) {
      const snapshot = activity(tuiSnapshot([tuiRow({ state: 'running' })], observedAt))
      expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    }
  })

  it('默认使用当前时间判定新鲜度', () => {
    const snapshot = activity(tuiSnapshot([tuiRow()], Date.now()))
    expect(resolveShelfTaskStatus(terminalEntry(), TERMINAL_BINDING, snapshot, ConnectionStatus.CONNECTED)).toBe('running')
  })
})

describe('保存区 Harness 原生任务状态', () => {
  it('原生任务行映射已接收、运行、完成、失败与中断', () => {
    const cases: Array<[WorkbenchActivitySession['taskState'], ShelfTaskStatus]> = [
      // accepted 只是官方已接收，还没有运行证据，不能伪装成 running。
      ['accepted', 'accepted'],
      ['running', 'running'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'interrupted'],
      ['unconfirmed', 'unknown'],
      ['unknown', 'unknown']
    ]
    for (const [taskState, expected] of cases) {
      const snapshot = nativeSnapshot([nativeRow({ taskState })])
      expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, snapshot, undefined, NOW)).toBe(expected)
    }
  })

  it('待审批优先于任务阶段', () => {
    const snapshot = nativeSnapshot([nativeRow({
      taskState: 'running',
      approvals: [{ id: 'approval-a', toolName: 'shell', reason: '', options: ['allowed-once', 'rejected'], askedAt: NOW }]
    })])
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, snapshot, undefined, NOW)).toBe('approval')
  })

  it('过期、离线或未来时钟的原生快照不提供状态', () => {
    for (const overrides of [
      { connection: 'offline' as const },
      { connection: 'stale' as const },
      { observedAt: NOW - FRESH_MS },
      { observedAt: NOW - FRESH_MS - 1 },
      { observedAt: NOW + 1 },
      { identity: null }
    ]) {
      const snapshot = nativeSnapshot([nativeRow({ taskState: 'completed' })], overrides)
      expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, snapshot, undefined, NOW)).toBe('unknown')
    }
  })

  it('后台身份不匹配或缺失身份均返回未知', () => {
    const snapshot = nativeSnapshot([nativeRow({ taskState: 'completed' })])
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', identity: OTHER_IDENTITY }), undefined, snapshot, undefined, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', identity: undefined }), undefined, snapshot, undefined, NOW)).toBe('unknown')
    const otherSnapshot = nativeSnapshot([nativeRow({ taskState: 'completed' })], { identity: OTHER_IDENTITY })
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, otherSnapshot, undefined, NOW)).toBe('unknown')
  })

  it('会话、任务或行新鲜度不匹配时返回未知', () => {
    const completed = nativeSnapshot([nativeRow({ taskState: 'completed' })])
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', sessionId: 'session-b' }), undefined, completed, undefined, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-b' }), undefined, completed, undefined, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, nativeSnapshot([nativeRow({ stale: true })]), undefined, NOW)).toBe('unknown')
    // 条目没有 taskId 时只按会话匹配当前视图。
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: undefined }), undefined, completed, undefined, NOW)).toBe('completed')
  })

  it('同一会话多行时优先待审批，其次取最新更新', () => {
    const older = nativeRow({ taskId: 'task-old', taskState: 'running', updatedAt: NOW - 10 })
    const latest = nativeRow({ taskId: 'task-new', taskState: 'failed', updatedAt: NOW })
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: undefined }), undefined, nativeSnapshot([older, latest]), undefined, NOW)).toBe('failed')
    const pending: WorkbenchActivitySession = { ...older, updatedAt: NOW - 20, approvals: [{ id: 'approval-a', toolName: 'shell', reason: '', options: ['allowed-once'], askedAt: NOW - 20 }] }
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: undefined }), undefined, nativeSnapshot([pending, latest]), undefined, NOW)).toBe('approval')
  })

  it('持久化的 lastState 不作为状态证据', () => {
    const offline = nativeSnapshot([], { connection: 'offline', identity: null })
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', lastState: 'completed' }), undefined, offline, undefined, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', lastState: 'completed' }), undefined, null, undefined, NOW)).toBe('unknown')
    const running = nativeSnapshot([nativeRow({ taskState: 'running' })])
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', lastState: 'completed' }), undefined, running, undefined, NOW)).toBe('running')
    const completed = nativeSnapshot([nativeRow({ taskState: 'completed' })])
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a', lastState: 'running' }), undefined, completed, undefined, NOW)).toBe('completed')
  })
})

describe('保存区 Harness 官方 Web 回合状态', () => {
  const offlineNative = (web: HarnessWebActivitySnapshot): WorkbenchActivitySnapshot =>
    activity(undefined, { connection: 'offline', identity: null, web })

  it('官方 Web 回合映射运行、审批、回合结束、失败与中断', () => {
    const cases: Array<[HarnessWebActivitySession['state'], ShelfTaskStatus]> = [
      ['running', 'running'],
      ['waiting-approval', 'approval'],
      ['turn-ended', 'turnEnded'],
      ['failed', 'failed'],
      ['interrupted', 'interrupted']
    ]
    for (const [state, expected] of cases) {
      const snapshot = offlineNative(webSnapshot([webRow({ state })]))
      expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'turn-a' }), undefined, snapshot, undefined, NOW)).toBe(expected)
    }
  })

  it('完成的原生视图与回合结束的 Web 视图区分开', () => {
    const nativeCompleted = nativeSnapshot([nativeRow({ taskState: 'completed' })])
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, nativeCompleted, undefined, NOW)).toBe('completed')
    const webEnded = offlineNative(webSnapshot([webRow({ state: 'turn-ended' })]))
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'turn-a' }), undefined, webEnded, undefined, NOW)).toBe('turnEnded')
  })

  it('新鲜的 Web 证据优先于原生视图', () => {
    const snapshot = nativeSnapshot([nativeRow({ taskId: 'turn-a', taskState: 'completed' })], {
      web: webSnapshot([webRow({ turnId: 'turn-a', state: 'running' })])
    })
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'turn-a' }), undefined, snapshot, undefined, NOW)).toBe('running')
  })

  it('Web 身份或新鲜度不符时回退到原生证据', () => {
    const otherIdentity = nativeSnapshot([nativeRow({ taskState: 'completed' })], {
      web: webSnapshot([webRow({ state: 'running' })], { identity: OTHER_IDENTITY })
    })
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, otherIdentity, undefined, NOW)).toBe('completed')

    for (const observedAt of [NOW - FRESH_MS, NOW + 1]) {
      const staleWeb = nativeSnapshot([nativeRow({ taskState: 'failed' })], {
        web: webSnapshot([webRow({ state: 'running' })], { observedAt })
      })
      expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'task-a' }), undefined, staleWeb, undefined, NOW)).toBe('failed')
    }
  })

  it('Web 回合不匹配时不冒充当前回合', () => {
    const snapshot = offlineNative(webSnapshot([webRow({ turnId: 'turn-b', state: 'running' })]))
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'turn-a' }), undefined, snapshot, undefined, NOW)).toBe('unknown')
    // 条目没有 taskId 时按会话匹配当前回合。
    expect(resolveShelfTaskStatus(harnessEntry({ taskId: undefined }), undefined, snapshot, undefined, NOW)).toBe('running')
  })

  it('Web 快照离线或无身份时不提供状态', () => {
    for (const overrides of [{ connection: 'offline' as const }, { connection: 'stale' as const }, { identity: null }]) {
      const snapshot = offlineNative(webSnapshot([webRow({ state: 'running' })], overrides))
      expect(resolveShelfTaskStatus(harnessEntry({ taskId: 'turn-a' }), undefined, snapshot, undefined, NOW)).toBe('unknown')
    }
  })
})

describe('终端任务状态接口', () => {
  it('新鲜快照中同一终端的活跃行给出映射结果', () => {
    const cases: Array<[TuiActivityState, ShelfTaskStatus]> = [
      ['idle', 'idle'],
      ['running', 'running'],
      ['waiting-approval', 'approval'],
      ['turn-ended', 'turnEnded'],
      ['failed', 'failed'],
      ['interrupted', 'interrupted'],
      ['unknown', 'unknown'],
      // 会话结束本身没有可信任务结果，不能当成完成或失败。
      ['session-ended', 'unknown']
    ]
    for (const [state, expected] of cases) {
      const snapshot = activity(tuiSnapshot([tuiRow({ state })]))
      expect(resolveTerminalTaskStatus('t-a', snapshot, ConnectionStatus.CONNECTED, NOW)).toBe(expected)
    }
    // 在线但没有任何 TUI 事件时仍然未知。
    expect(resolveTerminalTaskStatus('t-a', activity(tuiSnapshot([])), ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
  })

  it('连接异常/断开覆盖 TUI 旧事件，不沿用旧结论', () => {
    for (const staleState of ['completed', 'running', 'waiting-approval'] as TuiActivityState[]) {
      const snapshot = activity(tuiSnapshot([tuiRow({ state: staleState })]))
      expect(resolveTerminalTaskStatus('t-a', snapshot, ConnectionStatus.ERROR, NOW)).toBe('connectionError')
      expect(resolveTerminalTaskStatus('t-a', snapshot, ConnectionStatus.DISCONNECTED, NOW)).toBe('disconnected')
      expect(resolveTerminalTaskStatus('t-a', snapshot, 'closed', NOW)).toBe('disconnected')
    }
  })

  it('过期、未来时钟或没有快照时不提供状态', () => {
    for (const observedAt of [NOW - FRESH_MS, NOW - FRESH_MS - 1, NOW + 1]) {
      const snapshot = activity(tuiSnapshot([tuiRow({ state: 'running' })], observedAt))
      expect(resolveTerminalTaskStatus('t-a', snapshot, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    }
    expect(resolveTerminalTaskStatus('t-a', null, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    // 连接断开/异常不依赖快照，缺快照也照实说明。
    expect(resolveTerminalTaskStatus('t-a', null, ConnectionStatus.ERROR, NOW)).toBe('connectionError')
  })

  it('其他终端或已失活的旧审批行不是当前任务状态', () => {
    const otherTerminal = activity(tuiSnapshot([tuiRow({ terminalId: 't-b', state: 'waiting-approval' })]))
    expect(resolveTerminalTaskStatus('t-a', otherTerminal, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')

    const inactiveApproval = activity(tuiSnapshot([tuiRow({ state: 'waiting-approval', active: false })]))
    expect(resolveTerminalTaskStatus('t-a', inactiveApproval, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')

    // 同一终端残留的失活旧审批行不能压过当前活跃行。
    const mixed = activity(tuiSnapshot([
      tuiRow({ launchId: 'launch-old', state: 'waiting-approval', active: false }),
      tuiRow({ state: 'running' })
    ]))
    expect(resolveTerminalTaskStatus('t-a', mixed, ConnectionStatus.CONNECTED, NOW)).toBe('running')
  })

  it('默认使用当前时间判定新鲜度', () => {
    const snapshot = activity(tuiSnapshot([tuiRow()], Date.now()))
    expect(resolveTerminalTaskStatus('t-a', snapshot, ConnectionStatus.CONNECTED)).toBe('running')
  })
})

describe('原生任务状态接口', () => {
  const approval = (id = 'approval-a') => ({
    id, toolName: 'shell', reason: '', options: ['allowed-once' as const, 'rejected' as const], askedAt: NOW
  })

  it('按任务阶段映射，accepted 不冒充运行', () => {
    const cases: Array<[WorkbenchActivitySession['taskState'], ShelfTaskStatus]> = [
      ['accepted', 'accepted'],
      ['running', 'running'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'interrupted'],
      ['unconfirmed', 'unknown'],
      ['unknown', 'unknown']
    ]
    for (const [taskState, expected] of cases) {
      const row = nativeRow({ taskState })
      expect(resolveNativeTaskStatus(row, nativeSnapshot([row]), NOW)).toBe(expected)
    }
  })

  it('审批优先于任务阶段，包括已完成但仍有待处理审批的残留行', () => {
    const running = nativeRow({ taskState: 'running', approvals: [approval()] })
    expect(resolveNativeTaskStatus(running, nativeSnapshot([running]), NOW)).toBe('approval')
    const completed = nativeRow({ taskState: 'completed', approvals: [approval()] })
    expect(resolveNativeTaskStatus(completed, nativeSnapshot([completed]), NOW)).toBe('approval')
    const accepted = nativeRow({ taskState: 'accepted', approvals: [approval()] })
    expect(resolveNativeTaskStatus(accepted, nativeSnapshot([accepted]), NOW)).toBe('approval')
  })

  it('过期、未来时钟、离线或过期行都不提供状态', () => {
    const row = nativeRow({ taskState: 'completed' })
    for (const overrides of [
      { observedAt: NOW - FRESH_MS },
      { observedAt: NOW - FRESH_MS - 1 },
      { observedAt: NOW + 1 },
      { connection: 'offline' as const },
      { connection: 'stale' as const },
      { identity: null }
    ]) {
      expect(resolveNativeTaskStatus(row, nativeSnapshot([row], overrides), NOW)).toBe('unknown')
    }
    const stale = nativeRow({ taskState: 'completed', stale: true })
    expect(resolveNativeTaskStatus(stale, nativeSnapshot([stale]), NOW)).toBe('unknown')
    // 过期行即使带审批也不显示审批。
    const staleApproval = nativeRow({ taskState: 'running', stale: true, approvals: [approval()] })
    expect(resolveNativeTaskStatus(staleApproval, nativeSnapshot([staleApproval]), NOW)).toBe('unknown')
    expect(resolveNativeTaskStatus(row, null, NOW)).toBe('unknown')
  })

  it('默认使用当前时间判定新鲜度', () => {
    const row = nativeRow({ taskState: 'accepted' })
    expect(resolveNativeTaskStatus(row, nativeSnapshot([row], { observedAt: Date.now() }))).toBe('accepted')
  })
})

describe('官方 Web 回合状态接口', () => {
  it('按回合状态映射，回合结束只能是 turnEnded', () => {
    const cases: Array<[HarnessWebActivitySession['state'], ShelfTaskStatus]> = [
      ['running', 'running'],
      ['waiting-approval', 'approval'],
      ['turn-ended', 'turnEnded'],
      ['failed', 'failed'],
      ['interrupted', 'interrupted']
    ]
    for (const [state, expected] of cases) {
      const row = webRow({ state })
      expect(resolveWebTaskStatus(row, webSnapshot([row]), NOW)).toBe(expected)
    }
    // 回合结束不能升级成完成；原生 completed 与 Web turn-ended 必须区分。
    const ended = webRow({ state: 'turn-ended' })
    expect(resolveWebTaskStatus(ended, webSnapshot([ended]), NOW)).toBe('turnEnded')
    const completedNative = nativeRow({ taskState: 'completed' })
    expect(resolveNativeTaskStatus(completedNative, nativeSnapshot([completedNative]), NOW)).toBe('completed')
  })

  it('过期、未来时钟、离线或缺失快照时不提供状态', () => {
    const row = webRow({ state: 'running' })
    for (const overrides of [
      { observedAt: NOW - FRESH_MS },
      { observedAt: NOW - FRESH_MS - 1 },
      { observedAt: NOW + 1 },
      { connection: 'offline' as const },
      { connection: 'stale' as const },
      { identity: null }
    ]) {
      expect(resolveWebTaskStatus(row, webSnapshot([row], overrides), NOW)).toBe('unknown')
    }
    expect(resolveWebTaskStatus(row, undefined, NOW)).toBe('unknown')
  })

  it('默认使用当前时间判定新鲜度', () => {
    const row = webRow({ state: 'waiting-approval' })
    expect(resolveWebTaskStatus(row, webSnapshot([row], { observedAt: Date.now() }))).toBe('approval')
  })
})

describe('保存区其他条目与不变量', () => {
  it('普通网页条目没有任务来源，始终未知', () => {
    const snapshot = nativeSnapshot([nativeRow({ taskState: 'completed' })], { web: webSnapshot([webRow()]) })
    expect(resolveShelfTaskStatus(webEntry(), { kind: 'web', id: 'w-a' }, snapshot, ConnectionStatus.CONNECTED, NOW)).toBe('unknown')
    expect(resolveShelfTaskStatus(webEntry(), undefined, snapshot, undefined, NOW)).toBe('unknown')
  })

  it('不修改入参，重复调用结果一致', () => {
    const entry = harnessEntry({ taskId: 'turn-a' })
    const snapshot = nativeSnapshot([nativeRow({ taskId: 'turn-a', taskState: 'completed' })], { web: webSnapshot([webRow({ turnId: 'turn-a' })]) })
    const entryBefore = JSON.stringify(entry), snapshotBefore = JSON.stringify(snapshot)
    expect(resolveShelfTaskStatus(entry, undefined, snapshot, undefined, NOW)).toBe('running')
    expect(JSON.stringify(entry)).toBe(entryBefore)
    expect(JSON.stringify(snapshot)).toBe(snapshotBefore)
    expect(resolveShelfTaskStatus(entry, undefined, snapshot, undefined, NOW)).toBe('running')
  })
})
