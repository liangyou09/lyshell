// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'
import type { TaskShelfEntry, TaskShelfRequest } from '@shared/task-shelf'
import { createConnectionStatusHandler } from './connection-status'
import { beginShelfTerminalRestore, waitForShelfTerminalRestores } from './shelf-terminal-placement'
import { useSessionStore } from './session-store'
import { usePaneStore } from './pane-store'
import { useTaskShelf } from './task-shelf'

const config = (id: string): SessionConfig => ({ id, name: id, type: ConnectionType.LOCAL, local: {}, terminal: {} as SessionConfig['terminal'], tags: [], createdAt: new Date(), updatedAt: new Date() })
const entry: TaskShelfEntry = { id: 'saved', resourceKey: 'terminal:old', title: 'Saved shell', createdAt: 1, updatedAt: 1, revision: 1, capability: 'directory', recovery: { kind: 'terminal', sessionId: 'old', type: ConnectionType.LOCAL } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const releases: Array<() => void> = []
const hold = () => { const release = beginShelfTerminalRestore(); releases.push(release); return release }

beforeEach(() => {
  useSessionStore.setState({ sessions: [{ id: 'main', config: config('main'), status: ConnectionStatus.CONNECTED }], pendingSessionStatus: {} })
  usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'pane', sessions: ['main'], activeSessionId: 'main', overlays: [] }, activePaneId: 'pane' }, hiddenTabSessions: {}, retainedSessionIds: {}, overlayPayloads: {} })
  useTaskShelf.setState({ entries: [entry], bindings: {}, busy: {}, error: null, saveErrors: {}, restoreFailures: {} })
})
afterEach(() => { releases.splice(0).forEach(release => release()); vi.restoreAllMocks() })

describe('连接通知与侧栏恢复的落位顺序', () => {
  it.each([false, true])('恢复回执晚于 connected 时不出现主区帧（已有会话=%s）', async known => {
    if (known) useSessionStore.getState().addTemporarySession({ id: 'restored', config: config('restored'), status: ConnectionStatus.CONNECTING })
    const getSession = vi.fn(async (id: string) => config(id))
    const onStatus = createConnectionStatusHandler(new Map(), getSession)
    const exposed: boolean[] = []
    const unsubscribe = usePaneStore.subscribe(state => { exposed.push(state.getAllLeafPanes().some(pane => pane.sessions.includes('restored') && !state.hiddenTabSessions.restored)) })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      getSession,
      taskShelfRequest: async (request: TaskShelfRequest) => {
        if (request.kind === 'restore') {
          onStatus({ id: 'restored', status: ConnectionStatus.CONNECTED })
          await flush()
          expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('main')
          expect(usePaneStore.getState().getPaneBySessionId('restored')).toBeUndefined()
          return { success: true, entries: [entry], restored: { kind: 'terminal', sessionId: 'restored' } }
        }
        return { success: true, entries: [entry], entry }
      }
    } })
    try {
      expect(await useTaskShelf.getState().open('saved', undefined, true)).toBe(true)
      await flush()
      expect(usePaneStore.getState().getPaneBySessionId('restored')?.id).toBe('pane')
      expect(usePaneStore.getState().hiddenTabSessions.restored).toBe(true)
      expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('main')
      expect(exposed).not.toContain(true)
      expect(useTaskShelf.getState().bindings.saved).toEqual({ kind: 'terminal', id: 'restored' })
      expect(await useTaskShelf.getState().open('saved')).toBe(true)
      expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('restored')
    } finally { unsubscribe() }
  })
  it.each([false, true])('普通连接仍可自动打开到主区（已有会话=%s）', async known => {
    if (known) useSessionStore.getState().addTemporarySession({ id: 'normal', config: config('normal'), status: ConnectionStatus.CONNECTING })
    const onStatus = createConnectionStatusHandler(new Map(), async id => config(id))
    onStatus({ id: 'normal', status: ConnectionStatus.CONNECTED })
    await flush()
    expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('normal')
  })
  it('侧栏恢复期间的无关连接只延后落位，不会被收纳', async () => {
    const release = hold()
    const onStatus = createConnectionStatusHandler(new Map(), async id => config(id))
    onStatus({ id: 'normal', status: ConnectionStatus.CONNECTED })
    await flush()
    expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('main')
    release(); await flush()
    expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('normal')
    expect(usePaneStore.getState().hiddenTabSessions.normal).not.toBe(true)
  })
  it('恢复失败也释放落位等待，后续普通连接不会卡住', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: async () => { throw new Error('restore failed') } } })
    expect(await useTaskShelf.getState().open('saved', undefined, true)).toBe(false)
    const onStatus = createConnectionStatusHandler(new Map(), async id => config(id))
    onStatus({ id: 'normal', status: ConnectionStatus.CONNECTED })
    await flush()
    expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('normal')
  })
  it('读取配置期间关闭的会话不会被迟到回调重新打开', async () => {
    let resolve!: (config: SessionConfig) => void
    const onStatus = createConnectionStatusHandler(new Map(), () => new Promise<SessionConfig>(done => { resolve = done }))
    onStatus({ id: 'closed', status: ConnectionStatus.CONNECTING })
    onStatus({ id: 'closed', status: ConnectionStatus.DISCONNECTED })
    resolve(config('closed')); await flush()
    expect(usePaneStore.getState().getPaneBySessionId('closed')).toBeUndefined()
  })
  it('克隆流程的跳过自动落位标记继续有效', async () => {
    useSessionStore.getState().addTemporarySession({ id: 'clone', config: config('clone'), status: ConnectionStatus.CONNECTING, skipAutoAddToPane: true })
    createConnectionStatusHandler(new Map(), async id => config(id))({ id: 'clone', status: ConnectionStatus.CONNECTED })
    await flush()
    expect(usePaneStore.getState().getPaneBySessionId('clone')).toBeUndefined()
    expect(useSessionStore.getState().getSession('clone')?.skipAutoAddToPane).toBe(false)
  })
  it('通知只等待当时在途的恢复，不等待后续新任务', async () => {
    const first = hold()
    const waiting = waitForShelfTerminalRestores()
    hold()
    first()
    await waiting
  })
})
