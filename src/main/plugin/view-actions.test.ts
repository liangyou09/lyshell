/**
 * view-actions 单元测试 -- UI 动作权限判定、参数清洗、弹窗尺寸钳制、审计摘要，
 * 以及 PluginActionDispatcher 的回执对账（首次/同窗口唯一有效）、超时、批量收尾。
 *
 * electron / 仓库 / HTTP 名单全部 mock（对齐 dev-user-data.test.ts 模式）：
 * dispatch 只需要 BrowserWindow.fromId 给一个「活着」的窗口对象。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  pluginGet: vi.fn(),
  sessionGet: vi.fn(),
  sessionAllowed: vi.fn(),
  fromId: vi.fn()
}))

vi.mock('electron', () => ({ BrowserWindow: { fromId: mocks.fromId } }))
vi.mock('@main/storage/plugin-repository', () => ({ pluginRepository: { get: mocks.pluginGet } }))
vi.mock('@main/storage/repository', () => ({ sessionRepository: { get: mocks.sessionGet } }))
vi.mock('@main/mcp/http-server', () => ({ isSessionAllowedForMcp: mocks.sessionAllowed }))

import {
  checkActionPermission,
  sanitizeActionParams,
  clampDialogSize,
  summarizeAction,
  PluginActionDispatcher,
  type ActionDispatchHooks,
  type PluginActionRequest
} from './view-actions'
import type { PluginGuestRecord } from './view-guests'

/** guest 记录基线：插件 p1 的 panel 视图，发起窗口 7 */
const guest = (over: Partial<PluginGuestRecord> = {}): PluginGuestRecord => ({
  webContentsId: 11,
  pluginId: 'p1',
  viewId: 'panel',
  kind: 'panel',
  ownerWindowId: 7,
  ...over
})

/** pluginRepository.get 返回的最小条目形状 */
const pluginEntry = (granted: string[], enabled = true) => ({
  id: 'p1',
  version: '1.0.0',
  path: 'p1',
  dev: true,
  enabled,
  source: 'dev',
  installedAt: '2026-01-01T00:00:00.000Z',
  grantedCapabilities: granted
})

/** 记录型 hooks：发给 renderer 的请求全量留痕 */
function makeHooks(): ActionDispatchHooks & { requests: PluginActionRequest[] } {
  const requests: PluginActionRequest[] = []
  return {
    requests,
    sendToWindow: (_win, payload) => {
      requests.push(payload)
    },
    logWarn: () => {}
  }
}

/** 全部依赖就绪（p1 已启用、窗口存活）的常用组包 */
function readyDispatcher(hooks = makeHooks(), granted = ['uiControl']) {
  mocks.pluginGet.mockReturnValue(pluginEntry(granted))
  mocks.fromId.mockReturnValue({ isDestroyed: () => false })
  return { dispatcher: new PluginActionDispatcher(hooks), hooks }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('checkActionPermission（纯函数）', () => {
  it('无 uiControl 一律拒绝（含未授权 undefined）', () => {
    expect(checkActionPermission([], 'openWebTab').ok).toBe(false)
    expect(checkActionPermission(undefined, 'openWebTab').ok).toBe(false)
    expect(checkActionPermission(['read', 'sessionControl'], 'openWebTab').ok).toBe(false)
    const r = checkActionPermission(['sessionControl'], 'openTerminal')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('uiControl')
  })

  it('openTerminal 另需 sessionControl、openDoc 另需 read；openWebTab/openDialog 仅 uiControl', () => {
    expect(checkActionPermission(['uiControl'], 'openWebTab').ok).toBe(true)
    expect(checkActionPermission(['uiControl'], 'openDialog').ok).toBe(true)
    const t = checkActionPermission(['uiControl'], 'openTerminal')
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.error).toContain('sessionControl')
    const d = checkActionPermission(['uiControl'], 'openDoc')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toContain('read')
    expect(checkActionPermission(['uiControl', 'sessionControl'], 'openTerminal').ok).toBe(true)
    expect(checkActionPermission(['uiControl', 'read'], 'openDoc').ok).toBe(true)
  })
})

