import { describe, expect, it, vi } from 'vitest'
import { validateSshPersistence, validateTaskShelfRequest } from './validation'
import { ConnectionType, type SessionConfig } from '@shared/types'
vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))

describe('保存区 IPC 白名单', () => {
  it('SSH 目录引用只接收安全绝对路径，保存配置时剥离；Telnet 不引入目录字段', () => {
    const config = { type: ConnectionType.SSH, ssh: { host: 'example', username: 'user', port: 22, resumeDirectory: '/srv/a b' } } as SessionConfig
    validateSshPersistence(config)
    expect(config.ssh?.resumeDirectory).toBe('/srv/a b')
    validateSshPersistence(config, true)
    expect(config.ssh?.resumeDirectory).toBeUndefined()
    expect(() => validateSshPersistence({ ...config, ssh: { ...config.ssh!, resumeDirectory: '/srv/a\ncommand' } })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'capture', resource: { kind: 'terminal', id: 't', context: 'injected history' } })).toThrow()
  })
  it('不接收命令、凭据和调用方自报的恢复配置', () => {
    expect(() => validateTaskShelfRequest({ kind: 'capture', resource: { kind: 'terminal', id: 't', command: 'execute' } })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'restore', id: 't', recovery: { password: 'secret' } })).toThrow()
  })
  it('校验网页和 ID 上限，允许空地址记录当前实例', () => {
    expect(validateTaskShelfRequest({ kind: 'capture', resource: { kind: 'web', id: 'w', url: '', title: '' } })).toMatchObject({ kind: 'capture' })
    expect(() => validateTaskShelfRequest({ kind: 'capture', resource: { kind: 'web', id: 'w', url: 'x'.repeat(4097), title: '' } })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'remove', id: 'x'.repeat(129) })).toThrow()
  })
  it('仅合法、明确的 tmux 引用可进入运行期，普通保存会剥离它', () => {
    const config = { type: ConnectionType.SSH, ssh: { host: 'example', username: 'user', port: 22, keepSessionAlive: true, resumeSessionName: 'lyshell-unique' } } as SessionConfig
    validateSshPersistence(config)
    expect(config.ssh?.resumeSessionName).toBe('lyshell-unique')
    validateSshPersistence(config, true)
    expect(config.ssh).toMatchObject({ keepSessionAlive: true })
    expect(config.ssh?.resumeSessionName).toBeUndefined()
    expect(() => validateSshPersistence({ ...config, ssh: { ...config.ssh!, resumeSessionName: 'user-session; command' } })).toThrow()
    expect(() => validateSshPersistence({ ...config, ssh: { ...config.ssh!, keepSessionAlive: 'true' as never } })).toThrow()
  })
})
