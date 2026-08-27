// @vitest-environment jsdom
/**
 * PaneTabBar 渲染断言。
 *
 * 页签品牌来源标与基本页签结构用 RTL 断言;主窗口布局无法整树渲染
 * (依赖 electronAPI / xterm),仅保留少量结构不变量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import PaneTabBar from './PaneTabBar'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { ConnectionStatus } from '@shared/types'
import type { PaneLeaf, SessionConfig } from '@shared/types'

// PaneTabBar 仅从 SplitPaneContainer 导入 setDraggingSessionId;真实模块会拖入
// PaneView → TerminalView → xterm 整条渲染链,与页签条渲染无关,桩掉
vi.mock('./SplitPaneContainer', () => ({
  setDraggingSessionId: () => {},
  getDraggingSessionId: () => null
}))

const makePane = (sessions: string[]): PaneLeaf => ({
  id: 'pane-1',
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null
})

const makeSession = (id: string, name: string, tags?: string[]) => ({
  id,
  // 渲染只读 name 与 tags(页签品牌来源标);其余 SessionConfig 字段与本测试无关
  config: { id, name, type: 'ssh', tags } as unknown as SessionConfig,
  status: ConnectionStatus.CONNECTED
})

beforeEach(() => {
  useSessionStore.setState({ sessions: [] })
  usePaneStore.setState({
    mcpAuditPaneId: null,
    dshWeb: null,
    dshWebPaneId: null,
    dshWebActive: false,
    hiddenTabSessions: {}
  })
})

afterEach(() => cleanup())

describe('PaneTabBar 顶排页签条(渲染断言)', () => {
  // harness 工作区启动的瞬态会话 tags 带 <kind>:<id>(handlers.ts 的 spawnLocalCommandSession),
  // 页签名左侧据此亮品牌来源标;普通会话、通用 Agent(agent:<id>)与用户自建的裸 kind 名标签不亮
  it('harness 会话页签亮品牌来源标(codex/claude/dsh),普通、agent: 与裸 kind 名标签不亮', () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'ws', ['codex:ws-1']),
        makeSession('s2', 'ws', ['claude:ws-2']),
        makeSession('s3', 'ws', ['dsh:ws-3']),
        makeSession('s4', 'plain'),
        makeSession('s5', 'agent', ['agent:a-1']),
        makeSession('s6', 'bare', ['codex'])
      ]
    })
    const { container } = render(<PaneTabBar pane={makePane(['s1', 's2', 's3', 's4', 's5', 's6'])} />)
    const markOf = (id: string) =>
      container.querySelector(`[data-tab-id="${id}"] [data-harness-mark]`)
    expect(markOf('s1')?.getAttribute('data-harness-mark')).toBe('codex')
    expect(markOf('s2')?.getAttribute('data-harness-mark')).toBe('claude')
    expect(markOf('s3')?.getAttribute('data-harness-mark')).toBe('dsh')
    expect(markOf('s4')).toBeNull()
    expect(markOf('s5')).toBeNull()
    // 只认 <kind>: 前缀(主进程打标约定)—— 用户自建的裸 "codex" 纯标签不命中品牌标
    expect(markOf('s6')).toBeNull()
  })

})

