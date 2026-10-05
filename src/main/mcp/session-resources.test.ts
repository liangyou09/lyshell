import { describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'
import { PluginResourceRegistry, releasePluginSessions } from '../plugin/resource-registry'
import { createTrackedSession, resolveSessionResourceOwner, trackSessionConnectionResource, trackSessionResource } from './session-resources'

describe('MCP 复用会话的资源归属', () => {
  it.each([ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR])('重新连接已有 %s 用户运行时，禁用只关闭终端', async status => {
    const registry = new PluginResourceRegistry()
    const saved = { id: 'user-saved' }
    const owner = resolveSessionResourceOwner(registry, saved, 'b')
    expect(trackSessionConnectionResource(registry, saved.id, owner, status, () => true)).toBe(true)
    const deleteSaved = vi.fn()
    const deleteLive = vi.fn(async (_id: string) => {})
    await releasePluginSessions(registry, 'b', {
      notifyReleased() {}, listSessions: () => [saved], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive
    })
    expect(deleteSaved).not.toHaveBeenCalled()
    expect(deleteLive).toHaveBeenCalledWith(saved.id)
  })

  it.each([ConnectionStatus.CONNECTED, ConnectionStatus.CONNECTING, ConnectionStatus.RECONNECTING])('复用已有 %s 用户连接，不认领为插件资源', status => {
    const registry = new PluginResourceRegistry()
    const owner = resolveSessionResourceOwner(registry, { id: 'user-live' }, 'b')
    expect(trackSessionConnectionResource(registry, 'user-live', owner, status, () => true)).toBe(true)
    expect(registry.owner('user-live')).toBeUndefined()
    expect(registry.release('b')).toEqual([])
  })

  it('新建运行时需要登记，插件已禁用时不接受重新连接', () => {
    const registry = new PluginResourceRegistry()
    const owner = resolveSessionResourceOwner(registry, { id: 'new-live' }, 'b')
    expect(trackSessionConnectionResource(registry, 'new-live', owner, undefined, () => true)).toBe(true)
    expect(registry.owner('new-live')).toBe('b')
    registry.release('b')
    expect(trackSessionConnectionResource(registry, 'new-live', owner, ConnectionStatus.DISCONNECTED, () => true)).toBe(false)
    const current = resolveSessionResourceOwner(registry, { id: 'new-live' }, 'b')
    expect(trackSessionConnectionResource(registry, 'new-live', current, ConnectionStatus.ERROR, () => false)).toBe(false)
  })

  it('重启后 B 复用 A 的保存项，禁用 B 保留资源，禁用 A 回收保存项和终端', async () => {
    const registry = new PluginResourceRegistry()
    const saved = { id: 'saved-a', ownerPluginId: 'a' }
    const owner = resolveSessionResourceOwner(registry, saved, 'b')
    expect(owner.pluginId).toBe('a')
    expect(trackSessionResource(registry, saved.id, owner, () => true)).toBe(true)
    expect(registry.release('b')).toEqual([])
    const deleteSaved = vi.fn()
    const deleteLive = vi.fn(async (_id: string) => {})
    await releasePluginSessions(registry, 'a', {
      notifyReleased() {}, listSessions: () => [saved], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive
    })
    expect(deleteSaved).toHaveBeenCalledWith(saved.id)
    expect(deleteLive).toHaveBeenCalledWith(saved.id)
  })

  it('复用用户保存项创建终端，只回收运行时，不删除用户配置', async () => {
    const registry = new PluginResourceRegistry()
    const owner = resolveSessionResourceOwner(registry, { id: 'user-saved' }, 'b')
    expect(trackSessionResource(registry, 'user-saved', owner, () => true)).toBe(true)
    const deleteSaved = vi.fn()
    const deleteLive = vi.fn(async (_id: string) => {})
    await releasePluginSessions(registry, 'b', {
      notifyReleased() {}, listSessions: () => [{ id: 'user-saved' }], deleteSaved,
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive
    })
    expect(deleteSaved).not.toHaveBeenCalled()
    expect(deleteLive).toHaveBeenCalledWith('user-saved')
  })

  it('复用已登记运行时不转移给另一个请求插件', () => {
    const registry = new PluginResourceRegistry()
    registry.track('a', 'user-saved', 0)
    const owner = resolveSessionResourceOwner(registry, { id: 'user-saved' }, 'b')
    expect(owner.pluginId).toBe('a')
    expect(owner.saved).toBe(false)
    expect(trackSessionResource(registry, 'user-saved', owner, () => true)).toBe(true)
    expect(registry.release('b')).toEqual([])
  })

  it('原插件已禁用或等待建会话期间发生过回收，拒绝迟到登记', () => {
    const registry = new PluginResourceRegistry()
    const saved = { id: 'saved-a', ownerPluginId: 'a' }
    const owner = resolveSessionResourceOwner(registry, saved, 'b')
    expect(trackSessionResource(registry, saved.id, owner, id => id === 'b')).toBe(false)
    registry.release('a')
    expect(trackSessionResource(registry, saved.id, owner, () => true)).toBe(false)
    expect(registry.owner(saved.id)).toBeUndefined()
  })

  it('登记冲突返回失败，不静默认领其他插件的资源', () => {
    const registry = new PluginResourceRegistry()
    registry.track('b', 'saved-a', 0)
    const owner = resolveSessionResourceOwner(registry, { id: 'saved-a', ownerPluginId: 'a' }, 'b')
    expect(trackSessionResource(registry, 'saved-a', owner, () => true)).toBe(false)
    expect(registry.owner('saved-a')).toBe('b')
  })

  it('普通用户请求复用插件保存项也保留原归属，用户配置无需插件登记', () => {
    const registry = new PluginResourceRegistry()
    const owned = resolveSessionResourceOwner(registry, { id: 'saved-a', ownerPluginId: 'a' })
    expect(trackSessionResource(registry, 'saved-a', owned, () => true)).toBe(true)
    expect(registry.owner('saved-a')).toBe('a')
    const user = resolveSessionResourceOwner(registry, { id: 'user-saved' })
    expect(trackSessionResource(registry, 'user-saved', user, () => false)).toBe(true)
    expect(registry.owner('user-saved')).toBeUndefined()
  })
})

describe('MCP 新建运行时的并发回收', () => {
  function fixture(savedOwner?: string) {
    const registry = new PluginResourceRegistry()
    const config: SessionConfig = {
      id: 'saved', name: 'Telnet', type: ConnectionType.TELNET, telnet: { host: 'host', port: 23 },
      terminal: {} as SessionConfig['terminal'], tags: [], createdAt: new Date(), updatedAt: new Date(), ownerPluginId: savedOwner
    }
    const sessions = new Map<string, { id: string; status: ConnectionStatus }>()
    const hooks = {
      isRequestActive: () => true, isPluginEnabled: () => true, isSessionDeleting: () => false,
      getSession: (id: string) => sessions.get(id),
      createSession: vi.fn(async (config: SessionConfig) => {
        const session = { id: config.id, status: ConnectionStatus.DISCONNECTED }
        sessions.set(session.id, session)
        return session
      }),
      deleteSession: vi.fn(async (id: string) => { sessions.delete(id); registry.forgetLiveSession(id) })
    }
    const owner = resolveSessionResourceOwner(registry, config, 'a')
    return { registry, config, sessions, hooks, owner }
  }

  it('A 等待创建返回时 B 复用连接，保留 A 的归属和 B 已启动的终端', async () => {
    const { registry, config, sessions, hooks, owner } = fixture()
    const first = createTrackedSession(registry, config, owner, hooks)
    expect(registry.owner(config.id)).toBe('a')
    const live = sessions.get(config.id)!
    const borrower = resolveSessionResourceOwner(registry, config, 'b')
    expect(trackSessionConnectionResource(registry, live.id, borrower, live.status, () => true)).toBe(true)
    live.status = ConnectionStatus.CONNECTED
    expect(await first).toBe(live)
    expect(hooks.deleteSession).not.toHaveBeenCalled()
    expect(registry.release('b')).toEqual([])
    expect(sessions.get(config.id)).toBe(live)
  })

  it('等待期间旧会话被回收并由 B 同 ID 重建，A 不得删除 B 的新对象', async () => {
    const { registry, config, sessions, hooks, owner } = fixture()
    const first = createTrackedSession(registry, config, owner, hooks)
    registry.release('a')
    const replacement = { id: config.id, status: ConnectionStatus.CONNECTED }
    sessions.set(config.id, replacement)
    registry.track('b', config.id, registry.generation('b'))
    expect(await first).toBeUndefined()
    expect(hooks.deleteSession).not.toHaveBeenCalled()
    expect(sessions.get(config.id)).toBe(replacement)
    expect(registry.owner(config.id)).toBe('b')
  })

  it('同一个对象已被另一插件认领，旧请求失败也不能删除它', async () => {
    const { registry, config, sessions, hooks, owner } = fixture()
    const first = createTrackedSession(registry, config, owner, hooks)
    const live = sessions.get(config.id)
    registry.release('a')
    registry.track('b', config.id, registry.generation('b'))
    expect(await first).toBeUndefined()
    expect(hooks.deleteSession).not.toHaveBeenCalled()
    expect(sessions.get(config.id)).toBe(live)
  })

  it('等待期间请求失效，只删除本次创建且归属未变的运行时', async () => {
    const { registry, config, sessions, hooks, owner } = fixture()
    let active = true
    hooks.isRequestActive = () => active
    const first = createTrackedSession(registry, config, owner, hooks)
    active = false
    expect(await first).toBeUndefined()
    expect(hooks.deleteSession).toHaveBeenCalledWith(config.id)
    expect(sessions.has(config.id)).toBe(false)
    expect(registry.owner(config.id)).toBeUndefined()
  })

  it.each([undefined, 'a'])('创建失败撤销运行时预登记，保存项归属为 %s 时仍保留它', async savedOwner => {
    const { registry, config, hooks, owner } = fixture(savedOwner)
    hooks.createSession.mockRejectedValueOnce(new Error('create failed'))
    await expect(createTrackedSession(registry, config, owner, hooks)).rejects.toThrow('create failed')
    expect(registry.owner(config.id)).toBe(savedOwner)
    expect(hooks.deleteSession).not.toHaveBeenCalled()
  })

  it('来源正在删除或已有其他运行时，拒绝创建且不夺取其归属', async () => {
    const { registry, config, sessions, hooks, owner } = fixture()
    hooks.isSessionDeleting = () => true
    expect(await createTrackedSession(registry, config, owner, hooks)).toBeUndefined()
    hooks.isSessionDeleting = () => false
    sessions.set(config.id, { id: config.id, status: ConnectionStatus.CONNECTED })
    expect(await createTrackedSession(registry, config, owner, hooks)).toBeUndefined()
    expect(hooks.createSession).not.toHaveBeenCalled()
    expect(hooks.deleteSession).not.toHaveBeenCalled()
    expect(registry.owner(config.id)).toBeUndefined()
  })
})
