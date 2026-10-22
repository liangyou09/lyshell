import { describe, expect, it, vi } from 'vitest'
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
import { validateTerminalOutputControl } from './validation'

describe('终端输出 IPC 边界', () => {
  it.each([
    { kind: 'subscribe', sessionId: 'session' },
    { kind: 'unsubscribe', sessionId: 'session', subscriptionId: 'stream' },
    { kind: 'ack', sessionId: 'session', subscriptionId: 'stream', sequence: 1 }
  ])('接受有效的 %j', value => expect(validateTerminalOutputControl(value)).toEqual(value))

  it.each([null, [], {}, { kind: 'subscribe', sessionId: '' }, { kind: 'subscribe', sessionId: 'x'.repeat(129) },
    { kind: 'ack', sessionId: 's', subscriptionId: 'id', sequence: 0 },
    { kind: 'ack', sessionId: 's', subscriptionId: 'id', sequence: 0.5 },
    { kind: 'ack', sessionId: 's', subscriptionId: 'id', sequence: Infinity },
    { kind: 'ack', sessionId: 's', subscriptionId: 'id', sequence: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'unsubscribe', sessionId: 's', subscriptionId: '' },
    { kind: 'unknown', sessionId: 's', subscriptionId: 'id' }
  ])('拒绝无效控制消息 %j', value => expect(() => validateTerminalOutputControl(value)).toThrow())
})
