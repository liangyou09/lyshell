// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import type { SessionConfig } from '@shared/types'
import { useSessionStore } from './session-store'
const connect = vi.fn()
beforeEach(() => {
  connect.mockReset()
  window.electronAPI = { connect } as unknown as typeof window.electronAPI
  useSessionStore.setState({ sessions: [{ id: 'runtime', status: ConnectionStatus.CONNECTED, config: {
    id: 'runtime', name: 'terminal', type: ConnectionType.LOCAL, ownerPluginId: 'plugin', originSavedSessionId: 'user-saved',
    terminal: {} as SessionConfig['terminal'], tags: [], createdAt: new Date(), updatedAt: new Date()
  } }] })
})
afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI })
describe('普通终端克隆', () => {
  it('携带源运行时 ID，让 main 继承可信归属', async () => {
    connect.mockResolvedValue({ id: 'clone', status: ConnectionStatus.CONNECTING })
    await expect(useSessionStore.getState().cloneSession('runtime')).resolves.toBe('clone')
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: '' }), undefined, 'runtime')
  })
  it('主进程拒绝已回收来源时抛出错误，不把 temp 当成成功克隆', async () => {
    connect.mockResolvedValue({ id: 'temp', status: ConnectionStatus.ERROR, error: 'Source session no longer exists' })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(useSessionStore.getState().cloneSession('runtime')).rejects.toThrow('Source session no longer exists')
    log.mockRestore()
  })
})
