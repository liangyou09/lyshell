// @vitest-environment jsdom
// 分组列表回归：固定批量动作、独立开合及既有存档。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import type { SessionConfig } from '@shared/types'
import SessionsPanel, { GroupHeader } from './SessionsPanel'
import '../../i18n'

vi.mock('../FileManager/FileManagerPanel', () => ({
  default: () => <div data-testid="file-manager-panel" />
}))

// 1 置顶(一键收/放的管辖对象)+ 1 子网会话(192.168.1.0/24)—— 两段
// 都要被辊行一键收/放;SessionSlot 是纯 props 组件,真会话可安全渲染
const pinnedSession: SessionConfig = {
  id: 'pinned-1',
  name: 'pinned-one',
  type: 'ssh',
  ssh: { host: '10.0.0.1', port: 22, username: 'root' },
  tags: ['pinned'],
  pinOrder: 0,
  createdAt: new Date('2026-09-01'),
  updatedAt: new Date('2026-09-01')
} as unknown as SessionConfig

const subnetSession: SessionConfig = {
  id: 'subnet-1',
  name: 'subnet-one',
  type: 'ssh',
  ssh: { host: '192.168.1.10', port: 22, username: 'root' },
  tags: [],
  createdAt: new Date('2026-09-02'),
  updatedAt: new Date('2026-09-02')
} as unknown as SessionConfig

vi.mock('../../stores/session-store', () => ({
  useSessionStore: () => ({
    savedSessions: [pinnedSession, subnetSession],
    sessions: [],
    reachability: {},
    refreshSavedSessions: vi.fn(),
    disconnectSession: vi.fn(),
    removeLiveSession: vi.fn(),
    setSessionEncoding: vi.fn(),
    deleteSession: vi.fn()
  })
}))

beforeEach(() => {
  (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = 'test'
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.electronAPI = {
    // 只回 fileManagerClosed(恒开);其余键 undefined —— 挂载期异步读档
    // 不落定分组折叠态,否则 promise 在测试首个 await 才兑现,会把测试
    // 先点出的折叠态冲回去(时序假象,非组件缺陷)
    getConfig: vi.fn(async (key: string) => (key === 'fileManagerClosed' ? false : undefined)),
    setConfig: vi.fn(async () => true),
    getQuickCommands: vi.fn(async () => []),
    commandGroupList: vi.fn(async () => [])
  } as unknown as typeof window.electronAPI
})

afterEach(() => cleanup())

const foldOf = (text: string) => screen.getByText(text).closest('.scroll-fold') as HTMLElement
const expandAll = () => screen.getByRole('button', { name: 'Expand all' }) as HTMLButtonElement
const collapseAll = () => screen.getByRole('button', { name: 'Collapse all' }) as HTMLButtonElement

describe('会话分组列表', () => {
  it('外层无双轴，内部单画轴保留，第一行单按钮随分组状态切换', () => {
    const { container } = render(<SessionsPanel />)
    expect(container.querySelector('.group-list .scroll-head .rod-caps')).toBeTruthy()
    expect(container.querySelector('.group-list .scroll-dual-rod')).toBeNull()
    expect(collapseAll().closest('.panel-header')).toBeTruthy()
    expect(container.querySelector('.group-list .group-list-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull()
    expect(collapseAll().disabled).toBe(false)
    expect(foldOf('pinned-one').classList.contains('open')).toBe(true)
  })

  it('批量收起隐藏内容并隔离焦点，标题仍可单独展开；混合状态下先收齐再展开', () => {
    render(<SessionsPanel />)
    fireEvent.click(collapseAll())
    expect(foldOf('pinned-one').classList.contains('open')).toBe(false)
    expect(foldOf('subnet-one').hasAttribute('inert')).toBe(true)
    expect(expandAll().getAttribute('aria-expanded')).toBe('false')
    const pinned = screen.getByText('Pinned').closest('[role="button"]') as HTMLElement
    expect(pinned.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(pinned)
    expect(pinned.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull()
    expect(collapseAll().disabled).toBe(false)
    fireEvent.click(collapseAll())
    fireEvent.click(expandAll())
    expect(foldOf('subnet-one').classList.contains('open')).toBe(true)
    expect(foldOf('subnet-one').hasAttribute('inert')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull()
  })

  it('置顶组批量开合仍走既有防抖存档', async () => {
    render(<SessionsPanel />)
    fireEvent.click(collapseAll())
    await waitFor(() => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('pinnedCollapsed', true), { timeout: 2000 })
    fireEvent.click(expandAll())
    await waitFor(() => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('pinnedCollapsed', false), { timeout: 2000 })
  })

  it('目录序号与可截断路径片段各自占位', () => {
    render(<GroupHeader label="project" labelTitle="/work/east/project" detail="east" detailMarker="#1" count={1} />)
    expect(screen.getByText('#1').className).toContain('shrink-0')
    expect(screen.getByText('east').className).toContain('truncate')
    expect(screen.getByText('#1').parentElement).toBe(screen.getByText('east').parentElement)
  })
})
