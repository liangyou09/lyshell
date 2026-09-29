import { describe, it, expect, beforeEach, vi } from 'vitest'

// auth.ts 依赖 electron-log；测试环境 mock 掉（只测 token 绑定/解析逻辑）。
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

import {
  bindPluginToken,
  revokePluginToken,
  resolveToken,
  clearAllTokens,
  bindPluginUiToken,
  revokePluginUiToken,
  revokeAllPluginTokens,
  hasPluginUiToken,
  getPluginUiToken
} from './auth'

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

  it('host token 解析为 tokenSource=host（缺省语义显式化）', () => {
    const token = bindPluginToken('my-plugin', ['read'])
    expect(resolveToken(token)!.tokenSource).toBe('host')
  })
})

describe('plugin UI token（界面视图凭据，与 host token 并存）', () => {
  beforeEach(() => {
    clearAllTokens()
  })

  it('bindPluginUiToken 返回 token 且 resolveToken 命中 plugin 档并标记 tokenSource=ui', () => {
    const token = bindPluginUiToken('my-plugin', ['uiControl', 'read'])
    expect(token).toBeTypeOf('string')
    const binding = resolveToken(token)
    expect(binding!.kind).toBe('plugin')
    expect(binding!.pluginId).toBe('my-plugin')
    expect(binding!.capabilities).toEqual(['uiControl', 'read'])
    expect(binding!.tokenSource).toBe('ui')
  })

  it('同一插件 host token 与 UI token 共存，互不覆盖', () => {
    const host = bindPluginToken('my-plugin', ['read'])
    const ui = bindPluginUiToken('my-plugin', ['uiControl'])
    const hostBinding = resolveToken(host)
    const uiBinding = resolveToken(ui)
    expect(hostBinding).not.toBeNull()
    expect(uiBinding).not.toBeNull()
    expect(hostBinding!.tokenSource).toBe('host')
    expect(uiBinding!.tokenSource).toBe('ui')
    expect(hostBinding!.capabilities).toEqual(['read'])
    expect(uiBinding!.capabilities).toEqual(['uiControl'])
    // 再绑 UI token 不影响 host token
    const ui2 = bindPluginUiToken('my-plugin', ['uiControl', 'read'])
    expect(resolveToken(ui)).toBeNull()
    expect(resolveToken(host)!.tokenSource).toBe('host')
    expect(resolveToken(ui2)!.tokenSource).toBe('ui')
    // 再绑 host token 不影响 UI token
    const host2 = bindPluginToken('my-plugin', ['read', 'execute'])
    expect(resolveToken(ui2)!.tokenSource).toBe('ui')
    expect(resolveToken(host)).toBeNull()
    expect(resolveToken(host2)!.tokenSource).toBe('host')
  })

  it('revokePluginToken 只撤 host token，UI token 保留', () => {
    const host = bindPluginToken('my-plugin', ['read'])
    const ui = bindPluginUiToken('my-plugin', ['uiControl'])
    revokePluginToken('my-plugin')
    expect(resolveToken(host)).toBeNull()
    expect(resolveToken(ui)!.tokenSource).toBe('ui')
  })

  it('revokePluginUiToken 只撤 UI token，host token 保留', () => {
    const host = bindPluginToken('my-plugin', ['read'])
    const ui = bindPluginUiToken('my-plugin', ['uiControl'])
    revokePluginUiToken('my-plugin')
    expect(resolveToken(ui)).toBeNull()
    expect(resolveToken(host)!.tokenSource).toBe('host')
  })

  it('revokeAllPluginTokens 一起撤（禁用/卸载语义）', () => {
    const host = bindPluginToken('my-plugin', ['read'])
    const ui = bindPluginUiToken('my-plugin', ['uiControl'])
    revokeAllPluginTokens('my-plugin')
    expect(resolveToken(host)).toBeNull()
    expect(resolveToken(ui)).toBeNull()
  })

  it('hasPluginUiToken / getPluginUiToken / clearAllTokens', () => {
    expect(hasPluginUiToken('my-plugin')).toBe(false)
    expect(getPluginUiToken('my-plugin')).toBeNull()
    const token = bindPluginUiToken('my-plugin', ['uiControl'])
    expect(hasPluginUiToken('my-plugin')).toBe(true)
    expect(getPluginUiToken('my-plugin')).toBe(token)
    clearAllTokens()
    expect(hasPluginUiToken('my-plugin')).toBe(false)
    expect(getPluginUiToken('my-plugin')).toBeNull()
  })

  it('UI token 与 host token / 其他插件 token 值互异且互不误配', () => {
    const hostA = bindPluginToken('plugin-a', ['read'])
    const uiA = bindPluginUiToken('plugin-a', ['uiControl'])
    const uiB = bindPluginUiToken('plugin-b', ['uiControl'])
    expect(new Set([hostA, uiA, uiB]).size).toBe(3)
    expect(resolveToken(uiA)!.pluginId).toBe('plugin-a')
    expect(resolveToken(uiB)!.pluginId).toBe('plugin-b')
  })
})
