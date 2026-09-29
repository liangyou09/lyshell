/**
 * view-tokens 单元测试 —— UI token 与「已启用且有视图」集合的对账。
 *
 * 关键回归：安装会覆盖 grantedCapabilities（如同 ID 重装减权），而 HTTP 鉴权用
 * token 内的权限快照 —— refreshAllPluginUiTokens 若只补签不重签，已有视图的
 * callApi 会继续持旧（更宽）权限。重签语义 = 撤销旧 token + 按新授权重建。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

/** 仓库替身：id → entry（enabled / grantedCapabilities 可动态改写） */
const repoEntries = new Map<string, { id: string; enabled: boolean; grantedCapabilities: string[] }>()
vi.mock('@main/storage/plugin-repository', () => ({
  pluginRepository: {
    get: (id: string) => repoEntries.get(id),
    getEnabled: () => [...repoEntries.values()].filter((e) => e.enabled),
    getAll: () => [...repoEntries.values()]
  }
}))

import { refreshAllPluginUiTokens, ensurePluginUiToken, maybeRevokePluginUiToken } from './view-tokens'
import {
  bindPluginUiToken,
  getPluginUiToken,
  hasPluginUiToken,
  revokeAllPluginTokens,
  resolveToken,
  clearAllTokens
} from '@main/mcp/auth'
import type { PluginViewRegistry } from './view-registry'

/** 视图注册表替身：id → 视图数量 */
const fakeRegistry = (views: Record<string, number>): PluginViewRegistry =>
  ({
    listViewsForPlugin: (id: string) => Array.from({ length: views[id] ?? 0 }, (_, i) => ({ id: `v${i}` }))
  }) as unknown as PluginViewRegistry

const setEntry = (id: string, enabled: boolean, granted: string[]): void => {
  repoEntries.set(id, { id, enabled, grantedCapabilities: granted as never })
}

describe('refreshAllPluginUiTokens', () => {
  beforeEach(() => {
    clearAllTokens()
    repoEntries.clear()
  })

  it('授权减权后重签：旧 token 失效，新 token 快照 = 当前授权（回归：同 ID 重装减权）', () => {
    setEntry('p1', true, ['read', 'execute'])
    const oldToken = bindPluginUiToken('p1', ['read', 'execute'])
    expect(resolveToken(oldToken)?.capabilities).toEqual(['read', 'execute'])

    // 同 ID 重装/权限变更：grantedCapabilities 覆盖为更小集合
    setEntry('p1', true, ['read'])
    refreshAllPluginUiTokens(fakeRegistry({ p1: 1 }))

    expect(resolveToken(oldToken)).toBeNull() // 旧 token 整个失效，不是保留旧快照
    const newToken = getPluginUiToken('p1')
    expect(newToken).toBeTruthy()
    expect(newToken).not.toBe(oldToken)
    expect(resolveToken(newToken as string)?.capabilities).toEqual(['read'])
  })

  it('授权扩权后同样重签（快照跟随当前授权，方向无关）', () => {
    setEntry('p1', true, ['read'])
    const oldToken = bindPluginUiToken('p1', ['read'])
    setEntry('p1', true, ['read', 'execute'])
    refreshAllPluginUiTokens(fakeRegistry({ p1: 1 }))
    expect(resolveToken(oldToken)).toBeNull()
    expect(resolveToken(getPluginUiToken('p1') as string)?.capabilities).toEqual(['read', 'execute'])
  })

  it('无 token 的有视图插件补签', () => {
    setEntry('p1', true, ['read'])
    refreshAllPluginUiTokens(fakeRegistry({ p1: 2 }))
    expect(hasPluginUiToken('p1')).toBe(true)
    expect(resolveToken(getPluginUiToken('p1') as string)?.capabilities).toEqual(['read'])
  })

  it('无视图/禁用插件撤销 UI token（仓库已移除的插件由卸载路径 revokeAllPluginTokens 负责撤销）', () => {
    setEntry('p1', true, ['read'])
    setEntry('p3', false, ['read'])
    bindPluginUiToken('p1', ['read'])
    bindPluginUiToken('p3', ['read'])
    // p1 视图清空；p3 禁用
    refreshAllPluginUiTokens(fakeRegistry({}))
    expect(hasPluginUiToken('p1')).toBe(false)
    expect(hasPluginUiToken('p3')).toBe(false)
  })

  it('重签幂等：连续两次调用后 token 仍有效且快照一致', () => {
    setEntry('p1', true, ['read'])
    refreshAllPluginUiTokens(fakeRegistry({ p1: 1 }))
    refreshAllPluginUiTokens(fakeRegistry({ p1: 1 }))
    expect(hasPluginUiToken('p1')).toBe(true)
    expect(resolveToken(getPluginUiToken('p1') as string)?.capabilities).toEqual(['read'])
  })
})

describe('ensurePluginUiToken / maybeRevokePluginUiToken', () => {
  beforeEach(() => {
    clearAllTokens()
    repoEntries.clear()
  })

  it('ensurePluginUiToken 无则建、有则跳过（重签由 refreshAll 对账）', () => {
    setEntry('p1', true, ['read'])
    ensurePluginUiToken(fakeRegistry({ p1: 1 }), 'p1')
    const first = getPluginUiToken('p1')
    expect(first).toBeTruthy()
    ensurePluginUiToken(fakeRegistry({ p1: 1 }), 'p1')
    expect(getPluginUiToken('p1')).toBe(first)
  })

  it('maybeRevokePluginUiToken 插件恢复有效时不撤销', () => {
    setEntry('p1', true, ['read'])
    bindPluginUiToken('p1', ['read'])
    maybeRevokePluginUiToken(fakeRegistry({ p1: 1 }), 'p1')
    expect(hasPluginUiToken('p1')).toBe(true)
  })

  it('revokeAllPluginTokens 连 host token 一起清（三步撤销语义，供 reSign 场景）', () => {
    setEntry('p1', true, ['read'])
    bindPluginUiToken('p1', ['read'])
    revokeAllPluginTokens('p1')
    expect(hasPluginUiToken('p1')).toBe(false)
  })
})
