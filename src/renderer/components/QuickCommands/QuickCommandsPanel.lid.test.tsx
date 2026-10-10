// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import QuickCommandsPanel from './QuickCommandsPanel'
import { useQuickCommandsStore } from '@/stores'
import '../../i18n'

const command = { id: 'cmd-1', name: '查看目录', content: 'ls\n' }
const originalState = useQuickCommandsStore.getState()
beforeEach(() => {
  localStorage.clear()
  useQuickCommandsStore.setState({ commands: [command], groups: [{ id: 'ops', name: 'Ops', order: 1 }], selectedGroupId: 'default' })
})
afterEach(() => { cleanup(); localStorage.clear(); useQuickCommandsStore.setState(originalState) })

describe('快捷命令印匣盖', () => {
  it('键盘开合保存状态并隔离收起内容，恢复后命令可执行', () => {
    const execute = vi.fn()
    const { container, unmount } = render(<QuickCommandsPanel onExecuteCommand={execute} />)
    const lid = container.querySelector('.seal-box-lid') as HTMLElement
    fireEvent.keyDown(lid, { key: 'Enter' })
    expect(lid.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.seal-box-fold')?.hasAttribute('inert')).toBe(true)
    expect(localStorage.getItem('lyshell.quickCmdCollapsed.v1')).toBe('1')
    unmount()
    const restored = render(<QuickCommandsPanel onExecuteCommand={execute} />)
    const restoredLid = restored.container.querySelector('.seal-box-lid') as HTMLElement
    expect(restoredLid.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(restoredLid, { key: ' ' })
    expect(restored.container.querySelector('.seal-box-fold')?.hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '查看目录' }))
    expect(execute).toHaveBeenCalledWith(command)
  })

  it('匣盖内分组按钮与键盘事件不误触开合', () => {
    const { container } = render(<QuickCommandsPanel />)
    const lid = container.querySelector('.seal-box-lid') as HTMLElement
    fireEvent.click(lid)
    const group = container.querySelectorAll('.seal-box-groups button')[1]
    fireEvent.keyDown(group, { key: 'Enter' })
    fireEvent.click(group)
    expect(useQuickCommandsStore.getState().selectedGroupId).toBe('ops')
    expect(lid.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.rod-caps')).toBeNull()
  })
})
