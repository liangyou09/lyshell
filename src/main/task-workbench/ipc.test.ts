import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { parseTaskWorkbenchRequest } from '@shared/task-workbench-validation'

const mocks = vi.hoisted(() => ({
  handler: undefined as ((event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) | undefined,
  fromWebContents: vi.fn(), request: vi.fn()
}))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: mocks.fromWebContents } }))
vi.mock('../ipc/application-ipc', () => ({ applicationIpc: { handle: (_channel: string, handler: typeof mocks.handler) => { mocks.handler = handler } } }))
vi.mock('../ipc/validation', () => ({
  ValidationError: class extends Error {},
  validateTaskWorkbenchRequest: (value: unknown) => {
    const result = parseTaskWorkbenchRequest(value)
    if (!result) throw new Error('Invalid task workbench request')
    return result
  }
}))
vi.mock('./runtime', () => ({ requestTaskWorkbench: mocks.request }))
import { registerTaskWorkbenchIpc } from './ipc'

function setup() {
  const sender = { mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  const parent = { webContents: sender }
  mocks.fromWebContents.mockReturnValue(parent)
  registerTaskWorkbenchIpc()
  return { sender, parent, event: { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent }
}

describe('task workbench trusted IPC', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('rejects guest senders and subframes before any business operation', async () => {
    const { event } = setup()
    mocks.fromWebContents.mockReturnValue(undefined)
    await expect(mocks.handler!(event, { kind: 'list' })).rejects.toThrow('main window')
    const second = setup()
    await expect(mocks.handler!({ ...second.event, senderFrame: {} } as IpcMainInvokeEvent, { kind: 'list' })).rejects.toThrow('main window')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('rejects forged DTO before forwarding and only sends returned snapshots to its sender', async () => {
    const { event, sender, parent } = setup()
    await expect(mocks.handler!(event, { kind: 'list', owner: 'forged' })).rejects.toThrow('Invalid')
    expect(mocks.request).not.toHaveBeenCalled()
    const snapshot = { revision: 1, queueEnabled: false, maxActive: 2, entries: [], submissions: [], results: [] }
    mocks.request.mockResolvedValue({ ok: true, snapshot })
    await expect(mocks.handler!(event, { kind: 'list' })).resolves.toEqual({ ok: true, snapshot })
    expect(mocks.request).toHaveBeenCalledWith({ kind: 'list' }, parent)
    expect(sender.send).toHaveBeenCalledWith('task-workbench:changed', snapshot)
  })
})
