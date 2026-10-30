import { describe, expect, it, vi } from 'vitest'
import { validateSshPersistence, validateTaskShelfRequest, validateTaskShelfTerminalTabs } from './validation'
import { ConnectionType, type SessionConfig } from '@shared/types'
vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))

describe('保存区 IPC 白名单', () => {
  it('退出回收的页签登记只接收有界唯一 ID，不接收恢复数据', () => {
    expect(validateTaskShelfTerminalTabs([])).toEqual([])
    expect(validateTaskShelfTerminalTabs([' t1 ', 't2'])).toEqual(['t1', 't2'])
    for (const raw of [null, {}, [''], ['  '], ['t', 't'], ['t', ' t '], ['x'.repeat(129)], [{ id: 't', command: 'injected' }], Array.from({ length: 10001 }, (_, index) => `t${index}`)]) {
      expect(() => validateTaskShelfTerminalTabs(raw)).toThrow()
    }
  })
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
  it('全部移回是精确无参数请求，附加字段一律拒绝', () => {
    expect(validateTaskShelfRequest({ kind: 'unarchiveAll' })).toEqual({ kind: 'unarchiveAll' })
    // 只认 kind：不能借这次批量操作夹带 id / archived / 资源列表。
    expect(() => validateTaskShelfRequest({ kind: 'unarchiveAll', id: 't1' })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'unarchiveAll', archived: false })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'unarchiveAll', ids: ['t1'] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'unarchiveAll', preferences: { toggleShortcut: '', collectShortcut: '' } })).toThrow()
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

describe('启动归档与分类命令 IPC 校验', () => {
  const ids = { bootId: 'boot-1', scopeId: 'shelf:abc' }

  it('activate 严格白名单：0 条合法，超 100 条/重复或空 taskId/非法版本一律拒绝', () => {
    expect(validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-1', items: [] })).toEqual({ kind: 'activate', ...ids, requestId: 'r-1', items: [] })
    const item = { taskId: 't-1', expectedRevision: 2 }
    expect(validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-2', items: [item] })).toMatchObject({ items: [item] })

    const many = Array.from({ length: 101 }, (_, index) => ({ taskId: `t-${index}`, expectedRevision: 1 }))
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-3', items: many })).toThrow(/at most/)
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-4', items: [item, item] })).toThrow(/duplicated/)
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-5', items: [{ taskId: '  ', expectedRevision: 1 }] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-6', items: [{ taskId: 't', expectedRevision: 0 }] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-7', items: [{ taskId: 't', expectedRevision: 1.5 }] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-8', items: [{ taskId: 't', expectedRevision: 1, status: 'moved' }] })).toThrow(/unknown field/)
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: '', items: [] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'x'.repeat(129), items: [] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'activate', bootId: '', scopeId: ids.scopeId, requestId: 'r-9', items: [] })).toThrow()
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-10', items: [], extra: true })).toThrow(/field/)
    expect(() => validateTaskShelfRequest({ kind: 'activate', ...ids, requestId: 'r-11', items: 'nope' })).toThrow()
  })

  it('retryInitialization 只接受 boot/scope，不接收任何额外字段', () => {
    expect(validateTaskShelfRequest({ kind: 'retryInitialization', ...ids })).toEqual({ kind: 'retryInitialization', ...ids })
    expect(() => validateTaskShelfRequest({ kind: 'retryInitialization', ...ids, requestId: 'r' })).toThrow(/field/)
    expect(() => validateTaskShelfRequest({ kind: 'retryInitialization', bootId: ids.bootId })).toThrow()
  })
})
