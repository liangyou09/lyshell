// @vitest-environment jsdom
/**
 * 文档动作链接单测 —— /ls 清点文档的可点入口(新建 + 打开) + /help 手册的 MCP 安全开关:
 *   docActionFromHref:lyshell-action:// 前缀 + 已知动作 id + 查询参数识别,其余回落 null
 *   runDocAction:new-* 切面板并置新建请求;open-session 直连启动(不切面板);
 *                open-agent 直连 launchAgent;open-env / open-dsh 等切面板并置
 *                条目请求;open-plugin 仅切面板
 *   mcp-toggle(手册「MCP 集成」段的动作链接):翻转 security 配置(读-合-写)
 *                并原地换已开手册页签的链接标签;写失败仅留痕,标签不动
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { docActionFromHref, runDocAction } from './doc-actions'
import { NAV_EVENT } from './command-registry'
import { useUiStore } from '../stores/ui-store'
import { useSessionStore } from '../stores/session-store'
import { usePaneStore } from '../stores/pane-store'
import { BUILTIN_HELP_PATH } from '../components/DocPanel/readDoc'
import { buildMcpToggleLink } from '../components/DocPanel/manualMcp'
import { ConnectionType } from '@shared/types'
import type { SessionConfig, DocOverlayPayload, OverlayPayload } from '@shared/types'
import type { NavTab } from '../components/Layout/ActivityRail'

const updateSession = vi.fn()
const connect = vi.fn()
const listSessions = vi.fn()
const launchAgent = vi.fn()
const getConfig = vi.fn()
const setConfig = vi.fn()

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
  getConfig.mockReset()
  setConfig.mockReset().mockResolvedValue(undefined)
  // ui-store / session-store 是模块级单例,测试间归零防串扰
  useUiStore.setState({ createDialogRequests: {}, openItemRequests: {} })
  useSessionStore.setState({ savedSessions: [savedSsh] })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { updateSession, connect, listSessions, launchAgent, getConfig, setConfig }
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

  it('mcp-toggle 动作(手册 MCP 开关):同一解析路径,href 携带的手册语言只是参数', () => {
    expect(docActionFromHref('lyshell-action://mcp-toggle-confirm-destructive?lang=zh'))
      .toEqual({ id: 'mcp-toggle-confirm-destructive', params: { lang: 'zh' } })
    expect(docActionFromHref('lyshell-action://mcp-toggle-allow-metadata-write?lang=en'))
      .toEqual({ id: 'mcp-toggle-allow-metadata-write', params: { lang: 'en' } })
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

// ───────── mcp-toggle(/help 手册「MCP 集成」段的安全开关,设置面板 MCP 页签移入手册后的唯一开关 UI) ─────────

/** 挂一个 zh 手册页签到 pane-1(payload 字典 + 树引用同步构造,整字典替换防跨用例残留) */
const mountHelpTab = (content: string): void => {
  usePaneStore.setState({
    layout: {
      root: {
        id: 'pane-1', type: 'leaf', sessions: ['s-a'], activeSessionId: 's-a',
        overlays: [{ id: 'doc-m', kind: 'doc', active: true, slot: null }]
      },
      activePaneId: 'pane-1'
    },
    overlayPayloads: {
      'doc-m': {
        kind: 'doc', source: 'builtin', docKind: 'markdown', path: BUILTIN_HELP_PATH,
        title: 'manual', size: content.length, mtime: 0, content
      } as OverlayPayload
    }
  })
}

/** 取手册页签 payload(不在/不是 doc = 测试自身搭错了脚手架) */
const helpTab = (): DocOverlayPayload => {
  const p = usePaneStore.getState().overlayPayloads['doc-m']
  if (p?.kind !== 'doc') throw new Error('doc payload expected')
  return p
}

describe('runDocAction:mcp-toggle 手册安全开关', () => {
  it('翻转 security 配置(读-合-写保留兄弟键)并按新状态原地换已开手册页签的标签', async () => {
    getConfig.mockResolvedValue({ mcp: { allowSessionMetadataWrite: true }, unrelated: 'keep' })
    mountHelpTab(`安全\n${buildMcpToggleLink('confirmDestructive', 'zh', true)}`)

    runDocAction({ id: 'mcp-toggle-confirm-destructive', params: { lang: 'zh' } })

    // 路由是 fire-and-forget 异步:轮询等翻转与标签刷新落地
    await vi.waitFor(() => {
      expect(helpTab().content).toContain(buildMcpToggleLink('confirmDestructive', 'zh', false))
    })
    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig).toHaveBeenCalledWith('security', {
      mcp: { allowSessionMetadataWrite: true, confirmDestructiveCommands: false },
      unrelated: 'keep'
    })
  })

  it('写失败仅控制台留痕,已开手册页签的标签不动(标签永不指向未写入的状态)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      getConfig.mockResolvedValue({ mcp: {} })
      setConfig.mockRejectedValue(new Error('write failed'))
      const onLink = buildMcpToggleLink('confirmDestructive', 'zh', true)
      mountHelpTab(`安全\n${onLink}`)

      runDocAction({ id: 'mcp-toggle-confirm-destructive', params: { lang: 'zh' } })

      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledTimes(1)
      })
      expect(helpTab().content).toBe(`安全\n${onLink}`)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
