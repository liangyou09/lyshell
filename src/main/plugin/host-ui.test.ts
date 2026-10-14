import { describe, it, expect, vi } from 'vitest'
import { openPluginHostUi } from './host-ui'
import type { TokenBinding } from '../mcp/auth'
import type { PluginViewMeta } from '@shared/plugin-types'

const host: TokenBinding = { kind: 'plugin', pluginId: 'aipet', tokenSource: 'host', capabilities: ['uiControl'] }
const body = { pluginId: 'aipet', target: 'chat2' }
const setup = () => ({
  plugin: vi.fn(() => ({ enabled: true, grantedCapabilities: ['uiControl'] as ['uiControl'] })),
  views: vi.fn((): PluginViewMeta[] => [
    { pluginId: 'aipet', id: 'chat2', title: '聊天2', entry: 'views/chat2.html', source: 'manifest' },
    { pluginId: 'aipet', id: 'settings', title: 'PetLink', entry: 'views/settings.html', source: 'manifest', surface: 'settings' }
  ]),
  open: vi.fn(async () => ({ ok: true }))
})

describe('插件宿主界面入口', () => {
  it.each<TokenBinding>([
    { kind: 'global' }, { kind: 'session' }, { kind: 'dshBridge' },
    { ...host, tokenSource: 'ui' }, { ...host, pluginId: 'other' }, { ...host, capabilities: [] }
  ])('拒绝非 host 身份、冒充或缺少能力 %j', async binding => {
    const deps = setup()
    expect((await openPluginHostUi(body, binding, deps)).status).toBe(403)
    expect(deps.open).not.toHaveBeenCalled()
  })
  it('当前权限撤销或禁用立即拒绝，即使 token 带旧能力', async () => {
    const deps = setup()
    deps.plugin.mockReturnValue({ enabled: false, grantedCapabilities: ['uiControl'] })
    expect((await openPluginHostUi(body, host, deps)).status).toBe(403)
    deps.plugin.mockReturnValue({ enabled: true, grantedCapabilities: [] as unknown as ['uiControl'] })
    expect((await openPluginHostUi(body, host, deps)).status).toBe(403)
    expect(deps.open).not.toHaveBeenCalled()
  })
  it.each(['chat2', 'settings'])('打开已注册的 %s，成功响应只包含目标身份', async target => {
    const deps = setup()
    const request = { pluginId: 'aipet', target }
    expect(await openPluginHostUi(request, host, deps)).toEqual({ status: 200, body: { success: true, data: request } })
    expect(deps.open).toHaveBeenCalledWith(request, target)
  })
  it('拒绝未知目标/额外 URL；没有目标不聚焦宿主', async () => {
    const deps = setup()
    for (const value of [null, [], { ...body, url: 'https://example.com' }, { ...body, target: 'workbench' }]) {
      expect((await openPluginHostUi(value, host, deps)).status).toBe(400)
    }
    deps.views.mockReturnValue([])
    expect((await openPluginHostUi(body, host, deps)).status).toBe(404)
    expect(deps.open).not.toHaveBeenCalled()
  })
  it('renderer 不可用或等待时撤权不会返回成功', async () => {
    const deps = setup()
    deps.open.mockResolvedValue({ ok: false })
    expect((await openPluginHostUi(body, host, deps)).status).toBe(503)
    deps.open.mockImplementation(async () => {
      deps.plugin.mockReturnValue({ enabled: false, grantedCapabilities: ['uiControl'] })
      return { ok: true }
    })
    expect((await openPluginHostUi(body, host, deps)).status).toBe(403)
  })
})
