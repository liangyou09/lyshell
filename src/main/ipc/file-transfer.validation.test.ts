import { describe, expect, it, vi } from 'vitest'
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
import { validateBuiltinTransferMethod } from './validation'

describe('内置文件传输 IPC', () => {
  it('只接受明确的 SFTP', () => expect(validateBuiltinTransferMethod('sftp')).toBe('sftp'))
  it.each(['exec', 'scp', 'tcp', 'python', 'base64', '', null, undefined, {}])('拒绝其他传输方式 %j', value => {
    expect(() => validateBuiltinTransferMethod(value)).toThrow()
  })
})