describe('sanitizeActionParams（纯函数）', () => {
  it('拒绝非对象参数', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(sanitizeActionParams('openWebTab', bad).ok).toBe(false)
    }
  })

  it('openTerminal：sessionId 必填 1-128 字符', () => {
    expect(sanitizeActionParams('openTerminal', {}).ok).toBe(false)
    expect(sanitizeActionParams('openTerminal', { sessionId: '' }).ok).toBe(false)
    expect(sanitizeActionParams('openTerminal', { sessionId: 'x'.repeat(129) }).ok).toBe(false)
    expect(sanitizeActionParams('openTerminal', { sessionId: 's1' })).toEqual({ ok: true, params: { sessionId: 's1' } })
  })

  it('openWebTab：仅接受合法 http/https URL 并归一化', () => {
    expect(sanitizeActionParams('openWebTab', {}).ok).toBe(false)
    expect(sanitizeActionParams('openWebTab', { url: 'not a url' }).ok).toBe(false)
    expect(sanitizeActionParams('openWebTab', { url: 'ftp://example.com' }).ok).toBe(false)
    expect(sanitizeActionParams('openWebTab', { url: 'javascript:alert(1)' }).ok).toBe(false)
    const r = sanitizeActionParams('openWebTab', { url: 'HTTPS://Example.COM/a?b=1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.params.url as string).toLowerCase()).toBe('https://example.com/a?b=1')
  })

  it('openDoc：拒绝 NUL / 查询串 / fragment', () => {
    expect(sanitizeActionParams('openDoc', { path: 'C:\\a.md' }).ok).toBe(true)
    expect(sanitizeActionParams('openDoc', { path: 'C:\\a.md?x=1' }).ok).toBe(false)
    expect(sanitizeActionParams('openDoc', { path: 'C:\\a.md#frag' }).ok).toBe(false)
    expect(sanitizeActionParams('openDoc', { path: 'C:\\a\0.md' }).ok).toBe(false)
    expect(sanitizeActionParams('openDoc', {}).ok).toBe(false)
  })

  it('openDialog：viewId 规则 + title 长度 + width/height 范围钳取整', () => {
    expect(sanitizeActionParams('openDialog', {}).ok).toBe(false)
    expect(sanitizeActionParams('openDialog', { viewId: 'Bad' }).ok).toBe(false)
    expect(sanitizeActionParams('openDialog', { viewId: 'panel', title: 'x'.repeat(65) }).ok).toBe(false)
    expect(sanitizeActionParams('openDialog', { viewId: 'panel', width: 100 }).ok).toBe(false)
    expect(sanitizeActionParams('openDialog', { viewId: 'panel', height: 2000 }).ok).toBe(false)
    const ok = sanitizeActionParams('openDialog', { viewId: 'panel', title: 'Pick', width: 500.4 })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.params).toEqual({ viewId: 'panel', title: 'Pick', width: 500 })
    const minimal = sanitizeActionParams('openDialog', { viewId: 'panel' })
    expect(minimal.ok).toBe(true)
    if (minimal.ok) expect(minimal.params).toEqual({ viewId: 'panel' })
  })
})

describe('clampDialogSize / summarizeAction', () => {
  it('clampDialogSize：非数/越界/合法值', () => {
    expect(clampDialogSize(undefined)).toBeUndefined()
    expect(clampDialogSize(Number.NaN)).toBeUndefined()
    expect(clampDialogSize(50)).toBe(200)
    expect(clampDialogSize(5000)).toBe(1024)
    expect(clampDialogSize(480)).toBe(480)
    expect(clampDialogSize(300.7)).toBe(301)
  })

  it('summarizeAction：含插件/视图/动作与目标，长 URL 截断', () => {
    expect(summarizeAction('openTerminal', 'p1', 'panel', { sessionId: 's1' })).toContain('p1/panel openTerminal session=s1')
    expect(summarizeAction('openDialog', 'p1', 'panel', { viewId: 'picker' })).toContain('target=picker')
    const long = summarizeAction('openWebTab', 'p1', 'panel', { url: `https://x/${'a'.repeat(200)}` })
    expect(long.length).toBeLessThan(160)
    expect(long).toContain('p1/panel openWebTab')
  })
})

