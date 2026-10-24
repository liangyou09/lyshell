// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayPayload } from '@shared/types'
import type { ProjectSceneRequest } from '@shared/project-scene'
import { ProjectEntry } from './ProjectEntry'
import { usePaneStore } from '../../stores/pane-store'

const { attach } = vi.hoisted(() => ({ attach: vi.fn() }))
vi.mock('../../stores/project-entry-launch', () => ({ attachProjectEntrySession: attach }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh' } }) }))
const payload: Extract<OverlayPayload, { kind: 'projectEntry' }> = { kind: 'projectEntry', target: { presetId: 'project', cwd: 'C:/projects/alpha' }, entry: { kind: 'agent', agentKind: 'codex', agentId: 'opaque-agent-id' } }
const defaultRequest = async (input: ProjectSceneRequest) => input.kind === 'describe' ? { success: true, scenes: [], issues: [], projectName: 'Alpha', entryName: '实现助手' } : { success: true, scenes: [], issues: [], sessionId: 'terminal-1' }
const request = vi.fn(defaultRequest)
beforeEach(() => {
  request.mockReset().mockImplementation(defaultRequest); attach.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', projectSceneRequest: request } })
  usePaneStore.setState({ overlayPayloads: { entry: payload } })
})
afterEach(cleanup)
describe('restored Agent entry', () => {
  it('uses the live launcher name and places actions before collapsible technical information', async () => {
    const view = render(<ProjectEntry payload={payload} id="entry" />)
    expect(await view.findByRole('heading', { name: '实现助手 · 待启动' })).toBeTruthy()
    const header = view.container.querySelector('.project-entry-header')!
    expect(header.querySelectorAll('button')).toHaveLength(2)
    expect(header.textContent).not.toContain('opaque-agent-id')
    expect(view.container.querySelector('details')?.open).toBe(false)
    expect(request.mock.calls.every(([input]) => input.kind === 'describe')).toBe(true)
  })
  it('retries terminal placement after an accepted launch without starting a second process', async () => {
    attach.mockRejectedValueOnce(new Error('终端信息暂不可用'))
    const view = render(<ProjectEntry payload={payload} id="entry" />)
    fireEvent.click(view.getByRole('button', { name: '选择历史对话…' }))
    expect(await view.findByRole('alert')).toBeTruthy()
    const retry = view.getByRole('button', { name: '定位已创建的终端' })
    fireEvent.click(retry)
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2))
    expect(request.mock.calls.filter(([input]) => input.kind === 'launch')).toHaveLength(1)
    expect(attach).toHaveBeenLastCalledWith('entry', payload, 'terminal-1')
  })
  it('retains an accepted receipt when moving the entry remounts its component', async () => {
    attach.mockRejectedValueOnce(new Error('终端信息暂不可用'))
    const first = render(<ProjectEntry payload={payload} id="entry" />)
    fireEvent.click(first.getByRole('button', { name: '选择历史对话…' }))
    await first.findByRole('alert')
    first.unmount()
    const moved = render(<ProjectEntry payload={payload} id="entry" />)
    fireEvent.click(moved.getByRole('button', { name: '定位已创建的终端' }))
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2))
    expect(request.mock.calls.filter(([input]) => input.kind === 'launch')).toHaveLength(1)
  })
  it('blocks another launch after remounting while the first request is pending', async () => {
    let finish!: (result: Awaited<ReturnType<typeof request>>) => void
    request.mockImplementation(async input => input.kind === 'describe'
      ? { success: true, scenes: [], issues: [], projectName: 'Alpha', entryName: '实现助手' }
      : new Promise(resolve => { finish = resolve }))
    const first = render(<ProjectEntry payload={payload} id="entry" />)
    fireEvent.click(first.getByRole('button', { name: '新建对话' }))
    first.unmount()
    const moved = render(<ProjectEntry payload={payload} id="entry" />)
    expect(moved.getByRole('button', { name: '新建对话' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(moved.getByRole('button', { name: '新建对话' }))
    await act(async () => finish({ success: true, scenes: [], issues: [], sessionId: 'terminal-1' }))
    expect(request.mock.calls.filter(([input]) => input.kind === 'launch')).toHaveLength(1)
  })
  it('does not resend a launch after losing its IPC receipt', async () => {
    request.mockImplementation(async input => {
      if (input.kind === 'launch') throw new Error('IPC disconnected')
      return { success: true, scenes: [], issues: [], projectName: 'Alpha', entryName: '实现助手' }
    })
    const first = render(<ProjectEntry payload={payload} id="entry" />)
    fireEvent.click(first.getByRole('button', { name: '新建对话' }))
    await first.findByRole('alert')
    first.unmount()
    const moved = render(<ProjectEntry payload={payload} id="entry" />)
    expect(moved.getByRole('button', { name: '请先检查终端列表' }).hasAttribute('disabled')).toBe(true)
    expect(request.mock.calls.filter(([input]) => input.kind === 'launch')).toHaveLength(1)
  })
})
