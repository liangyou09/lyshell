// @vitest-environment jsdom
/**
 * removeLiveSession 的清理范围测试（纯 store 逻辑，不渲染组件）：
 * 1) entry 存在：摘 entry、清 pending 暂存、activeSessionId 命中时置空
 * 2) entry 不存在但 pending 暂存仍在（早到 cwd/编码推送先于 entry 建立，
 *    真关闭先到）：暂存一并清掉，不留孤儿数据 —— 与 deleteSession 同款清理
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useSessionStore } from './session-store'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import type { SessionConfig } from '@shared/types'
import type { SessionState } from './session-store'

const sessionState = (id: string, overrides: Partial<SessionState> = {}): SessionState => ({
  id,
  config: {
    id,
    name: `remove-live-${id}`,
    type: ConnectionType.LOCAL,
    terminal: {
      fontFamily: 'Consolas', fontSize: 12, theme: {} as SessionConfig['terminal']['theme'],
      cursorStyle: 'bar', cursorBlink: false, scrollback: 10, encoding: 'utf-8'
    },
    tags: [], createdAt: new Date(), updatedAt: new Date()
  },
  status: ConnectionStatus.CONNECTED,
  ...overrides
})

beforeEach(() => {
  useSessionStore.setState({
    savedSessions: [],
    sessions: [],
    reachability: {},
    pendingRuntimeEncoding: {},
    pendingSessionCwd: {},
    activeSessionId: null
  })
})

describe('removeLiveSession', () => {
  it('entry 存在时：摘 entry、清 pending 暂存、activeSessionId 命中置空', () => {
    useSessionStore.setState({
      sessions: [sessionState('s-live'), sessionState('s-other')],
      activeSessionId: 's-live',
      pendingRuntimeEncoding: { 's-live': 'gbk' },
      pendingSessionCwd: { 's-live': 'D:\\work' }
    })

    useSessionStore.getState().removeLiveSession('s-live')

    const s = useSessionStore.getState()
    expect(s.sessions.map(x => x.id)).toEqual(['s-other'])
    expect(s.activeSessionId).toBeNull()
    expect(s.pendingRuntimeEncoding).not.toHaveProperty('s-live')
    expect(s.pendingSessionCwd).not.toHaveProperty('s-live')
  })

  it('entry 不存在但 pending 暂存仍在时：暂存被清掉，不留孤儿数据', () => {
    useSessionStore.setState({
      sessions: [sessionState('s-other')],
      pendingRuntimeEncoding: { 's-ghost': 'gbk' },
      pendingSessionCwd: { 's-ghost': 'D:\\ghost' }
    })

    useSessionStore.getState().removeLiveSession('s-ghost')

    const s = useSessionStore.getState()
    expect(s.sessions.map(x => x.id)).toEqual(['s-other'])
    expect(s.pendingRuntimeEncoding).toEqual({})
    expect(s.pendingSessionCwd).toEqual({})
  })
})
