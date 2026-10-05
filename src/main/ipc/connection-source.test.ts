import { describe, expect, it, vi } from 'vitest'
import type { SessionConfig } from '@shared/types'
import { ConnectionType } from '@shared/types'
import { PluginResourceRegistry } from '../plugin/resource-registry'
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
import { assertConnectionCloneSourceId } from './validation'
import { resolveConnectionSource } from './connection-source'

const config = (id: string, extra: Partial<SessionConfig> = {}): SessionConfig => ({
  id, name: 'terminal', type: ConnectionType.LOCAL, local: {},
  terminal: {} as SessionConfig['terminal'], tags: [], createdAt: new Date(), updatedAt: new Date(), ...extra
})
function state() {
  const saved = new Map<string, SessionConfig>()
  const live = new Map<string, { config: SessionConfig }>()
  const registry = new PluginResourceRegistry()
  const hooks = { getSaved: (id: string) => saved.get(id), getLive: (id: string) => live.get(id),
    owner: (id: string) => registry.owner(id), isPluginEnabled: () => true }
  return { saved, live, registry, hooks }
}
describe('连接来源与插件归属', () => {
  it.each([undefined, 'user-saved'])('普通克隆源保存项为 %s，继承运行时归属并纳入回收', origin => {
    const { saved, live, registry, hooks } = state()
    saved.set('user-saved', config('user-saved'))
    live.set('runtime', { config: config('runtime', { originSavedSessionId: origin }) })
    registry.track('plugin', 'runtime', 0)
    const source = resolveConnectionSource(config('', { originSavedSessionId: 'forged', ownerPluginId: 'forged' }), { sourceSessionId: 'runtime' }, hooks)
    expect(source.ownerPluginId).toBe('plugin')
    expect(source.originSavedSessionId).toBe(origin)
    registry.track(source.ownerPluginId!, 'clone', registry.generation('plugin'))
    expect(registry.release('plugin').map(item => item.sessionId)).toEqual(['runtime', 'clone'])
    expect(saved.get('user-saved')?.ownerPluginId).toBeUndefined()
  })
  it('来源已删除/正在删除，拒绝旧克隆请求而非创建无归属资源', () => {
    const { hooks } = state()
    expect(() => resolveConnectionSource(config('', { ownerPluginId: 'plugin' }), { sourceSessionId: 'deleted' }, hooks)).toThrow('Source session no longer exists')
  })
  it('touch 成功后保存项被禁用回收，迟到的普通连接被拒绝', () => {
    const { saved, registry, hooks } = state()
    const prior = config('', { originSavedSessionId: 'plugin-saved', ownerPluginId: 'plugin' })
    saved.set('plugin-saved', config('plugin-saved', { ownerPluginId: 'plugin' }))
    registry.track('plugin', 'plugin-saved', 0, true)
    registry.release('plugin').forEach(item => saved.delete(item.sessionId))
    expect(() => resolveConnectionSource(prior, {}, hooks)).toThrow('Session no longer exists')
  })
  it('源运行时仍在 Map，但所属插件已禁用时拒绝克隆', () => {
    const { live, hooks } = state()
    live.set('runtime', { config: config('runtime', { ownerPluginId: 'plugin' }) })
    hooks.isPluginEnabled = () => false
    expect(() => resolveConnectionSource(config(''), { sourceSessionId: 'runtime' }, hooks)).toThrow('Plugin is disabled')
  })
  it('直接连接携带已回收的 ID 时拒绝重建保存项，已有用户 ID 仍可连接', () => {
    const { saved, live, hooks } = state()
    expect(() => resolveConnectionSource(config('removed', { ownerPluginId: 'plugin' }), {}, hooks)).toThrow('Session no longer exists')
    saved.set('user-saved', config('user-saved'))
    expect(resolveConnectionSource(config('user-saved'), {}, hooks).ownerPluginId).toBeUndefined()
    live.set('runtime', { config: config('runtime', { ownerPluginId: 'plugin' }) })
    expect(resolveConnectionSource(config('runtime'), {}, hooks).ownerPluginId).toBe('plugin')
  })
  it('普通用户临时连接及克隆不接受入参伪造归属', () => {
    const { live, hooks } = state()
    live.set('runtime', { config: config('runtime') })
    expect(resolveConnectionSource(config('', { ownerPluginId: 'plugin' }), {}, hooks).ownerPluginId).toBeUndefined()
    expect(resolveConnectionSource(config('', { ownerPluginId: 'plugin' }), { sourceSessionId: 'runtime' }, hooks).ownerPluginId).toBeUndefined()
  })
  it('源保存项已经删除，仍可从存活的用户运行时克隆', () => {
    const { live, hooks } = state()
    live.set('runtime', { config: config('runtime', { originSavedSessionId: 'removed-user-saved' }) })
    expect(resolveConnectionSource(config(''), { sourceSessionId: 'runtime' }, hooks).ownerPluginId).toBeUndefined()
  })
  it('克隆来源 ID 严格校验，并拒绝混用保存或插件动作请求', () => {
    expect(assertConnectionCloneSourceId(undefined)).toBeUndefined()
    expect(assertConnectionCloneSourceId('runtime')).toBe('runtime')
    for (const id of ['', 123, {}, 'x'.repeat(129)]) expect(() => assertConnectionCloneSourceId(id)).toThrow()
    const { hooks } = state()
    expect(() => resolveConnectionSource(config('saved'), { sourceSessionId: 'runtime' }, hooks)).toThrow('Clone requires')
    expect(() => resolveConnectionSource(config(''), { sourceSessionId: 'runtime', pluginId: 'plugin' }, hooks)).toThrow('Clone requires')
  })
})
