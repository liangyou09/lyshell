import { describe, it, expect, beforeEach, vi } from 'vitest'

// auth.ts 依赖 electron-log；测试环境 mock 掉（只测 token 绑定/解析逻辑）。
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import { bindPluginToken, revokePluginToken, resolveToken, clearAllTokens } from './auth'

describe('plugin token (§7 plugin 档)', () => {
  beforeEach(() => {
    clearAllTokens()
  })

  it('bindPluginToken 返回 token 且 resolveToken 命中 plugin 档', () => {
    const token = bindPluginToken('my-plugin', ['read', 'sessionControl'])
    expect(token).toBeTypeOf('string')
    expect(token.length).toBeGreaterThan(0)

    const binding = resolveToken(token)
    expect(binding).not.toBeNull()
    expect(binding!.kind).toBe('plugin')
    expect(binding!.pluginId).toBe('my-plugin')
    expect(binding!.capabilities).toEqual(['read', 'sessionControl'])
  })

  it('resolveToken 对无效/空 token 返回 null', () => {
    bindPluginToken('my-plugin', ['read'])
    expect(resolveToken('not-a-real-token')).toBeNull()
    expect(resolveToken(undefined)).toBeNull()
    expect(resolveToken('')).toBeNull()
  })

  it('revokePluginToken 后 token 失效', () => {
    const token = bindPluginToken('my-plugin', ['read'])
    expect(resolveToken(token)).not.toBeNull()

    revokePluginToken('my-plugin')
    expect(resolveToken(token)).toBeNull()
  })

  it('重新绑定同 pluginId 使旧 token 失效并更新 capability', () => {
    const token1 = bindPluginToken('my-plugin', ['read'])
    const token2 = bindPluginToken('my-plugin', ['read', 'execute'])

    expect(resolveToken(token1)).toBeNull()
    const binding = resolveToken(token2)
    expect(binding).not.toBeNull()
    expect(binding!.capabilities).toEqual(['read', 'execute'])
  })

  it('不同 pluginId 的 token 互不干扰', () => {
    const t1 = bindPluginToken('plugin-a', ['read'])
    const t2 = bindPluginToken('plugin-b', ['execute'])

    expect(resolveToken(t1)!.pluginId).toBe('plugin-a')
    expect(resolveToken(t2)!.pluginId).toBe('plugin-b')

    revokePluginToken('plugin-a')
    expect(resolveToken(t1)).toBeNull()
    expect(resolveToken(t2)).not.toBeNull()
  })

  it('clearAllTokens 清除所有 plugin token', () => {
    const t1 = bindPluginToken('plugin-a', ['read'])
    const t2 = bindPluginToken('plugin-b', ['read'])
    clearAllTokens()
    expect(resolveToken(t1)).toBeNull()
    expect(resolveToken(t2)).toBeNull()
  })

  it('plugin token 不与 session token 混淆（kind 区分）', () => {
    const token = bindPluginToken('my-plugin', ['read'])
    const binding = resolveToken(token)
    expect(binding!.kind).toBe('plugin')
    expect(binding!.originSessionId).toBeUndefined()
  })
})
