// @vitest-environment jsdom
/**
 * 文档动作链接单测 —— /ls 清点文档的可点入口(新建 + 打开两类):
 *   docActionFromHref:lyshell-action:// 前缀 + 已知动作 id + 查询参数识别,其余回落 null
 *   runDocAction:new-* 切面板并置新建请求;open-session 直连启动(不切面板);
 *                open-agent 直连 launchAgent;open-env / open-dsh 等切面板并置
 *                条目请求;open-plugin 仅切面板
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { docActionFromHref, runDocAction } from './doc-actions'
import { NAV_EVENT } from './command-registry'
import { useUiStore } from '../stores/ui-store'
import { useSessionStore } from '../stores/session-store'
import { ConnectionType } from '@shared/types'
import type { SessionConfig } from '@shared/types'
import type { NavTab } from '../components/Layout/ActivityRail'

const updateSession = vi.fn()
const connect = vi.fn()
const listSessions = vi.fn()
const launchAgent = vi.fn()

const savedSsh: SessionConfig = {
  id: 'saved-1',
  name: 'prod',
  type: ConnectionType.SSH,
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  terminal: {} as SessionConfig['terminal'],
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
}

beforeEach(() => {
  updateSession.mockReset().mockResolvedValue(undefined)
  connect.mockReset().mockResolvedValue('session-x')
  listSessions.mockReset().mockResolvedValue([])
  launchAgent.mockReset().mockResolvedValue(undefined)
  // ui-store / session-store 是模块级单例,测试间归零防串扰
  useUiStore.setState({ createDialogRequests: {}, openItemRequests: {} })
  useSessionStore.setState({ savedSessions: [savedSsh] })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { updateSession, connect, listSessions, launchAgent }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('docActionFromHref:scheme 与参数识别', () => {
  it('新建动作:无查询参数,参数为空对象', () => {
    expect(docActionFromHref('lyshell-action://new-session')).toEqual({ id: 'new-session', params: {} })
  })

  it('打开动作:携带查询参数(URL 编码解回原文)', () => {
    expect(docActionFromHref('lyshell-action://open-session?id=saved-1')).toEqual({ id: 'open-session', params: { id: 'saved-1' } })
    expect(docActionFromHref('lyshell-action://open-dsh?id=a%7Cb')).toEqual({ id: 'open-dsh', params: { id: 'a|b' } })
  })

  it('重复 key 只取首个(?id=a&id=b 不静默换值)', () => {
    expect(docActionFromHref('lyshell-action://open-session?id=a&id=b')).toEqual({ id: 'open-session', params: { id: 'a' } })
  })

  it('非本 scheme / 未知名返回 null(调用方回落普通链接处理)', () => {
    expect(docActionFromHref('https://example.com')).toBeNull()
    expect(docActionFromHref('mailto:a@b.c')).toBeNull()
    expect(docActionFromHref('./relative.md')).toBeNull()
    expect(docActionFromHref('#anchor')).toBeNull()
    expect(docActionFromHref('lyshell-action://nope')).toBeNull()
    expect(docActionFromHref('lyshell-action://nope?id=x')).toBeNull()
    expect(docActionFromHref('')).toBeNull()
  })
})

describe('runDocAction:路由副作用', () => {
  it('new-*:派发 NAV_EVENT 并置对应面板的新建请求格', () => {
    const seen: NavTab[] = []
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NavTab>).detail)
    }
    window.addEventListener(NAV_EVENT, listener)
    try {
      runDocAction({ id: 'new-agent', params: {} })
      runDocAction({ id: 'new-dsh', params: {} })
      expect(seen).toEqual(['agents', 'dsh'])
      expect(useUiStore.getState().createDialogRequests.agents).toBe(1)
      expect(useUiStore.getState().createDialogRequests.dsh).toBe(1)
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('open-session:以 runtime 克隆直连(不切面板、不置面板请求)', async () => {
    const listener = vi.fn()
    window.addEventListener(NAV_EVENT, listener)
    try {
      runDocAction({ id: 'open-session', params: { id: 'saved-1' } })
      // connectSession 是 async:等启动链落地再断言
      await vi.waitFor(() => {
        expect(connect).toHaveBeenCalledTimes(1)
      })
      const runtime = connect.mock.calls[0][0] as SessionConfig
      expect(runtime.id).toBe('')
      expect(runtime.originSavedSessionId).toBe('saved-1')
      expect(listener).not.toHaveBeenCalled()  // 终端长在活动分屏,不打断当前左栏页签
      expect(useUiStore.getState().openItemRequests.sessions).toBeUndefined()
      expect(useUiStore.getState().createDialogRequests.sessions).toBeUndefined()
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('open-session:快照后已删的会话不连接(静默 + 控制台留痕)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      runDocAction({ id: 'open-session', params: { id: 'gone' } })
      await Promise.resolve()
      expect(connect).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('open-agent:直接调用 launchAgent(与 AgentsPanel 行点击同一条链,不切面板)', () => {
    const listener = vi.fn()
    window.addEventListener(NAV_EVENT, listener)
    try {
      runDocAction({ id: 'open-agent', params: { id: 'agent-9' } })
      expect(launchAgent).toHaveBeenCalledWith('agent-9')
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('open-env / open-dsh:切面板并置对应面板的条目请求格', () => {
    const seen: NavTab[] = []
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NavTab>).detail)
    }
    window.addEventListener(NAV_EVENT, listener)
    try {
      runDocAction({ id: 'open-env', params: { id: 'p1' } })
      runDocAction({ id: 'open-dsh', params: { id: 'w1' } })
      expect(seen).toEqual(['env', 'dsh'])
      expect(useUiStore.getState().openItemRequests.env).toEqual({ itemId: 'p1', nonce: 1 })
      expect(useUiStore.getState().openItemRequests.dsh).toEqual({ itemId: 'w1', nonce: 1 })
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('open-plugin:仅切面板(插件无「打开」语义,不置条目/新建请求)', () => {
    const seen: NavTab[] = []
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NavTab>).detail)
    }
    window.addEventListener(NAV_EVENT, listener)
    try {
      runDocAction({ id: 'open-plugin', params: { id: 'demo' } })
      expect(seen).toEqual(['plugins'])
      expect(useUiStore.getState().openItemRequests.plugins).toBeUndefined()
      expect(useUiStore.getState().createDialogRequests.plugins).toBeUndefined()
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
  })

  it('未知动作无副作用(不派发、不连接、不置请求)', () => {
    const listener = vi.fn()
    window.addEventListener(NAV_EVENT, listener)
    try {
      runDocAction({ id: 'nope', params: {} })
    } finally {
      window.removeEventListener(NAV_EVENT, listener)
    }
    expect(listener).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(launchAgent).not.toHaveBeenCalled()
    expect(useUiStore.getState().createDialogRequests).toEqual({})
    expect(useUiStore.getState().openItemRequests).toEqual({})
  })
})
