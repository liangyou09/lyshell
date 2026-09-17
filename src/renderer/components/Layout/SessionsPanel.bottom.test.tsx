// @vitest-environment jsdom
/**
 * SessionsPanel 栏底文件管理器关闭/恢复回归：关闭后 FileManager 摘树但
 * 分割线保留为恢复轨；关闭态持久化，恢复后回到原位置。
 * 写门回归：读档未落定(慢/失败)时防抖与卸载补写都不得把默认 false 落盘 ——
 * 否则存档的 true 被冲掉且无从恢复（真机上 = 每次快速切页签都丢关闭存档）。
 * 高度存档防毒：离谱超上限值收敛到绝对上限（4000，同小窗写轮眼口径）。
 * 另有拖拽抢跑回归：点关闭按钮的 mousedown 不得冒泡到分割线启动拖高
 * （真机上抖动会把按钮从指针下拽走并改写存档高度 —— pointerdown 冒泡
 * 在 WebPanel 还会 setPointerCapture 偷走 click，jsdom 只能测鼠标冒泡这条）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import SessionsPanel from './SessionsPanel'
import '../../i18n'

vi.mock('../FileManager/FileManagerPanel', () => ({
  default: () => <div data-testid="file-manager-panel" />
}))

vi.mock('../../stores/session-store', () => ({
  useSessionStore: () => ({
    savedSessions: [],
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
    getConfig: vi.fn(async () => false),
    setConfig: vi.fn(async () => true),
    getQuickCommands: vi.fn(async () => []),
    commandGroupList: vi.fn(async () => [])
  } as unknown as typeof window.electronAPI
})

afterEach(() => cleanup())

describe('文件管理器栏底窗口', () => {
  it('存档为关闭态时渲染恢复轨而非面板，关闭态持久化', async () => {
    (window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => key === 'fileManagerClosed'
    )
    render(<SessionsPanel />)
    await waitFor(() => expect(screen.queryByTestId('file-manager-panel')).toBeNull())
    expect(screen.getByTitle('Restore file manager')).toBeTruthy()
    await waitFor(() => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('fileManagerClosed', true))
  })

  it('默认打开；点关闭按钮摘树并持久化关闭态', async () => {
    render(<SessionsPanel />)
    await waitFor(() => expect(screen.getByTestId('file-manager-panel')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Close file manager'))
    await waitFor(() => {
      expect(screen.queryByTestId('file-manager-panel')).toBeNull()
      expect(screen.getByTitle('Restore file manager')).toBeTruthy()
    })
    await waitFor(() => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('fileManagerClosed', true))
  })

  it('恢复后文件管理器回到面板，关闭态写回 false', async () => {
    (window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => key === 'fileManagerClosed'
    )
    render(<SessionsPanel />)
    await waitFor(() => expect(screen.queryByTestId('file-manager-panel')).toBeNull())
    fireEvent.click(screen.getByTitle('Restore file manager'))
    await waitFor(() => expect(screen.getByTestId('file-manager-panel')).toBeTruthy())
    await waitFor(() => expect(window.electronAPI.setConfig).toHaveBeenCalledWith('fileManagerClosed', false))
  })

  it('点关闭按钮不触发拖高：mousedown 不冒泡到分割线，mousemove 不改写高度', async () => {
    render(<SessionsPanel />)
    const panel = await waitFor(() => screen.getByTestId('file-manager-panel'))
    const wrapper = panel.parentElement as HTMLElement
    expect(wrapper.style.height).toBe('200px')
    // 按下即带抖动：mousedown 落在按钮上，随后 document mousemove ——
    // 若冒泡启动了拖高，jsdom 零尺寸 rect 会把高度夹到 100px
    fireEvent.mouseDown(screen.getByTitle('Close file manager'))
    fireEvent.mouseMove(document, { clientY: 300 })
    fireEvent.mouseUp(document)
    expect(wrapper.style.height).toBe('200px')
    await waitFor(() => expect(window.electronAPI.setConfig).not.toHaveBeenCalledWith('fileManagerHeight', 100))
  })

  it('关闭后 500ms 内切走页签（卸载）也补写关闭态', async () => {
    render(<SessionsPanel />)
    await waitFor(() => expect(screen.getByTestId('file-manager-panel')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Close file manager'))
    await waitFor(() => expect(screen.getByTitle('Restore file manager')).toBeTruthy())
    // 防抖 500ms 未到即随页签切换卸载 —— 卸载时补写,关闭决策不丢
    cleanup()
    const closedWrites = (window.electronAPI.setConfig as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => c[0] === 'fileManagerClosed')
    expect(closedWrites.length).toBeGreaterThan(0)
    expect(closedWrites[closedWrites.length - 1]).toEqual(['fileManagerClosed', true])
  })

  it('写门：读档未落定即切走页签（卸载），默认 false 不落盘冲掉存档的 true', async () => {
    // 模拟读档慢/失败:config 永不 resolve —— 修复前卸载补写把默认 false 写进档,
    // 存档 true 被冲掉(防抖 500ms 路同理,本用例两条一起锁)
    (window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {})
    )
    render(<SessionsPanel />)
    cleanup()
    const closedWrites = (window.electronAPI.setConfig as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => c[0] === 'fileManagerClosed')
    expect(closedWrites).toEqual([])
  })

  it('高度存档防毒：离谱超上限值收敛到绝对上限（4000）', async () => {
    // config 被手改成 99999:恢复侧要把高度夹到绝对上限,不夹会直接写成
    // 99999px 行内高度(恢复时面板未布局,rect 量不到当前布局上限)
    (window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => key === 'fileManagerHeight' ? 99999 : undefined
    )
    render(<SessionsPanel />)
    const panel = await waitFor(() => screen.getByTestId('file-manager-panel'))
    const wrapper = panel.parentElement as HTMLElement
    expect(wrapper.style.height).toBe('4000px')
  })
})
