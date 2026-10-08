import { describe, expect, it, vi } from 'vitest'

vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))

import { assertExplorerLaunchConsumer } from './validation'

describe('资源管理器启动请求认领', () => {
  it('主窗口可认领', () => {
    expect(() => assertExplorerLaunchConsumer(12, 12)).not.toThrow()
  })

  it('webview、浮窗与窗口未创建时拒绝认领', () => {
    expect(() => assertExplorerLaunchConsumer(15, 12)).toThrow('requires the main window')
    expect(() => assertExplorerLaunchConsumer(15, null)).toThrow('requires the main window')
  })
})