describe('handleInvoke：权限与事实核对', () => {
  it('未知动作 / 非字符串动作拒绝', async () => {
    const { dispatcher } = readyDispatcher()
    await expect(dispatcher.handleInvoke(guest(), 'selfDestruct', {})).resolves.toMatchObject({ ok: false })
    await expect(dispatcher.handleInvoke(guest(), 42 as unknown as 'openWebTab', {})).resolves.toMatchObject({ ok: false })
  })

  it('插件未启用/不存在拒绝；缺授权按动作要求拒绝', async () => {
    mocks.pluginGet.mockReturnValue(null)
    const a = new PluginActionDispatcher(makeHooks())
    await expect(a.handleInvoke(guest(), 'openWebTab', { url: 'https://x' })).resolves.toMatchObject({ ok: false, error: 'plugin is not enabled' })

    mocks.pluginGet.mockReturnValue(pluginEntry(['uiControl'], false))
    const b = new PluginActionDispatcher(makeHooks())
    await expect(b.handleInvoke(guest(), 'openWebTab', { url: 'https://x' })).resolves.toMatchObject({ ok: false, error: 'plugin is not enabled' })

    mocks.pluginGet.mockReturnValue(pluginEntry(['read']))
    const c = new PluginActionDispatcher(makeHooks())
    const r = await c.handleInvoke(guest(), 'openTerminal', { sessionId: 's1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('uiControl')
  })

  it('openTerminal：未知会话 / 名单拒绝 / 通过后注入完整 saved config（不回传 guest）', async () => {
    mocks.sessionGet.mockReturnValue(null)
    const { dispatcher: a } = readyDispatcher(undefined, ['uiControl', 'sessionControl'])
    await expect(a.handleInvoke(guest(), 'openTerminal', { sessionId: 's1' })).resolves.toMatchObject({ ok: false, error: 'unknown session' })

    const saved = { id: 's1', name: 'dev', config: { host: 'h' } }
    mocks.sessionGet.mockReturnValue(saved)
    mocks.sessionAllowed.mockReturnValue(false)
    const { dispatcher: b } = readyDispatcher(undefined, ['uiControl', 'sessionControl'])
    await expect(b.handleInvoke(guest(), 'openTerminal', { sessionId: 's1' })).resolves.toMatchObject({
      ok: false,
      error: 'session is not allowed (MCP security list)'
    })

    mocks.sessionAllowed.mockReturnValue(true)
    const { dispatcher: c, hooks } = readyDispatcher(undefined, ['uiControl', 'sessionControl'])
    const p = c.handleInvoke(guest(), 'openTerminal', { sessionId: 's1' })
    expect(hooks.requests[0].params.config).toBe(saved)
    c.handleResult({ requestId: hooks.requests[0].requestId, ok: true }, 7)
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('openDoc：不受支持的扩展名 / 敏感路径拒绝 / 正常路径分发', async () => {
    const { dispatcher, hooks } = readyDispatcher(undefined, ['uiControl', 'read'])
    await expect(dispatcher.handleInvoke(guest(), 'openDoc', { path: join(tmpdir(), 'a.exe') })).resolves.toMatchObject({
      ok: false,
      error: 'path is not a supported document type'
    })
    const r = await dispatcher.handleInvoke(guest(), 'openDoc', { path: '/home/u/.ssh/id_rsa.md' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('path rejected')
    // 普通文档路径通过事实预检（文件不必存在，ENOENT 跳过 realpath 复核）并正常分发
    const p = dispatcher.handleInvoke(guest(), 'openDoc', { path: join(tmpdir(), 'readme.md') })
    expect(hooks.requests).toHaveLength(1)
    dispatcher.handleResult({ requestId: hooks.requests[0].requestId, ok: true }, 7)
    await expect(p).resolves.toEqual({ ok: true })
  })
})

describe('handleInvoke：openDialog 注入与回传', () => {
  it('createDialogForInvoke 注入 dialogId/entryUrl，成功回执带回 dialogId', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    hooks.createDialogForInvoke = vi.fn(() => ({
      ok: true as const,
      dialogId: 'dlg1',
      entryUrl: 'lyshell-plugin://p1/panel.html?dialogId=dlg1'
    }))
    const p = dispatcher.handleInvoke(guest(), 'openDialog', { viewId: 'panel', title: 'Pick', width: 500 })
    // 注入字段是 handleInvoke 在调用之后写进同一 params 对象的（spy 记录引用会看到
    // 注入后的状态），这里只断言调用与清洗后的原始字段；注入结果看下方 request.params
    expect(hooks.createDialogForInvoke).toHaveBeenCalledTimes(1)
    expect(hooks.createDialogForInvoke).toHaveBeenCalledWith(
      guest(),
      expect.objectContaining({ viewId: 'panel', title: 'Pick', width: 500 })
    )
    expect(hooks.requests[0].params).toMatchObject({
      dialogId: 'dlg1',
      entryUrl: 'lyshell-plugin://p1/panel.html?dialogId=dlg1'
    })
    dispatcher.handleResult({ requestId: hooks.requests[0].requestId, ok: true }, 7)
    await expect(p).resolves.toEqual({ ok: true, dialogId: 'dlg1' })
  })

  it('bridge 未接线 / 目标核对失败给出确定错误', async () => {
    const { dispatcher } = readyDispatcher()
    await expect(dispatcher.handleInvoke(guest(), 'openDialog', { viewId: 'panel' })).resolves.toMatchObject({
      ok: false,
      error: 'dialog support is not wired'
    })

    const hooks2 = makeHooks()
    hooks2.createDialogForInvoke = () => ({ ok: false, error: 'target view not registered' })
    mocks.pluginGet.mockReturnValue(pluginEntry(['uiControl']))
    mocks.fromId.mockReturnValue({ isDestroyed: () => false })
    const dispatcher2 = new PluginActionDispatcher(hooks2)
    await expect(dispatcher2.handleInvoke(guest(), 'openDialog', { viewId: 'nope' })).resolves.toMatchObject({
      ok: false,
      error: 'target view not registered'
    })
  })

  it('分发失败的 openDialog 放弃未挂载弹窗记录（abandon 收到 dialogId）', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    hooks.createDialogForInvoke = vi.fn(() => ({
      ok: true as const,
      dialogId: 'dlg1',
      entryUrl: 'lyshell-plugin://p1/panel.html?dialogId=dlg1'
    }))
    const abandon = vi.fn()
    hooks.abandonDialogForInvoke = abandon
    const p = dispatcher.handleInvoke(guest(), 'openDialog', { viewId: 'panel' })
    dispatcher.handleResult({ requestId: hooks.requests[0].requestId, ok: false, error: 'renderer refused' }, 7)
    await expect(p).resolves.toMatchObject({ ok: false, error: 'renderer refused' })
    expect(abandon).toHaveBeenCalledTimes(1)
    expect(abandon).toHaveBeenCalledWith('dlg1')
  })

  it('超限请求在登记弹窗前被拒（不调 createDialogForInvoke）；分发成功不放弃', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    hooks.createDialogForInvoke = vi.fn(() => ({
      ok: true as const,
      dialogId: 'dlg1',
      entryUrl: 'lyshell-plugin://p1/panel.html?dialogId=dlg1'
    }))
    const abandon = vi.fn()
    hooks.abandonDialogForInvoke = abandon
    const flights: Array<Promise<unknown>> = []
    for (let i = 0; i < 8; i++) {
      flights.push(dispatcher.handleInvoke(guest(), 'openWebTab', { url: `https://x/${i}` }))
    }
    expect(hooks.requests).toHaveLength(8)
    await expect(dispatcher.handleInvoke(guest(), 'openDialog', { viewId: 'panel' })).resolves.toMatchObject({
      ok: false,
      error: 'too many pending actions for this plugin'
    })
    expect(hooks.createDialogForInvoke).not.toHaveBeenCalled()
    dispatcher.failPendingForPlugin('p1', 'cleanup')
    await Promise.all(flights)
    // 有空位且分发成功：不放弃
    const p = dispatcher.handleInvoke(guest(), 'openDialog', { viewId: 'panel' })
    dispatcher.handleResult({ requestId: hooks.requests[8].requestId, ok: true }, 7)
    await expect(p).resolves.toEqual({ ok: true, dialogId: 'dlg1' })
    expect(abandon).not.toHaveBeenCalled()
  })
})

describe('回执对账（handleResult）', () => {
  it('仅所属窗口的首次回执被采纳；重复/异窗口/未知 requestId 忽略', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    const p = dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x/1' })
    const req = hooks.requests[0]
    expect(dispatcher.handleResult({ requestId: req.requestId, ok: true }, 8)).toBe(false) // 异窗口
    expect(dispatcher.handleResult({ requestId: 'ghost', ok: true }, 7)).toBe(false) // 未知
    expect(dispatcher.handleResult(undefined, 7)).toBe(false)
    expect(dispatcher.handleResult({ requestId: req.requestId, ok: true }, 7)).toBe(true) // 首次
    expect(dispatcher.handleResult({ requestId: req.requestId, ok: true }, 7)).toBe(false) // 重复
    await expect(p).resolves.toEqual({ ok: true })
    expect(dispatcher.pendingCount()).toBe(0)
  })

  it('失败回执透传 renderer 错误；空错误给确定文案', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    const p1 = dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x/1' })
    dispatcher.handleResult({ requestId: hooks.requests[0].requestId, ok: false, error: 'bad url' }, 7)
    await expect(p1).resolves.toEqual({ ok: false, error: 'bad url' })

    const p2 = dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x/2' })
    dispatcher.handleResult({ requestId: hooks.requests[1].requestId, ok: false }, 7)
    await expect(p2).resolves.toEqual({ ok: false, error: 'renderer action failed' })
  })

  it('renderer 回执超时给出确定错误并清 pending', async () => {
    vi.useFakeTimers()
    const { dispatcher, hooks } = readyDispatcher()
    const p = dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x' })
    await vi.advanceTimersByTimeAsync(10_500)
    await expect(p).resolves.toEqual({ ok: false, error: 'renderer action timed out' })
    expect(dispatcher.pendingCount()).toBe(0)
    expect(hooks.requests).toHaveLength(1)
  })
})

describe('分发与收尾', () => {
  it('所属窗口不存在/已销毁直接失败（不进 pending）', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    mocks.fromId.mockReturnValue(null)
    await expect(dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x' })).resolves.toMatchObject({
      ok: false,
      error: 'owner window is gone'
    })
    mocks.fromId.mockReturnValue({ isDestroyed: () => true })
    await expect(dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x' })).resolves.toMatchObject({
      ok: false,
      error: 'owner window is gone'
    })
    expect(hooks.requests).toHaveLength(0)
    expect(dispatcher.pendingCount()).toBe(0)
  })

  it('sendToWindow 抛错按 dispatch failed 收尾', async () => {
    const hooks = makeHooks()
    hooks.sendToWindow = () => {
      throw new Error('ipc gone')
    }
    mocks.pluginGet.mockReturnValue(pluginEntry(['uiControl']))
    mocks.fromId.mockReturnValue({ isDestroyed: () => false })
    const dispatcher = new PluginActionDispatcher(hooks)
    await expect(dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x' })).resolves.toMatchObject({
      ok: false,
      error: 'dispatch failed: ipc gone'
    })
    expect(dispatcher.pendingCount()).toBe(0)
  })

  it('每插件在途动作超过上限直接拒绝', async () => {
    const { dispatcher, hooks } = readyDispatcher()
    const flights: Array<Promise<unknown>> = []
    for (let i = 0; i < 8; i++) {
      flights.push(dispatcher.handleInvoke(guest(), 'openWebTab', { url: `https://x/${i}` }))
    }
    await expect(dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x/9' })).resolves.toMatchObject({
      ok: false,
      error: 'too many pending actions for this plugin'
    })
    expect(hooks.requests).toHaveLength(8)
    dispatcher.failPendingForPlugin('p1', 'cleanup')
    await Promise.all(flights)
  })

  it('failPendingForWindow 只收尾该窗口；failPendingForPlugin 收尾该插件', async () => {
    const { dispatcher } = readyDispatcher()
    const pWin7a = dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x/1' })
    const pWin7b = dispatcher.handleInvoke(guest(), 'openWebTab', { url: 'https://x/2' })
    const pWin9 = dispatcher.handleInvoke(guest({ ownerWindowId: 9 }), 'openWebTab', { url: 'https://x/3' })
    dispatcher.failPendingForWindow(7, 'window closed')
    await expect(pWin7a).resolves.toEqual({ ok: false, error: 'window closed' })
    await expect(pWin7b).resolves.toEqual({ ok: false, error: 'window closed' })
    expect(dispatcher.pendingCount()).toBe(1) // 窗口 9 的仍在途
    dispatcher.failPendingForPlugin('p1', 'plugin disabled')
    await expect(pWin9).resolves.toEqual({ ok: false, error: 'plugin disabled' })
    expect(dispatcher.pendingCount()).toBe(0)
  })
})
