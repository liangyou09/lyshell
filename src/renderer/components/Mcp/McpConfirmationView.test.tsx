// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpConfirmationData } from '@shared/mcp-confirmation'
import McpConfirmationView from './McpConfirmationView'

afterEach(cleanup)
const data: McpConfirmationData = { title: 'MCP 破坏性命令确认', message: '允许执行？', operation: 'execute_command', source: 'LyShell · Agent', targets: [{ name: '10.5.20.39', type: 'ssh' }], contentKind: 'command', content: 'echo <img src=x onerror=alert(1)>\n' + 'x'.repeat(900) + '\nreboot', locale: 'zh', theme: 'light', rules: [{ name: 'shutdown-reboot', description: '关闭或重启系统', snippet: 'reboot' }] }

describe('MCP 确认界面', () => {
  it('默认聚焦拒绝，长内容逐字显示为文字而非 HTML；复制不触发批准', async () => {
    const request = vi.fn().mockResolvedValue(true)
    await act(async () => { render(<McpConfirmationView data={data} onRequest={request} />) })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '拒绝' }))
    expect(document.querySelector('.mcp-confirm-code')?.textContent).toBe(data.content)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('10.5.20.39')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(request).toHaveBeenCalledWith({ kind: 'copy' })
    expect(request).not.toHaveBeenCalledWith({ kind: 'allow' })
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(request).toHaveBeenCalledWith({ kind: 'reject' })
  })
  it('确认失败后禁用允许，关闭按钮仍可拒绝', async () => {
    const request = vi.fn().mockImplementation(async r => r.kind !== 'allow')
    await act(async () => { render(<McpConfirmationView data={data} onRequest={request} />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '允许一次' })) })
    expect((screen.getByRole('button', { name: '允许一次' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关闭并拒绝' })) })
    expect(request).toHaveBeenCalledWith({ kind: 'reject' })
  })
  it('就绪之前不能批准，复制失败保留手动复制方式', async () => {
    const request = vi.fn().mockImplementation(async r => r.kind === 'ready' ? true : false)
    render(<McpConfirmationView data={{ ...data, locale: 'en' }} onRequest={request} />)
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => undefined)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(screen.getByRole('status').textContent).toContain('Select the content')
    expect(document.querySelector('.mcp-confirm-code')?.getAttribute('tabindex')).toBe('0')
  })
})
