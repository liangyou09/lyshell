// @vitest-environment jsdom
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SidebarToggle from './SidebarToggle'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

beforeEach(() => { vi.stubGlobal('__APP_VERSION__', '2.0.2') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const Sidebar: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false)
  return <>
    <div id="workspace-sidebar" aria-hidden={collapsed}>
      <SidebarToggle collapsed={false} onClick={() => setCollapsed(true)} tabIndex={collapsed ? -1 : 0} />
    </div>
    <div aria-hidden={!collapsed}>
      <SidebarToggle collapsed onClick={() => setCollapsed(false)} tabIndex={collapsed ? 0 : -1} />
    </div>
  </>
}

it('键盘开合后焦点交给可见的另一控位，状态与控制目标一致', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  render(<Sidebar />)
  const collapse = screen.getByRole('button', { name: 'settings.collapseSidebar' })
  collapse.focus()
  expect(collapse.getAttribute('aria-expanded')).toBe('true')
  expect(collapse.getAttribute('aria-controls')).toBe('workspace-sidebar')
  fireEvent.click(collapse, { detail: 0 })
  act(() => { frames.shift()!(0) })
  const expand = screen.getByRole('button', { name: 'settings.expandSidebar' })
  expect(document.activeElement).toBe(expand)
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(expand, { detail: 0 })
  act(() => { frames.shift()!(0) })
  expect(document.activeElement).toBe(collapse)
})

it('鼠标点击开关不安排键盘焦点转移', () => {
  const frame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', frame)
  render(<Sidebar />)
  fireEvent.click(screen.getByRole('button', { name: 'settings.collapseSidebar' }), { detail: 1 })
  expect(screen.getByRole('button', { name: 'settings.expandSidebar' })).toBeTruthy()
  expect(frame).not.toHaveBeenCalled()
})

it('收起时按页签状态切换纯图标和名称版本，保留展开操作的无障碍名称', () => {
  const { container, rerender } = render(<SidebarToggle collapsed showBrand={false} onClick={() => {}} />)
  expect(container.querySelector('.sidebar-toggle-wordmark')).toBeNull()
  expect(container.querySelector('.sidebar-toggle-version')).toBeNull()
  expect(screen.getByRole('button', { name: 'settings.expandSidebar' })).toBeTruthy()
  rerender(<SidebarToggle collapsed showBrand onClick={() => {}} />)
  expect(container.querySelector('.sidebar-toggle-wordmark')?.textContent).toBe('LyShell')
  expect(container.querySelector('.sidebar-toggle-version')?.textContent).toBe('v2.0.2')
  rerender(<SidebarToggle collapsed={false} showBrand onClick={() => {}} />)
  expect(container.querySelector('.sidebar-toggle-wordmark')).toBeNull()
})
