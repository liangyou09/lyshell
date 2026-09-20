// @vitest-environment jsdom
/**
 * 会话墙双开画轴(.scroll-dual-wall)回归:整面会话墙(垂卷分组们:
 * LIVE/PINNED/协议筛选/子网组)住进一张竖置双开画轴的纸里,替代原「全体」
 * 天头总闸。锁定:
 * 1. 墙恒开:纸面/分组栏恒在 —— 收起的是纸里的垂卷分组们,不是整墙卷回
 *    双辊(「收起的时候也是展开的状态」:全体收起时墙纸仍铺着,纸面上
 *    立着一排卷起的分组卷);
 * 2. 点任一辊行(上/下)= 一键收/放(toggleAllGroups 旧总闸语义随总闸
 *    迁到墙上):收 = 置顶段+全部子网组都卷起,放 = 全部展开;上辊行带
 *    键盘入口(aria-expanded 反映全体分组态,两态 title);
 * 3. 分组卷拢走 ScrollFold:内容仍在 DOM,开合态由容器 open class 与
 *    inert 属性承载(jsdom 无布局,勿用 queryByText null 断言摘树);
 * 4. 置顶段开合走 pinnedCollapsed 既有存档(防抖落盘);子网组态与单组
 *    折叠同口径不存档;LIVE 段不归辊行管;
 * 5. 总闸已摘:开合 title 挂在 .scroll-dual-rod 辊行上,不再是
 *    .scroll-head 分组栏的根栏提示;墙自身无态可存档 —— config 不应有
 *    wallRolled 相关读写。
 * 注:墙纸里同族物件(分组 rod-caps/scroll-tie)不被双开轴细棍覆写压细,
 * 靠 globals.css 的直系限定(.scroll-dual > .scroll-dual-rod)保证 ——
 * jsdom 不级联 CSS,该回归不在本文件覆盖范围。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import type { SessionConfig } from '@shared/types'
import SessionsPanel from './SessionsPanel'
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

// ScrollFold 折叠不摘树:内容仍在 DOM,开合态由容器 class/inert 承载
const foldOf = (text: string) => screen.getByText(text).closest('.scroll-fold') as HTMLElement

describe('会话墙双开画轴(墙恒开)', () => {
  it('默认全体展开:分组与行都在纸里,上辊行是一键收钮(键盘可达,两态 title)', () => {
    render(<SessionsPanel />)
    // 子网分组 + 两个会话行都在墙纸里,折叠容器都是开态(无 inert)
    expect(screen.getByText('192.168.1.0/24')).toBeTruthy()
    expect(screen.getByText('pinned-one')).toBeTruthy()
    expect(screen.getByText('subnet-one')).toBeTruthy()
    expect(foldOf('pinned-one').classList.contains('open')).toBe(true)
    expect(foldOf('pinned-one').hasAttribute('inert')).toBe(false)
    // 上辊行 = 一键收/放钮:全体展开态 title 是「折叠全部分组」,键盘入口在
    const rod = screen.getByTitle('Collapse all groups')
    expect(rod.getAttribute('aria-expanded')).toBe('true')
    expect(rod.closest('.scroll-dual-rod')).toBeTruthy()
    // 墙恒开:装配恒挂 open(纸永铺着,无 rolled 卷回态)
    const wall = rod.closest('.scroll-dual') as HTMLElement
    expect(wall.classList.contains('open')).toBe(true)
    expect(wall.classList.contains('rolled')).toBe(false)
  })

  it('点上辊行一键收:置顶+子网组全卷起;墙恒开,分组栏仍在纸里;辊行翻向展开', () => {
    render(<SessionsPanel />)
    fireEvent.click(screen.getByTitle('Collapse all groups'))
    // 两个分组都卷起:分组栏 aria-expanded=false,ScrollFold 收拢
    // (inert 挡 Tab 序,内容仍在 DOM —— 不摘树)
    const pinnedHeader = screen.getByText('Pinned').closest('[role="button"]') as HTMLElement
    expect(pinnedHeader.getAttribute('aria-expanded')).toBe('false')
    const subnetHeader = screen.getByText('192.168.1.0/24').closest('[role="button"]') as HTMLElement
    expect(subnetHeader.getAttribute('aria-expanded')).toBe('false')
    expect(foldOf('pinned-one').classList.contains('open')).toBe(false)
    expect(foldOf('pinned-one').hasAttribute('inert')).toBe(true)
    expect(foldOf('subnet-one').hasAttribute('inert')).toBe(true)
    // 墙恒开(「收起的时候也是展开的状态」):墙纸仍铺着,分组栏(卷起的
    // 分组卷)仍立在纸面上 —— 收起的是里面的会话画卷,不是整墙
    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(screen.getByText('192.168.1.0/24')).toBeTruthy()
    // 辊行两态翻转:全体收起 → title 翻向「展开」,aria-expanded 跟随
    const rod = screen.getByTitle('Expand all groups')
    expect(rod.getAttribute('aria-expanded')).toBe('false')
    const wall = rod.closest('.scroll-dual') as HTMLElement
    expect(wall.classList.contains('rolled')).toBe(false)
  })

  it('再点展开:一切如旧(分组开、行可进、title 复原)', () => {
    render(<SessionsPanel />)
    fireEvent.click(screen.getByTitle('Collapse all groups'))
    fireEvent.click(screen.getByTitle('Expand all groups'))
    const pinnedHeader = screen.getByText('Pinned').closest('[role="button"]') as HTMLElement
    expect(pinnedHeader.getAttribute('aria-expanded')).toBe('true')
    expect(foldOf('pinned-one').classList.contains('open')).toBe(true)
    expect(foldOf('pinned-one').hasAttribute('inert')).toBe(false)
    expect(foldOf('subnet-one').hasAttribute('inert')).toBe(false)
    expect(screen.getByTitle('Collapse all groups')).toBeTruthy()
  })

  it('点下辊行同样一键收/放(鼠标入口,双向 toggle)', () => {
    render(<SessionsPanel />)
    // 下辊行不带 title(键盘由上辊行独占)—— 按装配内位置取
    const wall = screen.getByTitle('Collapse all groups').closest('.scroll-dual') as HTMLElement
    const rodB = wall.querySelector('.scroll-dual-rod-b') as HTMLElement
    fireEvent.click(rodB)
    expect(foldOf('pinned-one').hasAttribute('inert')).toBe(true)
    expect(screen.getByTitle('Expand all groups')).toBeTruthy()
    fireEvent.click(rodB)
    expect(foldOf('pinned-one').hasAttribute('inert')).toBe(false)
    expect(screen.getByTitle('Collapse all groups')).toBeTruthy()
  })

  it('置顶段开合走既有存档:一键收后 pinnedCollapsed 防抖落盘 true,再展开落盘 false', async () => {
    render(<SessionsPanel />)
    fireEvent.click(screen.getByTitle('Collapse all groups'))
    await waitFor(
      () => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('pinnedCollapsed', true),
      { timeout: 2000 }
    )
    fireEvent.click(screen.getByTitle('Expand all groups'))
    await waitFor(
      () => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('pinnedCollapsed', false),
      { timeout: 2000 }
    )
  })

  it('总闸已摘:开合 title 在辊行上,不再挂在 .scroll-head 分组栏;墙态无 config 读写', () => {
    render(<SessionsPanel />)
    // 旧「全体」总闸是带 title 的 scroll-head 根栏;现在 title 挂在墙的
    // 辊行(.scroll-dual-rod)上,与分组栏(.scroll-head)无关
    const rod = screen.getByTitle('Collapse all groups')
    expect(rod.closest('.scroll-head')).toBeNull()
    // 分组栏(PINNED)自身不带总闸管辖 title
    const pinnedHeader = screen.getByText('Pinned').closest('.scroll-head') as HTMLElement
    expect(pinnedHeader.getAttribute('title')).toBeNull()
    // 墙自身无态可存档(改的是各分组自己的开合态,走既有存档键)
    const keys = (window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(keys).not.toContain('wallRolled')
    const setKeys = (window.electronAPI.setConfig as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(setKeys).not.toContain('wallRolled')
  })
})
